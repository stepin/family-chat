/**
 * Typed storage errors (docs/PLAN.md 7.7 and 7.8). The sync engine reacts to
 * `kind` only and never sees HTTP status codes.
 */
export type StorageErrorKind =
  | 'NotFound'
  | 'Auth'
  | 'Conflict'
  | 'Full'
  | 'Transient'
  | 'Fatal'
  | 'TooLarge'
  | 'Forbidden'
  | 'RateLimited';

/** Machine-readable detail for diagnostics; never used for control flow by the engine. */
export type StorageErrorReason =
  | 'http'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'not-multistatus'
  | 'bad-xml'
  | 'listing-too-large'
  | 'response-too-large'
  | 'not-a-collection'
  | 'invalid-path';

export interface StorageErrorInit {
  status?: number;
  reason?: StorageErrorReason;
  retryAfterMs?: number;
  cause?: unknown;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly kind: StorageErrorKind;
  readonly status: number | undefined;
  readonly reason: StorageErrorReason;
  readonly retryAfterMs: number | undefined;

  constructor(kind: StorageErrorKind, message: string, init: StorageErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = kind;
    this.status = init.status;
    this.reason = init.reason ?? 'http';
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function isStorageError(e: unknown, kind?: StorageErrorKind): e is StorageError {
  return e instanceof StorageError && (kind === undefined || e.kind === kind);
}

/** Maps an HTTP status of a failed WebDAV request to an error kind. */
export function kindForStatus(status: number): StorageErrorKind {
  switch (status) {
    case 401:
      return 'Auth';
    case 403:
      return 'Forbidden';
    case 404:
    case 410:
      return 'NotFound';
    case 409:
    case 412:
      return 'Conflict';
    case 413:
      return 'TooLarge';
    case 429:
      return 'RateLimited';
    case 507:
      return 'Full';
    case 408:
    case 423:
    case 425:
      return 'Transient';
    default:
      return status >= 500 ? 'Transient' : 'Fatal';
  }
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds from `nowMs`. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}
