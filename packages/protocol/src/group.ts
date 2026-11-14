// Groups (docs/PROTOCOL.md, section "Группы"): self-certifying group id, the signed group state
// with its ownership chain, epoch secrets and the encrypted state blob.
//
// chatId   = base32(SHA-256("fc/v1/group-id\n" || lp(creatorSignPub) || lp(nonce))[0..16])
// state    = envelope "group-state" signed by the owner the chain yields for this version
// transfer = Ed25519(previous owner, "fc/v1/group-transfer\n" || lp(serverId) || lp(chatId)
//                    || u32 version || lp(fromSignPub) || lp(toSignPub))
// blob     = "FCS" || 0x01 || u32 epoch || u32 version || serverTag(8) || chatTag(8) || nonce(12)
//            || AES-256-GCM(encKey, nonce, u32 len || envelope JSON || zero padding to 256, AAD)

import { concat, copy, equalBytes, isAllZero, lp, readU32be, u32be, utf8, type Bytes } from './bytes.ts';
import { GCM_NONCE_BYTES, GCM_TAG_BYTES, gcmOpen, gcmSeal } from './aead.ts';
import { base32DecodeExact, base32Encode, base64urlDecodeExact, base64urlEncode } from './codec.ts';
import {
  CHAT_ID_BYTES,
  EPOCH_SECRET_BYTES,
  EVENT_PADDING_BLOCK,
  FIRST_STATE_VERSION,
  GROUP_NONCE_BYTES,
  MAX_GROUP_MEMBERS,
  MAX_NAME_CHARS,
  MAX_STATE_BLOB_BYTES,
  PROTOCOL_VERSION,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  USER_ID_BYTES,
} from './constants.ts';
import { deriveEncKey, type ChatKeys } from './dm.ts';
import {
  checkEnvelopeSignature,
  openEnvelope,
  parseEnvelope,
  sealBytes,
  serializeEnvelope,
  type SignedEnvelope,
} from './envelope.ts';
import { malformed, ProtocolError } from './errors.ts';
import { chatTag, serverTag } from './event.ts';
import { checkContextString, isObject, isSafeUint, nameProblem, parseJsonObject, type JsonObject } from './json.ts';
import { checkSignPub, sha256Bytes, sign, userIdFromSignPub, verify, type IdentityKeys } from './keys.ts';
import { randomBytes } from './random.ts';

export const LABEL_GROUP_ID = 'fc/v1/group-id\n';
export const LABEL_GROUP_TRANSFER = 'fc/v1/group-transfer\n';
export const STATE_MAGIC = utf8('FCS');
export const STATE_FORMAT = 0x01;
export const STATE_HEADER_BYTES = 28;
const STATE_OVERHEAD = STATE_HEADER_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES;
const U32_MAX = 0xffffffff;

/** A member as listed in the state: identity public keys bound to the userId. */
export interface GroupMember {
  readonly userId: string;
  readonly signPub: Bytes;
  readonly boxPub: Bytes;
}

/** Input form of a member; a verified Identity fits. */
export interface GroupMemberInput {
  readonly userId: string;
  readonly signPub: Uint8Array;
  readonly boxPub: Uint8Array;
}

/** One ownership transfer, signed by the previous owner. */
export interface GroupTransfer {
  /** Version of the state that introduced the transfer. */
  readonly version: number;
  readonly to: string;
  readonly toSignPub: Bytes;
  readonly sig: Bytes;
}

/** A verified group state. */
export interface GroupState {
  readonly serverId: string;
  readonly chatId: string;
  readonly version: number;
  readonly epoch: number;
  readonly name: string;
  readonly creator: { readonly userId: string; readonly signPub: Bytes; readonly nonce: Bytes };
  /** Owner after all transfers; only the owner may write the next version. */
  readonly owner: string;
  /** Who signed this version: the owner before any transfer introduced by this version. */
  readonly by: string;
  readonly bySignPub: Bytes;
  readonly transfers: readonly GroupTransfer[];
  /** Sorted by userId, unique, includes the owner. */
  readonly members: readonly GroupMember[];
  /** stateHash of the previous version; null for version 1. */
  readonly prev: Bytes | null;
  /** SHA-256 of the exact payload bytes. */
  readonly stateHash: Bytes;
  readonly payloadBytes: Bytes;
  readonly envelope: SignedEnvelope;
}

