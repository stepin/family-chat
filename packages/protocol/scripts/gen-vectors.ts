// Regenerates docs/vectors/*.json from fixed inputs using this package.
// Run: pnpm --filter @family-chat/protocol run vectors:generate
// The output is deterministic; the package tests fail if the files and the code disagree.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519.js';
import { concat, copy, lp, utf8 } from '../src/bytes.ts';
import { base32Decode, base64urlDecode, base64urlEncode } from '../src/codec.ts';
import { deriveDmKeys, dmChatId, deriveEncKey, LABEL_DM } from '../src/dm.ts';
import {
  createAuthEnvelope,
  createIdentityEnvelope,
  createProfileEnvelope,
  envelopeSigningInput,
  serializeEnvelope,
  verifyIdentityEnvelope,
  type SignedEnvelope,
} from '../src/envelope.ts';
import { eventAad, eventHeader, eventSigningInput, encodeEventWithNonce, NONCE_BYTES } from '../src/event.ts';
import { fingerprint } from '../src/fingerprint.ts';
import { deriveIdentityKeys, sign, type IdentityKeys } from '../src/keys.ts';
import { encodeMsgPayload } from '../src/payload.ts';
import { isValidPhrase, seedToPhrase } from '../src/phrase.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(h, 'hex'));
const write = (name: string, data: unknown): void => {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');
};

const NOTE = 'Test vectors for docs/PROTOCOL.md. Binary values are lowercase hex unless the field name says otherwise. Secret keys here are test keys only.';

// ---- inputs ----
const seeds = {
  alice: fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
  bob: fromHex('f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff'),
  carol: fromHex('7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c'),
};
const SERVER_ID = 'q8Jb3kVf0w2Xy7HnT1sZ9A';
const OTHER_SERVER_ID = 'Zp4Lm9Qr2Ts6Uv8Wx0Yz1A';
const DEV_ID = 'mfrggzdfmztwq2lk';
const MSG_ID = 'aebagbafaydqqcikbmga2dqpca';
const NONCE = fromHex('a0a1a2a3a4a5a6a7a8a9aaab');
const CREATED = 1794787200000; // 2026-11-15T00:00:00Z

const keys: Record<keyof typeof seeds, IdentityKeys> = {
  alice: deriveIdentityKeys(seeds.alice),
  bob: deriveIdentityKeys(seeds.bob),
  carol: deriveIdentityKeys(seeds.carol),
};

function keyVector(name: keyof typeof seeds) {
  const k = keys[name];
  return {
    seedHex: hex(seeds[name]),
    phrase: seedToPhrase(seeds[name]),
    signSecretHex: hex(k.signSecret),
    signPubHex: hex(k.signPub),
    boxSecretHex: hex(k.boxSecret),
    boxPubHex: hex(k.boxPub),
    selfKeyHex: hex(k.selfKey),
    userId: k.userId,
    fingerprint: fingerprint(k),
  };
}

// ---- identity.json ----
write('identity.json', {
  note: NOTE,
  derivation: {
    hkdf: 'HKDF-SHA-256, salt = empty, L = 32',
    signSecret: 'HKDF(seed, info="fc/v1/sign") is the RFC 8032 Ed25519 secret key (seed form)',
    boxSecret: 'HKDF(seed, info="fc/v1/box") is the RFC 7748 X25519 secret key (clamped on use)',
    selfKey: 'HKDF(seed, info="fc/v1/self")',
    userId: 'base32(SHA-256(signPub)[0..16])',
    fingerprint: 'SHA-256("fc/v1/fingerprint\\n" || lp(signPub) || lp(boxPub)), bytes 0..30 as 6 big-endian 40-bit numbers mod 100000',
  },
  bip39Wordlist: { file: 'bip39-english.txt', sha256: '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda' },
  phrases: [
    { seedHex: '00'.repeat(32), phrase: seedToPhrase(new Uint8Array(32)) },
    { seedHex: 'ff'.repeat(32), phrase: seedToPhrase(new Uint8Array(32).fill(0xff)) },
    { seedHex: hex(seeds.alice), phrase: seedToPhrase(seeds.alice) },
  ],
  users: { alice: keyVector('alice'), bob: keyVector('bob'), carol: keyVector('carol') },
});

