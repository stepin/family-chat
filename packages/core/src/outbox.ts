// Sending: a persistent outbox and one sender at a time across tabs.
//
// enqueue: `seq` and the message id are allocated in the same transaction
// that inserts the outbox row (and clears the chat's draft).
// OutboxSender: drains the queue under an exclusive lock (Web Locks, or the
// lease fallback), taken for one pass at a time. Transient errors (network,
// 5xx, 429) keep the message "on device" and retry with backoff and the same
// Idempotency-Key; other errors mark it "failed" until retried or cancelled.
// Server time and order come from the POST answer.

import {
  encodeDeletePayload,
  encodeEditPayload,
  encodeEvent,
  encodeMsgPayload,
  encodeReactPayload,
  MAX_BODY_BYTES,
  newMessageId,
  stickerEmojiProblem,
  stickerRefProblem,
  type Attachment,
  type StickerRef,
  type ChatKeys,
  type Location,
  type MsgRef,
} from '@family-chat/protocol';
import { ApiError, isApiError, isTransient } from './api/errors.ts';
import { commitSent, outboxPayload, type AccountRuntimeLike } from './apply.ts';
import { describeError } from './db/diagnostics.ts';
import type { OutboxControl, OutboxRow } from './db/schema.ts';
import { CoreError, isCoreError } from './errors.ts';
import { backoffDelay } from './util/backoff.ts';
import { Waker } from './util/clock.ts';

const ENCODER = new TextEncoder();

export function checkMessageText(text: string): void {
  if (typeof text !== 'string' || text.trim().length === 0) throw new CoreError('invalid-input', 'message is empty');
  if (ENCODER.encode(text).length > MAX_BODY_BYTES) {
    throw new CoreError('invalid-input', `message is longer than ${MAX_BODY_BYTES} bytes`);
  }
}

/** The protocol's rules for a place (docs/PROTOCOL.md 7), checked before the message is queued. */
export function checkLocation(l: Location): void {
  const ok = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!l || !ok(l.lat, -90, 90) || !ok(l.lon, -180, 180) || !ok(l.accuracy, 0, 1e7)) {
    throw new CoreError('invalid-input', 'location must have lat -90..90, lon -180..180 and accuracy 0..10^7 m');
  }
}

export interface MessageExtras {
  readonly reply?: MsgRef | undefined;
  readonly attachments?: readonly Attachment[];
  readonly location?: Location;
  readonly fwd?: boolean;
  /** A sticker (M5); the text is then its emoji. */
  readonly sticker?: StickerRef;
  /** Use this message id (attachments were prepared under it). */
  readonly msgId?: string;
  /** Extra work in the same transaction as the outbox row (attachment rows). */
  readonly inTransaction?: () => Promise<void>;
}

/** Puts a message into the outbox. Returns its message id. */
export async function enqueueMessage(
  rt: AccountRuntimeLike,
  chatId: string,
  text: string,
  replyOrExtras?: MsgRef | MessageExtras,
): Promise<string> {
  const extras: MessageExtras =
    replyOrExtras && 'author' in replyOrExtras ? { reply: replyOrExtras } : ((replyOrExtras as MessageExtras | undefined) ?? {});
  const reply = extras.reply;
  const hasContent = (extras.attachments?.length ?? 0) > 0 || extras.location !== undefined;
  if (!hasContent || text.length > 0) checkMessageText(text);
  if (extras.location !== undefined) checkLocation(extras.location);
  if (extras.sticker !== undefined) {
    const p = stickerRefProblem(extras.sticker) ?? stickerEmojiProblem(text);
    if (p || hasContent) throw new CoreError('invalid-input', `sticker: ${p ?? 'no attachments or place with a sticker'}`);
  }
  const { ctx, session } = rt;
  const { db } = ctx;
  const acc = session.accountId;
  const chat = await db.chats.get([acc, chatId]);
  if (!chat) throw new CoreError('unknown-chat');
  if (chat.kind === 'group') {
    const g = await db.groups.get([acc, chatId]);
    if (!g?.member) throw new CoreError('not-member');
  } else if (chat.kind === 'dm') {
    const peer = await rt.directory.user(chat.peerId);
    if (peer?.revoked) throw new CoreError('peer-revoked');
  }
  const msgId = extras.msgId ?? newMessageId();
  await db.transaction('rw', [db.counters, db.outbox, db.drafts, db.blobs], async () => {
    const counter = await db.counters.get([acc, chatId]);
    const seq = counter?.nextSeq ?? 1;
    await db.counters.put({ accountId: acc, chatId, nextSeq: seq + 1 });
    const now = ctx.clock.now();
    await db.outbox.add({
      accountId: acc,
      msgId,
      chatId,
      devId: session.devId,
      seq,
      body: text,
      reply: reply ?? null,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      error: null,
      ...(extras.attachments && extras.attachments.length > 0 ? { attachments: [...extras.attachments] } : {}),
      ...(extras.location ? { location: extras.location } : {}),
      ...(extras.fwd ? { fwd: true as const } : {}),
      ...(extras.sticker ? { sticker: extras.sticker } : {}),
    });
    // A sticker leaves the half-written text alone.
    if (!extras.sticker) await db.drafts.delete([acc, chatId]);
    await extras.inTransaction?.();
  });
  return msgId;
}

