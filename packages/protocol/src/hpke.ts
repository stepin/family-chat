// HPKE (RFC 9180), base mode only, KEM DHKEM(X25519, HKDF-SHA256) (0x0020), KDF HKDF-SHA256 (0x0001),
// AEAD AES-256-GCM (0x0002). AES-128-GCM (0x0001) is supported only so the implementation can be
// checked against more of the RFC 9180 test vectors. Built from @noble/curves, @noble/hashes and
// WebCrypto AES-GCM; no other dependency.

import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, copy, isAllZero, utf8, type Bytes } from './bytes.ts';
import { GCM_NONCE_BYTES, gcmOpen, gcmSeal } from './aead.ts';
import { ProtocolError } from './errors.ts';
import { randomBytes } from './random.ts';

export const HPKE_KEM_X25519_SHA256 = 0x0020;
export const HPKE_KDF_SHA256 = 0x0001;
export const HPKE_AEAD_AES128GCM = 0x0001;
export const HPKE_AEAD_AES256GCM = 0x0002;
/** Length of `enc` (the ephemeral X25519 public key). */
export const HPKE_ENC_BYTES = 32;

export type HpkeAead = typeof HPKE_AEAD_AES128GCM | typeof HPKE_AEAD_AES256GCM;

const EMPTY = new Uint8Array(0);
const VERSION_LABEL = utf8('HPKE-v1');
const N_SECRET = 32;
const N_H = 32;

function i2osp(n: number, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0 && n > 0; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
}

const KEM_SUITE_ID = concat(utf8('KEM'), i2osp(HPKE_KEM_X25519_SHA256, 2));

function suiteId(aead: HpkeAead): Bytes {
  return concat(utf8('HPKE'), i2osp(HPKE_KEM_X25519_SHA256, 2), i2osp(HPKE_KDF_SHA256, 2), i2osp(aead, 2));
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Bytes {
  return copy(extract(sha256, concat(VERSION_LABEL, suite, utf8(label), ikm), salt));
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number): Bytes {
  return copy(expand(sha256, prk, concat(i2osp(len, 2), VERSION_LABEL, suite, utf8(label), info), len));
}

function dh(sk: Uint8Array, pk: Uint8Array): Bytes {
  let out: Bytes;
  try {
    out = copy(x25519.getSharedSecret(sk, pk));
  } catch {
    throw new ProtocolError('invalid-key', 'X25519 shared secret is invalid (low-order key)');
  }
  // RFC 9180 section 7.1.4: an all-zero DH output must be rejected.
  if (isAllZero(out)) throw new ProtocolError('invalid-key', 'X25519 shared secret is all zero');
  return out;
}

export interface HpkeKeyPair {
  readonly secretKey: Bytes;
  readonly publicKey: Bytes;
}

/** DeriveKeyPair(ikm) of DHKEM(X25519, HKDF-SHA256), RFC 9180 section 7.1.3. */
export function hpkeDeriveKeyPair(ikm: Uint8Array): HpkeKeyPair {
  const dkpPrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'dkp_prk', ikm);
  const secretKey = labeledExpand(KEM_SUITE_ID, dkpPrk, 'sk', EMPTY, 32);
  return { secretKey, publicKey: copy(x25519.getPublicKey(secretKey)) };
}

function extractAndExpand(dhOut: Uint8Array, kemContext: Uint8Array): Bytes {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dhOut);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
}

function checkPublicKey(pk: Uint8Array, what: string): void {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) throw new ProtocolError('invalid-key', `${what} must be 32 bytes`);
}

/** HPKE context of one side. Holds secrets. Sequence numbers start at 0 and grow by one per message. */
export class HpkeContext {
  readonly #key: Bytes;
  readonly #baseNonce: Bytes;
  readonly #exporterSecret: Bytes;
  readonly #suite: Bytes;
  #seq = 0;

  constructor(suite: Bytes, key: Bytes, baseNonce: Bytes, exporterSecret: Bytes) {
    this.#suite = suite;
    this.#key = key;
    this.#baseNonce = baseNonce;
    this.#exporterSecret = exporterSecret;
  }

