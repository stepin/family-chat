/* global self, clients, indexedDB */
// Web Push handlers, imported into the generated service worker (workbox
// `importScripts` in vite.config.ts), plus the icon badge and the Web
// Share Target (both below).
//
// Every push shows a notification, whatever happens: iOS revokes the
// subscription of a web app that receives pushes silently. The payload is
// `{chatId, gseq}` (docs/API.md 6); names come from the local database
// (read-only, plain IndexedDB, nothing is created or changed). Text is not
// decrypted here. Group chats show the group name.
//
// The title is the chat (the person, the group, "Избранное"); when several
// families share the device it starts with the family's name ("Ивановы ·
// Мама"), to tell them apart.
//
// One worker per fcd: pages of the other families of the server
// (`<root>/f/<id>/…`) register this root worker too, so its one push
// subscription serves every family of the server. It answers those pages
// from the root's cache (the same app), so they open without a network. The language is the app's (settings key
// `ui.lang`, written by the app), else the first of ru/en in the system's
// list, else Russian: the same rule as src/lib/locale.ts.

const DB_NAME = 'family-chat';
const LOOKUP_TIMEOUT_MS = 3000;
/** Settings keys shared with the core (packages/core/src/badge.ts and share.ts). */
const BADGE_KEY = 'badge.count';
const SHARE_KEY = 'share.pending';
const MAX_BADGE = 9999;
const MAX_SHARED_FILES = 10;
const MAX_SHARED_BYTES = 1024 * 1024 * 1024;
const MAX_SHARED_TEXT = 16 * 1024;
const LANG_KEY = 'ui.lang';

const TEXT = {
  ru: {
    message: 'Новое сообщение',
    groupMessage: 'Новое сообщение в группе',
    from: (name) => `Новое сообщение от ${name}`,
    self: 'Новая запись в «Избранном»',
    selfTitle: 'Избранное',
    test: 'Пробное уведомление дошло.',
    testLater: (s) => `Пробное уведомление дошло (отправлено через ${s} с).`,
  },
  en: {
    message: 'New message',
    groupMessage: 'New message in the group',
    from: (name) => `New message from ${name}`,
    self: 'New note in Saved Messages',
    selfTitle: 'Saved Messages',
    test: 'The test notification arrived.',
    testLater: (s) => `The test notification arrived (sent ${s} s later).`,
  },
};

