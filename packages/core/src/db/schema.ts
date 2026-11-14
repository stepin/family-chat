// Local database: IndexedDB through Dexie. Works in a page, a dedicated worker
// and a service worker. The schema only grows: a new Dexie version may add
// tables and indexes, never drop or reinterpret them (docs/PLAN.md 7.1). A
// client that meets a newer database gets DbVersionError and writes nothing.
//
// Several accounts (servers) can live side by side: every per-server table is
// keyed by `accountId` first.

import { Dexie, type Table } from 'dexie';
import type {
  Attachment,
  AttachmentKind,
  AvatarRef,
  BlobRef,
  GroupState,
  Location,
  MsgRef,
  SignedEnvelope,
} from '@family-chat/protocol';
import type { NoticeBody, ServerEvent } from '../api/types.ts';
import { messageWords } from '../search.ts';

export const DEFAULT_DB_NAME = 'family-chat';
export const DB_VERSION = 3;

export type AccountStatus = 'active' | 'login-invalid' | 'removed';

/** Recorded when `after + 1 < oldestGseq`: events after the cursor were deleted by retention. */
export interface RetentionGap {
  /** Cursor we asked with. */
  readonly after: number;
  /** Oldest gseq still on the server at that moment. */
  readonly oldestGseq: number;
  /** Server time of the first event received after the gap, if any. */
  readonly firstTime: number | null;
  /** True when the gap was met on the first sync of this device (expected). */
  readonly firstSync: boolean;
  /** Server time of the oldest record still on the server (M2 `oldestTime`); null when unknown. */
  readonly oldestTime?: number | null;
  /** Local time of detection. */
  readonly detectedAt: number;
}

export interface AccountRow {
  /** Local id (random). */
  id: string;
  serverUrl: string;
  serverId: string;
  familyName: string;
  userId: string;
  devId: string;
  /** Device token: a secret. Never leaves this table except in the Authorization header. */
  token: string;
  admin: boolean;
  status: AccountStatus;
  /** Last `cursor` from `GET /v1/events`. */
  cursor: number;
  /** False until the first full pass over the server's events finished. */
  initialSyncDone: boolean;
  retentionGap: RetentionGap | null;
  retentionDays: number;
  pushAvailable: boolean;
  vapidPublicKey: string | null;
  /** Whether this device registered a push subscription (as far as we know). */
  pushRegistered: boolean;
  createdAt: number;
  lastSyncAt: number | null;
  // ---- added in version 2 (absent in rows written by M1 until the upgrade runs) ----
  /** Cursor of `GET /v1/keys`. */
  keysCursor?: number;
  /** Oldest record still on the server, from the last events page. */
  oldest?: { gseq: number; time: number | null } | null;
  /** The identity was revoked (status is then 'removed'). */
  revoked?: boolean;
  /** Server limits from `/v1/hello` (M2). */
  limits?: ServerLimits | null;
}

export interface ServerLimits {
  readonly maxFileMb: number;
  readonly maxPartBytes: number;
  readonly maxBlobBytes: number;
  readonly maxAvatarBytes: number;
  readonly maxGroupMembers: number;
  readonly fetchedAt: number;
}

export interface IdentityRow {
  userId: string;
  /** The 32-byte identity seed: the most important secret on the device. */
  seed: Uint8Array;
  createdAt: number;
}

export interface UserRow {
  accountId: string;
  userId: string;
  identity: SignedEnvelope;
  signPub: Uint8Array<ArrayBuffer>;
  boxPub: Uint8Array<ArrayBuffer>;
  created: number;
  profile: SignedEnvelope | null;
  name: string | null;
  /** Profile revision, -1 when no profile is known. */
  rev: number;
  admin: boolean;
  removed: boolean;
  /**
   * A different identity arrived for this userId. It is not used; the stored
   * keys stay in force until the person accepts the change.
   */
  keyChange: { identity: SignedEnvelope; detectedAt: number } | null;
  // ---- version 2 ----
  /** Avatar reference from the verified profile. */
  avatar?: AvatarRef | null;
  /** Verified revocation: remembered forever, even if the server drops it later. */
  revoked?: { revokedAt: number; envelope: SignedEnvelope; detectedAt: number } | null;
  /** Fingerprint the person confirmed as verified (local mark); compared with the current keys. */
  verifiedFingerprint?: string | null;
}

