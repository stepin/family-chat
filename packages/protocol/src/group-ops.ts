// Building the next group state (create, rename, add, remove, transfer) and deciding what a
// member does with a received state. Every builder signs the new state, verifies it against
// the previous one exactly as a receiver would, encrypts it and seals the epoch secret for the
// members who need it.

import { copy, type Bytes } from './bytes.ts';
import { GCM_NONCE_BYTES } from './aead.ts';
import { base32DecodeExact } from './codec.ts';
import {
  EPOCH_SECRET_BYTES,
  FIRST_GROUP_EPOCH,
  FIRST_STATE_VERSION,
  GROUP_NONCE_BYTES,
  MAX_GROUP_MEMBERS,
  MAX_NAME_CHARS,
  PUBLIC_KEY_BYTES,
  USER_ID_BYTES,
} from './constants.ts';
import type { ChatKeys } from './dm.ts';
import type { SignedEnvelope } from './envelope.ts';
import { ProtocolError } from './errors.ts';
import {
  deriveGroupKeys,
  encodeGroupState,
  encryptGroupStateWithNonce,
  groupChatId,
  openGroupState,
  signTransfer,
  verifyGroupState,
  type GroupMember,
  type GroupMemberInput,
  type GroupState,
  type GroupStateFields,
} from './group.ts';
import { openGroupKey, sealGroupKeyWith, verifyGroupKey, type OpenedGroupKey } from './group-key.ts';
import { checkContextString, nameProblem } from './json.ts';
import { checkSignPub, userIdFromSignPub, type IdentityKeys } from './keys.ts';
import { randomBytes } from './random.ts';

/** Randomness source; only the internal *With variants accept another one (test vectors). */
export type Rng = (n: number) => Bytes;

export interface SealedGroupKey {
  readonly recipient: string;
  readonly envelope: SignedEnvelope;
}

/** Everything the owner uploads for one change: PUT the state blob, then the sealed keys. */
export interface GroupChange {
  readonly state: GroupState;
  /** Encrypted state, as the server stores it (GET /chats/<id>/state/<version>). */
  readonly blob: Bytes;
  /** Epoch secret of state.epoch (new when newEpoch). Holds a secret: store it with the chat. */
  readonly secret: Bytes;
  readonly keys: ChatKeys;
  readonly newEpoch: boolean;
  /** Sealed keys for the members who need the secret of state.epoch. */
  readonly sealedKeys: readonly SealedGroupKey[];
}

function checkMemberInput(m: GroupMemberInput): GroupMember {
  const bad = (msg: string) => new ProtocolError('invalid-argument', `member: ${msg}`);
  try {
    base32DecodeExact(m.userId, USER_ID_BYTES, 'userId');
  } catch {
    throw bad('userId must be base32 of 16 bytes');
  }
  if (!(m.signPub instanceof Uint8Array) || m.signPub.length !== PUBLIC_KEY_BYTES) throw bad('signPub must be 32 bytes');
  if (!(m.boxPub instanceof Uint8Array) || m.boxPub.length !== PUBLIC_KEY_BYTES) throw bad('boxPub must be 32 bytes');
  if (userIdFromSignPub(m.signPub) !== m.userId) throw new ProtocolError('user-id-mismatch', 'member userId does not match signPub');
  checkSignPub(m.signPub);
  return { userId: m.userId, signPub: copy(m.signPub), boxPub: copy(m.boxPub) };
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : name;
  const p = nameProblem(n, MAX_NAME_CHARS);
  if (p) throw new ProtocolError('invalid-argument', `group name: ${p}`);
  return n as string;
}

function checkSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.length !== EPOCH_SECRET_BYTES) {
    throw new ProtocolError('invalid-argument', 'epoch secret must be 32 bytes');
  }
}

function checkOwner(prev: GroupState, owner: IdentityKeys): void {
  if (owner.userId !== prev.owner) throw new ProtocolError('not-owner', 'only the owner can change the group');
}

function selfMember(k: IdentityKeys): GroupMember {
  return { userId: k.userId, signPub: k.signPub, boxPub: k.boxPub };
}

