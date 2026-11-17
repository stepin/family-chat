// Telegram sticker sets by link: the link parser, the import through the
// shared accumulator (order, duplicates, failed files, retry), waits on
// Retry-After, cancelling, and the typed errors through the real transport.

import { describe, expect, it } from 'vitest';
import { Transport } from '../src/api/transport.ts';
import type { TelegramSet } from '../src/api/types.ts';
import { importTelegramStickers, type TelegramApi, type TelegramProgress } from '../src/stickers/telegram.ts';
import { isTelegramImportError, parseTelegramSetLink, TelegramImportError } from '../src/stickers/telegram-link.ts';
import { ApiError, NetworkError } from '../src/api/errors.ts';
import { fakeWebp, lottie, tgsOf } from './support/zip.ts';

describe('parseTelegramSetLink', () => {
  it('reads every form of a set link and refuses the rest', () => {
    for (const s of [
      'https://t.me/addstickers/Cats_by_bot',
      't.me/addstickers/Cats_by_bot',
      'http://telegram.me/addstickers/Cats_by_bot/',
      'https://t.me/addstickers/Cats_by_bot?x=1',
      'tg://addstickers?set=Cats_by_bot',
      '  Cats_by_bot  ',
    ]) {
      expect([s, parseTelegramSetLink(s)]).toEqual([s, { kind: 'set', name: 'Cats_by_bot' }]);
    }
    expect(parseTelegramSetLink('https://t.me/addemoji/Hearts')).toEqual({ kind: 'emoji', name: 'Hearts' });
    expect(parseTelegramSetLink('tg://addemoji?set=Hearts')).toEqual({ kind: 'emoji', name: 'Hearts' });
    for (const s of ['', 'https://example.org/addstickers/Cats', 'https://t.me/Cats', 'cats and dogs', 'https://t.me/addstickers/a-b', 'x'.repeat(65)]) {
      expect([s, parseTelegramSetLink(s)]).toEqual([s, null]);
    }
  });
});

const W1 = fakeWebp(512, 512, false, 100);
const W2 = fakeWebp(512, 512, false, 200);
const T1 = tgsOf(lottie());

function setOf(ids: [string, 'webp' | 'tgs'][], video = 0): TelegramSet {
  return { name: 'Cats', title: 'Коты', stickers: ids.map(([id, type]) => ({ id, emoji: '😺', type })), skipped: { video, other: 0 } };
}

/** A fake server: `files` by id; a function answer can throw. */
function fakeApi(set: TelegramSet | (() => TelegramSet), files: Record<string, Uint8Array | (() => Uint8Array)>): TelegramApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    set: async () => {
      calls.push('set');
      return typeof set === 'function' ? set() : set;
    },
    file: async (_name, id) => {
      calls.push(id);
      const f = files[id];
      if (!f) throw new ApiError(502, 'telegram_unavailable', 'GET file', { reason: 'upstream_error' });
      return typeof f === 'function' ? f() : f;
    },
  };
}

const noSleep = async () => {};