  #nextNonce(): Bytes {
    // 2^32 messages is far beyond any use here; RFC 9180 limits seq to 2^96 - 1.
    if (this.#seq >= 0xffffffff) throw new ProtocolError('invalid-argument', 'HPKE sequence number overflow');
    const seq = i2osp(this.#seq, GCM_NONCE_BYTES);
    const nonce = new Uint8Array(GCM_NONCE_BYTES);
    for (let i = 0; i < GCM_NONCE_BYTES; i++) nonce[i] = (this.#baseNonce[i] as number) ^ (seq[i] as number);
    return nonce;
  }

  async seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
    const ct = await gcmSeal(this.#key, this.#nextNonce(), aad, plaintext);
    this.#seq++;
    return ct;
  }

  /** Throws ProtocolError `wrong-key` when authentication fails (the sequence number does not advance). */
  async open(aad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
    const pt = await gcmOpen(this.#key, this.#nextNonce(), aad, ciphertext);
    if (!pt) throw new ProtocolError('wrong-key', 'HPKE ciphertext does not open with this key and context');
    this.#seq++;
    return pt;
  }

  /** Secret export, RFC 9180 section 5.3. */
  export(exporterContext: Uint8Array, length: number): Bytes {
    if (!Number.isInteger(length) || length < 0 || length > 255 * N_H) {
      throw new ProtocolError('invalid-argument', 'HPKE export length is out of range');
    }
    return labeledExpand(this.#suite, this.#exporterSecret, 'sec', exporterContext, length);
  }
}

function keySchedule(aead: HpkeAead, sharedSecret: Uint8Array, info: Uint8Array): HpkeContext {
  const suite = suiteId(aead);
  const nk = aead === HPKE_AEAD_AES256GCM ? 32 : 16;
  const pskIdHash = labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(0x00), pskIdHash, infoHash); // mode_base = 0x00
  const secret = labeledExtract(suite, sharedSecret, 'secret', EMPTY);
  return new HpkeContext(
    suite,
    labeledExpand(suite, secret, 'key', context, nk),
    labeledExpand(suite, secret, 'base_nonce', context, GCM_NONCE_BYTES),
    labeledExpand(suite, secret, 'exp', context, N_H),
  );
}

export interface HpkeSender {
  /** The encapsulated key (ephemeral public key), sent with the ciphertext. */
  readonly enc: Bytes;
  readonly context: HpkeContext;
}

/**
 * SetupBaseS. `ikmE` makes the ephemeral key deterministic (test vectors only); by default the
 * ephemeral key comes from 32 random bytes.
 */
export function hpkeSetupSender(
  pkR: Uint8Array,
  info: Uint8Array,
  options: { readonly aead?: HpkeAead; readonly ikmE?: Uint8Array } = {},
): HpkeSender {
  checkPublicKey(pkR, 'HPKE recipient key');
  const eph = hpkeDeriveKeyPair(options.ikmE ?? randomBytes(32));
  const dhOut = dh(eph.secretKey, pkR);
  const enc = eph.publicKey;
  const sharedSecret = extractAndExpand(dhOut, concat(enc, pkR));
  return { enc, context: keySchedule(options.aead ?? HPKE_AEAD_AES256GCM, sharedSecret, info) };
}

/** SetupBaseR. */
export function hpkeSetupRecipient(
  enc: Uint8Array,
  skR: Uint8Array,
  info: Uint8Array,
  options: { readonly aead?: HpkeAead } = {},
): HpkeContext {
  checkPublicKey(enc, 'HPKE enc');
  if (!(skR instanceof Uint8Array) || skR.length !== 32) {
    throw new ProtocolError('invalid-argument', 'HPKE recipient secret key must be 32 bytes');
  }
  const dhOut = dh(skR, enc);
  const pkR = copy(x25519.getPublicKey(skR));
  const sharedSecret = extractAndExpand(dhOut, concat(enc, pkR));
  return keySchedule(options.aead ?? HPKE_AEAD_AES256GCM, sharedSecret, info);
}

/** Single-shot Seal (RFC 9180 section 6.1) with AES-256-GCM. */
export async function hpkeSeal(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  options: { readonly ikmE?: Uint8Array } = {},
): Promise<{ enc: Bytes; ciphertext: Bytes }> {
  const s = hpkeSetupSender(pkR, info, options);
  return { enc: s.enc, ciphertext: await s.context.seal(aad, plaintext) };
}

/** Single-shot Open with AES-256-GCM. Throws `wrong-key` when the ciphertext does not open. */
export async function hpkeOpen(
  enc: Uint8Array,
  skR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Bytes> {
  return hpkeSetupRecipient(enc, skR, info).open(aad, ciphertext);
}
