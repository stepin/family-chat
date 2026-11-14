// Attachments (docs/PROTOCOL.md, section "Вложения"): a random key per file, parts of 4 MiB,
// AES-256-GCM with nonce = part number and AAD = "fc/v1/blob\n" || lp(blobId) || u32 part || u32 parts.
// Parts are encrypted and decrypted one at a time, so a whole file never has to be in memory.

import { concat, lp, u32be, utf8, type Bytes } from './bytes.ts';
import { counterNonce, GCM_TAG_BYTES, gcmOpen, gcmSeal } from './aead.ts';
import { base32DecodeExact, base32Encode, base64urlDecode, base64urlDecodeExact, base64urlEncode } from './codec.ts';
import {
  ALLOWED_PART_SIZES,
  BLOB_ID_BYTES,
  BLOB_PART_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_FILE_NAME_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_THUMB_BYTES,
  VOICE_PEAKS,
} from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';
import { isObject, isSafeUint, nameProblem, type JsonObject } from './json.ts';
import { randomBytes } from './random.ts';

export const LABEL_BLOB = 'fc/v1/blob\n';
export const BLOB_KEY_BYTES = 32;
/** Longest voice message, in milliseconds (24 hours). */
export const MAX_VOICE_DURATION_MS = 86_400_000;
/** Largest image side in pixels. */
export const MAX_IMAGE_SIDE = 65535;

export const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const VOICE_TYPES: readonly string[] = ['audio/mp4', 'audio/webm', 'audio/ogg'];

/** The encrypted file: what the reader needs to download and decrypt it. */
export interface BlobRef {
  /** base32 of 16 random bytes (26 characters); also the path segment in /blobs/<id>/<part>. */
  readonly id: string;
  /** base64url of the 32-byte AES-256-GCM key of this file. */
  readonly key: string;
  /** Number of parts: ceil(size / partSize), and 1 for an empty file. */
  readonly parts: number;
  readonly partSize: number;
  /** Plaintext size in bytes. */
  readonly size: number;
}

export type AttachmentKind = 'image' | 'voice' | 'file';

/** Attachment descriptor inside a `msg` payload. */
export interface Attachment {
  readonly blob: BlobRef;
  readonly name: string;
  readonly mime: string;
  readonly kind: AttachmentKind;
  /** Width and height in pixels: required for images, optional for files, absent for voice. */
  readonly w?: number;
  readonly h?: number;
  /** base64url of an inline JPEG thumbnail of at most 4096 bytes (images and files). */
  readonly thumb?: string;
  /** Voice only: duration in milliseconds. */
  readonly dur?: number;
  /** Voice only: exactly 64 waveform peaks, each 0..255. */
  readonly peaks?: readonly number[];
}

/** Number of parts of a file of `size` bytes. An empty file is one empty part. */
export function blobPartCount(size: number, partSize: number = BLOB_PART_SIZE): number {
  return size === 0 ? 1 : Math.ceil(size / partSize);
}

/** A new blob for a file of `size` bytes: random id, random key, 4 MiB parts. */
export function newBlob(size: number, options: { readonly maxSize?: number } = {}): BlobRef {
  const max = options.maxSize ?? MAX_ATTACHMENT_BYTES;
  if (!isSafeUint(size) || size > max) throw new ProtocolError('invalid-argument', 'blob size is out of range');
  return {
    id: base32Encode(randomBytes(BLOB_ID_BYTES)),
    key: base64urlEncode(randomBytes(BLOB_KEY_BYTES)),
    parts: blobPartCount(size),
    partSize: BLOB_PART_SIZE,
    size,
  };
}

