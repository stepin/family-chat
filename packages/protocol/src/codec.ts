// base64url (RFC 4648 section 5, no padding) and base32 (RFC 4648 section 6 alphabet,
// lowercase, no padding). Decoders are strict: they reject padding, foreign characters,
// impossible lengths and non-zero trailing bits, so every byte string has exactly one text form.

import type { Bytes } from './bytes.ts';
import { malformed } from './errors.ts';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function table(alphabet: string): Int8Array {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  return t;
}

const B64_T = table(B64);
const B32_T = table(B32);

function encodeBits(bytes: Uint8Array, alphabet: string, bitsPerChar: number): string {
  const mask = (1 << bitsPerChar) - 1;
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet[(acc >>> bits) & mask];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (bitsPerChar - bits)) & mask];
  return out;
}

function decodeBits(text: string, t: Int8Array, bitsPerChar: number, name: string): Bytes {
  if (typeof text !== 'string') throw malformed(`${name}: not a string`);
  const outLen = Math.floor((text.length * bitsPerChar) / 8);
  // A valid length leaves fewer trailing bits than one character carries.
  if ((text.length * bitsPerChar) % 8 >= bitsPerChar) throw malformed(`${name}: invalid length`);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? (t[c] as number) : -1;
    if (v < 0) throw malformed(`${name}: invalid character at position ${i}`);
    acc = (acc << bitsPerChar) | v;
    bits += bitsPerChar;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw malformed(`${name}: non-zero trailing bits`);
  return out;
}

export function base64urlEncode(bytes: Uint8Array): string {
  return encodeBits(bytes, B64, 6);
}

/** Strict base64url decoding (no padding). Throws ProtocolError `malformed`. */
export function base64urlDecode(text: string): Bytes {
  return decodeBits(text, B64_T, 6, 'base64url');
}

export function base32Encode(bytes: Uint8Array): string {
  return encodeBits(bytes, B32, 5);
}

/** Strict lowercase base32 decoding (no padding). Throws ProtocolError `malformed`. */
export function base32Decode(text: string): Bytes {
  return decodeBits(text, B32_T, 5, 'base32');
}

/** Decode base32 and require an exact byte length. */
export function base32DecodeExact(text: unknown, bytes: number, name: string): Bytes {
  if (typeof text !== 'string') throw malformed(`${name}: not a string`);
  const out = base32Decode(text);
  if (out.length !== bytes) throw malformed(`${name}: expected ${bytes} bytes`);
  return out;
}

/** Decode base64url and require an exact byte length. */
export function base64urlDecodeExact(text: unknown, bytes: number, name: string): Bytes {
  if (typeof text !== 'string') throw malformed(`${name}: not a string`);
  const out = base64urlDecode(text);
  if (out.length !== bytes) throw malformed(`${name}: expected ${bytes} bytes`);
  return out;
}
