// Event payloads: UTF-8 JSON. Common fields of every kind: v, t, id, dev, seq, crit?.
// Implemented kinds (version 1): msg, edit, delete, react. Unknown kinds (or unknown versions)
// marked "crit": true decode to "update the app"; other unknown kinds decode to "ignore".
//
// decodePayload (used by decodeEvent) and parsePayload give the same typed form of every
// implemented kind (since M4 the client acts on edit/delete/react; until M3 decodePayload
// reported them as "ignore").

import { utf8, type Bytes } from './bytes.ts';
import { checkAttachmentInput, validateAttachment, type Attachment } from './attachment.ts';
import { base32DecodeExact } from './codec.ts';
import {
  DEV_ID_BYTES,
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MESSAGE_ID_BYTES,
  PROTOCOL_VERSION,
  USER_ID_BYTES,
} from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';
import { isObject, isSafeUint, nameProblem, parseJsonObject, type JsonObject } from './json.ts';

export type { Attachment } from './attachment.ts';

/** Reference to a message: the pair (author userId, message id). */
export interface MsgRef {
  readonly author: string;
  readonly id: string;
}

/** A point on the map: degrees (WGS 84) and accuracy radius in metres. */
export interface Location {
  readonly lat: number;
  readonly lon: number;
  readonly accuracy: number;
}

interface Common {
  readonly v: 1;
  /** Message id (also the Idempotency-Key); equals the id in the event header. */
  readonly id: string;
  /** Sending device. */
  readonly dev: string;
  /** Per (device, chat) counter, +1 for every event. */
  readonly seq: number;
}

/**
 * A message. `body` is Markdown, at most 16 KB of UTF-8. A sender includes at least one of
 * body, attachments (1..10) and location; a receiver accepts a msg with none of them.
 */
export interface MsgPayload extends Common {
  readonly t: 'msg';
  readonly body?: string;
  readonly reply?: MsgRef;
  /** Forwarded content. A bare marker: the original author is not named (it cannot be verified here). */
  readonly fwd?: true;
  readonly attachments?: readonly Attachment[];
  readonly location?: Location;
}

/** Replace the body of an own message. Only the author of `target` may edit it. */
export interface EditPayload extends Common {
  readonly t: 'edit';
  readonly target: MsgRef;
  /** New body, at most 16 KB; may be empty (a message with attachments may lose its caption). */
  readonly body: string;
}

/** Delete a message (by its author, or by the group owner). */
export interface DeletePayload extends Common {
  readonly t: 'delete';
  readonly target: MsgRef;
  /** `dev` and `seq` of the deleted event, so the gap it leaves is not reported as a loss. */
  readonly targetDev: string;
  readonly targetSeq: number;
}

/** Set (`on: true`) or clear a reaction of the sender on a message. */
export interface ReactPayload extends Common {
  readonly t: 'react';
  readonly target: MsgRef;
  readonly emoji: string;
  readonly on: boolean;
}

export type Payload = MsgPayload | EditPayload | DeletePayload | ReactPayload;

interface UnknownKind {
  readonly t: string;
  readonly id: string;
  readonly dev?: string;
  readonly seq?: number;
}

export type ParsedPayload =
  | { readonly kind: 'msg'; readonly msg: MsgPayload }
  | { readonly kind: 'edit'; readonly edit: EditPayload }
  | { readonly kind: 'delete'; readonly delete: DeletePayload }
  | { readonly kind: 'react'; readonly react: ReactPayload }
  /** Unknown critical kind: show "update the app to see this message". */
  | ({ readonly kind: 'update-required' } & UnknownKind)
  /** Unknown non-critical kind (or unknown version): skip (dev/seq still count). */
  | ({ readonly kind: 'ignore' } & UnknownKind);

/** What decodeEvent delivers: the same as ParsedPayload. */
export type DecodedPayload = ParsedPayload;

export interface MsgInput {
  readonly id: string;
  readonly dev: string;
  readonly seq: number;
  readonly body?: string;
  readonly reply?: MsgRef;
  readonly fwd?: boolean;
  readonly attachments?: readonly Attachment[];
  readonly location?: Location;
}

