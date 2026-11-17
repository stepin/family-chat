// A Telegram sticker set by its link (`t.me/addstickers/<name>`). The family
// server holds the bot token and asks Telegram; this device gets the list and
// then the files, three at a time (the server's limit per device), and puts
// every file through the same checks as an import from files. Video stickers
// are left out and counted.

import type { TelegramSet } from '../api/types.ts';
import { ApiError, NetworkError } from '../api/errors.ts';
import { PackAccumulator, type ImportedSticker, type StickerImport, type TelegramSource } from './import.ts';
import { parseTelegramSetLink, TelegramImportError, type TelegramImportCode } from './telegram-link.ts';

export type TelegramProgress =
  | { readonly phase: 'opening' }
  /** The server or Telegram asks to wait this many seconds. */
  | { readonly phase: 'waiting'; readonly seconds: number; readonly done: number; readonly total: number }
  | { readonly phase: 'loading'; readonly done: number; readonly total: number };

/** What the import needs from the family server (the transport with a token). */
export interface TelegramApi {
  set(name: string, signal: AbortSignal): Promise<TelegramSet>;
  file(name: string, id: string, signal: AbortSignal): Promise<Uint8Array>;
}

export interface TelegramImportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: TelegramProgress) => void;
  /** A previous result: only its failed stickers are loaded again, the order of the set kept. */
  readonly retry?: StickerImport;
  /** Waits (injectable for tests). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Files loaded at the same time (the server allows 3 per device). */
export const TELEGRAM_CONCURRENCY = 3;
/** Waits on `Retry-After` per file before it counts as failed. */
export const TELEGRAM_MAX_WAITS = 3;

const KNOWN: ReadonlySet<string> = new Set([
  'telegram_disabled',
  'not_found',
  'telegram_unavailable',
  'telegram_busy',
  'rate_limited',
  'telegram_emoji_set',
  'bad_request',
]);

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/** An error of the transport as a TelegramImportError (or AbortError when the import was cancelled). */
function toImportError(e: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || (e instanceof NetworkError && e.reason === 'aborted')) return abortError();
  if (e instanceof DOMException && e.name === 'AbortError') return e;
  if (e instanceof ApiError) {
    const code = (KNOWN.has(e.code) ? e.code : 'other') as TelegramImportCode;
    const retry = e.retryAfterMs !== undefined ? Math.ceil(e.retryAfterMs / 1000) : undefined;
    return new TelegramImportError(code, e.status, e.reason, retry);
  }
  if (e instanceof NetworkError) return new TelegramImportError('offline', 0, e.reason);
  return e;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Imports a Telegram set by its link into a pack preview (the same
 * `StickerImport` as files give). Throws TelegramImportError for a bad link,
 * a server or Telegram error, a video-only set or when no file loaded;
 * DOMException `AbortError` when cancelled.
 */
export async function importTelegramStickers(api: TelegramApi, link: string, opts: TelegramImportOptions = {}): Promise<StickerImport> {
  const parsed = parseTelegramSetLink(link);
  if (!parsed) throw new TelegramImportError('bad_link');
  if (parsed.kind === 'emoji') throw new TelegramImportError('emoji_link');
  const signal = opts.signal ?? new AbortController().signal;
  const sleep = opts.sleep ?? defaultSleep;
  let restarted = false;
  for (;;) {
    try {
      return await importOnce(api, parsed.name, signal, sleep, opts);
    } catch (e) {
      // The set changed between the list and a file: start again once, with a fresh list.
      if (e instanceof StaleSet && !restarted) {
        restarted = true;
        opts = { ...opts, retry: undefined };
        continue;
      }
      if (e instanceof StaleSet) throw new TelegramImportError('not_found', 404, 'stale_set');
      throw e;
    }
  }
}

class StaleSet extends Error {}

