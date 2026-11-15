/* global self, clients, indexedDB */
// Web Push handlers, imported into the generated service worker (workbox
// `importScripts` in vite.config.ts). M5 adds the icon badge and the Web
// Share Target (both below).
//
// Every push shows a notification, whatever happens: iOS revokes the
// subscription of a web app that receives pushes silently. The payload is
// `{chatId, gseq}` (docs/API.md 6); names come from the local database
// (read-only, plain IndexedDB, nothing is created or changed). Text is not
// decrypted here. Group chats show the group name (docs/PLAN-v2.md 7.7).
//
// M7: the title is the chat (the person, the group, "Избранное"), not the
// family; the family's name is added only when several families share the
// device, to tell them apart. The language is the app's (settings key
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
  const withFamily = (body) => (family ? `${body} · ${family}` : body);
  if (info.group) return { title: info.groupName || family || 'Family Chat', body: withFamily(t.groupMessage) };
  if (info.self) return { title: t.selfTitle, body: withFamily(t.self) };
  if (info.peerName) return { title: info.peerName, body: withFamily(t.message) };
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

  // Test pushes of the server check page (/server/, fcd --m0).
  if (data.kind === 'm0-test') {
    const sentAt = typeof data.sentAt === 'number' ? data.sentAt : 0;
    const receivedAt = Date.now();
    event.waitUntil(
      (async () => {
        // The text is chosen here, in the app's language (M7); older servers sent their own.
        const t = TEXT[pickLang(await readLangPref())];
        const delay = typeof data.delay === 'number' && data.delay > 0 ? data.delay : 0;
        await self.registration.showNotification(data.title || 'Family Chat', {
          body: data.body || (delay ? t.testLater(delay) : t.test),
          icon,
          badge: icon,
          tag: `fc-m0-${sentAt || receivedAt}`,
          data: { url: new URL(`server/?from=push&sentAt=${sentAt}`, scope).href, m0: true, sentAt },
        });
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of windows) w.postMessage({ type: 'fc-push', sentAt, receivedAt });
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
          badge: icon,
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
      for (const w of windows) {
        if (!w.url.startsWith(self.registration.scope) || !('focus' in w)) continue;
        if (data.m0) {
          await w.focus();
          w.postMessage({ type: 'fc-notification-click', sentAt: data.sentAt });
          return;
        }
        // The main app (not the check pages) opens the chat itself.
        const path = new URL(w.url).pathname;
        if (path === new URL(self.registration.scope).pathname) {
          await w.focus();
          w.postMessage({ type: 'fc-open-chat', chatId: data.chatId || null, accountId: data.accountId || null });
          return;
        }
      }
      await clients.openWindow(url);
    })(),
  );
});

// ---- Web Share Target (M5, docs/PLAN.md 7.5) ----
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

async function handleShare(event) {
  const scope = self.registration.scope;
  let stored = false;
  try {
    stored = await stashShare(event.request);
  } catch {
    stored = false;
  }
  // The share navigates a window of the app to this address; that window takes the stash.
  return Response.redirect(new URL(stored ? './?share=1' : './?share=unavailable', scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.href !== new URL('share-target', self.registration.scope).href) return;
  event.respondWith(handleShare(event));
});
