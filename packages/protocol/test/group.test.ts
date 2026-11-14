import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { base32Decode, base64urlDecode, base64urlEncode } from '../src/codec.ts';
import { decodeEvent, encodeEvent } from '../src/event.ts';
import { createIdentityEnvelope, sealBytes, verifyIdentityEnvelope, type Identity, type SignedEnvelope } from '../src/envelope.ts';
import {
  deriveGroupKeys,
  encodeGroupState,
  encryptGroupState,
  groupChatId,
  newEpochSecret,
  newGroupNonce,
  openGroupState,
  readGroupStateHeader,
  signTransfer,
  verifyGroupState,
  type GroupState,
  type GroupStateFields,
} from '../src/group.ts';
import { openGroupKey, readGroupKey, sealGroupKey, verifyGroupKey } from '../src/group-key.ts';
import {
  acceptGroupKey,
  addGroupMembers,
  compareGroupMembers,
  createGroup,
  groupStateActions,
  removeGroupMembers,
  renameGroup,
  transferGroupOwnership,
  type GroupChange,
} from '../src/group-ops.ts';
import { deriveIdentityKeys, sha256Bytes, type IdentityKeys } from '../src/keys.ts';
import { encodeMsgPayload } from '../src/payload.ts';
import { newDevId, newMessageId, newSeed } from '../src/random.ts';
import { asyncErrorCode, errorCode, hex } from './helpers.ts';

const serverId = 'home-server';
const keys = (): IdentityKeys => deriveIdentityKeys(newSeed());
const ident = (k: IdentityKeys): Identity => verifyIdentityEnvelope(createIdentityEnvelope(k, 1));
const alice = keys();
const bob = keys();
const carol = keys();
const dave = keys();
const mallory = keys();

const payloadOf = (env: SignedEnvelope): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64urlDecode(env.payload)));

/** Re-sign an altered state payload with `signer` (a forger who controls that key). */
function forge(state: GroupState, patch: (p: Record<string, unknown>) => void, signer: IdentityKeys): SignedEnvelope {
  const p = payloadOf(state.envelope);
  patch(p);
  return sealBytes('group-state', utf8(JSON.stringify(p)), signer);
}

async function threeMemberGroup(): Promise<GroupChange> {
  return createGroup({ serverId, owner: alice, name: '  Семья  ', members: [ident(bob), ident(carol)] });
}

describe('group id', () => {
  it('is 26 base32 characters derived from the creator key and nonce', () => {
    const nonce = newGroupNonce();
    const id = groupChatId(alice.signPub, nonce);
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    expect(base32Decode(id)).toHaveLength(16);
    expect(groupChatId(alice.signPub, nonce)).toBe(id);
    expect(groupChatId(bob.signPub, nonce)).not.toBe(id);
    expect(groupChatId(alice.signPub, newGroupNonce())).not.toBe(id);
  });

  it('rejects wrong lengths', () => {
    expect(errorCode(() => groupChatId(alice.signPub, new Uint8Array(15)))).toBe('invalid-argument');
    expect(errorCode(() => groupChatId(new Uint8Array(31), newGroupNonce()))).toBe('invalid-argument');
  });
});

describe('epoch keys', () => {
  it('derives encKey like a direct chat and validates input', () => {
    const s = newEpochSecret();
    const k = deriveGroupKeys(s, 3);
    expect(k.epoch).toBe(3);
    expect(k.encKey).toHaveLength(32);
    expect(hex(deriveGroupKeys(s, 4).encKey)).toBe(hex(k.encKey));
    expect(errorCode(() => deriveGroupKeys(new Uint8Array(31), 0))).toBe('invalid-argument');
    expect(errorCode(() => deriveGroupKeys(s, -1))).toBe('invalid-argument');
    expect(errorCode(() => deriveGroupKeys(s, 2 ** 32))).toBe('invalid-argument');
  });
});

