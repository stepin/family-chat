// Direct-chat key: dmKey = HKDF(X25519(mySecret, peerBoxPub), "fc/v1/dm" || serverId || sort(idA, idB)).
// The chat with yourself ("Избранное") uses the same formula with peer = self.

import { x25519 } from '@noble/curves/ed25519.js';
import { concat, copy, isAllZero, lp, utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base32Encode } from './codec.ts';
import { DM_EPOCH, PUBLIC_KEY_BYTES, USER_ID_BYTES } from './constants.ts';
import { ProtocolError } from './errors.ts';
import { checkContextString } from './json.ts';
import { hkdf32, sha256Bytes, type IdentityKeys } from './keys.ts';

export const LABEL_DM = 'fc/v1/dm';
export const LABEL_ENC = 'fc/v1/enc';
export const LABEL_DM_CHAT = 'fc/v1/dm\n';

/** Symmetric keys of one chat epoch. Holds secrets. */
export interface ChatKeys {
  readonly epoch: number;
  /** AES-256-GCM key for events: HKDF(secret, "fc/v1/enc"). */
  readonly encKey: Bytes;
}

export interface DmKeys extends ChatKeys {
  /** The direct-chat secret itself; other keys are derived from it. */
  readonly dmKey: Bytes;
}

function checkUserId(id: unknown, what: string): string {
  try {
    base32DecodeExact(id, USER_ID_BYTES, what);
  } catch {
    throw new ProtocolError('invalid-argument', `${what} must be a userId`);
  }
  return id as string;
}

/** The two userIds in byte order (both are ASCII, so code-unit order is byte order). */
function sortedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Encryption key of an epoch secret: HKDF(secret, "fc/v1/enc"). */
export function deriveEncKey(secret: Uint8Array): Bytes {
  return hkdf32(secret, utf8(LABEL_ENC));
}

/**
 * Keys of the direct chat between `me` and `peer` on one server. Throws `invalid-key` when
 * X25519 yields the all-zero shared secret (peer sent a low-order point).
 */
export function deriveDmKeys(
  me: IdentityKeys,
  peer: { readonly userId: string; readonly boxPub: Uint8Array },
  serverId: string,
): DmKeys {
  checkContextString(serverId, 'serverId', 'invalid-argument');
  const peerId = checkUserId(peer.userId, 'peer userId');
  if (!(peer.boxPub instanceof Uint8Array) || peer.boxPub.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolError('invalid-key', 'peer boxPub must be 32 bytes');
  }
  let shared: Bytes;
  try {
    shared = copy(x25519.getSharedSecret(me.boxSecret, peer.boxPub));
  } catch {
    throw new ProtocolError('invalid-key', 'X25519 shared secret is invalid (low-order peer key)');
  }
  if (isAllZero(shared)) throw new ProtocolError('invalid-key', 'X25519 shared secret is all zero');
  const [lo, hi] = sortedPair(me.userId, peerId);
  const info = concat(utf8(LABEL_DM), lp(serverId), lp(lo), lp(hi));
  const dmKey = hkdf32(shared, info);
  shared.fill(0);
  return { epoch: DM_EPOCH, dmKey, encKey: deriveEncKey(dmKey) };
}

/**
 * Public chat id of the direct chat between two users on one server, as the server computes it:
 * base32(first 16 bytes of SHA-256(utf8("fc/v1/dm\n" + serverId + "\n" + lo + "\n" + hi))).
 * No length prefixes here (server contract); the encoding is still injective because lo and hi
 * are fixed 26-character base32 strings, so serverId is everything between the label and the
 * last 54 characters.
 */
export function dmChatId(serverId: string, userIdA: string, userIdB: string): string {
  checkContextString(serverId, 'serverId', 'invalid-argument');
  const [lo, hi] = sortedPair(checkUserId(userIdA, 'userIdA'), checkUserId(userIdB, 'userIdB'));
  const h = sha256Bytes(utf8(`${LABEL_DM_CHAT}${serverId}\n${lo}\n${hi}`));
  return base32Encode(h.subarray(0, 16));
}
