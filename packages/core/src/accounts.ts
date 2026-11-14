// Identity and accounts: create an identity, join a server (invitation or
// administrator code), restore by the 24-word phrase on a new device, update
// the own profile. Plus the per-account runtime that ties session, directory,
// sync engine and outbox together.

import {
  base32Encode,
  createIdentityEnvelope,
  createProfileEnvelope,
  createRevocationEnvelope,
  deriveIdentityKeys,
  newDevId,
  newSeed,
  phraseToSeed,
  randomBytes,
  seedToPhrase,
  type AvatarRef,
  type IdentityKeys,
} from '@family-chat/protocol';
import { isApiError } from './api/errors.ts';
import { normalizeServerUrl, type Transport } from './api/transport.ts';
import type { Hello, InviteCheck, IssuedToken, JoinCode } from './api/types.ts';
import { retryPendingEvents, type AccountRuntimeLike } from './apply.ts';
import { Transfers } from './attachments.ts';
import type { CoreContext } from './context.ts';
import type { AccountRow } from './db/schema.ts';
import { Directory } from './directory.ts';
import { CoreError } from './errors.ts';
import { Groups } from './groups.ts';
import { OutboxSender } from './outbox.ts';
import { authenticateDevice, Session } from './session.ts';
import { SyncEngine } from './sync.ts';
import { StickerPacks } from './stickers/packs.ts';
import { fileKey } from './attachments.ts';
import { removeFiles } from './apply.ts';
import { Dexie, type Table } from 'dexie';

export const SUPPORTED_PROTOCOL = 1;

export class AccountRuntime implements AccountRuntimeLike {
  readonly session: Session;
  readonly directory: Directory;
  readonly groups: Groups;
  readonly sync: SyncEngine;
  readonly outbox: OutboxSender;
  readonly transfers: Transfers;
  /** Sticker packs of this server (M5). */
  readonly stickers: StickerPacks;
  #started = false;
  #connectedOnce = false;

  constructor(
    readonly ctx: CoreContext,
    account: AccountRow,
  ) {
    this.session = new Session(ctx, account);
    this.directory = new Directory(ctx, this.session);
    this.groups = new Groups({
      ctx,
      session: this.session,
      directory: this.directory,
      retryPending: async (chatIds) => {
        await retryPendingEvents(this, chatIds);
      },
    });
    this.outbox = new OutboxSender(this);
    this.stickers = new StickerPacks(this);
    this.transfers = new Transfers(this, ctx.files, { onUploaded: () => this.outbox.kick() });
    this.sync = new SyncEngine(this, {
      onConnected: () => {
        this.outbox.kick();
        this.transfers.kick();
        if (!this.#connectedOnce) {
          this.#connectedOnce = true;
          this.groups.kick({ full: true });
          void this.stickers.refresh().catch((e: unknown) =>
            void ctx.diag.info('stickers', `sticker packs not refreshed: ${String((e as Error)?.name)}`, this.session.accountId),
          );
        }
      },
    });
  }

  readonly onAttachments = (): void => this.transfers.kick();

  get accountId(): string {
    return this.session.accountId;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void ensureSelfChat(this).catch(() => undefined);
    this.sync.start();
    this.outbox.start();
    this.groups.start();
    this.transfers.start();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await Promise.all([this.sync.stop(), this.outbox.stop(), this.groups.stop(), this.transfers.stop()]);
  }
}

/** The chat with myself ("Избранное") exists on every account. Returns its id. */
export async function ensureSelfChat(rt: AccountRuntimeLike): Promise<string> {
  const { db, clock } = rt.ctx;
  const acc = rt.session.accountId;
  const chatId = rt.directory.selfChatId();
  await db.transaction('rw', db.chats, async () => {
    if (await db.chats.get([acc, chatId])) return;
    await db.chats.put({ accountId: acc, chatId, kind: 'self', peerId: rt.session.userId, createdAt: clock.now(), last: null, readGseq: 0, unread: 0 });
  });
  return chatId;
}

/** A new identity; the seed is stored on this device. Returns its userId. */
export async function createIdentity(ctx: CoreContext): Promise<string> {
  return storeSeed(ctx, newSeed());
}

