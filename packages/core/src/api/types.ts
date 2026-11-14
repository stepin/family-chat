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
}

export interface MeEntry extends UserEntry {
  readonly devId: string;
  readonly push: boolean;
}

export interface ChatEntry {
  readonly chatId: string;
  readonly kind: 'dm';
  readonly members: readonly string[];
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
}

export interface EventsPage {
  readonly events: readonly ServerEvent[];
  /** `GET /v1/events`: the next `after`; history: the oldest gseq in the page. */
  readonly cursor: number;
  readonly more: boolean;
  readonly oldestGseq: number;
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
  readonly retentionDays: number;
  readonly push: boolean;
}
