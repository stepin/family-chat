import { afterEach, describe, expect, it } from 'vitest';
import type { FamilyChatCore } from '../src/core.ts';
import type { ChatSummary } from '../src/views.ts';
import { isCoreError } from '../src/errors.ts';
import { SETTING_PUSH_SHOW_TEXT } from '../src/push.ts';
import { until } from '../src/util/readable.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, family, makeCore } from './support/helpers.ts';

const cores: FamilyChatCore[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(server = new FakeServer()) {
  const f = await family(server);
  cores.push(f.a, f.b);
  return { server, ...f };
}

describe('facade', () => {
  it('two members exchange messages through the long poll', async () => {
    const { a, b, accA, accB } = await setup();
    const chatA = await a.openChat(accA.id, accB.userId);
    const chatB = await b.openChat(accB.id, accA.userId);
    expect(chatA).toBe(chatB);

    const viewA = a.chat(accA.id, chatA);
    const viewB = b.chat(accB.id, chatB);
    const unsubA = viewA.messages.subscribe(() => {});
    const unsubB = viewB.messages.subscribe(() => {});

    await a.send(accA.id, chatA, 'Привет!');
    const got = await until(viewB.messages, (m) => m.length === 1);
    expect(got[0]).toMatchObject({ body: 'Привет!', outgoing: false, status: 'on-server', senderId: accA.userId });
    expect(got[0]!.gseq).toBeGreaterThan(0);

    await b.send(accB.id, chatB, 'И тебе');
    const back = await until(viewA.messages, (m) => m.length === 2 && m.every((x) => x.status === 'on-server'));
    expect(back.map((m) => m.body)).toEqual(['Привет!', 'И тебе']);
    expect(back[0]!.outgoing).toBe(true);
    expect(back[1]!.outgoing).toBe(false);

    // Chat list with last message and unread counter.
    const dmOf = (l: readonly ChatSummary[]) => l.filter((c) => c.kind === 'dm');
    const list = dmOf(await until(b.chatList, (l) => dmOf(l).length === 1 && dmOf(l)[0]!.lastMessage?.body === 'И тебе'));
    expect(list[0]).toMatchObject({ unread: 1, title: 'Мама', peerId: accA.userId, pending: 0 });
    await viewB.markRead();
    await until(b.chatList, (l) => dmOf(l)[0]!.unread === 0);

    // Connection state.
    expect(a.connection.get()[accA.id]?.kind).toBe('connected');
    unsubA();
    unsubB();
  });

  it('shows outbox statuses and drafts', async () => {
    const { a, accA, accB, server } = await setup();
    const chat = await a.openChat(accA.id, accB.userId);
    await a.setDraft(accA.id, chat, 'черновик');
    expect(await a.getDraft(accA.id, chat)).toBe('черновик');
    await until(a.drafts, (d) => d.length === 1 && d[0]!.text === 'черновик');
    await until(a.chatList, (l) => l.some((c) => c.draft === 'черновик'));

    server.offline = true;
    const view = a.chat(accA.id, chat);
    const unsub = view.messages.subscribe(() => {});
    await a.send(accA.id, chat, 'в очереди');
    // Sending clears the draft in the same transaction.
    expect(await a.getDraft(accA.id, chat)).toBe('');
    const pending = await until(view.messages, (m) => m.length === 1);
    expect(pending[0]).toMatchObject({ status: 'on-device', gseq: null, time: null, outgoing: true });
    await until(a.outbox, (o) => o.length === 1 && o[0]!.status === 'on-device');
    await until(a.connection, (c) => c[accA.id]?.kind === 'offline');

    server.offline = false;
    a.wake();
    const sent = await until(view.messages, (m) => m.length === 1 && m[0]!.status === 'on-server');
    expect(sent[0]!.gseq).not.toBeNull();
    await until(a.outbox, (o) => o.length === 0);
    await a.setDraft(accA.id, chat, '');
    expect(await a.getDraft(accA.id, chat)).toBe('');
    unsub();
  });

  // About 0.6 s alone, but 60 sends plus a full restore: on a loaded machine
  // (several test runs at once) it took over the default 5 s. The budget
  // matches its own `eventually` waits (8 s each).
  it('pages backwards through local messages and the server history', { timeout: 20_000 }, async () => {
    const server = new FakeServer();
    const { a, accA, accB } = await setup(server);
    const chat = await a.openChat(accA.id, accB.userId);
    for (let i = 0; i < 60; i++) await a.send(accA.id, chat, `m${i}`);
    await eventually(async () => (await a.db.messages.count()) === 60, 8000, '60 messages sent');

    // A fresh device of A restores from its phrase: no local history yet.
    const phrase = await a.recoveryPhrase(accA.userId);
    const a2 = makeCore(server);
    cores.push(a2);
    await a2.start();
    const acc2 = await a2.restore({ serverUrl: 'https://fc.test', phrase });
    await eventually(async () => (await a2.db.messages.count()) === 60, 8000, 'history synced');

    const view = a2.chat(acc2.id, chat);
    const unsub = view.messages.subscribe(() => {});
    const first = await until(view.messages, (m) => m.length === 50);
    expect(first[49]!.body).toBe('m59');
    expect(await view.loadOlder()).toBe(true);
    const all = await until(view.messages, (m) => m.length === 60);
    expect(all[0]!.body).toBe('m0');
    // Nothing older locally or on the server.
    expect(await view.loadOlder()).toBe(false);
    unsub();
  });

  it('loads older messages from the server when the local database has none', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await setup(server);
    const chat = await a.openChat(accA.id, accB.userId);
    await b.stop(); // B does not sync: its database stays empty
    for (let i = 0; i < 3; i++) await a.send(accA.id, chat, `h${i}`);
    await eventually(async () => (await a.db.messages.count()) === 3);
    const view = b.chat(accB.id, chat);
    const unsub = view.messages.subscribe(() => {});
    expect(await view.loadOlder()).toBe(true);
    const msgs = await until(view.messages, (m) => m.length === 3);
    expect(msgs.map((m) => m.body)).toEqual(['h0', 'h1', 'h2']);
    expect(await view.loadOlder()).toBe(false);
    unsub();
  });

  it('server check for administrators', async () => {
    const { a, b, accA, accB } = await setup();
    const check = a.serverCheck(accA.id);
    const w = await check.wait(0);
    expect(w.seconds).toBe(0);
    await expect(b.serverCheck(accB.id).wait(0)).rejects.toMatchObject({ code: 'not_admin', status: 403 });
    // No subscription on this device yet.
    expect(await check.lastPush()).toBeNull();
    await expect(check.push(0)).rejects.toMatchObject({ code: 'no_subscription', status: 409 });
    await a.push.register(accA.id, { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(await check.push(0)).toMatchObject({ sent: true });
    expect(await check.push(30)).toMatchObject({ scheduled: true });
    expect((await check.lastPush())?.result).toBe('sent');
  });

  it('lists members with fingerprints and chat ids', async () => {
    const { a, accA, accB } = await setup();
    const members = await until(a.members(accA.id), (m) => m.length === 2);
    const me = members.find((m) => m.isMe)!;
    const peer = members.find((m) => !m.isMe)!;
    expect(me).toMatchObject({ userId: accA.userId, name: 'Мама', admin: true, chatId: null });
    expect(peer).toMatchObject({ userId: accB.userId, name: 'Папа', admin: false, keyChanged: false });
    expect(peer.fingerprint).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(peer.chatId).toMatch(/^[a-z2-7]{26}$/);
  });

  it('admin functions', async () => {
    const { a, b, accA, accB } = await setup();
    const inv = await a.admin.createInvite(accA.id);
    expect(inv.link).toBe(`https://fc.test/#invite=${inv.code}`);
    const list = await a.admin.listInvites(accA.id);
    expect(list.some((i) => i.id === inv.id)).toBe(true);
    await a.admin.revokeInvite(accA.id, inv.id);
    expect((await a.admin.listInvites(accA.id)).some((i) => i.id === inv.id)).toBe(false);
    const users = await a.admin.listUsers(accA.id);
    expect(users.map((u) => u.name).sort()).toEqual(['Мама', 'Папа']);
    const stats = await a.admin.stats(accA.id);
    expect(stats.users).toBe(2);
    await expect(b.admin.stats(accB.id)).rejects.toMatchObject({ code: 'not_admin', status: 403 });

    await a.admin.removeUser(accA.id, accB.userId);
    await until(b.connection, (c) => c[accB.id]?.kind === 'removed');
    await until(b.accounts, (l) => l[0]?.status === 'removed');
    const members = await until(a.members(accA.id), (m) => m.some((x) => x.userId === accB.userId && x.removed));
    expect(members.length).toBe(2);
  });

  it('settings, diagnostics report, push registration and handling', async () => {
    const { a, b, accA, accB } = await setup();
    expect(await a.getSetting('x')).toBeUndefined();
    await a.setSetting('x', { y: 1 });
    expect(await a.getSetting('x')).toEqual({ y: 1 });

    expect(await b.push.vapidPublicKey(accB.id)).toBe('BOrfake');
    await b.push.register(accB.id, { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } });
    await until(b.accounts, (l) => l[0]?.pushRegistered === true);
    await b.push.unregister(accB.id);
    await until(b.accounts, (l) => l[0]?.pushRegistered === false);

    const chat = await a.openChat(accA.id, accB.userId);
    await b.stop();
    await a.send(accA.id, chat, 'секретный текст');
    const sent = await eventually(async () => (await a.db.messages.toArray())[0]);

    const generic = await b.handlePush({ chatId: chat, gseq: sent.gseq });
    expect(generic).toMatchObject({ kind: 'message', senderName: 'Мама', text: null, chatId: chat });
    await b.setSetting(SETTING_PUSH_SHOW_TEXT, true);
    expect(await b.handlePush(JSON.stringify({ chatId: chat, gseq: sent.gseq }))).toMatchObject({
      kind: 'message',
      text: 'секретный текст',
    });
    expect(await b.handlePush({ nope: 1 })).toMatchObject({ kind: 'generic', chatId: null });
    expect(await b.handlePush({ chatId: chat, gseq: 999 })).toMatchObject({ kind: 'generic', chatId: chat });

    const report = await a.diagnosticsReport();
    expect(report).toContain('POST /v1/chats/{chatId}/events 200');
    expect(report).not.toContain('секретный');
    // Background loops (sync, groups) would log new exchanges meanwhile.
    await a.stop();
    await a.clearDiagnostics();
    expect(await a.diagnosticsReport()).toBe('');
  });

  it('rejects bad input', async () => {
    const { a, accA, accB } = await setup();
    const chat = await a.openChat(accA.id, accB.userId);
    await expect(a.send(accA.id, chat, '   ')).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(a.send(accA.id, chat, 'я'.repeat(9000))).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(a.send(accA.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'x')).rejects.toSatisfy((e) => isCoreError(e, 'unknown-chat'));
    // The chat with oneself exists ("Избранное").
    expect(await a.openChat(accA.id, accA.userId)).toBe(accA.selfChatId);
    await expect(a.openChat(accA.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toSatisfy((e) => isCoreError(e, 'unknown-user'));
    await expect(a.relogin('nope')).rejects.toSatisfy((e) => isCoreError(e, 'no-account'));
    await expect(a.retry(accA.id, 'nope')).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(a.cancel(accA.id, 'nope')).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
  });

  it('identity, relogin, profile, key change and lifecycle through the facade', async () => {
    const server = new FakeServer();
    const x = makeCore(server);
    cores.push(x);
    await x.start();
    const uid = await x.createIdentity();
    expect(await x.identities()).toEqual([uid]);
    const acc = await x.join({ serverUrl: 'https://fc.test', code: { adminCode: server.adminCode }, name: 'Я', userId: uid });
    expect(acc.userId).toBe(uid);
    expect((await x.serverInfo('fc.test')).familyName).toBe('Семья');

    // Same identity on a second server.
    const other = new FakeServer();
    const ctxFetch: typeof fetch = ((u: string, init: RequestInit) =>
      (u.startsWith('https://two.test') ? other.fetch : server.fetch)(u, init)) as typeof fetch;
    const y = makeCore(server, { fetch: ctxFetch });
    cores.push(y);
    await y.start();
    const phrase = await x.recoveryPhrase(uid);
    await y.join({ serverUrl: 'https://two.test', code: { adminCode: other.adminCode }, name: 'Я', phrase });
    const z = makeCore(server, { fetch: ctxFetch, db: y.db });
    // y's database already has the identity and the account for two.test; add fc.test too.
    const accZ = await z.addDevice('https://fc.test', uid);
    expect(accZ.serverId).toBe(server.serverId);

    await x.updateProfile(acc.id, 'Новое имя');
    expect(server.users.get(uid)!.name).toBe('Новое имя');

    // Login invalid, then "log in again".
    server.revokeTokens(uid);
    server.failNext('POST /v1/auth/device', { status: 401, body: { error: 'bad_signature', message: '' } });
    x.wake();
    await until(x.connection, (c) => c[acc.id]?.kind === 'login-invalid');
    await until(x.accounts, (l) => l[0]?.status === 'login-invalid');
    await x.relogin(acc.id);
    await until(x.connection, (c) => c[acc.id]?.kind === 'connected');

    await x.acceptKeyChange(acc.id, uid); // nothing pending: no-op
    await x.stop();
    await x.start();
    await until(x.connection, (c) => c[acc.id]?.kind === 'connected');
    await x.close();
    cores.splice(cores.indexOf(x), 1);
    await expect(x.openChat(acc.id, uid)).rejects.toSatisfy((e) => isCoreError(e, 'closed'));
    await expect(x.start()).rejects.toSatisfy((e) => isCoreError(e, 'closed'));
  });

  it('start refuses a database from a newer client', async () => {
    const { Dexie } = await import('dexie');
    const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
    const { CoreDb, DbVersionError } = await import('../src/db/schema.ts');
    const factory = new IDBFactory();
    const newer = new Dexie('fc-newer', { indexedDB: factory, IDBKeyRange });
    newer.version(9).stores({ accounts: 'id' });
    await newer.open();
    newer.close();
    const x = makeCore(new FakeServer(), { db: new CoreDb('fc-newer', { indexedDB: factory, IDBKeyRange }) });
    await expect(x.start()).rejects.toBeInstanceOf(DbVersionError);
  });
});