interface CommonInput {
  readonly id: string;
  readonly dev: string;
  readonly seq: number;
  readonly target: MsgRef;
}
export interface EditInput extends CommonInput {
  readonly body: string;
}
export interface DeleteInput extends CommonInput {
  readonly targetDev: string;
  readonly targetSeq: number;
}
export interface ReactInput extends CommonInput {
  readonly emoji: string;
  readonly on: boolean;
}

/** Reaction emoji: 1..16 code points, at most 64 bytes, no control or bidi characters. */
export const MAX_EMOJI_CHARS = 16;
export const MAX_EMOJI_BYTES = 64;

function isB32(v: unknown, bytes: number): v is string {
  try {
    base32DecodeExact(v, bytes, 'id');
    return true;
  } catch {
    return false;
  }
}

function msgRefProblem(r: unknown, what: string): string | undefined {
  if (!isObject(r)) return `${what} must be an object`;
  if (!isB32(r.author, USER_ID_BYTES)) return `${what}.author must be a userId`;
  if (!isB32(r.id, MESSAGE_ID_BYTES)) return `${what}.id must be a message id`;
  return undefined;
}

function locationProblem(l: unknown): string | undefined {
  if (!isObject(l)) return 'location must be an object';
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!fin(l.lat) || l.lat < -90 || l.lat > 90) return 'location.lat must be a number -90..90';
  if (!fin(l.lon) || l.lon < -180 || l.lon > 180) return 'location.lon must be a number -180..180';
  if (!fin(l.accuracy) || l.accuracy < 0 || l.accuracy > 1e7) return 'location.accuracy must be metres 0..10^7';
  return undefined;
}

function emojiProblem(e: unknown): string | undefined {
  const p = nameProblem(e, MAX_EMOJI_CHARS);
  if (p) return `emoji: ${p}`;
  if (utf8(e as string).length > MAX_EMOJI_BYTES) return `emoji must be at most ${MAX_EMOJI_BYTES} bytes`;
  if ((e as string).trim() !== e) return 'emoji must not contain surrounding spaces';
  return undefined;
}

function bodyProblem(b: unknown): { code: 'malformed' | 'too-large'; message: string } | undefined {
  if (typeof b !== 'string') return { code: 'malformed', message: 'body must be a string' };
  if (utf8(b).length > MAX_BODY_BYTES) return { code: 'too-large', message: `body exceeds ${MAX_BODY_BYTES} bytes` };
  return undefined;
}

const ref = (r: MsgRef): MsgRef => ({ author: r.author, id: r.id });
const loc = (l: Location): Location => ({ lat: l.lat, lon: l.lon, accuracy: l.accuracy });

function commonOut(t: string, input: { id: string; dev: string; seq: number }, kind: string): JsonObject {
  const bad = (m: string) => new ProtocolError('invalid-argument', `${kind}: ${m}`);
  if (!isB32(input.id, MESSAGE_ID_BYTES)) throw bad('id must be a message id');
  if (!isB32(input.dev, DEV_ID_BYTES)) throw bad('dev must be a devId');
  if (!isSafeUint(input.seq)) throw bad('seq must be a non-negative integer');
  return { v: PROTOCOL_VERSION, t, id: input.id, dev: input.dev, seq: input.seq };
}

function checkBodyInput(body: unknown, kind: string): void {
  const p = bodyProblem(body);
  if (p) throw new ProtocolError(p.code === 'too-large' ? 'too-large' : 'invalid-argument', `${kind}: ${p.message}`);
}

/**
 * Serialise a `msg` payload. Field order is fixed: v, t, id, dev, seq, body, reply, fwd,
 * attachments, location. At least one of a non-empty body, attachments and location is required.
 */
