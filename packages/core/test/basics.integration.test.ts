// The core against a real fcd process. This is where the TypeScript crypto
// (packages/protocol) first meets the Rust server: join and device-auth
// envelopes, direct chat ids and encrypted events must all be accepted.

import { dmChatId } from '@family-chat/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isApiError } from '../src/api/errors.ts';
import { Transport } from '../src/api/transport.ts';
import { createCore, type AccountView, type FamilyChatCore } from '../src/core.ts';
import { authenticateDevice } from '../src/session.ts';
import { CoreContext } from '../src/context.ts';
import { until } from '../src/util/readable.ts';
import { Fcd } from './integration/fcd.ts';
import { eventually, FAST, memDb } from './support/helpers.ts';

const fcd = new Fcd();
const cores: FamilyChatCore[] = [];

function core(): FamilyChatCore {
  const c = createCore({ db: memDb(), ...FAST });
  cores.push(c);
  return c;
}

async function messagesOf(c: FamilyChatCore, accountId: string, chatId: string): Promise<string[]> {
  const rows = await c.db.messages.where('[accountId+chatId+gseq]').between([accountId, chatId, 0], [accountId, chatId, Infinity]).toArray();
  return rows.map((m) => m.body);
}

let a: FamilyChatCore;
let b: FamilyChatCore;
let c: FamilyChatCore;
let accA: AccountView;
let accB: AccountView;
let accC: AccountView;
let chatAB: string;
const secrets: string[] = [];

beforeAll(async () => {
  await fcd.start();
});

afterAll(async () => {
  for (const x of cores.splice(0)) await x.close().catch(() => undefined);
  await fcd.dispose();
});

