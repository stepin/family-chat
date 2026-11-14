// Notifications: the real state on this device, enabling (permission first,
// then the push subscription handed to the server through core.push).
//
// Several families (M5): a browser keeps one push subscription per app, tied
// to one server's VAPID key, and every family server has its own key. So
// notifications come from one family on this device: the one the person
// enabled them for (by default the family whose server the app was opened
// from). The other families are checked while the app is open; the settings
// say so and offer to move notifications to another family.

import type { AccountView, FamilyChatCore } from '@family-chat/core';
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
 * The family whose server sends this device's notifications: one already
 * registered, else the one whose server the app was opened from, else the
 * first. Removed accounts never.
 */
export function pushAccountOf(accounts: readonly AccountView[], origin: string): AccountView | null {
  const active = accounts.filter((a) => a.status !== 'removed');
  const sameOrigin = (a: AccountView): boolean => {
    try {
      return new URL(a.serverUrl).origin === origin;
    } catch {
      return false;
    }
  };
  const registered = active.filter((a) => a.pushRegistered);
  return registered.find(sameOrigin) ?? registered[0] ?? active.find(sameOrigin) ?? active[0] ?? null;
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
  if (account && pushAccount && pushAccount.id !== account.id && pushAccount.pushRegistered) return 'other-family';
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

async function subscribeAndRegister(core: FamilyChatCore, account: AccountView): Promise<void> {
  if (!account.vapidPublicKey) throw new Error('push is off on the server');
  const key = base64UrlToBytes(account.vapidPublicKey);
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key cannot be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) throw new Error('incomplete subscription');
  await core.push.register(account.id, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
    expirationTime: json.expirationTime ?? null,
  });
}

/**
 * Called straight from the tap: the permission request is the first thing
 * that happens (Safari requires it inside the user gesture).
 */
export async function enableNotifications(
  core: FamilyChatCore,
  account: AccountView,
  accounts: readonly AccountView[] = [account],
): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  // Only one family can have the browser's subscription: the others give it up first.
  for (const other of accounts) {
    if (other.id !== account.id && other.pushRegistered) await core.push.unregister(other.id).catch(() => undefined);
  }
  await subscribeAndRegister(core, account);
  return permission;
}

export async function disableNotifications(core: FamilyChatCore, account: AccountView): Promise<void> {
  await core.push.unregister(account.id);
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => undefined);
}

/**
 * At start: when permission is granted, hand the current subscription to the
 * server again (the server drops subscriptions the push service rejected).
 */
export async function refreshSubscription(core: FamilyChatCore, accounts: readonly AccountView[]): Promise<void> {
  const account = pushAccountOf(accounts, location.origin);
  if (!account) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!account.pushAvailable || !account.vapidPublicKey || !('serviceWorker' in navigator)) return;
  const reg = await registration(5_000);
  const sub = await reg.pushManager.getSubscription();
  if (!sub && !account.pushRegistered) return;
  await subscribeAndRegister(core, account);
}
