// Identity and accounts: create an identity, join a server (invitation or
// administrator code), restore by the 24-word phrase on a new device, update
// the own profile. Plus the per-account runtime that ties session, directory,
// sync engine and outbox together.

import {
  base32Encode,
  createIdentityEnvelope,
  createProfileEnvelope,
  deriveIdentityKeys,
  newDevId,
  newSeed,
  phraseToSeed,
  randomBytes,
  seedToPhrase,
  type IdentityKeys,
} from '@family-chat/protocol';
import { isApiError } from './api/errors.ts';
import { normalizeServerUrl, type Transport } from './api/transport.ts';
import type { Hello, IssuedToken, JoinCode } from './api/types.ts';
import type { AccountRuntimeLike } from './apply.ts';
import type { CoreContext } from './context.ts';
import type { AccountRow } from './db/schema.ts';
import { Directory } from './directory.ts';
import { CoreError } from './errors.ts';
import { OutboxSender } from './outbox.ts';
import { authenticateDevice, Session } from './session.ts';
import { SyncEngine } from './sync.ts';

export const SUPPORTED_PROTOCOL = 1;

export class AccountRuntime implements AccountRuntimeLike {
  readonly session: Session;
  readonly directory: Directory;
  readonly sync: SyncEngine;
  readonly outbox: OutboxSender;
  #started = false;

  constructor(
    readonly ctx: CoreContext,
    account: AccountRow,
  ) {
    this.session = new Session(ctx, account);
    this.directory = new Directory(ctx, this.session);
    this.outbox = new OutboxSender(this);
    this.sync = new SyncEngine(this, { onConnected: () => this.outbox.kick() });
  }

  get accountId(): string {
    return this.session.accountId;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.sync.start();
    this.outbox.start();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await Promise.all([this.sync.stop(), this.outbox.stop()]);
  }
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

/** Signs and uploads a new profile (rev = stored + 1; one retry on 409 stale_rev). */
export async function updateProfile(rt: AccountRuntime, name: string): Promise<void> {
  const { ctx, session, directory } = rt;
  const keys = await ctx.keys(session.userId);
  let me = await directory.user(session.userId);
  if (!me) {
    await directory.refresh();
    me = await directory.user(session.userId);
    if (!me) throw new CoreError('unknown-user');
  }
  let rev = Math.max(me.rev, 0) + 1;
  for (let attempt = 0; ; attempt++) {
    const env = createProfileEnvelope(keys, { name, rev, updated: ctx.clock.now() });
    try {
      const stored = await session.call((t) => session.transport.putProfile(t, env));
      await directory.ingest([
        { userId: me.userId, identity: me.identity, profile: stored, admin: me.admin, removed: me.removed },
      ]);
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