/** The 24-word recovery phrase of an identity stored on this device. A secret: show it, never log it. */
export async function recoveryPhrase(ctx: CoreContext, userId: string): Promise<string> {
  const row = await ctx.db.identities.get(userId);
  if (!row) throw new CoreError('no-identity');
  return seedToPhrase(row.seed);
}

export async function fetchHello(ctx: CoreContext, serverUrl: string): Promise<Hello> {
  const hello = await ctx.transport(normalizeServerUrl(serverUrl)).hello();
  if (hello.protocol !== SUPPORTED_PROTOCOL) throw new CoreError('unsupported-server');
  return hello;
}

async function ensureNewServer(ctx: CoreContext, serverId: string): Promise<void> {
  const existing = await ctx.db.accounts.where('serverId').equals(serverId).first();
  if (existing) throw new CoreError('account-exists');
}

function newAccountId(): string {
  return base32Encode(randomBytes(10));
}

async function saveAccount(
  ctx: CoreContext,
  serverUrl: string,
  hello: Hello,
  issued: IssuedToken,
): Promise<AccountRow> {
  const row: AccountRow = {
    id: newAccountId(),
    serverUrl,
    serverId: hello.serverId,
    familyName: hello.familyName,
    userId: issued.userId,
    devId: issued.devId,
    token: issued.token,
    admin: issued.admin,
    status: 'active',
    cursor: 0,
    initialSyncDone: false,
    retentionGap: null,
    retentionDays: hello.retentionDays,
    pushAvailable: hello.push,
    vapidPublicKey: hello.vapidPublicKey,
    pushRegistered: false,
    createdAt: ctx.clock.now(),
    lastSyncAt: null,
  };
  await ctx.db.accounts.add(row);
  void ctx.diag.info('auth', `account created for server ${hello.serverId}`, row.id);
  return row;
}

export interface JoinInput {
  readonly serverUrl: string;
  /** Exactly one: the invitation code, or the administrator code for the first member. */
  readonly code: JoinCode;
  /** Display name for the profile. */
  readonly name: string;
  /** Existing identity on this device. */
  readonly userId?: string;
  /** Or an identity restored from its phrase (stored once the server accepts it). */
  readonly phrase?: string;
  /** With neither, a new identity is created. */
}

/**
 * Joins a server. When the server says this identity is already a member
 * (409 `already_member`), adds this device by signature instead.
 */
export async function joinServer(ctx: CoreContext, input: JoinInput): Promise<AccountRow> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const transport = ctx.transport(serverUrl);
  const hello = await fetchHello(ctx, serverUrl);
  await ensureNewServer(ctx, hello.serverId);
  let keys: IdentityKeys;
  let seedToStore: Uint8Array | undefined;
  if (input.userId !== undefined) {
    keys = await ctx.keys(input.userId);
  } else {
    seedToStore = input.phrase !== undefined ? phraseToSeed(input.phrase) : newSeed();
    keys = deriveIdentityKeys(seedToStore);
  }
  const userId = keys.userId;
  const now = ctx.clock.now();
  // Validates the name (ProtocolError `invalid-argument`) before anything is sent.
  const profile = createProfileEnvelope(keys, { name: input.name, rev: 1, updated: now });
  const identity = createIdentityEnvelope(keys, now);
  const devId = newDevId();
  const code: JoinCode = 'invite' in input.code ? { invite: input.code.invite } : { adminCode: input.code.adminCode };
  let issued: IssuedToken;
  try {
    issued = await transport.join({ ...code, identity, profile, devId });
  } catch (e) {
    if (!isApiError(e, 'already_member')) throw e;
    issued = await authenticateDevice(transport, keys, hello.serverId, devId);
  }
  if (seedToStore) await storeSeed(ctx, seedToStore);
  const row = await saveAccount(ctx, serverUrl, hello, issued);
  // Our own entry, so that the directory knows us before the first refresh.
  const rt = new AccountRuntime(ctx, row);
  await rt.directory.ingest([{ userId, identity, profile, admin: issued.admin, removed: false }]);
  return row;
}