describe('createGroup', () => {
  it('produces version 1, epoch 0, sorted members and keys for everyone', async () => {
    const g = await threeMemberGroup();
    const s = g.state;
    expect(s.version).toBe(1);
    expect(s.epoch).toBe(0);
    expect(s.name).toBe('Семья');
    expect(s.owner).toBe(alice.userId);
    expect(s.by).toBe(alice.userId);
    expect(s.prev).toBeNull();
    expect(s.transfers).toEqual([]);
    expect(s.members.map((m) => m.userId)).toEqual([alice.userId, bob.userId, carol.userId].sort());
    expect(s.chatId).toBe(groupChatId(alice.signPub, s.creator.nonce));
    expect(hex(s.stateHash)).toBe(hex(sha256Bytes(s.payloadBytes)));
    expect(g.newEpoch).toBe(true);
    expect(g.sealedKeys.map((k) => k.recipient).sort()).toEqual([alice.userId, bob.userId, carol.userId].sort());
    expect(Object.keys(payloadOf(s.envelope))).toEqual([
      'v', 'serverId', 'chatId', 'version', 'epoch', 'name', 'creator', 'owner', 'by', 'transfers', 'members', 'prev',
    ]);
  });

  it('every member opens the key, decrypts and verifies the state from the chain alone', async () => {
    const g = await threeMemberGroup();
    for (const me of [alice, bob, carol]) {
      const k = g.sealedKeys.find((x) => x.recipient === me.userId)!;
      const r = await acceptGroupKey(k.envelope, g.blob, me, { serverId });
      expect(r.state.version).toBe(1);
      expect(hex(r.key.secret)).toBe(hex(g.secret));
      expect(hex(r.keys.encKey)).toBe(hex(g.keys.encKey));
    }
  });

  it('tolerates the owner in the member list and rejects bad input', async () => {
    const g = await createGroup({ serverId, owner: alice, name: 'x', members: [ident(alice), ident(bob)] });
    expect(g.state.members).toHaveLength(2);
    const bad = (input: Partial<Parameters<typeof createGroup>[0]>) =>
      asyncErrorCode(createGroup({ serverId, owner: alice, name: 'x', members: [], ...input }));
    expect(await bad({ name: ' ' })).toBe('invalid-argument');
    expect(await bad({ serverId: '' })).toBe('invalid-argument');
    expect(await bad({ members: [ident(bob), ident(bob)] })).toBe('invalid-argument');
    expect(await bad({ members: [{ ...ident(bob), userId: carol.userId }] })).toBe('user-id-mismatch');
    expect(await bad({ members: [{ ...ident(bob), userId: 'x' }] })).toBe('invalid-argument');
    expect(await bad({ members: [{ ...ident(bob), boxPub: new Uint8Array(3) }] })).toBe('invalid-argument');
    expect(await bad({ members: [{ ...ident(bob), signPub: new Uint8Array(3) }] })).toBe('invalid-argument');
    const many = Array.from({ length: 100 }, () => ident(keys()));
    expect(await bad({ members: many })).toBe('too-large');
    const g1 = await createGroup({ serverId, owner: alice, name: 'solo', members: [] });
    expect(g1.state.members.map((m) => m.userId)).toEqual([alice.userId]);
  });
});

