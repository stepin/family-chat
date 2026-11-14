// Local database: IndexedDB through Dexie. Works in a page, a dedicated worker
// and a service worker. The schema only grows: a new Dexie version may add
// tables and indexes, never drop or reinterpret them (docs/PLAN.md 7.1). A
// client that meets a newer database gets DbVersionError and writes nothing.
//
// Several accounts (servers) can live side by side: every per-server table is
// keyed by `accountId` first.

import { Dexie, type Table } from 'dexie';
import type { MsgRef, SignedEnvelope } from '@family-chat/protocol';

export const DEFAULT_DB_NAME = 'family-chat';
export const DB_VERSION = 1;

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
}

export interface LastMessage {
  senderId: string;
  msgId: string;
  kind: MessageKind;
  body: string;
  gseq: number;
  time: number;
}

export interface ChatRow {
  accountId: string;
  chatId: string;
  kind: 'dm';
  /** The other member of the direct chat. */
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

export type MessageKind = 'msg' | 'update-required';

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
