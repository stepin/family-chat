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
//
// Edits, deletions and reactions (M4) are stored as control rows and the
// target message is recomputed from all of them (`recompute`), so the result
// does not depend on the order in which events arrive:
// - delete: valid from the target's author or from an owner of the group in
//   an accepted state of the delete event's epoch. Final: the message becomes
//   a quiet "deleted" row (no text, no files, no reactions), its event and
//   the edit and reaction events about it are dropped from this device, its
//   attachments are removed. A delete that arrives before its target leaves a
//   tombstone, and the target is turned into the deleted row on arrival.
// - edit: valid only from the target's author; the edit with the highest
//   gseq wins (the server's order). No time window (the plans name none).
// - react: one value per (target, sender, emoji), the highest gseq wins;
//   emoji are listed by the gseq of their oldest reaction still on.
// - The server's zeroed record of a deleted event ("deleted": true) is not
//   proof of anything: it only puts a "deleted" placeholder where nothing is
//   known, and never hides a readable message. Only the signed payload does.

import {
  decodeEvent,
  isProtocolError,
  payloadCommon,
  type Attachment,
  type DecodedPayload,
  type Identity,
  type MsgPayload,
  type MsgRef,
} from '@family-chat/protocol';
import { Dexie } from 'dexie';
import { isTransient } from './api/errors.ts';
import type { PostEventResult, ServerEvent } from './api/types.ts';
import { CoreError, isCoreError } from './errors.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type {
  BlobRow,
  ChatKind,
  ChatRow,
  ControlRow,
  MessageRow,
  OutboxRow,
  ReactionAgg,
  RetentionGap,
  TombstoneRow,
} from './db/schema.ts';
import { fileKey } from './attachments.ts';
import { messageWords } from './search.ts';
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
  /** The server's zeroed record of an event deleted for everyone: no payload, header only. */
  readonly serverDeleted?: boolean;
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
    if (ev.deleted) {
      const peerId = await directory.peerForChat(ev.chatId);
      const known = peerId || (await db.groups.get([acc, ev.chatId]));
      if (!known) continue;
      out.push({
        chatId: ev.chatId,
        chatKind: peerId ? (peerId === me ? 'self' : 'dm') : 'group',
        peerId: peerId ?? '',
        senderId: ev.senderId,
        msgId: ev.msgId,
        devId: ev.devId,
        epoch: ev.epoch,
        gseq: ev.gseq,
        time: ev.time,
        body: ev.body,
        payload: { kind: 'ignore', t: '', id: ev.msgId },
        serverDeleted: true,
      });
      continue;
    }
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

/** Work collected inside a commit transaction and done after it. */
export interface CommitFlags {
  attachments: boolean;
  /** Local attachment files of deleted messages, removed after the transaction. */
  files: { storage: 'opfs' | 'idb'; key: string }[];
}

export const COMMIT_TABLES = (db: CoreContext['db']) => [
  db.events,
  db.messages,
  db.chats,
  db.seqTrack,
  db.accounts,
  db.blobs,
  db.controls,
  db.tombstones,
  db.groupStates,
];

/** Removes the local files of deleted messages (outside any transaction; failures are ignored). */
export async function removeFiles(ctx: CoreContext, files: CommitFlags['files']): Promise<void> {
  for (const f of files) {
    try {
      await (await ctx.files.of(f.storage)).delete(f.key);
    } catch {
      // Already gone or storage closed.
    }
  }
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
  const auto = (await db.settings.get(SETTING_AUTO_DOWNLOAD))?.value !== false;
  const flags: CommitFlags = { attachments: false, files: [] };
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
  await removeFiles(ctx, flags.files);
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
    ...(row.sticker ? { sticker: row.sticker } : {}),
  };
}

