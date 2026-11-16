// Preparing photos and files for sending.
//
// Photos are downscaled to at most 2048 px on the long side and re-encoded on
// the device, which also drops EXIF (with the shooting location). Decoding
// goes through `createImageBitmap` with resize options, so the full-resolution
// picture is never drawn onto a canvas. WebP when the browser can encode it,
// JPEG otherwise: the type of the resulting blob is checked, because Safari
// silently returns PNG for formats it cannot write. Each image also gets an
// inline JPEG thumbnail of at most 4 KB and its dimensions, so the chat does
// not jump when the picture arrives.

import { IMAGE_TYPES, MAX_AVATAR_BYTES, MAX_THUMB_BYTES, type AttachmentInput } from '@family-chat/core';

export const MAX_IMAGE_SIDE = 2048;
export const AVATAR_SIDE = 256;
/** Quality of re-encoded photos. */
export const PHOTO_QUALITY = 0.85;

/** Thumbnail attempts, largest first, until the JPEG fits into MAX_THUMB_BYTES. */
export const THUMB_STEPS: readonly { readonly side: number; readonly quality: number }[] = [
  { side: 96, quality: 0.6 },
  { side: 72, quality: 0.5 },
  { side: 56, quality: 0.45 },
  { side: 40, quality: 0.4 },
  { side: 28, quality: 0.35 },
];

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Size that fits into `max` on the long side, keeping the aspect ratio; never upscales. */
export function fitWithin(width: number, height: number, max: number): Size & { readonly scaled: boolean } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h, scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true };
}

/** Output types to try, in order. */
export function encodeOrder(): readonly ('image/webp' | 'image/jpeg')[] {
  return ['image/webp', 'image/jpeg'];
}

const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};

// Characters the protocol refuses in names: controls, bidi overrides, separators.
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/\\]/g;

/**
 * A file name the protocol accepts (docs/PROTOCOL.md 16.3): 1-128 code points,
 * at most 255 bytes, no control or bidi characters, no path separators, not
 * "." or "..", no spaces at the ends. Falls back to `fallback`.
 */
export function safeFileName(name: string, fallback = 'file'): string {
  let s = name.replace(BAD_NAME_CHARS, '_').trim();
  if (s === '.' || s === '..') s = '';
  let chars = Array.from(s);
  if (chars.length > 128) {
    // Keep the extension when shortening.
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    chars = [...Array.from(s.slice(0, s.length - ext.length)).slice(0, 128 - Array.from(ext).length), ...Array.from(ext)];
  }
  const enc = new TextEncoder();
  while (chars.length > 0 && enc.encode(chars.join('')).length > 255) chars.pop();
  s = chars.join('').trim();
  return s.length > 0 ? s : fallback;
}

/** Replaces the extension to match the new type ("IMG_1.HEIC" → "IMG_1.webp"). */
export function renameForType(name: string, mime: string): string {
  const ext = EXT[mime];
  if (!ext) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return safeFileName(`${base || 'photo'}.${ext}`, `photo.${ext}`);
}

/** A MIME type the protocol accepts (lower case `type/subtype`, no parameters). */
export function safeMime(type: string): string {
  const t = type.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : 'application/octet-stream';
}

/** The picture can be re-encoded (a still image type; GIF keeps its animation and is sent as is). */
export function shouldReencode(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/gif' && mime !== 'image/svg+xml';
}

// ---- browser part ----

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function toBlob(canvas: Canvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** Draws a bitmap (already at the target size) and encodes it; null when nothing suitable came out. */
async function encode(bitmap: ImageBitmap, type: 'image/webp' | 'image/jpeg', quality: number): Promise<Blob | null> {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (type === 'image/jpeg') {
    // JPEG has no transparency: white instead of black behind transparent pixels.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  const blob = await toBlob(canvas, type, quality);
  // Safari returns PNG for types it cannot encode: check what came out.
  return blob && blob.type === type ? blob : null;
}

/** Natural size of a picture, read by the browser from the file header (EXIF orientation applied). */
export function naturalSize(file: Blob): Promise<Size> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve({ width: img.naturalWidth, height: img.naturalHeight });
      else reject(new Error('no size'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    img.src = url;
  });
}

function resized(source: ImageBitmapSource, size: Size, crop?: { sx: number; sy: number; sw: number; sh: number }): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high',
    imageOrientation: 'from-image',
  };
  return crop ? createImageBitmap(source, crop.sx, crop.sy, crop.sw, crop.sh, options) : createImageBitmap(source, options);
}

