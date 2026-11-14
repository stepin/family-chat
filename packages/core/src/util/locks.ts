// Exclusive locks across tabs and workers. Web Locks when the platform has
// them; otherwise a lease row in IndexedDB (with an in-process queue so that
// one context never races itself).

import type { CoreDb } from '../db/schema.ts';
import { sleep, type Clock } from './clock.ts';

export interface LockManagerLike {
  /** Runs `fn` while holding the exclusive lock `name`. */
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

interface WebLocks {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

/** The platform's Web Locks, or undefined. */
export function webLocks(): LockManagerLike | undefined {
  const locks = (globalThis as { navigator?: { locks?: WebLocks } }).navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return undefined;
  return { request: (name, fn) => locks.request(name, () => fn()) };
}

export interface LeaseLockOptions {
  /** Lease duration; renewed while held. Default 15 s. */
  readonly ttlMs?: number;
  /** How often a waiting context retries. Default 250 ms. */
  readonly pollMs?: number;
  readonly owner?: string;
}

/**
 * Fallback lock: a row `{name, owner, expiresAt}` in the `leases` table. A
 * context takes the lease when it is free or expired, renews it while it
 * works, and deletes it when done. A crashed holder blocks others for at most
 * one lease duration.
 */
export class LeaseLocks implements LockManagerLike {
  readonly #owner: string;
  readonly #ttl: number;
  readonly #poll: number;
  readonly #local = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: CoreDb,
    private readonly clock: Clock,
    options: LeaseLockOptions = {},
  ) {
    this.#owner = options.owner ?? Math.random().toString(36).slice(2) + this.clock.now().toString(36);
    this.#ttl = options.ttlMs ?? 15_000;
    this.#poll = options.pollMs ?? 250;
  }

  request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#local.get(name) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.#withLease(name, fn));
    this.#local.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }

  async #tryTake(name: string): Promise<boolean> {
    return this.db.transaction('rw', this.db.leases, async () => {
      const row = await this.db.leases.get(name);
      const now = this.clock.now();
      if (row && row.owner !== this.#owner && row.expiresAt > now) return false;
      await this.db.leases.put({ name, owner: this.#owner, expiresAt: now + this.#ttl });
      return true;
    });
  }

  async #withLease<T>(name: string, fn: () => Promise<T>): Promise<T> {
    while (!(await this.#tryTake(name))) await sleep(this.clock, this.#poll);
    let timer: unknown;
    let released = false;
    const renew = (): void => {
      if (released) return;
      timer = this.clock.setTimeout(() => {
        if (released) return;
        void this.db.leases
          .update(name, { expiresAt: this.clock.now() + this.#ttl })
          .catch(() => undefined)
          .then(renew);
      }, this.#ttl / 3);
    };
    renew();
    try {
      return await fn();
    } finally {
      released = true;
      this.clock.clearTimeout(timer);
      await this.db
        .transaction('rw', this.db.leases, async () => {
          const row = await this.db.leases.get(name);
          if (row?.owner === this.#owner) await this.db.leases.delete(name);
        })
        .catch(() => undefined);
    }
  }
}