/**
 * Puts a control event (edit, delete for everyone, reaction) into the outbox.
 * It goes out in queue order like a message. Returns its event id.
 */
export async function enqueueControl(rt: AccountRuntimeLike, chatId: string, control: OutboxControl): Promise<string> {
  if (control.kind === 'edit' && ENCODER.encode(control.body).length > MAX_BODY_BYTES) {
    throw new CoreError('invalid-input', `message is longer than ${MAX_BODY_BYTES} bytes`);
  }
  const { ctx, session } = rt;
  const { db } = ctx;
  const acc = session.accountId;
  const chat = await db.chats.get([acc, chatId]);
  if (!chat) throw new CoreError('unknown-chat');
  if (chat.kind === 'group') {
    const g = await db.groups.get([acc, chatId]);
    if (!g?.member) throw new CoreError('not-member');
  }
  const msgId = newMessageId();
  await db.transaction('rw', [db.counters, db.outbox], async () => {
    const counter = await db.counters.get([acc, chatId]);
    const seq = counter?.nextSeq ?? 1;
    await db.counters.put({ accountId: acc, chatId, nextSeq: seq + 1 });
    const now = ctx.clock.now();
    await db.outbox.add({
      accountId: acc,
      msgId,
      chatId,
      devId: session.devId,
      seq,
      body: '',
      reply: null,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      error: null,
      control,
    });
  });
  return msgId;
}

/** Encodes the payload of an outbox row: a message or a control event. */
function encodeRow(row: OutboxRow): Uint8Array {
  const c = row.control;
  const common = { id: row.msgId, dev: row.devId, seq: row.seq };
  if (!c) return encodeMsgPayload({ ...outboxPayload(row), ...(row.fwd ? { fwd: true } : {}) });
  switch (c.kind) {
    case 'edit':
      return encodeEditPayload({ ...common, target: c.target, body: c.body });
    case 'delete':
      return encodeDeletePayload({ ...common, target: c.target, targetDev: c.targetDev, targetSeq: c.targetSeq });
    case 'react':
      return encodeReactPayload({ ...common, target: c.target, emoji: c.emoji, on: c.on });
  }
}

/** Upload state of an outbox row's attachments: all done, still running, or one failed. */
async function uploadState(rt: AccountRuntimeLike, row: OutboxRow): Promise<'ready' | 'waiting' | 'failed'> {
  if (!row.attachments || row.attachments.length === 0) return 'ready';
  const { db } = rt.ctx;
  for (const a of row.attachments) {
    const b = await db.blobs.get([row.accountId, a.blob.id]);
    if (!b || b.status === 'failed' || b.status === 'cancelled') return 'failed';
    if (b.status !== 'done') return 'waiting';
  }
  return 'ready';
}

/** Queue order: creation time, then seq (two messages may share a millisecond). */
export function byQueueOrder(a: OutboxRow, b: OutboxRow): number {
  return a.createdAt - b.createdAt || a.seq - b.seq;
}