/** JPEG thumbnail of at most MAX_THUMB_BYTES, or undefined when even the smallest step is too big. */
export async function makeThumb(source: ImageBitmapSource, size: Size): Promise<Uint8Array | undefined> {
  for (const step of THUMB_STEPS) {
    const fit = fitWithin(size.width, size.height, step.side);
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await resized(source, fit);
      const blob = await encode(bitmap, 'image/jpeg', step.quality);
      if (blob && blob.size <= MAX_THUMB_BYTES) return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return undefined;
    } finally {
      bitmap?.close();
    }
  }
  return undefined;
}

/** Re-encodes a bitmap: WebP, else JPEG; the blob and its type. */
async function encodeBest(bitmap: ImageBitmap, quality: number): Promise<Blob> {
  for (const type of encodeOrder()) {
    const blob = await encode(bitmap, type, quality);
    if (blob) return blob;
  }
  throw new Error('cannot encode');
}

/**
 * One picked file as an attachment. Photos are downscaled and re-encoded
 * unless `original` is set; pictures the browser cannot decode (HEIC on most
 * browsers) and everything else go as files.
 */
export async function prepareAttachment(file: File, options: { readonly original: boolean }): Promise<AttachmentInput> {
  const mime = safeMime(file.type);
  const name = safeFileName(file.name || 'file');
  const asFile: AttachmentInput = { data: file, name, mime };
  if (!mime.startsWith('image/')) return asFile;
  let size: Size;
  try {
    size = await naturalSize(file);
  } catch {
    return asFile;
  }
  const thumb = await makeThumb(file, size);
  if (options.original || !shouldReencode(mime)) {
    // Sent as is: an image only when the type is one the protocol shows as an image.
    if (!IMAGE_TYPES.includes(mime)) return { ...asFile, ...(thumb ? { thumb } : {}) };
    return { data: file, name, mime, kind: 'image', width: size.width, height: size.height, ...(thumb ? { thumb } : {}) };
  }
  const target = fitWithin(size.width, size.height, MAX_IMAGE_SIDE);
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await resized(file, target);
    const blob = await encodeBest(bitmap, PHOTO_QUALITY);
    return {
      data: blob,
      name: renameForType(name, blob.type),
      mime: blob.type,
      kind: 'image',
      width: bitmap.width,
      height: bitmap.height,
      ...(thumb ? { thumb } : {}),
    };
  } catch {
    return IMAGE_TYPES.includes(mime)
      ? { data: file, name, mime, kind: 'image', width: size.width, height: size.height, ...(thumb ? { thumb } : {}) }
      : asFile;
  } finally {
    bitmap?.close();
  }
}

/** A square crop of a picture as a 256 px WebP or JPEG avatar of at most 256 KB. */
export async function prepareAvatar(file: Blob, crop: { sx: number; sy: number; side: number }): Promise<Blob> {
  const bitmap = await resized(file, { width: AVATAR_SIDE, height: AVATAR_SIDE }, { sx: crop.sx, sy: crop.sy, sw: crop.side, sh: crop.side });
  try {
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await encodeBest(bitmap, q);
      if (blob.size <= MAX_AVATAR_BYTES) return blob;
    }
    throw new Error('avatar too large');
  } finally {
    bitmap.close();
  }
}

/** Initial square crop: the centre of the picture. */
export function centreCrop(size: Size): { sx: number; sy: number; side: number } {
  const side = Math.min(size.width, size.height);
  return { sx: Math.round((size.width - side) / 2), sy: Math.round((size.height - side) / 2), side };
}
