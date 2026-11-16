// The group vector files agree with the code: positive vectors are reproduced byte for byte,
// negative vectors fail with the documented error.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createArchiveReader, createArchiveWriterWithSalt, type ArchiveRecord } from '../src/archive.ts';
import { decryptBlobPart, encryptBlobPart, validateAttachment, type BlobRef } from '../src/attachment.ts';
import { concat, u32be, utf8 } from '../src/bytes.ts';
import { verifyIdentityEnvelope, verifyProfileEnvelope, verifyRevocationEnvelope, createIdentityEnvelope } from '../src/envelope.ts';
import { deriveGroupKeys, groupChatId, openGroupState, verifyGroupState, type GroupState } from '../src/group.ts';
import { openGroupKey, verifyGroupKey } from '../src/group-key.ts';
import { createGroupWith, removeGroupMembersWith, transferGroupOwnershipWith, type Rng } from '../src/group-ops.ts';
import { deriveIdentityKeys, type IdentityKeys } from '../src/keys.ts';
import { parsePayload } from '../src/payload.ts';
import { asyncErrorCode, errorCode, hex, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const gv = loadVector('group.json');
const K: Record<string, IdentityKeys> = {
  alice: deriveIdentityKeys(unhex(ids.users.alice.seedHex)),
  bob: deriveIdentityKeys(unhex(ids.users.bob.seedHex)),
  carol: deriveIdentityKeys(unhex(ids.users.carol.seedHex)),
  dave: deriveIdentityKeys(unhex(gv.extraUsers.dave.seedHex)),
  mallory: deriveIdentityKeys(unhex(gv.extraUsers.mallory.seedHex)),
};
const serverId: string = gv.serverId;

function testRng(label: string): Rng {
  let i = 0;
  return (n) => new Uint8Array(createHash('sha256').update(concat(utf8(`fc/test/rng\n${label}`), u32be(i++))).digest()).subarray(0, n);
}

describe('group.json', () => {
  it('reproduces every step byte for byte', async () => {
    const g1 = await createGroupWith({ serverId, owner: K.alice!, name: 'Семья', members: [K.bob!, K.carol!] }, testRng('create'));
    const g2 = await transferGroupOwnershipWith({ prev: g1.state, owner: K.alice!, secret: g1.secret, to: K.bob!.userId }, testRng('transfer'));
    const g3 = await removeGroupMembersWith({ prev: g2.state, owner: K.bob!, userIds: [K.carol!.userId] }, testRng('remove'));
    [g1, g2, g3].forEach((g, i) => {
      const step = gv.steps[i];
      expect(step.state.payloadText).toBe(new TextDecoder().decode(g.state.payloadBytes));
      expect(hex(g.state.stateHash)).toBe(step.state.stateHashHex);
      expect(hex(g.blob)).toBe(step.blob.blobHex);
      expect(hex(g.secret)).toBe(step.epochSecretHex);
      expect(g.sealedKeys.map((k) => JSON.stringify(k.envelope))).toEqual(
        step.sealedKeys.map((k: { envelope: string }) => JSON.stringify(JSON.parse(k.envelope))),
      );
    });
    expect(gv.groupId.chatId).toBe(groupChatId(K.alice!.signPub, unhex(gv.groupId.nonceHex)));
  });

  it('every member can follow the chain from the files alone', async () => {
    const chatId: string = gv.groupId.chatId;
    let prev: GroupState | undefined;
    for (const step of gv.steps) {
      const keys = deriveGroupKeys(unhex(step.epochSecretHex), step.state.epoch);
      expect(hex(keys.encKey)).toBe(step.encKeyHex);
      const state = await openGroupState(unhex(step.blob.blobHex), { serverId, chatId, keys, ...(prev ? { prev } : {}) });
      expect(verifyGroupState(JSON.parse(step.state.envelope), { serverId, chatId }).version).toBe(step.state.version);
      for (const k of step.sealedKeys) {
        const opened = await openGroupKey(k.envelope, K[k.recipient]!, { serverId });
        expect(hex(opened.secret)).toBe(step.epochSecretHex);
        verifyGroupKey(opened, state);
      }
      prev = state;
    }
  });
});

describe('negative-groups.json', () => {
  const neg = loadVector('negative-groups.json');
  const chatId: string = gv.groupId.chatId;

  it('group states', async () => {
    const states: Record<string, GroupState> = {};
    let prev: GroupState | undefined;
    for (const step of gv.steps) {
      prev = verifyGroupState(JSON.parse(step.state.envelope), { serverId, chatId, ...(prev ? { prev } : {}) });
      states[step.name.split(':')[0]] = prev;
    }
    for (const c of neg.groupStates) {
      const ctx = { serverId, chatId, ...(c.prev ? { prev: states[c.prev] } : {}) };
      expect(errorCode(() => verifyGroupState(c.envelope, ctx)), c.name).toBe(c.expectedError);
    }
  });

  it('sealed keys', async () => {
    for (const c of neg.sealedKeys) {
      expect(await asyncErrorCode(openGroupKey(c.envelope, K[c.openAs]!, { serverId })), c.name).toBe(c.expectedError);
    }
  });

  it('attachment parts and descriptors', async () => {
    const av = loadVector('attachment.json');
    const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
    const single = av.single.blob as BlobRef;
    expect(hex(await encryptBlobPart(single, 0, unhex(av.single.plaintextHex)))).toBe(av.single.ciphertextHex);
    const big = av.twoParts.blob as BlobRef;
    const plain = pattern(big.size, av.twoParts.seed);
    const cts = [
      await encryptBlobPart(big, 0, plain.subarray(0, big.partSize)),
      await encryptBlobPart(big, 1, plain.subarray(big.partSize)),
    ];
    cts.forEach((ct, i) => expect(createHash('sha256').update(ct).digest('hex')).toBe(av.twoParts.parts[i].ciphertextSha256));
    for (const c of neg.attachmentParts) {
      const blob = c.vector === 'single' ? single : big;
      let ct = c.vector === 'single' ? unhex(av.single.ciphertextHex) : (cts[c.present] as Uint8Array);
      if (c.truncate) ct = ct.subarray(0, ct.length - c.truncate);
      if (c.flipLastByte) {
        ct = new Uint8Array(ct);
        ct[ct.length - 1] = (ct[ct.length - 1] as number) ^ 1;
      }
      expect(await asyncErrorCode(decryptBlobPart(blob, c.as, ct)), c.name).toBe(c.expectedError);
    }
    validateAttachment(av.descriptor);
    for (const c of neg.descriptors) expect(errorCode(() => validateAttachment(c.descriptor)), c.name).toBe(c.expectedError);
  });

  it('archives', async () => {
    const arv = loadVector('archive.json');
    const read = async (file: Uint8Array, who: IdentityKeys) => {
      const r = createArchiveReader(who);
      const out: ArchiveRecord[] = [...(await r.push(file))];
      out.push(...(await r.finish()));
      return out;
    };
    const small = unhex(arv.small.fileHex);
    const recs = await read(small, K.alice!);
    expect(recs.map((r) => ({ type: r.type, dataHex: hex(r.data) }))).toEqual(arv.small.records);
    // Reproduce the two-block archive.
    const w = createArchiveWriterWithSalt(K.alice!, unhex(arv.twoBlocks.saltHex));
    const rec = Uint8Array.from({ length: arv.twoBlocks.record.length }, (_, i) => (i * 31 + arv.twoBlocks.record.seed) & 0xff);
    const big = concat(w.header, ...(await w.write(1, rec)), ...(await w.finish()));
    expect(createHash('sha256').update(big).digest('hex')).toBe(arv.twoBlocks.fileSha256);
    for (const c of neg.archives) {
      let file = c.vector === 'small' ? small : big;
      if (c.truncateTo) file = file.subarray(0, c.truncateTo);
      if (c.flipByte !== undefined) {
        file = new Uint8Array(file);
        file[c.flipByte] = (file[c.flipByte] as number) ^ 1;
      }
      expect(await asyncErrorCode(read(file, K[c.openAs]!)), c.name).toBe(c.expectedError);
    }
  });
});

describe('envelopes-avatar-revoked.json and payloads.json', () => {
  it('verify with the package', () => {
    const ev = loadVector('envelopes-avatar-revoked.json');
    const alice = verifyIdentityEnvelope(createIdentityEnvelope(K.alice!, 1));
    const [profile, revoked] = ev.envelopes;
    expect(verifyProfileEnvelope(profile.envelope, alice).avatar).toMatchObject({ type: 'image/webp' });
    expect(verifyRevocationEnvelope(revoked.envelope, alice).userId).toBe(K.alice!.userId);
    for (const p of loadVector('payloads.json').payloads) {
      expect(parsePayload(utf8(p.text)).kind).toBe(p.name.split(' ')[0]);
    }
  });
});