export interface LastMessage {
  senderId: string;
  msgId: string;
  kind: MessageKind;
  body: string;
  gseq: number;
  time: number;
  /** What the message carries besides text (M3, for the chat list preview): first attachment kind or a place. */
  media?: LastMedia;
}

export type LastMedia = 'image' | 'voice' | 'file' | 'location';

export type ChatKind = 'dm' | 'self' | 'group';

export interface ChatRow {
  accountId: string;
  chatId: string;
  /** 'dm' with another member, 'self' ("Избранное", peerId is me), 'group' (peerId is ''). */
  kind: ChatKind;
  /** The other member of the direct chat (me for 'self', '' for a group). */
  peerId: string;
  /** Local time when the chat appeared on this device. */
  createdAt: number;
  last: LastMessage | null;
  /** Highest gseq the person has seen in this chat. */
  readGseq: number;
  /** Incoming messages with gseq > readGseq. */
  unread: number;
}

/** A verified event exactly as received (body bytes are the server's bytes). */
export interface EventRow {
  accountId: string;
  senderId: string;
  msgId: string;
  gseq: number;
  time: number;
  chatId: string;
  devId: string;
  epoch: number;
  body: Uint8Array;
}

/**
 * 'service': an entry derived from group states or server notices (no sender, no text).
 * 'deleted' (M4): deleted for everyone; shown as a quiet "message deleted" line (no text, no files).
 */
export type MessageKind = 'msg' | 'update-required' | 'service' | 'deleted';

/** Reactions on a message (M4): every emoji with the users who placed it, in a deterministic order. */
export interface ReactionAgg {
  readonly emoji: string;
  /** Sorted userIds. */
  readonly users: readonly string[];
}

/** What a service entry in a group says (rendered by the UI). */
export type ServiceEntry =
  | { readonly type: 'created'; readonly by: string; readonly name: string; readonly members: readonly string[] }
  | { readonly type: 'renamed'; readonly by: string; readonly name: string }
  | { readonly type: 'added'; readonly by: string; readonly userIds: readonly string[] }
  | { readonly type: 'joined'; readonly by: string }
  | { readonly type: 'left'; readonly userId: string }
  | { readonly type: 'removed'; readonly by: string; readonly userIds: readonly string[] }
  | { readonly type: 'owner'; readonly by: string; readonly userId: string }
  | { readonly type: 'you-removed' }
  | { readonly type: 'you-left' };

/** A message derived from a verified event. */
export interface MessageRow {
  accountId: string;
  chatId: string;
  senderId: string;
  msgId: string;
  devId: string;
  seq: number | null;
  gseq: number;
  time: number;
  kind: MessageKind;
  /** Markdown text; empty for `update-required` and for a msg without body. */
  body: string;
  reply: MsgRef | null;
  // ---- version 2 ----
  /** Validated attachment descriptors (contain the file keys: secrets). */
  attachments?: Attachment[];
  location?: Location;
  fwd?: true;
  service?: ServiceEntry;
  // ---- version 3 (M4) ----
  /** Normalized search words (search.ts); multiEntry index. Empty for anything but a msg. */
  words?: string[];
  /** The edit in force (the newest valid one by gseq). */
  edited?: { gseq: number; time: number };
  /** Aggregated reactions (absent: none). */
  reactions?: ReactionAgg[];
}

/** Payload of a queued control event (M4): edit, delete for everyone or reaction. */
export type OutboxControl =
  | { readonly kind: 'edit'; readonly target: MsgRef; readonly body: string }
  | {
      readonly kind: 'delete';
      readonly target: MsgRef;
      readonly targetDev: string;
      readonly targetSeq: number;
      /** Server record of the target, deleted on the server after the event is accepted. */
      readonly targetGseq: number | null;
      /** My uploads of the target, removed from the server afterwards. */
      readonly blobIds: readonly string[];
      /** The event is on the server; only the server clean-up is left. */
      readonly posted?: boolean;
    }
  | { readonly kind: 'react'; readonly target: MsgRef; readonly emoji: string; readonly on: boolean };

