import {
  createIdentityEnvelope,
  deriveDmKeys,
  deriveIdentityKeys,
  dmChatId,
  encodeEvent,
  encodeMsgPayload,
  newDevId,
  newMessageId,
  newSeed,
  verifyIdentityEnvelope,
} from '@family-chat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRuntime, joinServer } from '../src/accounts.ts';
import type { CoreContext } from '../src/context.ts';
import type { AccountRow } from '../src/db/schema.ts';
import { until } from '../src/util/readable.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, makeCtx } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const runtimes: AccountRuntime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop();
});

interface Member {
  ctx: CoreContext;
  row: AccountRow;
  rt: AccountRuntime;
}

async function pair(server = new FakeServer()): Promise<{ server: FakeServer; a: Member; b: Member; chatId: string }> {
  const ctxA = makeCtx(server);
  const rowA = await joinServer(ctxA, { serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'A' });
  const ctxB = makeCtx(server);
  const rowB = await joinServer(ctxB, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'B' });
  const a = { ctx: ctxA, row: rowA, rt: new AccountRuntime(ctxA, rowA) };
  const b = { ctx: ctxB, row: rowB, rt: new AccountRuntime(ctxB, rowB) };
  runtimes.push(a.rt, b.rt);
  return { server, a, b, chatId: dmChatId(server.serverId, rowA.userId, rowB.userId) };
}

/** Encrypts a message from `m` to `peerId` as the protocol requires. */
async function encodeFrom(m: Member, server: FakeServer, peerId: string, opts: { seq: number; body?: string; msgId?: string; dev?: string }) {
  const me = await m.ctx.keys(m.row.userId);
  const peer = verifyIdentityEnvelope(server.users.get(peerId)!.identity.envelope);
  const chatId = dmChatId(server.serverId, m.row.userId, peerId);
  const keys = deriveDmKeys(me, peer, server.serverId);
  const msgId = opts.msgId ?? newMessageId();
  const payload = encodeMsgPayload({ id: msgId, dev: opts.dev ?? m.row.devId, seq: opts.seq, body: opts.body ?? 'x' });
  const body = await encodeEvent({ serverId: server.serverId, chatId, chat: keys, author: me, payload });
  return { chatId, msgId, body };
}

