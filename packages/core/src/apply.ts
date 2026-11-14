// Turning server events into local state.
//
// decodeEvents: decrypt and verify each event with the protocol package
// (async WebCrypto, so outside any database transaction). Direct chats (and
// the chat with oneself) use the pair key; groups use the epoch secret and the
// members of the last accepted state of that epoch. An event whose group key
// or state is not known yet waits in `pendingEvents` and is retried after the
// next group update; an event that fails verification is written to
// diagnostics and skipped, never stored or shown.
//
// commitEvents / commitSent: one IndexedDB transaction stores the verified
// events, the derived messages, the chat summaries, the seq tracking,
// attachment rows and (for sync) the cursor, so a crash never leaves a cursor
// ahead of its messages. Duplicates are dropped by (sender, message id).

import {
  decodeEvent,
  isProtocolError,
  type Attachment,
  type DecodedPayload,
  type Identity,
  type MsgPayload,
} from '@family-chat/protocol';
import { isTransient } from './api/errors.ts';
import type { PostEventResult, ServerEvent } from './api/types.ts';
import { CoreError, isCoreError } from './errors.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type { BlobRow, ChatKind, ChatRow, MessageRow, OutboxRow, RetentionGap } from './db/schema.ts';
import type { Directory } from './directory.ts';
import type { Groups } from './groups.ts';
import type { Session } from './session.ts';

/** A verified event ready to be stored. */
export interface Applicable {
  readonly chatId: string;
  readonly chatKind: ChatKind;
  /** The other member of a direct chat (me for the chat with myself, '' for a group). */
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
  readonly groups: Groups;
  /** Wakes the attachment engine after new attachments were stored. */
  readonly onAttachments?: () => void;
}

/** Setting key: download images and voice up to 10 MB automatically (default true). */
export const SETTING_AUTO_DOWNLOAD = 'attachments.autoDownload';
/** Largest attachment downloaded automatically (images and voice). */
export const AUTO_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

export interface DecodeOptions {
  /** May call the group engine to fetch missing states and keys (default true). */
  readonly reconcile?: boolean;
  /** Store events that wait for a group key in `pendingEvents` (default true). */
  readonly keepPending?: boolean;
  /** May fetch the member list when a sender or chat is unknown (default true). */
  readonly refresh?: boolean;
}

interface DecodeResult {
  readonly items: Applicable[];
  /** gseq of events that still wait for a key or a state. */
  readonly waiting: Set<number>;
}

/** Decrypts and verifies events; refreshes the member list once if a sender or chat is unknown. */
export async function decodeEvents(
  rt: AccountRuntimeLike,
  events: readonly ServerEvent[],
  options: DecodeOptions = {},
): Promise<Applicable[]> {
  return (await decodeAll(rt, events, options)).items;
}