describe('builders and transitions', () => {
  it('rename keeps the epoch and needs no keys', async () => {
    const g = await threeMemberGroup();
    const r = await renameGroup({ prev: g.state, owner: alice, secret: g.secret, name: 'Дом' });
    expect(r.state.version).toBe(2);
    expect(r.state.epoch).toBe(0);
    expect(r.newEpoch).toBe(false);
    expect(r.sealedKeys).toEqual([]);
    expect(hex(r.state.prev!)).toBe(hex(g.state.stateHash));
    // Members decrypt with the key they already have and verify against the previous state.
    const s = await openGroupState(r.blob, { serverId, chatId: g.state.chatId, keys: g.keys, prev: g.state });
    expect(s.name).toBe('Дом');
    expect(groupStateActions(g.state, s, bob.userId)).toMatchObject({ renamed: true, newEpoch: false, needKey: false, member: true });
  });

  it('add with history keeps the epoch and seals the current secret to newcomers only', async () => {
    const g = await threeMemberGroup();
    const a = await addGroupMembers({ prev: g.state, owner: alice, secret: g.secret, members: [ident(dave)], history: true });
    expect(a.state.epoch).toBe(0);
    expect(hex(a.secret)).toBe(hex(g.secret));
    expect(a.sealedKeys.map((k) => k.recipient)).toEqual([dave.userId]);
    const r = await acceptGroupKey(a.sealedKeys[0]!.envelope, a.blob, dave, { serverId });
    expect(r.state.version).toBe(2);
    expect(groupStateActions(undefined, r.state, dave.userId)).toMatchObject({ member: true, newEpoch: true, needKey: true });
    expect(groupStateActions(g.state, a.state, bob.userId).added).toEqual([dave.userId]);
  });

  it('add without history starts a new epoch sealed to everyone', async () => {
    const g = await threeMemberGroup();
    const a = await addGroupMembers({ prev: g.state, owner: alice, secret: g.secret, members: [ident(dave)], history: false });
    expect(a.state.epoch).toBe(1);
    expect(a.newEpoch).toBe(true);
    expect(hex(a.secret)).not.toBe(hex(g.secret));
    expect(a.sealedKeys).toHaveLength(4);
    const k = a.sealedKeys.find((x) => x.recipient === bob.userId)!;
    const r = await acceptGroupKey(k.envelope, a.blob, bob, { serverId, prev: g.state });
    expect(r.keys.epoch).toBe(1);
  });

  it('remove starts a new epoch; the removed member cannot read the new state', async () => {
    const g = await threeMemberGroup();
    const r = await removeGroupMembers({ prev: g.state, owner: alice, userIds: [carol.userId] });
    expect(r.state.epoch).toBe(1);
    expect(r.sealedKeys.map((k) => k.recipient).sort()).toEqual([alice.userId, bob.userId].sort());
    expect(await asyncErrorCode(openGroupState(r.blob, { serverId, chatId: g.state.chatId, keys: { ...g.keys, epoch: 1 } }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupState(r.blob, { serverId, chatId: g.state.chatId, keys: g.keys }))).toBe('wrong-epoch');
    expect(groupStateActions(g.state, r.state, carol.userId)).toMatchObject({ removed: true, member: false, needKey: false });
    expect(groupStateActions(g.state, r.state, bob.userId)).toMatchObject({
      removed: false,
      newEpoch: true,
      needKey: true,
      removedMembers: [carol.userId],
    });
  });

  it('transfer: signed by the old owner, the new owner signs the next version', async () => {
    const g = await threeMemberGroup();
    const t = await transferGroupOwnership({ prev: g.state, owner: alice, secret: g.secret, to: bob.userId });
    expect(t.state.owner).toBe(bob.userId);
    expect(t.state.by).toBe(alice.userId);
    expect(t.state.transfers).toHaveLength(1);
    expect(t.state.transfers[0]!.version).toBe(2);
    expect(groupStateActions(g.state, t.state, bob.userId)).toMatchObject({ ownerChanged: true, isOwner: true });
    // Alice is no longer the owner.
    expect(await asyncErrorCode(renameGroup({ prev: t.state, owner: alice, secret: g.secret, name: 'x' }))).toBe('not-owner');
    const r = await renameGroup({ prev: t.state, owner: bob, secret: g.secret, name: 'Bob' });
    expect(r.state.by).toBe(bob.userId);
    // A newcomer verifies version 3 from the embedded chain alone.
    const a = await addGroupMembers({ prev: r.state, owner: bob, secret: g.secret, members: [ident(dave)], history: true });
    const acc = await acceptGroupKey(a.sealedKeys[0]!.envelope, a.blob, dave, { serverId });
    expect(acc.state.owner).toBe(bob.userId);
    expect(acc.state.version).toBe(4);
    // A second transfer back to Alice extends the chain.
    const t2 = await transferGroupOwnership({ prev: a.state, owner: bob, secret: g.secret, to: alice.userId });
    expect(t2.state.transfers.map((x) => x.to)).toEqual([bob.userId, alice.userId]);
  });

  it('builders reject a non-owner and bad arguments', async () => {
    const g = await threeMemberGroup();
    const p = g.state;
    expect(await asyncErrorCode(renameGroup({ prev: p, owner: bob, secret: g.secret, name: 'x' }))).toBe('not-owner');
    expect(await asyncErrorCode(renameGroup({ prev: p, owner: alice, secret: new Uint8Array(1), name: 'x' }))).toBe('invalid-argument');
    expect(await asyncErrorCode(addGroupMembers({ prev: p, owner: alice, secret: g.secret, members: [], history: true }))).toBe('invalid-argument');
    expect(await asyncErrorCode(addGroupMembers({ prev: p, owner: alice, secret: g.secret, members: [ident(bob)], history: true }))).toBe('invalid-argument');
    expect(
      await asyncErrorCode(addGroupMembers({ prev: p, owner: alice, secret: g.secret, members: [ident(dave), ident(dave)], history: true })),
    ).toBe('invalid-argument');
    expect(await asyncErrorCode(removeGroupMembers({ prev: p, owner: alice, userIds: [] }))).toBe('invalid-argument');
    expect(await asyncErrorCode(removeGroupMembers({ prev: p, owner: alice, userIds: [dave.userId] }))).toBe('invalid-argument');
    expect(await asyncErrorCode(removeGroupMembers({ prev: p, owner: alice, userIds: [alice.userId] }))).toBe('invalid-argument');
    expect(await asyncErrorCode(transferGroupOwnership({ prev: p, owner: alice, secret: g.secret, to: dave.userId }))).toBe('invalid-argument');
    expect(await asyncErrorCode(transferGroupOwnership({ prev: p, owner: alice, secret: g.secret, to: alice.userId }))).toBe('invalid-argument');
  });
});

describe('verifyGroupState: failures', () => {
  it('state signed by a non-owner member', async () => {
    const g = await threeMemberGroup();
    const env = forge(g.state, (p) => {
      p.by = mallory.userId;
      p.name = 'Захвачено';
    }, mallory);
    expect(errorCode(() => verifyGroupState(env, { serverId, chatId: g.state.chatId }))).toBe('not-owner');
    // Claiming to be the owner does not help without the owner's key.
    const env2 = forge(g.state, (p) => (p.name = 'Захвачено'), mallory);
    expect(errorCode(() => verifyGroupState(env2, { serverId, chatId: g.state.chatId }))).toBe('bad-signature');
  });

  it('a transfer not signed by the previous owner breaks the chain', async () => {
    const g = await threeMemberGroup();
    const fields: GroupStateFields = {
      serverId,
      chatId: g.state.chatId,
      version: 2,
      epoch: 0,
      name: 'x',
      creatorSignPub: alice.signPub,
      nonce: g.state.creator.nonce,
      owner: bob.userId,
      transfers: [signTransfer(bob, serverId, g.state.chatId, 2, ident(bob))],
      members: g.state.members,
      prev: g.state.stateHash,
    };
    // Bob signs a transfer to himself; whoever signs the state, the chain is broken.
    expect(errorCode(() => verifyGroupState(encodeGroupState(fields, alice), { serverId, chatId: g.state.chatId }))).toBe('bad-chain');
    const mal = { ...ident(mallory) };
    const fields2 = { ...fields, owner: mallory.userId, transfers: [signTransfer(mallory, serverId, g.state.chatId, 2, mal)] };
    expect(errorCode(() => verifyGroupState(encodeGroupState(fields2, mallory), { serverId, chatId: g.state.chatId }))).toBe('bad-chain');
  });

  it('chain rules: versions, targets, owner, origin', async () => {
    const g = await threeMemberGroup();
    const t = await transferGroupOwnership({ prev: g.state, owner: alice, secret: g.secret, to: bob.userId });
    const ctx = { serverId, chatId: g.state.chatId };
    const v = (patch: (p: Record<string, unknown>) => void, signer = alice) =>
      errorCode(() => verifyGroupState(forge(t.state, patch, signer), ctx));
    const tr = (p: Record<string, unknown>) => (p.transfers as Record<string, unknown>[])[0]!;
    expect(v((p) => (tr(p).version = 3))).toBe('bad-chain'); // beyond the state version
    expect(v((p) => (tr(p).version = 1))).toBe('bad-chain'); // version 1 cannot transfer
    expect(v((p) => (tr(p).to = carol.userId))).toBe('bad-chain'); // target does not match its key
    expect(v((p) => (tr(p).sig = base64urlEncode(new Uint8Array(64))))).toBe('bad-chain');
    expect(v((p) => (p.owner = alice.userId))).toBe('bad-chain'); // owner is not the end of the chain
    expect(v((p) => ((p.creator as Record<string, unknown>).nonce = base64urlEncode(new Uint8Array(16))))).toBe('bad-chain');
    expect(v((p) => ((p.creator as Record<string, unknown>).signPub = base64urlEncode(bob.signPub)))).toBe('bad-chain');
    // Transfer to the current owner.
    const self = signTransfer(alice, serverId, g.state.chatId, 2, ident(alice));
    expect(
      v((p) => {
        p.transfers = [{ version: 2, to: alice.userId, toSignPub: base64urlEncode(alice.signPub), sig: base64urlEncode(self.sig) }];
        p.owner = alice.userId;
      }),
    ).toBe('bad-chain');
  });

  it('rejects another server, chat, hash, and malformed fields', async () => {
    const g = await threeMemberGroup();
    const s = g.state;
    const ctx = { serverId, chatId: s.chatId };
    expect(errorCode(() => verifyGroupState(s.envelope, { ...ctx, serverId: 'other' }))).toBe('wrong-server');
    expect(errorCode(() => verifyGroupState(s.envelope, { ...ctx, chatId: groupChatId(bob.signPub, newGroupNonce()) }))).toBe('wrong-chat');
    expect(errorCode(() => verifyGroupState(s.envelope, { ...ctx, expectedHash: new Uint8Array(32) }))).toBe('state-mismatch');
    const v = (patch: (p: Record<string, unknown>) => void) => errorCode(() => verifyGroupState(forge(s, patch, alice), ctx));
    expect(v((p) => (p.version = 0))).toBe('malformed');
    expect(v((p) => (p.version = 2))).toBe('malformed'); // prev null on version 2
    expect(v((p) => (p.prev = base64urlEncode(new Uint8Array(32))))).toBe('malformed'); // prev on version 1
    expect(v((p) => (p.epoch = -1))).toBe('malformed');
    expect(v((p) => (p.name = ''))).toBe('malformed');
    expect(v((p) => (p.name = 'a‮b'))).toBe('malformed');
    expect(v((p) => (p.members = []))).toBe('malformed');
    expect(v((p) => (p.members = [...(p.members as unknown[])].reverse()))).toBe('malformed');
    expect(v((p) => (p.members = [(p.members as unknown[])[0], (p.members as unknown[])[0]]))).toBe('malformed');
    expect(v((p) => (p.members = (p.members as Record<string, string>[]).filter((m) => m.userId !== alice.userId)))).toBe('malformed');
    expect(v((p) => (p.transfers = {}))).toBe('malformed');
    expect(v((p) => (p.transfers = [1]))).toBe('malformed');
    expect(v((p) => (p.creator = 'x'))).toBe('malformed');
    expect(v((p) => (p.members = [1]))).toBe('malformed');
    expect(v((p) => (p.v = 2))).toBe('unsupported-version');
    expect(
      v((p) => {
        const m = (p.members as Record<string, string>[]).find((x) => x.userId === bob.userId)!;
        m.signPub = base64urlEncode(carol.signPub);
      }),
    ).toBe('user-id-mismatch');
  });

  it('transition rules against the previous accepted state', async () => {
    const g = await threeMemberGroup();
    const r = await renameGroup({ prev: g.state, owner: alice, secret: g.secret, name: 'v2' });
    const ctx = { serverId, chatId: g.state.chatId, prev: g.state };
    expect(verifyGroupState(r.state.envelope, ctx).version).toBe(2);
    const v = (patch: (p: Record<string, unknown>) => void, signer = alice, prev = g.state) =>
      errorCode(() => verifyGroupState(forge(r.state, patch, signer), { ...ctx, prev }));
    // The version must be exactly prev + 1: replaying version 2 on top of version 2 fails.
    expect(errorCode(() => verifyGroupState(r.state.envelope, { ...ctx, prev: r.state }))).toBe('invalid-transition');
    expect(v((p) => (p.version = 3))).toBe('invalid-transition');
    expect(v((p) => (p.prev = base64urlEncode(new Uint8Array(32))))).toBe('invalid-transition');
    expect(v((p) => (p.epoch = 2))).toBe('invalid-transition');
    // Removing a member without a new epoch.
    expect(v((p) => (p.members = (p.members as Record<string, string>[]).filter((m) => m.userId !== carol.userId)))).toBe(
      'invalid-transition',
    );
    // A member's keys cannot change.
    expect(
      v((p) => {
        const m = (p.members as Record<string, string>[]).find((x) => x.userId === bob.userId)!;
        m.boxPub = base64urlEncode(carol.boxPub);
      }),
    ).toBe('invalid-transition');
    // Another group with the same version number.
    const other = await createGroup({ serverId, owner: alice, name: 'o', members: [] });
    expect(errorCode(() => verifyGroupState(r.state.envelope, { ...ctx, prev: { ...other.state, chatId: g.state.chatId } }))).toBe(
      'invalid-transition',
    );
  });

  it('transition rules for the ownership chain', async () => {
    const g = await threeMemberGroup();
    const t = await transferGroupOwnership({ prev: g.state, owner: alice, secret: g.secret, to: bob.userId });
    const r = await renameGroup({ prev: t.state, owner: bob, secret: g.secret, name: 'r' });
    const ctx = { serverId, chatId: g.state.chatId };
    expect(verifyGroupState(r.state.envelope, { ...ctx, prev: t.state }).by).toBe(bob.userId);
    // The old owner keeps writing as if no transfer happened: chain shorter than before.
    const oldOwner = forge(r.state, (p) => {
      p.transfers = [];
      p.owner = alice.userId;
      p.by = alice.userId;
    }, alice);
    expect(errorCode(() => verifyGroupState(oldOwner, { ...ctx, prev: t.state }))).toBe('bad-chain');
    // A backdated transfer inserted later (version below the new state's version).
    const t2 = signTransfer(bob, serverId, g.state.chatId, 3, ident(carol));
    const backdated = forge(r.state, (p) => {
      (p.transfers as unknown[]).push({ version: 3, to: carol.userId, toSignPub: base64urlEncode(carol.signPub), sig: base64urlEncode(t2.sig) });
      p.owner = carol.userId;
      p.by = carol.userId;
      p.version = 4;
      p.prev = base64urlEncode(r.state.stateHash);
    }, carol);
    const prev3 = verifyGroupState(r.state.envelope, { ...ctx, prev: t.state });
    expect(errorCode(() => verifyGroupState(backdated, { ...ctx, prev: prev3 }))).toBe('bad-chain');
    // Signed by someone other than the previous owner although the chain itself is fine.
    expect(errorCode(() => verifyGroupState(t.state.envelope, { ...ctx, prev: { ...g.state, owner: carol.userId } }))).toBe('not-owner');
    // Earlier transfers rewritten.
    const rewritten = forge(r.state, (p) => {
      const sig = signTransfer(alice, serverId, g.state.chatId, 2, ident(carol)).sig;
      p.transfers = [{ version: 2, to: carol.userId, toSignPub: base64urlEncode(carol.signPub), sig: base64urlEncode(sig) }];
      p.owner = carol.userId;
      p.by = carol.userId;
    }, carol);
    expect(errorCode(() => verifyGroupState(rewritten, { ...ctx, prev: t.state }))).toBe('bad-chain');
    // A transfer in this version, signed (state and transfer) by the previous owner, is accepted.
    const next = forge(r.state, (p) => {
      const sig = signTransfer(bob, serverId, g.state.chatId, 3, ident(carol)).sig;
      (p.transfers as unknown[]).push(
        { version: 3, to: carol.userId, toSignPub: base64urlEncode(carol.signPub), sig: base64urlEncode(sig) },
      );
      p.owner = carol.userId;
    }, bob);
    expect(verifyGroupState(next, { ...ctx, prev: t.state }).owner).toBe(carol.userId);
  });
});

describe('state blob', () => {
  it('round trip, header and every failure', async () => {
    const g = await threeMemberGroup();
    const ctx = { serverId, chatId: g.state.chatId, keys: g.keys };
    const blob = await encryptGroupState(g.state, ctx);
    expect(readGroupStateHeader(blob)).toEqual({ epoch: 0, version: 1 });
    expect((blob.length - 56) % 256).toBe(0);
    expect((await openGroupState(blob, ctx)).version).toBe(1);
    const flip = (i: number) => {
      const b = new Uint8Array(blob);
      b[i] = (b[i] as number) ^ 1;
      return b;
    };
    expect(await asyncErrorCode(openGroupState(flip(0), ctx))).toBe('malformed');
    expect(await asyncErrorCode(openGroupState(flip(3), ctx))).toBe('unsupported-version');
    expect(await asyncErrorCode(openGroupState(flip(7), ctx))).toBe('wrong-epoch');
    expect(await asyncErrorCode(openGroupState(flip(11), ctx))).toBe('wrong-key'); // version is in the AAD
    expect(await asyncErrorCode(openGroupState(flip(12), ctx))).toBe('wrong-server');
    expect(await asyncErrorCode(openGroupState(flip(20), ctx))).toBe('wrong-chat');
    expect(await asyncErrorCode(openGroupState(flip(blob.length - 1), ctx))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupState(blob.subarray(0, blob.length - 1), ctx))).toBe('malformed');
    expect(await asyncErrorCode(openGroupState(new Uint8Array(200_000), ctx))).toBe('too-large');
    expect(await asyncErrorCode(openGroupState(blob, { ...ctx, keys: deriveGroupKeys(newEpochSecret(), 0) }))).toBe('wrong-key');
    expect(errorCode(() => readGroupStateHeader(new Uint8Array(3)))).toBe('malformed');
    expect(await asyncErrorCode(encryptGroupState(g.state, { ...ctx, keys: { ...g.keys, epoch: 1 } }))).toBe('invalid-argument');
    expect(await asyncErrorCode(encryptGroupState(g.state, { ...ctx, chatId: 'x' }))).toBe('invalid-argument');
    expect(await asyncErrorCode(encryptGroupState(g.state, { ...ctx, keys: { epoch: 0, encKey: new Uint8Array(1) } }))).toBe(
      'invalid-argument',
    );
  });
});

