// Sticker packs (docs/PROTOCOL.md, "Наборы стикеров"; docs/PLAN.md 6.1, 6.10, 7.5).
//
// A pack is a signed manifest (envelope kind `sticker-pack`) plus its files. Each file is named
// by its content: hash32 = base32 of the first 20 bytes of SHA-256 of the file. The server and
// every client check that a file's bytes give its name. Packs are not encrypted: the plan
// publishes them readable by every member of the server (and so by the server itself).
//
// A sticker message is a `msg` with a `sticker` reference and `body` = the sticker's emoji, so
// a client that does not know stickers shows the emoji (the unknown field is ignored).

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base32Encode } from './codec.ts';
import { PROTOCOL_VERSION, USER_ID_BYTES } from './constants.ts';
import {
  checkEnvelopeSignature,
  openEnvelope,
  sealBytes,
  type Identity,
  type SignedEnvelope,
} from './envelope.ts';
import { malformed, ProtocolError } from './errors.ts';
import { checkContextString, isObject, isSafeUint, nameProblem, type JsonObject } from './json.ts';
import type { IdentityKeys } from './keys.ts';

/** Pack id: base32 of 16 random bytes. */
export const PACK_ID_BYTES = 16;
/** Sticker file name: base32 of the first 20 bytes of SHA-256 (32 characters). */
export const STICKER_HASH_BYTES = 20;
export const MAX_PACK_STICKERS = 200;
export const MAX_PACK_NAME_CHARS = 64;
export const MAX_WEBP_STICKER_BYTES = 512 * 1024;
export const MAX_TGS_STICKER_BYTES = 128 * 1024;
/** All files of a pack together. */
export const MAX_PACK_BYTES = 50 * 1024 * 1024;
export const MAX_STICKER_SIDE = 1024;
/** Sticker emoji: the rules of a reaction emoji. */
export const MAX_STICKER_EMOJI_CHARS = 16;
export const MAX_STICKER_EMOJI_BYTES = 64;

export type StickerType = 'webp' | 'tgs';
export const STICKER_TYPES: readonly StickerType[] = ['webp', 'tgs'];

/** One sticker of a manifest. */
export interface PackSticker {
  /** hash32 of the file. */
  readonly file: string;
  readonly type: StickerType;
  /** File size in bytes. */
  readonly size: number;
  readonly emoji: string;
  readonly w: number;
  readonly h: number;
}

export interface StickerPackInput {
  readonly packId: string;
  readonly serverId: string;
  readonly name: string;
  readonly created: number;
  readonly stickers: readonly PackSticker[];
}

/** A verified manifest. */
export interface StickerPack {
  readonly packId: string;
  readonly serverId: string;
  /** userId of the uploader (the signer). */
  readonly author: string;
  readonly name: string;
  readonly created: number;
  readonly stickers: readonly PackSticker[];
  readonly envelope: SignedEnvelope;
}

/** The `sticker` field of a msg payload. */
export interface StickerRef {
  readonly pack: string;
  readonly file: string;
  readonly type: StickerType;
  readonly w: number;
  readonly h: number;
}

/** hash32 of a sticker file: base32 of the first 20 bytes of its SHA-256. */
export function stickerFileHash(bytes: Uint8Array): string {
  return base32Encode(sha256(bytes).subarray(0, STICKER_HASH_BYTES));
}

function isB32(v: unknown, bytes: number): v is string {
  try {
    base32DecodeExact(v, bytes, 'id');
    return true;
  } catch {
    return false;
  }
}

// C0, DEL, C1 controls and bidirectional formatting characters (the name rules).
/** Problem with a sticker or reaction emoji, or undefined. */
export function stickerEmojiProblem(e: unknown): string | undefined {
  const p = nameProblem(e, MAX_STICKER_EMOJI_CHARS);
  if (p) return `emoji: ${p}`;
  if (utf8(e as string).length > MAX_STICKER_EMOJI_BYTES) return `emoji must be at most ${MAX_STICKER_EMOJI_BYTES} bytes`;
  if ((e as string).trim() !== e) return 'emoji must not contain surrounding spaces';
  return undefined;
}

export function maxStickerBytes(type: StickerType): number {
  return type === 'webp' ? MAX_WEBP_STICKER_BYTES : MAX_TGS_STICKER_BYTES;
}

function sideProblem(v: unknown, what: string): string | undefined {
  if (!isSafeUint(v) || v < 1 || v > MAX_STICKER_SIDE) return `${what} must be 1..${MAX_STICKER_SIDE}`;
  return undefined;
}

function packStickerProblem(s: unknown): string | undefined {
  if (!isObject(s)) return 'a sticker must be an object';
  if (!isB32(s.file, STICKER_HASH_BYTES)) return 'sticker file must be a hash32';
  if (!STICKER_TYPES.includes(s.type as StickerType)) return 'sticker type must be webp or tgs';
  if (!isSafeUint(s.size) || s.size < 1 || s.size > maxStickerBytes(s.type as StickerType)) return 'sticker size is out of range';
  return stickerEmojiProblem(s.emoji) ?? sideProblem(s.w, 'sticker w') ?? sideProblem(s.h, 'sticker h');
}