/** A verified control event (M4): kept so the derived message can be recomputed in any arrival order. */
export interface ControlRow {
  accountId: string;
  /** Author of the control event and its id. */
  senderId: string;
  msgId: string;
  chatId: string;
  gseq: number;
  time: number;
  epoch: number;
  kind: 'edit' | 'delete' | 'react';
  /** `${author}/${id}` of the target message. */
  target: string;
  body?: string;
  emoji?: string;
  on?: boolean;
}

/**
 * A deleted message (M4): `everyone` by a valid signed delete, `local` ("delete for me"),
 * `server` (only the server's zeroed record is known: a placeholder that never hides a
 * readable original).
 */
export interface TombstoneRow {
  accountId: string;
  /** Author and id of the deleted message. */
  senderId: string;
  msgId: string;
  chatId: string;
  reason: 'everyone' | 'local' | 'server';
  /** Who deleted it (the author, the group owner, me for local). */
  by: string;
  /** Local time of the deletion. */
  at: number;
  /** Server order and time of the deleted message, when known (to place the quiet line). */
  gseq?: number;
  time?: number;
}

export type OutboxStatus = 'pending' | 'failed';

export interface OutboxRow {
  accountId: string;
  msgId: string;
  chatId: string;
  devId: string;
  seq: number;
  body: string;
  reply: MsgRef | null;
  status: OutboxStatus;
  attempts: number;
  /** Local time of the next attempt. */
  nextAttemptAt: number;
  /** Local time; orders the queue. */
  createdAt: number;
  /** Error code of the last failure (ApiError code or a core code), no text. */
  error: string | null;
  // ---- version 2 ----
  /** Attachment descriptors; the message is sent once all their uploads are done. */
  attachments?: Attachment[];
  location?: Location;
  fwd?: true;
  // ---- version 3 (M4) ----
  /** A control event instead of a message (not shown as a message of its own). */
  control?: OutboxControl;
}

/** Next `seq` of this device in a chat. */
export interface CounterRow {
  accountId: string;
  chatId: string;
  nextSeq: number;
}

/** Highest `seq` seen per (chat, sender, device): detects losses. */
export interface SeqTrackRow {
  accountId: string;
  chatId: string;
  senderId: string;
  devId: string;
  lastSeq: number;
}