/** The payload of an outbox row (a message or a control event), exactly as it is encoded for sending. */
export function outboxParsed(row: OutboxRow): DecodedPayload {
  const c = row.control;
  const common = { v: 1 as const, id: row.msgId, dev: row.devId, seq: row.seq };
  if (!c) return { kind: 'msg', msg: outboxPayload(row) };
  switch (c.kind) {
    case 'edit':
      return { kind: 'edit', edit: { ...common, t: 'edit', target: c.target, body: c.body } };
    case 'delete':
      return { kind: 'delete', delete: { ...common, t: 'delete', target: c.target, targetDev: c.targetDev, targetSeq: c.targetSeq } };
    case 'react':
      return { kind: 'react', react: { ...common, t: 'react', target: c.target, emoji: c.emoji, on: c.on } };
  }
}

/**
 * Records an event the server accepted: removes the outbox row (a posted
 * delete stays for its server clean-up), stores the event and its effect.
 */
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
  const flags: CommitFlags = { attachments: false, files: [] };
  await db.transaction('rw', [...COMMIT_TABLES(db), db.outbox], async () => {
    if (row.control?.kind === 'delete') {
      await db.outbox.update([accountId, row.msgId], { control: { ...row.control, posted: true }, status: 'pending', attempts: 0, error: null });
    } else {
      await db.outbox.delete([accountId, row.msgId]);
    }
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
        payload: outboxParsed(row),
      },
      gaps,
      false,
      flags,
    );
  });
  await removeFiles(ctx, flags.files);
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

const refKey = (r: MsgRef): string => `${r.author}/${r.id}`;

function controlOf(item: Applicable): Omit<ControlRow, 'accountId'> | undefined {
  const p = item.payload;
  const base = { senderId: item.senderId, msgId: item.msgId, chatId: item.chatId, gseq: item.gseq, time: item.time, epoch: item.epoch };
  if (p.kind === 'edit') return { ...base, kind: 'edit', target: refKey(p.edit.target), body: p.edit.body };
  if (p.kind === 'delete') return { ...base, kind: 'delete', target: refKey(p.delete.target) };
  if (p.kind === 'react') return { ...base, kind: 'react', target: refKey(p.react.target), emoji: p.react.emoji, on: p.react.on };
  return undefined;
}

function lastOf(m: MessageRow): NonNullable<ChatRow['last']> {
  return {
    senderId: m.senderId,
    msgId: m.msgId,
    kind: m.kind,
    body: m.body,
    gseq: m.gseq,
    time: m.time,
    ...(m.attachments?.[0] ? { media: m.attachments[0].kind } : m.location ? { media: 'location' as const } : m.sticker ? { media: 'sticker' as const } : {}),
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
  flags: CommitFlags,
): Promise<boolean> {
  const { db } = ctx;
  if (item.serverDeleted) {
    await applyServerDeleted(ctx, acc, item);
    return false;
  }
  if (await db.events.get([acc, item.senderId, item.msgId])) return false;

  const p = item.payload;
  const common = payloadCommon(p);
  const dev = common.dev;
  const seq = common.seq;
  if (dev !== undefined && seq !== undefined) {
    const key: [string, string, string, string] = [acc, item.chatId, item.senderId, dev];
    const t = await db.seqTrack.get(key);
    if (!t) {
      await db.seqTrack.put({ accountId: acc, chatId: item.chatId, senderId: item.senderId, devId: dev, lastSeq: seq });
    } else if (seq > t.lastSeq) {
      // A delete names the seq of the event it removed: that gap is not a loss.
      const covered = p.kind === 'delete' && p.delete.targetDev === dev && p.delete.targetSeq === t.lastSeq + 1 ? 1 : 0;
      if (seq > t.lastSeq + 1 + covered) {
        gaps.push(
          `${seq - t.lastSeq - 1 - covered} event(s) missing from device ${dev} of ${item.senderId} in chat ${item.chatId} (seq ${t.lastSeq + 1 + covered}..${seq - 1})`,
        );
      }
      await db.seqTrack.put({ ...t, lastSeq: seq });
    }
  }

  // A message deleted on this device (for everyone or for me) never comes back: for
  // everyone it shows as the quiet "deleted" line in its place, for me not at all.
  const tomb = await db.tombstones.get([acc, item.senderId, item.msgId]);
  if (tomb && tomb.reason !== 'server' && p.kind !== 'edit' && p.kind !== 'delete' && p.kind !== 'react') {
    if (tomb.reason === 'everyone') await putDeletedRow(ctx, acc, { ...tomb, gseq: item.gseq, time: item.time }, item.devId);
    return false;
  }
  if (tomb?.reason === 'server') await db.tombstones.delete([acc, item.senderId, item.msgId]);

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

  const control = controlOf(item);
  if (control) {
    await db.controls.put({ accountId: acc, ...control });
    await db.chats.put(chat);
    const [author, id] = control.target.split('/') as [string, string];
    await recompute(ctx, acc, me, author, id, flags);
    return true;
  }

  if (p.kind === 'msg' || p.kind === 'update-required') {
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
      ...(msg?.sticker ? { sticker: msg.sticker } : {}),
    };
    message.words = messageWords(message);
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
    if (!chat.last || item.gseq > chat.last.gseq) chat.last = lastOf(message);
    if (item.senderId !== me && item.gseq > chat.readGseq) chat.unread += 1;
    await db.chats.put(chat);
    // Edits, reactions or a delete that came before the message.
    if (msg) await recompute(ctx, acc, me, item.senderId, item.msgId, flags);
    return true;
  }
  await db.chats.put(chat);
  return true;
}

