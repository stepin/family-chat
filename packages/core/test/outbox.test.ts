import { createIdentityEnvelope, deriveIdentityKeys, dmChatId, newSeed, verifyIdentityEnvelope } from '@family-chat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRuntime, joinServer } from '../src/accounts.ts';
import { CoreContext } from '../src/context.ts';
import { isCoreError } from '../src/errors.ts';
import { cancelMessage, checkMessageText, enqueueMessage, retryMessage } from '../src/outbox.ts';
import { LeaseLocks } from '../src/util/locks.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, FAST, makeCtx } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const runtimes: AccountRuntime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop();
});

async function setup(server = new FakeServer()) {
  const ctxA = makeCtx(server);
  const rowA = await joinServer(ctxA, { serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'A' });
  const ctxB = makeCtx(server);
  const rowB = await joinServer(ctxB, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'B' });
  const a = new AccountRuntime(ctxA, rowA);
  runtimes.push(a);
  await a.directory.refresh();
  const chatId = dmChatId(server.serverId, rowA.userId, rowB.userId);
  await ctxA.db.chats.put({ accountId: rowA.id, chatId, kind: 'dm', peerId: rowB.userId, createdAt: 0, last: null, readGseq: 0, unread: 0 });
  return { server, ctx: ctxA, row: rowA, a, rowB, chatId };
}