interface Next {
  readonly epoch: number;
  readonly name: string;
  readonly members: readonly GroupMember[];
  readonly owner: string;
  readonly transfers: GroupStateFields['transfers'];
  readonly secret: Bytes;
  /** Members who get a sealed key: everyone on a new epoch, or only newcomers. */
  readonly sealFor: readonly GroupMember[];
}

async function finish(prev: GroupState | undefined, fields: GroupStateFields, next: Next, signer: IdentityKeys, rng: Rng): Promise<GroupChange> {
  if (next.members.length > MAX_GROUP_MEMBERS) throw new ProtocolError('too-large', `a group has at most ${MAX_GROUP_MEMBERS} members`);
  const envelope = encodeGroupState(fields, signer);
  const state = verifyGroupState(envelope, {
    serverId: fields.serverId,
    chatId: fields.chatId,
    ...(prev ? { prev } : {}),
  });
  const keys = deriveGroupKeys(next.secret, state.epoch);
  const blob = await encryptGroupStateWithNonce(state, { serverId: state.serverId, chatId: state.chatId, keys }, rng(GCM_NONCE_BYTES));
  const sealedKeys: SealedGroupKey[] = [];
  for (const m of next.sealFor) {
    const envelope = await sealGroupKeyWith(
      {
        serverId: state.serverId,
        chatId: state.chatId,
        epoch: state.epoch,
        secret: next.secret,
        recipient: m,
        stateVersion: state.version,
        stateHash: state.stateHash,
      },
      signer,
      rng(32),
    );
    sealedKeys.push({ recipient: m.userId, envelope });
  }
  return { state, blob, secret: next.secret, keys, newEpoch: prev === undefined || state.epoch !== prev.epoch, sealedKeys };
}

function fieldsOf(prev: GroupState, next: Omit<Next, 'secret' | 'sealFor'>): GroupStateFields {
  return {
    serverId: prev.serverId,
    chatId: prev.chatId,
    version: prev.version + 1,
    epoch: next.epoch,
    name: next.name,
    creatorSignPub: prev.creator.signPub,
    nonce: prev.creator.nonce,
    owner: next.owner,
    transfers: next.transfers,
    members: next.members,
    prev: prev.stateHash,
  };
}

// ---- create ----

export interface CreateGroupInput {
  readonly serverId: string;
  /** The creator; becomes the owner and a member. */
  readonly owner: IdentityKeys;
  readonly name: string;
  /** Other members (verified identities); the owner is added automatically. */
  readonly members: readonly GroupMemberInput[];
}

/** Internal: createGroup with a chosen randomness source. */
export async function createGroupWith(input: CreateGroupInput, rng: Rng): Promise<GroupChange> {
  const serverId = checkContextString(input.serverId, 'serverId', 'invalid-argument');
  const name = checkName(input.name);
  const byId = new Map<string, GroupMember>([[input.owner.userId, selfMember(input.owner)]]);
  for (const m of input.members) {
    const member = checkMemberInput(m);
    if (member.userId === input.owner.userId) continue;
    if (byId.has(member.userId)) throw new ProtocolError('invalid-argument', 'duplicate member');
    byId.set(member.userId, member);
  }
  const nonce = rng(GROUP_NONCE_BYTES);
  const chatId = groupChatId(input.owner.signPub, nonce);
  const secret = rng(EPOCH_SECRET_BYTES);
  const members = [...byId.values()];
  const fields: GroupStateFields = {
    serverId,
    chatId,
    version: FIRST_STATE_VERSION,
    epoch: FIRST_GROUP_EPOCH,
    name,
    creatorSignPub: input.owner.signPub,
    nonce,
    owner: input.owner.userId,
    transfers: [],
    members,
    prev: null,
  };
  return finish(undefined, fields, { epoch: FIRST_GROUP_EPOCH, name, members, owner: input.owner.userId, transfers: [], secret, sealFor: members }, input.owner, rng);
}

/** Create a group: state version 1, epoch 0, a new secret sealed to every member (including the owner's other devices). */
export function createGroup(input: CreateGroupInput): Promise<GroupChange> {
  return createGroupWith(input, randomBytes);
}

// ---- rename ----

export interface RenameGroupInput {
  readonly prev: GroupState;
  readonly owner: IdentityKeys;
  /** Secret of prev.epoch (the epoch stays). */
  readonly secret: Uint8Array;
  readonly name: string;
}