/** The language stored by the app, or null (no database or no setting). */
async function readLangPref() {
  try {
    const db = await openExisting();
    try {
      if (!db.objectStoreNames.contains('settings')) return null;
      const row = await request(db.transaction('settings', 'readonly').objectStore('settings').get(LANG_KEY));
      return row ? row.value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The app's choice ('ru', 'en'), or the system's languages when it is 'system' or unknown. */
function pickLang(pref) {
  if (pref === 'ru' || pref === 'en') return pref;
  const nav = self.navigator || {};
  const list = nav.languages && nav.languages.length ? nav.languages : [nav.language || ''];
  for (const tag of list) {
    const primary = String(tag).toLowerCase().split(/[-_]/)[0];
    if (primary === 'ru' || primary === 'en') return primary;
  }
  return 'ru';
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Opens the app database if it exists; never creates it. */
function openExisting() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

/**
 * Family name and what to call the chat, as far as the database knows: the
 * other person's name for a direct chat, the group name (from the verified
 * state) for a group, "Избранное" for the chat with oneself.
 */
async function lookup(chatId) {
  const db = await openExisting();
  try {
    const names = ['accounts', 'chats', 'users'];
    let langPref = null;
    if (db.objectStoreNames.contains('settings')) {
      const row = await request(db.transaction('settings', 'readonly').objectStore('settings').get(LANG_KEY));
      langPref = row ? row.value : null;
    }
    if (!names.every((n) => db.objectStoreNames.contains(n))) return { langPref };
    const withGroups = db.objectStoreNames.contains('groups');
    const tx = db.transaction(withGroups ? [...names, 'groups'] : names, 'readonly');
    const chats = typeof chatId === 'string' ? await request(tx.objectStore('chats').index('chatId').getAll(chatId)) : [];
    const chat = chats[0];
    const accounts = await request(tx.objectStore('accounts').getAll());
    const account = chat ? accounts.find((a) => a.id === chat.accountId) : accounts.length === 1 ? accounts[0] : undefined;
    let peerName = null;
    let groupName = null;
    let self = false;
    if (chat && chat.kind === 'group') {
      if (withGroups) {
        const group = await request(tx.objectStore('groups').get([chat.accountId, chat.chatId]));
        const name = group && group.state ? group.state.name : null;
        groupName = typeof name === 'string' && name.length > 0 ? name : null;
      }
    } else if (chat && chat.kind === 'self') {
      self = true;
    } else if (chat) {
      const peer = await request(tx.objectStore('users').get([chat.accountId, chat.peerId]));
      peerName = peer && typeof peer.name === 'string' ? peer.name : null;
    }
    return {
      accountId: account ? account.id : null,
      familyName: account ? account.familyName : null,
      peerName,
      groupName,
      group: !!chat && chat.kind === 'group',
      self,
      severalFamilies: accounts.length > 1,
      langPref,
    };
  } finally {
    db.close();
  }
}

/**
 * Title and text of the notification (no message text: it is not decrypted
 * here). The family's name only tells families apart (several on the device).
 */
function describe(info) {
  const t = TEXT[pickLang(info.langPref)];
  const family = info.severalFamilies && info.familyName ? info.familyName : null;
  const withFamily = (title) => (family ? `${family} · ${title}` : title);
  if (info.group) return { title: info.groupName ? withFamily(info.groupName) : family || 'Family Chat', body: t.groupMessage };
  if (info.self) return { title: withFamily(t.selfTitle), body: t.self };
  if (info.peerName) return { title: withFamily(info.peerName), body: t.message };
  return { title: family || 'Family Chat', body: t.message };
}

/**
 * The badge rule (packages/core/src/badge.ts): a push cannot be decrypted
 * here, so the count the app last stored goes up by one per push; the app
 * sets the real total again when it opens. Pushes come only for new
 * messages (edits, deletions and reactions carry the no-push hint).
 */
async function bumpBadge() {
  const db = await openExisting();
  let count = 0;
  try {
    if (!db.objectStoreNames.contains('settings')) return null;
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const row = await request(store.get(BADGE_KEY));
    const stored = row ? row.value : undefined;
    const n = typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    count = Math.min(n + 1, MAX_BADGE);
    await request(store.put({ key: BADGE_KEY, value: count }));
  } finally {
    db.close();
  }
  return count;
}

async function showBadge(count) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== 'function' || typeof count !== 'number') return;
  try {
    await nav.setAppBadge(count);
  } catch {
    // Not available here: nothing to do.
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({}), ms))]);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  const scope = self.registration.scope;
  const icon = new URL('icon-192.png', scope).href;
  // Monochrome silhouette: Android draws the badge from its alpha channel.
  const badge = new URL('badge-96.png', scope).href;

  // Test notifications of the server check: the /server/ page or the
  // app's "Server check" section.
  if (data.kind === 'check-test') {
    const sentAt = typeof data.sentAt === 'number' ? data.sentAt : 0;
    const receivedAt = Date.now();
    const fromApp = data.from === 'app';
    event.waitUntil(
      (async () => {
        // The text is chosen here, in the app's language; older servers sent their own.
        const t = TEXT[pickLang(await readLangPref())];
        const delay = typeof data.delay === 'number' && data.delay > 0 ? data.delay : 0;
        await self.registration.showNotification(data.title || 'Family Chat', {
          body: data.body || (delay ? t.testLater(delay) : t.test),
          icon,
          badge,
          tag: `fc-check-${sentAt || receivedAt}`,
          data: {
            url: fromApp ? new URL('./?open=server-check', scope).href : new URL(`server/?from=push&sentAt=${sentAt}`, scope).href,
            check: true,
            from: fromApp ? 'app' : 'page',
            sentAt,
          },
        });
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of windows) w.postMessage({ type: 'fc-push', sentAt, receivedAt });
      })(),
    );
    return;
  }

  // A kind this service worker does not know (a newer server): a plain
  // notification, without counting it as an unread message.
  if (typeof data.kind === 'string') {
    event.waitUntil(
      (async () => {
        const t = TEXT[pickLang(await readLangPref())];
        await self.registration.showNotification('Family Chat', { body: t.message, icon, badge, data: { url: scope } });
      })(),
    );
    return;
  }

  const chatId = typeof data.chatId === 'string' && /^[a-z2-7]{26}$/.test(data.chatId) ? data.chatId : null;
  event.waitUntil(
    (async () => {
      let info = {};
      try {
        info = await withTimeout(lookup(chatId), LOOKUP_TIMEOUT_MS);
      } catch {
        info = {};
      }
      const { title, body } = describe(info);
      const accountId = typeof info.accountId === 'string' && /^[a-z2-7]{16,26}$/.test(info.accountId) ? info.accountId : null;
      const url = new URL(chatId ? `./?chat=${chatId}${accountId ? `&account=${accountId}` : ''}` : './', scope).href;
      try {
        await showBadge(await withTimeout(bumpBadge(), LOOKUP_TIMEOUT_MS));
      } catch {
        // The badge is a hint; the notification matters.
      }
      try {
        await self.registration.showNotification(title, {
          body,
          icon,
          badge,
          // One notification per chat; a new message replaces it and alerts again.
          tag: chatId ? `fc-chat-${chatId}` : 'fc-message',
          renotify: true,
          data: { url, chatId, accountId },
        });
      } catch {
        await self.registration.showNotification('Family Chat', { body: TEXT[pickLang(info.langPref)].message, icon, data: { url, chatId, accountId } });
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const scopePath = new URL(self.registration.scope).pathname;
      for (const w of windows) {
        if (!w.url.startsWith(self.registration.scope) || !('focus' in w)) continue;
        if (data.check) {
          // The window of the screen that asked for the test.
          const path = new URL(w.url).pathname;
          if (data.from === 'app' ? path !== scopePath : !path.endsWith('/server/')) continue;
          await w.focus();
          w.postMessage(
            data.from === 'app' ? { type: 'fc-open-server-check' } : { type: 'fc-notification-click', sentAt: data.sentAt },
          );
          return;
        }
        // The main app (not the check pages) opens the chat itself.
        const path = new URL(w.url).pathname;
        if (path === scopePath) {
          await w.focus();
          w.postMessage({ type: 'fc-open-chat', chatId: data.chatId || null, accountId: data.accountId || null });
          return;
        }
      }
      await clients.openWindow(url);
    })(),
  );
});