describe('importTelegramStickers', () => {
  it('loads a set in order, with Telegram emoji, title and counts', async () => {
    const api = fakeApi(setOf([['a', 'webp'], ['b', 'tgs'], ['c', 'webp']], 2), { a: W1, b: T1, c: W2 });
    const seen: TelegramProgress[] = [];
    const r = await importTelegramStickers(api, 'https://t.me/addstickers/Cats', { onProgress: (p) => seen.push(p), sleep: noSleep });
    expect(r.stickers.map((s) => s.telegramId)).toEqual(['a', 'b', 'c']);
    expect(r.stickers.every((s) => s.emoji === '😺')).toBe(true);
    expect(r.telegram?.title).toBe('Коты');
    expect(r.telegram?.video).toBe(2);
    expect(r.telegram?.failed).toEqual([]);
    expect(r.skipped.filter((s) => s.reason === 'video')).toHaveLength(2);
    expect(seen[0]).toEqual({ phase: 'opening' });
    expect(seen.at(-1)).toEqual({ phase: 'loading', done: 3, total: 3 });
  });

  it('keeps failed files for a retry that loads only them, in the set order', async () => {
    let bOk = false;
    const files = {
      a: W1,
      b: () => {
        if (!bOk) throw new ApiError(502, 'telegram_unavailable', 'GET file', { reason: 'timeout' });
        return T1;
      },
      c: W2,
    };
    const api = fakeApi(setOf([['a', 'webp'], ['b', 'tgs'], ['c', 'webp']]), files);
    const first = await importTelegramStickers(api, 'Cats', { sleep: noSleep });
    expect(first.stickers.map((s) => s.telegramId)).toEqual(['a', 'c']);
    expect(first.telegram?.failed).toEqual(['b']);
    expect(first.skipped).toContainEqual({ name: 'b', reason: 'download-failed' });
    bOk = true;
    api.calls.length = 0;
    const second = await importTelegramStickers(api, 'Cats', { retry: first, sleep: noSleep });
    expect(api.calls).toEqual(['b']);
    expect(second.stickers.map((s) => s.telegramId)).toEqual(['a', 'b', 'c']);
    expect(second.telegram?.failed).toEqual([]);
  });

  it('duplicates go through the shared accumulator', async () => {
    const api = fakeApi(setOf([['a', 'webp'], ['b', 'webp']]), { a: W1, b: W1 });
    const r = await importTelegramStickers(api, 'Cats', { sleep: noSleep });
    expect(r.stickers).toHaveLength(1);
    expect(r.skipped).toContainEqual({ name: 'b.webp', reason: 'duplicate' });
    expect(r.telegram?.failed).toEqual([]);
  });

  it('waits on Retry-After at most 3 times per file, then counts it as failed', async () => {
    let busy = 0;
    const api = fakeApi(setOf([['a', 'webp'], ['b', 'webp']]), {
      a: W1,
      b: () => {
        busy++;
        throw new ApiError(503, 'telegram_busy', 'GET file', { retryAfterMs: 7000 });
      },
    });
    const waits: number[] = [];
    const r = await importTelegramStickers(api, 'Cats', {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(busy).toBe(4);
    expect(waits).toEqual([7000, 7000, 7000]);
    expect(r.telegram?.failed).toEqual(['b']);
  });

  it('errors: bad and emoji links, video only, nothing loaded, server codes', async () => {
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return isTelegramImportError(e) ? e.code : String(e);
      }
    };
    const ok = fakeApi(setOf([['a', 'webp']]), { a: W1 });
    expect(await code(importTelegramStickers(ok, 'hello world'))).toBe('bad_link');
    expect(await code(importTelegramStickers(ok, 't.me/addemoji/Hearts'))).toBe('emoji_link');
    expect(await code(importTelegramStickers(fakeApi(setOf([], 5), {}), 'Cats'))).toBe('video_only');
    expect(await code(importTelegramStickers(fakeApi(setOf([['a', 'webp']]), {}), 'Cats', { sleep: noSleep }))).toBe('no_stickers');
    const err = (e: Error): TelegramApi => ({
      set: async () => {
        throw e;
      },
      file: async () => new Uint8Array(),
    });
    expect(await code(importTelegramStickers(err(new ApiError(404, 'telegram_disabled', 'x')), 'Cats'))).toBe('telegram_disabled');
    expect(await code(importTelegramStickers(err(new ApiError(422, 'telegram_emoji_set', 'x')), 'Cats'))).toBe('telegram_emoji_set');
    expect(await code(importTelegramStickers(err(new NetworkError('offline', 'x')), 'Cats'))).toBe('offline');
    const unavailable = await importTelegramStickers(err(new ApiError(502, 'telegram_unavailable', 'x', { reason: 'token_rejected' })), 'Cats').catch((e) => e);
    expect(unavailable).toBeInstanceOf(TelegramImportError);
    expect(unavailable.reason).toBe('token_rejected');
    expect(unavailable.status).toBe(502);
  });

  it('a stale set restarts the import once with a fresh list', async () => {
    let lists = 0;
    let stale = true;
    const api: TelegramApi = {
      set: async () => {
        lists++;
        return setOf([['a', 'webp']]);
      },
      file: async () => {
        if (stale) {
          stale = false;
          throw new ApiError(404, 'not_found', 'GET file', { reason: 'stale_set' });
        }
        return W1;
      },
    };
    const r = await importTelegramStickers(api, 'Cats', { sleep: noSleep });
    expect(lists).toBe(2);
    expect(r.stickers).toHaveLength(1);
  });
});

describe('through the real transport', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  function transport(answer: (url: string, init: RequestInit) => Promise<Response>) {
    const t = new Transport({ baseUrl: 'https://chat.example.org/f/abcd', fetch: answer });
    const api: TelegramApi = {
      set: (name, signal) => t.telegramSet('tok', name, signal),
      file: (name, id, signal) => t.telegramFile('tok', name, id, signal),
    };
    return api;
  }

  it('maps reason and Retry-After of the server into the typed error', async () => {
    const api = transport(async () => json(503, { error: 'telegram_busy', message: 'wait' }, { 'retry-after': '120' }));
    const waits: number[] = [];
    const e = await importTelegramStickers(api, 'Cats', { sleep: async (ms) => void waits.push(ms) }).catch((x) => x);
    expect(e).toBeInstanceOf(TelegramImportError);
    expect(e.code).toBe('telegram_busy');
    expect(e.retryAfter).toBe(120);
    expect(waits).toEqual([120_000, 120_000, 120_000]);
  });

  it('a cancel is an AbortError, not an error of the server', async () => {
    const ctl = new AbortController();
    const urls: string[] = [];
    const api = transport(async (url, init) => {
      urls.push(url);
      if (url.endsWith('/v1/telegram/sets/Cats')) return json(200, { name: 'Cats', title: 'C', stickers: [{ id: 'a', emoji: null, type: 'webp' }], skipped: { video: 0, other: 0 } });
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        ctl.abort();
      });
    });
    const e = await importTelegramStickers(api, 'Cats', { signal: ctl.signal }).catch((x) => x);
    expect(e).toBeInstanceOf(DOMException);
    expect(e.name).toBe('AbortError');
    // Paths are relative to the family address.
    expect(urls[0]).toBe('https://chat.example.org/f/abcd/v1/telegram/sets/Cats');
    expect(urls[1]).toBe('https://chat.example.org/f/abcd/v1/telegram/sets/Cats/files/a');
  });
});
