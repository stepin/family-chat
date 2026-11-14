// Randomness comes only from the platform CSPRNG (WebCrypto getRandomValues).

import type { Bytes } from './bytes.ts';
import { base32Encode } from './codec.ts';
import { DEV_ID_BYTES, MESSAGE_ID_BYTES, SEED_BYTES } from './constants.ts';

export function randomBytes(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 65536) throw new RangeError('randomBytes: invalid length');
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A new 32-byte identity seed. */
export function newSeed(): Bytes {
  return randomBytes(SEED_BYTES);
}

/** Device id: base32 of 10 random bytes (16 characters). */
export function newDevId(): string {
  return base32Encode(randomBytes(DEV_ID_BYTES));
}

/** Message id, also the Idempotency-Key: base32 of 16 random bytes (26 characters). */
export function newMessageId(): string {
  return base32Encode(randomBytes(MESSAGE_ID_BYTES));
}