// ---- Web Share Target ----
//
// The installed app is a share target (manifest `share_target`: POST,
// multipart, `title`, `text`, `url`, `files`). The shared content is kept in
// the app's settings table under `share.pending` (files as Blobs) and the app
// opens with `?share=1`; it then asks which family and chat (also when it was
// closed). Too many or too large files are refused here with a reason the app
// shows. Nothing leaves the device at this point.

function sharedString(form, name) {
  const v = form.get(name);
  return typeof v === 'string' ? v.slice(0, MAX_SHARED_TEXT) : '';
}

async function stashShare(shareRequest) {
  let entry;
  try {
    const form = await shareRequest.formData();
    const files = form.getAll('files').filter((f) => typeof f === 'object' && f !== null && typeof f.size === 'number' && f.size > 0);
    const total = files.reduce((n, f) => n + f.size, 0);
    const problem = files.length > MAX_SHARED_FILES ? 'too-many-files' : total > MAX_SHARED_BYTES ? 'too-large' : null;
    entry = {
      id: Math.random().toString(36).slice(2),
      at: Date.now(),
      title: sharedString(form, 'title'),
      text: sharedString(form, 'text'),
      url: sharedString(form, 'url'),
      files: problem ? [] : files,
      problem,
    };
  } catch {
    entry = { id: Math.random().toString(36).slice(2), at: Date.now(), title: '', text: '', url: '', files: [], problem: 'unreadable' };
  }
  const db = await openExisting();
  try {
    if (!db.objectStoreNames.contains('settings')) return false;
    const tx = db.transaction('settings', 'readwrite');
    await request(tx.objectStore('settings').put({ key: SHARE_KEY, value: entry }));
    return true;
  } finally {
    db.close();
  }
}

