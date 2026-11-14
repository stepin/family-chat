import { phraseToSeed, ProtocolError } from '@family-chat/protocol';
import { describe, expect, it } from 'vitest';
import {
  AccountRuntime,
  addDeviceForIdentity,
  createIdentity,
  fetchHello,
  joinServer,
  recoveryPhrase,
  restoreAccount,
  updateProfile,
} from '../src/accounts.ts';
import { isApiError } from '../src/api/errors.ts';
import { isCoreError } from '../src/errors.ts';
import { authenticateDevice } from '../src/session.ts';
import { FakeServer } from './support/fake-server.ts';
import { makeCtx, memDb } from './support/helpers.ts';

const URL_ = 'https://fc.test';

async function admin(server = new FakeServer()) {
  const ctx = makeCtx(server);
  const row = await joinServer(ctx, { serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'Мама' });
  const rt = new AccountRuntime(ctx, row);
  return { server, ctx, row, rt };
}

describe('identity and joining', () => {
  it('creates an identity and shows its phrase', async () => {
    const ctx = makeCtx(new FakeServer());
    const userId = await createIdentity(ctx);
    const phrase = await recoveryPhrase(ctx, userId);
    expect(phrase.split(' ')).toHaveLength(24);
    const stored = await ctx.db.identities.get(userId);
    expect(phraseToSeed(phrase)).toEqual(stored!.seed);
    await expect(recoveryPhrase(ctx, 'nobody')).rejects.toSatisfy((e) => isCoreError(e, 'no-identity'));
    await expect(ctx.keys('nobody')).rejects.toSatisfy((e) => isCoreError(e, 'no-identity'));
  });

  it('joins with the admin code, then with an invitation using an existing identity', async () => {
    const { server, ctx, row } = await admin();
    expect(row).toMatchObject({ admin: true, status: 'active', cursor: 0, initialSyncDone: false, serverUrl: URL_ });
    expect(server.adminCodeActive).toBe(false);
    // The own entry is in the directory at once.
    expect((await ctx.db.users.get([row.id, row.userId]))?.name).toBe('Мама');

    const ctx2 = makeCtx(server);
    const uid = await createIdentity(ctx2);
    const code = server.newInviteCode();
    const row2 = await joinServer(ctx2, { serverUrl: URL_, code: { invite: code }, name: ' Папа ', userId: uid });
    expect(row2.userId).toBe(uid);
    expect(row2.admin).toBe(false);
    expect(server.users.get(uid)!.name).toBe('Папа');
    // Second account for the same server on one device is refused.
    await expect(
      joinServer(ctx2, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'x', userId: uid }),
    ).rejects.toSatisfy((e) => isCoreError(e, 'account-exists'));
  });

  it('maps join errors and stores no identity on failure', async () => {
    const server = new FakeServer();
    const ctx = makeCtx(server);
    await expect(joinServer(ctx, { serverUrl: URL_, code: { adminCode: 'WRONG' }, name: 'x' })).rejects.toSatisfy((e) =>
      isApiError(e, 'invalid_code'),
    );
    await expect(joinServer(ctx, { serverUrl: URL_, code: { invite: 'nope' }, name: 'x' })).rejects.toSatisfy((e) =>
      isApiError(e, 'invalid_invite'),
    );
    await expect(
      joinServer(ctx, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'bad‮name' }),
    ).rejects.toBeInstanceOf(ProtocolError);
    expect(await ctx.db.identities.count()).toBe(0);
    expect(await ctx.db.accounts.count()).toBe(0);
  });

  it('falls back to device login when the identity is already a member', async () => {
    const { server, ctx, row } = await admin();
    const phrase = await recoveryPhrase(ctx, row.userId);
    const ctx2 = makeCtx(server);
    const row2 = await joinServer(ctx2, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'x', phrase });
    expect(row2.userId).toBe(row.userId);
    expect(row2.devId).not.toBe(row.devId);
    expect(await ctx2.db.identities.get(row.userId)).toBeDefined();
  });

  it('restores by phrase on a new device', async () => {
    const { server, ctx, row } = await admin();
    const phrase = await recoveryPhrase(ctx, row.userId);
    const ctx2 = makeCtx(server);
    const restored = await restoreAccount(ctx2, { serverUrl: URL_, phrase: phrase.toUpperCase().replace(/ /g, '\n') });
    expect(restored).toMatchObject({ userId: row.userId, admin: true, cursor: 0 });
    expect(server.users.get(row.userId)!.devices.size).toBe(2);

    // Unknown identity: needs an invitation, and its seed is not kept.
    const stranger = await recoveryPhrase(ctx2, await createIdentity(makeCtx(server, ctx2.db)));
    const ctx3 = makeCtx(server);
    await expect(restoreAccount(ctx3, { serverUrl: URL_, phrase: stranger })).rejects.toSatisfy((e) =>
      isCoreError(e, 'unknown-user'),
    );
    expect(await ctx3.db.identities.count()).toBe(0);
    await expect(restoreAccount(ctx3, { serverUrl: URL_, phrase: 'one two' })).rejects.toMatchObject({
      code: 'phrase-word-count',
    });

    // A removed member cannot add a device.
    server.removeUser(row.userId);
    await expect(restoreAccount(makeCtx(server), { serverUrl: URL_, phrase })).rejects.toSatisfy((e) =>
      isCoreError(e, 'removed'),
    );
  });

  it('adds a device for an identity stored here (another server)', async () => {
    const { ctx, row } = await admin();
    const other = new FakeServer();
    // Make the identity a member of the other server first.
    const ctxOther = makeCtx(other);
    const phrase = await recoveryPhrase(ctx, row.userId);
    await joinServer(ctxOther, { serverUrl: URL_, code: { adminCode: other.adminCode }, name: 'Мама', phrase });
    const ctx2 = makeCtx(other, ctx.db);
    const row2 = await addDeviceForIdentity(ctx2, URL_, row.userId);
    expect(row2.serverId).toBe(other.serverId);
  });

  it('refuses a server with another protocol version', async () => {
    const server = new FakeServer();
    const ctx = makeCtx(server);
    server.failNext('GET /v1/hello', { status: 200, body: { ...(await fetchHello(ctx, URL_)), protocol: 2 } });
    await expect(fetchHello(ctx, URL_)).rejects.toSatisfy((e) => isCoreError(e, 'unsupported-server'));
  });

  it('updates the profile, retrying once on stale_rev', async () => {
    const { server, ctx, row, rt } = await admin();
    await updateProfile(rt, 'Мама Оля');
    expect(server.users.get(row.userId)!.name).toBe('Мама Оля');
    expect((await ctx.db.users.get([row.id, row.userId]))!.rev).toBe(2);
    // Another device moved the revision ahead.
    server.users.get(row.userId)!.rev = 10;
    await updateProfile(rt, 'Оля');
    expect(server.users.get(row.userId)!.rev).toBe(11);
    expect((await ctx.db.users.get([row.id, row.userId]))!.name).toBe('Оля');
    await expect(updateProfile(rt, '')).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('session', () => {
  it('logs in again on 401 and repeats the request', async () => {
    const { server, ctx, row, rt } = await admin();
    server.revokeTokens(row.userId);
    const users = await rt.session.call((t) => rt.session.transport.users(t));
    expect(users).toHaveLength(1);
    const fresh = await ctx.db.accounts.get(row.id);
    expect(fresh!.token).not.toBe(row.token);
    expect(server.requests.filter((r) => r === 'POST /v1/auth/device')).toHaveLength(1);
  });

  it('retries once on bad_nonce', async () => {
    const { server, rt, row } = await admin();
    server.revokeTokens(row.userId);
    server.failNext('POST /v1/auth/device', { status: 401, body: { error: 'bad_nonce', message: '' } });
    await rt.session.call((t) => rt.session.transport.me(t));
    expect(server.requests.filter((r) => r === 'POST /v1/auth/challenge')).toHaveLength(2);
  });

  it('two bad nonces in a row make the login invalid', async () => {
    const { server, rt, row, ctx } = await admin();
    server.revokeTokens(row.userId);
    server.failNext('POST /v1/auth/device', { status: 401, body: { error: 'bad_nonce', message: '' } }, 2);
    await expect(rt.session.call((t) => rt.session.transport.me(t))).rejects.toSatisfy((e) =>
      isCoreError(e, 'login-invalid'),
    );
    expect(rt.session.status.get()).toBe('login-invalid');
    expect((await ctx.db.accounts.get(row.id))!.status).toBe('login-invalid');
    // Calls fail fast without the network until an explicit relogin.
    const before = server.requests.length;
    await expect(rt.session.call((t) => rt.session.transport.me(t))).rejects.toSatisfy((e) =>
      isCoreError(e, 'login-invalid'),
    );
    expect(server.requests.length).toBe(before);
    await rt.session.relogin();
    expect(rt.session.status.get()).toBe('active');
    await rt.session.call((t) => rt.session.transport.me(t));
  });

  it('unknown_user on re-login is login-invalid; transient errors propagate as they are', async () => {
    const { server, rt, row } = await admin();
    server.revokeTokens(row.userId);
    server.failNext('POST /v1/auth/challenge', 'network');
    await expect(rt.session.call((t) => rt.session.transport.me(t))).rejects.toMatchObject({ name: 'NetworkError' });
    expect(rt.session.status.get()).toBe('active');
    server.users.delete(row.userId);
    await expect(rt.session.call((t) => rt.session.transport.me(t))).rejects.toSatisfy((e) =>
      isCoreError(e, 'login-invalid'),
    );
  });

  it('403 removed switches to removed, also during re-login', async () => {
    const { server, rt, row, ctx } = await admin();
    server.removeUser(row.userId);
    await expect(rt.session.call((t) => rt.session.transport.me(t))).rejects.toSatisfy((e) => isCoreError(e, 'removed'));
    expect(rt.session.status.get()).toBe('removed');
    expect((await ctx.db.accounts.get(row.id))!.status).toBe('removed');
    await expect(rt.session.relogin()).rejects.toSatisfy((e) => isCoreError(e, 'removed'));

    const b = await admin();
    b.server.revokeTokens(b.row.userId);
    b.server.removeUser(b.row.userId);
    await expect(b.rt.session.call((t) => b.rt.session.transport.me(t))).rejects.toSatisfy((e) =>
      isCoreError(e, 'removed'),
    );
  });

  it('uses a token another tab already refreshed instead of logging in again', async () => {
    const { server, ctx, row } = await admin();
    const tabA = new AccountRuntime(ctx, row);
    const tabB = new AccountRuntime(ctx, row);
    server.revokeTokens(row.userId);
    await Promise.all([
      tabA.session.call((t) => tabA.session.transport.me(t)),
      tabB.session.call((t) => tabB.session.transport.me(t)),
    ]);
    // One context logged in; the other picked up its token from the database.
    expect(server.requests.filter((r) => r === 'POST /v1/auth/device')).toHaveLength(1);
  });

  it('authenticateDevice checks what the server issued', async () => {
    const { server, ctx, row } = await admin();
    const keys = await ctx.keys(row.userId);
    const t = ctx.transport(URL_);
    server.failNext('POST /v1/auth/device', { status: 200, body: { token: 'x', userId: 'other', devId: row.devId, admin: false } });
    await expect(authenticateDevice(t, keys, server.serverId, row.devId)).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('fails with no-account when the account row is gone', async () => {
    const { ctx, row, rt } = await admin();
    await ctx.db.accounts.delete(row.id);
    await expect(rt.session.call(async () => 1)).rejects.toSatisfy((e) => isCoreError(e, 'no-account'));
    void memDb;
  });
});
