// Turning server events into local state.
//
// decodeEvents: decrypt and verify each event with the protocol package
// (async WebCrypto, so outside any database transaction). An event that fails
// is written to diagnostics and skipped; it is never stored or shown.
//
// commitEvents / commitSent: one IndexedDB transaction stores the verified
// events, the derived messages, the chat summaries, the seq tracking and (for
// sync) the cursor, so a crash never leaves a cursor ahead of its messages.
// Duplicates are dropped by (sender, message id).

import { decodeEvent, isProtocolError, type DecodedPayload, type MsgPayload } from '@family-chat/protocol';
import type { PostEventResult, ServerEvent } from './api/types.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type { ChatRow, MessageRow, OutboxRow, RetentionGap } from './db/schema.ts';
import type { Directory } from './directory.ts';
import type { Session } from './session.ts';

/** A verified event ready to be stored. */
export interface Applicable {
  readonly chatId: string;
  readonly peerId: string;
  readonly senderId: string;
  readonly msgId: string;
  readonly devId: string;
  readonly epoch: number;
  readonly gseq: number;
  readonly time: number;
  readonly body: Uint8Array;
  readonly payload: DecodedPayload;
}

export interface AccountRuntimeLike {
  readonly ctx: CoreContext;
  readonly session: Session;
  readonly directory: Directory;
}

/** Decrypts and verifies events; refreshes the member list once if a sender or chat is unknown. */
export async function decodeEvents(rt: AccountRuntimeLike, events: readonly ServerEvent[]): Promise<Applicable[]> {
  const { ctx, session, directory } = rt;
  const acc = session.accountId;
  const me = session.userId;

  let needRefresh = false;
  for (const ev of events) {
    const peer = await directory.peerForChat(ev.chatId);
    if (!peer || (ev.senderId !== me && !(await directory.user(ev.senderId)))) {
      needRefresh = true;
      break;
    }
  }
  if (needRefresh) {
    try {
      await directory.refresh();
    } catch (e) {
      void ctx.diag.warn('directory', `member list refresh failed: ${describeError(e)}`, acc);
      throw e;
    }
  }

  const myIdentity = await directory.myIdentity();
  const out: Applicable[] = [];
  for (const ev of events) {
    const where = `event gseq=${ev.gseq} chat=${ev.chatId} sender=${ev.senderId}`;
    const peerId = await directory.peerForChat(ev.chatId);
    if (!peerId) {
      void ctx.diag.warn('verify', `${where} skipped: unknown chat`, acc);
      continue;
    }
    try {
      const peer = await directory.identity(peerId);
      const keys = await directory.chatKeys(peerId);
      const decoded = await decodeEvent(ev.body, {
        serverId: session.serverId,
        chatId: ev.chatId,
        chat: keys,
        lookupAuthor: (id) => (id === me ? myIdentity : id === peerId ? peer : undefined),
        expectedSender: ev.senderId,
      });
      if (decoded.msgId !== ev.msgId) {
        void ctx.diag.warn('verify', `${where} skipped: message id differs from the server's`, acc);
        continue;
      }
      out.push({
        chatId: ev.chatId,
        peerId,
        senderId: decoded.senderId,
        msgId: decoded.msgId,
        devId: ev.devId,
        epoch: ev.epoch,
        gseq: ev.gseq,
        time: ev.time,
        body: ev.body,
        payload: decoded.payload,
      });
    } catch (e) {
      const level = isProtocolError(e) ? 'warn' : 'error';
      void ctx.diag.log(level, 'verify', `${where} rejected: ${describeError(e)}`, acc);
    }
  }
  return out;
}

export interface CommitOptions {
  /** New cursor (sync only); always replaces the stored one. */
  readonly cursor?: number;
  readonly retentionGap?: RetentionGap;
  readonly initialSyncDone?: boolean;
}

export interface CommitResult {
  /** Newly stored events (duplicates excluded). */
  readonly added: number;
  /** Loss reports (seq gaps) for diagnostics. */
  readonly gaps: readonly string[];
}

