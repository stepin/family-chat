// Signed envelopes: {"payload":"<base64url>","sig":"<base64url>"}.
// sig = Ed25519(utf8("fc/v1/" + kind + "\n") || payload bytes). Verification always works on
// the received payload bytes; nothing is re-serialised.

import { concat, equalBytes, utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base64urlDecode, base64urlDecodeExact, base64urlEncode } from './codec.ts';
import {
  DEV_ID_BYTES,
  MAX_ENVELOPE_PAYLOAD_BYTES,
  MAX_NAME_CHARS,
  MAX_STATE_PAYLOAD_BYTES,
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

export type EnvelopeKind = 'identity' | 'profile' | 'auth' | 'revoked' | 'group-state' | 'group-key';

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

/** Reference to an avatar image uploaded with PUT /me/avatar: SHA-256 of the file and its type. */
export interface AvatarRef {
  /** base64url (no padding) of the 32-byte SHA-256 of the image file. */
  readonly sha256: string;
  readonly type: AvatarType;
}
export type AvatarType = 'image/jpeg' | 'image/webp';
export const AVATAR_TYPES: readonly AvatarType[] = ['image/jpeg', 'image/webp'];

export type Avatar = null | AvatarRef;

/** A verified profile. */
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

/** A verified identity revocation: the owner of the key declares it no longer valid. */
export interface Revocation {
  readonly userId: string;
  readonly revokedAt: number;
  readonly envelope: SignedEnvelope;
}

export function envelopeSigningInput(kind: EnvelopeKind, payload: Uint8Array): Bytes {
  return concat(utf8(`fc/v1/${kind}\n`), payload);
}

/** Largest payload of an envelope kind; group states carry member lists and get more room. */
export function maxPayloadBytes(kind: EnvelopeKind): number {
  return kind === 'group-state' ? MAX_STATE_PAYLOAD_BYTES : MAX_ENVELOPE_PAYLOAD_BYTES;
}

/** Sign exact payload bytes. Internal: used by the group modules. */
export function sealBytes(kind: EnvelopeKind, bytes: Uint8Array, keys: IdentityKeys): SignedEnvelope {
  if (bytes.length > maxPayloadBytes(kind)) throw new ProtocolError('too-large', `${kind} payload is too large`);
  const sig = sign(envelopeSigningInput(kind, bytes), keys.signSecret);
  return { payload: base64urlEncode(bytes), sig: base64urlEncode(sig) };
}

function seal(kind: EnvelopeKind, payload: JsonObject, keys: IdentityKeys): SignedEnvelope {
  const bytes = utf8(JSON.stringify(payload));
  if (bytes.length > maxPayloadBytes(kind)) throw new ProtocolError('too-large', `${kind} payload is too large`);
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

export interface Opened {
  env: SignedEnvelope;
  bytes: Bytes;
  sig: Bytes;
  json: JsonObject;
}

/** Shape, size and version of an envelope; no signature check. Internal. */
export function openEnvelope(input: unknown, kind: EnvelopeKind): Opened {
  return open(input, kind);
}

/** Signature check over the received bytes. Internal. */
export function checkEnvelopeSignature(o: Opened, kind: EnvelopeKind, signPub: Uint8Array): void {
  checkSig(o, kind, signPub);
}

function open(input: unknown, kind: EnvelopeKind): Opened {
  const env = parseEnvelope(input);
  // base64url of MAX bytes is at most ceil(MAX * 4 / 3) characters; check before decoding.
  if (env.payload.length > Math.ceil((maxPayloadBytes(kind) * 4) / 3)) {
    throw new ProtocolError('too-large', `${kind} payload is too large`);
  }
  const bytes = base64urlDecode(env.payload);
  if (bytes.length > maxPayloadBytes(kind)) throw new ProtocolError('too-large', `${kind} payload is too large`);
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
  /** Avatar reference; null or absent means no avatar. */
  readonly avatar?: AvatarRef | null;
}

/** Problem with an avatar reference, or undefined if it is valid (exactly the keys sha256 and type). */
function avatarProblem(a: unknown): string | undefined {
  if (a === null) return undefined;
  if (!isObject(a)) return 'avatar must be null or an object';
  const keys = Object.keys(a);
  if (keys.length !== 2 || !('sha256' in a) || !('type' in a)) return 'avatar must have exactly "sha256" and "type"';
  try {
    base64urlDecodeExact(a.sha256, 32, 'avatar sha256');
  } catch {
    return 'avatar sha256 must be base64url of 32 bytes';
  }
  if (!AVATAR_TYPES.includes(a.type as AvatarType)) return 'avatar type must be image/jpeg or image/webp';
  return undefined;
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
  const avatarIn = input.avatar ?? null;
  const ap = avatarProblem(avatarIn);
  if (ap) throw new ProtocolError('invalid-argument', ap);
  const avatar = avatarIn === null ? null : { sha256: avatarIn.sha256, type: avatarIn.type };
  return seal('profile', { v: PROTOCOL_VERSION, userId: keys.userId, name, avatar, rev: input.rev, updated }, keys);
}

/** Verify a profile envelope against the owner's verified identity. */
export function verifyProfileEnvelope(input: unknown, identity: Identity): Profile {
  const o = open(input, 'profile');
  const userId = checkUserId(o.json.userId, 'profile');
  const name = requireString(o.json, 'name', 'profile');
  const problem = nameProblem(name, MAX_NAME_CHARS);
  if (problem) throw malformed(`profile: ${problem}`);
  const avatarIn = o.json.avatar;
  const ap = avatarProblem(avatarIn);
  if (ap) throw malformed(`profile: ${ap}`);
  const avatar: Avatar =
    avatarIn === null ? null : { sha256: (avatarIn as AvatarRef).sha256, type: (avatarIn as AvatarRef).type };
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

// ---- revoked ----

/**
 * Revoke an identity: signed by the identity itself, so only the holder of the key can revoke it.
 * Clients stop trusting the identity from `revokedAt` on (PROTOCOL.md 4.5).
 */
export function createRevocationEnvelope(keys: IdentityKeys, revokedAt: number = Date.now()): SignedEnvelope {
  if (!Number.isSafeInteger(revokedAt) || revokedAt < 0) {
    throw new ProtocolError('invalid-argument', 'revokedAt must be a non-negative integer (ms)');
  }
  return seal('revoked', { v: PROTOCOL_VERSION, userId: keys.userId, revokedAt }, keys);
}

/** Verify a revocation against the revoked user's verified identity. */
export function verifyRevocationEnvelope(input: unknown, identity: Identity): Revocation {
  const o = open(input, 'revoked');
  const userId = checkUserId(o.json.userId, 'revoked');
  const revokedAt = requireUint(o.json, 'revokedAt', 'revoked');
  if (userId !== identity.userId) throw new ProtocolError('user-id-mismatch', 'revocation belongs to another user');
  checkSig(o, 'revoked', identity.signPub);
  return { userId, revokedAt, envelope: o.env };
}
