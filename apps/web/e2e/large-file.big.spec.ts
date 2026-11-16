// A 200 MB file (the server's default limit) sent and received against a
// real fcd, checked byte for byte, with the browser's memory sampled the
// whole way: the copy into app storage, encryption and upload on one side,
// download, decryption and saving on the other. Slow: `pnpm test:e2e:big`.
//
// Memory: the summed resident size (RSS) of every Chromium process of the
// test (an upper bound: shared pages are counted once per process), on macOS
// also the physical footprint per process type at the end of each phase, and
// the JavaScript heap with ArrayBuffer backing stores of both pages (CDP
// Runtime.getHeapUsage). Both people use on-disk profiles: ordinary
// Playwright contexts keep IndexedDB and OPFS in memory. Results go to the
// console and to test-results/large-file-memory.json.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { pairInChat } from './support/media.ts';
import { Fcd } from './support/fcd.ts';
import { expect, makePersistentUser, test, type User } from './support/test.ts';

/** 200 MB by default; FC_BIG_MB=50 for a smaller comparison run. */
const SIZE = Number(process.env['FC_BIG_MB'] ?? 200) * 1024 * 1024;
const MB = 1024 * 1024;

/** Writes `size` deterministic pseudo-random bytes in 8 MiB slices; returns the SHA-256. */
async function makeFile(path: string, size: number): Promise<string> {
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  let x = 0x9e3779b9;
  for (let done = 0; done < size; ) {
    const n = Math.min(8 * MB, size - done);
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      buf.writeUInt32LE(x >>> 0, i);
    }
    hash.update(buf);
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
    done += n;
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  return hash.digest('hex');
}

async function sha256(path: string): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: hash.digest('hex'), size };
}

/** RSS (bytes) of the Playwright Chromium processes, summed and by process type. */
function chromiumRss(): { total: number; byType: Record<string, number> } {
  const out = execFileSync('ps', ['-A', '-o', 'rss=,command='], { encoding: 'utf8', maxBuffer: 16 * MB });
  const byType: Record<string, number> = {};
  let total = 0;
  for (const line of out.split('\n')) {
    if (!/ms-playwright[\\/]chromium/.test(line)) continue;
    const m = /^\s*(\d+)\s/.exec(line);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    const sub = /--utility-sub-type=([\w.]+)/.exec(line)?.[1]?.replace(/\.mojom\.\w+$/, '');
    const type = sub ?? /--type=([\w-]+)/.exec(line)?.[1] ?? 'browser';
    byType[type] = (byType[type] ?? 0) + bytes;
    total += bytes;
  }
  return { total, byType };
}

/**
 * macOS: physical footprint (dirty + compressed memory, what the system
 * counts against the app) per process type, at a moment. Empty elsewhere.
 */
function footprints(): Record<string, number> {
  if (process.platform !== 'darwin') return {};
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * MB });
  const byType: Record<string, number> = {};
  for (const line of out.split('\n')) {
    if (!/ms-playwright[\\/]chromium/.test(line)) continue;
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    if (!pid) continue;
    let fp = 0;
    try {
      const txt = execFileSync('footprint', ['-f', 'bytes', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      fp = Number(/Footprint: (\d+) B/.exec(txt)?.[1] ?? 0);
    } catch {
      continue;
    }
    const sub = /--utility-sub-type=([\w.]+)/.exec(line)?.[1]?.replace(/\.mojom\.\w+$/, '');
    const type = sub ?? /--type=([\w-]+)/.exec(line)?.[1] ?? 'browser';
    byType[type] = (byType[type] ?? 0) + fp;
  }
  return byType;
}

/** JS heap plus ArrayBuffer backing stores (outside the JS heap) of a page. */
async function jsHeap(cdp: CDPSession): Promise<number> {
  const u = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number; embedderHeapUsedSize?: number };
  return u.usedSize + (u.backingStorageSize ?? 0) + (u.embedderHeapUsedSize ?? 0);
}

interface Phase {
  peakRss: number;
  byType: Record<string, number>;
  peakHeapMama: number;
  peakHeapPetya: number;
}

class Sampler {
  readonly phases: Record<string, Phase> = {};
  /** Footprint by process type at the end of each phase (macOS). */
  readonly footprintAtEnd: Record<string, Record<string, number>> = {};
  #phase = 'idle';
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;

  constructor(
    readonly mamaCdp: CDPSession,
    readonly petyaCdp: CDPSession,
  ) {}