export interface GroupStateContext {
  readonly serverId: string;
  readonly chatId: string;
  /** The previous accepted state; when given, the new state must follow it. */
  readonly prev?: GroupState;
  /** stateHash from a sealed key; when given, the state must have exactly this hash. */
  readonly expectedHash?: Uint8Array;
}

// ---- group id and epoch secrets ----

/** Random nonce for a new group id. */
export function newGroupNonce(): Bytes {
  return randomBytes(GROUP_NONCE_BYTES);
}

/** Self-certifying group id: base32(SHA-256("fc/v1/group-id\n" || lp(creatorSignPub) || lp(nonce))[0..16]). */
export function groupChatId(creatorSignPub: Uint8Array, nonce: Uint8Array): string {
  if (!(creatorSignPub instanceof Uint8Array) || creatorSignPub.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolError('invalid-argument', 'creator signPub must be 32 bytes');
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== GROUP_NONCE_BYTES) {
    throw new ProtocolError('invalid-argument', `group nonce must be ${GROUP_NONCE_BYTES} bytes`);
  }
  return base32Encode(sha256Bytes(concat(utf8(LABEL_GROUP_ID), lp(creatorSignPub), lp(nonce))).subarray(0, CHAT_ID_BYTES));
}

/** A new random epoch secret (32 bytes). Holds a secret. */
export function newEpochSecret(): Bytes {
  return randomBytes(EPOCH_SECRET_BYTES);
}

/** Group keys of an epoch: encKey = HKDF(secret, "fc/v1/enc"), the same function as for direct chats. */
export function deriveGroupKeys(secret: Uint8Array, epoch: number): ChatKeys {
  if (!(secret instanceof Uint8Array) || secret.length !== EPOCH_SECRET_BYTES) {
    throw new ProtocolError('invalid-argument', 'epoch secret must be 32 bytes');
  }
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > U32_MAX) throw new ProtocolError('invalid-argument', 'epoch must be a u32');
  return { epoch, encKey: deriveEncKey(secret) };
}

// ---- transfers ----

export function transferSigningInput(
  serverId: string,
  chatId: string,
  version: number,
  fromSignPub: Uint8Array,
  toSignPub: Uint8Array,
): Bytes {
  return concat(utf8(LABEL_GROUP_TRANSFER), lp(serverId), lp(chatId), u32be(version), lp(fromSignPub), lp(toSignPub));
}

/** Sign a transfer of ownership to `to`, effective in state `version`. Internal. */
export function signTransfer(
  owner: IdentityKeys,
  serverId: string,
  chatId: string,
  version: number,
  to: GroupMemberInput,
): GroupTransfer {
  const toSignPub = copy(to.signPub);
  const sig = sign(transferSigningInput(serverId, chatId, version, owner.signPub, toSignPub), owner.signSecret);
  return { version, to: to.userId, toSignPub, sig };
}

// ---- state payload ----

export interface GroupStateFields {
  readonly serverId: string;
  readonly chatId: string;
  readonly version: number;
  readonly epoch: number;
  readonly name: string;
  readonly creatorSignPub: Uint8Array;
  readonly nonce: Uint8Array;
  readonly owner: string;
  readonly transfers: readonly GroupTransfer[];
  readonly members: readonly GroupMemberInput[];
  readonly prev: Uint8Array | null;
}

/**
 * Serialise and sign a state. Field order: v, serverId, chatId, version, epoch, name, creator,
 * owner, by, transfers, members, prev. Members are sorted by userId. Internal: the builders in
 * group-ops.ts call it and then verify the result.
 */
