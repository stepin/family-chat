// Signed envelopes: {"payload":"<base64url>","sig":"<base64url>"}.
// sig = Ed25519(utf8("fc/v1/" + kind + "\n") || payload bytes). Verification always works on
// the received payload bytes; nothing is re-serialised.

import { concat, equalBytes, utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base64urlDecode, base64urlDecodeExact, base64urlEncode } from './codec.ts';
import {
  DEV_ID_BYTES,
  MAX_ENVELOPE_PAYLOAD_BYTES,
  MAX_NAME_CHARS,
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  USER_ID_BYTES,
} from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';
import {
  checkContextString,
  isObject,
  nameProblem,
  parseJsonObject,
  requireString,
  requireUint,
  type JsonObject,
} from './json.ts';
import { checkSignPub, sign, userIdFromSignPub, verify, type IdentityKeys } from './keys.ts';

export type EnvelopeKind = 'identity' | 'profile' | 'auth';

export interface SignedEnvelope {
  readonly payload: string;
  readonly sig: string;
}

/** A verified identity: public keys bound to the self-certifying userId. */
export interface Identity {
  readonly userId: string;
  readonly signPub: Bytes;
  readonly boxPub: Bytes;
  readonly created: number;
  readonly envelope: SignedEnvelope;
}

export type Avatar = null | Readonly<Record<string, unknown>>;

/** A verified profile. `avatar` is always null in M1; its object form is defined in M2. */
export interface Profile {
  readonly userId: string;
  readonly name: string;
  readonly avatar: Avatar;
  readonly rev: number;
  readonly updated: number;
  readonly envelope: SignedEnvelope;
}

/** A verified auth envelope (adding a device by signing the server's challenge). */
export interface AuthRequest {
  readonly userId: string;
  readonly serverId: string;
  readonly nonce: string;
  readonly devId: string;
  readonly envelope: SignedEnvelope;
}

export function envelopeSigningInput(kind: EnvelopeKind, payload: Uint8Array): Bytes {
  return concat(utf8(`fc/v1/${kind}\n`), payload);
}

function seal(kind: EnvelopeKind, payload: JsonObject, keys: IdentityKeys): SignedEnvelope {
  const bytes = utf8(JSON.stringify(payload));
  if (bytes.length > MAX_ENVELOPE_PAYLOAD_BYTES) throw new ProtocolError('too-large', `${kind} payload is too large`);
  const sig = sign(envelopeSigningInput(kind, bytes), keys.signSecret);
  return { payload: base64urlEncode(bytes), sig: base64urlEncode(sig) };
}

/** Serialise an envelope as the exact wire JSON. */
export function serializeEnvelope(env: SignedEnvelope): string {
  return JSON.stringify({ payload: env.payload, sig: env.sig });
}

/** Parse an envelope from a JSON string or an already parsed value. Shape only, no signature check. */
export function parseEnvelope(input: unknown): SignedEnvelope {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw malformed('envelope: invalid JSON');
    }
  }
  if (!isObject(value)) throw malformed('envelope: not an object');
  const keys = Object.keys(value);
  if (keys.length !== 2 || typeof value.payload !== 'string' || typeof value.sig !== 'string') {
    throw malformed('envelope: expected exactly "payload" and "sig" strings');
  }
  return { payload: value.payload, sig: value.sig };
}

interface Opened {
  env: SignedEnvelope;
  bytes: Bytes;
  sig: Bytes;
  json: JsonObject;
}

function open(input: unknown, kind: EnvelopeKind): Opened {
  const env = parseEnvelope(input);
  // base64url of MAX bytes is at most ceil(MAX * 4 / 3) characters; check before decoding.
  if (env.payload.length > Math.ceil((MAX_ENVELOPE_PAYLOAD_BYTES * 4) / 3)) {
    throw new ProtocolError('too-large', `${kind} payload is too large`);
  }
  const bytes = base64urlDecode(env.payload);
  const sig = base64urlDecodeExact(env.sig, SIGNATURE_BYTES, `${kind} sig`);
  const json = parseJsonObject(bytes, `${kind} payload`);
  const v = json.v;
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError('unsupported-version', `${kind} payload version is not supported`);
  }
  return { env, bytes, sig, json };
}

function checkSig(o: Opened, kind: EnvelopeKind, signPub: Uint8Array): void {
  if (!verify(o.sig, envelopeSigningInput(kind, o.bytes), signPub)) {
    throw new ProtocolError('bad-signature', `${kind} signature does not verify`);
  }
}

function checkUserId(value: unknown, name: string): string {
  base32DecodeExact(value, USER_ID_BYTES, `${name} userId`);
  return value as string;
}

function checkDevId(value: unknown, code: 'malformed' | 'invalid-argument'): string {
  try {
    base32DecodeExact(value, DEV_ID_BYTES, 'devId');
  } catch {
    throw new ProtocolError(code, 'devId must be base32 of 10 bytes');
  }
  return value as string;
}

// ---- identity ----