export async function renameGroupWith(input: RenameGroupInput, rng: Rng): Promise<GroupChange> {
  const { prev } = input;
  checkOwner(prev, input.owner);
  checkSecret(input.secret);
  const next = { epoch: prev.epoch, name: checkName(input.name), members: prev.members, owner: prev.owner, transfers: prev.transfers };
  return finish(prev, fieldsOf(prev, next), { ...next, secret: copy(input.secret), sealFor: [] }, input.owner, rng);
}

/** Rename the group: same epoch, no new keys. */
export function renameGroup(input: RenameGroupInput): Promise<GroupChange> {
  return renameGroupWith(input, randomBytes);
}

// ---- add ----

export interface AddGroupMembersInput {
  readonly prev: GroupState;
  readonly owner: IdentityKeys;
  /** Secret of prev.epoch; used when history is true. */
  readonly secret: Uint8Array;
  readonly members: readonly GroupMemberInput[];
  /**
   * true: keep the epoch, newcomers get the current secret and read the history of this epoch.
   * false ("without earlier history"): start a new epoch with a new secret sealed to everyone.
   */
  readonly history: boolean;
}

export async function addGroupMembersWith(input: AddGroupMembersInput, rng: Rng): Promise<GroupChange> {
  const { prev } = input;
  checkOwner(prev, input.owner);
  checkSecret(input.secret);
  if (input.members.length === 0) throw new ProtocolError('invalid-argument', 'no members to add');
  const added: GroupMember[] = [];
  for (const m of input.members) {
    const member = checkMemberInput(m);
    if (prev.members.some((x) => x.userId === member.userId) || added.some((x) => x.userId === member.userId)) {
      throw new ProtocolError('invalid-argument', 'member is already in the group');
    }
    added.push(member);
  }
  const members = [...prev.members, ...added];
  const epoch = input.history ? prev.epoch : prev.epoch + 1;
  const secret = input.history ? copy(input.secret) : rng(EPOCH_SECRET_BYTES);
  const next = { epoch, name: prev.name, members, owner: prev.owner, transfers: prev.transfers };
  return finish(prev, fieldsOf(prev, next), { ...next, secret, sealFor: input.history ? added : members }, input.owner, rng);
}

/** Add members, either keeping the epoch (with history) or starting a new one (without history). */
export function addGroupMembers(input: AddGroupMembersInput): Promise<GroupChange> {
  return addGroupMembersWith(input, randomBytes);
}

// ---- remove ----

export interface RemoveGroupMembersInput {
  readonly prev: GroupState;
  readonly owner: IdentityKeys;
  readonly userIds: readonly string[];
}

export async function removeGroupMembersWith(input: RemoveGroupMembersInput, rng: Rng): Promise<GroupChange> {
  const { prev } = input;
  checkOwner(prev, input.owner);
  if (input.userIds.length === 0) throw new ProtocolError('invalid-argument', 'no members to remove');
  for (const id of input.userIds) {
    if (!prev.members.some((m) => m.userId === id)) throw new ProtocolError('invalid-argument', 'not a member');
    if (id === prev.owner) throw new ProtocolError('invalid-argument', 'the owner cannot be removed; transfer ownership first');
  }
  const members = prev.members.filter((m) => !input.userIds.includes(m.userId));
  const next = { epoch: prev.epoch + 1, name: prev.name, members, owner: prev.owner, transfers: prev.transfers };
  return finish(prev, fieldsOf(prev, next), { ...next, secret: rng(EPOCH_SECRET_BYTES), sealFor: members }, input.owner, rng);
}

/** Remove members: new epoch, new secret sealed to the remaining members only. */
export function removeGroupMembers(input: RemoveGroupMembersInput): Promise<GroupChange> {
  return removeGroupMembersWith(input, randomBytes);
}

// ---- transfer ----

export interface TransferGroupOwnershipInput {
  readonly prev: GroupState;
  readonly owner: IdentityKeys;
  /** Secret of prev.epoch (the epoch stays). */
  readonly secret: Uint8Array;
  /** userId of the new owner; must be a member. */
  readonly to: string;
}

