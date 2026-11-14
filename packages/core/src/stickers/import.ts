// Importing a sticker pack (docs/PLAN.md 7.5, 7.6): `.webp` and `.tgs` files,
// or a `.zip` of them. Everything is checked here, before a preview is shown
// or anything is uploaded: archive limits (zip.ts), WebP headers (webp.ts),
// `.tgs` unpacking and sanitising (tgs.ts), sides, sizes, duplicates, counts.

import {
  MAX_PACK_BYTES,
  MAX_PACK_STICKERS,
  MAX_STICKER_SIDE,
  MAX_TGS_STICKER_BYTES,
  MAX_WEBP_STICKER_BYTES,
  stickerEmojiProblem,
  stickerFileHash,
  type StickerType,
} from '@family-chat/protocol';
import { StickerError, type StickerErrorCode } from './errors.ts';
import { readTgs } from './tgs.ts';
import { webpInfo } from './webp.ts';
import { readZip, type ZipLimits } from './zip.ts';

/** The archive limits of docs/PLAN.md 7.6 (200 files, 50 MB unpacked) plus a ratio and a record cap. */
export const STICKER_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxFileBytes: MAX_WEBP_STICKER_BYTES,
  maxTotalBytes: MAX_PACK_BYTES,
  maxRatio: 100,
};
/** A `.zip` larger than this is refused before it is read. */
export const MAX_STICKER_ZIP_BYTES = MAX_PACK_BYTES + 1024 * 1024;
export const DEFAULT_STICKER_EMOJI = '🙂';

const NESTED = /\.(zip|rar|7z|tar|tgz|gz|bz2|xz|jar|apk|cab|iso)$/i;
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;

export interface ImportInput {
  readonly name: string;
  readonly data: Blob | Uint8Array;
}

export interface ImportedSticker {
  /** File name inside the archive or as chosen (for the preview only). */
  readonly name: string;
  readonly type: StickerType;
  readonly bytes: Uint8Array;
  /** hash32 of the bytes (the file's name on the server). */
  readonly file: string;
  readonly size: number;
  readonly emoji: string;
  readonly w: number;
  readonly h: number;
  readonly animated: boolean;
}

export interface StickerImport {
  readonly stickers: ImportedSticker[];
  /** Files left out, with the reason. */
  readonly skipped: { readonly name: string; readonly reason: StickerErrorCode | 'unsupported' | 'duplicate' }[];
}

async function bytesOf(d: Blob | Uint8Array): Promise<Uint8Array> {
  return d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer());
}

const sizeOf = (d: Blob | Uint8Array): number => (d instanceof Uint8Array ? d.length : d.size);
const baseName = (n: string): string => n.split('/').pop() ?? n;

/** The emoji a file name starts with (Telegram exports often name files so), else the default. */
export function emojiFromName(name: string): string {
  const base = baseName(name);
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const first = Seg ? ([...new Seg(undefined, { granularity: 'grapheme' }).segment(base)][0]?.segment ?? '') : [...base][0] ?? '';
  return /\p{Extended_Pictographic}/u.test(first) && !stickerEmojiProblem(first) ? first : DEFAULT_STICKER_EMOJI;
}

/** Checks one sticker file; throws StickerError for a bad one. */
export async function checkStickerFile(name: string, bytes: Uint8Array, type: StickerType): Promise<ImportedSticker> {
  let w: number;
  let h: number;
  let animated: boolean;
  if (type === 'webp') {
    if (bytes.length > MAX_WEBP_STICKER_BYTES) throw new StickerError('file-too-large', name);
    const info = webpInfo(bytes);
    if (!info) throw new StickerError('bad-webp', name);
    ({ width: w, height: h, animated } = info);
  } else {
    if (bytes.length > MAX_TGS_STICKER_BYTES) throw new StickerError('file-too-large', name);
    const t = await readTgs(bytes);
    ({ width: w, height: h } = t.info);
    animated = true;
  }
  if (w < 1 || h < 1 || w > MAX_STICKER_SIDE || h > MAX_STICKER_SIDE) throw new StickerError('bad-size', name);
  return { name, type, bytes, file: stickerFileHash(bytes), size: bytes.length, emoji: emojiFromName(name), w, h, animated };
}

function typeOf(name: string): StickerType | null {
  if (/\.webp$/i.test(name)) return 'webp';
  if (/\.tgs$/i.test(name)) return 'tgs';
  return null;
}

/**
 * Reads the chosen files: `.webp`, `.tgs` and `.zip` (one level, no nested
 * archives). Bad sticker files are skipped with a reason; an unsafe archive,
 * too many stickers or nothing usable throw StickerError.
 */
export async function importStickers(inputs: readonly ImportInput[]): Promise<StickerImport> {
  const stickers: ImportedSticker[] = [];
  const skipped: StickerImport['skipped'] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = async (name: string, type: StickerType, read: () => Promise<Uint8Array>): Promise<void> => {
    try {
      const s = await checkStickerFile(name, await read(), type);
      if (seen.has(s.file)) {
        skipped.push({ name, reason: 'duplicate' });
        return;
      }
      if (stickers.length >= MAX_PACK_STICKERS) throw new StickerError('too-many-stickers');
      total += s.size;
      if (total > MAX_PACK_BYTES) throw new StickerError('too-large-total');
      seen.add(s.file);
      stickers.push(s);
    } catch (e) {
      if (!(e instanceof StickerError) || e.code === 'too-many-stickers' || e.code === 'too-large-total' || e.code === 'unsupported-browser') throw e;
      skipped.push({ name, reason: e.code });
    }
  };

  for (const input of inputs) {
    const lower = input.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      if (sizeOf(input.data) > MAX_STICKER_ZIP_BYTES) throw new StickerError('too-large-total');
      const entries = readZip(await bytesOf(input.data), STICKER_ZIP_LIMITS);
      if (entries.some((e) => NESTED.test(e.name) && !JUNK.test(e.name))) throw new StickerError('nested-archive');
      for (const e of entries) {
        if (JUNK.test(e.name)) continue;
        const type = typeOf(e.name);
        if (!type) {
          skipped.push({ name: e.name, reason: 'unsupported' });
          continue;
        }
        await add(e.name, type, () => e.read());
      }
    } else {
      const type = typeOf(input.name);
      if (!type) {
        if (NESTED.test(input.name)) throw new StickerError('nested-archive');
        skipped.push({ name: input.name, reason: 'unsupported' });
        continue;
      }
      if (sizeOf(input.data) > (type === 'webp' ? MAX_WEBP_STICKER_BYTES : MAX_TGS_STICKER_BYTES)) {
        skipped.push({ name: input.name, reason: 'file-too-large' });
        continue;
      }
      await add(input.name, type, () => bytesOf(input.data));
    }
  }
  if (stickers.length === 0) throw new StickerError('no-stickers');
  return { stickers, skipped };
}