function blobProblem(b: unknown, maxSize: number): string | undefined {
  if (!isObject(b)) return 'blob must be an object';
  try {
    base32DecodeExact(b.id, BLOB_ID_BYTES, 'blob id');
  } catch {
    return 'blob.id must be base32 of 16 bytes';
  }
  try {
    base64urlDecodeExact(b.key, BLOB_KEY_BYTES, 'blob key');
  } catch {
    return 'blob.key must be base64url of 32 bytes';
  }
  if (!isSafeUint(b.partSize) || !ALLOWED_PART_SIZES.includes(b.partSize)) return 'blob.partSize is not allowed';
  if (!isSafeUint(b.size)) return 'blob.size must be a non-negative integer';
  if (b.size > maxSize) return 'blob.size exceeds the limit';
  if (!isSafeUint(b.parts) || b.parts !== blobPartCount(b.size, b.partSize)) return 'blob.parts must be ceil(size / partSize)';
  return undefined;
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

function fileNameProblem(name: unknown): string | undefined {
  const p = nameProblem(name, MAX_FILE_NAME_CHARS);
  if (p) return p;
  const s = name as string;
  if (s !== s.trim()) return 'name must not start or end with spaces';
  if (utf8(s).length > MAX_FILE_NAME_BYTES) return `name must be at most ${MAX_FILE_NAME_BYTES} bytes`;
  if (/[/\\]/.test(s) || s === '.' || s === '..') return 'name must not contain path separators';
  return undefined;
}

function isDim(v: unknown): v is number {
  return isSafeUint(v) && v >= 1 && v <= MAX_IMAGE_SIDE;
}

function attachmentProblem(a: unknown, maxSize: number): string | undefined {
  if (!isObject(a)) return 'attachment must be an object';
  const bp = blobProblem(a.blob, maxSize);
  if (bp) return bp;
  const np = fileNameProblem(a.name);
  if (np) return `name: ${np}`;
  if (typeof a.mime !== 'string' || !MIME.test(a.mime)) return 'mime must be a lowercase type/subtype without parameters';
  const kind = a.kind;
  if (kind !== 'image' && kind !== 'voice' && kind !== 'file') return 'kind must be image, voice or file';
  if (kind === 'image' && !IMAGE_TYPES.includes(a.mime)) return 'image mime type is not allowed';
  if (kind === 'voice' && !VOICE_TYPES.includes(a.mime)) return 'voice mime type is not allowed';

  const hasDims = a.w !== undefined || a.h !== undefined;
  if (kind === 'image' && !hasDims) return 'image needs w and h';
  if (kind === 'voice' && hasDims) return 'voice must not have w or h';
  if (hasDims && (!isDim(a.w) || !isDim(a.h))) return `w and h must be integers 1..${MAX_IMAGE_SIDE}`;

  if (a.thumb !== undefined) {
    if (kind === 'voice') return 'voice must not have a thumbnail';
    if (typeof a.thumb !== 'string') return 'thumb must be base64url';
    if (a.thumb.length > Math.ceil((MAX_THUMB_BYTES * 4) / 3)) return `thumb must be at most ${MAX_THUMB_BYTES} bytes`;
    let thumb: Bytes;
    try {
      thumb = base64urlDecode(a.thumb);
    } catch {
      return 'thumb must be base64url';
    }
    if (thumb.length > MAX_THUMB_BYTES) return `thumb must be at most ${MAX_THUMB_BYTES} bytes`;
    if (thumb.length < 3 || thumb[0] !== 0xff || thumb[1] !== 0xd8 || thumb[2] !== 0xff) return 'thumb must be a JPEG';
  }

  if (kind === 'voice') {
    if (!isSafeUint(a.dur) || a.dur > MAX_VOICE_DURATION_MS) return 'voice needs dur in milliseconds';
    const peaks = a.peaks;
    if (!Array.isArray(peaks) || peaks.length !== VOICE_PEAKS) return `voice needs exactly ${VOICE_PEAKS} peaks`;
    if (!peaks.every((p) => isSafeUint(p) && p <= 255)) return 'peaks must be integers 0..255';
  } else if (a.dur !== undefined || a.peaks !== undefined) {
    return 'only voice has dur and peaks';
  }
  return undefined;
}

/** Copy of the known fields in the fixed order: blob, name, mime, kind, w, h, thumb, dur, peaks. */
function normalize(a: JsonObject): Attachment {
  const b = a.blob as JsonObject;
  const out: { -readonly [K in keyof Attachment]: Attachment[K] } = {
    blob: {
      id: b.id as string,
      key: b.key as string,
      parts: b.parts as number,
      partSize: b.partSize as number,
      size: b.size as number,
    },
    name: a.name as string,
    mime: a.mime as string,
    kind: a.kind as AttachmentKind,
  };
  if (a.w !== undefined) out.w = a.w as number;
  if (a.h !== undefined) out.h = a.h as number;
  if (a.thumb !== undefined) out.thumb = a.thumb as string;
  if (a.dur !== undefined) out.dur = a.dur as number;
  if (a.peaks !== undefined) out.peaks = [...(a.peaks as number[])];
  return out;
}

/**
 * Strict validation of a received attachment descriptor (PLAN.md 6.12 "Имена и описатели").
 * `maxSize` is the server's file limit when known. Throws `malformed`; returns a normalised copy
 * without unknown fields.
 */
export function validateAttachment(a: unknown, options: { readonly maxSize?: number } = {}): Attachment {
  const p = attachmentProblem(a, Math.min(options.maxSize ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES));
  if (p) throw malformed(`attachment: ${p}`);
  return normalize(a as JsonObject);
}

/** Same rules for an attachment about to be sent; throws `invalid-argument`. */
export function checkAttachmentInput(a: unknown): Attachment {
  const p = attachmentProblem(a, MAX_ATTACHMENT_BYTES);
  if (p) throw new ProtocolError('invalid-argument', `attachment: ${p}`);
  return normalize(a as JsonObject);
}

// ---- part encryption ----

interface OpenBlob {
  readonly idBytes: Bytes;
  readonly key: Bytes;
  readonly ref: BlobRef;
}

function openBlob(ref: BlobRef, code: 'malformed' | 'invalid-argument'): OpenBlob {
  const p = blobProblem(ref, MAX_ATTACHMENT_BYTES);
  if (p) throw new ProtocolError(code, `blob: ${p}`);
  return {
    idBytes: base32DecodeExact(ref.id, BLOB_ID_BYTES, 'blob id'),
    key: base64urlDecodeExact(ref.key, BLOB_KEY_BYTES, 'blob key'),
    ref,
  };
}

/** Plaintext length of part `index` (0-based): partSize for all but the last part. */
export function blobPartLength(ref: BlobRef, index: number): number {
  const b = openBlob(ref, 'invalid-argument').ref;
  checkIndex(b, index);
  return index < b.parts - 1 ? b.partSize : b.size - (b.parts - 1) * b.partSize;
}

function checkIndex(ref: BlobRef, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= ref.parts) {
    throw new ProtocolError('invalid-argument', 'part index is out of range');
  }
}

