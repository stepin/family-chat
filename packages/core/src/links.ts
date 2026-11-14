// Identity linking (M5, docs/PLAN.md 8.6): "this is the same person as…".
//
// When a relative started over without the phrase (a new phone), the family
// sees two identities of one person on the same server. After comparing
// fingerprints, a member links them on their own device: the older direct
// chat is then shown inside the newer one as one feed, and group owners are
// offered to add the new identity. The link is local and is never sent to a
// server. It stops applying if either identity's keys change.
//
// Several servers: an identity restored from the same phrase on another
// server has the same userId there (userId comes from the signing key), so
// that case needs no link; the UI shows it as "the same identity".

import { fingerprint } from '@family-chat/protocol';
import type { CoreContext } from './context.ts';
import type { IdentityLinkRow, UserRow } from './db/schema.ts';
import { CoreError } from './errors.ts';

/** Is the link still valid for the current keys of both identities? */
export function linkValid(link: IdentityLinkRow, users: ReadonlyMap<string, UserRow>): boolean {
  const from = users.get(link.userId);
  const to = users.get(link.to);
  return !!from && !!to && fingerprint(from) === link.fromFingerprint && fingerprint(to) === link.toFingerprint;
}

/**
 * Links `a` and `b` (members of the same account, neither me). The identity
 * created earlier becomes the older one. Chains are not allowed: an identity
 * is either linked to another or has others linked to it.
 */
export async function linkIdentities(ctx: CoreContext, accountId: string, me: string, a: string, b: string): Promise<IdentityLinkRow> {
  const { db } = ctx;
  if (a === b || a === me || b === me) throw new CoreError('invalid-input', 'link two other members');
  const [ua, ub] = await Promise.all([db.users.get([accountId, a]), db.users.get([accountId, b])]);
  if (!ua || !ub) throw new CoreError('unknown-user');
  const [older, newer] = ua.created <= ub.created ? [ua, ub] : [ub, ua];
  const existing = await db.links.where('accountId').equals(accountId).toArray();
  if (existing.some((l) => l.userId === newer.userId || l.to === older.userId)) {
    throw new CoreError('invalid-input', 'an identity can be linked only once, without chains');
  }
  if (existing.some((l) => l.userId === older.userId && l.to !== newer.userId)) {
    throw new CoreError('invalid-input', 'this identity is already linked to someone else');
  }
  const row: IdentityLinkRow = {
    accountId,
    userId: older.userId,
    to: newer.userId,
    fromFingerprint: fingerprint(older),
    toFingerprint: fingerprint(newer),
    createdAt: ctx.clock.now(),
  };
  await db.links.put(row);
  return row;
}

/** Removes the link of an identity (either side). */
export async function unlinkIdentity(ctx: CoreContext, accountId: string, userId: string): Promise<void> {
  const { db } = ctx;
  await db.links.delete([accountId, userId]);
  await db.links.where('[accountId+to]').equals([accountId, userId]).delete();
}
