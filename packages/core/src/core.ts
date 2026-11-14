// The facade for the UI: one object per app. Methods for every action, and
// observable state (Readable stores, Svelte-compatible) backed by Dexie live
// queries, so changes made by another tab or worker show up too.
//
// No DOM: it needs fetch, IndexedDB, WebCrypto and timers, all present in a
// worker. In M1 it may run on the main thread.

import { fingerprint, type MsgRef } from '@family-chat/protocol';
import { Dexie, liveQuery } from 'dexie';
import {
  AccountRuntime,
  addDeviceForIdentity,
  createIdentity,
  fetchHello,
  joinServer,
  recoveryPhrase,
  restoreAccount,
  updateProfile,
  type JoinInput,
  type RestoreInput,
} from './accounts.ts';
import type { FetchFn } from './api/transport.ts';
import type {
  AdminUser,
  Hello,
  InviteInfo,
  NewInvite,
  PushSubscriptionInput,
  ServerStats,
} from './api/types.ts';
import { commitEvents, decodeEvents } from './apply.ts';
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
import { byQueueOrder, cancelMessage, enqueueMessage, retryMessage } from './outbox.ts';
import { handlePush, registerPush, unregisterPush, type PushNotice } from './push.ts';
import type { ConnectionState } from './sync.ts';
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
  /** Direct chat id with this member (null for oneself). */
  readonly chatId: string | null;
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

/** "on-device": in the outbox; "on-server": accepted by the server; "failed": needs retry or cancel. */
export type MessageStatus = 'on-device' | 'on-server' | 'failed';

export interface MessageView {
  /** Stable key for lists: `${senderId}/${msgId}`. */
  readonly key: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly msgId: string;
  readonly senderId: string;
  readonly outgoing: boolean;
  /** `update-required`: show "update the app to see this message". */
  readonly kind: MessageKind;
  readonly body: string;
  readonly reply: MsgRef | null;
  /** Server order and time; null while the message is still on the device. */
  readonly gseq: number | null;
  readonly time: number | null;
  readonly status: MessageStatus;
  /** Last error code for failed or retrying outbox messages. */
  readonly error: string | null;
}

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
  };
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
  /** All chats of all accounts, most recent first. */
  readonly chats: Readable<ChatListItem[]>;
  /** Messages not yet accepted by the server, oldest first. */
  readonly outbox: Readable<OutboxItem[]>;
  readonly drafts: Readable<DraftItem[]>;
  /** The diagnostics log, oldest first (at most 500 entries). */
  readonly diagnostics: Readable<DiagnosticEntry[]>;

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
    });
    const onError = (e: unknown) => void this.#ctx.diag.error('db', `live query failed: ${String((e as Error)?.name)}`);
    const db = this.db;

    this.accounts = live<AccountView[]>([], async () => (await db.accounts.toArray()).map(accountView), onError);
    this.connection = { subscribe: (run) => this.#connection.subscribe(run), get: () => this.#connection.get() };
    this.chats = live<ChatListItem[]>([], () => this.#chatList(), onError);
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

  /** Joins a server with an invitation or the admin code; starts syncing it. */
  async join(input: JoinInput): Promise<AccountView> {
    const row = await joinServer(this.#ctx, input);
    return this.#adopt(row);
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
    const query = async (): Promise<MessageView[]> => {
      const account = await db.accounts.get(accountId);
      const me = account?.userId ?? '';
      const rows = await db.messages
        .where('[accountId+chatId+gseq]')
        .between([accountId, chatId, Dexie.minKey], [accountId, chatId, Dexie.maxKey])
        .reverse()
        .limit(limit)
        .toArray();
      rows.reverse();
      const out: MessageView[] = rows.map((m) => ({
        key: `${m.senderId}/${m.msgId}`,
        accountId,
        chatId,
        msgId: m.msgId,
        senderId: m.senderId,
        outgoing: m.senderId === me,
        kind: m.kind,
        body: m.body,
        reply: m.reply,
        gseq: m.gseq,
        time: m.time,
        status: 'on-server',
        error: null,
      }));
      const pending = (await db.outbox.where('[accountId+chatId]').equals([accountId, chatId]).toArray()).sort(
        byQueueOrder,
      );
      for (const o of pending) {
        out.push({
          key: `${me}/${o.msgId}`,
          accountId,
          chatId,
          msgId: o.msgId,
          senderId: me,
          outgoing: true,
          kind: 'msg',
          body: o.body,
          reply: o.reply,
          gseq: null,
          time: null,
          status: o.status === 'failed' ? 'failed' : 'on-device',
          error: o.error,
        });
      }
      return out;
    };
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
        const items = await decodeEvents(rt, page.events);
        await commitEvents(this.#ctx, accountId, rt.session.userId, items);
        const after = await range().count();
        limit += MESSAGES_PAGE;
        reload.update((n) => n + 1);
        return after > local || page.more;
      },
      markRead: () => this.markRead(accountId, chatId),
    };
  }

  async markRead(accountId: string, chatId: string): Promise<void> {
    await this.db.transaction('rw', this.db.chats, async () => {
      const c = await this.db.chats.get([accountId, chatId]);
      if (!c) return;
      await this.db.chats.put({ ...c, unread: 0, readGseq: Math.max(c.readGseq, c.last?.gseq ?? 0) });
    });
  }

  /** Queues a text message (Markdown, at most 16 KB). Returns its message id. Clears the chat's draft. */
  async send(accountId: string, chatId: string, text: string, reply?: MsgRef): Promise<string> {
    const rt = await this.#runtime(accountId);
    const msgId = await enqueueMessage(rt, chatId, text, reply);
    rt.outbox.kick();
    return msgId;
  }

  /** Sends a failed message again. */
  async retry(accountId: string, msgId: string): Promise<void> {
    const rt = await this.#runtime(accountId);
    await retryMessage(rt, msgId);
    rt.outbox.kick();
  }

  /** Removes a message that has not reached the server. */
  async cancel(accountId: string, msgId: string): Promise<void> {
    await cancelMessage(await this.#runtime(accountId), msgId);
  }

  async getDraft(accountId: string, chatId: string): Promise<string> {
    return (await this.db.drafts.get([accountId, chatId]))?.text ?? '';
  }

  /** Saves the unsent text of a chat; an empty text removes the draft. */
  async setDraft(accountId: string, chatId: string, text: string): Promise<void> {
    if (text.length === 0) await this.db.drafts.delete([accountId, chatId]);
    else await this.db.drafts.put({ accountId, chatId, text, updatedAt: this.#ctx.clock.now() });
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
    for (const o of outbox) pending.set(`${o.accountId}/${o.chatId}`, (pending.get(`${o.accountId}/${o.chatId}`) ?? 0) + 1);
    const items: (ChatListItem & { sortKey: number })[] = [];
    for (const c of chats) {
      const a = acc.get(c.accountId);
      if (!a) continue;
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
