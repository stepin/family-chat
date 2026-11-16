// Regenerates the vectors of groups, sealed keys, attachments, archive, revocation, avatar,
// payloads and their negative cases from fixed inputs using this package.
// Run: pnpm --filter @family-chat/protocol run vectors:generate
// The base files are written by gen-vectors.ts. hpke-rfc9180.json is external
// data (RFC 9180 known answers) and is not generated here.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counterNonce } from '../src/aead.ts';
import { createArchiveWriterWithSalt, deriveArchiveKey } from '../src/archive.ts';
import { blobPartAad, encryptBlobPart, type BlobRef } from '../src/attachment.ts';
import { concat, lp, u32be, utf8, type Bytes } from '../src/bytes.ts';
import { base32Encode, base64urlDecode, base64urlEncode } from '../src/codec.ts';
import {
  createProfileEnvelope,
  createRevocationEnvelope,
  envelopeSigningInput,
  sealBytes,
  serializeEnvelope,
  type SignedEnvelope,
} from '../src/envelope.ts';
import {
  encodeGroupState,
  groupChatId,
  LABEL_GROUP_ID,
  signTransfer,
  transferSigningInput,
  type GroupState,
} from '../src/group.ts';
import { groupKeyInfo, openGroupKey } from '../src/group-key.ts';
import {
  acceptGroupKey,
  createGroupWith,
  removeGroupMembersWith,
  renameGroupWith,
  transferGroupOwnershipWith,
  type GroupChange,
  type Rng,
} from '../src/group-ops.ts';
import { hpkeDeriveKeyPair } from '../src/hpke.ts';
import { deriveIdentityKeys, type IdentityKeys } from '../src/keys.ts';
import {
  encodeDeletePayload,
  encodeEditPayload,
  encodeMsgPayload,
  encodeReactPayload,
} from '../src/payload.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Bytes => new Uint8Array(Buffer.from(h, 'hex'));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const write = (name: string, data: unknown): void => {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');
};
const NOTE =
  'Test vectors for docs/PROTOCOL.md. Binary values are lowercase hex unless the field name says otherwise. Secret keys here are test keys only. Users alice, bob and carol are the ones of identity.json.';

// ---- users ----
const idv = JSON.parse(readFileSync(join(out, 'identity.json'), 'utf8'));
const extraSeeds = {
  dave: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d',
  mallory: '6d616c6c6f72796d616c6c6f72796d616c6c6f72796d616c6c6f72796d616c6c',
};
const K: Record<string, IdentityKeys> = {
  alice: deriveIdentityKeys(fromHex(idv.users.alice.seedHex)),
  bob: deriveIdentityKeys(fromHex(idv.users.bob.seedHex)),
  carol: deriveIdentityKeys(fromHex(idv.users.carol.seedHex)),
  dave: deriveIdentityKeys(fromHex(extraSeeds.dave)),
  mallory: deriveIdentityKeys(fromHex(extraSeeds.mallory)),
};
const nameOf = (userId: string): string => Object.keys(K).find((n) => K[n]!.userId === userId)!;
const SERVER_ID = 'q8Jb3kVf0w2Xy7HnT1sZ9A';
const T0 = 1794787200000;

/** Deterministic "random" bytes: SHA-256("fc/test/rng\n" || label || u32 counter), recorded in order. */
function testRng(label: string): Rng & { draws: string[] } {
  let i = 0;
  const draws: string[] = [];
  const rng = ((n: number) => {
    if (n > 32) throw new Error('test rng gives at most 32 bytes per draw');
    const b = new Uint8Array(createHash('sha256').update(concat(utf8(`fc/test/rng\n${label}`), u32be(i++))).digest()).subarray(0, n);
    draws.push(hex(b));
    return b;
  }) as Rng & { draws: string[] };
  rng.draws = draws;
  return rng;
}

// ---- group.json ----
function stateVector(state: GroupState) {
  return {
    version: state.version,
    epoch: state.epoch,
    owner: nameOf(state.owner),
    signer: nameOf(state.by),
    payloadText: text(state.payloadBytes),
    signingInputHex: hex(envelopeSigningInput('group-state', state.payloadBytes)),
    envelope: serializeEnvelope(state.envelope),
    stateHashHex: hex(state.stateHash),
  };
}

