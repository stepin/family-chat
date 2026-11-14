// Sticker files for the M5 tests, made here (nothing binary is committed):
// a ZIP (stored entries), a `.tgs` (gzip of a small Lottie animation) and a
// real WebP made by the browser itself.

import { gzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { crc32 } from './files.ts';

/** A ZIP with stored (uncompressed) entries. */
export function zipOf(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A two-second Lottie animation: a circle moving across, plus an expression that must never run. */
export function tgs(): Buffer {
  const anim = {
    v: '5.5.2',
    fr: 30,
    ip: 0,
    op: 60,
    w: 512,
    h: 512,
    nm: 'e2e',
    ddd: 0,
    tgs: 1,
    assets: [],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: 'circle',
        ks: {
          o: { a: 0, k: 100 },
          r: { a: 0, k: 0 },
          p: { a: 1, k: [{ t: 0, s: [128, 256, 0], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } }, { t: 60, s: [384, 256, 0] }], x: 'window.__lottieExpression = true' },
          a: { a: 0, k: [0, 0, 0] },
          s: { a: 0, k: [100, 100, 100] },
        },
        shapes: [
          { ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [160, 160] } },
          { ty: 'fl', c: { a: 0, k: [0.18, 0.36, 0.31, 1] }, o: { a: 0, k: 100 } },
        ],
        ip: 0,
        op: 60,
        st: 0,
      },
    ],
  };
  return gzipSync(Buffer.from(JSON.stringify(anim)));
}

/** A real static WebP (512x512) encoded by Chromium. */
export async function webp(page: Page, color = '#e07a5f'): Promise<Buffer> {
  const bytes = await page.evaluate(async (c) => {
    const canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(256, 256, 200, 0, Math.PI * 2);
    ctx.fill();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, color);
  return Buffer.from(bytes);
}

/** Records the Badging API calls of a page (`window.__badges`). */
export const BADGE_STUB = `
  window.__badges = [];
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: (n) => { window.__badges.push(n); return Promise.resolve(); } });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: () => { window.__badges.push(0); return Promise.resolve(); } });
`;
