// Notifications: the real state on this device, enabling (permission first,
// then the push subscription handed to the server through core.push).
//
// Several families: a browser keeps one push subscription per app (one
// service worker per fcd), tied to one VAPID key. All families of one fcd
// share its key, so the one subscription is registered with every family of
// that server on the device, and each family can be turned off by itself.
// Families on other servers have other keys: notifications then come from
// the families of one server only; the others are checked while the app is
// open, and the settings offer to move notifications.

import type { AccountView, FamilyChatCore } from '@family-chat/core';
import { pageServerUrl, sameServer } from './invite.ts';
import type { PlatformInfo } from './platform.ts';

export type NotifyState =
  /** Permission granted and this device is registered on the server. */
  | 'allowed'
  /** Permission granted, but no subscription on the server yet. */
  | 'granted-unregistered'
  /** Not asked yet. */
  | 'off'
  /** The person refused in the browser. */
  | 'denied'
  /** iOS outside the installed app: add to the Home Screen first. */
  | 'ios-install'
  /** The browser cannot receive Web Push. */
  | 'unsupported'
  /** The family server has push turned off. */
  | 'server-off'
  /** Notifications come from another family on this device (one subscription per browser). */
  | 'other-family';

export interface NotifyEnv {
  readonly hasNotification: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly permission: NotificationPermission | null;
}

export function notifyEnv(): NotifyEnv {
  return {
    hasNotification: typeof Notification !== 'undefined',
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: typeof PushManager !== 'undefined',
    permission: typeof Notification !== 'undefined' ? Notification.permission : null,
  };
}

/**
 * The family whose key owns this device's subscription: one already
 * registered (the family of the page's address first), else the family of
 * the page's address, else the first. Removed accounts never. The page's
 * address is compared with its path: on one host the root family and a
 * family at /f/<id> are different families.
 */
export function pushAccountOf(accounts: readonly AccountView[], pageUrl: string): AccountView | null {
  const active = accounts.filter((a) => a.status !== 'removed');
  const onPage = (a: AccountView): boolean => sameServer(a.serverUrl, pageUrl);
  const registered = active.filter((a) => a.pushRegistered);
  return registered.find(onPage) ?? registered[0] ?? active.find(onPage) ?? active[0] ?? null;
}

/** The other families on this device that share `account`'s push key (families of the same fcd). */
export function sameKeyFamilies(accounts: readonly AccountView[], account: AccountView): AccountView[] {
  return accounts.filter(
    (a) => a.id !== account.id && a.status === 'active' && a.pushAvailable && !!a.vapidPublicKey && a.vapidPublicKey === account.vapidPublicKey,
  );
}

export function notifyState(
  env: NotifyEnv,
  platform: PlatformInfo,
  account: AccountView | null,
  pushAccount: AccountView | null = account,
): NotifyState {
  if (platform.os === 'ios' && !platform.standalone) return 'ios-install';
  if (!env.hasNotification || !env.hasServiceWorker || !env.hasPushManager) return 'unsupported';
  if (account && (!account.pushAvailable || !account.vapidPublicKey)) return 'server-off';
  // Families with the same key share the subscription: never "another family" for each other.
  if (account && pushAccount && pushAccount.id !== account.id && pushAccount.pushRegistered && pushAccount.vapidPublicKey !== account.vapidPublicKey) {
    return 'other-family';
  }
  if (env.permission === 'denied') return 'denied';
  if (env.permission === 'granted') return account?.pushRegistered ? 'allowed' : 'granted-unregistered';
  return 'off';
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function registration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('service worker not ready')), timeoutMs)),
  ]);
}

/** The browser's subscription for `vapidPublicKey`, made anew when it belongs to another key. */
async function subscription(vapidPublicKey: string): Promise<PushSubscription> {
  const key = base64UrlToBytes(vapidPublicKey);
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key cannot be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  return sub ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
}

async function register(core: FamilyChatCore, account: AccountView, sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) throw new Error('incomplete subscription');
  await core.push.register(account.id, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    expirationTime: json.expirationTime ?? null,
  });
}

export interface EnableResult {
  readonly permission: NotificationPermission;
  /** Families with the same key whose server did not take the subscription (shown with "Повторить"). */
  readonly failed: readonly AccountView[];
}

/**
 * Called straight from the tap: the permission request is the first thing
 * that happens (Safari requires it inside the user gesture). Turns
 * notifications on for `account` and every family of the same server on
 * this device; families of other servers give the subscription up.
 */
export async function enableNotifications(
  core: FamilyChatCore,
  account: AccountView,
  accounts: readonly AccountView[] = [account],
): Promise<EnableResult> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { permission, failed: [] };
  if (!account.vapidPublicKey) throw new Error('push is off on the server');
  // Only one key can have the browser's subscription: families with another key give it up first.
  for (const other of accounts) {
    if (other.id !== account.id && other.pushRegistered && other.vapidPublicKey !== account.vapidPublicKey) {
      await core.push.unregister(other.id).catch(() => undefined);
    }
  }
  const sub = await subscription(account.vapidPublicKey);
  await register(core, account, sub);
  const failed: AccountView[] = [];
  for (const other of sameKeyFamilies(accounts, account)) {
    try {
      await register(core, other, sub);
    } catch {
      failed.push(other);
    }
  }
  return { permission, failed };
}

/** "Повторить" for one family whose registration failed. */
export async function retryNotifications(core: FamilyChatCore, account: AccountView): Promise<void> {
  if (!account.vapidPublicKey) throw new Error('push is off on the server');
  await register(core, account, await subscription(account.vapidPublicKey));
}

/**
 * Turns notifications off for this family only: its server forgets the
 * subscription; the browser's subscription is removed only when no other
 * family of the same server still uses it.
 */
export async function disableNotifications(
  core: FamilyChatCore,
  account: AccountView,
  accounts: readonly AccountView[] = [account],
): Promise<void> {
  await core.push.unregister(account.id);
  if (sameKeyFamilies(accounts, account).some((a) => a.pushRegistered)) return;
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => undefined);
}

/**
 * At start: when permission is granted, hand the current subscription to the
 * server of every family that wants notifications and shares its key (the
 * server drops subscriptions the push service rejected). A family added
 * later joins when another family with the same key wants notifications; a
 * family turned off stays off.
 */
export async function refreshSubscription(core: FamilyChatCore, accounts: readonly AccountView[], pageUrl = pageServerUrl(location)): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  const owner = pushAccountOf(accounts, pageUrl);
  if (!owner?.pushAvailable || !owner.vapidPublicKey) return;
  const reg = await registration(5_000);
  const current = await reg.pushManager.getSubscription();
  const key = current ? current.options.applicationServerKey : null;
  const keyOf = (a: AccountView): boolean => !!a.vapidPublicKey && (key ? sameKey(key, base64UrlToBytes(a.vapidPublicKey)) : a.vapidPublicKey === owner.vapidPublicKey);
  const family = [owner, ...sameKeyFamilies(accounts, owner)].filter((a) => a.status === 'active' && a.pushAvailable && keyOf(a));
  const anyWanted = family.some((a) => a.pushWanted === true);
  if (!anyWanted && !current) return;
  const targets = family.filter((a) => a.pushWanted === true || (a.pushWanted === null && anyWanted));
  if (targets.length === 0) return;
  const sub = await subscription(targets[0]!.vapidPublicKey!);
  for (const a of targets) await register(core, a, sub).catch(() => undefined);
}