async function stepVector(name: string, change: GroupChange, draws: string[], hasNewSecret: boolean, groupNonceDraw = false) {
  const s = change.state;
  let d = 0;
  const groupNonceHex = groupNonceDraw ? draws[d++] : undefined;
  const newSecretHex = hasNewSecret ? draws[d++] : undefined;
  const blobNonceHex = draws[d++]!;
  const header = change.blob.subarray(0, 28);
  const envBytes = utf8(serializeEnvelope(s.envelope));
  const used = 4 + envBytes.length;
  const plaintext = new Uint8Array(Math.ceil(used / 256) * 256);
  plaintext.set(concat(u32be(envBytes.length), envBytes));
  const keys = [];
  for (const k of change.sealedKeys) {
    const ikmE = draws[d++]!;
    const p = JSON.parse(text(base64urlDecode(k.envelope.payload)));
    const recipient = K[nameOf(k.recipient)]!;
    const opened = await openGroupKey(k.envelope, recipient, { serverId: SERVER_ID });
    keys.push({
      recipient: nameOf(k.recipient),
      ikmEHex: ikmE,
      ephemeralSecretHex: hex(hpkeDeriveKeyPair(fromHex(ikmE)).secretKey),
      infoHex: hex(groupKeyInfo(SERVER_ID, s.chatId, s.epoch, k.recipient, s.version, s.stateHash)),
      encHex: hex(base64urlDecode(p.enc)),
      ctHex: hex(base64urlDecode(p.ct)),
      payloadText: text(base64urlDecode(k.envelope.payload)),
      envelope: serializeEnvelope(k.envelope),
      openedSecretHex: hex(opened.secret),
    });
  }
  if (d !== draws.length) throw new Error(`${name}: unexpected number of random draws`);
  return {
    name,
    ...(groupNonceHex ? { groupNonceHex } : {}),
    epochSecretHex: hex(change.secret),
    ...(newSecretHex ? { newEpochSecret: true } : { newEpochSecret: false }),
    encKeyHex: hex(change.keys.encKey),
    state: stateVector(s),
    transfers: s.transfers.map((t, i) => {
      const from = i === 0 ? s.creator.signPub : s.transfers[i - 1]!.toSignPub;
      return {
        version: t.version,
        to: nameOf(t.to),
        signingInputHex: hex(transferSigningInput(SERVER_ID, s.chatId, t.version, from, t.toSignPub)),
        sigHex: hex(t.sig),
      };
    }),
    blob: {
      nonceHex: blobNonceHex,
      headerHex: hex(header),
      aadHex: hex(concat(header, lp(SERVER_ID), lp(s.chatId))),
      plaintextHex: hex(plaintext),
      blobHex: hex(change.blob),
    },
    sealedKeys: keys,
  };
}

const rng1 = testRng('create');
const g1 = await createGroupWith(
  { serverId: SERVER_ID, owner: K.alice!, name: 'Семья', members: [K.bob!, K.carol!] },
  rng1,
);
const rng2 = testRng('transfer');
const g2 = await transferGroupOwnershipWith({ prev: g1.state, owner: K.alice!, secret: g1.secret, to: K.bob!.userId }, rng2);
const rng3 = testRng('remove');
const g3 = await removeGroupMembersWith({ prev: g2.state, owner: K.bob!, userIds: [K.carol!.userId] }, rng3);
// Sanity: a newcomer-style check of version 3 from the chain alone, by Alice.
await acceptGroupKey(g3.sealedKeys.find((k) => k.recipient === K.alice!.userId)!.envelope, g3.blob, K.alice!, { serverId: SERVER_ID });

const chatId = g1.state.chatId;
const groupNonce = g1.state.creator.nonce;
write('group.json', {
  note: NOTE,
  extraUsers: Object.fromEntries(Object.entries(extraSeeds).map(([n, s]) => [n, { seedHex: s, userId: K[n]!.userId }])),
  serverId: SERVER_ID,
  rng: 'The "random" inputs (group nonce, epoch secrets, blob nonces, HPKE ikmE) are listed per step. They were drawn as SHA-256("fc/test/rng\\n" || label || u32 counter) truncated; a real client uses crypto.getRandomValues.',
  groupId: {
    rule: 'chatId = base32(SHA-256("fc/v1/group-id\\n" || lp(creatorSignPub) || lp(nonce))[0..16])',
    creator: 'alice',
    nonceHex: hex(groupNonce),
    hashInputHex: hex(concat(utf8(LABEL_GROUP_ID), lp(K.alice!.signPub), lp(groupNonce))),
    chatId,
  },
  rules: {
    state: 'envelope kind "group-state": sig = Ed25519(signer, "fc/v1/group-state\\n" || payload)',
    transfer: 'sig = Ed25519(previous owner, "fc/v1/group-transfer\\n" || lp(serverId) || lp(chatId) || u32 version || lp(fromSignPub) || lp(toSignPub))',
    encKey: 'encKey = HKDF-SHA-256(epochSecret, salt = empty, info = "fc/v1/enc", 32)',
    blob: 'header = "FCS" || 0x01 || u32 epoch || u32 version || serverTag || chatTag; blob = header || nonce || AES-256-GCM(encKey, nonce, u32 len || envelope JSON || zeros to a multiple of 256, AAD = header || lp(serverId) || lp(chatId))',
    sealedKey: 'HPKE base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; ephemeral key = DeriveKeyPair(ikmE); pkR = recipient boxPub; info as given; aad = empty; plaintext = epoch secret',
  },
  steps: [
    await stepVector('create: alice creates "Семья" with bob and carol', g1, rng1.draws, true, true),
    await stepVector('transfer: alice hands ownership to bob (signed by alice)', g2, rng2.draws, false),
    await stepVector('remove: bob removes carol (new epoch, keys for alice and bob)', g3, rng3.draws, true),
  ],
});