describe('sync engine', () => {
  it('first sync pages through everything with wait=0, then long-polls', async () => {
    const { server, a, b, chatId } = await pair();
    for (let i = 1; i <= 7; i++) {
      const e = await encodeFrom(a, server, b.row.userId, { seq: i, body: `m${i}` });
      server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e.msgId, body: e.body });
    }
    // Small pages to force `more`.
    const urls: string[] = [];
    const ctx = makeCtx(
      {
        ...server,
        fetch: (u: string, init: RequestInit) => {
          urls.push(u);
          return server.fetch(u.includes('/v1/events') ? u.replace('limit=500', 'limit=3') : u, init);
        },
      } as unknown as FakeServer,
      b.ctx.db,
    );
    const rt = new AccountRuntime(ctx, b.row);
    runtimes.push(rt);
    rt.start();
    await eventually(async () => (await ctx.db.accounts.get(b.row.id))?.initialSyncDone, 4000, 'initial sync');
    expect(await ctx.db.messages.count()).toBe(7);
    const ev = urls.filter((u) => u.includes('/v1/events'));
    expect(ev[0]).toContain('after=0');
    expect(ev.slice(0, 3).every((u) => !u.includes('wait='))).toBe(true);
    await eventually(() => urls.some((u) => u.includes('wait=25')), 2000, 'long poll');
    expect((await ctx.db.accounts.get(b.row.id))!.cursor).toBe(server.nextGseq - 1);
    expect(rt.sync.state.get().kind).toBe('connected');
  });

  it('skips events that fail verification and records them', async () => {
    const { server, a, b, chatId } = await pair();
    const good = await encodeFrom(a, server, b.row.userId, { seq: 1, body: 'ok' });
    const forged = await encodeFrom(a, server, b.row.userId, { seq: 2, body: 'forged' });
    forged.body[forged.body.length - 1]! ^= 1; // broken tag
    // An event signed by a third person who is not a member of the chat.
    const evil = deriveIdentityKeys(newSeed());
    server.users.set(evil.userId, {
      identity: verifyIdentityEnvelope(createIdentityEnvelope(evil)),
      profile: server.users.get(a.row.userId)!.profile,
      rev: 1,
      name: 'Evil',
      admin: false,
      removed: false,
      removedAt: null,
      devices: new Map(),
    });
    // Encrypted with the real chat key (as a leaked key would allow), signed by the outsider.
    const keys = deriveDmKeys(
      await a.ctx.keys(a.row.userId),
      verifyIdentityEnvelope(server.users.get(b.row.userId)!.identity.envelope),
      server.serverId,
    );
    const evilId = newMessageId();
    const evilBody = await encodeEvent({
      serverId: server.serverId,
      chatId,
      chat: keys,
      author: evil,
      payload: encodeMsgPayload({ id: evilId, dev: newDevId(), seq: 1, body: 'evil' }),
    });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: forged.msgId, body: forged.body });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: evilId, body: evilBody });
    // Server-reported msgId differs from the signed one.
    const other = await encodeFrom(a, server, b.row.userId, { seq: 3 });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: newMessageId(), body: other.body });
    // Event in a chat nobody can resolve.
    server.chats.set('zzzzzzzzzzzzzzzzzzzzzzzzzz', { members: [a.row.userId, b.row.userId].sort() as [string, string], createdAt: 0 });
    server.appendRaw({ chatId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz', senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: newMessageId(), body: good.body });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: good.msgId, body: good.body });

    expect(await b.rt.sync.syncOnce()).toBe(false);
    const msgs = await b.ctx.db.messages.toArray();
    expect(msgs.map((m) => m.body)).toEqual(['ok']);
    expect((await b.ctx.db.accounts.get(b.row.id))!.cursor).toBe(server.nextGseq - 1);
    await b.ctx.diag.flush();
    const diag = (await b.ctx.db.diagnostics.toArray()).map((d) => d.message).join('\n');
    expect(diag).toContain('rejected: protocol wrong-key');
    expect(diag).toContain('rejected: protocol unknown-author');
    expect(diag).toContain("message id differs from the server's");
    expect(diag).toContain('unknown chat');
    expect(diag).not.toContain('forged');
    expect(diag).not.toContain('evil');
  });

  it('deduplicates by (sender, message id) and reports seq gaps', async () => {
    const { server, a, b, chatId } = await pair();
    const e1 = await encodeFrom(a, server, b.row.userId, { seq: 1, body: 'one' });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e1.msgId, body: e1.body });
    // The same message again (for example a replayed body).
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e1.msgId, body: e1.body });
    const e4 = await encodeFrom(a, server, b.row.userId, { seq: 4, body: 'four' });
    server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e4.msgId, body: e4.body });
    await b.rt.sync.syncOnce();
    expect((await b.ctx.db.messages.toArray()).map((m) => m.body).sort()).toEqual(['four', 'one']);
    const chat = await b.ctx.db.chats.get([b.row.id, chatId]);
    expect(chat).toMatchObject({ unread: 2, peerId: a.row.userId });
    expect(chat!.last!.body).toBe('four');
    await b.ctx.diag.flush();
    const gaps = await b.ctx.db.diagnostics.filter((d) => d.kind === 'gap').toArray();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.message).toContain('2 event(s) missing');
    expect(gaps[0]!.message).toContain('seq 2..3');
  });

  it('records a retention gap and replaces the cursor even when it goes back', async () => {
    const { server, a, b, chatId } = await pair();
    for (let i = 1; i <= 3; i++) {
      const e = await encodeFrom(a, server, b.row.userId, { seq: i, body: `m${i}` });
      server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e.msgId, body: e.body });
    }
    await b.rt.sync.syncOnce();
    const cursor = (await b.ctx.db.accounts.get(b.row.id))!.cursor;
    expect(cursor).toBe(3);
    // More events; the device is offline while retention deletes some of them.
    for (let i = 4; i <= 6; i++) {
      const e = await encodeFrom(a, server, b.row.userId, { seq: i, body: `m${i}` });
      server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e.msgId, body: e.body });
    }
    server.expireBefore(6);
    await b.rt.sync.syncOnce();
    const acc = (await b.ctx.db.accounts.get(b.row.id))!;
    expect(acc.retentionGap).toMatchObject({ after: 3, oldestGseq: 6, firstSync: false });
    expect(acc.retentionGap!.firstTime).not.toBeNull();
    expect(acc.cursor).toBe(6);

    // The server was restored from an old backup: its cursor is lower. Always take it.
    server.nextGseq = 2;
    server.log.length = 0;
    server.oldestGseq = 2;
    await b.rt.sync.syncOnce();
    expect((await b.ctx.db.accounts.get(b.row.id))!.cursor).toBe(1);
    await b.ctx.diag.flush();
    expect((await b.ctx.db.diagnostics.toArray()).some((d) => d.message.includes('cursor went back from 6 to 1'))).toBe(true);
  });

  it('a retention gap on the first sync of a new device is marked as such', async () => {
    const { server, a, b, chatId } = await pair();
    for (let i = 1; i <= 3; i++) {
      const e = await encodeFrom(a, server, b.row.userId, { seq: i });
      server.appendRaw({ chatId, senderId: a.row.userId, devId: a.row.devId, epoch: 0, msgId: e.msgId, body: e.body });
    }
    server.expireBefore(3);
    await b.rt.sync.syncOnce();
    expect((await b.ctx.db.accounts.get(b.row.id))!.retentionGap).toMatchObject({ after: 0, oldestGseq: 3, firstSync: true });
  });

  it('reports offline since the first failure, backs off, recovers', async () => {
    const { server, b } = await pair();
    server.offline = true;
    b.rt.start();
    const off = await until(b.rt.sync.state, (s) => s.kind === 'offline');
    const since = (off as { since: number }).since;
    await eventually(() => server.requests.length > 0);
    await new Promise((r) => setTimeout(r, 60));
    const s2 = b.rt.sync.state.get();
    expect(s2.kind === 'offline' && s2.since).toBe(since);
    server.offline = false;
    await until(b.rt.sync.state, (s) => s.kind === 'connected');
  });

  it('honours Retry-After and logs non-transient errors', async () => {
    const { server, b } = await pair();
    server.failNext('GET /v1/events', { status: 400, body: { error: 'bad_request', message: '' } });
    b.rt.start();
    await until(b.rt.sync.state, (s) => s.kind === 'connected');
    await b.ctx.diag.flush();
    expect((await b.ctx.db.diagnostics.toArray()).some((d) => d.message.includes('events request failed: 400 bad_request'))).toBe(true);
  });

  it('stops in the removed state', async () => {
    const { server, b } = await pair();
    b.rt.start();
    await until(b.rt.sync.state, (s) => s.kind === 'connected');
    server.removeUser(b.row.userId);
    await until(b.rt.sync.state, (s) => s.kind === 'removed');
    expect((await b.ctx.db.accounts.get(b.row.id))!.status).toBe('removed');
    await b.rt.stop();
    expect(b.rt.sync.state.get().kind).toBe('stopped');
  });

  it('waits in login-invalid until kicked after a successful relogin', async () => {
    const { server, b } = await pair();
    server.revokeTokens(b.row.userId);
    server.failNext('POST /v1/auth/device', { status: 401, body: { error: 'bad_signature', message: '' } });
    b.rt.start();
    await until(b.rt.sync.state, (s) => s.kind === 'login-invalid');
    await b.rt.session.relogin();
    b.rt.sync.kick();
    await until(b.rt.sync.state, (s) => s.kind === 'connected');
  });

  it('a kick aborts the pending long poll and polls again at once', async () => {
    const { server, b } = await pair(new FakeServer({ msPerSecond: 1000 }));
    b.rt.start();
    await until(b.rt.sync.state, (s) => s.kind === 'connected');
    await eventually(() => server.requests.filter((r) => r === 'GET /v1/events').length >= 2);
    const n = server.requests.length;
    b.rt.sync.kick();
    await eventually(() => server.requests.length > n, 1000, 'new poll after kick');
  });
});
