// @family-chat/core: the client core (no UI, no DOM).
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
  ChatView,
  MessageView,
  MessageStatus,
  OutboxItem,
  DraftItem,
  DiagnosticEntry,
  CreatedInvite,
  OutgoingMessage,
  AvatarView,
  GlobalSearchResult,
  ChatSearchResult,
  StickerPackView,
  IdentityLinkView,
} from './core.ts';
// Stickers, badge, shared content.
export { StickerError, isStickerError } from './stickers/errors.ts';
export type { StickerErrorCode } from './stickers/errors.ts';
// The import pipeline (zip.ts, import.ts, tgs.ts) is reached through the facade
// (importStickers, readTgs, stickerAnimation), which loads it on first use.
export type { ImportInput, ImportedSticker, StickerImport } from './stickers/import.ts';
export type { SanitizedLottie, LottieInfo } from './stickers/tgs.ts';
export type { ZipLimits, ZipEntry } from './stickers/zip.ts';
export { webpInfo } from './stickers/webp.ts';
export type { WebpInfo } from './stickers/webp.ts';
export { unreadTotal, badgeAfterPush, titleWithUnread, SETTING_BADGE_COUNT, MAX_BADGE } from './badge.ts';
export { parseShared, sharedText, SETTING_SHARE_PENDING, MAX_SHARED_FILES, MAX_SHARED_BYTES, MAX_SHARED_TEXT } from './share.ts';
export type { SharedContent, ShareProblem } from './share.ts';
export { MAX_PACK_STICKERS, MAX_PACK_BYTES, MAX_WEBP_STICKER_BYTES, MAX_TGS_STICKER_BYTES, MAX_PACK_NAME_CHARS } from '@family-chat/protocol';
export type { Gender, PackSticker, StickerRef, StickerType } from '@family-chat/protocol';
export type {
  ChatSummary,
  GroupView,
  GroupMemberView,
  AttachmentView,
  AttachmentStatus,
  TransferView,
  ReactionView,
  ReplyPreview,
} from './views.ts';
export { normalize, tokenize, snippet, textMatches, queryWords, searchMessages, messageWords } from './search.ts';
export type { SearchHit, Snippet, SearchQuery, SearchResult } from './search.ts';
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
  LastMedia,
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
  ReactionAgg,
  ControlRow,
  TombstoneRow,
  OutboxControl,
  StickerPackRow,
  StickerFileRow,
  IdentityLinkRow,
} from './db/schema.ts';
export { MAX_DIAGNOSTICS } from './db/diagnostics.ts';

// Building blocks (for workers, tests and advanced use).
export type { Clock } from './util/clock.ts';
export { systemClock } from './util/clock.ts';
export type { LockManagerLike } from './util/locks.ts';
export { webLocks, LeaseLocks } from './util/locks.ts';
export type { BackoffOptions } from './util/backoff.ts';
export { backoffDelay, DEFAULT_BACKOFF } from './util/backoff.ts';