// ---- envelopes-avatar-revoked.json ----
const avatar = { sha256: base64urlEncode(createHash('sha256').update('avatar bytes').digest()), type: 'image/webp' as const };
const profileEnv = createProfileEnvelope(K.alice!, { name: 'Алиса', rev: 2, updated: T0 + 2000, avatar });
const revokedEnv = createRevocationEnvelope(K.alice!, T0 + 86_400_000);
const envV = (kind: 'profile' | 'revoked', env: SignedEnvelope) => {
  const payload = base64urlDecode(env.payload);
  return { kind, signer: 'alice', payloadText: text(payload), signingInputHex: hex(envelopeSigningInput(kind, payload)), envelope: serializeEnvelope(env) };
};
write('envelopes-avatar-revoked.json', {
  note: NOTE,
  rule: 'as in envelopes.json: sig = Ed25519(signSecret, utf8("fc/v1/" + kind + "\\n") || payloadBytes)',
  envelopes: [envV('profile', profileEnv), envV('revoked', revokedEnv)],
  avatarRule: 'avatar is null or exactly {"sha256": base64url(32 bytes), "type": "image/jpeg" | "image/webp"}',
});

// ---- attachment.json ----
const pattern = (n: number, seed: number): Bytes => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const smallBlob: BlobRef = {
  id: base32Encode(fromHex('00112233445566778899aabbccddeeff')),
  key: base64urlEncode(fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')),
  parts: 1,
  partSize: 4194304,
  size: 1000,
};
const smallPlain = pattern(1000, 7);
const smallCt = await encryptBlobPart(smallBlob, 0, smallPlain);
const bigBlob: BlobRef = {
  id: base32Encode(fromHex('ffeeddccbbaa99887766554433221100')),
  key: base64urlEncode(fromHex('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f')),
  parts: 2,
  partSize: 4194304,
  size: 2 * 4194304,
};
const bigPlain = pattern(bigBlob.size, 1);
const bigParts = [];
for (let i = 0; i < 2; i++) {
  const plain = bigPlain.subarray(i * bigBlob.partSize, Math.min((i + 1) * bigBlob.partSize, bigBlob.size));
  const ct = await encryptBlobPart(bigBlob, i, plain);
  bigParts.push({
    index: i,
    plaintextLength: plain.length,
    nonceHex: hex(counterNonce(i)),
    aadHex: hex(blobPartAad(fromHex('ffeeddccbbaa99887766554433221100'), i, 2)),
    ciphertextLength: ct.length,
    ciphertextSha256: sha(ct),
    tagHex: hex(ct.subarray(ct.length - 16)),
  });
}
const descriptor = {
  blob: smallBlob,
  name: 'photo.jpg',
  mime: 'image/jpeg',
  kind: 'image',
  w: 800,
  h: 600,
  thumb: base64urlEncode(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46)),
};
write('attachment.json', {
  note: NOTE,
  rule: 'part i (0-based) = AES-256-GCM(key, nonce = 8 zero bytes || u32 i, plaintext_i, AAD = "fc/v1/blob\\n" || lp(blobId raw 16 bytes) || u32 i || u32 parts); parts = ceil(size / partSize), 1 for an empty file',
  plaintextPattern: 'byte j of the file = (j * 31 + seed) mod 256',
  single: { blob: smallBlob, seed: 7, plaintextHex: hex(smallPlain), aadHex: hex(blobPartAad(fromHex('00112233445566778899aabbccddeeff'), 0, 1)), ciphertextHex: hex(smallCt) },
  twoParts: { blob: bigBlob, seed: 1, parts: bigParts },
  descriptor,
});

