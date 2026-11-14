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
  encodeEvent,
  encodeMsgPayload,
  MAX_BODY_BYTES,
  newMessageId,
  type MsgRef,
} from '@family-chat/protocol';
import { ApiError, isApiError, isTransient } from './api/errors.ts';
import { commitSent, type AccountRuntimeLike } from './apply.ts';
import { describeError } from './db/diagnostics.ts';
import type { OutboxRow } from './db/schema.ts';
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

/** Puts a message into the outbox. Returns its message id. */
export async function enqueueMessage(
  rt: AccountRuntimeLike,
  chatId: string,
  text: string,
  reply?: MsgRef,
): Promise<string> {
  checkMessageText(text);
  const { ctx, session } = rt;
  const { db } = ctx;
  const acc = session.accountId;
  const chat = await db.chats.get([acc, chatId]);
  if (!chat) throw new CoreError('unknown-chat');
  const msgId = newMessageId();
  await db.transaction('rw', [db.counters, db.outbox, db.drafts], async () => {
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
    });
    await db.drafts.delete([acc, chatId]);
  });
  return msgId;
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
      try {
        const chat = await db.chats.get([acc, fresh.chatId]);
        if (!chat) throw new CoreError('unknown-chat');
        let peer = await directory.identity(chat.peerId);
        if (!peer) {
          await directory.refresh();
          peer = await directory.identity(chat.peerId);
          if (!peer) throw new CoreError('unknown-user');
        }
        const keys = await directory.chatKeys(chat.peerId);
        const author = await ctx.keys(session.userId);
        const payload = encodeMsgPayload({
          id: fresh.msgId,
          dev: fresh.devId,
          seq: fresh.seq,
          body: fresh.body,
          ...(fresh.reply ? { reply: fresh.reply } : {}),
        });
        // A fresh nonce for every attempt (docs/PROTOCOL.md 6.4); the server
        // deduplicates by the Idempotency-Key.
        const body = await encodeEvent({ serverId: session.serverId, chatId: fresh.chatId, chat: keys, author, payload });
        const res = await session.call((t) =>
          session.transport.postEvent(t, { chatId: fresh.chatId, msgId: fresh.msgId, epoch: keys.epoch, body }),
        );
        await commitSent(ctx, acc, session.userId, fresh, chat.peerId, body, res);
        if (res.duplicate) void ctx.diag.info('outbox', `message ${fresh.msgId} was already on the server`, acc);
      } catch (e) {
        if (isCoreError(e, 'removed') || isCoreError(e, 'login-invalid')) return Infinity;
        if (isTransient(e)) {
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