/** Stores verified events (and the cursor) in one transaction. */
export async function commitEvents(
  ctx: CoreContext,
  accountId: string,
  myUserId: string,
  items: readonly Applicable[],
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { db } = ctx;
  const gaps: string[] = [];
  let added = 0;
  await db.transaction('rw', [db.events, db.messages, db.chats, db.seqTrack, db.accounts], async () => {
    for (const item of items) {
      if (await applyOne(ctx, accountId, myUserId, item, gaps)) added++;
    }
    const patch: Record<string, unknown> = {};
    if (options.cursor !== undefined) {
      patch.cursor = options.cursor;
      patch.lastSyncAt = ctx.clock.now();
    }
    if (options.retentionGap) patch.retentionGap = options.retentionGap;
    if (options.initialSyncDone) patch.initialSyncDone = true;
    if (Object.keys(patch).length > 0) await db.accounts.update(accountId, patch);
  });
  for (const g of gaps) void ctx.diag.warn('gap', g, accountId);
  return { added, gaps };
}

/** Records a message the server accepted: removes the outbox row, stores event and message. */
export async function commitSent(
  ctx: CoreContext,
  accountId: string,
  myUserId: string,
  row: OutboxRow,
  peerId: string,
  body: Uint8Array,
  res: PostEventResult,
): Promise<void> {
  const { db } = ctx;
  const msg: MsgPayload = {
    v: 1,
    t: 'msg',
    id: row.msgId,
    dev: row.devId,
    seq: row.seq,
    body: row.body,
    ...(row.reply ? { reply: row.reply } : {}),
  };
  const gaps: string[] = [];
  await db.transaction('rw', [db.events, db.messages, db.chats, db.seqTrack, db.outbox], async () => {
    await db.outbox.delete([accountId, row.msgId]);
    await applyOne(
      ctx,
      accountId,
      myUserId,
      {
        chatId: row.chatId,
        peerId,
        senderId: myUserId,
        msgId: row.msgId,
        devId: row.devId,
        epoch: 0,
        gseq: res.gseq,
        time: res.time,
        body,
        payload: { kind: 'msg', msg },
      },
      gaps,
    );
  });
}

/** Must run inside a transaction over events, messages, chats, seqTrack. Returns false for a duplicate. */
async function applyOne(
  ctx: CoreContext,
  acc: string,
  me: string,
  item: Applicable,
  gaps: string[],
): Promise<boolean> {
  const { db } = ctx;
  if (await db.events.get([acc, item.senderId, item.msgId])) return false;
  await db.events.put({
    accountId: acc,
    senderId: item.senderId,
    msgId: item.msgId,
    gseq: item.gseq,
    time: item.time,
    chatId: item.chatId,
    devId: item.devId,
    epoch: item.epoch,
    body: item.body,
  });

  const p = item.payload;
  const dev = p.kind === 'msg' ? p.msg.dev : p.dev;
  const seq = p.kind === 'msg' ? p.msg.seq : p.seq;
  if (dev !== undefined && seq !== undefined) {
    const key: [string, string, string, string] = [acc, item.chatId, item.senderId, dev];
    const t = await db.seqTrack.get(key);
    if (!t) {
      await db.seqTrack.put({ accountId: acc, chatId: item.chatId, senderId: item.senderId, devId: dev, lastSeq: seq });
    } else if (seq > t.lastSeq) {
      if (seq > t.lastSeq + 1) {
        gaps.push(
          `${seq - t.lastSeq - 1} event(s) missing from device ${dev} of ${item.senderId} in chat ${item.chatId} (seq ${t.lastSeq + 1}..${seq - 1})`,
        );
      }
      await db.seqTrack.put({ ...t, lastSeq: seq });
    }
  }

  const chat: ChatRow = (await db.chats.get([acc, item.chatId])) ?? {
    accountId: acc,
    chatId: item.chatId,
    kind: 'dm',
    peerId: item.peerId,
    createdAt: ctx.clock.now(),
    last: null,
    readGseq: 0,
    unread: 0,
  };

  if (p.kind !== 'ignore') {
    const message: MessageRow = {
      accountId: acc,
      chatId: item.chatId,
      senderId: item.senderId,
      msgId: item.msgId,
      devId: dev ?? item.devId,
      seq: seq ?? null,
      gseq: item.gseq,
      time: item.time,
      kind: p.kind === 'msg' ? 'msg' : 'update-required',
      body: p.kind === 'msg' ? (p.msg.body ?? '') : '',
      reply: p.kind === 'msg' ? (p.msg.reply ?? null) : null,
    };
    await db.messages.put(message);
    if (!chat.last || item.gseq > chat.last.gseq) {
      chat.last = {
        senderId: message.senderId,
        msgId: message.msgId,
        kind: message.kind,
        body: message.body,
        gseq: message.gseq,
        time: message.time,
      };
    }
    if (item.senderId !== me && item.gseq > chat.readGseq) chat.unread += 1;
  }
  await db.chats.put(chat);
  return true;
}