// ---- payloads.json ----
const MSG_ID = 'aebagbafaydqqcikbmga2dqpca';
const DEV_ID = 'mfrggzdfmztwq2lk';
const target = { author: K.bob!.userId, id: 'zzzzzzzzzzzzzzzzzzzzzzzzzq' };
const voice = {
  blob: { ...bigBlob },
  name: 'voice.m4a',
  mime: 'audio/mp4',
  kind: 'voice' as const,
  dur: 4200,
  peaks: Array.from({ length: 64 }, (_, i) => (i * 37) % 256),
};
write('payloads.json', {
  note: NOTE,
  payloads: [
    { name: 'msg with attachments, location and fwd, no body', text: text(encodeMsgPayload({ id: MSG_ID, dev: DEV_ID, seq: 5, fwd: true, attachments: [descriptor as never, voice], location: { lat: 55.7558, lon: 37.6173, accuracy: 25 } })) },
    { name: 'edit', text: text(encodeEditPayload({ id: MSG_ID, dev: DEV_ID, seq: 6, target, body: 'исправлено' })) },
    { name: 'delete', text: text(encodeDeletePayload({ id: MSG_ID, dev: DEV_ID, seq: 7, target, targetDev: DEV_ID, targetSeq: 3 })) },
    { name: 'react', text: text(encodeReactPayload({ id: MSG_ID, dev: DEV_ID, seq: 8, target, emoji: '👍', on: true })) },
  ],
});

// ---- archive.json ----
const salt = fromHex('5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a');
async function archive(records: [number, Uint8Array][], s: Uint8Array): Promise<Bytes> {
  const w = createArchiveWriterWithSalt(K.alice!, s);
  const parts: Uint8Array[] = [w.header];
  for (const [t, d] of records) parts.push(...(await w.write(t, d)));
  parts.push(...(await w.finish()));
  return concat(...parts);
}
const smallRecords: [number, Uint8Array][] = [
  [1, utf8('{"server":"q8Jb3kVf0w2Xy7HnT1sZ9A"}')],
  [2, new Uint8Array(0)],
  [3, pattern(100, 5)],
];
const smallArchive = await archive(smallRecords, salt);
const { key: archiveKey, check } = deriveArchiveKey(K.alice!.selfKey, salt);
const bigRecord = pattern(1024 * 1024 + 500, 9);
const salt2 = fromHex('a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5');
const bigArchive = await archive([[1, bigRecord]], salt2);
const blockCt = 1024 * 1024 + 16;
write('archive.json', {
  note: NOTE,
  rule: 'header = "FCA" || 0x01 || salt(16) || check(16); archiveKey = HKDF(selfKey, "fc/v1/archive" || salt); check = HKDF(archiveKey, "fc/v1/archive-check")[0..16]; block i = AES-256-GCM(archiveKey, nonce = 8 zero bytes || u32 i, plaintext_i, AAD = header || u32 i || u8 last); plaintext = records u16 type || u32 len || data; blocks of 1 MiB plaintext, the last one shorter (possibly empty) and flagged',
  owner: 'alice',
  small: {
    saltHex: hex(salt),
    archiveKeyHex: hex(archiveKey),
    checkHex: hex(check),
    records: smallRecords.map(([type, data]) => ({ type, dataHex: hex(data) })),
    fileHex: hex(smallArchive),
  },
  twoBlocks: {
    saltHex: hex(salt2),
    record: { type: 1, length: bigRecord.length, seed: 9, pattern: 'byte j = (j * 31 + seed) mod 256' },
    fileLength: bigArchive.length,
    fileSha256: sha(bigArchive),
    blockTagsHex: [hex(bigArchive.subarray(36 + blockCt - 16, 36 + blockCt)), hex(bigArchive.subarray(bigArchive.length - 16))],
  },
});