describe('core against fcd', () => {
  it('admin sets up the family with the server code; a second member joins by invitation', async () => {
    expect(fcd.adminCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    secrets.push(fcd.adminCode);
    a = core();
    b = core();
    await a.start();
    await b.start();
    const hello = await a.serverInfo(fcd.url);
    expect(hello).toMatchObject({ protocol: 1, familyName: 'Тест', rootSetUp: false, push: false });

    accA = await a.setUpFamily({ serverUrl: fcd.url, serverCode: fcd.adminCode.toLowerCase(), name: 'Мама' });
    expect(accA.admin).toBe(true);
    expect(accA.familyUrl).toBe(fcd.url);
    expect(await a.serverInfo(fcd.url)).toMatchObject({ adminCodeActive: false, rootSetUp: true });

    const inv = await a.admin.createInvite(accA.id);
    expect(inv.link).toBe(`${fcd.url}/#invite=${inv.code}`);
    secrets.push(inv.code, inv.link);
    accB = await b.join({ serverUrl: fcd.url, code: { invite: inv.code }, name: 'Папа' });
    expect(accB.admin).toBe(false);
    // The used invitation cannot be used again.
    const other = core();
    await expect(other.join({ serverUrl: fcd.url, code: { invite: inv.code }, name: 'X' })).rejects.toSatisfy((e) =>
      isApiError(e, 'invite_used'),
    );
    const invites = await a.admin.listInvites(accA.id);
    expect(invites.find((i) => i.id === inv.id)?.usedBy).toBe(accB.userId);

    for (const x of [a, b]) {
      const row = (await x.db.accounts.toArray())[0]!;
      secrets.push(row.token, await x.recoveryPhrase(row.userId));
    }
  });

  it('both exchange messages and receive them through the long poll', async () => {
    await a.refreshMembers(accA.id);
    chatAB = await a.openChat(accA.id, accB.userId);
    expect(chatAB).toBe(dmChatId(accA.serverId, accA.userId, accB.userId));
    const viewB = b.chat(accB.id, chatAB);
    const viewA = a.chat(accA.id, chatAB);
    const ub = viewB.messages.subscribe(() => {});
    const ua = viewA.messages.subscribe(() => {});
    // Make sure B is parked in a long poll before A writes.
    await until(b.connection, (s) => s[accB.id]?.kind === 'connected');

    await a.send(accA.id, chatAB, 'Привет из TypeScript');
    const gotB = await until(viewB.messages, (m) => m.length === 1);
    expect(gotB[0]).toMatchObject({ body: 'Привет из TypeScript', senderId: accA.userId, outgoing: false, status: 'on-server' });

    await b.send(accB.id, chatAB, 'Ответ **жирным**');
    const gotA = await until(viewA.messages, (m) => m.length === 2 && m.every((x) => x.status === 'on-server'));
    expect(gotA.map((m) => m.body)).toEqual(['Привет из TypeScript', 'Ответ **жирным**']);
    expect(gotA[0]!.gseq! < gotA[1]!.gseq!).toBe(true);
    secrets.push('Привет из TypeScript', 'Ответ **жирным**');

    // The server's view of the chat matches the TypeScript chat id.
    const tA = new Transport({ baseUrl: fcd.url });
    const tokenA = (await a.db.accounts.get(accA.id))!.token;
    const chats = await tA.chats(tokenA);
    expect(chats.map((x) => x.chatId)).toEqual([chatAB]);
    expect([...chats[0]!.members].sort()).toEqual([accA.userId, accB.userId].sort());

    const dm = <T extends { kind: string }>(l: readonly T[]): T[] => l.filter((c) => c.kind === 'dm');
    const list = dm(await until(b.chatList, (l) => dm(l)[0]?.lastMessage?.body === 'Ответ **жирным**'));
    expect(list[0]).toMatchObject({ title: 'Мама', unread: 1 });
    ua();
    ub();
  });

  it('a third member cannot read their chat', async () => {
    c = core();
    await c.start();
    const inv = await a.admin.createInvite(accA.id);
    accC = await c.join({ serverUrl: fcd.url, code: { invite: inv.code }, name: 'Бабушка' });
    const tokenC = (await c.db.accounts.get(accC.id))!.token;
    secrets.push(tokenC, inv.code);
    const t = new Transport({ baseUrl: fcd.url });
    await expect(t.chatEvents(tokenC, chatAB)).rejects.toSatisfy((e) => isApiError(e, 'not_member'));
    await expect(
      t.postEvent(tokenC, { chatId: chatAB, msgId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', epoch: 0, body: new Uint8Array(324) }),
    ).rejects.toSatisfy((e) => isApiError(e, 'not_member'));
    const page = await t.events(tokenC);
    expect(page.events).toHaveLength(0);
    await eventually(async () => (await c.db.accounts.get(accC.id))?.initialSyncDone);
    expect(await c.db.messages.count()).toBe(0);
    expect(await c.db.events.count()).toBe(0);
  });

  it('restoring by phrase on a fresh database gets the history that is on the server', async () => {
    const phrase = await a.recoveryPhrase(accA.userId);
    const a2 = core();
    await a2.start();
    const acc2 = await a2.restore({ serverUrl: fcd.url, phrase });
    expect(acc2.userId).toBe(accA.userId);
    expect(acc2.devId).not.toBe(accA.devId);
    expect(acc2.admin).toBe(true);
    await eventually(async () => (await messagesOf(a2, acc2.id, chatAB)).length === 2, 10_000, 'history');
    expect(await messagesOf(a2, acc2.id, chatAB)).toEqual(['Привет из TypeScript', 'Ответ **жирным**']);
    secrets.push((await a2.db.accounts.get(acc2.id))!.token);
  });

  it('two engines on the same account (two devices) both receive', async () => {
    const phrase = await b.recoveryPhrase(accB.userId);
    const b2 = core();
    await b2.start();
    const accB2 = await b2.restore({ serverUrl: fcd.url, phrase });
    await eventually(async () => (await b2.db.accounts.get(accB2.id))?.initialSyncDone);
    await until(b2.connection, (s) => s[accB2.id]?.kind === 'connected');
    await a.send(accA.id, chatAB, 'для обоих устройств');
    await eventually(async () => (await messagesOf(b, accB.id, chatAB)).includes('для обоих устройств'), 10_000, 'device 1');
    await eventually(async () => (await messagesOf(b2, accB2.id, chatAB)).includes('для обоих устройств'), 10_000, 'device 2');
    // What one device sends appears on the other device of the same person.
    await b2.send(accB2.id, chatAB, 'с телефона');
    await eventually(async () => (await messagesOf(b, accB.id, chatAB)).includes('с телефона'), 10_000, 'own other device');
    const own = (await b.db.messages.toArray()).find((m) => m.body === 'с телефона')!;
    expect(own.senderId).toBe(accB.userId);
    expect(own.devId).toBe(accB2.devId);
    secrets.push('для обоих устройств', 'с телефона', (await b2.db.accounts.get(accB2.id))!.token);
  });

  it('logs in again by signature after the token is invalidated', async () => {
    // Another client signs in with B's identity and B's devId: B's token is replaced.
    const ctx = new CoreContext({ db: b.db });
    const keys = await ctx.keys(accB.userId);
    const issued = await authenticateDevice(new Transport({ baseUrl: fcd.url }), keys, accB.serverId, accB.devId);
    const old = (await b.db.accounts.get(accB.id))!.token;
    expect(issued.token).not.toBe(old);
    secrets.push(issued.token, old);
    const t = new Transport({ baseUrl: fcd.url });
    await expect(t.me(old)).rejects.toSatisfy((e) => isApiError(e, 'unauthorized'));

    // B notices on its next request (the long poll or a send) and signs in again.
    await a.send(accA.id, chatAB, 'после перевхода');
    // A long poll already parked with the old token may still deliver; the next request gets 401.
    await eventually(async () => (await messagesOf(b, accB.id, chatAB)).includes('после перевхода'), 15_000, 'delivery');
    await eventually(async () => (await b.db.accounts.get(accB.id))!.token !== old, 15_000, 'new token');
    const fresh = (await b.db.accounts.get(accB.id))!.token;
    expect(fresh).not.toBe(old);
    expect(fresh).not.toBe(issued.token);
    secrets.push(fresh, 'после перевхода');
    expect(b.connection.get()[accB.id]?.kind).toBe('connected');
    await b.updateProfile(accB.id, 'Папа Коля');
    await a.refreshMembers(accA.id);
    expect((await a.db.users.get([accA.id, accB.userId]))?.name).toBe('Папа Коля');
  });

  it('a removed member ends in the "removed" state', async () => {
    await until(c.connection, (s) => s[accC.id]?.kind === 'connected');
    await a.admin.removeUser(accA.id, accC.userId);
    await until(c.connection, (s) => s[accC.id]?.kind === 'removed');
    expect((await c.db.accounts.get(accC.id))!.status).toBe('removed');
    const users = await a.admin.listUsers(accA.id);
    expect(users.find((u) => u.userId === accC.userId)).toMatchObject({ removed: true });
    // The removed member's device cannot come back by signature either.
    const phrase = await c.recoveryPhrase(accC.userId);
    await expect(core().restore({ serverUrl: fcd.url, phrase })).rejects.toMatchObject({ code: 'removed' });
    // Sending to a removed member fails permanently.
    const chatAC = await a.openChat(accA.id, accC.userId);
    const id = await a.send(accA.id, chatAC, 'ты тут?');
    const failed = await until(a.outbox, (o) => o.some((x) => x.msgId === id && x.status === 'failed'));
    expect(failed.find((x) => x.msgId === id)!.error).toBe('peer_removed');
    await a.cancel(accA.id, id);
    const stats = await a.admin.stats(accA.id);
    // `users` counts current members only.
    expect(stats).toMatchObject({ users: 2, removedUsers: 1 });
    // Push is off on this server.
    await expect(a.push.register(accA.id, { endpoint: 'https://push.example/x', keys: { p256dh: 'BA', auth: 'AA' } })).rejects.toSatisfy(
      (e) => isApiError(e, 'push_disabled'),
    );
  });

  it('sends while the server is down and delivers once it is back, without duplicates', async () => {
    const viewB = b.chat(accB.id, chatAB);
    const ub = viewB.messages.subscribe(() => {});
    const before = (await messagesOf(b, accB.id, chatAB)).length;
    await fcd.stop();
    await until(a.connection, (s) => s[accA.id]?.kind === 'offline');
    const id = await a.send(accA.id, chatAB, 'пока сервер спал');
    await new Promise((r) => setTimeout(r, 200));
    expect((await a.db.outbox.get([accA.id, id]))?.status).toBe('pending');
    await fcd.start(); // same folder, same port
    a.wake();
    b.wake();
    await eventually(async () => (await a.db.outbox.count()) === 0, 20_000, 'outbox drained');
    await eventually(async () => (await messagesOf(b, accB.id, chatAB)).includes('пока сервер спал'), 20_000, 'delivered');
    await new Promise((r) => setTimeout(r, 300));
    const all = await messagesOf(b, accB.id, chatAB);
    expect(all.filter((m) => m === 'пока сервер спал')).toHaveLength(1);
    expect(all.length).toBe(before + 1);
    // The server holds exactly one event with that id.
    const tokenA = (await a.db.accounts.get(accA.id))!.token;
    const hist = await new Transport({ baseUrl: fcd.url }).chatEvents(tokenA, chatAB);
    expect(hist.events.filter((e) => e.msgId === id)).toHaveLength(1);
    // Re-sending the same message id is a duplicate on the server.
    const ev = hist.events.find((e) => e.msgId === id)!;
    const dup = await new Transport({ baseUrl: fcd.url }).postEvent(tokenA, { chatId: chatAB, msgId: id, epoch: 0, body: ev.body });
    expect(dup).toMatchObject({ duplicate: true, gseq: ev.gseq });
    secrets.push('пока сервер спал', tokenA);
    ub();
  });

  it('keeps secrets and message text out of diagnostics', async () => {
    for (const x of cores) {
      await x.stop();
      const report = await x.diagnosticsReport();
      for (const s of secrets) {
        const words = s.split(/\s+/);
        if (words.length >= 24) {
          // A recovery phrase: no two consecutive words may appear (single words are common English).
          for (let i = 0; i + 1 < words.length; i++) {
            expect(report.includes(`${words[i]} ${words[i + 1]}`), 'diagnostics leak phrase words').toBe(false);
          }
        } else {
          expect(report.includes(s), 'diagnostics leak a secret or message text').toBe(false);
        }
      }
      expect(report.length).toBeGreaterThan(0);
    }
  });
});