export interface RestoreInput {
  readonly serverUrl: string;
  /** The 24-word recovery phrase (a secret). */
  readonly phrase: string;
}

/**
 * Restores an identity from its phrase and adds this device to a server where
 * the identity is a member (`auth/challenge` + `auth/device`). The seed is
 * stored only after the server accepted the signature. Throws CoreError
 * `unknown-user` when the identity is not a member there; it then needs an
 * invitation: joinServer with the same `phrase`.
 */
export async function restoreAccount(ctx: CoreContext, input: RestoreInput): Promise<AccountRow> {
  const seed = phraseToSeed(input.phrase);
  return addDevice(ctx, input.serverUrl, deriveIdentityKeys(seed), seed);
}

/** Adds this device to another server for an identity already stored here. */
export async function addDeviceForIdentity(ctx: CoreContext, serverUrl: string, userId: string): Promise<AccountRow> {
  return addDevice(ctx, serverUrl, await ctx.keys(userId), undefined);
}

async function addDevice(
  ctx: CoreContext,
  serverUrlInput: string,
  keys: IdentityKeys,
  seedToStore: Uint8Array | undefined,
): Promise<AccountRow> {
  const serverUrl = normalizeServerUrl(serverUrlInput);
  const transport: Transport = ctx.transport(serverUrl);
  const hello = await fetchHello(ctx, serverUrl);
  await ensureNewServer(ctx, hello.serverId);
  let issued: IssuedToken;
  try {
    issued = await authenticateDevice(transport, keys, hello.serverId, newDevId());
  } catch (e) {
    if (isApiError(e, 'unknown_user')) throw new CoreError('unknown-user', 'this identity is not a member of the server');
    if (isApiError(e, 'removed')) throw new CoreError('removed');
    if (isApiError(e, 'revoked')) throw new CoreError('revoked', 'this identity was revoked on the server');
    throw e;
  }
  if (seedToStore) await storeSeed(ctx, seedToStore);
  return saveAccount(ctx, serverUrl, hello, issued);
}

async function storeSeed(ctx: CoreContext, seed: Uint8Array): Promise<string> {
  const keys = deriveIdentityKeys(seed);
  await ctx.db.identities.put({ userId: keys.userId, seed, createdAt: ctx.clock.now() });
  ctx.rememberKeys(keys);
  return keys.userId;
}

export interface ProfileChange {
  readonly name?: string;
  /** New avatar reference (after PUT /v1/me/avatar), or null to remove it. */
  readonly avatar?: AvatarRef | null;
}

/**
 * Signs and uploads a new profile (rev = stored + 1; one retry on 409
 * stale_rev). Fields not given keep their current values.
 */
export async function updateProfile(rt: AccountRuntimeLike, changeOrName: string | ProfileChange): Promise<void> {
  const change: ProfileChange = typeof changeOrName === 'string' ? { name: changeOrName } : changeOrName;
  const { ctx, session, directory } = rt;
  const keys = await ctx.keys(session.userId);
  let me = await directory.user(session.userId);
  if (!me) {
    await directory.refresh();
    me = await directory.user(session.userId);
    if (!me) throw new CoreError('unknown-user');
  }
  const name = change.name ?? me.name;
  if (name === null) throw new CoreError('invalid-input', 'no name');
  const avatar = change.avatar !== undefined ? change.avatar : (me.avatar ?? null);
  let rev = Math.max(me.rev, 0) + 1;
  for (let attempt = 0; ; attempt++) {
    const env = createProfileEnvelope(keys, { name, rev, updated: ctx.clock.now(), avatar });
    try {
      const stored = await session.call((t) => session.transport.putProfile(t, env));
      await directory.ingest([
        { userId: me.userId, identity: me.identity, profile: stored, admin: me.admin, removed: me.removed },
      ]);
      void ctx.diag.info('auth', `profile updated (rev ${rev})`, session.accountId);
      return;
    } catch (e) {
      if (isApiError(e, 'stale_rev') && attempt === 0) {
        rev = Math.max(rev, e.details.rev ?? rev) + 1;
        continue;
      }
      throw e;
    }
  }
}