/** The server's zeroed record: a placeholder where nothing is known about the message. */
async function applyServerDeleted(ctx: CoreContext, acc: string, item: Applicable): Promise<void> {
  const { db } = ctx;
  const key: [string, string, string] = [acc, item.senderId, item.msgId];
  if ((await db.events.get(key)) || (await db.messages.get(key))) return;
  const tomb = await db.tombstones.get(key);
  if (tomb?.reason === 'local') return;
  const row: TombstoneRow = tomb ?? { accountId: acc, senderId: item.senderId, msgId: item.msgId, chatId: item.chatId, reason: 'server', by: '', at: ctx.clock.now() };
  if (!tomb) await db.tombstones.put({ ...row, gseq: item.gseq, time: item.time });
  await putDeletedRow(ctx, acc, { ...row, gseq: item.gseq, time: item.time }, item.devId);
}

/** The quiet "deleted" line in place of a message (when there is no row yet). */
async function putDeletedRow(ctx: CoreContext, acc: string, t: TombstoneRow, devId: string): Promise<void> {
  const { db } = ctx;
  if (t.gseq === undefined || t.time === undefined) return;
  if (await db.messages.get([acc, t.senderId, t.msgId])) return;
  const row: MessageRow = {
    accountId: acc,
    chatId: t.chatId,
    senderId: t.senderId,
    msgId: t.msgId,
    devId,
    seq: null,
    gseq: t.gseq,
    time: t.time,
    kind: 'deleted',
    body: '',
    reply: null,
    words: [],
  };
  await db.messages.put(row);
  if (t.gseq !== undefined && (t.reason === 'everyone' || t.reason === 'server')) {
    const prev = await db.tombstones.get([acc, t.senderId, t.msgId]);
    if (prev && prev.gseq === undefined) await db.tombstones.put({ ...prev, gseq: t.gseq, time: t.time });
  }
  const chat = await db.chats.get([acc, t.chatId]);
  if (chat && (!chat.last || t.gseq > chat.last.gseq)) await db.chats.put({ ...chat, last: lastOf(row) });
}

/** Owners of a group in the accepted states of one epoch. */
async function ownersOf(ctx: CoreContext, acc: string, chatId: string, epoch: number): Promise<Set<string>> {
  const states = await ctx.db.groupStates.where('[accountId+chatId]').equals([acc, chatId]).toArray();
  return new Set(states.filter((s) => s.epoch === epoch).map((s) => s.state.owner));
}

