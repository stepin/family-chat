// @family-chat/core: the client core for stage M1 (no UI, no DOM).
// API client, local database, session and identity, sync engine, outbox,
// directory, administration, push, and the facade for the UI.

// The facade (start here).
export { createCore, FamilyChatCore, handlePushPayload, MESSAGES_PAGE, HISTORY_PAGE } from './core.ts';
export type {
  CoreOptions,
  AccountView,
  Member,
  ChatListItem,
  ChatView,
  MessageView,
  MessageStatus,
  OutboxItem,
  DraftItem,
  DiagnosticEntry,
  CreatedInvite,
} from './core.ts';
export type { JoinInput, RestoreInput } from './accounts.ts';
export type { ConnectionState } from './sync.ts';
export type { PushNotice } from './push.ts';
export { SETTING_PUSH_SHOW_TEXT } from './push.ts';
export { inviteLink, parseInviteFragment } from './invite.ts';

// Observable values.
export { writable, readonly, until, Writable } from './util/readable.ts';
export type { Readable, Subscriber, Unsubscribe, StartFn } from './util/readable.ts';

// Errors.
export { CoreError, isCoreError } from './errors.ts';
export type { CoreErrorCode } from './errors.ts';
export { ApiError, NetworkError, isApiError, isNetworkError, isTransient, isServerErrorCode } from './api/errors.ts';
export type { ApiErrorCode, ServerErrorCode, NetworkErrorReason } from './api/errors.ts';
export { DbVersionError } from './db/schema.ts';

// API client.
export { Transport, normalizeServerUrl, MAX_WAIT_SECONDS } from './api/transport.ts';
export type { TransportOptions, FetchFn, ExchangeInfo } from './api/transport.ts';
export type * from './api/types.ts';

// Database.
export { CoreDb, openDb, DEFAULT_DB_NAME, DB_VERSION } from './db/schema.ts';
export type {
  DbDeps,
  AccountRow,
  AccountStatus,
  RetentionGap,
  IdentityRow,
  UserRow,
  ChatRow,
  LastMessage,
  EventRow,
  MessageRow,
  MessageKind,
  OutboxRow,
  OutboxStatus,
  DraftRow,
  DiagnosticRow,
  DiagnosticLevel,
} from './db/schema.ts';
export { MAX_DIAGNOSTICS } from './db/diagnostics.ts';

// Building blocks (for workers, tests and advanced use).
export type { Clock } from './util/clock.ts';
export { systemClock } from './util/clock.ts';
export type { LockManagerLike } from './util/locks.ts';
export { webLocks, LeaseLocks } from './util/locks.ts';
export type { BackoffOptions } from './util/backoff.ts';
export { backoffDelay, DEFAULT_BACKOFF } from './util/backoff.ts';

