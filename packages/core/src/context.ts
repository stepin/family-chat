// Shared dependencies of the core: database, clock, locks, diagnostics,
// transports per server and identity keys (derived from the seed on demand,
// kept in memory only).

import { deriveIdentityKeys, type IdentityKeys } from '@family-chat/protocol';
import { Transport, type FetchFn } from './api/transport.ts';
import { Diagnostics } from './db/diagnostics.ts';
import type { CoreDb } from './db/schema.ts';
import { CoreError } from './errors.ts';
import { FileStores, type FileStorePreference, type OpfsDirectory } from './files.ts';
import { DEFAULT_BACKOFF, type BackoffOptions } from './util/backoff.ts';
import { systemClock, type Clock } from './util/clock.ts';
import { LeaseLocks, webLocks, type LockManagerLike } from './util/locks.ts';

export interface ContextOptions {
  readonly db: CoreDb;
  readonly fetch?: FetchFn;
  readonly clock?: Clock;
  /** Lock manager; defaults to Web Locks, or a lease in IndexedDB without them. */
  readonly locks?: LockManagerLike;
  /** Source of jitter (not of key material). */
  readonly random?: () => number;
  readonly backoff?: BackoffOptions;
  /** `wait` of the long poll, seconds (default 25). */
  readonly waitSeconds?: number;
  /** Timeout of ordinary requests, ms. */
  readonly timeoutMs?: number;
  /** Where attachment files are kept: 'auto' (OPFS when available, else IndexedDB), 'opfs' or 'idb'. */
  readonly fileStore?: FileStorePreference;
  /** OPFS root (tests); defaults to navigator.storage.getDirectory(). */
  readonly opfsRoot?: () => Promise<OpfsDirectory>;
}

export class CoreContext {
  readonly db: CoreDb;
  readonly clock: Clock;
  readonly locks: LockManagerLike;
  readonly random: () => number;
  readonly backoff: BackoffOptions;
  readonly waitSeconds: number;
  readonly diag: Diagnostics;
  readonly files: FileStores;
  readonly #fetch: FetchFn | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #transports = new Map<string, Transport>();
  readonly #keys = new Map<string, IdentityKeys>();

  constructor(o: ContextOptions) {
    this.db = o.db;
    this.clock = o.clock ?? systemClock;
    this.locks = o.locks ?? webLocks() ?? new LeaseLocks(o.db, this.clock);
    this.random = o.random ?? Math.random;
    this.backoff = o.backoff ?? DEFAULT_BACKOFF;
    this.waitSeconds = o.waitSeconds ?? 25;
    this.diag = new Diagnostics(o.db, this.clock);
    this.files = new FileStores(o.db, o.fileStore ?? 'auto', o.opfsRoot);
    this.#fetch = o.fetch;
    this.#timeoutMs = o.timeoutMs;
  }

  /** One Transport per server address, reporting every exchange to diagnostics. */
  transport(serverUrl: string, accountId: string | null = null): Transport {
    const key = `${serverUrl}\n${accountId ?? ''}`;
    let t = this.#transports.get(key);
    if (!t) {
      t = new Transport({
        baseUrl: serverUrl,
        clock: this.clock,
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
        ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
        onExchange: (x) => {
          // Successful empty long polls would flood the 500-entry log; skip them.
          if (x.path === '/v1/events' && x.status === 200 && !x.events) return;
          const level = x.status === 0 || x.status >= 500 ? 'warn' : 'info';
          const extra = x.events ? ` events=${x.events}` : '';
          void this.diag.log(
            level,
            'http',
            `${x.method} ${x.path} ${x.status}${x.error ? ` ${x.error}` : ''} ${x.durationMs}ms${extra}`,
            accountId,
          );
        },
      });
      this.#transports.set(key, t);
    }
    return t;
  }

  /** Identity keys of a user whose seed is on this device. */
  async keys(userId: string): Promise<IdentityKeys> {
    const cached = this.#keys.get(userId);
    if (cached) return cached;
    const row = await this.db.identities.get(userId);
    if (!row) throw new CoreError('no-identity');
    const keys = deriveIdentityKeys(row.seed);
    if (keys.userId !== userId) throw new CoreError('no-identity', 'stored seed does not match its userId');
    this.#keys.set(userId, keys);
    return keys;
  }

  rememberKeys(keys: IdentityKeys): void {
    this.#keys.set(keys.userId, keys);
  }

  /** Drops the cached keys of an identity whose seed was removed from this device. */
  forgetKeys(userId: string): void {
    this.#keys.delete(userId);
  }
}
