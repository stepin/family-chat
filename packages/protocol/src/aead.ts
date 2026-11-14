// AES-GCM through WebCrypto. Internal.

import { concat, copy, u32be, type Bytes } from './bytes.ts';

export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;

function importKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', copy(raw), { name: 'AES-GCM' }, false, [usage]);
}

/** AES-GCM encryption (key of 16 or 32 bytes); returns ciphertext || tag. */
export async function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
  const k = await importKey(key, 'encrypt');
  return new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copy(nonce), additionalData: copy(aad), tagLength: 128 },
      k,
      copy(plaintext),
    ),
  );
}

/** AES-GCM decryption; returns undefined when authentication fails. */
export async function gcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Bytes | undefined> {
  if (ciphertext.length < GCM_TAG_BYTES) return undefined;
  try {
    const k = await importKey(key, 'decrypt');
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: copy(nonce), additionalData: copy(aad), tagLength: 128 },
        k,
        copy(ciphertext),
      ),
    );
  } catch {
    return undefined;
  }
}

/** 96-bit nonce equal to a counter: 8 zero bytes || u32 big-endian. */
export function counterNonce(n: number): Bytes {
  return concat(new Uint8Array(8), u32be(n));
}