function stickersProblem(list: unknown): string | undefined {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PACK_STICKERS) {
    return `stickers must be a list of 1..${MAX_PACK_STICKERS}`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const s of list) {
    const p = packStickerProblem(s);
    if (p) return p;
    const o = s as PackSticker;
    if (seen.has(o.file)) return 'the same file is listed twice';
    seen.add(o.file);
    total += o.size;
  }
  if (total > MAX_PACK_BYTES) return `a pack is at most ${MAX_PACK_BYTES} bytes`;
  return undefined;
}

const stickerOut = (s: PackSticker): PackSticker => ({ file: s.file, type: s.type, size: s.size, emoji: s.emoji, w: s.w, h: s.h });

/**
 * Signs a manifest. Field order is fixed: v, packId, serverId, author, name, created, stickers
 * (each: file, type, size, emoji, w, h).
 */
export function createStickerPackEnvelope(keys: IdentityKeys, input: StickerPackInput): SignedEnvelope {
  const bad = (m: string) => new ProtocolError('invalid-argument', `sticker-pack: ${m}`);
  if (!isB32(input.packId, PACK_ID_BYTES)) throw bad('packId must be base32 of 16 bytes');
  const serverId = checkContextString(input.serverId, 'serverId', 'invalid-argument');
  const name = typeof input.name === 'string' ? input.name.trim() : input.name;
  const np = nameProblem(name, MAX_PACK_NAME_CHARS);
  if (np) throw bad(np);
  if (!isSafeUint(input.created)) throw bad('created must be a non-negative integer (ms)');
  const sp = stickersProblem(input.stickers);
  if (sp) throw bad(sp);
  const payload: JsonObject = {
    v: PROTOCOL_VERSION,
    packId: input.packId,
    serverId,
    author: keys.userId,
    name,
    created: input.created,
    stickers: input.stickers.map(stickerOut),
  };
  return sealBytes('sticker-pack', utf8(JSON.stringify(payload)), keys);
}

/** Reads `author` and `packId` of a manifest without checking it (to find the author's identity first). */
export function readStickerPackHeader(input: unknown): { readonly packId: string; readonly author: string } {
  const o = openEnvelope(input, 'sticker-pack');
  if (!isB32(o.json.packId, PACK_ID_BYTES)) throw malformed('sticker-pack: packId must be base32 of 16 bytes');
  if (!isB32(o.json.author, USER_ID_BYTES)) throw malformed('sticker-pack: author must be a userId');
  return { packId: o.json.packId, author: o.json.author };
}

/**
 * Verifies a manifest against the author's verified identity and the server it was read from:
 * shape, limits, `serverId`, the author, the signature over the received bytes, and the
 * expected `packId` when given.
 */
export function verifyStickerPackEnvelope(
  input: unknown,
  author: Identity,
  expected: { readonly serverId: string; readonly packId?: string },
): StickerPack {
  const o = openEnvelope(input, 'sticker-pack');
  const j = o.json;
  if (!isB32(j.packId, PACK_ID_BYTES)) throw malformed('sticker-pack: packId must be base32 of 16 bytes');
  const serverId = checkContextString(j.serverId, 'sticker-pack serverId', 'malformed');
  if (!isB32(j.author, USER_ID_BYTES)) throw malformed('sticker-pack: author must be a userId');
  const np = nameProblem(j.name, MAX_PACK_NAME_CHARS);
  if (np) throw malformed(`sticker-pack: ${np}`);
  if (!isSafeUint(j.created)) throw malformed('sticker-pack: created must be a non-negative integer');
  const sp = stickersProblem(j.stickers);
  if (sp) throw new ProtocolError(sp.includes('at most') ? 'too-large' : 'malformed', `sticker-pack: ${sp}`);
  if (j.author !== author.userId) throw new ProtocolError('user-id-mismatch', 'sticker-pack belongs to another user');
  checkEnvelopeSignature(o, 'sticker-pack', author.signPub);
  if (serverId !== expected.serverId) throw new ProtocolError('wrong-server', 'sticker-pack was published on another server');
  if (expected.packId !== undefined && j.packId !== expected.packId) {
    throw new ProtocolError('context-mismatch', 'sticker-pack has another packId');
  }
  return {
    packId: j.packId,
    serverId,
    author: j.author,
    name: j.name as string,
    created: j.created,
    stickers: (j.stickers as PackSticker[]).map(stickerOut),
    envelope: o.env,
  };
}

/** Problem with the `sticker` field of a msg, or undefined. */
export function stickerRefProblem(s: unknown): string | undefined {
  if (!isObject(s)) return 'sticker must be an object';
  if (!isB32(s.pack, PACK_ID_BYTES)) return 'sticker.pack must be a packId';
  if (!isB32(s.file, STICKER_HASH_BYTES)) return 'sticker.file must be a hash32';
  if (!STICKER_TYPES.includes(s.type as StickerType)) return 'sticker.type must be webp or tgs';
  return sideProblem(s.w, 'sticker.w') ?? sideProblem(s.h, 'sticker.h');
}

export function stickerRefOut(s: StickerRef): StickerRef {
  return { pack: s.pack, file: s.file, type: s.type, w: s.w, h: s.h };
}

/** Does this file belong to this manifest entry (hash and size)? */
export function stickerFileMatches(bytes: Uint8Array, s: Pick<PackSticker, 'file' | 'size'>): boolean {
  return bytes.length === s.size && stickerFileHash(bytes) === s.file;
}

export type { Bytes };