/** `POST /v1/invites/check`: who invites into which family; 'invalid' for an unknown code. */
export async function checkInvite(
  ctx: CoreContext,
  serverUrl: string,
  code: string,
): Promise<InviteCheck | { readonly status: 'invalid' }> {
  try {
    return await ctx.transport(normalizeServerUrl(serverUrl)).inviteCheck(code.trim().toLowerCase());
  } catch (e) {
    if (isApiError(e, 'invalid_invite')) return { status: 'invalid' };
    throw e;
  }
}

/**
 * Revokes an identity on one server by its own signature (no token needed).
 * Every account of that identity on that server becomes 'removed' with the
 * `revoked` flag. Irreversible: the identity can never sign in there again.
 */
export async function revokeIdentity(ctx: CoreContext, serverUrl: string, keys: IdentityKeys): Promise<void> {
  const url = normalizeServerUrl(serverUrl);
  const env = createRevocationEnvelope(keys, ctx.clock.now());
  try {
    await ctx.transport(url).revoke(env);
  } catch (e) {
    if (isApiError(e, 'unknown_user')) throw new CoreError('unknown-user', 'this identity is not a member of the server');
    throw e;
  }
  const rows = await ctx.db.accounts.where('serverId').equals((await fetchHello(ctx, url)).serverId).toArray();
  for (const r of rows) {
    if (r.userId === keys.userId) await ctx.db.accounts.update(r.id, { status: 'removed', revoked: true });
  }
  void ctx.diag.warn('auth', `identity ${keys.userId} revoked on ${url}`);
}

/** Tables whose primary key starts with `accountId` (everything an account owns on this device). */
function accountTables(ctx: CoreContext): Table<unknown, unknown[]>[] {
  const db = ctx.db;
  return [
    db.users,
    db.chats,
    db.events,
    db.messages,
    db.outbox,
    db.counters,
    db.seqTrack,
    db.drafts,
    db.groups,
    db.groupStates,
    db.epochKeys,
    db.sealedKeys,
    db.groupPending,
    db.notices,
    db.pendingEvents,
    db.blobs,
    db.avatars,
    db.controls,
    db.tombstones,
    db.stickerPacks,
    db.stickerFiles,
    db.links,
  ] as unknown as Table<unknown, unknown[]>[];
}

/**
 * Removes an account from this device (M5): its history, files, keys of its
 * groups and its token. Nothing is sent to other servers. The server keeps
 * the device registered (there is no endpoint to drop a device token); the
 * push subscription is removed there when possible. The identity seed is
 * removed too when no other account on this device uses it: coming back then
 * needs the recovery phrase. Call with the account's loops stopped.
 */
export async function removeAccount(ctx: CoreContext, accountId: string): Promise<void> {
  const { db } = ctx;
  const row = await db.accounts.get(accountId);
  if (!row) throw new CoreError('no-account');
  if (row.pushRegistered && row.status === 'active') {
    const t = ctx.transport(row.serverUrl);
    await Promise.race([t.deletePush(row.token).catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
  }
  const files = (await db.blobs.where('accountId').equals(accountId).toArray())
    .filter((b) => b.storage)
    .map((b) => ({ storage: b.storage!, key: fileKey(accountId, b.blobId) }));
  const others = (await db.accounts.toArray()).filter((a) => a.id !== accountId && a.userId === row.userId);
  const tables = accountTables(ctx);
  await db.transaction('rw', [db.accounts, db.identities, ...tables], async () => {
    for (const t of tables) await t.where(':id').between([accountId], [accountId, Dexie.maxKey]).delete();
    await db.accounts.delete(accountId);
    if (others.length === 0) await db.identities.delete(row.userId);
  });
  if (others.length === 0) ctx.forgetKeys(row.userId);
  await removeFiles(ctx, files);
  void ctx.diag.info('auth', `account removed from this device (server ${row.serverId})`);
}

/** Identity keys from a recovery phrase (for revoking without a device). The phrase is a secret. */
export function keysFromPhrase(phrase: string): IdentityKeys {
  return deriveIdentityKeys(phraseToSeed(phrase));
}
