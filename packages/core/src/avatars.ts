// Avatars (docs/API.md 4.4): upload the image, then sign a profile that names
// it; other members' avatars are fetched with the token, checked against the
// SHA-256 in their signed profile and cached in IndexedDB (at most 256 KB each).
// Resizing and EXIF removal are the UI's job (browser APIs).

import { base64urlEncode, type AvatarRef } from '@family-chat/protocol';
import { isApiError } from './api/errors.ts';
import { updateProfile } from './accounts.ts';
import type { AccountRuntimeLike } from './apply.ts';
import { describeError } from './db/diagnostics.ts';
import type { AvatarRow } from './db/schema.ts';
import { CoreError } from './errors.ts';

export const MAX_AVATAR_BYTES = 262144;

/** JPEG starts with FF D8 FF, WebP with "RIFF", four bytes, "WEBP" (as the server checks). */
export function avatarType(bytes: Uint8Array): 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export async function sha256b64(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return base64urlEncode(new Uint8Array(d));
}

async function toBytes(image: Blob | Uint8Array): Promise<Uint8Array> {
  return image instanceof Uint8Array ? image : new Uint8Array(await image.arrayBuffer());
}

/** Uploads a prepared JPEG or WebP image and signs a profile naming it. */
export async function setAvatar(rt: AccountRuntimeLike, image: Blob | Uint8Array): Promise<AvatarRef> {
  const { ctx, session } = rt;
  const bytes = await toBytes(image);
  const limit = (await ctx.db.accounts.get(session.accountId))?.limits?.maxAvatarBytes ?? MAX_AVATAR_BYTES;
  if (bytes.length === 0) throw new CoreError('invalid-input', 'the image is empty');
  if (bytes.length > limit) throw new CoreError('too-large', `an avatar is at most ${limit} bytes`);
  const type = avatarType(bytes);
  if (!type) throw new CoreError('invalid-input', 'an avatar must be JPEG or WebP');
  const ref = await session.call((t) => session.transport.putAvatar(t, bytes));
  const mine = await sha256b64(bytes);
  if (ref.sha256 !== mine || ref.type !== type) throw new CoreError('invalid-input', 'the server stored another image');
  await ctx.db.avatars.put({ accountId: session.accountId, userId: session.userId, sha256: ref.sha256, type: ref.type, bytes, fetchedAt: ctx.clock.now() });
  await updateProfile(rt, { avatar: ref });
  return ref;
}

export async function removeAvatar(rt: AccountRuntimeLike): Promise<void> {
  await updateProfile(rt, { avatar: null });
}

/**
 * The avatar of a member as named in their verified profile, from the cache
 * or fetched now (checked against its SHA-256). Null when there is none or it
 * is no longer on the server.
 */
export async function fetchAvatar(rt: AccountRuntimeLike, userId: string): Promise<AvatarRow | null> {
  const { ctx, session, directory } = rt;
  const user = await directory.user(userId);
  const ref = user?.avatar;
  if (!ref) return null;
  const cached = await ctx.db.avatars.get([session.accountId, userId]);
  if (cached && cached.sha256 === ref.sha256) return cached;
  let bytes: Uint8Array;
  try {
    bytes = await session.call((t) => session.transport.getAvatar(t, userId, ref.sha256));
  } catch (e) {
    if (isApiError(e, 'not_found')) return null;
    throw e;
  }
  if ((await sha256b64(bytes)) !== ref.sha256) {
    void ctx.diag.warn('verify', `avatar of ${userId} does not match its hash`, session.accountId);
    return null;
  }
  const row: AvatarRow = { accountId: session.accountId, userId, sha256: ref.sha256, type: ref.type, bytes, fetchedAt: ctx.clock.now() };
  await ctx.db.avatars.put(row);
  return row;
}

/** Fetches the avatars named in profiles that are not cached yet (best effort). */
export async function refreshAvatars(rt: AccountRuntimeLike): Promise<void> {
  const { ctx, session } = rt;
  const users = await ctx.db.users.where('accountId').equals(session.accountId).toArray();
  for (const u of users) {
    if (!u.avatar) continue;
    try {
      await fetchAvatar(rt, u.userId);
    } catch (e) {
      void ctx.diag.info('avatar', `avatar of ${u.userId} not fetched: ${describeError(e)}`, session.accountId);
      return;
    }
  }
}