export function encodeGroupState(fields: GroupStateFields, signer: IdentityKeys): SignedEnvelope {
  const members = [...fields.members].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const payload = {
    v: PROTOCOL_VERSION,
    serverId: fields.serverId,
    chatId: fields.chatId,
    version: fields.version,
    epoch: fields.epoch,
    name: fields.name,
    creator: { signPub: base64urlEncode(fields.creatorSignPub), nonce: base64urlEncode(fields.nonce) },
    owner: fields.owner,
    by: signer.userId,
    transfers: fields.transfers.map((t) => ({
      version: t.version,
      to: t.to,
      toSignPub: base64urlEncode(t.toSignPub),
      sig: base64urlEncode(t.sig),
    })),
    members: members.map((m) => ({ userId: m.userId, signPub: base64urlEncode(m.signPub), boxPub: base64urlEncode(m.boxPub) })),
    prev: fields.prev === null ? null : base64urlEncode(fields.prev),
  };
  return sealBytes('group-state', utf8(JSON.stringify(payload)), signer);
}

function userIdField(v: unknown, what: string): string {
  base32DecodeExact(v, USER_ID_BYTES, what);
  return v as string;
}

function u32Field(o: JsonObject, key: string, what: string): number {
  const v = o[key];
  if (!isSafeUint(v) || v > U32_MAX) throw malformed(`${what}: ${key} must be a u32`);
  return v;
}

function parseMembers(v: unknown): GroupMember[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_GROUP_MEMBERS) {
    throw malformed(`state: members must be a list of 1..${MAX_GROUP_MEMBERS}`);
  }
  const out: GroupMember[] = [];
  for (const m of v) {
    if (!isObject(m)) throw malformed('state: member must be an object');
    const member = {
      userId: userIdField(m.userId, 'member userId'),
      signPub: base64urlDecodeExact(m.signPub, PUBLIC_KEY_BYTES, 'member signPub'),
      boxPub: base64urlDecodeExact(m.boxPub, PUBLIC_KEY_BYTES, 'member boxPub'),
    };
    const last = out[out.length - 1];
    if (last && !(last.userId < member.userId)) throw malformed('state: members must be sorted by userId and unique');
    out.push(member);
  }
  return out;
}

function parseTransfers(v: unknown): GroupTransfer[] {
  if (!Array.isArray(v)) throw malformed('state: transfers must be a list');
  return v.map((t) => {
    if (!isObject(t)) throw malformed('state: transfer must be an object');
    return {
      version: u32Field(t, 'version', 'transfer'),
      to: userIdField(t.to, 'transfer to'),
      toSignPub: base64urlDecodeExact(t.toSignPub, PUBLIC_KEY_BYTES, 'transfer toSignPub'),
      sig: base64urlDecodeExact(t.sig, SIGNATURE_BYTES, 'transfer sig'),
    };
  });
}

function sameMember(a: GroupMember, b: GroupMember): boolean {
  return a.userId === b.userId && equalBytes(a.signPub, b.signPub) && equalBytes(a.boxPub, b.boxPub);
}

function sameTransfer(a: GroupTransfer, b: GroupTransfer): boolean {
  return a.version === b.version && a.to === b.to && equalBytes(a.toSignPub, b.toSignPub) && equalBytes(a.sig, b.sig);
}

/**
 * Verify a group state envelope. Checks, each with its own error: shape and version
 * (`malformed`, `unsupported-version`, `too-large`), serverId (`wrong-server`), chatId
 * (`wrong-chat`), expected hash (`state-mismatch`), member keys (`user-id-mismatch`,
 * `invalid-key`), chatId derived from the creator and the ownership chain (`bad-chain`),
 * signer is the owner the chain yields (`not-owner`), signature (`bad-signature`), and with a
 * previous state: same creator, version + 1, prev hash, epoch rules (`invalid-transition`),
 * transfers extend the previous chain (`bad-chain`), signed by the previous owner (`not-owner`).
 */
