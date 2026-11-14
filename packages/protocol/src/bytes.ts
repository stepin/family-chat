// Byte helpers. Internal: not exported from the package entry point.

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
// fatal: reject invalid UTF-8; ignoreBOM: keep a leading BOM so strict JSON parsing rejects it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8(s: string): Bytes {
  return encoder.encode(s);
}

/** Strict UTF-8 decoding; returns undefined for invalid input. */
export function fromUtf8(b: Uint8Array): string | undefined {
  try {
    return decoder.decode(b);
  } catch {
    return undefined;
  }
}

/** Copy into a fresh ArrayBuffer-backed array (WebCrypto wants BufferSource over ArrayBuffer). */
export function copy(b: Uint8Array): Bytes {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u32be(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32 out of range');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function readU32be(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}

/** Length-prefixed field: u32 big-endian length followed by the bytes. */
export function lp(b: Uint8Array | string): Bytes {
  const bytes = typeof b === 'string' ? utf8(b) : b;
  return concat(u32be(bytes.length), bytes);
}

/** Constant-time comparison for equal-length inputs. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function isAllZero(b: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < b.length; i++) acc |= b[i] as number;
  return acc === 0;
}
