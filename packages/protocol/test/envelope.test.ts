import { describe, expect, it } from 'vitest';
import {
  createAuthEnvelope,
  createIdentityEnvelope,
  createProfileEnvelope,
  createRevocationEnvelope,
  envelopeSigningInput,
  maxPayloadBytes,
  parseEnvelope,
  serializeEnvelope,
  verifyAuthEnvelope,
  verifyIdentityEnvelope,
  verifyProfileEnvelope,
  verifyRevocationEnvelope,
  type SignedEnvelope,
} from '../src/envelope.ts';
import { utf8 } from '../src/bytes.ts';
import { base64urlDecode, base64urlEncode } from '../src/codec.ts';
import { deriveIdentityKeys, sign, type IdentityKeys } from '../src/keys.ts';
import { newDevId } from '../src/random.ts';
import { MAX_ENVELOPE_PAYLOAD_BYTES } from '../src/constants.ts';
import { errorCode, hex, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const v = loadVector('envelopes.json');
const neg = loadVector('negative.json');

const keys: Record<string, IdentityKeys> = Object.fromEntries(
  Object.entries(ids.users).map(([n, u]) => [n, deriveIdentityKeys(unhex((u as { seedHex: string }).seedHex))]),
);
const alice = keys.alice!;
const bob = keys.bob!;
const aliceId = verifyIdentityEnvelope(v.identities.alice);
const bobId = verifyIdentityEnvelope(v.identities.bob);

/** Build an envelope signed by `k` over arbitrary payload JSON. */
function forge(kind: 'identity' | 'profile' | 'auth' | 'revoked', payload: unknown, k: IdentityKeys = alice): SignedEnvelope {
  const bytes = utf8(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { payload: base64urlEncode(bytes), sig: base64urlEncode(sign(envelopeSigningInput(kind, bytes), k.signSecret)) };
}

const vec = (kind: string) => v.envelopes.find((e: { kind: string }) => e.kind === kind);

describe('envelope vectors', () => {
  it('identity is reproduced byte for byte', () => {
    const e = vec('identity');
    const env = createIdentityEnvelope(alice, e.payloadJson.created);
    expect(serializeEnvelope(env)).toBe(e.envelope);
    expect(hex(envelopeSigningInput('identity', base64urlDecode(env.payload)))).toBe(e.signingInputHex);
    const id = verifyIdentityEnvelope(e.envelope);
    expect(id.userId).toBe(alice.userId);
    expect(hex(id.signPub)).toBe(hex(alice.signPub));
    expect(hex(id.boxPub)).toBe(hex(alice.boxPub));
    expect(id.created).toBe(e.payloadJson.created);
  });

  it('profile is reproduced byte for byte', () => {
    const e = vec('profile');
    const env = createProfileEnvelope(alice, e.payloadJson);
    expect(serializeEnvelope(env)).toBe(e.envelope);
    const p = verifyProfileEnvelope(e.envelope, aliceId);
    expect(p).toMatchObject({ userId: alice.userId, name: 'Алиса', avatar: null, rev: 1 });
  });

  it('auth is reproduced byte for byte', () => {
    const e = vec('auth');
    const env = createAuthEnvelope(alice, e.payloadJson);
    expect(serializeEnvelope(env)).toBe(e.envelope);
    const a = verifyAuthEnvelope(e.envelope, aliceId, { serverId: e.payloadJson.serverId, nonce: e.payloadJson.nonce });
    expect(a).toMatchObject({ userId: alice.userId, devId: e.payloadJson.devId });
  });

  it.each(neg.envelopes as { name: string; kind: string; envelope: string; signer?: string; expectedError: string }[])(
    'negative vector: $name',
    (c) => {
      const signerId = c.signer === 'bob' ? bobId : aliceId;
      const run = () =>
        c.kind === 'identity'
          ? verifyIdentityEnvelope(c.envelope)
          : c.kind === 'profile'
            ? verifyProfileEnvelope(c.envelope, signerId)
            : verifyAuthEnvelope(c.envelope, signerId);
      expect(errorCode(run)).toBe(c.expectedError);
    },
  );
});

describe('envelope parsing', () => {
  const good = vec('identity').envelope as string;

  it('accepts a JSON string or a parsed object and keeps the exact strings', () => {
    const fromString = parseEnvelope(good);
    expect(parseEnvelope(JSON.parse(good))).toEqual(fromString);
    expect(serializeEnvelope(fromString)).toBe(good);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['missing sig', '{"payload":"e30"}'],
    ['extra key', '{"payload":"e30","sig":"AA","x":1}'],
    ['non-string payload', '{"payload":1,"sig":"AA"}'],
  ])('rejects %s', (_n, text) => {
    expect(errorCode(() => parseEnvelope(text))).toBe('malformed');
  });

  it('rejects bad base64url, short signatures, bad UTF-8, non-object payloads', () => {
    const e = JSON.parse(good);
    expect(errorCode(() => verifyIdentityEnvelope({ ...e, payload: e.payload + '=' }))).toBe('malformed');
    expect(errorCode(() => verifyIdentityEnvelope({ ...e, sig: 'AAAA' }))).toBe('malformed');
    expect(errorCode(() => verifyIdentityEnvelope({ ...e, payload: base64urlEncode(Uint8Array.of(0xff)) }))).toBe(
      'malformed',
    );
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', '[1]')))).toBe('malformed');
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', '﻿{"v":1}')))).toBe('malformed');
  });

  it('rejects oversized payloads before decoding', () => {
    const big = { payload: 'A'.repeat(Math.ceil((MAX_ENVELOPE_PAYLOAD_BYTES * 4) / 3) + 4), sig: 'AA' };
    expect(errorCode(() => verifyIdentityEnvelope(big))).toBe('too-large');
    expect(errorCode(() => createProfileEnvelope(alice, { name: 'a', rev: 0 }))).toBe('ok');
  });
});

describe('identity envelope', () => {
  const base = () => ({
    v: 1,
    userId: alice.userId,
    signPub: base64urlEncode(alice.signPub),
    boxPub: base64urlEncode(alice.boxPub),
    created: 1,
  });

  it('round-trips a fresh identity', () => {
    const k = deriveIdentityKeys(crypto.getRandomValues(new Uint8Array(32)));
    const id = verifyIdentityEnvelope(serializeEnvelope(createIdentityEnvelope(k)));
    expect(id.userId).toBe(k.userId);
    expect(id.created).toBeGreaterThan(1_700_000_000_000);
  });

  it('ignores unknown extra fields but rejects other versions', () => {
    expect(verifyIdentityEnvelope(forge('identity', { ...base(), extra: true })).userId).toBe(alice.userId);
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', { ...base(), v: 2 })))).toBe('unsupported-version');
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', { ...base(), v: '1' })))).toBe('unsupported-version');
  });

  it.each([
    ['userId of wrong length', { userId: 'abc' }],
    ['signPub of wrong length', { signPub: base64urlEncode(new Uint8Array(31)) }],
    ['boxPub of wrong length', { boxPub: base64urlEncode(new Uint8Array(33)) }],
    ['negative created', { created: -1 }],
    ['fractional created', { created: 1.5 }],
    ['string created', { created: '1' }],
  ])('rejects %s', (_n, patch) => {
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', { ...base(), ...patch })))).toBe('malformed');
  });

  it('rejects a signature made for another envelope kind', () => {
    const bytes = utf8(JSON.stringify(base()));
    const env = { payload: base64urlEncode(bytes), sig: base64urlEncode(sign(envelopeSigningInput('profile', bytes), alice.signSecret)) };
    expect(errorCode(() => verifyIdentityEnvelope(env))).toBe('bad-signature');
  });

  it('rejects an identity signed by someone else', () => {
    expect(errorCode(() => verifyIdentityEnvelope(forge('identity', base(), bob)))).toBe('bad-signature');
  });

  it('rejects invalid created values when creating', () => {
    expect(errorCode(() => createIdentityEnvelope(alice, -5))).toBe('invalid-argument');
    expect(errorCode(() => createIdentityEnvelope(alice, Number.NaN))).toBe('invalid-argument');
  });
});

describe('profile envelope', () => {
  const base = () => ({ v: 1, userId: alice.userId, name: 'Alice', avatar: null, rev: 3, updated: 5 });

  it('trims the name, defaults updated, and verifies', () => {
    const p = verifyProfileEnvelope(createProfileEnvelope(alice, { name: '  Мама 👩  ', rev: 2 }), aliceId);
    expect(p.name).toBe('Мама 👩');
    expect(p.rev).toBe(2);
    expect(p.updated).toBeGreaterThan(0);
  });

  it('accepts 64 code points (including astral) and rejects 65', () => {
    const name64 = '😀'.repeat(64);
    expect(verifyProfileEnvelope(createProfileEnvelope(alice, { name: name64, rev: 0 }), aliceId).name).toBe(name64);
    expect(errorCode(() => createProfileEnvelope(alice, { name: 'a'.repeat(65), rev: 0 }))).toBe('invalid-argument');
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', { ...base(), name: 'a'.repeat(65) }), aliceId))).toBe(
      'malformed',
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['control character', 'a\u0007b'],
    ['newline', 'a\nb'],
    ['bidi override', 'a‮b'],
    ['unpaired surrogate', 'a\ud800b'],
  ])('rejects a %s name on create and verify', (_n, name) => {
    expect(errorCode(() => createProfileEnvelope(alice, { name, rev: 0 }))).toBe('invalid-argument');
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', { ...base(), name }), aliceId))).toBe('malformed');
  });

  it('rejects bad rev and updated on create', () => {
    expect(errorCode(() => createProfileEnvelope(alice, { name: 'a', rev: -1 }))).toBe('invalid-argument');
    expect(errorCode(() => createProfileEnvelope(alice, { name: 'a', rev: 0, updated: 1.5 }))).toBe('invalid-argument');
    expect(errorCode(() => createProfileEnvelope(alice, { name: 7 as unknown as string, rev: 0 }))).toBe('invalid-argument');
  });

  it('avatar: null or exactly {sha256, type}', () => {
    const sha256 = base64urlEncode(new Uint8Array(32).fill(1));
    const p = verifyProfileEnvelope(forge('profile', { ...base(), avatar: { sha256, type: 'image/webp' } }), aliceId);
    expect(p.avatar).toEqual({ sha256, type: 'image/webp' });
    const bad = (avatar: unknown) => errorCode(() => verifyProfileEnvelope(forge('profile', { ...base(), avatar }), aliceId));
    expect(bad('x')).toBe('malformed');
    expect(bad([])).toBe('malformed');
    expect(bad({ file: 'x' })).toBe('malformed');
    expect(bad({ sha256, type: 'image/png' })).toBe('malformed');
    expect(bad({ sha256: sha256.slice(1), type: 'image/jpeg' })).toBe('malformed');
    expect(bad({ sha256, type: 'image/jpeg', extra: 1 })).toBe('malformed');
    expect(bad({ sha256 })).toBe('malformed');
    expect(bad(undefined)).toBe('malformed');
  });

  it('creates a profile with an avatar in field order sha256, type', () => {
    const sha256 = base64urlEncode(new Uint8Array(32).fill(2));
    const env = createProfileEnvelope(alice, { name: 'A', rev: 1, updated: 5, avatar: { sha256, type: 'image/jpeg' } });
    expect(new TextDecoder().decode(base64urlDecode(env.payload))).toBe(
      `{"v":1,"userId":"${alice.userId}","name":"A","avatar":{"sha256":"${sha256}","type":"image/jpeg"},"rev":1,"updated":5}`,
    );
    expect(verifyProfileEnvelope(env, aliceId).avatar).toEqual({ sha256, type: 'image/jpeg' });
    expect(createProfileEnvelope(alice, { name: 'A', rev: 1, updated: 5, avatar: null }).payload).toBe(
      createProfileEnvelope(alice, { name: 'A', rev: 1, updated: 5 }).payload,
    );
    const bad = (avatar: unknown) =>
      errorCode(() => createProfileEnvelope(alice, { name: 'A', rev: 1, avatar: avatar as null }));
    expect(bad({ sha256, type: 'image/gif' })).toBe('invalid-argument');
    expect(bad({ sha256: 'x', type: 'image/jpeg' })).toBe('invalid-argument');
  });

  it('rejects missing fields, another user, and a forged signature', () => {
    const { rev: _rev, ...noRev } = base();
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', noRev), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', { ...base(), name: 5 }), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', base()), bobId))).toBe('user-id-mismatch');
    expect(errorCode(() => verifyProfileEnvelope(forge('profile', base(), bob), aliceId))).toBe('bad-signature');
  });
});

describe('auth envelope', () => {
  const devId = newDevId();
  const input = { serverId: 'srv', nonce: 'challenge-1', devId };

  it('round-trips and checks the expected server and nonce', () => {
    const env = createAuthEnvelope(alice, input);
    expect(verifyAuthEnvelope(env, aliceId, { serverId: 'srv', nonce: 'challenge-1' })).toMatchObject(input);
    expect(verifyAuthEnvelope(env, aliceId).nonce).toBe('challenge-1');
    expect(errorCode(() => verifyAuthEnvelope(env, aliceId, { serverId: 'srv', nonce: 'challenge-2' }))).toBe(
      'context-mismatch',
    );
    expect(errorCode(() => verifyAuthEnvelope(env, aliceId, { serverId: 'other', nonce: 'challenge-1' }))).toBe(
      'context-mismatch',
    );
    expect(errorCode(() => verifyAuthEnvelope(env, bobId))).toBe('user-id-mismatch');
  });

  it('rejects invalid inputs on create', () => {
    expect(errorCode(() => createAuthEnvelope(alice, { ...input, serverId: '' }))).toBe('invalid-argument');
    expect(errorCode(() => createAuthEnvelope(alice, { ...input, nonce: 'x'.repeat(257) }))).toBe('invalid-argument');
    expect(errorCode(() => createAuthEnvelope(alice, { ...input, devId: 'ABC' }))).toBe('invalid-argument');
  });

  it('rejects malformed fields on verify', () => {
    const base = { v: 1, userId: alice.userId, ...input };
    expect(errorCode(() => verifyAuthEnvelope(forge('auth', { ...base, devId: 'short' }), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyAuthEnvelope(forge('auth', { ...base, nonce: 3 }), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyAuthEnvelope(forge('auth', { ...base, serverId: '' }), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyAuthEnvelope(forge('auth', { ...base, userId: 7 }), aliceId))).toBe('malformed');
  });
});

describe('revocation envelope', () => {
  it('creates and verifies with field order v, userId, revokedAt', () => {
    const env = createRevocationEnvelope(alice, 1794787200000);
    expect(new TextDecoder().decode(base64urlDecode(env.payload))).toBe(
      `{"v":1,"userId":"${alice.userId}","revokedAt":1794787200000}`,
    );
    expect(verifyRevocationEnvelope(serializeEnvelope(env), aliceId)).toMatchObject({ userId: alice.userId, revokedAt: 1794787200000 });
    expect(createRevocationEnvelope(alice).payload).toBeTruthy();
  });

  it('rejects another user, a forged signature, bad fields and other kinds', () => {
    const env = createRevocationEnvelope(alice, 5);
    expect(errorCode(() => verifyRevocationEnvelope(env, bobId))).toBe('user-id-mismatch');
    expect(errorCode(() => verifyRevocationEnvelope(forge('revoked', { v: 1, userId: alice.userId, revokedAt: 5 }, bob), aliceId))).toBe(
      'bad-signature',
    );
    expect(errorCode(() => verifyRevocationEnvelope(forge('revoked', { v: 1, userId: alice.userId, revokedAt: -1 }), aliceId))).toBe(
      'malformed',
    );
    expect(errorCode(() => verifyRevocationEnvelope(forge('revoked', { v: 1, userId: 'x', revokedAt: 1 }), aliceId))).toBe('malformed');
    expect(errorCode(() => verifyRevocationEnvelope(forge('revoked', { v: 2, userId: alice.userId, revokedAt: 1 }), aliceId))).toBe(
      'unsupported-version',
    );
    // A profile signature is not a revocation signature (kind label).
    const asProfile = forge('profile', { v: 1, userId: alice.userId, revokedAt: 5 });
    expect(errorCode(() => verifyRevocationEnvelope(asProfile, aliceId))).toBe('bad-signature');
    expect(errorCode(() => createRevocationEnvelope(alice, 1.5))).toBe('invalid-argument');
  });

  it('group states get a larger payload limit than other envelopes', () => {
    expect(maxPayloadBytes('group-state')).toBe(65536);
    expect(maxPayloadBytes('revoked')).toBe(8192);
    const big = forge('revoked', { v: 1, userId: alice.userId, revokedAt: 1, pad: 'x'.repeat(8200) });
    expect(errorCode(() => verifyRevocationEnvelope(big, aliceId))).toBe('too-large');
  });
});