/** AAD of one part: "fc/v1/blob\n" || lp(blobId raw 16 bytes) || u32 index || u32 parts. */
export function blobPartAad(idBytes: Uint8Array, index: number, parts: number): Bytes {
  return concat(utf8(LABEL_BLOB), lp(idBytes), u32be(index), u32be(parts));
}

/**
 * Encrypt part `index` (0-based). The plaintext must be exactly blobPartLength(ref, index) bytes.
 * The same part always encrypts to the same bytes (nonce = part number), so a resumed upload
 * re-sends identical data. Output length: plaintext + 16.
 */
export async function encryptBlobPart(ref: BlobRef, index: number, plaintext: Uint8Array): Promise<Bytes> {
  const b = openBlob(ref, 'invalid-argument');
  checkIndex(b.ref, index);
  if (!(plaintext instanceof Uint8Array) || plaintext.length !== blobPartLength(ref, index)) {
    throw new ProtocolError('invalid-argument', 'part plaintext has the wrong length');
  }
  return gcmSeal(b.key, counterNonce(index), blobPartAad(b.idBytes, index, b.ref.parts), plaintext);
}

/**
 * Decrypt part `index`. Throws `malformed` when the length does not match the descriptor
 * (truncated or padded part), `wrong-key` when authentication fails (altered bytes, a part
 * of another position or another file, or another total number of parts).
 */
export async function decryptBlobPart(ref: BlobRef, index: number, ciphertext: Uint8Array): Promise<Bytes> {
  const b = openBlob(ref, 'malformed');
  checkIndex(b.ref, index);
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length !== blobPartLength(ref, index) + GCM_TAG_BYTES) {
    throw malformed('blob part: length does not match the descriptor');
  }
  const pt = await gcmOpen(b.key, counterNonce(index), blobPartAad(b.idBytes, index, b.ref.parts), ciphertext);
  if (!pt) throw new ProtocolError('wrong-key', 'blob part does not decrypt (altered, reordered or foreign part)');
  return pt;
}