async function decodeAll(rt: AccountRuntimeLike, events: readonly ServerEvent[], options: DecodeOptions): Promise<DecodeResult> {
  const { ctx, session, directory, groups } = rt;
  const { db } = ctx;
  const acc = session.accountId;
  const me = session.userId;
  const mayReconcile = options.reconcile ?? true;

  let needRefresh = false;
  for (const ev of options.refresh === false ? [] : events) {
    const peer = await directory.peerForChat(ev.chatId);
    const group = peer ? undefined : await db.groups.get([acc, ev.chatId]);
    if ((!peer && !group) || (ev.senderId !== me && !(await directory.user(ev.senderId)))) {
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
  const waiting = new Set<number>();
  let reconciled = false;
  for (const ev of events) {
    const where = `event gseq=${ev.gseq} chat=${ev.chatId} sender=${ev.senderId}`;
    try {
      const sender = await directory.user(ev.senderId);
      if (sender?.revoked && ev.time > sender.revoked.revokedAt) {
        void ctx.diag.warn('verify', `${where} rejected: the sender's identity is revoked`, acc);
        continue;
      }
      const peerId = await directory.peerForChat(ev.chatId);
      let chatKind: ChatKind;
      let decoded;
      if (peerId) {
        chatKind = peerId === me ? 'self' : 'dm';
        const peer = peerId === me ? myIdentity : await directory.identity(peerId);
        const keys = await directory.chatKeys(peerId);
        decoded = await decodeEvent(ev.body, {
          serverId: session.serverId,
          chatId: ev.chatId,
          chat: keys,
          lookupAuthor: (id) => (id === me ? myIdentity : id === peerId ? peer : undefined),
          expectedSender: ev.senderId,
        });
      } else {
        chatKind = 'group';
        let gctx = await groups.decodeContext(ev.chatId, ev.epoch);
        if (!gctx && mayReconcile && !reconciled) {
          reconciled = true;
          try {
            await groups.reconcile({ full: true });
          } catch (e) {
            // Network trouble: retry the whole page later. Anything else: the event waits.
            if (isTransient(e) || e instanceof CoreError) throw e;
            void ctx.diag.warn('group', `group update before decoding failed: ${describeError(e)}`, acc);
          }
          gctx = await groups.decodeContext(ev.chatId, ev.epoch);
        }
        if (!gctx) {
          if (!waiting.has(ev.gseq)) void ctx.diag.info('verify', `${where} waits: unknown chat or group key not here yet`, acc);
          waiting.add(ev.gseq);
          if (options.keepPending ?? true) {
            await db.pendingEvents.put({ accountId: acc, gseq: ev.gseq, chatId: ev.chatId, event: ev, addedAt: ctx.clock.now(), attempts: 0 });
          }
          continue;
        }
        const lookup = gctx.lookup;
        decoded = await decodeEvent(ev.body, {
          serverId: session.serverId,
          chatId: ev.chatId,
          chat: gctx.chat,
          lookupAuthor: (id): Identity | undefined => (id === me ? (lookup(id) ? myIdentity : undefined) : lookup(id)),
          expectedSender: ev.senderId,
        });
      }
      if (decoded.msgId !== ev.msgId) {
        void ctx.diag.warn('verify', `${where} skipped: message id differs from the server's`, acc);
        continue;
      }
      out.push({
        chatId: ev.chatId,
        chatKind,
        peerId: peerId ?? '',
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
      if (isTransient(e) || isCoreError(e, 'removed') || isCoreError(e, 'revoked') || isCoreError(e, 'login-invalid')) throw e;
      const level = isProtocolError(e) ? 'warn' : 'error';
      void ctx.diag.log(level, 'verify', `${where} rejected: ${describeError(e)}`, acc);
    }
  }
  return { items: out, waiting };
}

/** Retries events that waited for a group key or state. Never reconciles (it runs inside group updates). */
export async function retryPendingEvents(rt: AccountRuntimeLike, chatIds: ReadonlySet<string> | null): Promise<number> {
  const { ctx, session } = rt;
  const { db } = ctx;
  const acc = session.accountId;
  const rows = (await db.pendingEvents.where('accountId').equals(acc).toArray())
    .filter((r) => !chatIds || chatIds.has(r.chatId))
    .sort((a, b) => a.gseq - b.gseq);
  if (rows.length === 0) return 0;
  const { items, waiting } = await decodeAll(
    rt,
    rows.map((r) => r.event),
    { reconcile: false, keepPending: false },
  );
  const r = await commitEvents(ctx, acc, session.userId, items);
  const done = rows.filter((x) => !waiting.has(x.gseq)).map((x): [string, number] => [acc, x.gseq]);
  await db.pendingEvents.bulkDelete(done);
  if (r.added > 0) rt.onAttachments?.();
  return r.added;
}

export interface CommitOptions {
  /** New cursor (sync only); always replaces the stored one. */
  readonly cursor?: number;
  readonly retentionGap?: RetentionGap;
  readonly initialSyncDone?: boolean;
  readonly oldest?: { gseq: number; time: number | null };
}

export interface CommitResult {
  /** Newly stored events (duplicates excluded). */
  readonly added: number;
  /** Loss reports (seq gaps) for diagnostics. */
  readonly gaps: readonly string[];
  /** New attachments were stored. */
  readonly attachments: boolean;
}

const COMMIT_TABLES = (db: CoreContext['db']) => [db.events, db.messages, db.chats, db.seqTrack, db.accounts, db.blobs];

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
  const auto = (await db.settings.get(SETTING_AUTO_DOWNLOAD))?.value !== false;
  const flags = { attachments: false };
  await db.transaction('rw', COMMIT_TABLES(db), async () => {
    for (const item of items) {
      if (await applyOne(ctx, accountId, myUserId, item, gaps, auto, flags)) added++;
    }
    const patch: Record<string, unknown> = {};
    if (options.cursor !== undefined) {
      patch.cursor = options.cursor;
      patch.lastSyncAt = ctx.clock.now();
    }
    if (options.retentionGap) patch.retentionGap = options.retentionGap;
    if (options.initialSyncDone) patch.initialSyncDone = true;
    if (options.oldest) patch.oldest = options.oldest;
    if (Object.keys(patch).length > 0) await db.accounts.update(accountId, patch);
  });
  for (const g of gaps) void ctx.diag.warn('gap', g, accountId);
  return { added, gaps, attachments: flags.attachments };
}

/** The msg payload of an outbox row, exactly as it is encoded for sending. */
export function outboxPayload(row: OutboxRow): MsgPayload {
  return {
    v: 1,
    t: 'msg',
    id: row.msgId,
    dev: row.devId,
    seq: row.seq,
    ...(row.body ? { body: row.body } : {}),
    ...(row.reply ? { reply: row.reply } : {}),
    ...(row.fwd ? { fwd: true as const } : {}),
    ...(row.attachments && row.attachments.length > 0 ? { attachments: row.attachments } : {}),
    ...(row.location ? { location: row.location } : {}),
  };
}

/** Records a message the server accepted: removes the outbox row, stores event and message. */
export async function commitSent(
  ctx: CoreContext,
  accountId: string,
  myUserId: string,
  row: OutboxRow,
  chat: { kind: ChatKind; peerId: string },
  epoch: number,
  body: Uint8Array,
  res: PostEventResult,
): Promise<void> {
  const { db } = ctx;
  const gaps: string[] = [];
  const flags = { attachments: false };
  await db.transaction('rw', [...COMMIT_TABLES(db), db.outbox], async () => {
    await db.outbox.delete([accountId, row.msgId]);
    await applyOne(
      ctx,
      accountId,
      myUserId,
      {
        chatId: row.chatId,
        chatKind: chat.kind,
        peerId: chat.peerId,
        senderId: myUserId,
        msgId: row.msgId,
        devId: row.devId,
        epoch,
        gseq: res.gseq,
        time: res.time,
        body,
        payload: { kind: 'msg', msg: outboxPayload(row) },
      },
      gaps,
      false,
      flags,
    );
  });
}

function blobRow(acc: string, item: Applicable, a: Attachment, auto: boolean, now: number): BlobRow {
  const autoKind = a.kind === 'image' || a.kind === 'voice';
  return {
    accountId: acc,
    blobId: a.blob.id,
    direction: 'down',
    chatId: item.chatId,
    senderId: item.senderId,
    msgId: item.msgId,
    ref: a.blob,
    name: a.name,
    mime: a.mime,
    kind: a.kind,
    size: a.blob.size,
    status: auto && autoKind && a.blob.size <= AUTO_DOWNLOAD_MAX_BYTES ? 'queued' : 'none',
    bytesDone: 0,
    partsDone: 0,
    attempts: 0,
    nextAttemptAt: now,
    error: null,
    storage: null,
    createdAt: now,
  };
}

/** Must run inside a transaction over COMMIT_TABLES. Returns false for a duplicate. */
async function applyOne(
  ctx: CoreContext,
  acc: string,
  me: string,
  item: Applicable,
  gaps: string[],
  auto: boolean,
  flags: { attachments: boolean },
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
    kind: item.chatKind,
    peerId: item.peerId,
    createdAt: ctx.clock.now(),
    last: null,
    readGseq: 0,
    unread: 0,
  };

  if (p.kind !== 'ignore') {
    const msg = p.kind === 'msg' ? p.msg : undefined;
    const message: MessageRow = {
      accountId: acc,
      chatId: item.chatId,
      senderId: item.senderId,
      msgId: item.msgId,
      devId: dev ?? item.devId,
      seq: seq ?? null,
      gseq: item.gseq,
      time: item.time,
      kind: msg ? 'msg' : 'update-required',
      body: msg?.body ?? '',
      reply: msg?.reply ?? null,
      ...(msg?.attachments ? { attachments: [...msg.attachments] } : {}),
      ...(msg?.location ? { location: msg.location } : {}),
      ...(msg?.fwd ? { fwd: true as const } : {}),
    };
    await db.messages.put(message);
    if (msg?.attachments) {
      const now = ctx.clock.now();
      for (const a of msg.attachments) {
        const existing = await db.blobs.get([acc, a.blob.id]);
        if (existing) continue; // my own upload (the local copy) or a repeat
        await db.blobs.put(blobRow(acc, item, a, auto, now));
        flags.attachments = true;
      }
    }
    if (!chat.last || item.gseq > chat.last.gseq) {
      chat.last = {
        senderId: message.senderId,
        msgId: message.msgId,
        kind: message.kind,
        body: message.body,
        gseq: message.gseq,
        time: message.time,
        ...(msg?.attachments?.[0] ? { media: msg.attachments[0].kind } : msg?.location ? { media: 'location' as const } : {}),
      };
    }
    if (item.senderId !== me && item.gseq > chat.readGseq) chat.unread += 1;
  }
  await db.chats.put(chat);
  return true;
}