async function handleShare(event, base) {
  let stored = false;
  try {
    stored = await stashShare(event.request);
  } catch {
    stored = false;
  }
  // The share navigates a window of the app to this address; that window takes the stash.
  return Response.redirect(new URL(stored ? './?share=1' : './?share=unavailable', base).href, 303);
}

/** `<scope>f/<id>/`: the base of another family of this server, from a path inside the scope. */
const FAMILY_PATH = /^f\/([a-z2-7]{16})\/(.*)$/;

function familyOf(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  const m = FAMILY_PATH.exec(url.pathname.slice(scope.pathname.length));
  return m ? { base: new URL(`f/${m[1]}/`, scope).href, rest: m[2] } : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST') {
    // The share target of the root page or of a family page `/f/<id>/`.
    const fam = familyOf(url);
    const base = fam && fam.rest === 'share-target' ? fam.base : self.registration.scope;
    if (url.href !== new URL('share-target', base).href) return;
    event.respondWith(handleShare(event, base));
    return;
  }
  if (req.method !== 'GET') return;
  // A page of another family of this server: the same app as the root's, from the root's cache.
  const fam = familyOf(url);
  if (!fam || fam.rest.startsWith('v1/') || fam.rest === 'v1') return;
  const path = fam.rest === '' || fam.rest.endsWith('/') ? `${fam.rest}index.html` : fam.rest;
  const target = new URL(path, self.registration.scope).href;
  event.respondWith(
    (async () => {
      const cached = await caches.match(target, { ignoreSearch: true }).catch(() => undefined);
      return cached || fetch(req);
    })(),
  );
  // The precache router behind would not know this address anyway.
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
});

// ---- A new push subscription ----
//
// The push service replaced the subscription: hand the new one to every
// family of this server on the device that wants notifications (the same
// key), as the app would at its next start.

function b64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription || null;
      if (!sub) {
        const key = event.oldSubscription && event.oldSubscription.options ? event.oldSubscription.options.applicationServerKey : null;
        if (!key) return;
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const key = sub.options && sub.options.applicationServerKey ? b64url(sub.options.applicationServerKey) : null;
      const json = sub.toJSON();
      if (!key || !json.endpoint || !json.keys) return;
      const db = await openExisting();
      let accounts = [];
      try {
        if (db.objectStoreNames.contains('accounts')) accounts = await request(db.transaction('accounts', 'readonly').objectStore('accounts').getAll());
      } finally {
        db.close();
      }
      const body = JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, expirationTime: json.expirationTime ?? null });
      for (const a of accounts) {
        if (a.status !== 'active' || !a.token || a.vapidPublicKey !== key) continue;
        if (!(a.pushWanted === true || (a.pushWanted == null && a.pushRegistered))) continue;
        await fetch(`${a.serverUrl}/v1/me/push`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
          body,
          credentials: 'omit',
          cache: 'no-store',
        }).catch(() => undefined);
      }
    })(),
  );
});