  phase(name: string): void {
    if (this.#phase !== 'idle') this.footprintAtEnd[this.#phase] = footprints();
    this.#phase = name;
    this.phases[name] ??= { peakRss: 0, byType: {}, peakHeapMama: 0, peakHeapPetya: 0 };
  }

  async sample(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const p = this.phases[this.#phase] ?? (this.phases[this.#phase] = { peakRss: 0, byType: {}, peakHeapMama: 0, peakHeapPetya: 0 });
      const rss = chromiumRss();
      if (rss.total > p.peakRss) {
        p.peakRss = rss.total;
        p.byType = rss.byType;
      }
      p.peakHeapMama = Math.max(p.peakHeapMama, await jsHeap(this.mamaCdp).catch(() => 0));
      p.peakHeapPetya = Math.max(p.peakHeapPetya, await jsHeap(this.petyaCdp).catch(() => 0));
    } finally {
      this.#busy = false;
    }
  }

  start(): void {
    this.#timer = setInterval(() => void this.sample(), 250);
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  /** Resolves when no sample is in flight. */
  async idle(): Promise<void> {
    while (this.#busy) await new Promise((r) => setTimeout(r, 20));
  }
}

async function cdpFor(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  return cdp;
}

test('a 200 MB file goes up and comes down byte for byte, without being held in memory', async ({ problems }) => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-big-'));
  const fcd = new Fcd();
  const users: User[] = [];
  // On-disk profiles: what a real browser does (see makePersistentUser).
  const newUser = async (options = {}) => {
    const u = await makePersistentUser(problems, mkdtempSync(join(dir, 'profile-')), options);
    users.push(u);
    return u;
  };
  try {
    const file = join(dir, 'большое-видео.bin');
    const expected = await makeFile(file, SIZE);
    await fcd.start(); // default limit: 200 MB
    const { mama, petya } = await pairInChat(newUser, fcd);
    const sampler = new Sampler(await cdpFor(mama.page), await cdpFor(petya.page));
    sampler.phase('baseline');
    for (let i = 0; i < 8; i++) {
      await sampler.sample();
      await mama.page.waitForTimeout(250);
    }
    sampler.start();
    const t0 = Date.now();

    sampler.phase('copy-encrypt-upload');
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page.getByTestId('file-input').setInputFiles(file);
    await mama.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
    const sent = mama.page.getByTestId('message').filter({ hasText: 'большое-видео.bin' });
    await expect(sent).toHaveAttribute('data-status', 'on-server', { timeout: 20 * 60_000 });
    const tUp = Date.now();

    sampler.phase('download-decrypt');
    const card = petya.page.getByTestId('attachment-file').filter({ hasText: 'большое-видео.bin' });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Скачать: большое-видео.bin' }).click();
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 20 * 60_000 });
    const tDown = Date.now();

    sampler.phase('save');
    const download = petya.page.waitForEvent('download');
    await card.getByRole('button', { name: 'Сохранить: большое-видео.bin' }).click();
    const d = await download;
    const saved = await d.path();
    const tSave = Date.now();
    await sampler.sample();
    // What stays after garbage collection (transient buffers versus held data).
    // The periodic sampler records peaks; stop it first, so that a sample
    // taken before the collection is not counted as "after".
    sampler.stop();
    await sampler.idle();
    sampler.phase('after-gc');
    for (const cdp of [sampler.mamaCdp, sampler.petyaCdp]) await cdp.send('HeapProfiler.collectGarbage');
    await petya.page.waitForTimeout(3000);
    await sampler.sample();
    sampler.footprintAtEnd['after-gc'] = footprints();

    const got = await sha256(saved);
    expect(got.size).toBe(SIZE);
    expect(got.hash).toBe(expected);

    const mb = (n: number) => Math.round(n / MB);
    const base = sampler.phases['baseline']!;
    const report = {
      fileBytes: SIZE,
      seconds: { upload: (tUp - t0) / 1000, download: (tDown - tUp) / 1000, save: (tSave - tDown) / 1000 },
      mb: Object.fromEntries(
        Object.entries(sampler.phases).map(([k, p]) => [
          k,
          {
            chromiumRss: mb(p.peakRss),
            rssOverBaseline: mb(p.peakRss - base.peakRss),
            byType: Object.fromEntries(Object.entries(p.byType).map(([t, v]) => [t, mb(v)])),
            jsHeapMama: mb(p.peakHeapMama),
            jsHeapPetya: mb(p.peakHeapPetya),
          },
        ]),
      ),
    };
    const footprintMb = Object.fromEntries(
      Object.entries(sampler.footprintAtEnd).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([t, b]) => [t, mb(b)]))]),
    );
    Object.assign(report, { footprintAtPhaseEndMb: footprintMb });
    console.log(JSON.stringify(report, null, 2));
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'large-file-memory.json'), JSON.stringify(report, null, 2));
    test.info().annotations.push({ type: 'memory', description: JSON.stringify(report.mb) });
    // The JavaScript heap with its ArrayBuffers holds a few parts in flight
    // (garbage until the next collection), never the file: after a collection
    // almost nothing stays.
    const gc = sampler.phases['after-gc']!;
    expect(gc.peakHeapMama).toBeLessThan(32 * MB);
    expect(gc.peakHeapPetya).toBeLessThan(32 * MB);
    for (const p of Object.values(sampler.phases)) {
      expect(p.peakHeapMama).toBeLessThan(160 * MB);
      expect(p.peakHeapPetya).toBeLessThan(160 * MB);
    }
    // macOS: the browser process (where storage and downloads live) does not keep the file.
    const fpBase = sampler.footprintAtEnd['baseline']?.['browser'];
    const fpEnd = sampler.footprintAtEnd['after-gc']?.['browser'];
    if (fpBase !== undefined && fpEnd !== undefined) expect(fpEnd - fpBase).toBeLessThan(64 * MB);
  } finally {
    for (const u of users) await u.context.close().catch(() => undefined);
    await fcd.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
