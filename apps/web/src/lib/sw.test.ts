// The service worker add-on (public/push-sw.js) run in a fake service worker
// scope: the badge rule on push, the account in the notification's address,
// and the Web Share Target handler (the POST is handled the way the real
// worker gets it from the share sheet).

import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { parseShared, SETTING_BADGE_COUNT, SETTING_SHARE_PENDING } from '@family-chat/core';

const CODE = readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://fc.test/app/';

type Listener = (e: unknown) => void;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** The app database as Dexie leaves it (only the stores the worker reads). */
async function appDb(factory: IDBFactory, withSettings = true): Promise<void> {
  const open = factory.open('family-chat', 40);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('accounts', { keyPath: 'id' });
    db.createObjectStore('chats', { keyPath: ['accountId', 'chatId'] }).createIndex('chatId', 'chatId');
    db.createObjectStore('users', { keyPath: ['accountId', 'userId'] });
    db.createObjectStore('groups', { keyPath: ['accountId', 'chatId'] });
    if (withSettings) db.createObjectStore('settings', { keyPath: 'key' });
  };
  const db = await req(open);
  const tx = db.transaction(withSettings ? ['accounts', 'chats', 'users', 'settings'] : ['accounts', 'chats', 'users'], 'readwrite');
  tx.objectStore('accounts').put({ id: 'accountaaaaaaaaa', familyName: 'Ивановы' });
  tx.objectStore('accounts').put({ id: 'accountbbbbbbbbb', familyName: 'Петровы' });
  tx.objectStore('chats').put({ accountId: 'accountbbbbbbbbb', chatId: 'c'.repeat(26), kind: 'dm', peerId: 'p'.repeat(26) });
  tx.objectStore('users').put({ accountId: 'accountbbbbbbbbb', userId: 'p'.repeat(26), name: 'Бабушка' });
  if (withSettings) tx.objectStore('settings').put({ key: SETTING_BADGE_COUNT, value: 4 });
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

async function setting(factory: IDBFactory, key: string): Promise<unknown> {
  const db = await req(factory.open('family-chat'));
  const row = await req(db.transaction('settings').objectStore('settings').get(key));
  db.close();
  return (row as { value?: unknown } | undefined)?.value;
}

function worker(factory: IDBFactory, badge = true) {
  const listeners = new Map<string, Listener[]>();
  const notifications: { title: string; options: { body?: string; data?: { url?: string; accountId?: string | null } } }[] = [];
  const setAppBadge = vi.fn(async () => undefined);
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    registration: {
      scope: SCOPE,
      showNotification: async (title: string, options: never) => void notifications.push({ title, options }),
    },
    navigator: badge ? { setAppBadge } : {},
  };
  const clients = { matchAll: async () => [], openWindow: async () => null };
  new Function('self', 'clients', 'indexedDB', CODE)(self, clients, factory);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const e = { ...event, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (response = p) };
    for (const l of listeners.get(type) ?? []) l(e);
    await Promise.all(waits);
    return response;
  };
  return { dispatch, notifications, setAppBadge };
}

describe('push: badge and routing', () => {
  it('adds one to the stored count, shows the badge and names the account in the address', async () => {
    const factory = new IDBFactory();
    await appDb(factory);
    const w = worker(factory);
    await w.dispatch('push', { data: { json: () => ({ chatId: 'c'.repeat(26), gseq: 7 }) } });
    expect(await setting(factory, SETTING_BADGE_COUNT)).toBe(5);
    expect(w.setAppBadge).toHaveBeenCalledWith(5);
    expect(w.notifications).toHaveLength(1);
    expect(w.notifications[0]!.title).toBe('Петровы');
    expect(w.notifications[0]!.options.body).toBe('Новое сообщение от Бабушка');
    expect(w.notifications[0]!.options.data!.url).toBe(`${SCOPE}?chat=${'c'.repeat(26)}&account=accountbbbbbbbbb`);
    expect(w.notifications[0]!.options.data!.accountId).toBe('accountbbbbbbbbb');
    await w.dispatch('push', { data: { json: () => ({ chatId: 'c'.repeat(26), gseq: 8 }) } });
    expect(w.setAppBadge).toHaveBeenLastCalledWith(6);
  });

  it('still notifies without the Badging API or a settings store', async () => {
    const factory = new IDBFactory();
    await appDb(factory, false);
    const w = worker(factory, false);
    await w.dispatch('push', { data: { json: () => ({ chatId: 'c'.repeat(26), gseq: 1 }) } });
    expect(w.notifications).toHaveLength(1);
    const empty = worker(new IDBFactory());
    await empty.dispatch('push', { data: { json: () => ({ chatId: 'zzz', gseq: 1 }) } });
    expect(empty.notifications[0]!.title).toBe('Family Chat');
  });
});

describe('Web Share Target', () => {
  function sharePost(form: FormData, path = 'share-target'): Request {
    return new Request(new URL(path, SCOPE), { method: 'POST', body: form });
  }

  it('keeps the shared text and files and opens the app', async () => {
    const factory = new IDBFactory();
    await appDb(factory);
    const w = worker(factory);
    const form = new FormData();
    form.set('title', 'Статья');
    form.set('text', 'Посмотри');
    form.set('url', 'https://example.org/a');
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
    form.append('files', new File([new Uint8Array([4])], 'doc.pdf', { type: 'application/pdf' }));
    const res = await w.dispatch('fetch', { request: sharePost(form) });
    expect(res).toBeDefined();
    const r = await res!;
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${SCOPE}?share=1`);
    const stored = await setting(factory, SETTING_SHARE_PENDING);
    const shared = parseShared(stored, Date.now())!;
    expect(shared.text).toBe('Статья\nПосмотри\nhttps://example.org/a');
    expect(shared.files.map((f) => [f.name, f.size])).toEqual([
      ['photo.jpg', 3],
      ['doc.pdf', 1],
    ]);
    expect(shared.problem).toBeNull();
  });

  it('refuses too many files with a reason, and ignores other requests', async () => {
    const factory = new IDBFactory();
    await appDb(factory);
    const w = worker(factory);
    const form = new FormData();
    for (let i = 0; i < 11; i++) form.append('files', new File([new Uint8Array([i])], `${i}.txt`));
    await (await w.dispatch('fetch', { request: sharePost(form) }))!;
    expect(parseShared(await setting(factory, SETTING_SHARE_PENDING), Date.now())).toMatchObject({ files: [], problem: 'too-many-files' });
    expect(await w.dispatch('fetch', { request: sharePost(new FormData(), 'v1/chats/x/events') })).toBeUndefined();
    expect(await w.dispatch('fetch', { request: new Request(new URL('share-target', SCOPE)) })).toBeUndefined();
  });

  it('without the app database the app opens with an explanation', async () => {
    const w = worker(new IDBFactory());
    const form = new FormData();
    form.set('text', 'привет');
    const r = await (await w.dispatch('fetch', { request: sharePost(form) }))!;
    expect(r.headers.get('location')).toBe(`${SCOPE}?share=unavailable`);
  });
});