export function encodeMsgPayload(input: MsgInput): Bytes {
  const bad = (m: string) => new ProtocolError('invalid-argument', `msg: ${m}`);
  const out = commonOut('msg', input, 'msg');
  if (input.body !== undefined) {
    checkBodyInput(input.body, 'msg');
    if (input.body.length === 0) throw bad('body must not be empty (omit it instead)');
    out.body = input.body;
  }
  if (input.reply !== undefined) {
    const p = msgRefProblem(input.reply, 'reply');
    if (p) throw bad(p);
    out.reply = ref(input.reply);
  }
  if (input.fwd !== undefined && input.fwd !== false) {
    if (input.fwd !== true) throw bad('fwd must be a boolean');
    out.fwd = true;
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length === 0 || input.attachments.length > MAX_ATTACHMENTS) {
      throw bad(`attachments must be a list of 1..${MAX_ATTACHMENTS}`);
    }
    out.attachments = input.attachments.map((a) => checkAttachmentInput(a));
  }
  if (input.location !== undefined) {
    const p = locationProblem(input.location);
    if (p) throw bad(p);
    out.location = loc(input.location);
  }
  if (out.body === undefined && out.attachments === undefined && out.location === undefined) {
    throw bad('a message needs a body, attachments or a location');
  }
  return utf8(JSON.stringify(out));
}

/** Serialise an `edit` payload: v, t, id, dev, seq, target, body. */
export function encodeEditPayload(input: EditInput): Bytes {
  const out = commonOut('edit', input, 'edit');
  const p = msgRefProblem(input.target, 'target');
  if (p) throw new ProtocolError('invalid-argument', `edit: ${p}`);
  checkBodyInput(input.body, 'edit');
  out.target = ref(input.target);
  out.body = input.body;
  return utf8(JSON.stringify(out));
}

/** Serialise a `delete` payload: v, t, id, dev, seq, target, targetDev, targetSeq. */
export function encodeDeletePayload(input: DeleteInput): Bytes {
  const bad = (m: string) => new ProtocolError('invalid-argument', `delete: ${m}`);
  const out = commonOut('delete', input, 'delete');
  const p = msgRefProblem(input.target, 'target');
  if (p) throw bad(p);
  if (!isB32(input.targetDev, DEV_ID_BYTES)) throw bad('targetDev must be a devId');
  if (!isSafeUint(input.targetSeq)) throw bad('targetSeq must be a non-negative integer');
  out.target = ref(input.target);
  out.targetDev = input.targetDev;
  out.targetSeq = input.targetSeq;
  return utf8(JSON.stringify(out));
}

/** Serialise a `react` payload: v, t, id, dev, seq, target, emoji, on. */
export function encodeReactPayload(input: ReactInput): Bytes {
  const bad = (m: string) => new ProtocolError('invalid-argument', `react: ${m}`);
  const out = commonOut('react', input, 'react');
  const p = msgRefProblem(input.target, 'target') ?? emojiProblem(input.emoji);
  if (p) throw bad(p);
  if (typeof input.on !== 'boolean') throw bad('on must be a boolean');
  out.target = ref(input.target);
  out.emoji = input.emoji;
  out.on = input.on;
  return utf8(JSON.stringify(out));
}

/**
 * Parse payload bytes into the full typed form. Throws ProtocolError `malformed` for invalid JSON
 * or a broken implemented kind.
 */
export function parsePayload(bytes: Uint8Array): ParsedPayload {
  const o = parseJsonObject(bytes, 'payload');
  const { v, t, id, crit } = o;
  if (!isSafeUint(v) || v < 1) throw malformed('payload: v must be a positive integer');
  if (typeof t !== 'string' || t.length === 0) throw malformed('payload: t must be a non-empty string');
  if (crit !== undefined && typeof crit !== 'boolean') throw malformed('payload: crit must be a boolean');
  if (!isB32(id, MESSAGE_ID_BYTES)) throw malformed('payload: id must be a message id');

  if (v === PROTOCOL_VERSION) {
    if (t === 'msg') return { kind: 'msg', msg: decodeMsg(o, id) };
    if (t === 'edit') return { kind: 'edit', edit: decodeEdit(o, id) };
    if (t === 'delete') return { kind: 'delete', delete: decodeDelete(o, id) };
    if (t === 'react') return { kind: 'react', react: decodeReact(o, id) };
  }

  const extra: { dev?: string; seq?: number } = {};
  if (isB32(o.dev, DEV_ID_BYTES)) extra.dev = o.dev;
  if (isSafeUint(o.seq)) extra.seq = o.seq;
  return { kind: crit === true ? 'update-required' : 'ignore', t, id, ...extra };
}

