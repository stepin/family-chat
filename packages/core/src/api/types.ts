// Wire types of the fcd API (docs/API.md). Binary values are already decoded
// where the client needs bytes (event bodies); envelopes stay as strings.

import type { SignedEnvelope } from '@family-chat/protocol';

export interface Hello {
  readonly protocol: number;
  readonly server: string;
  readonly version: string;
  readonly serverId: string;
  readonly familyName: string;
  readonly retentionDays: number;
  readonly maxFileMb: number;
  readonly push: boolean;
  readonly vapidPublicKey: string | null;
  /** Server clock, ms. */
  readonly time: number;
  readonly maxEventBytes: number;
  readonly adminCodeActive: boolean;
  readonly m0: boolean;
  /** Limits (M2). Older servers do not send them; defaults from docs/API.md 1.7 are used. */
  readonly maxPartBytes: number;
  readonly maxBlobBytes: number;
  readonly maxAvatarBytes: number;
  readonly maxStateBytes: number;
  readonly maxSealedKeyBytes: number;
  readonly maxGroupMembers: number;
}

export type JoinCode = { readonly invite: string } | { readonly adminCode: string };

export type JoinRequest = JoinCode & {
  readonly identity: SignedEnvelope;
  readonly profile: SignedEnvelope;
  readonly devId: string;
};

/** Answer of `join` and `auth/device`. The token is a secret. */
export interface IssuedToken {
  readonly token: string;
  readonly userId: string;
  readonly devId: string;
  readonly admin: boolean;
}

