// Builds ZIP archives and sticker files in tests, including malicious ones
// (nothing binary is committed).

import { deflateRawSync, gzipSync } from 'node:zlib';
import { crc32 } from '../../src/stickers/zip.ts';

export interface ZipItem {
  readonly name: string;
  readonly data: Uint8Array;
  /** 0 stored, 8 deflate (default), anything else is written as is. */
  readonly method?: number;
  readonly flags?: number;
  /** Lie about the uncompressed size. */
  readonly declaredSize?: number;
  /** Lie about the CRC. */
  readonly crc?: number;
}

const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export function makeZip(items: readonly ZipItem[], options: { centralOverride?: (i: number, offset: number) => number } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localLen = 0;
  items.forEach((it, i) => {
    const method = it.method ?? 8;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(it.data)) : it.data;
    const name = new TextEncoder().encode(it.name);
    const crc = it.crc ?? crc32(it.data);
    const usize = it.declaredSize ?? it.data.length;
    const flags = it.flags ?? 0x0800;
    const at = localLen;
    const head = new Uint8Array([
      ...le32(0x04034b50), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21),
      ...le32(crc), ...le32(comp.length), ...le32(usize), ...le16(name.length), ...le16(0), ...name,
    ]);
    locals.push(head, comp);
    localLen += head.length + comp.length;
    const offset = options.centralOverride ? options.centralOverride(i, at) : at;
    central.push(
      new Uint8Array([
        ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21),
        ...le32(crc), ...le32(comp.length), ...le32(usize), ...le16(name.length), ...le16(0), ...le16(0),
        ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name,
      ]),
    );
  });
  const cdLen = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(items.length), ...le16(items.length), ...le32(cdLen), ...le32(localLen), ...le16(0),
  ]);
  const parts = [...locals, ...central, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A minimal WebP header: VP8X with the animation flag, or a lossy VP8 frame header. */
export function fakeWebp(w: number, h: number, animated = false, pad = 64): Uint8Array {
  const body: number[] = [];
  if (animated) {
    body.push(...[0x56, 0x50, 0x38, 0x58], ...le32(10), 0x02, 0, 0, 0, ...le32(w - 1).slice(0, 3), ...le32(h - 1).slice(0, 3));
  } else {
    body.push(...[0x56, 0x50, 0x38, 0x20], ...le32(10 + pad), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), ...new Array(pad).fill(7));
  }
  const riff = [0x57, 0x45, 0x42, 0x50, ...body];
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, ...le32(riff.length), ...riff]);
}

/** A `.tgs`: gzip of the JSON. */
export function tgsOf(json: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(typeof json === 'string' ? json : JSON.stringify(json))));
}

/** A small, valid Lottie animation with one shape layer. */
export function lottie(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: '5.5.2',
    fr: 60,
    ip: 0,
    op: 180,
    w: 512,
    h: 512,
    nm: 'test',
    ddd: 0,
    tgs: 1,
    assets: [],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: 'shape',
        ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
        shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] } }],
        ip: 0,
        op: 180,
        st: 0,
      },
    ],
    ...over,
  };
}