// ---- negative-groups.json ----
const ctxNote = 'Group cases are verified with serverId and chatId of group.json and no previous state unless "prev" names a step.';
// State signed by a non-owner member (carol) claiming to sign as herself.
const v1 = JSON.parse(text(g1.state.payloadBytes));
const nonOwner = sealBytes('group-state', utf8(JSON.stringify({ ...v1, name: 'Захват', by: K.carol!.userId })), K.carol!);
// Broken chain: mallory-free variant: carol signs a transfer to herself and the state.
const brokenFields = {
  serverId: SERVER_ID,
  chatId,
  version: 2,
  epoch: 0,
  name: 'Семья',
  creatorSignPub: K.alice!.signPub,
  nonce: groupNonce,
  owner: K.carol!.userId,
  transfers: [signTransfer(K.carol!, SERVER_ID, chatId, 2, K.carol!)],
  members: g1.state.members,
  prev: g1.state.stateHash,
};
const brokenChain = encodeGroupState(brokenFields, K.carol!);
// Replay of version 2 on top of version 2.
const toBob = g1.sealedKeys.find((k) => k.recipient === K.bob!.userId)!.envelope;
const toBobPayload = JSON.parse(text(base64urlDecode(toBob.payload)));
const mallorysGroup = await createGroupWith({ serverId: SERVER_ID, owner: K.mallory!, name: 'М', members: [K.bob!] }, testRng('mallory'));
const replayChat = sealBytes('group-key', utf8(JSON.stringify({ ...toBobPayload, chatId: mallorysGroup.state.chatId, by: K.mallory!.userId })), K.mallory!);
const replayMemberChanged = serializeEnvelope({
  payload: base64urlEncode(utf8(JSON.stringify({ ...toBobPayload, recipient: K.carol!.userId }))),
  sig: toBob.sig,
});
const renamed = await renameGroupWith({ prev: g1.state, owner: K.alice!, secret: g1.secret, name: 'x' }, testRng('neg-rename'));

write('negative-groups.json', {
  note: `${NOTE} ${ctxNote}`,
  groupStates: [
    { name: 'state signed by a non-owner member (carol)', envelope: serializeEnvelope(nonOwner), expectedError: 'not-owner' },
    { name: 'broken transfer chain: carol signs a transfer to herself', envelope: serializeEnvelope(brokenChain), expectedError: 'bad-chain' },
    { name: 'version 2 replayed on top of version 2', envelope: serializeEnvelope(g2.state.envelope), prev: 'transfer', expectedError: 'invalid-transition' },
    { name: 'renamed version 2 checked against the transfer chain end (version 2)', envelope: serializeEnvelope(renamed.state.envelope), prev: 'transfer', expectedError: 'invalid-transition' },
  ],
  sealedKeys: [
    { name: 'key for bob delivered to carol unchanged', envelope: serializeEnvelope(toBob), openAs: 'carol', expectedError: 'wrong-recipient' },
    { name: 'recipient field changed to carol (original signature)', envelope: replayMemberChanged, openAs: 'carol', expectedError: 'wrong-key' },
    { name: 'ciphertext lifted into mallory\'s group (re-signed by mallory)', envelope: serializeEnvelope(replayChat), openAs: 'bob', expectedError: 'wrong-key' },
  ],
  attachmentParts: [
    { name: 'parts reordered: part 1 presented as part 0', vector: 'twoParts', present: 1, as: 0, expectedError: 'wrong-key' },
    { name: 'parts reordered: part 0 presented as part 1', vector: 'twoParts', present: 0, as: 1, expectedError: 'wrong-key' },
    { name: 'part 1 truncated by one byte', vector: 'twoParts', present: 1, as: 1, truncate: 1, expectedError: 'malformed' },
    { name: 'single part with the tag altered', vector: 'single', present: 0, as: 0, flipLastByte: true, expectedError: 'wrong-key' },
  ],
  descriptors: [
    { name: 'wrong part count', descriptor: { ...descriptor, blob: { ...smallBlob, parts: 2 } }, expectedError: 'malformed' },
    { name: 'path-like blob id', descriptor: { ...descriptor, blob: { ...smallBlob, id: '../../../etc/passwd' } }, expectedError: 'malformed' },
    { name: 'blob id with uppercase letters', descriptor: { ...descriptor, blob: { ...smallBlob, id: smallBlob.id.toUpperCase() } }, expectedError: 'malformed' },
    { name: 'part size not allowed', descriptor: { ...descriptor, blob: { ...smallBlob, partSize: 65536 } }, expectedError: 'malformed' },
    { name: 'file name with a path separator', descriptor: { ...descriptor, name: '../photo.jpg' }, expectedError: 'malformed' },
    { name: 'voice with 63 peaks', descriptor: { ...voice, peaks: voice.peaks.slice(1) }, expectedError: 'malformed' },
  ],
  archives: [
    { name: 'small archive opened by bob', vector: 'small', openAs: 'bob', expectedError: 'wrong-identity' },
    { name: 'two-block archive truncated after the first block', vector: 'twoBlocks', truncateTo: 36 + blockCt, openAs: 'alice', expectedError: 'malformed' },
    { name: 'small archive with one ciphertext byte altered', vector: 'small', flipByte: 40, openAs: 'alice', expectedError: 'malformed' },
  ],
});

console.log(`group vectors written to ${out}`);
