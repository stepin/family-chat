import { describe, expect, it } from 'vitest';
import { isValidPhrase, normalizePhrase, phraseToSeed, seedToPhrase } from '../src/phrase.ts';
import { checkSignPub, deriveIdentityKeys, userIdFromSignPub, verify, sign } from '../src/keys.ts';
import { fingerprint } from '../src/fingerprint.ts';
import { ProtocolError } from '../src/errors.ts';
import { newSeed } from '../src/random.ts';
import { errorCode, hex, loadVector, unhex } from './helpers.ts';

const v = loadVector('identity.json');
const neg = loadVector('negative.json');

describe('recovery phrase', () => {
  it.each(v.phrases as { seedHex: string; phrase: string }[])('matches vector $phrase', ({ seedHex, phrase }) => {
    expect(seedToPhrase(unhex(seedHex))).toBe(phrase);
    expect(hex(phraseToSeed(phrase))).toBe(seedHex);
  });

  it('encodes the BIP39 known answers for 256-bit entropy', () => {
    expect(seedToPhrase(new Uint8Array(32))).toBe('abandon '.repeat(23) + 'art');
    expect(seedToPhrase(new Uint8Array(32).fill(0xff))).toBe('zoo '.repeat(23) + 'vote');
  });

  it('round-trips random seeds and has 24 words', () => {
    for (let i = 0; i < 20; i++) {
      const seed = newSeed();
      const phrase = seedToPhrase(seed);
      expect(phrase.split(' ')).toHaveLength(24);
      expect(hex(phraseToSeed(phrase))).toBe(hex(seed));
    }
  });

  it('accepts pasted input with capitals, line breaks and extra spaces', () => {
    const phrase = v.phrases[2].phrase as string;
    const messy = `  ${phrase.toUpperCase().split(' ').join('\n\t  ')}  `;
    expect(normalizePhrase(messy).join(' ')).toBe(phrase);
    expect(hex(phraseToSeed(messy))).toBe(v.phrases[2].seedHex);
    expect(isValidPhrase(messy)).toBe(true);
  });

  it.each(neg.phrases as { name: string; phrase: string; expectedError: string; positions?: number[] }[])(
    'negative vector: $name',
    (c) => {
      expect(errorCode(() => phraseToSeed(c.phrase))).toBe(c.expectedError);
      expect(isValidPhrase(c.phrase)).toBe(false);
      if (c.positions) {
        try {
          phraseToSeed(c.phrase);
        } catch (e) {
          expect((e as ProtocolError).positions).toEqual(c.positions);
        }
      }
    },
  );

  it('reports every unknown word position and never echoes the words', () => {
    const words = (v.phrases[2].phrase as string).split(' ');
    words[0] = 'secretish';
    words[9] = 'hunter';
    try {
      phraseToSeed(words.join(' '));
      expect.unreachable();
    } catch (e) {
      const err = e as ProtocolError;
      expect(err.code).toBe('phrase-unknown-word');
      expect(err.positions).toEqual([1, 10]);
      expect(err.message).not.toContain('secretish');
      expect(err.message).not.toContain('hunter');
      expect(err.message).not.toContain(words[1]);
    }
  });

  it('checksum error message carries no words', () => {
    const c = neg.phrases.find((p: { expectedError: string }) => p.expectedError === 'phrase-checksum');
    try {
      phraseToSeed(c.phrase);
      expect.unreachable();
    } catch (e) {
      for (const w of (c.phrase as string).split(' ')) expect((e as Error).message.split(/\W+/)).not.toContain(w);
    }
  });

  it('rejects wrong word counts and wrong input types', () => {
    expect(errorCode(() => phraseToSeed(''))).toBe('phrase-word-count');
    expect(errorCode(() => phraseToSeed(`${v.phrases[2].phrase} abandon`))).toBe('phrase-word-count');
    expect(errorCode(() => phraseToSeed(12 as unknown as string))).toBe('invalid-argument');
    expect(errorCode(() => seedToPhrase(new Uint8Array(16)))).toBe('invalid-argument');
  });
});

describe('identity keys', () => {
  for (const [name, u] of Object.entries(v.users) as [string, Record<string, string>][]) {
    it(`derives ${name}'s keys, userId and fingerprint from the seed`, () => {
      const k = deriveIdentityKeys(unhex(u.seedHex!));
      expect(hex(k.signSecret)).toBe(u.signSecretHex);
      expect(hex(k.signPub)).toBe(u.signPubHex);
      expect(hex(k.boxSecret)).toBe(u.boxSecretHex);
      expect(hex(k.boxPub)).toBe(u.boxPubHex);
      expect(hex(k.selfKey)).toBe(u.selfKeyHex);
      expect(k.userId).toBe(u.userId);
      expect(userIdFromSignPub(k.signPub)).toBe(u.userId);
      expect(fingerprint(k)).toBe(u.fingerprint);
      expect(seedToPhrase(unhex(u.seedHex!))).toBe(u.phrase);
    });
  }

  it('userId is 26 lowercase base32 characters', () => {
    const k = deriveIdentityKeys(newSeed());
    expect(k.userId).toMatch(/^[a-z2-7]{26}$/);
  });

  it('rejects seeds of the wrong size', () => {
    expect(errorCode(() => deriveIdentityKeys(new Uint8Array(31)))).toBe('invalid-argument');
    expect(errorCode(() => deriveIdentityKeys('x' as unknown as Uint8Array))).toBe('invalid-argument');
    expect(errorCode(() => userIdFromSignPub(new Uint8Array(31)))).toBe('invalid-argument');
  });

  it('signs and verifies; rejects altered messages and malformed signatures', () => {
    const k = deriveIdentityKeys(newSeed());
    const msg = Uint8Array.of(1, 2, 3);
    const sig = sign(msg, k.signSecret);
    expect(verify(sig, msg, k.signPub)).toBe(true);
    expect(verify(sig, Uint8Array.of(1, 2, 4), k.signPub)).toBe(false);
    expect(verify(sig.subarray(1), msg, k.signPub)).toBe(false);
    expect(verify(sig, msg, new Uint8Array(3))).toBe(false);
  });

  it('rejects small-order and invalid Ed25519 public keys', () => {
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1; // the neutral element, order 1
    expect(errorCode(() => checkSignPub(identityPoint))).toBe('invalid-key');
    expect(errorCode(() => checkSignPub(new Uint8Array(31)))).toBe('invalid-key');
    expect(errorCode(() => checkSignPub(new Uint8Array(32).fill(0xff)))).toBe('invalid-key');
    expect(errorCode(() => checkSignPub(deriveIdentityKeys(newSeed()).signPub))).toBe('ok');
  });

  it('fingerprint is 6 groups of 5 digits and differs between people', () => {
    const a = fingerprint(deriveIdentityKeys(newSeed()));
    const b = fingerprint(deriveIdentityKeys(newSeed()));
    expect(a).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(a).not.toBe(b);
  });
});