describe('sealed keys', () => {
  it('readGroupKey exposes routing fields without the secret', async () => {
    const g = await threeMemberGroup();
    const h = readGroupKey(g.sealedKeys[0]!.envelope);
    expect(h).toMatchObject({ serverId, chatId: g.state.chatId, epoch: 0, stateVersion: 1, by: alice.userId });
    expect('secret' in h).toBe(false);
  });

  it('cannot be replayed to another member, chat, epoch or state', async () => {
    const g = await threeMemberGroup();
    const toBob = g.sealedKeys.find((k) => k.recipient === bob.userId)!.envelope;
    // Delivered to Carol as is.
    expect(await asyncErrorCode(openGroupKey(toBob, carol, { serverId }))).toBe('wrong-recipient');
    expect(await asyncErrorCode(openGroupKey(toBob, bob, { serverId: 'other' }))).toBe('wrong-server');
    // The owner's ciphertext lifted into a payload for another chat, member, epoch or state.
    const relabel = (patch: (p: Record<string, unknown>) => void, signer = alice) => {
      const p = payloadOf(toBob);
      patch(p);
      return sealBytes('group-key', utf8(JSON.stringify(p)), signer);
    };
    const other = await createGroup({ serverId, owner: mallory, name: 'm', members: [ident(bob)] });
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.chatId = other.state.chatId), mallory), bob, { serverId }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.recipient = carol.userId)), carol, { serverId }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.epoch = 1)), bob, { serverId }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.stateVersion = 2)), bob, { serverId }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.stateHash = base64urlEncode(new Uint8Array(32)))), bob, { serverId }))).toBe(
      'wrong-key',
    );
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.serverId = 'x')), bob, { serverId: 'x' }))).toBe('wrong-key');
    expect(await asyncErrorCode(openGroupKey(relabel((p) => (p.ct = base64urlEncode(new Uint8Array(47)))), bob, { serverId }))).toBe(
      'malformed',
    );
  });

  it('verifyGroupKey ties the key to the state and its signer', async () => {
    const g = await threeMemberGroup();
    const r = await renameGroup({ prev: g.state, owner: alice, secret: g.secret, name: 'r' });
    const k = await openGroupKey(g.sealedKeys.find((x) => x.recipient === bob.userId)!.envelope, bob, { serverId });
    verifyGroupKey(k, g.state);
    expect(errorCode(() => verifyGroupKey(k, r.state))).toBe('state-mismatch');
    const other = await createGroup({ serverId, owner: alice, name: 'o', members: [] });
    expect(errorCode(() => verifyGroupKey(k, { ...g.state, chatId: other.state.chatId }))).toBe('wrong-chat');
    expect(errorCode(() => verifyGroupKey(k, { ...g.state, epoch: 5 }))).toBe('wrong-epoch');
    expect(errorCode(() => verifyGroupKey(k, { ...g.state, by: bob.userId }))).toBe('not-owner');
    expect(errorCode(() => verifyGroupKey(k, { ...g.state, bySignPub: bob.signPub }))).toBe('bad-signature');
    expect(errorCode(() => verifyGroupKey(k, { ...g.state, serverId: 'z' }))).toBe('wrong-server');
    // A key sealed by a non-owner for this state: opens, but fails the signer check.
    const forged = await sealGroupKey(
      { serverId, chatId: g.state.chatId, epoch: 0, secret: newEpochSecret(), recipient: bob, stateVersion: 1, stateHash: g.state.stateHash },
      mallory,
    );
    const fk = await openGroupKey(forged, bob, { serverId });
    expect(errorCode(() => verifyGroupKey(fk, g.state))).toBe('not-owner');
    expect(await asyncErrorCode(acceptGroupKey(forged, g.blob, bob, { serverId }))).toBe('wrong-key'); // fake secret
  });

  it('acceptGroupKey rejects a state blob with another hash', async () => {
    const g = await threeMemberGroup();
    const reblob = await encryptGroupState(g.state, { serverId, chatId: g.state.chatId, keys: g.keys });
    const k = g.sealedKeys.find((x) => x.recipient === bob.userId)!.envelope;
    expect((await acceptGroupKey(k, reblob, bob, { serverId })).state.version).toBe(1);
    const r = await renameGroup({ prev: g.state, owner: alice, secret: g.secret, name: 'r' });
    expect(await asyncErrorCode(acceptGroupKey(k, r.blob, bob, { serverId }))).toBe('state-mismatch');
  });

  it('sealGroupKey validates its input', async () => {
    const g = await threeMemberGroup();
    const base = { serverId, chatId: g.state.chatId, epoch: 0, secret: g.secret, recipient: bob, stateVersion: 1, stateHash: g.state.stateHash };
    const bad = (patch: object) => asyncErrorCode(sealGroupKey({ ...base, ...patch }, alice));
    expect(await bad({ chatId: 'x' })).toBe('invalid-argument');
    expect(await bad({ epoch: -1 })).toBe('invalid-argument');
    expect(await bad({ stateVersion: 0 })).toBe('invalid-argument');
    expect(await bad({ secret: new Uint8Array(1) })).toBe('invalid-argument');
    expect(await bad({ stateHash: new Uint8Array(1) })).toBe('invalid-argument');
    expect(await bad({ recipient: { userId: bob.userId, boxPub: new Uint8Array(1) } })).toBe('invalid-key');
    expect(await bad({ recipient: { userId: bob.userId, boxPub: new Uint8Array(32) } })).toBe('invalid-key');
  });
});

