// Sync engine of one account: one cursor, a long-poll loop on GET /v1/events.
//
// - restarts at once after every answer (wait=25 s; wait=0 while `more` is true
//   or until the first full pass of a new device has finished);
// - on network errors backs off with jitter and reports "offline since …";
// - records a retention gap when `after + 1 < oldestGseq`;
// - verifies every event, stores messages and the cursor in one transaction,
//   and always replaces the cursor with the server's.

import { isApiError, isNetworkError, isTransient } from './api/errors.ts';
import type { EventsPage } from './api/types.ts';
import { commitEvents, decodeEvents, type AccountRuntimeLike } from './apply.ts';
import { describeError } from './db/diagnostics.ts';
import type { RetentionGap } from './db/schema.ts';
import { isCoreError } from './errors.ts';
import { backoffDelay } from './util/backoff.ts';
import { Waker } from './util/clock.ts';
import { writable, type Readable, type Writable } from './util/readable.ts';

export type ConnectionState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly since: number }
  | { readonly kind: 'offline'; readonly since: number }
  | { readonly kind: 'login-invalid' }
  /** Removed from the family, or (`reason: 'revoked'`) my identity was revoked. */
  | { readonly kind: 'removed'; readonly reason?: 'removed' | 'revoked' }
  | { readonly kind: 'stopped' };

export const EVENTS_PAGE_LIMIT = 500;

export interface SyncHooks {
  /** Called after each successful exchange with the server (the outbox uses it to retry at once). */
  onConnected?(): void;
}

export class SyncEngine {
  readonly #state: Writable<ConnectionState> = writable<ConnectionState>({ kind: 'stopped' });
  readonly #waker: Waker;
  #running = false;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #failures = 0;
  #offlineSince: number | undefined;

  constructor(
    private readonly rt: AccountRuntimeLike,
    private readonly hooks: SyncHooks = {},
  ) {
    this.#waker = new Waker(rt.ctx.clock);
  }

  get state(): Readable<ConnectionState> {
    return this.#state;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  /** Stops the loop and aborts the pending long poll. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#abort?.abort();
    this.#waker.kick();
    await this.#loop;
    this.#loop = undefined;
    this.#state.set({ kind: 'stopped' });
  }

  /** Retry now (after a re-login, or when the app comes back to the foreground). */
  kick(): void {
    this.#failures = 0;
    this.#waker.kick();
    this.#abort?.abort();
  }

  async #run(): Promise<void> {
    const { ctx, session } = this.rt;
    const acc = session.accountId;
    let more: boolean = false;
    this.#state.set({ kind: 'connecting' });
    while (this.#running) {
      const status = session.status.get();
      if (status === 'removed') {
        this.#state.set(await this.#removedState());
        return;
      }
      if (status === 'login-invalid') {
        this.#state.set({ kind: 'login-invalid' });
        await this.#waker.wait(Infinity);
        continue;
      }
      try {
        const account = await ctx.db.accounts.get(acc);
        if (!account) return;
        const wait: number = more || !account.initialSyncDone ? 0 : ctx.waitSeconds;
        this.#abort = new AbortController();
        const signal = this.#abort.signal;
        const page: EventsPage = await session.call((t) =>
          session.transport.events(t, { after: account.cursor, limit: EVENTS_PAGE_LIMIT, wait }, signal),
        );
        this.#abort = undefined;
        this.#failures = 0;
        this.#offlineSince = undefined;
        if (this.#state.get().kind !== 'connected') this.#state.set({ kind: 'connected', since: ctx.clock.now() });
        this.hooks.onConnected?.();
        await this.applyPage(page, account.cursor, !account.initialSyncDone);
        more = page.more;
      } catch (e) {
        this.#abort = undefined;
        if (!this.#running) break;
        if (isCoreError(e, 'removed') || isCoreError(e, 'revoked')) {
          this.#state.set(await this.#removedState());
          return;
        }
        if (isCoreError(e, 'login-invalid')) {
          this.#state.set({ kind: 'login-invalid' });
          continue;
        }
        if (isNetworkError(e) && e.reason === 'aborted') continue; // kick()
        this.#failures++;
        if (isTransient(e)) {
          this.#offlineSince ??= ctx.clock.now();
          this.#state.set({ kind: 'offline', since: this.#offlineSince });
        } else {
          void ctx.diag.error('sync', `events request failed: ${describeError(e)}`, acc);
        }
        const retryAfter = isApiError(e) ? (e.retryAfterMs ?? 0) : 0;
        const delay = Math.max(retryAfter, backoffDelay(this.#failures, ctx.backoff, ctx.random));
        await this.#waker.wait(delay);
      }
    }
  }

  async #removedState(): Promise<ConnectionState> {
    const row = await this.rt.ctx.db.accounts.get(this.rt.session.accountId).catch(() => undefined);
    return row?.revoked ? { kind: 'removed', reason: 'revoked' } : { kind: 'removed', reason: 'removed' };
  }

  /**
   * Verifies and stores one page of `GET /v1/events` together with its cursor.
   * Public for tests and for one-shot syncs (for example in a service worker).
   */
  async applyPage(page: EventsPage, after: number, firstSync: boolean): Promise<void> {
    const { ctx, session } = this.rt;
    const acc = session.accountId;
    let gap: RetentionGap | undefined;
    if (after + 1 < page.oldestGseq) {
      gap = {
        after,
        oldestGseq: page.oldestGseq,
        firstTime: page.events[0]?.time ?? page.notices[0]?.time ?? null,
        firstSync,
        detectedAt: ctx.clock.now(),
        oldestTime: page.oldestTime,
      };
      void ctx.diag.info(
        'sync',
        `events ${after + 1}..${page.oldestGseq - 1} were deleted by retention${firstSync ? ' (first sync)' : ''}`,
        acc,
      );
    }
    // Notices first: group states and keys they announce are needed to decrypt the events after them.
    const targets = await this.rt.groups.handleNotices(page.notices);
    if (targets.size > 0) await this.rt.groups.reconcile({ targets });
    const items = await decodeEvents(this.rt, page.events);
    if (page.cursor < after) {
      void ctx.diag.warn('sync', `server cursor went back from ${after} to ${page.cursor}`, acc);
    }
    const r = await commitEvents(ctx, acc, session.userId, items, {
      cursor: page.cursor,
      oldest: { gseq: page.oldestGseq, time: page.oldestTime },
      ...(gap ? { retentionGap: gap } : {}),
      ...(firstSync && !page.more ? { initialSyncDone: true } : {}),
    });
    if (r.attachments) this.rt.onAttachments?.();
  }

  /** One request without waiting (wait=0); returns whether more pages are pending. */
  async syncOnce(): Promise<boolean> {
    const { ctx, session } = this.rt;
    const account = await ctx.db.accounts.get(session.accountId);
    if (!account) return false;
    const page = await session.call((t) =>
      session.transport.events(t, { after: account.cursor, limit: EVENTS_PAGE_LIMIT, wait: 0 }),
    );
    await this.applyPage(page, account.cursor, !account.initialSyncDone);
    return page.more;
  }
}