// ---- envelopes.json ----
function envVector(kind: string, env: SignedEnvelope, payloadJson: unknown) {
  const payload = base64urlDecode(env.payload);
  return {
    kind,
    signer: 'alice',
    payloadJson,
    payloadText: new TextDecoder().decode(payload),
    signingInputHex: hex(envelopeSigningInput(kind as 'identity', payload)),
    envelope: serializeEnvelope(env),
  };
}
const identityEnv = createIdentityEnvelope(keys.alice, CREATED);
const profileEnv = createProfileEnvelope(keys.alice, { name: 'Алиса', rev: 1, updated: CREATED + 1000 });
const authEnv = createAuthEnvelope(keys.alice, { serverId: SERVER_ID, nonce: 'n0nce-Challenge_123', devId: DEV_ID });
write('envelopes.json', {
  note: NOTE,
  rule: 'sig = Ed25519(signSecret, utf8("fc/v1/" + kind + "\\n") || payloadBytes); envelope = {"payload": base64url(payloadBytes), "sig": base64url(sig)}',
  envelopes: [
    envVector('identity', identityEnv, { created: CREATED }),
    envVector('profile', profileEnv, { name: 'Алиса', rev: 1, updated: CREATED + 1000 }),
    envVector('auth', authEnv, { serverId: SERVER_ID, nonce: 'n0nce-Challenge_123', devId: DEV_ID }),
  ],
  identities: {
    alice: serializeEnvelope(identityEnv),
    bob: serializeEnvelope(createIdentityEnvelope(keys.bob, CREATED)),
    carol: serializeEnvelope(createIdentityEnvelope(keys.carol, CREATED)),
  },
});

// ---- dm.json ----
function dmVector(a: keyof typeof seeds, b: keyof typeof seeds, serverId: string) {
  const ka = keys[a];
  const kb = keys[b];
  const shared = x25519.getSharedSecret(ka.boxSecret, kb.boxPub);
  const [lo, hi] = ka.userId <= kb.userId ? [ka.userId, kb.userId] : [kb.userId, ka.userId];
  const info = concat(utf8(LABEL_DM), lp(serverId), lp(lo), lp(hi));
  const dm = deriveDmKeys(ka, kb, serverId);
  const other = deriveDmKeys(kb, ka, serverId);
  if (hex(dm.dmKey) !== hex(other.dmKey)) throw new Error('dm keys differ');
  return {
    me: a,
    peer: b,
    serverId,
    sharedSecretHex: hex(shared),
    infoHex: hex(info),
    dmKeyHex: hex(dm.dmKey),
    encKeyHex: hex(dm.encKey),
    chatId: dmChatId(serverId, ka.userId, kb.userId),
  };
}
write('dm.json', {
  note: NOTE,
  rule: 'dmKey = HKDF(X25519(mySecret, peerBoxPub), info = "fc/v1/dm" || lp(serverId) || lp(minId) || lp(maxId)); encKey = HKDF(dmKey, "fc/v1/enc"); chatId = base32(SHA-256(utf8("fc/v1/dm\\n" + serverId + "\\n" + minId + "\\n" + maxId))[0..16])',
  chats: [
    dmVector('alice', 'bob', SERVER_ID),
    dmVector('alice', 'alice', SERVER_ID),
    dmVector('alice', 'bob', OTHER_SERVER_ID),
    dmVector('bob', 'carol', SERVER_ID),
  ],
  // The all-zero shared secret must be rejected: peer boxPub = 32 zero bytes.
  zeroPeer: { me: 'alice', peerBoxPubHex: '00'.repeat(32), expectedError: 'invalid-key' },
});