export async function transferGroupOwnershipWith(input: TransferGroupOwnershipInput, rng: Rng): Promise<GroupChange> {
  const { prev } = input;
  checkOwner(prev, input.owner);
  checkSecret(input.secret);
  const to = prev.members.find((m) => m.userId === input.to);
  if (!to) throw new ProtocolError('invalid-argument', 'the new owner must be a member');
  if (to.userId === prev.owner) throw new ProtocolError('invalid-argument', 'already the owner');
  const transfer = signTransfer(input.owner, prev.serverId, prev.chatId, prev.version + 1, to);
  const next = { epoch: prev.epoch, name: prev.name, members: prev.members, owner: to.userId, transfers: [...prev.transfers, transfer] };
  return finish(prev, fieldsOf(prev, next), { ...next, secret: copy(input.secret), sealFor: [] }, input.owner, rng);
}

/** Transfer ownership: a version signed by the current owner that names the new owner. */
export function transferGroupOwnership(input: TransferGroupOwnershipInput): Promise<GroupChange> {
  return transferGroupOwnershipWith(input, randomBytes);
}

// ---- receiving ----

/**
 * A newcomer's (or restored device's) entry point: open a sealed key, decrypt the state it refers
 * to and check both. The state is verified from its embedded chain alone (or against `prev`), its
 * hash must equal the key's stateHash, and the key must be signed by the signer of that state.
 */
export async function acceptGroupKey(
  sealedKey: unknown,
  stateBlob: Uint8Array,
  me: IdentityKeys,
  ctx: { readonly serverId: string; readonly prev?: GroupState },
): Promise<{ state: GroupState; key: OpenedGroupKey; keys: ChatKeys }> {
  const key = await openGroupKey(sealedKey, me, { serverId: ctx.serverId });
  const keys = deriveGroupKeys(key.secret, key.epoch);
  const state = await openGroupState(stateBlob, {
    serverId: ctx.serverId,
    chatId: key.chatId,
    keys,
    expectedHash: key.stateHash,
    ...(ctx.prev ? { prev: ctx.prev } : {}),
  });
  verifyGroupKey(key, state);
  return { state, key, keys };
}

/** What a member does after accepting `next` (with `prev` the state accepted before, if any). */
export interface GroupStateActions {
  /** I am a member of the new state. */
  readonly member: boolean;
  /** I was a member of prev and am not any more: stop sending, keep the history read-only. */
  readonly removed: boolean;
  readonly isOwner: boolean;
  /** The epoch changed (always true for the first state seen). */
  readonly newEpoch: boolean;
  /**
   * A member must have the sealed key of next.epoch before sending; events of an older epoch
   * are rejected by the server (409) and are re-encrypted with the new key and sent again.
   */
  readonly needKey: boolean;
  readonly added: readonly string[];
  readonly removedMembers: readonly string[];
  readonly renamed: boolean;
  readonly ownerChanged: boolean;
}

export function groupStateActions(prev: GroupState | undefined, next: GroupState, me: string): GroupStateActions {
  const has = (s: GroupState | undefined, id: string) => s?.members.some((m) => m.userId === id) ?? false;
  const member = has(next, me);
  const newEpoch = prev === undefined || prev.epoch !== next.epoch;
  return {
    member,
    removed: has(prev, me) && !member,
    isOwner: next.owner === me,
    newEpoch,
    needKey: member && newEpoch,
    added: next.members.filter((m) => !has(prev, m.userId)).map((m) => m.userId),
    removedMembers: prev ? prev.members.filter((m) => !has(next, m.userId)).map((m) => m.userId) : [],
    renamed: prev !== undefined && prev.name !== next.name,
    ownerChanged: prev !== undefined && prev.owner !== next.owner,
  };
}

/**
 * Compare the signed member list with the delivery list the server reports. Members missing on
 * the server have left or were excluded: the owner removes them with a new epoch. Extra users on
 * the server are shown as a discrepancy (they receive ciphertext without a key).
 */
export function compareGroupMembers(
  state: GroupState,
  serverMembers: readonly string[],
): { missingOnServer: readonly string[]; extraOnServer: readonly string[] } {
  const signed = new Set(state.members.map((m) => m.userId));
  const server = new Set(serverMembers);
  return {
    missingOnServer: [...signed].filter((id) => !server.has(id)),
    extraOnServer: [...server].filter((id) => !signed.has(id)),
  };
}