export function verifyGroupState(input: unknown, ctx: GroupStateContext): GroupState {
  const o = openEnvelope(input, 'group-state');
  const j = o.json;
  const serverId = checkContextString(j.serverId, 'state serverId', 'malformed');
  const chatId = j.chatId;
  base32DecodeExact(chatId, CHAT_ID_BYTES, 'state chatId');
  const version = u32Field(j, 'version', 'state');
  if (version < FIRST_STATE_VERSION) throw malformed('state: version must be at least 1');
  const epoch = u32Field(j, 'epoch', 'state');
  const name = j.name;
  const np = nameProblem(name, MAX_NAME_CHARS);
  if (np) throw malformed(`state: ${np}`);
  if (!isObject(j.creator)) throw malformed('state: creator must be an object');
  const creatorSignPub = base64urlDecodeExact(j.creator.signPub, PUBLIC_KEY_BYTES, 'creator signPub');
  const nonce = base64urlDecodeExact(j.creator.nonce, GROUP_NONCE_BYTES, 'creator nonce');
  const owner = userIdField(j.owner, 'state owner');
  const by = userIdField(j.by, 'state by');
  const transfers = parseTransfers(j.transfers);
  const members = parseMembers(j.members);
  let prev: Bytes | null = null;
  if (j.prev !== null) prev = base64urlDecodeExact(j.prev, 32, 'state prev');
  if ((version === FIRST_STATE_VERSION) !== (prev === null)) throw malformed('state: prev must be null exactly for version 1');

  if (serverId !== ctx.serverId) throw new ProtocolError('wrong-server', 'state belongs to another server');
  if (chatId !== ctx.chatId) throw new ProtocolError('wrong-chat', 'state belongs to another chat');
  const stateHash = sha256Bytes(o.bytes);
  if (ctx.expectedHash !== undefined && !equalBytes(stateHash, ctx.expectedHash)) {
    throw new ProtocolError('state-mismatch', 'state hash differs from the expected one');
  }

  for (const m of members) {
    if (userIdFromSignPub(m.signPub) !== m.userId) throw new ProtocolError('user-id-mismatch', 'member userId does not match signPub');
    checkSignPub(m.signPub);
  }

  // Origin: the chat id must come from the creator key, then every transfer is signed by the
  // owner before it.
  if (groupChatId(creatorSignPub, nonce) !== chatId) throw new ProtocolError('bad-chain', 'chatId is not derived from the creator key');
  const badChain = (m: string) => new ProtocolError('bad-chain', `ownership chain: ${m}`);
  try {
    checkSignPub(creatorSignPub);
  } catch {
    throw badChain('creator key is invalid');
  }
  let cur = { userId: userIdFromSignPub(creatorSignPub), signPub: creatorSignPub };
  let signer = cur;
  let lastVersion = FIRST_STATE_VERSION;
  for (const t of transfers) {
    if (t.version <= lastVersion || t.version > version) throw badChain('transfer versions must grow and not exceed the state version');
    if (userIdFromSignPub(t.toSignPub) !== t.to) throw badChain('transfer target does not match its key');
    try {
      checkSignPub(t.toSignPub);
    } catch {
      throw badChain('transfer target key is invalid');
    }
    if (t.to === cur.userId) throw badChain('transfer to the current owner');
    if (!verify(t.sig, transferSigningInput(serverId, chatId, t.version, cur.signPub, t.toSignPub), cur.signPub)) {
      throw badChain('transfer is not signed by the previous owner');
    }
    if (t.version < version) signer = { userId: t.to, signPub: t.toSignPub };
    cur = { userId: t.to, signPub: t.toSignPub };
    lastVersion = t.version;
  }
  if (owner !== cur.userId) throw badChain('owner is not the end of the chain');
  if (!members.some((m) => m.userId === owner)) throw malformed('state: the owner must be a member');
  if (by !== signer.userId) throw new ProtocolError('not-owner', 'state is not signed by the owner');
  checkEnvelopeSignature(o, 'group-state', signer.signPub);

  const state: GroupState = {
    serverId,
    chatId: chatId as string,
    version,
    epoch,
    name: name as string,
    creator: { userId: userIdFromSignPub(creatorSignPub), signPub: creatorSignPub, nonce },
    owner,
    by,
    bySignPub: signer.signPub,
    transfers,
    members,
    prev,
    stateHash,
    payloadBytes: o.bytes,
    envelope: o.env,
  };
  if (ctx.prev) checkTransition(ctx.prev, state);
  return state;
}