/** The reactions in force: one value per (sender, emoji), the highest gseq wins. */
export function aggregateReactions(controls: readonly Pick<ControlRow, 'kind' | 'senderId' | 'gseq' | 'emoji' | 'on'>[]): ReactionAgg[] {
  const latest = new Map<string, { sender: string; emoji: string; gseq: number; on: boolean }>();
  for (const c of controls) {
    if (c.kind !== 'react' || c.emoji === undefined) continue;
    const k = `${c.senderId}\u0000${c.emoji}`;
    const cur = latest.get(k);
    if (!cur || c.gseq > cur.gseq) latest.set(k, { sender: c.senderId, emoji: c.emoji, gseq: c.gseq, on: c.on === true });
  }
  const byEmoji = new Map<string, { users: string[]; first: number }>();
  for (const v of latest.values()) {
    if (!v.on) continue;
    const e = byEmoji.get(v.emoji) ?? { users: [], first: Infinity };
    e.users.push(v.sender);
    e.first = Math.min(e.first, v.gseq);
    byEmoji.set(v.emoji, e);
  }
  return [...byEmoji.entries()]
    .sort((a, b) => a[1].first - b[1].first || (a[0] < b[0] ? -1 : 1))
    .map(([emoji, e]) => ({ emoji, users: e.users.sort() }));
}

/**
 * Recomputes one message from its original event and all control events and
 * tombstones about it. Runs inside a transaction over COMMIT_TABLES.
 */
export async function recompute(ctx: CoreContext, acc: string, me: string, author: string, id: string, flags: CommitFlags): Promise<void> {
  const { db } = ctx;
  const key: [string, string, string] = [acc, author, id];
  const controls = await db.controls.where('[accountId+target]').equals([acc, `${author}/${id}`]).toArray();
  let tomb: TombstoneRow | undefined = await db.tombstones.get(key);
  if (!tomb || tomb.reason === 'server') {
    for (const d of controls.filter((c) => c.kind === 'delete').sort((a, b) => a.gseq - b.gseq)) {
      const chat = await db.chats.get([acc, d.chatId]);
      const allowed = d.senderId === author || (chat?.kind === 'group' && (await ownersOf(ctx, acc, d.chatId, d.epoch)).has(d.senderId));
      if (!allowed) continue;
      tomb = { ...(tomb ?? {}), accountId: acc, senderId: author, msgId: id, chatId: d.chatId, reason: 'everyone', by: d.senderId, at: ctx.clock.now() };
      await db.tombstones.put(tomb);
      break;
    }
  }
  const msg = await db.messages.get(key);
  if (tomb && tomb.reason !== 'server') {
    if (msg && tomb.gseq === undefined) {
      tomb = { ...tomb, gseq: msg.gseq, time: msg.time };
      await db.tombstones.put(tomb);
    }
    await eraseMessage(ctx, acc, me, author, id, msg, tomb, controls, flags);
    if (!msg && tomb.reason === 'everyone') await putDeletedRow(ctx, acc, tomb, '');
    return;
  }
  if (!msg || msg.kind !== 'msg') return;
  const edit = controls.filter((c) => c.kind === 'edit' && c.senderId === author).sort((a, b) => b.gseq - a.gseq)[0];
  const next: MessageRow = { ...msg };
  if (edit && edit.body !== undefined) {
    next.body = edit.body;
    next.edited = { gseq: edit.gseq, time: edit.time };
  }
  const reactions = aggregateReactions(controls);
  if (reactions.length > 0) next.reactions = reactions;
  else delete next.reactions;
  next.words = messageWords(next);
  await db.messages.put(next);
  const chat = await db.chats.get([acc, msg.chatId]);
  if (chat?.last && chat.last.senderId === author && chat.last.msgId === id && chat.last.body !== next.body) {
    await db.chats.put({ ...chat, last: { ...chat.last, body: next.body } });
  }
}