describe('outbox', () => {
  it('allocates seq and message id with the outbox row', async () => {
    const { ctx, row, a, chatId } = await setup();
    await ctx.db.drafts.put({ accountId: row.id, chatId, text: 'draft', updatedAt: 0 });
    const m1 = await enqueueMessage(a, chatId, 'one');
    const m2 = await enqueueMessage(a, chatId, 'two', { author: row.userId, id: m1 });
    expect(m1).toMatch(/^[a-z2-7]{26}$/);
    const rows = await ctx.db.outbox.toArray();
    expect(rows.map((r) => [r.msgId, r.seq, r.status, r.devId])).toEqual(
      expect.arrayContaining([
        [m1, 1, 'pending', row.devId],
        [m2, 2, 'pending', row.devId],
      ]),
    );
    expect(rows.find((r) => r.msgId === m2)!.reply).toEqual({ author: row.userId, id: m1 });
    expect((await ctx.db.counters.get([row.id, chatId]))!.nextSeq).toBe(3);
    expect(await ctx.db.drafts.count()).toBe(0);
    expect(() => checkMessageText('')).toThrow();
    await expect(enqueueMessage(a, 'nochat', 'x')).rejects.toSatisfy((e) => isCoreError(e, 'unknown-chat'));
  });

  it('sends in order and records server order and time', async () => {
    const { server, ctx, a, chatId, row } = await setup();
    await enqueueMessage(a, chatId, 'one');
    await enqueueMessage(a, chatId, 'two');
    a.outbox.start();
    await eventually(async () => (await ctx.db.outbox.count()) === 0);
    const msgs = (await ctx.db.messages.toArray()).sort((x, y) => x.gseq - y.gseq);
    expect(msgs.map((m) => m.body)).toEqual(['one', 'two']);
    expect(msgs.map((m) => m.gseq)).toEqual(server.log.map((e) => e.gseq));
    expect(msgs[0]!.time).toBe(server.log[0]!.time);
    expect(await ctx.db.events.count()).toBe(2);
    const chat = await ctx.db.chats.get([row.id, chatId]);
    expect(chat!.last!.body).toBe('two');
    expect(chat!.unread).toBe(0);
  });

  it('retries transient errors with the same Idempotency-Key, without duplicates', async () => {
    const { server, ctx, a, chatId } = await setup();
    const keys: string[] = [];
    const fetch = server.fetch;
    const spy = makeCtx({ ...server, fetch: (u: string, init: RequestInit) => {
      if (init.method === 'POST' && u.includes('/events')) keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
      return fetch(u, init);
    } } as unknown as FakeServer, ctx.db);
    const rt = new AccountRuntime(spy, (await ctx.db.accounts.toArray())[0]!);
    runtimes.push(rt);
    const id = await enqueueMessage(rt, chatId, 'hello');
    server.failNext('POST /v1/chats/', 'network');
    server.failNext('POST /v1/chats/', { status: 503, body: { error: 'internal', message: '' } });
    // The server stored the event but the answer was lost: the retry is a duplicate.
    server.failNext('POST /v1/chats/', { status: 500, body: { error: 'internal', message: '' } });
    rt.outbox.start();
    await eventually(async () => (await ctx.db.outbox.count()) === 0, 4000, 'sent');
    expect(keys.every((k) => k === id)).toBe(true);
    expect(keys.length).toBe(4);
    expect(server.log).toHaveLength(1);
    expect(await ctx.db.messages.count()).toBe(1);
  });

  it('permanent errors mark the message failed; retry and cancel', async () => {
    const { server, ctx, a, chatId, row } = await setup();
    server.failNext('POST /v1/chats/', { status: 403, body: { error: 'peer_removed', message: '' } });
    const id = await enqueueMessage(a, chatId, 'x');
    expect(await a.outbox.drain()).toBe(Infinity);
    const failed = await ctx.db.outbox.get([row.id, id]);
    expect(failed).toMatchObject({ status: 'failed', error: 'peer_removed', attempts: 1 });
    // Failed rows are skipped by later passes.
    await a.outbox.drain();
    expect((await ctx.db.outbox.get([row.id, id]))!.status).toBe('failed');
    await retryMessage(a, id);
    expect((await ctx.db.outbox.get([row.id, id]))).toMatchObject({ status: 'pending', attempts: 0, error: null });
    await a.outbox.drain();
    expect(await ctx.db.outbox.count()).toBe(0);

    const id2 = await enqueueMessage(a, chatId, 'y');
    await cancelMessage(a, id2);
    expect(await ctx.db.outbox.count()).toBe(0);
    await expect(retryMessage(a, id2)).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
  });

  it('keeps the order: a message waiting for retry blocks the ones after it', async () => {
    const { server, ctx, a, chatId } = await setup();
    server.offline = true;
    await enqueueMessage(a, chatId, 'first');
    await enqueueMessage(a, chatId, 'second');
    const next = await a.outbox.drain();
    expect(Number.isFinite(next)).toBe(true);
    const rows = await ctx.db.outbox.toArray();
    expect(rows.find((r) => r.body === 'first')!.attempts).toBe(1);
    expect(rows.find((r) => r.body === 'second')!.attempts).toBe(0);
    // Before the retry time nothing is sent.
    server.offline = false;
    expect(await a.outbox.drain()).toBe(next);
    expect(server.log).toHaveLength(0);
  });

  it('stops sending when the account is removed', async () => {
    const { server, ctx, a, chatId, row } = await setup();
    server.removeUser(row.userId);
    await enqueueMessage(a, chatId, 'x');
    expect(await a.outbox.drain()).toBe(Infinity);
    expect((await ctx.db.outbox.toArray())[0]!.status).toBe('pending');
  });

  it('fails a message whose peer is unknown even after a refresh', async () => {
    const { ctx, a, row } = await setup();
    const stranger = deriveIdentityKeys(newSeed());
    verifyIdentityEnvelope(createIdentityEnvelope(stranger));
    const chatId = 'ccccccccccccccccccccccccccc'.slice(0, 26);
    await ctx.db.chats.put({ accountId: row.id, chatId, kind: 'dm', peerId: stranger.userId, createdAt: 0, last: null, readGseq: 0, unread: 0 });
    await enqueueMessage(a, chatId, 'x');
    await a.outbox.drain();
    expect((await ctx.db.outbox.toArray())[0]).toMatchObject({ status: 'failed', error: 'unknown-user' });
  });

  it('one sender at a time across contexts (lease fallback)', async () => {
    const { server, ctx, chatId, row } = await setup();
    let inFlight = 0;
    let maxInFlight = 0;
    const gated = { ...server, fetch: async (u: string, init: RequestInit) => {
      const post = init.method === 'POST' && u.includes('/events');
      if (post) maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        if (post) await new Promise((r) => setTimeout(r, 15));
        return await server.fetch(u, init);
      } finally {
        if (post) inFlight--;
      }
    } } as unknown as FakeServer;
    const mk = () =>
      new AccountRuntime(new CoreContext({ db: ctx.db, fetch: gated.fetch, ...FAST, locks: new LeaseLocks(ctx.db, { now: Date.now, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number) }, { pollMs: 2 }) }), row);
    const t1 = mk();
    const t2 = mk();
    runtimes.push(t1, t2);
    for (let i = 0; i < 4; i++) await enqueueMessage(t1, chatId, `m${i}`);
    t1.outbox.start();
    t2.outbox.start();
    await eventually(async () => (await ctx.db.outbox.count()) === 0, 4000, 'all sent');
    expect(maxInFlight).toBe(1);
    expect(server.log.map((e) => e.msgId)).toHaveLength(4);
    expect(await ctx.db.messages.count()).toBe(4);
  });
});
