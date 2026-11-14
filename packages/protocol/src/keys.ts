// Identity keys derived from the seed with HKDF-SHA-256 (empty salt, info = domain label).

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { copy, utf8, type Bytes } from './bytes.ts';
import { base32Encode } from './codec.ts';
import { PUBLIC_KEY_BYTES, SEED_BYTES, USER_ID_BYTES } from './constants.ts';
import { ProtocolError } from './errors.ts';

export const LABEL_SIGN = 'fc/v1/sign';
export const LABEL_BOX = 'fc/v1/box';
export const LABEL_SELF = 'fc/v1/self';

const EMPTY = new Uint8Array(0);

/** HKDF-SHA-256 with an empty salt, 32 bytes of output. */
export function hkdf32(ikm: Uint8Array, info: Uint8Array): Bytes {
  return copy(hkdf(sha256, ikm, EMPTY, info, 32));
}

export function sha256Bytes(data: Uint8Array): Bytes {
  return copy(sha256(data));
}

/**
 * Secret and public keys of one identity. Holds secrets: never log or serialise it.
 * `selfKey` is reserved for the archive format (M2) and is not used in M1.
 */
export interface IdentityKeys {
  readonly userId: string;
  readonly signPub: Bytes;
  readonly boxPub: Bytes;
  readonly signSecret: Bytes;
  readonly boxSecret: Bytes;
  readonly selfKey: Bytes;
}

/** userId = base32(first 16 bytes of SHA-256(signPub)), 26 characters. */
export function userIdFromSignPub(signPub: Uint8Array): string {
  if (!(signPub instanceof Uint8Array) || signPub.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolError('invalid-argument', `signPub must be ${PUBLIC_KEY_BYTES} bytes`);
  }
  return base32Encode(sha256(signPub).subarray(0, USER_ID_BYTES));
}

export function deriveIdentityKeys(seed: Uint8Array): IdentityKeys {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new ProtocolError('invalid-argument', `seed must be ${SEED_BYTES} bytes`);
  }
  const signSecret = hkdf32(seed, utf8(LABEL_SIGN));
  const boxSecret = hkdf32(seed, utf8(LABEL_BOX));
  const selfKey = hkdf32(seed, utf8(LABEL_SELF));
  const signPub = copy(ed25519.getPublicKey(signSecret));
  const boxPub = copy(x25519.getPublicKey(boxSecret));
  return { userId: userIdFromSignPub(signPub), signPub, boxPub, signSecret, boxSecret, selfKey };
}

/** Ed25519 signature (RFC 8032, deterministic). */
export function sign(message: Uint8Array, signSecret: Uint8Array): Bytes {
  return copy(ed25519.sign(message, signSecret));
}

/**
 * Ed25519 verification with RFC 8032 rules (no ZIP-215 leniency): non-canonical point
 * or scalar encodings are rejected. Small-order public keys are rejected by `checkSignPub`.
 */
export function verify(signature: Uint8Array, message: Uint8Array, signPub: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, signPub, { zip215: false });
  } catch {
    return false;
  }
}

/** Throws `invalid-key` when signPub is not a canonical Ed25519 point of large order. */
export function checkSignPub(signPub: Uint8Array): void {
  let ok = false;
  try {
    ok = !ed25519.Point.fromBytes(signPub, false).isSmallOrder();
  } catch {
    ok = false;
  }
  if (!ok) throw new ProtocolError('invalid-key', 'signPub is not a valid Ed25519 public key');
}
