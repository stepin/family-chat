// Sealed epoch secrets (docs/PROTOCOL.md, section "Запечатанный ключ эпохи").
//
// envelope "group-key", signed by the signer of the state it refers to:
//   {"v":1,"serverId","chatId","epoch","recipient","stateVersion","stateHash","by","enc","ct"}
// enc, ct = HPKE base mode (DHKEM X25519, HKDF-SHA256, AES-256-GCM) to the recipient's boxPub:
//   info = "fc/v1/group-key\n" || lp(serverId) || lp(chatId) || u32 epoch || lp(recipient)
//          || u32 stateVersion || lp(stateHash),  aad = empty,  plaintext = epoch secret (32 bytes)

import { concat, equalBytes, lp, u32be, utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base64urlDecodeExact, base64urlEncode } from './codec.ts';
import { CHAT_ID_BYTES, EPOCH_SECRET_BYTES, PROTOCOL_VERSION, PUBLIC_KEY_BYTES, USER_ID_BYTES } from './constants.ts';
import { checkEnvelopeSignature, openEnvelope, sealBytes, type SignedEnvelope } from './envelope.ts';
import { malformed, ProtocolError } from './errors.ts';
import type { GroupState } from './group.ts';
import { HPKE_ENC_BYTES, hpkeOpen, hpkeSetupSender } from './hpke.ts';
import { checkContextString, isSafeUint, type JsonObject } from './json.ts';
import type { IdentityKeys } from './keys.ts';
import { randomBytes } from './random.ts';

export const LABEL_GROUP_KEY = 'fc/v1/group-key\n';
const SEALED_BYTES = EPOCH_SECRET_BYTES + 16;
const U32_MAX = 0xffffffff;

export interface SealGroupKeyInput {
  readonly serverId: string;
  readonly chatId: string;
  readonly epoch: number;
  /** The epoch secret. */
  readonly secret: Uint8Array;
  readonly recipient: { readonly userId: string; readonly boxPub: Uint8Array };
  /** Version and hash of the state that this key belongs to (the state the signer just wrote). */
  readonly stateVersion: number;
  readonly stateHash: Uint8Array;
}

/** Public fields of a sealed key, readable without decrypting (for routing and sorting). */
export interface GroupKeyHeader {
  readonly serverId: string;
  readonly chatId: string;
  readonly epoch: number;
  readonly recipient: string;
  readonly stateVersion: number;
  readonly stateHash: Bytes;
  readonly by: string;
}

/** A sealed key opened by its recipient. The signature is checked later by verifyGroupKey. Holds a secret. */
export interface OpenedGroupKey extends GroupKeyHeader {
  readonly secret: Bytes;
  readonly envelope: SignedEnvelope;
}

export function groupKeyInfo(
  serverId: string,
  chatId: string,
  epoch: number,
  recipient: string,
  stateVersion: number,
  stateHash: Uint8Array,
): Bytes {
  return concat(
    utf8(LABEL_GROUP_KEY),
    lp(serverId),
    lp(chatId),
    u32be(epoch),
    lp(recipient),
    u32be(stateVersion),
    lp(stateHash),
  );
}

function u32(v: unknown): v is number {
  return isSafeUint(v) && v <= U32_MAX;
}

/** Seal with a caller-chosen HPKE ephemeral seed. Internal (test vectors and builders). */
export async function sealGroupKeyWith(input: SealGroupKeyInput, signer: IdentityKeys, ikmE: Uint8Array): Promise<SignedEnvelope> {
  const bad = (m: string) => new ProtocolError('invalid-argument', `group key: ${m}`);
  checkContextString(input.serverId, 'serverId', 'invalid-argument');
  try {
    base32DecodeExact(input.chatId, CHAT_ID_BYTES, 'chatId');
    base32DecodeExact(input.recipient.userId, USER_ID_BYTES, 'recipient');
  } catch {
    throw bad('chatId and recipient must be base32 of 16 bytes');
  }
  if (!u32(input.epoch) || !u32(input.stateVersion) || input.stateVersion < 1) throw bad('epoch and stateVersion must be u32');
  if (!(input.secret instanceof Uint8Array) || input.secret.length !== EPOCH_SECRET_BYTES) throw bad('secret must be 32 bytes');
  if (!(input.stateHash instanceof Uint8Array) || input.stateHash.length !== 32) throw bad('stateHash must be 32 bytes');
  if (!(input.recipient.boxPub instanceof Uint8Array) || input.recipient.boxPub.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolError('invalid-key', 'recipient boxPub must be 32 bytes');
  }
  const info = groupKeyInfo(input.serverId, input.chatId, input.epoch, input.recipient.userId, input.stateVersion, input.stateHash);
  const sender = hpkeSetupSender(input.recipient.boxPub, info, { ikmE });
  const ct = await sender.context.seal(new Uint8Array(0), input.secret);
  const payload = {
    v: PROTOCOL_VERSION,
    serverId: input.serverId,
    chatId: input.chatId,
    epoch: input.epoch,
    recipient: input.recipient.userId,
    stateVersion: input.stateVersion,
    stateHash: base64urlEncode(input.stateHash),
    by: signer.userId,
    enc: base64urlEncode(sender.enc),
    ct: base64urlEncode(ct),
  };
  return sealBytes('group-key', utf8(JSON.stringify(payload)), signer);
}