describe('group events and member lists', () => {
  it('events use the event format with the group epoch', async () => {
    const g = await threeMemberGroup();
    const members = [alice, bob, carol].map(ident);
    const ctx = { serverId, chatId: g.state.chatId, chat: g.keys };
    const id = newMessageId();
    const body = await encodeEvent({ ...ctx, author: bob, payload: encodeMsgPayload({ id, dev: newDevId(), seq: 1, body: 'hi' }) });
    const lookupAuthor = (u: string) => members.find((m) => m.userId === u && g.state.members.some((x) => x.userId === u));
    expect((await decodeEvent(body, { ...ctx, lookupAuthor })).msgId).toBe(id);
    const r = await removeGroupMembers({ prev: g.state, owner: alice, userIds: [carol.userId] });
    expect(await asyncErrorCode(decodeEvent(body, { ...ctx, chat: r.keys, lookupAuthor }))).toBe('wrong-epoch');
  });

  it('compareGroupMembers reports both directions', async () => {
    const g = await threeMemberGroup();
    expect(compareGroupMembers(g.state, [alice.userId, bob.userId, dave.userId])).toEqual({
      missingOnServer: [carol.userId],
      extraOnServer: [dave.userId],
    });
    expect(compareGroupMembers(g.state, g.state.members.map((m) => m.userId))).toEqual({ missingOnServer: [], extraOnServer: [] });
  });
});