// ---- event.json ----
const dmAB = deriveDmKeys(keys.alice, keys.bob, SERVER_ID);
const chatId = dmChatId(SERVER_ID, keys.alice.userId, keys.bob.userId);
const ctx = { serverId: SERVER_ID, chatId, chat: { epoch: 0, encKey: dmAB.encKey } };
const payload = encodeMsgPayload({
  id: MSG_ID,
  dev: DEV_ID,
  seq: 1,
  body: 'Привет! **Hello**',
  reply: { author: keys.bob.userId, id: 'zzzzzzzzzzzzzzzzzzzzzzzzzq' },
});
const body = await encodeEventWithNonce({ ...ctx, author: keys.alice, payload }, NONCE);
const msgIdBytes = base32Decode(MSG_ID);
const senderIdBytes = base32Decode(keys.alice.userId);
const header = eventHeader(ctx, msgIdBytes);
const sigInput = eventSigningInput(ctx, msgIdBytes, senderIdBytes, payload);
const sig = sign(sigInput, keys.alice.signSecret);
const used = 16 + 64 + 4 + payload.length;
const plaintext = new Uint8Array(Math.ceil(used / 256) * 256);
plaintext.set(concat(senderIdBytes, sig, fromHex(payload.length.toString(16).padStart(8, '0')), payload));
write('event.json', {
  note: NOTE,
  inputs: {
    author: 'alice',
    serverId: SERVER_ID,
    chatId,
    epoch: 0,
    encKeyHex: hex(dmAB.encKey),
    msgId: MSG_ID,
    nonceHex: hex(NONCE),
    payloadText: new TextDecoder().decode(payload),
  },
  intermediate: {
    headerHex: hex(header),
    aadHex: hex(eventAad(header, ctx)),
    signingInputHex: hex(sigInput),
    sigHex: hex(sig),
    plaintextHex: hex(plaintext),
  },
  bodyHex: hex(body),
});

// ---- negative.json ----
async function reencrypt(plain: Uint8Array, c: typeof ctx, nonce = NONCE): Promise<Uint8Array> {
  const h = eventHeader(c, msgIdBytes);
  const key = await crypto.subtle.importKey('raw', c.chat.encKey, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: eventAad(h, c) }, key, copy(plain)),
  );
  return concat(h, nonce, ct);
}
const flip = (b: Uint8Array, i: number): Uint8Array => {
  const c = new Uint8Array(b);
  c[i] = (c[i] as number) ^ 0x01;
  return c;
};
const otherChatId = dmChatId(SERVER_ID, keys.alice.userId, keys.carol.userId);
const dmBC = deriveDmKeys(keys.bob, keys.carol, SERVER_ID);
const badSigPlain = flip(plaintext, 16 + 5);
const movedPlainCtx = { ...ctx, chatId: otherChatId };
if (NONCE.length !== NONCE_BYTES) throw new Error('nonce');

const tamperedPayloadEnv = (() => {
  const text = new TextDecoder().decode(base64urlDecode(identityEnv.payload)).replace(String(CREATED), String(CREATED + 1));
  return serializeEnvelope({ payload: base64urlEncode(utf8(text)), sig: identityEnv.sig });
})();
const tamperedSigEnv = serializeEnvelope({
  payload: identityEnv.payload,
  sig: base64urlEncode(flip(base64urlDecode(identityEnv.sig), 10)),
});
// An identity whose userId belongs to someone else, correctly signed by Alice's key.
const wrongUserIdEnv = (() => {
  const p = utf8(
    JSON.stringify({
      v: 1,
      userId: keys.bob.userId,
      signPub: base64urlEncode(keys.alice.signPub),
      boxPub: base64urlEncode(keys.alice.boxPub),
      created: CREATED,
    }),
  );
  return serializeEnvelope({
    payload: base64urlEncode(p),
    sig: base64urlEncode(sign(envelopeSigningInput('identity', p), keys.alice.signSecret)),
  });
})();
// Sanity: the positive identity verifies.
verifyIdentityEnvelope(identityEnv);

const alicePhrase = seedToPhrase(seeds.alice).split(' ');
const badChecksum = [...alicePhrase.slice(0, 23), alicePhrase[23] === 'abandon' ? 'ability' : 'abandon'].join(' ');
if (isValidPhrase(badChecksum)) throw new Error('replacement word happens to keep the checksum valid; pick another');

const decodeCtx = (o: { serverId?: string; chatId?: string; epoch?: number; encKeyHex?: string }) => ({
  serverId: o.serverId ?? SERVER_ID,
  chatId: o.chatId ?? chatId,
  epoch: o.epoch ?? 0,
  encKeyHex: o.encKeyHex ?? hex(dmAB.encKey),
});