function checkTransition(p: GroupState, s: GroupState): void {
  const bad = (m: string) => new ProtocolError('invalid-transition', `state transition: ${m}`);
  if (p.serverId !== s.serverId || p.chatId !== s.chatId) throw bad('another group');
  if (!equalBytes(p.creator.signPub, s.creator.signPub) || !equalBytes(p.creator.nonce, s.creator.nonce)) throw bad('creator changed');
  if (s.version !== p.version + 1) throw bad('version must be the previous version + 1');
  if (s.prev === null || !equalBytes(s.prev, p.stateHash)) throw bad('prev is not the hash of the previous state');
  if (s.transfers.length < p.transfers.length || s.transfers.length > p.transfers.length + 1) {
    throw new ProtocolError('bad-chain', 'ownership chain: must extend the previous chain by at most one transfer');
  }
  p.transfers.forEach((t, i) => {
    if (!sameTransfer(t, s.transfers[i] as GroupTransfer)) throw new ProtocolError('bad-chain', 'ownership chain: earlier transfers changed');
  });
  const added = s.transfers[p.transfers.length];
  if (added && added.version !== s.version) throw new ProtocolError('bad-chain', 'ownership chain: a new transfer must belong to this version');
  if (s.by !== p.owner) throw new ProtocolError('not-owner', 'change is not signed by the owner of the previous state');
  if (s.epoch !== p.epoch && s.epoch !== p.epoch + 1) throw bad('epoch must stay or grow by one');
  const removed = p.members.some((m) => !s.members.some((n) => n.userId === m.userId));
  if (removed && s.epoch !== p.epoch + 1) throw bad('removing a member requires a new epoch');
  // A member's keys never change inside one group (a new key is a new identity).
  for (const m of s.members) {
    const old = p.members.find((x) => x.userId === m.userId);
    if (old && !sameMember(old, m)) throw bad('member keys changed');
  }
}

// ---- encrypted state blob ----

export interface StateBlobContext {
  readonly serverId: string;
  readonly chatId: string;
  /** Keys of the epoch the state belongs to. */
  readonly keys: ChatKeys;
}

function stateHeader(ctx: StateBlobContext, version: number): Bytes {
  return concat(STATE_MAGIC, Uint8Array.of(STATE_FORMAT), u32be(ctx.keys.epoch), u32be(version), serverTag(ctx.serverId), chatTag(ctx.chatId));
}

function stateAad(header: Uint8Array, ctx: StateBlobContext): Bytes {
  return concat(header, lp(ctx.serverId), lp(ctx.chatId));
}

function checkBlobContext(ctx: StateBlobContext): void {
  checkContextString(ctx.serverId, 'serverId', 'invalid-argument');
  checkContextString(ctx.chatId, 'chatId', 'invalid-argument');
  if (!Number.isInteger(ctx.keys.epoch) || ctx.keys.epoch < 0 || ctx.keys.epoch > U32_MAX) {
    throw new ProtocolError('invalid-argument', 'epoch must be a u32');
  }
  if (!(ctx.keys.encKey instanceof Uint8Array) || ctx.keys.encKey.length !== 32) {
    throw new ProtocolError('invalid-argument', 'encKey must be 32 bytes');
  }
}

/** Encrypt a verified state with its epoch key and a caller-chosen nonce. Internal (test vectors). */
export async function encryptGroupStateWithNonce(state: GroupState, ctx: StateBlobContext, nonce: Uint8Array): Promise<Bytes> {
  checkBlobContext(ctx);
  if (nonce.length !== GCM_NONCE_BYTES) throw new ProtocolError('invalid-argument', 'nonce must be 12 bytes');
  if (state.epoch !== ctx.keys.epoch) throw new ProtocolError('invalid-argument', 'keys belong to another epoch');
  if (state.serverId !== ctx.serverId || state.chatId !== ctx.chatId) {
    throw new ProtocolError('invalid-argument', 'state belongs to another chat');
  }
  const env = utf8(serializeEnvelope(state.envelope));
  const used = 4 + env.length;
  const plaintext = new Uint8Array(Math.ceil(used / EVENT_PADDING_BLOCK) * EVENT_PADDING_BLOCK);
  plaintext.set(concat(u32be(env.length), env));
  if (STATE_OVERHEAD + plaintext.length > MAX_STATE_BLOB_BYTES) throw new ProtocolError('too-large', 'state is too large');
  const header = stateHeader(ctx, state.version);
  return concat(header, nonce, await gcmSeal(ctx.keys.encKey, nonce, stateAad(header, ctx), plaintext));
}

