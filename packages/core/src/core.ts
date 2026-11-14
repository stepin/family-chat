// The facade for the UI: one object per app. Methods for every action, and
// observable state (Readable stores, Svelte-compatible) backed by Dexie live
// queries, so changes made by another tab or worker show up too.
//
// No DOM: it needs fetch, IndexedDB, WebCrypto and timers, all present in a
// worker. The web client runs it on the main thread.

import { dmChatId, fingerprint, type AvatarRef, type IdentityKeys, type Location, type MsgRef, type PackSticker, type StickerRef } from '@family-chat/protocol';
import { Dexie, liveQuery } from 'dexie';
import {
  AccountRuntime,
  addDeviceForIdentity,
  checkInvite,
  createIdentity,
  ensureSelfChat,
  fetchHello,
  joinServer,
  keysFromPhrase,
  recoveryPhrase,
  removeAccount,
  restoreAccount,
  revokeIdentity,
  updateProfile,
  type JoinInput,
  type RestoreInput,
} from './accounts.ts';
import type { FetchFn } from './api/transport.ts';
import type {
  AdminUser,
  Hello,
  InviteCheck,
  InviteInfo,
  NewInvite,
  PushSubscriptionInput,
  ServerStats,
} from './api/types.ts';
import { commitEvents, decodeEvents, deleteLocally } from './apply.ts';
import { exportArchive, importArchive, toReadableStream, type ArchiveSource, type ExportOptions, type ImportResult } from './archive.ts';
import { prepareUploads, type AttachmentInput } from './attachments.ts';
import { checkMessageText as checkText } from './outbox.ts';
import { fetchAvatar, removeAvatar, setAvatar } from './avatars.ts';
import type { FileStorePreference, OpfsDirectory } from './files.ts';
import {
  chatMessages,
  chatSummaries,
  linkedChatIds,
  groupView,
  transferView,
  type ChatSummary,
  type GroupView,
  type MessageView,
  type TransferView,
} from './views.ts';
import { CoreContext } from './context.ts';
import {
  CoreDb,
  DEFAULT_DB_NAME,
  openDb,
  type AccountRow,
  type AccountStatus,
  type DbDeps,
  type DiagnosticLevel,
  type DiagnosticRow,
  type MessageKind,
  type RetentionGap,
} from './db/schema.ts';
import { CoreError } from './errors.ts';
import { inviteLink } from './invite.ts';
import { byQueueOrder, cancelMessage, enqueueControl, enqueueMessage, retryMessage } from './outbox.ts';
import { base64urlDecode, newMessageId } from '@family-chat/protocol';
import { countFrom, searchMessages, textMatches, queryWords, type SearchHit } from './search.ts';
import { handlePush, registerPush, unregisterPush, type PushNotice } from './push.ts';
import type { ConnectionState } from './sync.ts';
import { SETTING_BADGE_COUNT, unreadTotal } from './badge.ts';
import { parseShared, SETTING_SHARE_PENDING, type SharedContent } from './share.ts';
import { linkIdentities, linkValid, unlinkIdentity } from './links.ts';
// The sticker import pipeline and the `.tgs` reader load on first use (their own chunk in the web build).
import type { ImportInput, StickerImport } from './stickers/import.ts';
import type { SanitizedLottie } from './stickers/tgs.ts';
import type { IdentityLinkRow } from './db/schema.ts';
import type { BackoffOptions } from './util/backoff.ts';
import type { Clock } from './util/clock.ts';
import type { LockManagerLike } from './util/locks.ts';
import { writable, type Readable, type Unsubscribe, type Writable } from './util/readable.ts';

// ---- options ----

export interface CoreOptions {
  /** A database instance (tests, several cores on one database). */
  readonly db?: CoreDb;
  /** Database name when `db` is not given (default "family-chat"). */
  readonly dbName?: string;
  /** IndexedDB implementation when `db` is not given (tests: fake-indexeddb). */
  readonly dbDeps?: DbDeps;
  readonly fetch?: FetchFn;
  readonly clock?: Clock;
  readonly locks?: LockManagerLike;
  readonly random?: () => number;
  readonly backoff?: BackoffOptions;
  /** Long-poll `wait`, seconds (default 25). */
  readonly waitSeconds?: number;
  /** Timeout of ordinary requests, ms (default 20000). */
  readonly timeoutMs?: number;
  /** Attachment storage: 'auto' (OPFS when available, else IndexedDB; default), 'opfs' or 'idb'. */
  readonly fileStore?: FileStorePreference;
  /** OPFS root directory (tests); defaults to navigator.storage.getDirectory(). */
  readonly opfsRoot?: () => Promise<OpfsDirectory>;
}

// ---- views ----

/** An account without its secrets. */
export interface AccountView {
  readonly id: string;
  readonly serverUrl: string;
  readonly serverId: string;
  readonly familyName: string;
  readonly userId: string;
  readonly devId: string;
  readonly admin: boolean;
  readonly status: AccountStatus;
  readonly retentionDays: number;
  /** Set when events after our cursor were already deleted by retention. */
  readonly retentionGap: RetentionGap | null;
  readonly initialSyncDone: boolean;
  readonly pushAvailable: boolean;
  readonly pushRegistered: boolean;
  readonly vapidPublicKey: string | null;
  readonly lastSyncAt: number | null;
  /** My identity was revoked on this server (status is 'removed'). */
  readonly revoked: boolean;
  /** The chat with myself ("Избранное") on this account. */
  readonly selfChatId: string;
  /**
   * Server time of the oldest record still on the server (null when unknown).
   * With `historyTrimmed`, the UI shows "messages before <date> are no longer
   * on the server" at the top of a chat whose history reached the start.
   */
  readonly oldestTime: number | null;
  /** Older records were deleted by retention (the oldest gseq on the server is above 1). */
  readonly historyTrimmed: boolean;
}

/** Result of join: the account, plus the chat with the person who invited (opened locally). */
export interface JoinResult extends AccountView {
  readonly firstChatId: string | null;
}

export interface Member {
  readonly accountId: string;
  readonly userId: string;
  /** From the verified profile; null when unknown. */
  readonly name: string | null;
  readonly admin: boolean;
  readonly removed: boolean;
  readonly isMe: boolean;
  /** 30 digits for manual comparison (docs/PROTOCOL.md 3.4). */
  readonly fingerprint: string;
  /** The server offered different keys for this userId (see acceptKeyChange). */
  readonly keyChanged: boolean;
  /** Direct chat id with this member (null for oneself; see AccountView.selfChatId). */
  readonly chatId: string | null;
  /** The identity was revoked: nothing is encrypted to it any more. */
  readonly revoked: boolean;
  /** I marked this fingerprint as verified (and the keys did not change since). */
  readonly verified: boolean;
  /** Avatar reference from the verified profile (blob: core.avatar()). */
  readonly avatar: AvatarRef | null;
}

export interface ChatListItem {
  readonly accountId: string;
  readonly chatId: string;
  readonly peerId: string;
  readonly peerName: string | null;
  readonly peerRemoved: boolean;
  readonly familyName: string;
  readonly lastMessage: {
    readonly senderId: string;
    readonly outgoing: boolean;
    readonly kind: MessageKind;
    readonly body: string;
    readonly time: number;
  } | null;
  /** Server time of the last message (null for an empty chat). */
  readonly lastTime: number | null;
  readonly unread: number;
  /** Messages of this chat still in the outbox. */
  readonly pending: number;
  readonly draft: string | null;
}

