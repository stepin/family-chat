// `.tgs` stickers: gzip-compressed Lottie JSON.
//
// Hostile input: unpacked with a size cap, then sanitised before any
// renderer sees it. Expressions (string `x` properties, which a full Lottie
// player would run as JavaScript) are removed, as are external addresses,
// image, audio and font assets, text, audio and camera layers. The canvas,
// frame rate, duration, number of layers and the size of the whole tree are
// capped, precompositions must not reference themselves. The web client
// renders the result with the light lottie-web build, which has no
// expression support at all.

import { MAX_STICKER_SIDE } from '@family-chat/protocol';
import { StickerError } from './errors.ts';
import { inflateCapped } from './zip.ts';

/** Unpacked `.tgs`. */
export const MAX_TGS_JSON_BYTES = 1024 * 1024;
export const MAX_TGS_SECONDS = 10;
export const MAX_TGS_FPS = 120;
/** Layers in the animation and its precompositions together. */
export const MAX_TGS_LAYERS = 500;
/** Layers after precompositions are expanded (one asset used many times counts each time). */
export const MAX_TGS_EXPANDED_LAYERS = 2000;
/** Objects and arrays in the whole tree. */
export const MAX_TGS_NODES = 300_000;

export interface LottieInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
}

export interface SanitizedLottie {
  /** The cleaned animation data, ready for lottie-web (light build). */
  readonly data: Record<string, unknown>;
  readonly info: LottieInfo;
}

/** Layer types kept: precomposition, solid, null, shape. */
const KEPT_LAYERS = new Set([0, 1, 3, 4]);
const URLISH = /^\s*(https?:|data:|blob:|javascript:|file:|ftp:|\/\/)/i;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unpacks a `.tgs` (gzip) with the size cap. */
export async function inflateTgs(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new StickerError('bad-tgs');
  return inflateCapped(bytes, 'gzip', MAX_TGS_JSON_BYTES, 'tgs-too-big');
}

function filterLayers(list: unknown): Json[] {
  if (!Array.isArray(list)) throw new StickerError('bad-tgs');
  return list.filter((l): l is Json => isObj(l) && KEPT_LAYERS.has(l.ty as number));
}

/**
 * Removes expressions and external addresses everywhere, iteratively (a deep
 * tree cannot overflow the stack). Returns the number of objects and arrays.
 */
function scrub(root: unknown): number {
  let nodes = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      nodes++;
      if (nodes > MAX_TGS_NODES) throw new StickerError('tgs-too-complex');
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i];
        if (typeof x === 'string' && URLISH.test(x)) v.splice(i, 1);
        else if (typeof x === 'object' && x !== null) stack.push(x);
      }
    } else if (isObj(v)) {
      nodes++;
      if (nodes > MAX_TGS_NODES) throw new StickerError('tgs-too-complex');
      for (const k of Object.keys(v)) {
        const x = v[k];
        // A Lottie expression is a string `x` on an animated property.
        if (k === 'x' && typeof x === 'string') delete v[k];
        else if (typeof x === 'string' && URLISH.test(x)) delete v[k];
        else if (k === '__proto__' || k === 'constructor' || k === 'prototype') delete v[k];
        else if (typeof x === 'object' && x !== null) stack.push(x);
      }
    }
  }
  return nodes;
}

/** Checks and cleans parsed Lottie JSON; throws StickerError for anything unsafe or too heavy. */
export function sanitizeLottie(input: unknown): SanitizedLottie {
  if (!isObj(input)) throw new StickerError('bad-tgs');
  const { fr, ip, op, w, h } = input;
  if (!num(fr) || !num(ip) || !num(op) || !num(w) || !num(h)) throw new StickerError('bad-tgs');
  if (fr <= 0 || fr > MAX_TGS_FPS || op <= ip || ip < 0) throw new StickerError('tgs-too-long');
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_STICKER_SIDE || h > MAX_STICKER_SIDE) {
    throw new StickerError('bad-size');
  }
  if ((op - ip) / fr > MAX_TGS_SECONDS) throw new StickerError('tgs-too-long');

  const data: Json = {};
  for (const k of ['v', 'fr', 'ip', 'op', 'w', 'h', 'nm', 'ddd', 'tgs']) if (k in input) data[k] = input[k];
  data.layers = filterLayers(input.layers);
  // Only precompositions among the assets: no images, sounds, fonts or data files.
  const assets = Array.isArray(input.assets)
    ? input.assets.filter((a): a is Json => isObj(a) && typeof a.id === 'string' && Array.isArray(a.layers))
    : [];
  data.assets = assets.map((a) => ({ id: a.id, ...(num(a.fr) ? { fr: a.fr } : {}), layers: filterLayers(a.layers) }));

  scrub(data);

  // Layer counts and precomposition references.
  const byId = new Map<string, Json[]>();
  for (const a of data.assets as Json[]) byId.set(a.id as string, a.layers as Json[]);
  let layers = (data.layers as Json[]).length;
  for (const l of byId.values()) layers += l.length;
  if (layers > MAX_TGS_LAYERS) throw new StickerError('tgs-too-complex');
  const expanded = new Map<string, number>();
  const visiting = new Set<string>();
  const expand = (list: Json[], depth: number): number => {
    if (depth > 32) throw new StickerError('tgs-too-complex');
    let n = 0;
    for (const l of list) {
      n++;
      if (l.ty === 0) {
        const ref = l.refId;
        if (typeof ref !== 'string' || !byId.has(ref)) continue;
        if (visiting.has(ref)) throw new StickerError('tgs-too-complex');
        let sub = expanded.get(ref);
        if (sub === undefined) {
          visiting.add(ref);
          sub = expand(byId.get(ref)!, depth + 1);
          visiting.delete(ref);
          expanded.set(ref, sub);
        }
        n += sub;
      }
      if (n > MAX_TGS_EXPANDED_LAYERS) throw new StickerError('tgs-too-complex');
    }
    return n;
  };
  expand(data.layers as Json[], 0);

  return { data, info: { width: w, height: h, fps: fr, frames: Math.ceil(op - ip) } };
}

/** Unpacks, parses and sanitises a `.tgs` file. */
export async function readTgs(bytes: Uint8Array): Promise<SanitizedLottie> {
  const raw = await inflateTgs(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new StickerError('bad-tgs');
  }
  return sanitizeLottie(parsed);
}