export class OutboxSender {
  readonly #waker: Waker;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(private readonly rt: AccountRuntimeLike) {
    this.#waker = new Waker(rt.ctx.clock);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#waker.kick();
    await this.#loop;
    this.#loop = undefined;
  }

  /** Look at the queue now (new message, connection back, manual retry). */
  kick(): void {
    this.#waker.kick();
  }

  async #run(): Promise<void> {
    const { ctx, session } = this.rt;
    while (this.#running) {
      let nextAt = Infinity;
      if (session.status.get() === 'active') {
        try {
          nextAt = await ctx.locks.request(`fc-outbox-${session.accountId}`, () => this.drain());
        } catch (e) {
          void ctx.diag.error('outbox', `send pass failed: ${describeError(e)}`, session.accountId);
          nextAt = ctx.clock.now() + backoffDelay(1, ctx.backoff, ctx.random);
        }
      }
      if (!this.#running) break;
      await this.#waker.wait(nextAt - ctx.clock.now());
    }
  }

  /**
   * One pass over the queue, in order. Returns the local time of the next
   * scheduled retry (Infinity when nothing waits). Call it under the lock.
   */
  async drain(): Promise<number> {
    const { ctx, session, directory } = this.rt;
    const { db } = ctx;
    const acc = session.accountId;
    const rows = (await db.outbox.where('accountId').equals(acc).toArray()).sort(byQueueOrder);
    for (const row of rows) {
      if (row.status !== 'pending') continue;
      if (row.nextAttemptAt > ctx.clock.now()) return row.nextAttemptAt; // keep the order
      // Re-read: another context may have sent or cancelled it meanwhile.
      const fresh = await db.outbox.get([acc, row.msgId]);
      if (!fresh || fresh.status !== 'pending') continue;
      // Attachments upload first; a message waiting for them does not hold up the rest.
      const uploads = await uploadState(this.rt, fresh);
      if (uploads === 'waiting') continue;
      try {
        if (fresh.control?.kind === 'delete' && fresh.control.posted) {
          await this.#serverCleanup(fresh, fresh.control);
          continue;
        }
        if (uploads === 'failed') throw new CoreError('invalid-input', 'attachment upload failed');
        const chat = await db.chats.get([acc, fresh.chatId]);
        if (!chat) throw new CoreError('unknown-chat');
        const author = await ctx.keys(session.userId);
        const payload = encodeRow(fresh);
        let res;
        let body: Uint8Array;
        let epoch = 0;
        for (let attempt = 0; ; attempt++) {
          const keys: ChatKeys = await this.#keysFor(chat);
          epoch = keys.epoch;
          // A fresh nonce for every attempt (docs/PROTOCOL.md 6.4); the server
          // deduplicates by the Idempotency-Key.
          body = await encodeEvent({ serverId: session.serverId, chatId: fresh.chatId, chat: keys, author, payload });
          const sendBody = body;
          try {
            res = await session.call((t) =>
              session.transport.postEvent(t, {
                chatId: fresh.chatId,
                msgId: fresh.msgId,
                epoch: keys.epoch,
                body: sendBody,
                // Edits, deletions and reactions ask the server not to notify (docs/API.md 4.1).
                ...(fresh.control ? { silent: true } : {}),
              }),
            );
            break;
          } catch (e) {
            // The group moved to a new epoch: fetch the key, re-encrypt with the same id, send again.
            if (chat.kind === 'group' && isApiError(e, 'epoch_mismatch') && attempt < 3) {
              void ctx.diag.info('outbox', `message ${fresh.msgId}: epoch changed, re-encrypting`, acc);
              await this.rt.groups.reconcile({ full: true });
              continue;
            }
            if (chat.kind === 'group' && isApiError(e, 'not_member')) {
              await this.rt.groups.reconcile({ full: true }).catch(() => undefined);
            }
            throw e;
          }
        }
        await commitSent(ctx, acc, session.userId, fresh, chat, epoch, body, res);
        if (res.duplicate) void ctx.diag.info('outbox', `message ${fresh.msgId} was already on the server`, acc);
      } catch (e) {
        if (isCoreError(e, 'removed') || isCoreError(e, 'login-invalid') || isCoreError(e, 'revoked')) return Infinity;
        if (isTransient(e) || isCoreError(e, 'need-key')) {
          const attempts = fresh.attempts + 1;
          const retryAfter = isApiError(e) ? (e.retryAfterMs ?? 0) : 0;
          const nextAttemptAt =
            ctx.clock.now() + Math.max(retryAfter, backoffDelay(attempts, ctx.backoff, ctx.random));
          await db.outbox.update([acc, fresh.msgId], { attempts, nextAttemptAt, error: errorCode(e) });
          void ctx.diag.info('outbox', `message ${fresh.msgId} not sent yet: ${describeError(e)}`, acc);
          return nextAttemptAt;
        }
        await db.outbox.update([acc, fresh.msgId], {
          status: 'failed',
          attempts: fresh.attempts + 1,
          error: errorCode(e),
        });
        void ctx.diag.warn('outbox', `message ${fresh.msgId} failed: ${describeError(e)}`, acc);
      }
    }
    return Infinity;
  }

  /**
   * After a delete event is on the server: the target's record is zeroed on
   * the server and my uploads of it are removed. Gone already counts as done.
   */
  async #serverCleanup(row: OutboxRow, c: Extract<OutboxControl, { kind: 'delete' }>): Promise<void> {
    const { ctx, session } = this.rt;
    const acc = session.accountId;
    if (c.targetGseq !== null) {
      const gseq = c.targetGseq;
      try {
        await session.call((t) => session.transport.deleteEvent(t, row.chatId, gseq));
      } catch (e) {
        if (isTransient(e) || isCoreError(e)) throw e;
        // Removed by retention, never stored, or not mine to delete (a former owner): nothing more to do.
        void ctx.diag.info('outbox', `server copy of event ${gseq} not deleted: ${describeError(e)}`, acc);
      }
    }
    for (const blobId of c.blobIds) {
      try {
        await session.call((t) => session.transport.deleteBlob(t, blobId));
      } catch (e) {
        if (isTransient(e) || isCoreError(e)) throw e;
        if (!isApiError(e, 'blob_not_found')) void ctx.diag.info('outbox', `attachment ${blobId} not deleted: ${describeError(e)}`, acc);
      }
    }
    await ctx.db.outbox.delete([acc, row.msgId]);
  }

  async #keysFor(chat: { kind: string; peerId: string; chatId: string }): Promise<ChatKeys> {
    const { directory, groups } = this.rt;
    if (chat.kind === 'group') return groups.sendKeys(chat.chatId);
    let peer = await directory.identity(chat.peerId);
    if (!peer) {
      await directory.refresh();
      peer = await directory.identity(chat.peerId);
      if (!peer) throw new CoreError('unknown-user');
    }
    if (chat.kind === 'dm' && (await directory.user(chat.peerId))?.revoked) throw new CoreError('peer-revoked');
    return directory.chatKeys(chat.peerId);
  }
}

function errorCode(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  if (e instanceof CoreError) return e.code;
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
  if (e instanceof Error && e.name === 'NetworkError') return 'network';
  return 'error';
}

/** Failed → pending again, at once. */
export async function retryMessage(rt: AccountRuntimeLike, msgId: string): Promise<void> {
  const { db, clock } = rt.ctx;
  const acc = rt.session.accountId;
  await db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get([acc, msgId]);
    if (!row) throw new CoreError('invalid-input', 'no such message in the outbox');
    await db.outbox.put({ ...row, status: 'pending', attempts: 0, nextAttemptAt: clock.now(), error: null });
  });
}

/**
 * Removes a message that is not on the server yet. If a send is in flight at
 * that moment, the message may still arrive; it then shows up through sync.
 */
export async function cancelMessage(rt: AccountRuntimeLike, msgId: string): Promise<void> {
  const { db } = rt.ctx;
  const acc = rt.session.accountId;
  const row: OutboxRow | undefined = await db.outbox.get([acc, msgId]);
  if (!row) throw new CoreError('invalid-input', 'no such message in the outbox');
  await db.outbox.delete([acc, msgId]);
}
