/* global self, clients, indexedDB */
// Web Push handlers, imported into the generated service worker (workbox
// `importScripts` in vite.config.ts).
//
// Every push shows a notification, whatever happens: iOS revokes the
// subscription of a web app that receives pushes silently. The payload is
// `{chatId, gseq}` (docs/API.md 6); names come from the local database
// (read-only, plain IndexedDB, nothing is created or changed). Text is not
// decrypted here in M1.

const DB_NAME = 'family-chat';
const LOOKUP_TIMEOUT_MS = 3000;

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

/** Family name and the other person's name for a chat id, as far as the database knows. */
async function lookup(chatId) {
  const db = await openExisting();
  try {
    const names = ['accounts', 'chats', 'users'];
    if (!names.every((n) => db.objectStoreNames.contains(n))) return {};
    const tx = db.transaction(names, 'readonly');
    const chats = typeof chatId === 'string' ? await request(tx.objectStore('chats').index('chatId').getAll(chatId)) : [];
    const chat = chats[0];
    const accounts = await request(tx.objectStore('accounts').getAll());
    const account = chat ? accounts.find((a) => a.id === chat.accountId) : accounts.length === 1 ? accounts[0] : undefined;
    let peerName = null;
    if (chat) {
      const peer = await request(tx.objectStore('users').get([chat.accountId, chat.peerId]));
      peerName = peer && typeof peer.name === 'string' ? peer.name : null;
    }
    return { familyName: account ? account.familyName : null, peerName };
  } finally {
    db.close();
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
        await self.registration.showNotification(data.title || 'Family Chat', {
          body: data.body || 'Новое сообщение',
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
      const title = info.familyName || 'Family Chat';
      const body = info.peerName ? `Новое сообщение от ${info.peerName}` : 'Новое сообщение';
      const url = new URL(chatId ? `./?chat=${chatId}` : './', scope).href;
      try {
        await self.registration.showNotification(title, {
          body,
          icon,
          badge: icon,
          // One notification per chat; a new message replaces it and alerts again.
          tag: chatId ? `fc-chat-${chatId}` : 'fc-message',
          renotify: true,
          data: { url, chatId },
        });
      } catch {
        await self.registration.showNotification('Family Chat', { body: 'Новое сообщение', icon, data: { url, chatId } });
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
          w.postMessage({ type: 'fc-open-chat', chatId: data.chatId || null });
          return;
        }
      }
      await clients.openWindow(url);
    })(),
  );
});
