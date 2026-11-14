// Diagnostics log: the last 500 entries, for the diagnostics screen and the
// "copy report" button. Callers compose messages from non-secret values only
// (status codes, error codes, chat ids, gseq, device ids). As a second line of
// defence, anything that looks like a device token or a long base64 blob is
// redacted, and generic error messages are cut short.

import { isProtocolError } from '@family-chat/protocol';
import { ApiError, NetworkError } from '../api/errors.ts';
import type { Clock } from '../util/clock.ts';
import type { CoreDb, DiagnosticLevel, DiagnosticRow } from './schema.ts';

export const MAX_DIAGNOSTICS = 500;

// Device tokens are 43 base64url characters; keys, signatures and nonces are
// as long or longer. Ids worth logging (userId, chatId, msgId: 26 characters,
// devId: 16) are shorter, so every run of 40+ such characters is redacted.
const LONG_B64 = /[A-Za-z0-9_-]{40,}/g;

export function scrub(text: string): string {
  return text.replace(LONG_B64, '[redacted]').slice(0, 300);
}

/** Short, safe description of an error: type and code, no payloads. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.code}`;
  if (e instanceof NetworkError) return `network ${e.reason}`;
  if (isProtocolError(e)) return `protocol ${e.code}`;
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `${e.name} ${code}` : scrub(`${e.name}: ${e.message}`).slice(0, 120);
  }
  return 'unknown error';
}

export class Diagnostics {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: CoreDb,
    private readonly clock: Clock,
  ) {}

  /** Appends an entry. Never throws; writes are serialised. */
  log(level: DiagnosticLevel, kind: string, message: string, accountId: string | null = null): Promise<void> {
    const row: DiagnosticRow = { time: this.clock.now(), level, accountId, kind, message: scrub(message) };
    this.#queue = this.#queue.then(async () => {
      try {
        await this.db.transaction('rw', this.db.diagnostics, async () => {
          await this.db.diagnostics.add(row);
          const n = await this.db.diagnostics.count();
          if (n > MAX_DIAGNOSTICS) {
            const old = await this.db.diagnostics.orderBy('id').limit(n - MAX_DIAGNOSTICS).primaryKeys();
            await this.db.diagnostics.bulkDelete(old);
          }
        });
      } catch {
        // The log is best effort (the database may be closing).
      }
    });
    return this.#queue;
  }

  info(kind: string, message: string, accountId: string | null = null): Promise<void> {
    return this.log('info', kind, message, accountId);
  }

  warn(kind: string, message: string, accountId: string | null = null): Promise<void> {
    return this.log('warn', kind, message, accountId);
  }

  error(kind: string, message: string, accountId: string | null = null): Promise<void> {
    return this.log('error', kind, message, accountId);
  }

  /** Resolves when every queued write has finished. */
  flush(): Promise<void> {
    return this.#queue;
  }

  async clear(): Promise<void> {
    await this.flush();
    await this.db.diagnostics.clear();
  }

  /** Plain-text report, oldest first. */
  async report(): Promise<string> {
    await this.flush();
    const rows = await this.db.diagnostics.orderBy('id').toArray();
    return rows
      .map((r) => `${new Date(r.time).toISOString()} ${r.level} ${r.kind}${r.accountId ? ` [${r.accountId}]` : ''} ${r.message}`)
      .join('\n');
  }
}
