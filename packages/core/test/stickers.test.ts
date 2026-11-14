// M5: the sticker import pipeline with hostile input generated here: ZIP
// limits (bombs, traversal, nested archives, encryption, lies about sizes and
// CRCs, overlapping entries), WebP headers and `.tgs` sanitising.

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_PACK_STICKERS, stickerFileHash } from '@family-chat/protocol';
import { StickerError, type StickerErrorCode } from '../src/stickers/errors.ts';
import { emojiFromName, importStickers, STICKER_ZIP_LIMITS } from '../src/stickers/import.ts';
import { MAX_TGS_JSON_BYTES, readTgs, sanitizeLottie } from '../src/stickers/tgs.ts';
import { webpInfo } from '../src/stickers/webp.ts';
import { readZip, safeZipPath } from '../src/stickers/zip.ts';
import { fakeWebp, lottie, makeZip, tgsOf } from './support/zip.ts';

async function code(p: Promise<unknown> | (() => unknown)): Promise<StickerErrorCode | 'ok'> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'ok';
  } catch (e) {
    if (e instanceof StickerError) return e.code;
    throw e;
  }
}

const zipInput = (items: Parameters<typeof makeZip>[0]) => [{ name: 'pack.zip', data: makeZip(items) }];

describe('zip reader', () => {
  it('reads stored and deflated files and checks the CRC', async () => {
    const a = fakeWebp(512, 512);
    const b = tgsOf(lottie());
    const entries = readZip(makeZip([{ name: 'a.webp', data: a, method: 0 }, { name: 'dir/b.tgs', data: b }]), STICKER_ZIP_LIMITS);
    expect(entries.map((e) => e.name)).toEqual(['a.webp', 'dir/b.tgs']);
    expect(await entries[0]!.read()).toEqual(a);
    expect(await entries[1]!.read()).toEqual(b);
    const bad = readZip(makeZip([{ name: 'a.webp', data: a, crc: 1 }]), STICKER_ZIP_LIMITS);
    expect(await code(bad[0]!.read())).toBe('bad-zip');
  });

  it('refuses paths outside the archive', () => {
    for (const name of ['../evil.webp', 'a/../../evil.webp', '/etc/evil.webp', 'C:/evil.webp', 'c:evil.webp', 'a\\..\\evil.webp', 'a/./b.webp', 'a//b.webp', 'nul\0.webp']) {
      expect([name, safeZipPath(name)]).toEqual([name, false]);
      expect(() => readZip(makeZip([{ name, data: fakeWebp(10, 10) }]), STICKER_ZIP_LIMITS)).toThrow(StickerError);
    }
    expect(safeZipPath('stickers/cat.webp')).toBe(true);
    expect(safeZipPath('stickers/')).toBe(true);
  });

  it('refuses a decompression bomb by its ratio, before inflating', async () => {
    const zeros = new Uint8Array(400 * 1024);
    expect(await code(importStickers(zipInput([{ name: 'bomb.webp', data: zeros }])))).toBe('ratio');
  });

  it('stops inflating at the declared size (a file that lies about its size)', async () => {
    const data = new Uint8Array(300 * 1024).map((_, i) => (i * 7919) % 251);
    const entries = readZip(makeZip([{ name: 'liar.webp', data, declaredSize: 1000 }]), { ...STICKER_ZIP_LIMITS, maxRatio: 1e9 });
    expect(await code(entries[0]!.read())).toBe('file-too-large');
  });

  it('refuses files and archives over the limits', async () => {
    const big = new Uint8Array(STICKER_ZIP_LIMITS.maxFileBytes + 1).map((_, i) => (i * 31) % 256);
    expect(await code(importStickers(zipInput([{ name: 'big.webp', data: big, method: 0 }])))).toBe('file-too-large');
    // The total is checked on the declared sizes, before anything is read.
    const chunk = new Uint8Array(STICKER_ZIP_LIMITS.maxFileBytes).map((_, i) => (i * 13) % 256);
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.webp`, data: chunk, method: 0 }));
    expect(await code(importStickers(zipInput(many)))).toBe('too-large-total');
    const entries = Array.from({ length: STICKER_ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `d${i}/`, data: new Uint8Array(0), method: 0 }));
    expect(await code(importStickers(zipInput(entries)))).toBe('too-many-files');
  });

  it('refuses encryption, unknown methods, overlapping entries and garbage', async () => {
    const w = fakeWebp(64, 64);
    expect(await code(importStickers(zipInput([{ name: 'a.webp', data: w, flags: 0x0801 }])))).toBe('zip-encrypted');
    expect(await code(importStickers(zipInput([{ name: 'a.webp', data: w, method: 12 }])))).toBe('bad-compression');
    // Two central records pointing at one local file: the overlap trick of some zip bombs.
    const overlap = makeZip([{ name: 'a.webp', data: w }, { name: 'b.webp', data: w }], { centralOverride: () => 0 });
    expect(await code(importStickers([{ name: 'x.zip', data: overlap }]))).toBe('bad-zip');
    expect(await code(importStickers([{ name: 'x.zip', data: new TextEncoder().encode('not a zip at all, sorry') }]))).toBe('bad-zip');
    const good = makeZip([{ name: 'a.webp', data: w }]);
    expect(await code(importStickers([{ name: 'cut.zip', data: good.subarray(0, good.length - 5) }]))).toBe('bad-zip');
  });

  it('refuses nested archives and skips junk and unknown files', async () => {
    const inner = makeZip([{ name: 'a.webp', data: fakeWebp(64, 64) }]);
    expect(await code(importStickers(zipInput([{ name: 'inner.zip', data: inner }, { name: 'a.webp', data: fakeWebp(64, 64) }])))).toBe('nested-archive');
    expect(await code(importStickers([{ name: 'loose.zip.gz', data: inner }]))).toBe('nested-archive');
    const r = await importStickers(
      zipInput([
        { name: '__MACOSX/._a.webp', data: new Uint8Array(10) },
        { name: '.DS_Store', data: new Uint8Array(10) },
        { name: 'readme.html', data: new TextEncoder().encode('<script>alert(1)</script>') },
        { name: 'icon.svg', data: new TextEncoder().encode('<svg onload="alert(1)"/>') },
        { name: '😺cat.webp', data: fakeWebp(512, 512) },
      ]),
    );
    expect(r.stickers.map((s) => [s.name, s.emoji])).toEqual([['😺cat.webp', '😺']]);
    expect(r.skipped).toEqual([
      { name: 'readme.html', reason: 'unsupported' },
      { name: 'icon.svg', reason: 'unsupported' },
    ]);
  });
});

describe('webp headers', () => {
  it('reads sides and the animation flag without decoding', () => {
    expect(webpInfo(fakeWebp(512, 400))).toEqual({ width: 512, height: 400, animated: false });
    expect(webpInfo(fakeWebp(512, 512, true))).toEqual({ width: 512, height: 512, animated: true });
    expect(webpInfo(new TextEncoder().encode('RIFF....WEBPVP8 garbage garbage garbage'))).toBeNull();
    expect(webpInfo(new Uint8Array(100))).toBeNull();
  });

  it('import checks sides, sizes, duplicates and counts', async () => {
    const r = await importStickers([
      { name: 'a.webp', data: fakeWebp(512, 512) },
      { name: 'a-copy.webp', data: fakeWebp(512, 512) },
      { name: 'huge.webp', data: fakeWebp(4000, 512) },
      { name: 'png.webp', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(40).fill(0)]) },
      { name: 'b.webp', data: new Blob([fakeWebp(256, 256, true) as Uint8Array<ArrayBuffer>]) },
    ]);
    expect(r.stickers.map((s) => [s.name, s.w, s.h, s.animated, s.file])).toEqual([
      ['a.webp', 512, 512, false, stickerFileHash(fakeWebp(512, 512))],
      ['b.webp', 256, 256, true, stickerFileHash(fakeWebp(256, 256, true))],
    ]);
    expect(r.skipped).toEqual([
      { name: 'a-copy.webp', reason: 'duplicate' },
      { name: 'huge.webp', reason: 'bad-size' },
      { name: 'png.webp', reason: 'bad-webp' },
    ]);
    expect(await code(importStickers([{ name: 'x.txt', data: new Uint8Array(3) }]))).toBe('no-stickers');
    const lots = Array.from({ length: MAX_PACK_STICKERS + 1 }, (_, i) => ({ name: `s${i}.webp`, data: fakeWebp(10 + i, 10) }));
    expect(await code(importStickers(lots))).toBe('too-many-stickers');
  });

  it('takes the emoji from the file name when it starts with one', () => {
    expect(emojiFromName('😂.webp')).toBe('😂');
    expect(emojiFromName('pack/👍🏽 like.tgs')).toBe('👍🏽');
    expect(emojiFromName('cat.webp')).toBe('🙂');
  });
});

describe('tgs sanitising', () => {
  it('removes expressions, external addresses, images, text and fonts', async () => {
    const evil = lottie({
      assets: [
        { id: 'img', w: 10, h: 10, u: 'https://tracker.example/', p: 'pixel.png' },
        { id: 'data', p: 'data:image/png;base64,AAAA', e: 1 },
        { id: 'comp', layers: [{ ty: 4, nm: 'inner', ks: { p: { a: 0, k: [0, 0], x: 'var $bm_rt = fetch("https://evil.example")' } }, shapes: [] }] },
      ],
      fonts: { list: [{ fName: 'x', fPath: 'https://fonts.example/x.css' }] },
      chars: [{ ch: 'a' }],
      markers: [{ tm: 0, cm: 'javascript:alert(1)', dr: 0 }],
      layers: [
        ...(lottie().layers as unknown[]),
        { ty: 2, refId: 'img', nm: 'image layer' },
        { ty: 5, nm: 'text layer', t: { d: { k: [] } } },
        { ty: 0, refId: 'comp', nm: 'precomp', w: 512, h: 512 },
        { ty: 4, nm: 'expr', ks: { o: { a: 0, k: 100, x: 'eval("alert(1)")' }, r: { a: 1, k: [], x: "thisComp.layer('a')" } }, shapes: [{ ty: 'gr', nm: 'https://x.example' }] },
      ],
    });
    const t = await readTgs(tgsOf(evil));
    const text = JSON.stringify(t.data);
    expect(text).not.toMatch(/https?:|data:|javascript:|eval|fetch|thisComp|fPath|fonts|chars|markers/);
    expect((t.data.layers as { ty: number; nm: string }[]).map((l) => [l.ty, l.nm])).toEqual([
      [4, 'shape'],
      [0, 'precomp'],
      [4, 'expr'],
    ]);
    expect((t.data.assets as { id: string }[]).map((a) => a.id)).toEqual(['comp']);
    expect(t.info).toEqual({ width: 512, height: 512, fps: 60, frames: 180 });
  });

  it('caps duration, canvas, layers and the whole tree', async () => {
    expect(await code(() => sanitizeLottie(lottie({ op: 60 * 11 })))).toBe('tgs-too-long');
    expect(await code(() => sanitizeLottie(lottie({ fr: 1000 })))).toBe('tgs-too-long');
    expect(await code(() => sanitizeLottie(lottie({ op: 0 })))).toBe('tgs-too-long');
    expect(await code(() => sanitizeLottie(lottie({ w: 5000 })))).toBe('bad-size');
    expect(await code(() => sanitizeLottie(lottie({ w: 1.5 })))).toBe('bad-size');
    const layer = (lottie().layers as unknown[])[0];
    expect(await code(() => sanitizeLottie(lottie({ layers: Array.from({ length: 501 }, () => layer) })))).toBe('tgs-too-complex');
    // A precomposition that includes itself, and one that multiplies.
    const loop = lottie({ assets: [{ id: 'a', layers: [{ ty: 0, refId: 'a' }] }], layers: [{ ty: 0, refId: 'a' }] });
    expect(await code(() => sanitizeLottie(loop))).toBe('tgs-too-complex');
    const fan = Array.from({ length: 50 }, () => ({ ty: 0, refId: 'b' }));
    const mult = lottie({ assets: [{ id: 'b', layers: Array.from({ length: 50 }, () => layer) }], layers: fan });
    expect(await code(() => sanitizeLottie(mult))).toBe('tgs-too-complex');
    const wide = lottie({ layers: [{ ...(layer as object), shapes: Array.from({ length: 310_000 }, () => []) }] });
    expect(await code(() => sanitizeLottie(wide))).toBe('tgs-too-complex');
    expect(await code(() => sanitizeLottie([1, 2]))).toBe('bad-tgs');
    expect(await code(() => sanitizeLottie({ fr: 60 }))).toBe('bad-tgs');
  });

  it('refuses a gzip bomb, non-gzip and broken JSON', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(MAX_TGS_JSON_BYTES + 1, 0x20)));
    expect(bomb.length).toBeLessThan(10_000);
    expect(await code(readTgs(bomb))).toBe('tgs-too-big');
    expect(await code(readTgs(new TextEncoder().encode(JSON.stringify(lottie()))))).toBe('bad-tgs');
    expect(await code(readTgs(tgsOf('{"v": "5", broken')))).toBe('bad-tgs');
    const deep = '['.repeat(50_000) + ']'.repeat(50_000);
    expect(['bad-tgs', 'tgs-too-complex']).toContain(await code(readTgs(tgsOf(deep))));
    const r = await importStickers([{ name: 'bomb.tgs', data: bomb }, { name: 'ok.tgs', data: tgsOf(lottie()) }]);
    expect(r.skipped).toEqual([{ name: 'bomb.tgs', reason: 'tgs-too-big' }]);
    expect(r.stickers[0]).toMatchObject({ type: 'tgs', w: 512, h: 512, animated: true });
  });
});
