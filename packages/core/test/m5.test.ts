// M5 in the core against fake servers: two families on one device syncing at
// once, the same identity on both, removing one account, push routing to the
// right account, the no-push hint for control events, the badge rule, the
// shared-content stash and identity links.

import { afterEach, describe, expect, it } from 'vitest';
import { badgeAfterPush, MAX_BADGE, SETTING_BADGE_COUNT, titleWithUnread, unreadTotal } from '../src/badge.ts';
import { createCore, type FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { parseShared, SETTING_SHARE_PENDING, sharedText } from '../src/share.ts';
import { until } from '../src/util/readable.ts';
import type { FetchFn } from '../src/api/transport.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, FAST, memDb } from './support/helpers.ts';

const cores: FamilyChatCore[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

/** One fetch for two fake servers, by host. */
function twoServers(s1: FakeServer, s2: FakeServer, seen?: { url: string; headers: Headers }[]): FetchFn {
  return (url, init) => {
    seen?.push({ url, headers: new Headers(init.headers) });
    return url.startsWith('https://two.test') ? s2.fetch(url, init) : s1.fetch(url, init);
  };
}

function core(fetch: FetchFn, db = memDb()): FamilyChatCore {
  const c = createCore({ db, fetch, ...FAST });
  cores.push(c);
  return c;
}

/** Mama on both servers (administrator of each), papa on one, babushka on two. */
async function setup() {
  const s1 = new FakeServer({ familyName: 'Ивановы' });
  const s2 = new FakeServer({ familyName: 'Петровы' });
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = twoServers(s1, s2, seen);
  const mama = core(fetch);
  const papa = core(fetch);
  const babushka = core(fetch);
  for (const c of [mama, papa, babushka]) await c.start();
  const m1 = await mama.join({ serverUrl: 'https://one.test', code: { adminCode: s1.adminCode }, name: 'Мама' });
  // The same identity on the second server ("use the same identity").
  const m2 = await mama.join({ serverUrl: 'https://two.test', code: { adminCode: s2.adminCode }, name: 'Мама', userId: m1.userId });
  const p1 = await papa.join({ serverUrl: 'https://one.test', code: { invite: (await mama.admin.createInvite(m1.id)).code }, name: 'Папа' });
  const b2 = await babushka.join({ serverUrl: 'https://two.test', code: { invite: (await mama.admin.createInvite(m2.id)).code }, name: 'Бабушка' });
  await mama.refreshMembers(m1.id);
  await mama.refreshMembers(m2.id);
  return { s1, s2, seen, mama, papa, babushka, m1, m2, p1, b2 };
}

describe('two families on one device', () => {
  it('keeps the same identity, syncs both at once and counts unread per family', async () => {
    const { mama, papa, babushka, m1, m2, p1, b2 } = await setup();
    expect(m2.userId).toBe(m1.userId);
    expect(await mama.identities()).toEqual([m1.userId]);
    expect((await mama.accountList()).map((a) => a.familyName).sort()).toEqual(['Ивановы', 'Петровы']);

    const c1 = await papa.openChat(p1.id, m1.userId);
    const c2 = await babushka.openChat(b2.id, m2.userId);
    expect(c1).not.toBe(c2);
    await papa.send(p1.id, c1, 'Привет из первой семьи');
    await babushka.send(b2.id, c2, 'Привет из второй семьи');

    const list = await until(mama.chatList, (l) => l.filter((c) => c.unread > 0).length === 2);
    const byFamily = Object.fromEntries(list.filter((c) => c.unread > 0).map((c) => [c.familyName, [c.accountId, c.lastMessage?.body]]));
    expect(byFamily).toEqual({ Ивановы: [m1.id, 'Привет из первой семьи'], Петровы: [m2.id, 'Привет из второй семьи'] });
    expect(await until(mama.unreadTotal, (n) => n === 2)).toBe(2);

    // Each server only ever saw its own family's requests.
    await mama.markRead(m2.id, c2);
    expect(await until(mama.unreadTotal, (n) => n === 1)).toBe(1);
  });

  it('routes a push to the account that has the chat', async () => {
    const { s2, mama, babushka, m2, b2 } = await setup();
    const c2 = await babushka.openChat(b2.id, m2.userId);
    await babushka.send(b2.id, c2, 'Пирожки готовы');
    await eventually(() => s2.log.some((e) => e.chatId === c2));
    const ev = s2.log.find((e) => e.chatId === c2)!;
    const notice = await mama.handlePush({ chatId: c2, gseq: ev.gseq });
    expect(notice).toMatchObject({ kind: 'message', accountId: m2.id, chatId: c2, familyName: 'Петровы', senderName: 'Бабушка' });
  });

  it('removes one account with its data and leaves the other running', async () => {
    const { s1, mama, papa, babushka, m1, m2, p1, b2 } = await setup();
    const c1 = await papa.openChat(p1.id, m1.userId);
    const c2 = await babushka.openChat(b2.id, m2.userId);
    await papa.send(p1.id, c1, 'раз');
    await babushka.send(b2.id, c2, 'два');
    await until(mama.chatList, (l) => l.filter((c) => c.lastMessage).length >= 2);
    await mama.setDraft(m1.id, c1, 'черновик');

    await mama.removeAccount(m1.id);
    expect((await mama.accountList()).map((a) => a.id)).toEqual([m2.id]);
    for (const t of ['users', 'chats', 'events', 'messages', 'drafts', 'counters', 'seqTrack', 'outbox']) {
      const left = (await mama.db.table(t).toArray()).filter((r: { accountId?: string }) => r.accountId === m1.id);
      expect([t, left.length]).toEqual([t, 0]);
    }
    // The identity is still used by the other family: its seed stays.
    expect(await mama.identities()).toEqual([m2.userId]);
    // The other family keeps syncing.
    const before = s1.requests.length;
    await babushka.send(b2.id, c2, 'три');
    await until(mama.chat(m2.id, c2).messages, (l) => l.some((m) => m.body === 'три'));
    expect(s1.requests.slice(before).some((r) => r.includes('/v1/events'))).toBe(false);
    expect(isCoreError(await mama.chat(m1.id, c1).loadOlder().catch((e: unknown) => e), 'no-account')).toBe(true);

    // The last account of an identity takes its seed with it.
    await mama.removeAccount(m2.id);
    expect(await mama.identities()).toEqual([]);
    expect(await mama.accountList()).toEqual([]);
  });

  it('sends edits, deletions and reactions with the no-push hint, messages without', async () => {
    const { seen, papa, m1, p1 } = await setup();
    const c1 = await papa.openChat(p1.id, m1.userId);
    const id = await papa.send(p1.id, c1, 'исходный текст');
    await until(papa.chat(p1.id, c1).messages, (l) => l.some((m) => m.msgId === id && m.status === 'on-server'));
    await papa.editMessage(p1.id, c1, id, 'исправленный текст');
    await papa.react(p1.id, c1, p1.userId, id, '👍', true);
    await eventually(() => seen.filter((s) => s.url.endsWith(`/v1/chats/${c1}/events`)).length >= 3);
    const posts = seen.filter((s) => s.url.endsWith(`/v1/chats/${c1}/events`));
    expect(posts.map((s) => s.headers.get('x-fc-push'))).toEqual([null, 'none', 'none']);
    await papa.deleteForEveryone(p1.id, c1, p1.userId, id);
    await eventually(() => seen.filter((s) => s.url.endsWith(`/v1/chats/${c1}/events`)).length >= 4);
    expect(seen.filter((s) => s.url.endsWith(`/v1/chats/${c1}/events`))[3]!.headers.get('x-fc-push')).toBe('none');
  });
});

describe('badge', () => {
  it('counts unread of the accounts that are still members', () => {
    const accounts = [
      { id: 'a', status: 'active' as const },
      { id: 'b', status: 'removed' as const },
      { id: 'c', status: 'login-invalid' as const },
    ];
    const chats = [
      { accountId: 'a', unread: 2 },
      { accountId: 'a', unread: 0 },
      { accountId: 'b', unread: 5 },
      { accountId: 'c', unread: 1 },
      { accountId: 'gone', unread: 9 },
    ];
    expect(unreadTotal(accounts, chats)).toBe(3);
    expect(unreadTotal(accounts, [{ accountId: 'a', unread: 20_000 }])).toBe(MAX_BADGE);
  });

  it('the service worker adds one per push to what the app stored', () => {
    expect(badgeAfterPush(undefined)).toBe(1);
    expect(badgeAfterPush(4)).toBe(5);
    expect(badgeAfterPush(-3)).toBe(1);
    expect(badgeAfterPush('7')).toBe(1);
    expect(badgeAfterPush(MAX_BADGE)).toBe(MAX_BADGE);
    expect(titleWithUnread('Family Chat', 0)).toBe('Family Chat');
    expect(titleWithUnread('Family Chat', 3)).toBe('(3) Family Chat');
    expect(titleWithUnread('Family Chat', 150)).toBe('(99+) Family Chat');
  });

  it('noteBadge stores the total for the service worker', async () => {
    const s = new FakeServer();
    const c = core(s.fetch);
    await c.start();
    await c.noteBadge(4);
    expect(await c.getSetting(SETTING_BADGE_COUNT)).toBe(4);
    // What push-sw.js does on a push: read, add one, store.
    await c.setSetting(SETTING_BADGE_COUNT, badgeAfterPush(await c.getSetting(SETTING_BADGE_COUNT)));
    expect(await c.getSetting(SETTING_BADGE_COUNT)).toBe(5);
  });
});

describe('shared content', () => {
  const now = 1_800_000_000_000;

  it('joins title, text and address without repeating them', () => {
    expect(sharedText('Статья', 'Смотри: https://x.example/a', 'https://x.example/a')).toBe('Статья\nСмотри: https://x.example/a');
    expect(sharedText('', '', 'https://x.example')).toBe('https://x.example');
    expect(sharedText('  ', 'a'.repeat(20_000), '').length).toBe(16 * 1024);
  });

  it('validates the stash', () => {
    const f = new File([new Uint8Array(3)], 'photo.jpg', { type: 'image/jpeg' });
    expect(parseShared({ id: 'x', at: now, title: '', text: 'привет', url: '', files: [f, 'junk', 5] }, now)).toMatchObject({
      text: 'привет',
      files: [f],
      problem: null,
    });
    expect(parseShared({ id: 'x', at: now - 25 * 3600_000, text: 'old', files: [] }, now)).toBeNull();
    expect(parseShared({ id: 'x', at: now + 3600_000, text: 'future', files: [] }, now)).toBeNull();
    expect(parseShared('nonsense', now)).toBeNull();
    expect(parseShared({ id: 'x', at: now, text: 'много', files: [f], problem: 'too-many-files' }, now)).toMatchObject({ files: [], problem: 'too-many-files' });
    const many = Array.from({ length: 12 }, (_, i) => new File([new Uint8Array(1)], `${i}.txt`));
    expect(parseShared({ id: 'x', at: now, files: many }, now)!.files).toHaveLength(10);
  });

  it('takeShared returns the stash once', async () => {
    const s = new FakeServer();
    const c = core(s.fetch);
    await c.start();
    expect(await c.takeShared()).toBeNull();
    const f = new File([new Uint8Array([1, 2])], 'a.png', { type: 'image/png' });
    await c.setSetting(SETTING_SHARE_PENDING, { id: 'abc', at: Date.now(), title: 'Заголовок', text: 'Текст', url: '', files: [f] });
    const got = await c.takeShared();
    expect(got).toMatchObject({ id: 'abc', text: 'Заголовок\nТекст', problem: null });
    expect(got!.files.map((x) => x.name)).toEqual(['a.png']);
    expect(await c.takeShared()).toBeNull();
  });
});

describe('identity links', () => {
  it('shows the older chat inside the newer one and refuses chains', async () => {
    const s = new FakeServer();
    const mama = core(s.fetch);
    const old = core(s.fetch);
    const fresh = core(s.fetch);
    for (const c of [mama, old, fresh]) await c.start();
    const m = await mama.join({ serverUrl: 'https://fc.test', code: { adminCode: s.adminCode }, name: 'Мама' });
    const o = await old.join({ serverUrl: 'https://fc.test', code: { invite: (await mama.admin.createInvite(m.id)).code }, name: 'Папа' });
    // The identity's `created` comes from the client clock: the new phone is strictly later.
    await new Promise((r) => setTimeout(r, 5));
    const n = await fresh.join({ serverUrl: 'https://fc.test', code: { invite: (await mama.admin.createInvite(m.id)).code }, name: 'Папа (новый телефон)' });
    await mama.refreshMembers(m.id);
    const oldChat = await old.openChat(o.id, m.userId);
    await old.send(o.id, oldChat, 'со старого телефона');
    await until(mama.chatList, (l) => l.some((c) => c.chatId === oldChat && c.unread === 1));
    const newChatOnFresh = await fresh.openChat(n.id, m.userId);
    await fresh.send(n.id, newChatOnFresh, 'с нового телефона');
    await until(mama.chatList, (l) => l.some((c) => c.chatId === newChatOnFresh && c.unread === 1));

    // Order of arguments does not matter: the identity created earlier is the older one.
    const newChat = await mama.linkIdentity(m.id, n.userId, o.userId);
    expect(newChat).toBe(newChatOnFresh);
    const links = await until(mama.identityLinks(m.id), (l) => l.length === 1);
    expect(links[0]).toMatchObject({ userId: o.userId, to: n.userId, valid: true });

    const list = await until(mama.chatList, (l) => !l.some((c) => c.chatId === oldChat));
    const merged = list.find((c) => c.chatId === newChat)!;
    expect(merged.unread).toBe(2);
    const feed = await until(mama.chat(m.id, newChat).messages, (l) => l.length === 2);
    expect(feed.map((x) => x.body)).toEqual(['со старого телефона', 'с нового телефона']);
    await mama.markRead(m.id, newChat);
    expect(await until(mama.unreadTotal, (x) => x === 0)).toBe(0);

    await expect(mama.linkIdentity(m.id, n.userId, m.userId)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(mama.linkIdentity(m.id, o.userId, n.userId)).resolves.toBe(newChat);

    await mama.unlinkIdentity(m.id, o.userId);
    await until(mama.chatList, (l) => l.some((c) => c.chatId === oldChat));
  });
});