async function importOnce(
  api: TelegramApi,
  name: string,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  opts: TelegramImportOptions,
): Promise<StickerImport> {
  const progress = (p: TelegramProgress) => {
    try {
      opts.onProgress?.(p);
    } catch {
      // A broken listener must not break the import.
    }
  };
  if (signal.aborted) throw abortError();
  const prev = opts.retry?.telegram;
  let source: TelegramSource;
  if (prev && prev.name.toLowerCase() === name.toLowerCase()) {
    source = prev;
  } else {
    progress({ phase: 'opening' });
    let set: TelegramSet | undefined;
    for (let waits = 0; !set; waits++) {
      try {
        set = await api.set(name, signal);
      } catch (e) {
        const err = toImportError(e, signal);
        if (err instanceof TelegramImportError && (err.code === 'telegram_busy' || err.code === 'rate_limited') && waits < TELEGRAM_MAX_WAITS) {
          const seconds = Math.max(1, err.retryAfter ?? 5);
          progress({ phase: 'waiting', seconds, done: 0, total: 0 });
          await sleep(seconds * 1000, signal);
          continue;
        }
        throw err;
      }
    }
    if (set.stickers.length === 0) {
      throw new TelegramImportError(set.skipped.video > 0 ? 'video_only' : 'no_stickers');
    }
    source = {
      name,
      title: set.title,
      order: set.stickers.map((s) => s.id),
      failed: [],
      emoji: Object.fromEntries(set.stickers.map((s) => [s.id, s.emoji])),
      types: Object.fromEntries(set.stickers.map((s) => [s.id, s.type])),
      video: set.skipped.video,
      other: set.skipped.other,
    };
  }

  // What is loaded already (a retry keeps the stickers that loaded before).
  const kept = new Map<string, ImportedSticker>();
  for (const s of opts.retry?.stickers ?? []) if (s.telegramId) kept.set(s.telegramId, s);
  const todo = prev === source ? source.failed : source.order;
  const total = source.order.length;
  const bytes = new Map<string, Uint8Array>();
  let done = total - todo.length;
  progress({ phase: 'loading', done, total });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const id = todo[next++]!;
      for (let waits = 0; ; waits++) {
        if (signal.aborted) throw abortError();
        try {
          bytes.set(id, await api.file(source.name, id, signal));
          break;
        } catch (e) {
          const err = toImportError(e, signal);
          if (!(err instanceof TelegramImportError)) throw err;
          if (err.code === 'not_found' && err.reason === 'stale_set') throw new StaleSet();
          if ((err.code === 'telegram_busy' || err.code === 'rate_limited') && waits < TELEGRAM_MAX_WAITS) {
            const seconds = Math.max(1, err.retryAfter ?? 1);
            progress({ phase: 'waiting', seconds, done, total });
            await sleep(seconds * 1000, signal);
            continue;
          }
          // Disabled or a rejected token stops everything; the rest count as failed.
          if (err.code === 'telegram_disabled' || err.reason === 'token_rejected') throw err;
          break;
        }
      }
      done++;
      progress({ phase: 'loading', done, total });
    }
  };
  await Promise.all(Array.from({ length: Math.min(TELEGRAM_CONCURRENCY, todo.length) }, worker));

  // Checked in the set's order, through the same accumulator as files.
  const acc = new PackAccumulator();
  const failed: string[] = [];
  for (const id of source.order) {
    const old = kept.get(id);
    const type = source.types[id] ?? 'webp';
    const name = `${id}.${type}`;
    const data = bytes.get(id) ?? old?.bytes;
    if (!data) {
      failed.push(id);
      continue;
    }
    const ok = await acc.add(name, type, () => Promise.resolve(data), { emoji: source.emoji[id] ?? null, telegramId: id });
    if (!ok && acc.skipped.at(-1)?.reason !== 'duplicate') failed.push(id);
  }
  if (acc.stickers.length === 0) throw new TelegramImportError('no_stickers');
  const skipped: StickerImport['skipped'] = [
    ...Array.from({ length: source.video }, () => ({ name: 'video', reason: 'video' as const })),
    ...Array.from({ length: source.other }, () => ({ name: 'other', reason: 'unsupported' as const })),
    ...acc.skipped,
    ...failed.filter((id) => !acc.skipped.some((s) => s.name.startsWith(`${id}.`))).map((id) => ({ name: id, reason: 'download-failed' as const })),
  ];
  return { stickers: acc.stickers, skipped, telegram: { ...source, failed } };
}
