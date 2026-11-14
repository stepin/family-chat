// Errors raised by the core itself (as opposed to ApiError / NetworkError from
// the transport and ProtocolError from the crypto package).

export type CoreErrorCode =
  /** No such account on this device. */
  | 'no-account'
  /** The identity seed for this user is not on this device. */
  | 'no-identity'
  /** An account for this server already exists on this device. */
  | 'account-exists'
  /** Re-login by signature failed for a reason that retrying will not fix. */
  | 'login-invalid'
  /** The person was removed from the family (403 `removed`). */
  | 'removed'
  /** The user is not known (not in `GET /v1/users`). */
  | 'unknown-user'
  /** Chat with oneself: not thrown since M2 (kept for compatibility). */
  | 'self-chat'
  /** No such chat on this device. */
  | 'unknown-chat'
  /** Bad argument from the caller (empty text, too long, wrong state). */
  | 'invalid-input'
  /** The server speaks another protocol version. */
  | 'unsupported-server'
  /** The core was stopped or closed. */
  | 'closed'
  /** A file or image is larger than the server accepts (checked before anything is sent). */
  | 'too-large'
  /** Not (or no longer) a member of this group. */
  | 'not-member'
  /** Only the group owner can do this. */
  | 'not-owner'
  /** The group owner must transfer ownership before leaving. */
  | 'owner-cannot-leave'
  /** A previous group change is still being sent; try again later. */
  | 'busy'
  /** The key of the group's current epoch has not arrived yet. */
  | 'need-key'
  /** The member's identity is revoked: nothing is encrypted to it any more. */
  | 'peer-revoked'
  /** My identity is revoked on this server. */
  | 'revoked'
  /** The archive was written by another identity. */
  | 'wrong-identity'
  /** The archive is damaged, truncated or not an archive. */
  | 'bad-archive'
  /** An attachment is not on the server any more (deleted or expired). */
  | 'gone';

export class CoreError extends Error {
  override readonly name = 'CoreError';
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export function isCoreError(e: unknown, code?: CoreErrorCode): e is CoreError {
  return e instanceof CoreError && (code === undefined || e.code === code);
}