export function createIdentityEnvelope(keys: IdentityKeys, created: number = Date.now()): SignedEnvelope {
  if (!Number.isSafeInteger(created) || created < 0) {
    throw new ProtocolError('invalid-argument', 'created must be a non-negative integer (ms)');
  }
  return seal(
    'identity',
    {
      v: PROTOCOL_VERSION,
      userId: keys.userId,
      signPub: base64urlEncode(keys.signPub),
      boxPub: base64urlEncode(keys.boxPub),
      created,
    },
    keys,
  );
}

/**
 * Verify a self-signed identity envelope: shape, version, key lengths, userId = hash of signPub,
 * signPub is a valid large-order point, signature by signPub.
 */
export function verifyIdentityEnvelope(input: unknown): Identity {
  const o = open(input, 'identity');
  const userId = checkUserId(o.json.userId, 'identity');
  const signPub = base64urlDecodeExact(o.json.signPub, PUBLIC_KEY_BYTES, 'identity signPub');
  const boxPub = base64urlDecodeExact(o.json.boxPub, PUBLIC_KEY_BYTES, 'identity boxPub');
  const created = requireUint(o.json, 'created', 'identity');
  if (userIdFromSignPub(signPub) !== userId) {
    throw new ProtocolError('user-id-mismatch', 'identity userId does not match signPub');
  }
  checkSignPub(signPub);
  checkSig(o, 'identity', signPub);
  return { userId, signPub, boxPub, created, envelope: o.env };
}

// ---- profile ----

export interface ProfileInput {
  readonly name: string;
  readonly rev: number;
  readonly updated?: number;
}

export function createProfileEnvelope(keys: IdentityKeys, input: ProfileInput): SignedEnvelope {
  const name = typeof input.name === 'string' ? input.name.trim() : input.name;
  const problem = nameProblem(name, MAX_NAME_CHARS);
  if (problem) throw new ProtocolError('invalid-argument', problem);
  const updated = input.updated ?? Date.now();
  if (!Number.isSafeInteger(input.rev) || input.rev < 0) {
    throw new ProtocolError('invalid-argument', 'rev must be a non-negative integer');
  }
  if (!Number.isSafeInteger(updated) || updated < 0) {
    throw new ProtocolError('invalid-argument', 'updated must be a non-negative integer (ms)');
  }
  return seal(
    'profile',
    { v: PROTOCOL_VERSION, userId: keys.userId, name, avatar: null, rev: input.rev, updated },
    keys,
  );
}

/** Verify a profile envelope against the owner's verified identity. */
export function verifyProfileEnvelope(input: unknown, identity: Identity): Profile {
  const o = open(input, 'profile');
  const userId = checkUserId(o.json.userId, 'profile');
  const name = requireString(o.json, 'name', 'profile');
  const problem = nameProblem(name, MAX_NAME_CHARS);
  if (problem) throw malformed(`profile: ${problem}`);
  const avatar = o.json.avatar;
  if (avatar !== null && !isObject(avatar)) throw malformed('profile: avatar must be null or an object');
  const rev = requireUint(o.json, 'rev', 'profile');
  const updated = requireUint(o.json, 'updated', 'profile');
  if (userId !== identity.userId) {
    throw new ProtocolError('user-id-mismatch', 'profile belongs to another user');
  }
  checkSig(o, 'profile', identity.signPub);
  return { userId, name, avatar, rev, updated, envelope: o.env };
}

// ---- auth ----

export interface AuthInput {
  readonly serverId: string;
  /** The server's challenge, copied verbatim. */
  readonly nonce: string;
  readonly devId: string;
}

export function createAuthEnvelope(keys: IdentityKeys, input: AuthInput): SignedEnvelope {
  const serverId = checkContextString(input.serverId, 'serverId', 'invalid-argument');
  const nonce = checkContextString(input.nonce, 'nonce', 'invalid-argument');
  const devId = checkDevId(input.devId, 'invalid-argument');
  return seal('auth', { v: PROTOCOL_VERSION, userId: keys.userId, serverId, nonce, devId }, keys);
}

/**
 * Verify an auth envelope against the user's verified identity. When `expected` is given,
 * serverId and nonce must match it exactly (the server always passes it).
 */
export function verifyAuthEnvelope(
  input: unknown,
  identity: Identity,
  expected?: { readonly serverId: string; readonly nonce: string },
): AuthRequest {
  const o = open(input, 'auth');
  const userId = checkUserId(o.json.userId, 'auth');
  const serverId = checkContextString(o.json.serverId, 'auth serverId', 'malformed');
  const nonce = checkContextString(o.json.nonce, 'auth nonce', 'malformed');
  const devId = checkDevId(o.json.devId, 'malformed');
  if (userId !== identity.userId) throw new ProtocolError('user-id-mismatch', 'auth belongs to another user');
  checkSig(o, 'auth', identity.signPub);
  if (expected) {
    // Compare as bytes in constant time; the nonce is a secret-ish challenge.
    const same =
      equalBytes(utf8(serverId), utf8(expected.serverId)) && equalBytes(utf8(nonce), utf8(expected.nonce));
    if (!same) throw new ProtocolError('context-mismatch', 'auth serverId or nonce does not match');
  }
  return { userId, serverId, nonce, devId, envelope: o.env };
}