interface ParsedKey extends GroupKeyHeader {
  readonly enc: Bytes;
  readonly ct: Bytes;
}

function parse(input: unknown): { opened: ReturnType<typeof openEnvelope>; key: ParsedKey } {
  const opened = openEnvelope(input, 'group-key');
  const j: JsonObject = opened.json;
  const serverId = checkContextString(j.serverId, 'group key serverId', 'malformed');
  base32DecodeExact(j.chatId, CHAT_ID_BYTES, 'group key chatId');
  base32DecodeExact(j.recipient, USER_ID_BYTES, 'group key recipient');
  base32DecodeExact(j.by, USER_ID_BYTES, 'group key by');
  if (!u32(j.epoch)) throw malformed('group key: epoch must be a u32');
  if (!u32(j.stateVersion) || j.stateVersion < 1) throw malformed('group key: stateVersion must be a positive u32');
  const key: ParsedKey = {
    serverId,
    chatId: j.chatId as string,
    epoch: j.epoch,
    recipient: j.recipient as string,
    stateVersion: j.stateVersion,
    stateHash: base64urlDecodeExact(j.stateHash, 32, 'group key stateHash'),
    by: j.by as string,
    enc: base64urlDecodeExact(j.enc, HPKE_ENC_BYTES, 'group key enc'),
    ct: base64urlDecodeExact(j.ct, SEALED_BYTES, 'group key ct'),
  };
  return { opened, key };
}

/**
 * The sealed key as the server stores and returns it (`GET /v1/keys`, field `key`): the JSON text
 * of the signed envelope. Returns the parsed value for openGroupKey / acceptGroupKey; text that is
 * not JSON is `malformed` (the shape itself is checked when the key is opened).
 */
export function parseSealedGroupKey(text: string): unknown {
  if (typeof text !== 'string') throw malformed('group key: not a string');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw malformed('group key: not JSON');
  }
}

/** Public fields of a sealed key without decrypting or checking the signature. */
export function readGroupKey(input: unknown): GroupKeyHeader {
  const { key } = parse(input);
  return {
    serverId: key.serverId,
    chatId: key.chatId,
    epoch: key.epoch,
    recipient: key.recipient,
    stateVersion: key.stateVersion,
    stateHash: key.stateHash,
    by: key.by,
  };
}

/**
 * Open a sealed key addressed to `me`. Checks: shape and version (`malformed`,
 * `unsupported-version`), serverId (`wrong-server`), recipient (`wrong-recipient`), HPKE open with
 * every bound field in the info (`wrong-key`: the key was moved to another chat, epoch, state or
 * member, or altered). The owner signature needs the state and is checked by verifyGroupKey.
 */
export async function openGroupKey(input: unknown, me: IdentityKeys, ctx: { readonly serverId: string }): Promise<OpenedGroupKey> {
  const { opened, key } = parse(input);
  if (key.serverId !== ctx.serverId) throw new ProtocolError('wrong-server', 'group key belongs to another server');
  if (key.recipient !== me.userId) throw new ProtocolError('wrong-recipient', 'group key is addressed to another member');
  const info = groupKeyInfo(key.serverId, key.chatId, key.epoch, key.recipient, key.stateVersion, key.stateHash);
  let secret: Bytes;
  try {
    secret = await hpkeOpen(key.enc, me.boxSecret, info, new Uint8Array(0), key.ct);
  } catch {
    throw new ProtocolError('wrong-key', 'group key does not open for this member and context');
  }
  return {
    serverId: key.serverId,
    chatId: key.chatId,
    epoch: key.epoch,
    recipient: key.recipient,
    stateVersion: key.stateVersion,
    stateHash: key.stateHash,
    by: key.by,
    secret,
    envelope: opened.env,
  };
}

/**
 * Check an opened key against the verified state it refers to: same chat (`wrong-chat`), same
 * version and hash (`state-mismatch`), same epoch (`wrong-epoch`), signed by the signer of that
 * state (`not-owner`, `bad-signature`).
 */
export function verifyGroupKey(key: OpenedGroupKey, state: GroupState): void {
  // Re-read the signed fields from the envelope rather than trusting the in-memory copy.
  const { opened, key: k } = parse(key.envelope);
  if (k.serverId !== state.serverId) throw new ProtocolError('wrong-server', 'group key belongs to another server');
  if (k.chatId !== state.chatId) throw new ProtocolError('wrong-chat', 'group key belongs to another chat');
  if (k.stateVersion !== state.version || !equalBytes(k.stateHash, state.stateHash)) {
    throw new ProtocolError('state-mismatch', 'group key refers to another state');
  }
  if (k.epoch !== state.epoch) throw new ProtocolError('wrong-epoch', 'group key belongs to another epoch');
  if (k.by !== state.by) throw new ProtocolError('not-owner', 'group key is not signed by the owner');
  checkEnvelopeSignature(opened, 'group-key', state.bySignPub);
}

/**
 * Seal the epoch secret for one member, signed by `signer` (the signer of the state it refers to).
 * The group builders call this for every member who needs the key.
 */
export function sealGroupKey(input: SealGroupKeyInput, signer: IdentityKeys): Promise<SignedEnvelope> {
  return sealGroupKeyWith(input, signer, randomBytes(32));
}