/** Encrypt a verified state with its epoch key (random nonce). The result is what the server stores. */
export function encryptGroupState(state: GroupState, ctx: StateBlobContext): Promise<Bytes> {
  return encryptGroupStateWithNonce(state, ctx, randomBytes(GCM_NONCE_BYTES));
}

/** Epoch and version from the clear header of a state blob, to pick the key. */
export function readGroupStateHeader(blob: Uint8Array): { epoch: number; version: number } {
  if (!(blob instanceof Uint8Array) || blob.length < STATE_HEADER_BYTES) throw malformed('state blob: too short');
  if (!equalBytes(blob.subarray(0, 3), STATE_MAGIC)) throw malformed('state blob: bad magic');
  if (blob[3] !== STATE_FORMAT) throw new ProtocolError('unsupported-version', 'state blob format is not supported');
  return { epoch: readU32be(blob, 4), version: readU32be(blob, 8) };
}

/**
 * Decrypt and verify a state blob. Checks the layout (`malformed`, `too-large`), format
 * (`unsupported-version`), epoch (`wrong-epoch`), server (`wrong-server`), chat (`wrong-chat`),
 * AES-GCM (`wrong-key`), padding (`malformed`), then everything verifyGroupState checks, and
 * finally that the clear header matches the signed version and epoch (`malformed`).
 */
export async function openGroupState(
  blob: Uint8Array,
  ctx: StateBlobContext & { readonly prev?: GroupState; readonly expectedHash?: Uint8Array },
): Promise<GroupState> {
  checkBlobContext(ctx);
  if (!(blob instanceof Uint8Array)) throw malformed('state blob: not bytes');
  if (blob.length > MAX_STATE_BLOB_BYTES) throw new ProtocolError('too-large', 'state blob exceeds the size limit');
  if (blob.length < STATE_OVERHEAD + EVENT_PADDING_BLOCK || (blob.length - STATE_OVERHEAD) % EVENT_PADDING_BLOCK !== 0) {
    throw malformed('state blob: invalid length');
  }
  const { epoch, version } = readGroupStateHeader(blob);
  if (epoch !== ctx.keys.epoch) throw new ProtocolError('wrong-epoch', 'state blob belongs to another epoch');
  if (!equalBytes(blob.subarray(12, 20), serverTag(ctx.serverId))) throw new ProtocolError('wrong-server', 'state blob belongs to another server');
  if (!equalBytes(blob.subarray(20, 28), chatTag(ctx.chatId))) throw new ProtocolError('wrong-chat', 'state blob belongs to another chat');
  const header = copy(blob.subarray(0, STATE_HEADER_BYTES));
  const nonce = blob.subarray(STATE_HEADER_BYTES, STATE_HEADER_BYTES + GCM_NONCE_BYTES);
  const plaintext = await gcmOpen(ctx.keys.encKey, nonce, stateAad(header, ctx), blob.subarray(STATE_HEADER_BYTES + GCM_NONCE_BYTES));
  if (!plaintext) throw new ProtocolError('wrong-key', 'state blob does not decrypt with this epoch key');
  const len = readU32be(plaintext, 0);
  if (len > plaintext.length - 4) throw malformed('state blob: length exceeds plaintext');
  const used = 4 + len;
  if (Math.ceil(used / EVENT_PADDING_BLOCK) * EVENT_PADDING_BLOCK !== plaintext.length) throw malformed('state blob: padding is not minimal');
  if (!isAllZero(plaintext.subarray(used))) throw malformed('state blob: padding is not zero');
  const envJson = parseJsonObject(plaintext.subarray(4, used), 'state envelope');
  const state = verifyGroupState(parseEnvelope(envJson), {
    serverId: ctx.serverId,
    chatId: ctx.chatId,
    ...(ctx.prev ? { prev: ctx.prev } : {}),
    ...(ctx.expectedHash ? { expectedHash: ctx.expectedHash } : {}),
  });
  if (state.version !== version || state.epoch !== epoch) throw malformed('state blob: header does not match the signed state');
  return state;
}