export interface Challenge {
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface UserEntry {
  readonly userId: string;
  readonly identity: SignedEnvelope;
  /** null only for data damaged on the server's disk. */
  readonly profile: SignedEnvelope | null;
  readonly admin: boolean;
  readonly removed: boolean;
  /** Revocation envelope (M2), exactly as its owner sent it; null or absent when not revoked. */
  readonly revoked?: SignedEnvelope | null;
}

export interface MeEntry extends UserEntry {
  readonly devId: string;
  readonly push: boolean;
}

export interface ChatEntry {
  readonly chatId: string;
  readonly kind: 'dm' | 'group';
  readonly members: readonly string[];
  /** Group owner; null for a direct chat. */
  readonly owner: string | null;
  /** Group state version; null for a direct chat. */
  readonly version: number | null;
  readonly epoch: number;
  readonly createdAt: number;
  readonly lastGseq: number | null;
  readonly lastTime: number | null;
}

export interface PostEventInput {
  readonly chatId: string;
  /** Message id, sent as `Idempotency-Key`. */
  readonly msgId: string;
  readonly epoch: number;
  readonly body: Uint8Array;
}

export interface PostEventResult {
  readonly gseq: number;
  readonly time: number;
  readonly duplicate: boolean;
}

export interface ServerEvent {
  readonly gseq: number;
  readonly time: number;
  readonly chatId: string;
  readonly senderId: string;
  readonly devId: string;
  readonly epoch: number;
  readonly msgId: string;
  readonly body: Uint8Array;
  /** Deleted for everyone on the server (M4): the body is empty, only the header is left. */
  readonly deleted?: true;
}

/** A server notice (docs/API.md 7): unencrypted, written by the server itself. */
export interface ServerNotice {
  readonly gseq: number;
  readonly time: number;
  readonly chatId: string;
  /** `type` and the public fields, as the server sent them (unknown types are kept as is). */
  readonly notice: NoticeBody;
}

export type NoticeBody =
  | {
      readonly type: 'group_created';
      readonly by: string;
      readonly owner: string;
      readonly members: readonly string[];
      readonly version: number;
      readonly epoch: number;
    }
  | {
      readonly type: 'group_state';
      readonly by: string;
      readonly owner: string;
      readonly members: readonly string[];
      readonly version: number;
      readonly epoch: number;
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | {
      readonly type: 'member_left';
      readonly userId: string;
      readonly members: readonly string[];
      readonly version: number;
      readonly epoch: number;
    }
  | { readonly type: 'member_removed' | 'member_revoked'; readonly userId: string }
  /** An event was deleted for everyone on the server (M4). A hint only: local copies go away by the signed `delete` payload. */
  | { readonly type: 'event_deleted'; readonly gseq: number; readonly senderId: string; readonly msgId: string; readonly by: string };

export interface EventsPage {
  /** Encrypted events of members (`kind: "event"`). */
  readonly events: readonly ServerEvent[];
  /** Server notices of known types (`kind: "notice"`); unknown ones are dropped. */
  readonly notices: readonly ServerNotice[];
  /** `GET /v1/events`: the next `after`; history: the oldest gseq in the page. */
  readonly cursor: number;
  readonly more: boolean;
  readonly oldestGseq: number;
  /** Server time of the oldest record still on the server; null when the log is empty or unknown. */
  readonly oldestTime: number | null;
}

export interface EventsQuery {
  readonly after?: number;
  readonly limit?: number;
  /** Seconds, 0-30. */
  readonly wait?: number;
}

export interface HistoryQuery {
  readonly before?: number;
  readonly limit?: number;
}

/** Shape of `PushSubscription.toJSON()`. */
export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly expirationTime?: number | null;
}

/** A new invitation. `code` is shown once and is a secret until used. */
export interface NewInvite {
  readonly id: string;
  readonly code: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface InviteInfo {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly createdBy: string;
  readonly usedAt: number | null;
  readonly usedBy: string | null;
}

export interface AdminDevice {
  readonly devId: string;
  readonly createdAt: number;
  readonly push: boolean;
}

export interface AdminUser {
  readonly userId: string;
  readonly name: string | null;
  readonly admin: boolean;
  readonly removed: boolean;
  readonly removedAt: number | null;
  readonly revoked: boolean;
  readonly revokedAt: number | null;
  readonly devices: readonly AdminDevice[];
}

export interface ServerStats {
  readonly version: string;
  readonly dataBytes: number;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly events: number;
  readonly oldestGseq: number;
  readonly lastGseq: number;
  readonly users: number;
  readonly removedUsers: number;
  readonly chats: number;
  readonly groups: number;
  readonly retentionDays: number;
  readonly push: boolean;
}

// ---- M2 ----

export interface SealedKeyEntry {
  readonly userId: string;
  /** Serialized `group-key` envelope (opaque for the server). */
  readonly key: string;
}

export interface CreateGroupRequest {
  readonly chatId: string;
  /** Encrypted state blob of version 1. */
  readonly state: Uint8Array;
  readonly members: readonly string[];
  readonly epoch: number;
  readonly keys: readonly SealedKeyEntry[];
}

export interface ChangeGroupRequest {
  readonly baseVersion: number;
  readonly state: Uint8Array;
  readonly members: readonly string[];
  readonly owner: string;
  readonly epoch: number;
  readonly keys: readonly SealedKeyEntry[];
}

export interface KeyEntry {
  readonly n: number;
  readonly chatId: string;
  readonly epoch: number;
  readonly version: number;
  readonly time: number;
  readonly key: string;
}

export interface KeysPage {
  readonly keys: readonly KeyEntry[];
  readonly cursor: number;
  readonly more: boolean;
}

export interface AvatarUpload {
  readonly sha256: string;
  readonly type: 'image/jpeg' | 'image/webp';
}

export interface BlobPartResult {
  readonly blobId: string;
  readonly part: number;
  readonly size: number;
  readonly total: number;
}

export interface BlobInfo {
  readonly blobId: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly parts: readonly { readonly part: number; readonly size: number }[];
  readonly total: number;
  readonly maxBytes: number;
}

/** `POST /v1/invites/check`. `createdBy.name` is an unverified hint until the signed profile arrives. */
export interface InviteCheck {
  readonly status: 'valid' | 'used' | 'expired';
  readonly familyName: string;
  readonly createdBy: { readonly userId: string; readonly name: string | null };
  readonly createdAt: number;
  readonly expiresAt: number;
}