export type { MessageStatus, MessageView } from './views.ts';

export interface OutboxItem {
  readonly accountId: string;
  readonly chatId: string;
  readonly msgId: string;
  readonly status: 'on-device' | 'failed';
  readonly attempts: number;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface DraftItem {
  readonly accountId: string;
  readonly chatId: string;
  readonly text: string;
  readonly updatedAt: number;
}

export type DiagnosticEntry = DiagnosticRow;

/** Messages of one chat, newest at the end, with paging backwards. */
export interface ChatView {
  readonly accountId: string;
  readonly chatId: string;
  readonly messages: Readable<MessageView[]>;
  /**
   * Shows older messages: first from the local database, then from the
   * server's history. Resolves false when there is nothing older.
   */
  loadOlder(): Promise<boolean>;
  /** Marks everything shown as read (unread counter to zero). */
  markRead(): Promise<void>;
  /**
   * Makes sure the message with this gseq is in `messages` (loads older
   * messages from the local database as needed). False when it is not on
   * this device.
   */
  reveal(gseq: number): Promise<boolean>;
}

/** Result of the global search (M4): messages on this device plus chats and contacts by name. */
export interface GlobalSearchResult {
  /** Normalized query words, for highlighting. */
  readonly words: readonly string[];
  /** Chats whose name matches. */
  readonly chats: readonly ChatSummary[];
  /** Family members without a chat on this device yet whose name matches. */
  readonly contacts: readonly { readonly accountId: string; readonly userId: string; readonly name: string }[];
  /** Matching messages, newest first (at most `limit`). */
  readonly messages: readonly SearchHit[];
  /** Number of matching messages. */
  readonly total: number;
}

/** Result of the search inside one chat: every match, newest first. */
export interface ChatSearchResult {
  readonly words: readonly string[];
  readonly hits: readonly SearchHit[];
}

export interface CreatedInvite extends NewInvite {
  /** `https://<server>/#invite=<code>`; a secret until used. */
  readonly link: string;
}

export const MESSAGES_PAGE = 50;
export const HISTORY_PAGE = 200;

// ---- helpers ----

function live<T>(initial: T, query: () => Promise<T>, onError: (e: unknown) => void): Readable<T> {
  return writable(initial, (set) => {
    const sub = liveQuery(query).subscribe({ next: set, error: onError });
    return () => sub.unsubscribe();
  });
}

function accountView(a: AccountRow): AccountView {
  return {
    id: a.id,
    serverUrl: a.serverUrl,
    serverId: a.serverId,
    familyName: a.familyName,
    userId: a.userId,
    devId: a.devId,
    admin: a.admin,
    status: a.status,
    retentionDays: a.retentionDays,
    retentionGap: a.retentionGap,
    initialSyncDone: a.initialSyncDone,
    pushAvailable: a.pushAvailable,
    pushRegistered: a.pushRegistered,
    vapidPublicKey: a.vapidPublicKey,
    lastSyncAt: a.lastSyncAt,
    revoked: a.revoked === true,
    selfChatId: dmChatId(a.serverId, a.userId, a.userId),
    oldestTime: a.oldest?.time ?? null,
    historyTrimmed: (a.oldest?.gseq ?? 1) > 1,
  };
}

/** What to send: text (Markdown), attachments, a place; at least one of them. */
export interface OutgoingMessage {
  readonly text?: string;
  readonly reply?: MsgRef;
  readonly attachments?: readonly AttachmentInput[];
  /** A place (the UI takes it from the Geolocation API); the message may have no text then. */
  readonly location?: Location;
  readonly fwd?: boolean;
  /** A sticker (M5): `text` must then be its emoji; no attachments or place. */
  readonly sticker?: StickerRef;
}

/** A published sticker pack of a family (M5). */
export interface StickerPackView {
  readonly accountId: string;
  readonly packId: string;
  readonly name: string;
  /** Uploader; only they can delete the pack. */
  readonly author: string;
  readonly mine: boolean;
  readonly stickers: readonly PackSticker[];
  readonly publishedAt: number | null;
}

/** "The same person as…" (M5): an older identity shown together with a newer one. */
export interface IdentityLinkView {
  readonly accountId: string;
  /** The older identity. */
  readonly userId: string;
  /** The newer identity (the same person). */
  readonly to: string;
  /** False when either identity's keys changed since: the link no longer applies. */
  readonly valid: boolean;
}

export interface AvatarView {
  readonly userId: string;
  readonly sha256: string;
  readonly type: 'image/jpeg' | 'image/webp';
  readonly blob: Blob;
}

// ---- the facade ----

export class FamilyChatCore {
  readonly db: CoreDb;
  readonly #ctx: CoreContext;
  readonly #runtimes = new Map<string, AccountRuntime>();
  readonly #connection: Writable<Record<string, ConnectionState>> = writable({});
  readonly #connUnsubs = new Map<string, Unsubscribe>();
  #started = false;
  #closed = false;

  /** All accounts on this device. */
  readonly accounts: Readable<AccountView[]>;
  /** Connection state per account id. */
  readonly connection: Readable<Record<string, ConnectionState>>;
  /**
   * Direct chats with other members, most recent first (the M1 list; groups
   * and the chat with myself are not in it). New screens use `chatList`.
   */
  readonly chats: Readable<ChatListItem[]>;
  /** Every chat: the chat with myself pinned first, then groups and direct chats by last activity. */
  readonly chatList: Readable<ChatSummary[]>;
  /** Uploads and downloads that are queued, running or failed. */
  readonly transfers: Readable<TransferView[]>;
  /** Messages not yet accepted by the server, oldest first. */
  readonly outbox: Readable<OutboxItem[]>;
  readonly drafts: Readable<DraftItem[]>;
  /** The diagnostics log, oldest first (at most 500 entries). */
  readonly diagnostics: Readable<DiagnosticEntry[]>;
  /** M5: total unread over the accounts that are still members (the app icon badge and the title). */
  readonly unreadTotal: Readable<number>;