write('negative.json', {
  note: NOTE + ' Each event case is decoded with the given context; members known to the decoder are listed in "members".',
  events: [
    {
      name: 'wrong-aad: message id in the header altered (AAD differs, tags still match)',
      bodyHex: hex(flip(body, 24)),
      context: decodeCtx({}),
      members: ['alice', 'bob'],
      expectedError: 'wrong-key',
    },
    {
      name: 'wrong-aad: epoch altered in the header and in the context',
      bodyHex: hex(
        (() => {
          const b = new Uint8Array(body);
          b[7] = 1;
          return b;
        })(),
      ),
      context: decodeCtx({ epoch: 1 }),
      members: ['alice', 'bob'],
      expectedError: 'wrong-key',
    },
    {
      name: 'moved to another chat: same bytes delivered in the Alice-Carol chat',
      bodyHex: hex(body),
      context: decodeCtx({ chatId: otherChatId }),
      members: ['alice', 'bob'],
      expectedError: 'wrong-chat',
    },
    {
      name: 'moved to another chat by a member who re-encrypted the signed plaintext',
      bodyHex: hex(await reencrypt(plaintext, movedPlainCtx)),
      context: decodeCtx({ chatId: otherChatId }),
      members: ['alice', 'bob'],
      expectedError: 'bad-signature',
    },
    {
      name: 'moved to another server: same bytes, other serverId, same key',
      bodyHex: hex(body),
      context: decodeCtx({ serverId: OTHER_SERVER_ID }),
      members: ['alice', 'bob'],
      expectedError: 'wrong-server',
    },
    {
      name: 'wrong epoch in the context',
      bodyHex: hex(body),
      context: decodeCtx({ epoch: 1 }),
      members: ['alice', 'bob'],
      expectedError: 'wrong-epoch',
    },
    {
      name: 'wrong key: Bob-Carol key',
      bodyHex: hex(body),
      context: decodeCtx({ encKeyHex: hex(dmBC.encKey) }),
      members: ['alice', 'bob'],
      expectedError: 'wrong-key',
    },
    {
      name: 'ciphertext altered (last tag byte)',
      bodyHex: hex(flip(body, body.length - 1)),
      context: decodeCtx({}),
      members: ['alice', 'bob'],
      expectedError: 'wrong-key',
    },
    {
      name: 'tampered signature, re-encrypted with the right key',
      bodyHex: hex(await reencrypt(badSigPlain, ctx)),
      context: decodeCtx({}),
      members: ['alice', 'bob'],
      expectedError: 'bad-signature',
    },
    {
      name: 'unknown author: Alice is not a member known to the decoder',
      bodyHex: hex(body),
      context: decodeCtx({}),
      members: ['bob', 'carol'],
      expectedError: 'unknown-author',
    },
    {
      name: 'non-zero padding',
      bodyHex: hex(await reencrypt(flip(plaintext, plaintext.length - 1), ctx)),
      context: decodeCtx({}),
      members: ['alice', 'bob'],
      expectedError: 'malformed',
    },
    {
      name: 'truncated body',
      bodyHex: hex(body.subarray(0, body.length - 1)),
      context: decodeCtx({}),
      members: ['alice', 'bob'],
      expectedError: 'malformed',
    },
  ],
  envelopes: [
    { name: 'identity with tampered signature', kind: 'identity', envelope: tamperedSigEnv, expectedError: 'bad-signature' },
    {
      name: 'identity with tampered payload (created + 1), original signature',
      kind: 'identity',
      envelope: tamperedPayloadEnv,
      expectedError: 'bad-signature',
    },
    {
      name: 'identity whose userId is not the hash of signPub',
      kind: 'identity',
      envelope: wrongUserIdEnv,
      expectedError: 'user-id-mismatch',
    },
    {
      name: 'profile signed by Alice checked against Bob identity',
      kind: 'profile',
      envelope: serializeEnvelope(profileEnv),
      signer: 'bob',
      expectedError: 'user-id-mismatch',
    },
    {
      name: 'auth envelope signature replaced by the identity signature',
      kind: 'auth',
      envelope: serializeEnvelope({ payload: authEnv.payload, sig: identityEnv.sig }),
      signer: 'alice',
      expectedError: 'bad-signature',
    },
  ],
  phrases: [
    { name: 'bad checksum: last word replaced', phrase: badChecksum, expectedError: 'phrase-checksum' },
    {
      name: 'unknown word at position 3',
      phrase: [...alicePhrase.slice(0, 2), 'notaword', ...alicePhrase.slice(3)].join(' '),
      expectedError: 'phrase-unknown-word',
      positions: [3],
    },
    { name: '23 words', phrase: alicePhrase.slice(0, 23).join(' '), expectedError: 'phrase-word-count' },
  ],
});

// Keep deriveEncKey referenced for readers: encKey = deriveEncKey(dmKey).
if (hex(deriveEncKey(dmAB.dmKey)) !== hex(dmAB.encKey)) throw new Error('encKey mismatch');
console.log(`vectors written to ${out}`);
