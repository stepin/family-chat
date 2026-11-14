import { describe, expect, it, vi } from 'vitest';
import { base32Decode, base32Encode, base64urlDecode, base64urlEncode } from '../src/codec.ts';
import { concat, equalBytes, fromUtf8, isAllZero, lp, readU32be, u32be, utf8 } from '../src/bytes.ts';
import { newDevId, newMessageId, newSeed, randomBytes } from '../src/random.ts';
import { errorCode, hex } from './helpers.ts';

const ascii = (s: string) => utf8(s);

describe('base32 (RFC 4648 alphabet, lowercase, no padding)', () => {
  // RFC 4648 section 10 test vectors, lowercased and without padding.
  const cases: [string, string][] = [
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ];
  it.each(cases)('encodes and decodes %j', (plain, encoded) => {
    expect(base32Encode(ascii(plain))).toBe(encoded);
    expect(fromUtf8(base32Decode(encoded))).toBe(plain);
  });

  it('round-trips random lengths', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n);
      expect(hex(base32Decode(base32Encode(b)))).toBe(hex(b));
    }
  });

  it.each(['MZXW6', 'mzxw6=', 'mzxw1', 'mzx', 'm', 'mz', 'mzxw6ytbo', 'mzxw é'])('rejects %j', (s) => {
    expect(errorCode(() => base32Decode(s))).toBe('malformed');
  });

  it('rejects non-zero trailing bits', () => {
    expect(errorCode(() => base32Decode('mz'))).toBe('malformed'); // 'f' would be 'my'
  });

  it('rejects non-strings', () => {
    expect(errorCode(() => base32Decode(42 as unknown as string))).toBe('malformed');
  });
});

describe('base64url (no padding)', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ];
  it.each(cases)('encodes and decodes %j', (plain, encoded) => {
    expect(base64urlEncode(ascii(plain))).toBe(encoded);
    expect(fromUtf8(base64urlDecode(encoded))).toBe(plain);
  });

  it('uses the URL-safe alphabet', () => {
    expect(base64urlEncode(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
    expect(hex(base64urlDecode('-_8'))).toBe('fbff');
  });

  it('matches Buffer for random data', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n);
      expect(base64urlEncode(b)).toBe(Buffer.from(b).toString('base64url'));
      expect(hex(base64urlDecode(base64urlEncode(b)))).toBe(hex(b));
    }
  });

  it.each(['Zg==', 'Zm9v+', 'Zm9v/', 'Z', 'Zh', 'Zm9vY', 'Zm 9v'])('rejects %j', (s) => {
    expect(errorCode(() => base64urlDecode(s))).toBe('malformed');
  });
});

describe('byte helpers', () => {
  it('length-prefixes with u32 big-endian', () => {
    expect(hex(lp('ab'))).toBe('000000026162');
    expect(hex(lp(Uint8Array.of(1, 2, 3)))).toBe('00000003010203');
    expect(hex(u32be(0x01020304))).toBe('01020304');
    expect(readU32be(concat(Uint8Array.of(9), u32be(77)), 1)).toBe(77);
    expect(() => u32be(-1)).toThrow(RangeError);
    expect(() => u32be(2 ** 32)).toThrow(RangeError);
  });

  it('compares and inspects bytes', () => {
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(isAllZero(new Uint8Array(5))).toBe(true);
    expect(isAllZero(Uint8Array.of(0, 1))).toBe(false);
  });

  it('decodes UTF-8 strictly and keeps a BOM', () => {
    expect(fromUtf8(Uint8Array.of(0xff))).toBeUndefined();
    expect(fromUtf8(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41))).toBe('﻿A');
  });
});

describe('random identifiers', () => {
  it('devId is 16 base32 characters of 10 bytes', () => {
    const id = newDevId();
    expect(id).toMatch(/^[a-z2-7]{16}$/);
    expect(base32Decode(id)).toHaveLength(10);
  });

  it('message id is 26 base32 characters of 16 bytes', () => {
    const id = newMessageId();
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    expect(base32Decode(id)).toHaveLength(16);
  });

  it('seeds are 32 bytes and distinct', () => {
    expect(newSeed()).toHaveLength(32);
    expect(hex(newSeed())).not.toBe(hex(newSeed()));
    const ids = new Set(Array.from({ length: 200 }, newMessageId));
    expect(ids.size).toBe(200);
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    newDevId();
    newMessageId();
    newSeed();
    randomBytes(16);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects invalid lengths', () => {
    expect(() => randomBytes(-1)).toThrow(RangeError);
    expect(() => randomBytes(1.5)).toThrow(RangeError);
    expect(randomBytes(0)).toHaveLength(0);
  });
});