  constructor(options: CoreOptions = {}) {
    this.db = options.db ?? new CoreDb(options.dbName ?? DEFAULT_DB_NAME, options.dbDeps ?? {});
    this.#ctx = new CoreContext({
      db: this.db,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.locks ? { locks: options.locks } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.backoff ? { backoff: options.backoff } : {}),
      ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fileStore ? { fileStore: options.fileStore } : {}),
      ...(options.opfsRoot ? { opfsRoot: options.opfsRoot } : {}),
    });
    const onError = (e: unknown) => void this.#ctx.diag.error('db', `live query failed: ${String((e as Error)?.name)}`);
    const db = this.db;

    this.accounts = live<AccountView[]>([], async () => (await db.accounts.toArray()).map(accountView), onError);
    this.connection = { subscribe: (run) => this.#connection.subscribe(run), get: () => this.#connection.get() };
    this.chats = live<ChatListItem[]>([], () => this.#chatList(), onError);
    this.chatList = live<ChatSummary[]>([], () => chatSummaries(db), onError);
    this.transfers = live<TransferView[]>(
      [],
      async () =>
        (await db.blobs.toArray())
          .filter((b) => b.status === 'queued' || b.status === 'active' || b.status === 'failed')
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(transferView),
      onError,
    );
    this.outbox = live<OutboxItem[]>(
      [],
      async () =>
        (await db.outbox.toArray()).sort(byQueueOrder).map((o) => ({
          accountId: o.accountId,
          chatId: o.chatId,
          msgId: o.msgId,
          status: o.status === 'failed' ? ('failed' as const) : ('on-device' as const),
          attempts: o.attempts,
          error: o.error,
          createdAt: o.createdAt,
        })),
      onError,
    );
    this.drafts = live<DraftItem[]>(
      [],
      async () =>
        (await db.drafts.toArray()).map((d) => ({
          accountId: d.accountId,
          chatId: d.chatId,
          text: d.text,
          updatedAt: d.updatedAt,
        })),
      onError,
    );
    this.diagnostics = live<DiagnosticEntry[]>([], () => db.diagnostics.orderBy('id').toArray(), onError);
    this.unreadTotal = live<number>(
      0,
      async () => {
        const [accounts, summaries] = await Promise.all([db.accounts.toArray(), chatSummaries(db)]);
        return unreadTotal(accounts, summaries);
      },
      onError,
    );
  }

  // ---- lifecycle ----

  /** Opens the database and starts sync and sending for every account. Throws DbVersionError for a newer database. */
  async start(): Promise<void> {
    this.#ensureOpen();
    await openDb(this.db);
    this.#started = true;
    for (const a of await this.db.accounts.toArray()) (await this.#runtime(a.id)).start();
  }

  /** Stops all loops (the database stays open; start() resumes). */
  async stop(): Promise<void> {
    this.#started = false;
    await Promise.all([...this.#runtimes.values()].map((rt) => rt.stop()));
  }

  /** Stops and closes the database. The object cannot be used afterwards. */
  async close(): Promise<void> {
    await this.stop();
    await this.#ctx.diag.flush();
    for (const u of this.#connUnsubs.values()) u();
    this.#connUnsubs.clear();
    this.#closed = true;
    this.db.close();
  }

  /** Retry everything now (for example when the app returns to the foreground or the network comes back). */
  wake(): void {
    for (const rt of this.#runtimes.values()) {
      rt.sync.kick();
      rt.outbox.kick();
    }
  }

  // ---- identity and accounts ----

  /** Server info before joining: family name, whether the admin code is still active, push. */
  serverInfo(serverUrl: string): Promise<Hello> {
    return fetchHello(this.#ctx, serverUrl);
  }

  /** Creates an identity on this device; returns its userId. */
  createIdentity(): Promise<string> {
    return createIdentity(this.#ctx);
  }

  /** Accounts on this device, read once (the `accounts` store delivers its first value asynchronously). */
  async accountList(): Promise<AccountView[]> {
    return (await this.db.accounts.toArray()).map(accountView);
  }

  /** userIds of identities stored on this device. */
  async identities(): Promise<string[]> {
    return (await this.db.identities.toArray()).map((i) => i.userId);
  }

  /** The 24-word recovery phrase. A secret: show it to the person, never log it. */
  recoveryPhrase(userId: string): Promise<string> {
    return recoveryPhrase(this.#ctx, userId);
  }

  /**
   * Joins a server with an invitation or the admin code; starts syncing it.
   * With an invitation, the chat with the person who invited is opened
   * locally and returned as `firstChatId`.
   */
  async join(input: JoinInput): Promise<JoinResult> {
    let inviter: string | null = null;
    if ('invite' in input.code) {
      try {
        const check = await checkInvite(this.#ctx, input.serverUrl, input.code.invite);
        if (check.status !== 'invalid') inviter = check.createdBy.userId;
      } catch {
        // The check is a hint; joining reports the real error.
      }
    }
    const row = await joinServer(this.#ctx, input);
    const view = await this.#adopt(row);
    let firstChatId: string | null = null;
    if (inviter && inviter !== row.userId) firstChatId = await this.openChat(row.id, inviter).catch(() => null);
    return { ...view, firstChatId };
  }

  /**
   * Before joining: is the invitation valid, into which family, who invited
   * (`createdBy.name` is an unverified hint until the signed profile arrives).
   */
  checkInvite(serverUrl: string, code: string): Promise<InviteCheck | { readonly status: 'invalid' }> {
    return checkInvite(this.#ctx, serverUrl, code);
  }

  /** Restores an identity by its phrase on this device and adds the device to the server. */
  async restore(input: RestoreInput): Promise<AccountView> {
    const row = await restoreAccount(this.#ctx, input);
    return this.#adopt(row);
  }

  /** Adds this device to another server where an identity stored here is a member. */
  async addDevice(serverUrl: string, userId: string): Promise<AccountView> {
    const row = await addDeviceForIdentity(this.#ctx, serverUrl, userId);
    return this.#adopt(row);
  }

  /** "Log in again" after the state "login-invalid". */
  async relogin(accountId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    await rt.session.relogin();
    rt.sync.kick();
    rt.outbox.kick();
  }

  async updateProfile(accountId: string, name: string): Promise<void> {
    await updateProfile(await this.#runtime(accountId), name);
  }

  /**
   * M5: removes an account (one family) from this device: its history,
   * files, group keys and token. Other accounts keep running. The identity's
   * seed is removed too when no other account here uses it.
   */
  async removeAccount(accountId: string): Promise<void> {
    this.#ensureOpen();
    const rt = this.#runtimes.get(accountId);
    if (rt) {
      await rt.stop();
      this.#runtimes.delete(accountId);
      this.#connUnsubs.get(accountId)?.();
      this.#connUnsubs.delete(accountId);
      this.#connection.update((m) => {
        const { [accountId]: _gone, ...rest } = m;
        return rest;
      });
    }
    await removeAccount(this.#ctx, accountId);
  }

  // ---- directory ----

  /** Family members of an account (live). */
  members(accountId: string): Readable<Member[]> {
    const db = this.db;
    return live<Member[]>(
      [],
      async () => {
        const account = await db.accounts.get(accountId);
        if (!account) return [];
        const rt = await this.#runtime(accountId);
        const users = await db.users.where('accountId').equals(accountId).toArray();
        return users.map((u) => ({
          accountId,
          userId: u.userId,
          name: u.name,
          admin: u.admin,
          removed: u.removed,
          isMe: u.userId === account.userId,
          fingerprint: fingerprint(u),
          keyChanged: u.keyChange !== null,
          chatId: u.userId === account.userId ? null : rt.directory.chatIdFor(u.userId),
          revoked: !!u.revoked,
          verified: !!u.verifiedFingerprint && u.verifiedFingerprint === fingerprint(u),
          avatar: u.avatar ?? null,
        }));
      },
      (e) => void this.#ctx.diag.error('db', `members query failed: ${String((e as Error)?.name)}`, accountId),
    );
  }

  /** Fetches the member list from the server now. */
  async refreshMembers(accountId: string): Promise<void> {
    await (await this.#runtime(accountId)).directory.refresh();
  }

  /** Accepts the new keys the server reported for a member (after comparing fingerprints). */
  async acceptKeyChange(accountId: string, userId: string): Promise<void> {
    await (await this.#runtime(accountId)).directory.acceptKeyChange(userId);
  }

  /**
   * Opens (creates locally) the direct chat with a member, even if nobody has
   * written yet. Returns the chat id. The server learns about the chat with
   * the first message.
   */
  async openChat(accountId: string, peerId: string): Promise<string> {
    const rt = await this.#runtime(accountId);
    if (peerId === rt.session.userId) return ensureSelfChat(rt);
    const chatId = rt.directory.chatIdFor(peerId);
    if (!(await rt.directory.user(peerId))) {
      await rt.directory.refresh();
      if (!(await rt.directory.user(peerId))) throw new CoreError('unknown-user');
    }
    await this.db.transaction('rw', this.db.chats, async () => {
      if (await this.db.chats.get([accountId, chatId])) return;
      await this.db.chats.put({
        accountId,
        chatId,
        kind: 'dm',
        peerId,
        createdAt: this.#ctx.clock.now(),
        last: null,
        readGseq: 0,
        unread: 0,
      });
    });
    return chatId;
  }

  // ---- chats and messages ----

  /** Messages of a chat (live), with paging backwards. */
  chat(accountId: string, chatId: string): ChatView {
    const db = this.db;
    let limit = MESSAGES_PAGE;
    let serverDone = false;
    const reload = writable(0);
    const query = (): Promise<MessageView[]> => chatMessages(db, accountId, chatId, limit);
    const messages = writable<MessageView[]>([], (set) => {
      let sub: { unsubscribe(): void } | undefined;
      const unsubReload = reload.subscribe(() => {
        sub?.unsubscribe();
        sub = liveQuery(query).subscribe({
          next: set,
          error: (e: unknown) =>
            void this.#ctx.diag.error('db', `messages query failed: ${String((e as Error)?.name)}`, accountId),
        });
      });
      return () => {
        unsubReload();
        sub?.unsubscribe();
      };
    });
    const range = () =>
      db.messages
        .where('[accountId+chatId+gseq]')
        .between([accountId, chatId, Dexie.minKey], [accountId, chatId, Dexie.maxKey]);

    return {
      accountId,
      chatId,
      messages,
      loadOlder: async () => {
        const local = await range().count();
        if (local > limit) {
          limit += MESSAGES_PAGE;
          reload.update((n) => n + 1);
          return true;
        }
        if (serverDone) return false;
        const rt = await this.#runtime(accountId);
        const oldest = await range().first();
        const page = await rt.session.call((t) =>
          rt.session.transport.chatEvents(t, chatId, {
            ...(oldest ? { before: oldest.gseq } : {}),
            limit: HISTORY_PAGE,
          }),
        );
        if (!page.more) serverDone = true;
        // Older group events of an epoch whose key never reached me cannot be read: no retry list for them.
        const items = await decodeEvents(rt, page.events, { keepPending: false });
        await commitEvents(this.#ctx, accountId, rt.session.userId, items);
        const after = await range().count();
        limit += MESSAGES_PAGE;
        reload.update((n) => n + 1);
        return after > local || page.more;
      },
      markRead: () => this.markRead(accountId, chatId),
      reveal: async (gseq: number) => {
        if (!(await db.messages.where('[accountId+chatId+gseq]').equals([accountId, chatId, gseq]).first())) return false;
        const need = await countFrom(db, accountId, chatId, gseq);
        if (need > limit) {
          limit = Math.ceil(need / MESSAGES_PAGE) * MESSAGES_PAGE + MESSAGES_PAGE;
          reload.update((n) => n + 1);
        }
        return true;
      },
    };
  }

  // ---- M4: edit, delete, reactions, forward, search ----

  /** Changes the text (or caption) of my message. A message still on the device is changed in place. */
  async editMessage(accountId: string, chatId: string, msgId: string, text: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    const me = rt.session.userId;
    const queued = await this.db.outbox.get([accountId, msgId]);
    if (queued && !queued.control) {
      const hasContent = (queued.attachments?.length ?? 0) > 0 || !!queued.location;
      if (!hasContent || text.length > 0) checkText(text);
      await this.db.outbox.update([accountId, msgId], { body: text });
      return;
    }
    const m = await this.db.messages.get([accountId, me, msgId]);
    if (!m || m.kind !== 'msg' || m.chatId !== chatId) throw new CoreError('not-allowed', 'only my own messages can be edited');
    if (m.sticker) throw new CoreError('not-allowed', 'a sticker cannot be edited');
    const hasContent = (m.attachments?.length ?? 0) > 0 || !!m.location;
    if (!hasContent || text.length > 0) checkText(text);
    if (text === m.body) return;
    await enqueueControl(rt, chatId, { kind: 'edit', target: { author: me, id: msgId }, body: text });
    rt.outbox.kick();
  }

  /**
   * Deletes a message for everyone: my own message, or any message in a group
   * I own. The encrypted delete goes first, then the server copy and my
   * uploads of it are removed. A message still on the device is cancelled.
   */
  async deleteForEveryone(accountId: string, chatId: string, senderId: string, msgId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    const me = rt.session.userId;
    if (senderId === me) {
      const queued = await this.db.outbox.get([accountId, msgId]);
      if (queued && !queued.control) {
        await this.cancel(accountId, msgId);
        return;
      }
    }
    const m = await this.db.messages.get([accountId, senderId, msgId]);
    if (!m || m.chatId !== chatId || (m.kind !== 'msg' && m.kind !== 'update-required')) {
      throw new CoreError('not-allowed', 'no such message');
    }
    if (senderId !== me) {
      const g = await this.db.groups.get([accountId, chatId]);
      if (!g?.state || g.state.owner !== me) throw new CoreError('not-allowed', 'only the author or the group owner can delete it for everyone');
    }
    const blobIds =
      senderId === me
        ? (await this.db.blobs.where('[accountId+msgId]').equals([accountId, msgId]).toArray())
            .filter((b) => b.direction === 'up' && b.senderId === me)
            .map((b) => b.blobId)
        : [];
    await enqueueControl(rt, chatId, {
      kind: 'delete',
      target: { author: senderId, id: msgId },
      targetDev: m.devId,
      targetSeq: m.seq ?? 0,
      targetGseq: m.gseq,
      blobIds,
    });
    rt.outbox.kick();
  }

  /** Deletes a message on this device only (with its files); others keep it. */
  async deleteForMe(accountId: string, chatId: string, senderId: string, msgId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    const m = await this.db.messages.get([accountId, senderId, msgId]);
    if (!m || m.chatId !== chatId) {
      if (senderId === rt.session.userId && (await this.db.outbox.get([accountId, msgId]))) return this.cancel(accountId, msgId);
      throw new CoreError('not-allowed', 'no such message');
    }
    await deleteLocally(this.#ctx, accountId, rt.session.userId, senderId, msgId);
  }

  /** Places (`on: true`) or removes my reaction on a message. Several different emoji per person are allowed. */
  async react(accountId: string, chatId: string, senderId: string, msgId: string, emoji: string, on: boolean): Promise<void> {
    const rt = await this.#runtime(accountId);
    const m = await this.db.messages.get([accountId, senderId, msgId]);
    if (!m || m.chatId !== chatId || m.kind !== 'msg') throw new CoreError('not-allowed', 'no such message');
    // Taps that cancel each other before anything was sent never reach the server.
    const me = rt.session.userId;
    const queued = (await this.db.outbox.where('[accountId+chatId]').equals([accountId, chatId]).toArray()).filter(
      (o) => o.control?.kind === 'react' && o.control.target.author === senderId && o.control.target.id === msgId && o.control.emoji === emoji,
    );
    const untouched = queued.filter((o) => o.status === 'pending' && o.attempts === 0);
    if (untouched.length === queued.length) {
      await this.db.outbox.bulkDelete(untouched.map((o): [string, string] => [accountId, o.msgId]));
      const placed = !!m.reactions?.some((r) => r.emoji === emoji && r.users.includes(me));
      if (placed === on) return;
    }
    await enqueueControl(rt, chatId, { kind: 'react', target: { author: senderId, id: msgId }, emoji, on });
    rt.outbox.kick();
  }

  /**
   * Forwards a message (text, place, files, voice) to other chats, marked
   * "forwarded" without the original author. Every file is encrypted again
   * under a new key and uploaded for each destination. Files that are not on
   * this device: CoreError `not-downloaded` (its message lists the blob ids),
   * nothing is sent. Returns the new message ids.
   */
  async forwardMessage(accountId: string, chatId: string, senderId: string, msgId: string, toChatIds: readonly string[]): Promise<string[]> {
    const rt = await this.#runtime(accountId);
    const m = await this.db.messages.get([accountId, senderId, msgId]);
    if (!m || m.chatId !== chatId || m.kind !== 'msg') throw new CoreError('not-allowed', 'no such message');
    const atts = m.attachments ?? [];
    const missing: string[] = [];
    for (const a of atts) {
      const b = await this.db.blobs.get([accountId, a.blob.id]);
      const local = !!b?.storage && (b.status === 'done' || (b.direction === 'up' && b.status !== 'cancelled' && b.status !== 'failed'));
      if (!local) missing.push(a.blob.id);
    }
    if (missing.length > 0) throw new CoreError('not-downloaded', missing.join(','));
    const ids: string[] = [];
    for (const to of toChatIds) {
      const attachments: AttachmentInput[] = [];
      for (const a of atts) {
        attachments.push({
          data: await rt.transfers.blob(a.blob.id),
          name: a.name,
          mime: a.mime,
          kind: a.kind,
          ...(a.w !== undefined ? { width: a.w } : {}),
          ...(a.h !== undefined ? { height: a.h } : {}),
          ...(a.thumb ? { thumb: base64urlDecode(a.thumb) } : {}),
          ...(a.dur !== undefined ? { durationMs: a.dur } : {}),
          ...(a.peaks ? { peaks: a.peaks } : {}),
        });
      }
      ids.push(
        await this.sendMessage(accountId, to, {
          ...(m.body ? { text: m.body } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(m.location ? { location: m.location } : {}),
          ...(m.sticker ? { sticker: m.sticker } : {}),
          fwd: true,
        }),
      );
    }
    return ids;
  }

  /**
   * Searches the messages stored on this device (nothing goes to the
   * server), and chat and contact names. Words match by prefix, all words
   * must match, case and ё/е do not matter.
   */
  async search(text: string, options: { accountId?: string; limit?: number } = {}): Promise<GlobalSearchResult> {
    const words = queryWords(text);
    if (words.length === 0) return { words, chats: [], contacts: [], messages: [], total: 0 };
    const limit = options.limit ?? 100;
    const result = await searchMessages(this.db, { text, ...(options.accountId ? { accountId: options.accountId } : {}), limit });
    const summaries = (await chatSummaries(this.db)).filter((c) => !options.accountId || c.accountId === options.accountId);
    const chats = summaries.filter((c) => c.title !== null && textMatches(c.title, words));
    const withChat = new Set(summaries.filter((c) => c.peerId).map((c) => `${c.accountId}/${c.peerId}`));
    const accounts = await this.db.accounts.toArray();
    const mine = new Set(accounts.map((a) => `${a.id}/${a.userId}`));
    const contacts = (await this.db.users.toArray())
      .filter((u) => (!options.accountId || u.accountId === options.accountId) && u.name && !u.revoked)
      .filter((u) => !mine.has(`${u.accountId}/${u.userId}`) && !withChat.has(`${u.accountId}/${u.userId}`) && textMatches(u.name!, words))
      .map((u) => ({ accountId: u.accountId, userId: u.userId, name: u.name! }));
    return { words, chats, contacts, messages: result.hits, total: result.total };
  }

  /** Every message of one chat that matches, newest first (search inside a chat). */
  async searchChat(accountId: string, chatId: string, text: string): Promise<ChatSearchResult> {
    const r = await searchMessages(this.db, { text, accountId, chatId });
    return { words: r.words, hits: r.hits };
  }

  async markRead(accountId: string, chatId: string): Promise<void> {
    // The chats of linked older identities are read together with this one (one feed).
    const ids = [chatId, ...(await linkedChatIds(this.db, accountId, chatId))];
    await this.db.transaction('rw', this.db.chats, async () => {
      for (const id of ids) {
        const c = await this.db.chats.get([accountId, id]);
        if (!c) continue;
        await this.db.chats.put({ ...c, unread: 0, readGseq: Math.max(c.readGseq, c.last?.gseq ?? 0) });
      }
    });
  }

  /** Queues a text message (Markdown, at most 16 KB). Returns its message id. Clears the chat's draft. */
  async send(accountId: string, chatId: string, text: string, reply?: MsgRef): Promise<string> {
    const rt = await this.#runtime(accountId);
    const msgId = await enqueueMessage(rt, chatId, text, reply);
    rt.outbox.kick();
    return msgId;
  }

  /** Sends a failed message again (failed attachment uploads are restarted). */
  async retry(accountId: string, msgId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    // Uploads first: a send pass between the two steps must not see the
    // message pending while its upload is still marked failed (it would fail
    // the message again at once).
    await rt.transfers.retryUploads(msgId);
    await retryMessage(rt, msgId);
    rt.outbox.kick();
  }

  /** Removes a message that has not reached the server (its uploads are cancelled and removed). */
  async cancel(accountId: string, msgId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    await cancelMessage(rt, msgId);
    const uploads = await this.db.blobs.where('[accountId+msgId]').equals([accountId, msgId]).toArray();
    for (const b of uploads) if (b.direction === 'up') await rt.transfers.cancel(b.blobId);
  }

  async getDraft(accountId: string, chatId: string): Promise<string> {
    return (await this.db.drafts.get([accountId, chatId]))?.text ?? '';
  }

  /** Saves the unsent text of a chat; an empty text removes the draft. */
  async setDraft(accountId: string, chatId: string, text: string): Promise<void> {
    if (text.length === 0) await this.db.drafts.delete([accountId, chatId]);
    else await this.db.drafts.put({ accountId, chatId, text, updatedAt: this.#ctx.clock.now() });
  }

  /**
   * Queues a message with text, attachments and/or a place. Attachment files
   * are checked against the server limit (CoreError `too-large`), copied into
   * app storage and uploaded in parts; the message goes out after all parts
   * are on the server. Returns the message id.
   */
  async sendMessage(accountId: string, chatId: string, message: OutgoingMessage): Promise<string> {
    const rt = await this.#runtime(accountId);
    const files = message.attachments ?? [];
    if (files.length === 0) {
      const msgId = await enqueueMessage(rt, chatId, message.text ?? '', {
        reply: message.reply,
        ...(message.location ? { location: message.location } : {}),
        ...(message.fwd ? { fwd: true } : {}),
        ...(message.sticker ? { sticker: message.sticker } : {}),
      });
      rt.outbox.kick();
      return msgId;
    }
    const chat = await this.db.chats.get([accountId, chatId]);
    if (!chat) throw new CoreError('unknown-chat');
    const msgId = newMessageId();
    const { attachments, rows } = await prepareUploads(rt, this.#ctx.files, chatId, msgId, files);
    try {
      await enqueueMessage(rt, chatId, message.text ?? '', {
        msgId,
        reply: message.reply,
        attachments,
        ...(message.location ? { location: message.location } : {}),
        ...(message.fwd ? { fwd: true } : {}),
        inTransaction: async () => {
          await this.db.blobs.bulkPut(rows);
        },
      });
    } catch (e) {
      for (const r of rows) await (await this.#ctx.files.of(r.storage ?? 'idb')).delete(`${accountId}/${r.blobId}`).catch(() => undefined);
      throw e;
    }
    rt.transfers.kick();
    return msgId;
  }

  // ---- groups ----

  /** Group state as the UI shows it (live): name, members, owner, membership, mismatch with the server. */
  group(accountId: string, chatId: string): Readable<GroupView | null> {
    return live<GroupView | null>(null, () => groupView(this.db, accountId, chatId), (e) =>
      void this.#ctx.diag.error('db', `group query failed: ${String((e as Error)?.name)}`, accountId),
    );
  }

  /** Creates a group (I become the owner). Returns its chat id. */
  async createGroup(accountId: string, name: string, memberIds: readonly string[]): Promise<string> {
    const rt = await this.#runtime(accountId);
    return rt.groups.change({ type: 'create', name, members: [...memberIds] });
  }

  async renameGroup(accountId: string, chatId: string, name: string): Promise<void> {
    await (await this.#runtime(accountId)).groups.change({ type: 'rename', name }, chatId);
  }

  /**
   * Adds members. `history: true` (default): they read the group's history of
   * the current epoch that is still on the server; false ("without earlier
   * history"): a new epoch starts first.
   */
  async addGroupMembers(accountId: string, chatId: string, userIds: readonly string[], options: { history?: boolean } = {}): Promise<void> {
    await (await this.#runtime(accountId)).groups.change({ type: 'add', userIds: [...userIds], history: options.history ?? true }, chatId);
  }

  /** Removes members (new epoch: they cannot read anything sent afterwards). */
  async removeGroupMembers(accountId: string, chatId: string, userIds: readonly string[]): Promise<void> {
    await (await this.#runtime(accountId)).groups.change({ type: 'remove', userIds: [...userIds] }, chatId);
  }

  async transferGroupOwnership(accountId: string, chatId: string, to: string): Promise<void> {
    await (await this.#runtime(accountId)).groups.change({ type: 'transfer', to }, chatId);
  }

  /** Leaves a group. The owner must name the new owner (`transferTo`), else CoreError `owner-cannot-leave`. */
  async leaveGroup(accountId: string, chatId: string, options: { transferTo?: string } = {}): Promise<void> {
    await (await this.#runtime(accountId)).groups.leave(chatId, options.transferTo);
  }

  /** Re-reads groups and keys from the server now (GET /v1/chats, /v1/keys). */
  async refreshGroups(accountId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    await rt.groups.flushPending();
    await rt.groups.reconcile({ full: true });
    await rt.groups.ownerDuties();
  }

  // ---- attachments ----

  /** Starts downloading a received attachment (images and voice up to 10 MB start by themselves). */
  async downloadAttachment(accountId: string, blobId: string): Promise<void> {
    await (await this.#runtime(accountId)).transfers.download(blobId);
  }

  /** Stops a download (back to "not downloaded") or cancels an upload (the message then fails; cancel or retry it). */
  async cancelTransfer(accountId: string, blobId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    await rt.transfers.cancel(blobId);
    rt.outbox.kick();
  }

  /** Marks a received voice message as listened to on this device (`AttachmentView.heard`). */
  async markHeard(accountId: string, blobId: string): Promise<void> {
    await (await this.#runtime(accountId)).transfers.markHeard(blobId);
  }

  /** The attachment's contents as a Blob backed by app storage (never read whole into memory by the core). */
  async attachmentBlob(accountId: string, blobId: string): Promise<Blob> {
    return (await this.#runtime(accountId)).transfers.blob(blobId);
  }

  /** `URL.createObjectURL` of the attachment; the caller revokes it with `URL.revokeObjectURL`. */
  async attachmentUrl(accountId: string, blobId: string): Promise<string> {
    const blob = await this.attachmentBlob(accountId, blobId);
    if (typeof URL.createObjectURL !== 'function') throw new CoreError('invalid-input', 'object URLs are not available here');
    return URL.createObjectURL(blob);
  }

  // ---- profile, avatars, contacts ----

  /** Uploads a prepared JPEG or WebP (at most 256 KB) and signs a profile naming it. */
  async setAvatar(accountId: string, image: Blob | Uint8Array): Promise<AvatarRef> {
    return setAvatar(await this.#runtime(accountId), image);
  }

  async removeAvatar(accountId: string): Promise<void> {
    await removeAvatar(await this.#runtime(accountId));
  }

  /** A member's avatar (live; fetched with the token, checked by SHA-256 and cached). Null when none. */
  avatar(accountId: string, userId: string): Readable<AvatarView | null> {
    const db = this.db;
    const fetching = new Set<string>();
    return live<AvatarView | null>(
      null,
      async () => {
        const u = await db.users.get([accountId, userId]);
        const ref = u?.avatar;
        if (!ref) return null;
        const row = await db.avatars.get([accountId, userId]);
        if (row && row.sha256 === ref.sha256) {
          return { userId, sha256: row.sha256, type: row.type, blob: new Blob([row.bytes as Uint8Array<ArrayBuffer>], { type: row.type }) };
        }
        if (!fetching.has(ref.sha256)) {
          fetching.add(ref.sha256);
          // Outside the live query: the fetch writes the cache, which re-runs the query.
          setTimeout(() => {
            void this.#runtime(accountId)
              .then((rt) => fetchAvatar(rt, userId))
              .catch((e: unknown) => void this.#ctx.diag.info('avatar', `avatar of ${userId} not fetched: ${String((e as Error)?.name)}`, accountId));
          }, 0);
        }
        return null;
      },
      (e) => void this.#ctx.diag.error('db', `avatar query failed: ${String((e as Error)?.name)}`, accountId),
    );
  }

  /** A member's avatar as a Blob (fetched if needed), or null. */
  async avatarBlob(accountId: string, userId: string): Promise<Blob | null> {
    const row = await fetchAvatar(await this.#runtime(accountId), userId);
    return row ? new Blob([row.bytes as Uint8Array<ArrayBuffer>], { type: row.type }) : null;
  }

  /** Marks a member's current fingerprint as verified (or clears the mark). Local only. */
  async setVerified(accountId: string, userId: string, verified: boolean): Promise<void> {
    await (await this.#runtime(accountId)).directory.setVerified(userId, verified);
  }

  // ---- revocation ----

  /**
   * Revokes my identity on this account's server (lost device, leaked key).
   * Irreversible there: every device of this identity is signed out for good.
   * The local history stays readable.
   */
  async revokeIdentity(accountId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    const keys = await this.#ctx.keys(rt.session.userId);
    await revokeIdentity(this.#ctx, rt.session.serverUrl, keys);
    await rt.session.markRevoked().catch(() => undefined);
    await rt.stop();
  }

  /** Revokes an identity by its recovery phrase, without a device (the phrase is a secret, never stored). */
  async revokeIdentityByPhrase(serverUrl: string, phrase: string): Promise<void> {
    await revokeIdentity(this.#ctx, serverUrl, keysFromPhrase(phrase));
    for (const rt of this.#runtimes.values()) {
      const row = await this.db.accounts.get(rt.accountId);
      if (row?.revoked) await rt.stop();
    }
  }

  // ---- archive ----

  /**
   * The local history of one identity as an `.fcarchive` byte stream (header,
   * then encrypted blocks): accounts without tokens, contacts, chats, group
   * states with epoch secrets, verified events; attachment files with
   * `includeFiles`. Write the chunks to a file in order.
   */
  async *exportArchive(options: ExportOptions = {}): AsyncGenerator<Uint8Array> {
    const keys = await this.#identityKeys(options.userId);
    yield* exportArchive(this.#ctx, keys, options);
  }

  /** exportArchive as a ReadableStream (for `new Response(stream).blob()` or a file writer). */
  async exportArchiveStream(options: ExportOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const keys = await this.#identityKeys(options.userId);
    return toReadableStream(exportArchive(this.#ctx, keys, options));
  }

  /**
   * Imports an archive of an identity stored on this device (restore it by
   * phrase first). Events are verified again and replayed through the sync
   * path; known ones are skipped. CoreError `wrong-identity` for an archive of
   * another identity, `bad-archive` for a damaged one.
   */
  async importArchive(source: ArchiveSource): Promise<ImportResult> {
    this.#ensureOpen();
    const result = await importArchive(
      {
        ctx: this.#ctx,
        identities: async () => Promise.all((await this.db.identities.toArray()).map((i) => this.#ctx.keys(i.userId))),
        runtime: (id) => this.#runtime(id),
      },
      source,
    );
    for (const id of result.newAccounts) {
      const rt = await this.#runtime(id);
      if (this.#started) rt.start();
    }
    return result;
  }

  // ---- administration ----

  readonly admin = {
    createInvite: async (accountId: string): Promise<CreatedInvite> => {
      const rt = await this.#runtime(accountId);
      const inv = await rt.session.call((t) => rt.session.transport.createInvite(t));
      return { ...inv, link: inviteLink(rt.session.serverUrl, inv.code) };
    },
    listInvites: async (accountId: string): Promise<InviteInfo[]> => {
      const rt = await this.#runtime(accountId);
      return rt.session.call((t) => rt.session.transport.listInvites(t));
    },
    revokeInvite: async (accountId: string, inviteId: string): Promise<void> => {
      const rt = await this.#runtime(accountId);
      await rt.session.call((t) => rt.session.transport.revokeInvite(t, inviteId));
    },
    listUsers: async (accountId: string): Promise<AdminUser[]> => {
      const rt = await this.#runtime(accountId);
      return rt.session.call((t) => rt.session.transport.adminUsers(t));
    },
    removeUser: async (accountId: string, userId: string): Promise<void> => {
      const rt = await this.#runtime(accountId);
      await rt.session.call((t) => rt.session.transport.removeUser(t, userId));
      await rt.directory.refresh().catch(() => undefined);
    },
    stats: async (accountId: string): Promise<ServerStats> => {
      const rt = await this.#runtime(accountId);
      return rt.session.call((t) => rt.session.transport.stats(t));
    },
  };

  // ---- push ----

  readonly push = {
    /** Public VAPID key for `PushManager.subscribe({applicationServerKey})`, or null when push is off. */
    vapidPublicKey: async (accountId: string): Promise<string | null> =>
      (await this.db.accounts.get(accountId))?.vapidPublicKey ?? null,
    /** Hands `PushSubscription.toJSON()` to the server for this device. */
    register: async (accountId: string, sub: PushSubscriptionInput): Promise<void> =>
      registerPush(await this.#runtime(accountId), sub),
    unregister: async (accountId: string): Promise<void> => unregisterPush(await this.#runtime(accountId)),
  };

  /** What to show for a received push payload `{chatId, gseq}`. Never throws. */
  handlePush(payload: unknown): Promise<PushNotice> {
    return handlePush(this.#ctx, payload, (id) => this.#runtime(id));
  }

  // ---- M5: sticker packs ----

  /** Published sticker packs of a family (live), oldest first. */
  stickerPacks(accountId: string): Readable<StickerPackView[]> {
    const db = this.db;
    return live<StickerPackView[]>(
      [],
      async () => {
        const me = (await db.accounts.get(accountId))?.userId;
        const rows = await db.stickerPacks.where('accountId').equals(accountId).toArray();
        rows.sort((a, b) => (a.publishedAt ?? a.created) - (b.publishedAt ?? b.created) || a.packId.localeCompare(b.packId));
        return rows.map((r) => ({
          accountId,
          packId: r.packId,
          name: r.name,
          author: r.author,
          mine: r.author === me,
          stickers: r.stickers,
          publishedAt: r.publishedAt,
        }));
      },
      (e) => void this.#ctx.diag.error('db', `sticker packs query failed: ${String((e as Error)?.name)}`, accountId),
    );
  }

  /** Reads the family's pack list from the server now (manifests are verified). */
  async refreshStickers(accountId: string): Promise<void> {
    await (await this.#runtime(accountId)).stickers.refresh();
  }

  /**
   * Reads chosen `.webp`, `.tgs` and `.zip` files into a pack preview; every
   * file is checked (StickerError for an unsafe archive or nothing usable).
   * Nothing is stored or sent.
   */
  async importStickers(inputs: readonly ImportInput[]): Promise<StickerImport> {
    const { importStickers } = await import('./stickers/import.ts');
    return importStickers(inputs);
  }

  /** Unpacks and sanitises `.tgs` bytes (for previews of an imported pack). */
  async readTgs(bytes: Uint8Array): Promise<SanitizedLottie> {
    const { readTgs } = await import('./stickers/tgs.ts');
    return readTgs(bytes);
  }

  /** Publishes an imported pack for the family. Returns its pack id. */
  async publishStickerPack(accountId: string, name: string, pack: StickerImport): Promise<string> {
    return (await this.#runtime(accountId)).stickers.publish(name, pack.stickers);
  }

  /** Deletes my pack for everyone. */
  async deleteStickerPack(accountId: string, packId: string): Promise<void> {
    await (await this.#runtime(accountId)).stickers.delete(packId);
  }

  /** A sticker image as a Blob (checked against its hash). CoreError `gone` when its pack was deleted. */
  async stickerFile(accountId: string, packId: string, file: string): Promise<Blob> {
    const f = await (await this.#runtime(accountId)).stickers.file(packId, file);
    return new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type === 'webp' ? 'image/webp' : 'application/octet-stream' });
  }

  /** The sanitised animation data of a `.tgs` sticker (expressions and external addresses removed). */
  async stickerAnimation(accountId: string, packId: string, file: string): Promise<SanitizedLottie> {
    return (await this.#runtime(accountId)).stickers.animation(packId, file);
  }

  /** Sends a sticker of a pack of this family as its own message. Returns the message id. */
  async sendSticker(accountId: string, chatId: string, packId: string, file: string, reply?: MsgRef): Promise<string> {
    const row = await this.db.stickerPacks.get([accountId, packId]);
    const s = row?.stickers.find((x) => x.file === file);
    if (!row || !s) throw new CoreError('gone', 'no such sticker');
    return this.sendMessage(accountId, chatId, {
      text: s.emoji,
      sticker: { pack: packId, file, type: s.type, w: s.w, h: s.h },
      ...(reply ? { reply } : {}),
    });
  }

  // ---- M5: identity links ----

  /** Links of a family on this device (live). */
  identityLinks(accountId: string): Readable<IdentityLinkView[]> {
    const db = this.db;
    return live<IdentityLinkView[]>(
      [],
      async () => {
        const users = new Map((await db.users.where('accountId').equals(accountId).toArray()).map((u) => [u.userId, u]));
        return (await db.links.where('accountId').equals(accountId).toArray()).map((l: IdentityLinkRow) => ({
          accountId,
          userId: l.userId,
          to: l.to,
          valid: linkValid(l, users),
        }));
      },
      (e) => void this.#ctx.diag.error('db', `links query failed: ${String((e as Error)?.name)}`, accountId),
    );
  }

  /**
   * "This is the same person as…": links two members of a family on this
   * device after the person compared fingerprints. The older direct chat is
   * shown inside the newer one. Local only. Returns the newer direct chat id.
   */
  async linkIdentity(accountId: string, a: string, b: string): Promise<string> {
    const rt = await this.#runtime(accountId);
    const link = await linkIdentities(this.#ctx, accountId, rt.session.userId, a, b);
    return this.openChat(accountId, link.to);
  }

  async unlinkIdentity(accountId: string, userId: string): Promise<void> {
    await unlinkIdentity(this.#ctx, accountId, userId);
  }

  // ---- M5: badge and shared content ----

  /** Stores the total the app shows on the icon, for the service worker's count (badge.ts). */
  async noteBadge(total: number): Promise<void> {
    await this.db.settings.put({ key: SETTING_BADGE_COUNT, value: total });
  }

  /**
   * Takes what was shared into the app (Web Share Target) and forgets it, or
   * null. A stale or malformed stash is dropped.
   */
  async takeShared(): Promise<SharedContent | null> {
    let value: unknown;
    await this.db.transaction('rw', this.db.settings, async () => {
      value = (await this.db.settings.get(SETTING_SHARE_PENDING))?.value;
      if (value !== undefined) await this.db.settings.delete(SETTING_SHARE_PENDING);
    });
    return value === undefined ? null : parseShared(value, this.#ctx.clock.now());
  }

  // ---- settings and diagnostics ----

  async getSetting<T = unknown>(key: string): Promise<T | undefined> {
    return (await this.db.settings.get(key))?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  /** The diagnostics log as text, for "copy report". Contains no secrets or message text. */
  diagnosticsReport(): Promise<string> {
    return this.#ctx.diag.report();
  }

  /**
   * Adds an entry to the diagnostics log (for the UI's own events). The
   * message must be composed from non-secret values; long base64 runs are
   * redacted anyway.
   */
  logDiagnostic(level: DiagnosticLevel, kind: string, message: string, accountId: string | null = null): Promise<void> {
    return this.#ctx.diag.log(level, kind, message, accountId);
  }

  clearDiagnostics(): Promise<void> {
    return this.#ctx.diag.clear();
  }

  // ---- internals ----

  async #identityKeys(userId: string | undefined): Promise<IdentityKeys> {
    const ids = await this.db.identities.toArray();
    const id = userId ?? (ids.length === 1 ? ids[0]!.userId : undefined);
    if (!id) throw new CoreError(ids.length === 0 ? 'no-identity' : 'invalid-input', 'which identity?');
    return this.#ctx.keys(id);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new CoreError('closed');
  }

  async #runtime(accountId: string): Promise<AccountRuntime> {
    this.#ensureOpen();
    let rt = this.#runtimes.get(accountId);
    if (rt) return rt;
    const row = await this.db.accounts.get(accountId);
    if (!row) throw new CoreError('no-account');
    rt = this.#runtimes.get(accountId);
    if (rt) return rt;
    rt = new AccountRuntime(this.#ctx, row);
    this.#runtimes.set(accountId, rt);
    const unsub = rt.sync.state.subscribe((s) => this.#connection.update((m) => ({ ...m, [accountId]: s })));
    this.#connUnsubs.set(accountId, unsub);
    return rt;
  }

  async #adopt(row: AccountRow): Promise<AccountView> {
    const rt = await this.#runtime(row.id);
    await ensureSelfChat(rt);
    await rt.directory.refresh().catch((e: unknown) => {
      void this.#ctx.diag.warn('directory', `first member list fetch failed: ${String((e as Error)?.name)}`, row.id);
    });
    if (this.#started) rt.start();
    return accountView((await this.db.accounts.get(row.id)) ?? row);
  }

  async #chatList(): Promise<ChatListItem[]> {
    const db = this.db;
    const [accounts, chats, users, drafts, outbox] = await Promise.all([
      db.accounts.toArray(),
      db.chats.toArray(),
      db.users.toArray(),
      db.drafts.toArray(),
      db.outbox.toArray(),
    ]);
    const acc = new Map(accounts.map((a) => [a.id, a]));
    const user = new Map(users.map((u) => [`${u.accountId}/${u.userId}`, u]));
    const draft = new Map(drafts.map((d) => [`${d.accountId}/${d.chatId}`, d.text]));
    const pending = new Map<string, number>();
    for (const o of outbox) {
      if (o.control) continue;
      pending.set(`${o.accountId}/${o.chatId}`, (pending.get(`${o.accountId}/${o.chatId}`) ?? 0) + 1);
    }
    const items: (ChatListItem & { sortKey: number })[] = [];
    for (const c of chats) {
      const a = acc.get(c.accountId);
      if (!a || c.kind !== 'dm') continue;
      const peer = user.get(`${c.accountId}/${c.peerId}`);
      const key = `${c.accountId}/${c.chatId}`;
      items.push({
        accountId: c.accountId,
        chatId: c.chatId,
        peerId: c.peerId,
        peerName: peer?.name ?? null,
        peerRemoved: peer?.removed ?? false,
        familyName: a.familyName,
        lastMessage: c.last
          ? {
              senderId: c.last.senderId,
              outgoing: c.last.senderId === a.userId,
              kind: c.last.kind,
              body: c.last.body,
              time: c.last.time,
            }
          : null,
        lastTime: c.last?.time ?? null,
        unread: c.unread,
        pending: pending.get(key) ?? 0,
        draft: draft.get(key) ?? null,
        sortKey: c.last?.time ?? c.createdAt,
      });
    }
    items.sort((x, y) => y.sortKey - x.sortKey);
    return items.map(({ sortKey: _sortKey, ...rest }) => rest);
  }
}

/** Creates the facade. Call `start()` before use. */
export function createCore(options: CoreOptions = {}): FamilyChatCore {
  return new FamilyChatCore(options);
}

/**
 * For a service worker: handles one push payload with a short-lived core
 * (no sync loops), then closes it. Never throws.
 */
export async function handlePushPayload(payload: unknown, options: CoreOptions = {}): Promise<PushNotice> {
  const core = new FamilyChatCore(options);
  try {
    await openDb(core.db);
    return await core.handlePush(payload);
  } catch {
    return { kind: 'generic', accountId: null, chatId: null, familyName: null, chatName: null };
  } finally {
    if (!options.db) await core.close().catch(() => undefined);
    else await core.stop();
  }
}
