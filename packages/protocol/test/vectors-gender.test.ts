// The gender vector file agrees with the code: profiles with and without `gender` are reproduced
// byte for byte, and wrong values are rejected as malformed.

import { describe, expect, it } from 'vitest';
import { createProfileEnvelope, serializeEnvelope, verifyIdentityEnvelope, verifyProfileEnvelope, createIdentityEnvelope } from '../src/envelope.ts';
import { deriveIdentityKeys } from '../src/keys.ts';
import { errorCode, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const pg = loadVector('profile-gender.json');
const alice = deriveIdentityKeys(unhex(ids.users.alice.seedHex));
const aliceId = verifyIdentityEnvelope(createIdentityEnvelope(alice, 1));

describe('profile-gender.json', () => {
  it('reproduces and verifies every profile', () => {
    for (const p of pg.profiles) {
      const json = JSON.parse(p.payloadText);
      const env = createProfileEnvelope(alice, { name: json.name, rev: json.rev, updated: json.updated, ...(json.gender ? { gender: json.gender } : {}) });
      expect(serializeEnvelope(env), p.name).toBe(p.envelope);
      expect(verifyProfileEnvelope(JSON.parse(p.envelope), aliceId).gender, p.name).toBe(p.gender);
    }
  });

  it('rejects wrong values', () => {
    for (const c of pg.negative) expect(errorCode(() => verifyProfileEnvelope(c.envelope, aliceId)), c.name).toBe(c.expectedError);
  });

  it('refuses to create a profile with another value', () => {
    expect(errorCode(() => createProfileEnvelope(alice, { name: 'a', rev: 0, gender: 'x' as 'm' }))).toBe('invalid-argument');
  });
});
