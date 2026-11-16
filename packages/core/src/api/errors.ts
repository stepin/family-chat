// Typed errors of the API client. They mirror the server's error codes
// (docs/API.md, section 1.4). Messages contain only the method, the path
// template, the status and the code: never tokens, codes or bodies.

export type ServerErrorCode =
  | 'bad_request'
  | 'bad_member'
  | 'unknown_avatar'
  | 'bad_image'
  | 'unauthorized'
  | 'bad_signature'
  | 'bad_nonce'
  | 'removed'
  | 'revoked'
  | 'not_member'
  | 'not_owner'
  | 'not_admin'
  | 'peer_removed'
  | 'invalid_invite'
  | 'invalid_code'
  | 'not_found'
  | 'chat_not_found'
  | 'unknown_user'
  | 'blob_not_found'
  | 'method_not_allowed'
  | 'already_member'
  | 'stale_rev'
  | 'stale_version'
  | 'chat_exists'
  | 'owner_cannot_leave'
  | 'epoch_mismatch'
  | 'idempotency_conflict'
  | 'push_disabled'
  | 'cannot_remove_self'
  | 'invite_used'
  | 'invite_expired'
  | 'too_large'
  | 'rate_limited'
  | 'internal'
  | 'storage_full'
  // M5: sticker packs
  | 'pack_not_found'
  | 'file_not_found'
  | 'hash_mismatch'
  | 'bad_sticker'
  | 'pack_published'
  | 'missing_file'
  | 'file_mismatch'
  | 'not_author'
  | 'bad_manifest'
  | 'too_many_packs'
  // M8: server checks
  | 'admin_code_inactive'
  | 'push_failed'
  | 'no_subscription'
  | 'too_many_pending'
  | 'shutting_down';

const SERVER_CODES: ReadonlySet<string> = new Set<ServerErrorCode>([
  'bad_request',
  'bad_member',
  'unknown_avatar',
  'bad_image',
  'unauthorized',
  'bad_signature',
  'bad_nonce',
  'removed',
  'revoked',
  'not_member',
  'not_owner',
  'not_admin',
  'peer_removed',
  'invalid_invite',
  'invalid_code',
  'not_found',
  'chat_not_found',
  'unknown_user',
  'blob_not_found',
  'method_not_allowed',
  'already_member',
  'stale_rev',
  'stale_version',
  'chat_exists',
  'owner_cannot_leave',
  'epoch_mismatch',
  'idempotency_conflict',
  'push_disabled',
  'cannot_remove_self',
  'invite_used',
  'invite_expired',
  'too_large',
  'rate_limited',
  'internal',
  'storage_full',
  'pack_not_found',
  'file_not_found',
  'hash_mismatch',
  'bad_sticker',
  'pack_published',
  'missing_file',
  'file_mismatch',
  'not_author',
  'bad_manifest',
  'too_many_packs',
  'admin_code_inactive',
  'push_failed',
  'no_subscription',
  'too_many_pending',
  'shutting_down',
]);

/**
 * `unexpected_response`: the answer is not what the API promises (an HTML page
 * from a proxy or a captive portal, broken JSON, an unknown error code).
 */
export type ApiErrorCode = ServerErrorCode | 'unexpected_response';

export function isServerErrorCode(code: unknown): code is ServerErrorCode {
  return typeof code === 'string' && SERVER_CODES.has(code);
}

/** The server answered with an error status (or with something unreadable). */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ApiErrorCode;
  /** `Retry-After` in milliseconds (429). */
  readonly retryAfterMs: number | undefined;
  /** Extra numeric fields of the error body: `epoch`, `limit`, `rev`, `version`. */
  readonly details: Readonly<Record<string, number>>;
  /** `reason` of the error body (`push_failed`: gone, unauthorized, rejected, network). */
  readonly reason: string | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    where: string,
    options: { retryAfterMs?: number | undefined; details?: Record<string, number>; reason?: string | undefined } = {},
  ) {
    super(`${where}: HTTP ${status} ${code}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details ?? {};
    this.reason = options.reason;
  }
}

export type NetworkErrorReason = 'offline' | 'timeout' | 'aborted';

/** No HTTP answer: no connection, timeout, or the caller aborted. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
  readonly reason: NetworkErrorReason;

  constructor(reason: NetworkErrorReason, where: string) {
    super(`${where}: ${reason}`);
    this.reason = reason;
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export function isNetworkError(e: unknown): e is NetworkError {
  return e instanceof NetworkError;
}

/**
 * Worth retrying later with the same request: no connection, timeout, server
 * errors (5xx, including 507 storage full), 429, and unreadable answers
 * (typically a proxy page while the server restarts).
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof NetworkError) return e.reason !== 'aborted';
  if (e instanceof ApiError) {
    return e.status >= 500 || e.status === 429 || e.code === 'unexpected_response' || e.status === 0;
  }
  return false;
}
