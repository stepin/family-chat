// A small, strict ZIP reader for sticker archives (docs/PLAN.md 7.6, 7.8).
//
// Every archive is hostile input. Read from the central directory only:
// no encryption, no ZIP64, no multi-disk archives, methods "stored" and
// "deflate" only; names without absolute paths, drive letters, backslashes,
// NUL or `..`; data ranges inside the file, before the central directory and
// not overlapping (an old zip-bomb trick); declared sizes within the limits
// before anything is inflated; inflation stops at the declared size; the
// compression ratio is capped; CRC-32 must match. Inflation uses the
// platform's DecompressionStream('deflate-raw') (no dependency).

import { StickerError } from './errors.ts';

export interface ZipLimits {
  /** Records in the central directory (files, folders and junk together). */
  readonly maxEntries: number;
  /** Largest uncompressed file. */
  readonly maxFileBytes: number;
  /** All uncompressed files together. */
  readonly maxTotalBytes: number;
  /** Uncompressed / compressed, per file. */
  readonly maxRatio: number;
}

export interface ZipEntry {
  /** Path inside the archive (checked: relative, no `..`). */
  readonly name: string;
  /** Uncompressed size as declared (checked against the bytes when read). */
  readonly size: number;
  /** Reads and checks the file. */
  read(): Promise<Uint8Array>;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Is this a path we accept inside an archive? */
export function safeZipPath(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((seg, i, all) => seg !== '..' && seg !== '.' && (seg !== '' || i === all.length - 1));
}

/**
 * Streams `data` through a decompressor and returns at most `max` bytes;
 * throws StickerError(code) when the output would be longer.
 */
export async function inflateCapped(
  data: Uint8Array,
  format: 'deflate-raw' | 'gzip',
  max: number,
  code: 'file-too-large' | 'tgs-too-big' = 'file-too-large',
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new StickerError('unsupported-browser');
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new StickerError(code);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof StickerError) throw e;
    throw new StickerError(format === 'gzip' ? 'bad-tgs' : 'bad-zip');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Lists a ZIP archive and checks it as a whole (see the file comment). */
export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipEntry[] {
  if (bytes.length < 22) throw new StickerError('bad-zip');
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - MAX_COMMENT);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (u32(bytes, i) === EOCD_SIG && i + 22 + u16(bytes, i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new StickerError('bad-zip');
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new StickerError('zip64');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) throw new StickerError('bad-zip');
  if (count > limits.maxEntries) throw new StickerError('too-many-files');
  if (cdOffset + cdSize > eocd) throw new StickerError('bad-zip');

  const entries: ZipEntry[] = [];
  const ranges: [number, number][] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || u32(bytes, p) !== CEN_SIG) throw new StickerError('bad-zip');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28);
    const elen = u16(bytes, p + 30);
    const clen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    if (p + 46 + nlen + elen + clen > cdOffset + cdSize) throw new StickerError('bad-zip');
    const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (flags & 0x1) throw new StickerError('zip-encrypted');
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new StickerError('zip64');
    if (!safeZipPath(name)) throw new StickerError('bad-path');
    if (name.endsWith('/')) {
      if (usize !== 0) throw new StickerError('bad-zip');
      continue;
    }
    if (method !== 0 && method !== 8) throw new StickerError('bad-compression');
    if (method === 0 && csize !== usize) throw new StickerError('bad-zip');
    if (usize > limits.maxFileBytes) throw new StickerError('file-too-large', name);
    if (usize > 0 && (csize === 0 || usize / csize > limits.maxRatio)) throw new StickerError('ratio', name);
    total += usize;
    if (total > limits.maxTotalBytes) throw new StickerError('too-large-total');

    if (local + 30 > cdOffset || u32(bytes, local) !== LOC_SIG) throw new StickerError('bad-zip');
    const lflags = u16(bytes, local + 6);
    const lmethod = u16(bytes, local + 8);
    if ((lflags & 0x1) !== 0 || lmethod !== method) throw new StickerError('bad-zip');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const end = start + csize;
    if (end > cdOffset) throw new StickerError('bad-zip');
    ranges.push([local, end]);
    entries.push({
      name,
      size: usize,
      read: async () => {
        const data = bytes.subarray(start, end);
        const out = method === 0 ? data.slice() : await inflateCapped(data, 'deflate-raw', usize);
        if (out.length !== usize || crc32(out) !== crc) throw new StickerError('bad-zip', name);
        return out;
      },
    });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) throw new StickerError('bad-zip');
  return entries;
}
