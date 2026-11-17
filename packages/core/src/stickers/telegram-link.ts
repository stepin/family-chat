// Telegram set links and the errors of an import by link: small and
// dependency-free, so the interface can check a pasted link before the
// import code (stickers/telegram.ts) is loaded.

/** What a link names: a sticker set, or a set of custom emoji (not supported). */
export type TelegramLink = { readonly kind: 'set' | 'emoji'; readonly name: string };

const NAME = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Reads a set name from what a person pasted: `https://t.me/addstickers/N`,
 * `t.me/addstickers/N`, `telegram.me/addstickers/N`, `tg://addstickers?set=N`
 * or the bare name. `addemoji` links give `kind: 'emoji'`. Null when it is
 * none of these.
 */
export function parseTelegramSetLink(text: string): TelegramLink | null {
  const s = text.trim();
  if (NAME.test(s)) return { kind: 'set', name: s };
  const tg = /^tg:\/\/(addstickers|addemoji)\?(.*)$/i.exec(s);
  if (tg) {
    const name = new URLSearchParams(tg[2]!.split('#')[0]).get('set') ?? '';
    return NAME.test(name) ? { kind: tg[1]!.toLowerCase() === 'addemoji' ? 'emoji' : 'set', name } : null;
  }
  const web = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(addstickers|addemoji)\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(s);
  if (web && NAME.test(web[2]!)) return { kind: web[1]!.toLowerCase() === 'addemoji' ? 'emoji' : 'set', name: web[2]! };
  return null;
}

/** Codes of a failed Telegram import (server codes plus a few of this device). */
export type TelegramImportCode =
  | 'telegram_disabled'
  | 'not_found'
  | 'telegram_unavailable'
  | 'telegram_busy'
  | 'rate_limited'
  | 'telegram_emoji_set'
  | 'bad_request'
  /** The text is not a set link. */
  | 'bad_link'
  /** An `addemoji` link. */
  | 'emoji_link'
  /** Only video stickers in the set. */
  | 'video_only'
  /** Not a single file loaded. */
  | 'no_stickers'
  | 'offline'
  | 'other';

/** Why a Telegram import failed. Cancelling throws a DOMException `AbortError` instead. */
export class TelegramImportError extends Error {
  override readonly name = 'TelegramImportError';
  readonly code: TelegramImportCode;
  /** HTTP status, 0 when there was no answer or the problem is on this device. */
  readonly status: number;
  readonly reason: string | undefined;
  /** Seconds to wait (`Retry-After`). */
  readonly retryAfter: number | undefined;

  constructor(code: TelegramImportCode, status = 0, reason?: string, retryAfter?: number) {
    super(`telegram import: ${code}${reason ? ` (${reason})` : ''}`);
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

export function isTelegramImportError(e: unknown, code?: TelegramImportCode): e is TelegramImportError {
  return e instanceof TelegramImportError && (code === undefined || e.code === code);
}

