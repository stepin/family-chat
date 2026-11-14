// @family-chat/core: the client core (stage M2; no UI, no DOM).
// API client, local database, session and identity, sync engine, outbox,
// directory, groups, attachments, avatars, revocation, archive,
// administration, push, and the facade for the UI.

// The facade (start here).
export { createCore, FamilyChatCore, handlePushPayload, MESSAGES_PAGE, HISTORY_PAGE } from './core.ts';
export type {
  CoreOptions,
  AccountView,
  JoinResult,
  Member,
  ChatListItem,
  ChatView,
  MessageView,
  MessageStatus,
  OutboxItem,
  DraftItem,
  DiagnosticEntry,
  CreatedInvite,
  OutgoingMessage,
  AvatarView,
} from './core.ts';
export type {
  ChatSummary,
  GroupView,
  GroupMemberView,
  AttachmentView,
  AttachmentStatus,
  TransferView,
} from './views.ts';
export type { AttachmentInput } from './attachments.ts';
export type { ExportOptions, ImportResult, ArchiveSource } from './archive.ts';
export { SETTING_AUTO_DOWNLOAD, AUTO_DOWNLOAD_MAX_BYTES } from './apply.ts';
export { MAX_AVATAR_BYTES } from './avatars.ts';
// Attachment limits and types of the protocol, for the UI's own checks.
export { IMAGE_TYPES, MAX_ATTACHMENTS, MAX_THUMB_BYTES } from '@family-chat/protocol';
export type { FileStore, FileStoreKind, FileStorePreference, OpfsDirectory } from './files.ts';
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
  ChatKind,
  ServiceEntry,
  ServerLimits,
  GroupRow,
  GroupStateRow,
  GroupOp,
  BlobRow,
  BlobStatus,
} from './db/schema.ts';
export { MAX_DIAGNOSTICS } from './db/diagnostics.ts';

// Building blocks (for workers, tests and advanced use).
export type { Clock } from './util/clock.ts';
export { systemClock } from './util/clock.ts';
export type { LockManagerLike } from './util/locks.ts';
export { webLocks, LeaseLocks } from './util/locks.ts';
export type { BackoffOptions } from './util/backoff.ts';
export { backoffDelay, DEFAULT_BACKOFF } from './util/backoff.ts';