/** Applies a tombstone: the message becomes a quiet "deleted" row (for everyone) or disappears (for me). */
async function eraseMessage(
  ctx: CoreContext,
  acc: string,
  me: string,
  author: string,
  id: string,
  msg: MessageRow | undefined,
  tomb: TombstoneRow,
  controls: readonly ControlRow[],
  flags: CommitFlags,
): Promise<void> {
  const { db } = ctx;
  // The text of the message and of its edits leaves this device; reactions go too.
  await db.events.delete([acc, author, id]);
  for (const c of controls) {
    if (c.kind === 'delete') continue;
    await db.events.delete([acc, c.senderId, c.msgId]);
    await db.controls.delete([acc, c.senderId, c.msgId]);
  }
  for (const b of await db.blobs.where('[accountId+msgId]').equals([acc, id]).toArray()) {
    if (b.senderId !== author) continue;
    if (b.storage) flags.files.push({ storage: b.storage, key: fileKey(acc, b.blobId) });
    await db.blobs.delete([acc, b.blobId]);
  }
  if (!msg) return;
  if (msg.kind === 'deleted' && tomb.reason === 'everyone') return;
  const chat = await db.chats.get([acc, msg.chatId]);
  if (tomb.reason === 'local') {
    await db.messages.delete([acc, author, id]);
  } else {
    await db.messages.put({
      accountId: acc,
      chatId: msg.chatId,
      senderId: author,
      msgId: id,
      devId: msg.devId,
      seq: msg.seq,
      gseq: msg.gseq,
      time: msg.time,
      kind: 'deleted',
      body: '',
      reply: null,
      words: [],
    });
  }
  if (!chat) return;
  const next: ChatRow = { ...chat };
  if (msg.kind !== 'deleted' && author !== me && msg.gseq > chat.readGseq && chat.unread > 0) next.unread -= 1;
  if (chat.last && chat.last.senderId === author && chat.last.msgId === id) {
    const newest = await db.messages
      .where('[accountId+chatId+gseq]')
      .between([acc, msg.chatId, Dexie.minKey], [acc, msg.chatId, Dexie.maxKey])
      .last();
    next.last = newest ? lastOf(newest) : null;
  }
  await db.chats.put(next);
}

/**
 * "Delete for me": the message disappears from this device only (with its
 * attachment files); the server and other devices keep it.
 */
export async function deleteLocally(ctx: CoreContext, acc: string, me: string, author: string, id: string): Promise<void> {
  const { db } = ctx;
  const flags: CommitFlags = { attachments: false, files: [] };
  await db.transaction('rw', COMMIT_TABLES(db), async () => {
    const msg = await db.messages.get([acc, author, id]);
    if (!msg) return;
    // Also for a message already deleted for everyone: the quiet line goes away too.
    const tomb: TombstoneRow = { accountId: acc, senderId: author, msgId: id, chatId: msg.chatId, reason: 'local', by: me, at: ctx.clock.now(), gseq: msg.gseq, time: msg.time };
    await db.tombstones.put(tomb);
    const controls = await db.controls.where('[accountId+target]').equals([acc, `${author}/${id}`]).toArray();
    await eraseMessage(ctx, acc, me, author, id, msg, tomb, controls, flags);
  });
  await removeFiles(ctx, flags.files);
}

/** Stores tombstones (`everyone`, `local`) from an archive and applies them to messages already here. */
export async function importTombstones(ctx: CoreContext, acc: string, me: string, rows: readonly Omit<TombstoneRow, 'accountId'>[]): Promise<void> {
  const { db } = ctx;
  const flags: CommitFlags = { attachments: false, files: [] };
  await db.transaction('rw', COMMIT_TABLES(db), async () => {
    for (const r of rows) {
      const existing = await db.tombstones.get([acc, r.senderId, r.msgId]);
      // Local beats everyone beats server: the strongest deletion wins.
      const rank = { server: 0, everyone: 1, local: 2 } as const;
      if (existing && rank[existing.reason] >= rank[r.reason]) continue;
      await db.tombstones.put({ ...r, accountId: acc });
      await recompute(ctx, acc, me, r.senderId, r.msgId, flags);
    }
  });
  await removeFiles(ctx, flags.files);
}
