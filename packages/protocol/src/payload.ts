// Event payloads: UTF-8 JSON. Common fields of every kind: v, t, id, dev, seq, crit?.
// M1 implements the `msg` kind only. Unknown kinds (or unknown versions) marked
// "crit": true decode to "update the app"; other unknown kinds decode to "ignore".

import { utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact } from './codec.ts';
import { DEV_ID_BYTES, MAX_BODY_BYTES, MESSAGE_ID_BYTES, PROTOCOL_VERSION, USER_ID_BYTES } from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';
import { isObject, isSafeUint, parseJsonObject, type JsonObject } from './json.ts';

/** Reference to a message: the pair (author userId, message id). */
export interface MsgRef {
  readonly author: string;
  readonly id: string;
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

/** A text message (M1). `body` is Markdown, at most 16 KB of UTF-8. */
export interface MsgPayload extends Common {
  readonly t: 'msg';
  readonly body?: string;
  readonly reply?: MsgRef;
}

// The kinds below are type definitions only (planned for M4); M1 has no logic for them
// and decodes them like any unknown kind.
export interface EditPayload extends Common {
  readonly t: 'edit';
  readonly target: MsgRef;
  readonly body: string;
}
export interface DeletePayload extends Common {
  readonly t: 'delete';
  readonly target: MsgRef;
  /** `seq` of the deleted event, so the gap it leaves is not reported as a loss. */
  readonly targetSeq: number;
}
export interface ReactPayload extends Common {
  readonly t: 'react';
  readonly target: MsgRef;
  readonly emoji: string;
  readonly on: boolean;
}

export type Payload = MsgPayload | EditPayload | DeletePayload | ReactPayload;

export type DecodedPayload =
  | { readonly kind: 'msg'; readonly msg: MsgPayload }
  /** Unknown critical kind: show "update the app to see this message". */
  | { readonly kind: 'update-required'; readonly t: string; readonly id: string; readonly dev?: string; readonly seq?: number }
  /** Unknown non-critical kind: skip silently (dev/seq still count for loss detection). */
  | { readonly kind: 'ignore'; readonly t: string; readonly id: string; readonly dev?: string; readonly seq?: number };

export interface MsgInput {
  readonly id: string;
  readonly dev: string;
  readonly seq: number;
  readonly body: string;
  readonly reply?: MsgRef;
}

function isB32(v: unknown, bytes: number): v is string {
  try {
    base32DecodeExact(v, bytes, 'id');
    return true;
  } catch {
    return false;
  }
}

function msgRefProblem(r: unknown): string | undefined {
  if (!isObject(r)) return 'reply must be an object';
  if (!isB32(r.author, USER_ID_BYTES)) return 'reply.author must be a userId';
  if (!isB32(r.id, MESSAGE_ID_BYTES)) return 'reply.id must be a message id';
  return undefined;
}

/** Serialise a `msg` payload. Field order is fixed: v, t, id, dev, seq, body, reply. */
export function encodeMsgPayload(input: MsgInput): Bytes {
  const bad = (m: string) => new ProtocolError('invalid-argument', `msg: ${m}`);
  if (!isB32(input.id, MESSAGE_ID_BYTES)) throw bad('id must be a message id');
  if (!isB32(input.dev, DEV_ID_BYTES)) throw bad('dev must be a devId');
  if (!isSafeUint(input.seq)) throw bad('seq must be a non-negative integer');
  if (typeof input.body !== 'string' || input.body.length === 0) throw bad('body must be a non-empty string');
  if (utf8(input.body).length > MAX_BODY_BYTES) {
    throw new ProtocolError('too-large', `msg: body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const out: JsonObject = { v: PROTOCOL_VERSION, t: 'msg', id: input.id, dev: input.dev, seq: input.seq, body: input.body };
  if (input.reply !== undefined) {
    const p = msgRefProblem(input.reply);
    if (p) throw bad(p);
    out.reply = { author: input.reply.author, id: input.reply.id };
  }
  return utf8(JSON.stringify(out));
}

/** Decode payload bytes. Throws ProtocolError `malformed` for invalid JSON or a broken known kind. */
export function decodePayload(bytes: Uint8Array): DecodedPayload {
  const o = parseJsonObject(bytes, 'payload');
  const { v, t, id, crit } = o;
  if (!isSafeUint(v) || v < 1) throw malformed('payload: v must be a positive integer');
  if (typeof t !== 'string' || t.length === 0) throw malformed('payload: t must be a non-empty string');
  if (crit !== undefined && typeof crit !== 'boolean') throw malformed('payload: crit must be a boolean');
  if (!isB32(id, MESSAGE_ID_BYTES)) throw malformed('payload: id must be a message id');

  if (v === PROTOCOL_VERSION && t === 'msg') return { kind: 'msg', msg: decodeMsg(o, id) };

  const extra: { dev?: string; seq?: number } = {};
  if (isB32(o.dev, DEV_ID_BYTES)) extra.dev = o.dev;
  if (isSafeUint(o.seq)) extra.seq = o.seq;
  return { kind: crit === true ? 'update-required' : 'ignore', t, id, ...extra };
}

function decodeMsg(o: JsonObject, id: string): MsgPayload {
  if (!isB32(o.dev, DEV_ID_BYTES)) throw malformed('msg: dev must be a devId');
  if (!isSafeUint(o.seq)) throw malformed('msg: seq must be a non-negative integer');
  const msg: { -readonly [K in keyof MsgPayload]: MsgPayload[K] } = { v: 1, t: 'msg', id, dev: o.dev, seq: o.seq };
  if (o.body !== undefined) {
    if (typeof o.body !== 'string') throw malformed('msg: body must be a string');
    if (utf8(o.body).length > MAX_BODY_BYTES) throw malformed('msg: body is too large');
    msg.body = o.body;
  }
  if (o.reply !== undefined) {
    const p = msgRefProblem(o.reply);
    if (p) throw malformed(`msg: ${p}`);
    const r = o.reply as JsonObject;
    msg.reply = { author: r.author as string, id: r.id as string };
  }
  return msg;
}