/** Common fields of any parsed payload: `id` always, `dev` and `seq` when they are well formed. */
export function payloadCommon(p: ParsedPayload): { id: string; dev?: string; seq?: number } {
  switch (p.kind) {
    case 'msg':
      return { id: p.msg.id, dev: p.msg.dev, seq: p.msg.seq };
    case 'edit':
      return { id: p.edit.id, dev: p.edit.dev, seq: p.edit.seq };
    case 'delete':
      return { id: p.delete.id, dev: p.delete.dev, seq: p.delete.seq };
    case 'react':
      return { id: p.react.id, dev: p.react.dev, seq: p.react.seq };
    default: {
      const out: { id: string; dev?: string; seq?: number } = { id: p.id };
      if (p.dev !== undefined) out.dev = p.dev;
      if (p.seq !== undefined) out.seq = p.seq;
      return out;
    }
  }
}

/**
 * Decode payload bytes into the form the client acts on: `msg`, `edit`, `delete`, `react`,
 * `update-required` or `ignore` (see parsePayload).
 */
export function decodePayload(bytes: Uint8Array): DecodedPayload {
  return parsePayload(bytes);
}

function commonIn(o: JsonObject, kind: string): { dev: string; seq: number } {
  if (!isB32(o.dev, DEV_ID_BYTES)) throw malformed(`${kind}: dev must be a devId`);
  if (!isSafeUint(o.seq)) throw malformed(`${kind}: seq must be a non-negative integer`);
  return { dev: o.dev, seq: o.seq };
}

function refIn(o: JsonObject, key: string, kind: string): MsgRef {
  const p = msgRefProblem(o[key], key);
  if (p) throw malformed(`${kind}: ${p}`);
  return ref(o[key] as MsgRef);
}

function bodyIn(o: JsonObject, kind: string): string {
  const p = bodyProblem(o.body);
  if (p) throw malformed(`${kind}: ${p.message}`);
  return o.body as string;
}

function decodeMsg(o: JsonObject, id: string): MsgPayload {
  const msg: { -readonly [K in keyof MsgPayload]: MsgPayload[K] } = { v: 1, t: 'msg', id, ...commonIn(o, 'msg') };
  if (o.body !== undefined) msg.body = bodyIn(o, 'msg');
  if (o.reply !== undefined) msg.reply = refIn(o, 'reply', 'msg');
  if (o.fwd !== undefined) {
    if (o.fwd !== true) throw malformed('msg: fwd must be true when present');
    msg.fwd = true;
  }
  if (o.attachments !== undefined) {
    const list = o.attachments;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ATTACHMENTS) {
      throw malformed(`msg: attachments must be a list of 1..${MAX_ATTACHMENTS}`);
    }
    msg.attachments = list.map((a) => validateAttachment(a));
  }
  if (o.location !== undefined) {
    const p = locationProblem(o.location);
    if (p) throw malformed(`msg: ${p}`);
    msg.location = loc(o.location as Location);
  }
  return msg;
}

function decodeEdit(o: JsonObject, id: string): EditPayload {
  return { v: 1, t: 'edit', id, ...commonIn(o, 'edit'), target: refIn(o, 'target', 'edit'), body: bodyIn(o, 'edit') };
}

function decodeDelete(o: JsonObject, id: string): DeletePayload {
  const c = commonIn(o, 'delete');
  const target = refIn(o, 'target', 'delete');
  if (!isB32(o.targetDev, DEV_ID_BYTES)) throw malformed('delete: targetDev must be a devId');
  if (!isSafeUint(o.targetSeq)) throw malformed('delete: targetSeq must be a non-negative integer');
  return { v: 1, t: 'delete', id, ...c, target, targetDev: o.targetDev, targetSeq: o.targetSeq };
}

function decodeReact(o: JsonObject, id: string): ReactPayload {
  const c = commonIn(o, 'react');
  const target = refIn(o, 'target', 'react');
  const p = emojiProblem(o.emoji);
  if (p) throw malformed(`react: ${p}`);
  if (typeof o.on !== 'boolean') throw malformed('react: on must be a boolean');
  return { v: 1, t: 'react', id, ...c, target, emoji: o.emoji as string, on: o.on };
}
