// The unread badge on the app icon (M5, docs/PLAN.md 7.5; Badging API).
//
// The rule:
// - While the app is open, the badge is the total unread count over every
//   account on this device that is still a member (`unreadTotal`), and the
//   app stores that number in the settings table (`badge.count`).
// - A push cannot be decrypted to tell a message from anything else, and the
//   service worker does not run the core. It reads the stored number, adds
//   one and stores it again (`badgeAfterPush`, mirrored in
//   apps/web/public/push-sw.js). Pushes only come for new messages: edits,
//   deletions and reactions are sent with the no-push hint.
// - When the app opens (or comes back to the foreground) the badge is set to
//   the real total again, which corrects any drift (a message read on
//   another device while this one was closed, a push for a message that was
//   deleted meanwhile).

import type { AccountRow, ChatRow } from './db/schema.ts';

/** Settings key shared with the service worker. */
export const SETTING_BADGE_COUNT = 'badge.count';
/** Badges do not need to count further. */
export const MAX_BADGE = 9999;

/** Total unread over the accounts that are still members (removed accounts receive nothing new). */
export function unreadTotal(accounts: readonly Pick<AccountRow, 'id' | 'status'>[], chats: readonly Pick<ChatRow, 'accountId' | 'unread'>[]): number {
  const active = new Set(accounts.filter((a) => a.status !== 'removed').map((a) => a.id));
  let n = 0;
  for (const c of chats) if (active.has(c.accountId) && c.unread > 0) n += c.unread;
  return Math.min(n, MAX_BADGE);
}

/** The service worker's step: one more than the stored count (anything odd counts as 0). */
export function badgeAfterPush(stored: unknown): number {
  const n = typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  return Math.min(n + 1, MAX_BADGE);
}

/** Title of the page with the unread count in front (desktop tabs show it). */
export function titleWithUnread(base: string, unread: number): string {
  return unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
}