export interface DraftRow {
  accountId: string;
  chatId: string;
  text: string;
  updatedAt: number;
}

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticRow {
  id?: number;
  time: number;
  level: DiagnosticLevel;
  accountId: string | null;
  /** Area: http, sync, verify, gap, outbox, auth, directory, push, db. */
  kind: string;
  /** Composed from non-secret values only (status, code, ids, gseq). */
  message: string;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

// ---- version 2: groups ----

export interface GroupRow {
  accountId: string;
  chatId: string;
  /** Latest verified signed state; null until the first one is accepted. */
  state: GroupState | null;
  /** Delivery data from the server (GET /v1/chats or the last notice). */
  server: { version: number; epoch: number; owner: string | null; members: string[] } | null;
  /** I am a member (as far as this device knows). */
  member: boolean;
  /** Why I am no longer a member. */
  left: { reason: 'left' | 'removed'; at: number } | null;
  /** A sealed key for a state is missing (waiting for it). */
  needKey: boolean;
  /** A verification failure stopped progress (code only). */
  broken: string | null;
  createdAt: number;
}

export interface GroupStateRow {
  accountId: string;
  chatId: string;
  version: number;
  epoch: number;
  state: GroupState;
}

/** Epoch secret of a group: a secret. */
export interface EpochKeyRow {
  accountId: string;
  chatId: string;
  epoch: number;
  secret: Uint8Array;
  /** State version the secret was accepted with. */
  stateVersion: number;
}

/** A sealed key from GET /v1/keys, kept until processed (and afterwards, for restore and archive). */
export interface SealedKeyRow {
  accountId: string;
  n: number;
  chatId: string;
  epoch: number;
  version: number;
  time: number;
  key: string;
  done: boolean;
}

export type GroupOp =
  | { readonly type: 'create'; readonly name: string; readonly members: readonly string[] }
  | { readonly type: 'rename'; readonly name: string }
  | { readonly type: 'add'; readonly userIds: readonly string[]; readonly history: boolean }
  | { readonly type: 'remove'; readonly userIds: readonly string[]; readonly auto?: boolean }
  | { readonly type: 'transfer'; readonly to: string };

/** A group change written locally before it is sent (holds the new epoch secret). */
export interface GroupPendingRow {
  accountId: string;
  chatId: string;
  op: GroupOp;
  /** null for create. */
  baseVersion: number | null;
  state: GroupState;
  blob: Uint8Array;
  secret: Uint8Array;
  newEpoch: boolean;
  keys: { userId: string; key: string }[];
  createdAt: number;
  attempts: number;
  error: string | null;
}

export interface NoticeRow {
  accountId: string;
  gseq: number;
  time: number;
  chatId: string;
  notice: NoticeBody;
}

/** An event that could not be decrypted yet (group key or state missing); retried later. */
export interface PendingEventRow {
  accountId: string;
  gseq: number;
  chatId: string;
  event: ServerEvent;
  addedAt: number;
  attempts: number;
}

// ---- version 2: attachments and avatars ----

/** 'none': not downloaded; 'queued'/'active': transfer pending or running; 'done': the file is on this device. */
export type BlobStatus = 'none' | 'queued' | 'active' | 'done' | 'failed' | 'cancelled' | 'gone';

export interface BlobRow {
  accountId: string;
  blobId: string;
  direction: 'up' | 'down';
  chatId: string;
  /** Message carrying the attachment (sender and id). */
  senderId: string;
  msgId: string;
  /** The descriptor's blob reference (holds the file key: a secret). */
  ref: BlobRef;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  status: BlobStatus;
  /** Bytes transferred so far (plaintext). */
  bytesDone: number;
  /** Download: parts written so far (0..parts). */
  partsDone: number;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  /** Where the plaintext copy lives. */
  storage: 'opfs' | 'idb' | null;
  createdAt: number;
  /** Received voice message: played at least once on this device (M3; absent: not yet). */
  heard?: boolean;
}

/** One 4 MiB chunk of a file kept in IndexedDB (the fallback file store). */
export interface FileChunkRow {
  key: string;
  index: number;
  /** A Blob where the platform can store one in IndexedDB, else the bytes. */
  data: Blob | Uint8Array;
}

export interface AvatarRow {
  accountId: string;
  userId: string;
  sha256: string;
  type: 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
  fetchedAt: number;
}

/** Fallback cross-context lock (when Web Locks are unavailable). */
export interface LeaseRow {
  name: string;
  owner: string;
  expiresAt: number;
}

export interface DbDeps {
  /** IndexedDB factory (for tests: fake-indexeddb). Defaults to the global one. */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
}

export class CoreDb extends Dexie {
  accounts!: Table<AccountRow, string>;
  identities!: Table<IdentityRow, string>;
  users!: Table<UserRow, [string, string]>;
  chats!: Table<ChatRow, [string, string]>;
  events!: Table<EventRow, [string, string, string]>;
  messages!: Table<MessageRow, [string, string, string]>;
  outbox!: Table<OutboxRow, [string, string]>;
  counters!: Table<CounterRow, [string, string]>;
  seqTrack!: Table<SeqTrackRow, [string, string, string, string]>;
  drafts!: Table<DraftRow, [string, string]>;
  diagnostics!: Table<DiagnosticRow, number>;
  settings!: Table<SettingRow, string>;
  leases!: Table<LeaseRow, string>;
  groups!: Table<GroupRow, [string, string]>;
  groupStates!: Table<GroupStateRow, [string, string, number]>;
  epochKeys!: Table<EpochKeyRow, [string, string, number]>;
  sealedKeys!: Table<SealedKeyRow, [string, number]>;
  groupPending!: Table<GroupPendingRow, [string, string]>;
  notices!: Table<NoticeRow, [string, number]>;
  pendingEvents!: Table<PendingEventRow, [string, number]>;
  blobs!: Table<BlobRow, [string, string]>;
  fileChunks!: Table<FileChunkRow, [string, number]>;
  avatars!: Table<AvatarRow, [string, string]>;
  controls!: Table<ControlRow, [string, string, string]>;
  tombstones!: Table<TombstoneRow, [string, string, string]>;

  constructor(name: string = DEFAULT_DB_NAME, deps: DbDeps = {}) {
    super(name, deps.indexedDB ? { indexedDB: deps.indexedDB, IDBKeyRange: deps.IDBKeyRange } : undefined);
    // Version 1. Later versions: add `this.version(2).stores({...new tables or indexes})`
    // below; never change or remove what is here.
    this.version(1).stores({
      accounts: 'id, serverId',
      identities: 'userId',
      users: '[accountId+userId], accountId',
      chats: '[accountId+chatId], accountId, chatId',
      events: '[accountId+senderId+msgId], [accountId+gseq], [accountId+chatId+gseq]',
      messages: '[accountId+senderId+msgId], [accountId+chatId+gseq], accountId',
      outbox: '[accountId+msgId], accountId, [accountId+chatId], createdAt',
      counters: '[accountId+chatId]',
      seqTrack: '[accountId+chatId+senderId+devId]',
      drafts: '[accountId+chatId], accountId',
      diagnostics: '++id, time',
      settings: 'key',
      leases: 'name',
    });
    // Version 2 (M2): groups, notices, attachments, avatars. Only additions.
    this.version(2)
      .stores({
        groups: '[accountId+chatId], accountId',
        groupStates: '[accountId+chatId+version], [accountId+chatId]',
        epochKeys: '[accountId+chatId+epoch], [accountId+chatId]',
        sealedKeys: '[accountId+n], [accountId+chatId]',
        groupPending: '[accountId+chatId], accountId',
        notices: '[accountId+gseq], [accountId+chatId]',
        pendingEvents: '[accountId+gseq], [accountId+chatId], accountId',
        blobs: '[accountId+blobId], accountId, [accountId+msgId], status',
        fileChunks: '[key+index], key',
        avatars: '[accountId+userId], accountId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('accounts')
          .toCollection()
          .modify((a: AccountRow) => {
            a.keysCursor ??= 0;
            a.oldest ??= null;
            a.revoked ??= false;
            a.limits ??= null;
          });
      });
    // Version 3 (M4): edits, deletions, reactions and the search index. Only additions:
    // the messages store gains the multiEntry index `*words`, filled here for old rows.
    this.version(3)
      .stores({
        messages: '[accountId+senderId+msgId], [accountId+chatId+gseq], accountId, *words',
        controls: '[accountId+senderId+msgId], [accountId+target], [accountId+chatId]',
        tombstones: '[accountId+senderId+msgId], [accountId+chatId]',
      })
      .upgrade(async (tx) => {
        await tx
          .table('messages')
          .toCollection()
          .modify((m: MessageRow) => {
            m.words = messageWords(m);
          });
      });
  }
}

/** The database on this device was written by a newer client. */
export class DbVersionError extends Error {
  override readonly name = 'DbVersionError';
  constructor() {
    super('the local database was created by a newer version of the app');
  }
}

/**
 * Opens the database. Throws DbVersionError (and closes it) when the database
 * on disk has a newer schema version than this client knows: Dexie 4 would
 * open it anyway, but an older client must not write into a newer layout.
 */
export async function openDb(db: CoreDb): Promise<CoreDb> {
  try {
    await db.open();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const inner = (e as { inner?: { name?: string } } | null)?.inner?.name;
    if (name === 'VersionError' || inner === 'VersionError') throw new DbVersionError();
    throw e;
  }
  // Dexie stores version n as IndexedDB version n * 10.
  if (db.backendDB().version / 10 > DB_VERSION) {
    db.close();
    throw new DbVersionError();
  }
  return db;
}
