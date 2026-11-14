import { createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  HPKE_AEAD_AES128GCM,
  HPKE_AEAD_AES256GCM,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSeal,
  hpkeSetupRecipient,
  hpkeSetupSender,
  type HpkeAead,
} from '../src/hpke.ts';
import { asyncErrorCode, errorCode, hex, loadVector, unhex } from './helpers.ts';

const kat = loadVector('hpke-rfc9180.json');

/** SHAKE128 of the empty string, read as a stream (prefix of a long output). */
function shakeStream(): (n: number) => Uint8Array {
  const buf = new Uint8Array(createHash('shake128', { outputLength: 600_000 }).digest());
  let off = 0;
  return (n) => {
    const out = buf.subarray(off, off + n);
    off += n;
    if (out.length !== n) throw new Error('shake stream exhausted');
    return out;
  };
}

describe('HPKE: RFC 9180 known answers', () => {
  for (const v of kat.vectors) {
    it(`mode ${v.mode} kem ${v.kem_id} kdf ${v.kdf_id} aead ${v.aead_id}`, async () => {
      const aead = v.aead_id as HpkeAead;
      const r = hpkeDeriveKeyPair(unhex(v.ikmR));
      expect(hex(r.secretKey)).toBe(v.skRm);
      expect(hex(r.publicKey)).toBe(v.pkRm);
      const info = unhex(v.info);
      const sender = hpkeSetupSender(unhex(v.pkRm), info, { aead, ikmE: unhex(v.ikmE) });
      expect(hex(sender.enc)).toBe(v.enc);
      const recipient = hpkeSetupRecipient(sender.enc, unhex(v.skRm), info, { aead });

      const draw = shakeStream();
      const sink = createHash('shake128', { outputLength: 16 });
      for (let i = 0; i < 1000; i++) {
        const aad = draw(draw(1)[0] as number);
        const pt = draw(draw(1)[0] as number);
        const ct = await sender.context.seal(aad, pt);
        sink.update(ct);
        expect(hex(await recipient.open(aad, ct))).toBe(hex(pt));
      }
      expect(sink.digest('hex')).toBe(v.encryptions_accumulated);

      const draw2 = shakeStream();
      const sink2 = createHash('shake128', { outputLength: 16 });
      for (let l = 0; l < 1000; l++) {
        const ctx = draw2(draw2(1)[0] as number);
        const value = sender.context.export(ctx, l);
        expect(hex(recipient.export(ctx, l))).toBe(hex(value));
        sink2.update(value);
      }
      expect(sink2.digest('hex')).toBe(v.exports_accumulated);
    });
  }

  it('covers both AEADs', () => {
    expect(kat.vectors.map((v: { aead_id: number }) => v.aead_id).sort()).toEqual([HPKE_AEAD_AES128GCM, HPKE_AEAD_AES256GCM]);
  });
});

describe('HPKE: single shot and failures', () => {
  const r = hpkeDeriveKeyPair(new Uint8Array(32).fill(7));
  const info = new TextEncoder().encode('info');

  it('seals and opens with random ephemeral keys', async () => {
    const a = await hpkeSeal(r.publicKey, info, new Uint8Array(0), Uint8Array.of(1, 2, 3));
    const b = await hpkeSeal(r.publicKey, info, new Uint8Array(0), Uint8Array.of(1, 2, 3));
    expect(hex(a.enc)).not.toBe(hex(b.enc));
    expect(hex(await hpkeOpen(a.enc, r.secretKey, info, new Uint8Array(0), a.ciphertext))).toBe('010203');
  });

  it('fails with another info, aad, key or a modified ciphertext', async () => {
    const s = await hpkeSeal(r.publicKey, info, Uint8Array.of(9), Uint8Array.of(1));
    const other = hpkeDeriveKeyPair(new Uint8Array(32).fill(8));
    expect(await asyncErrorCode(hpkeOpen(s.enc, r.secretKey, Uint8Array.of(0), Uint8Array.of(9), s.ciphertext))).toBe('wrong-key');
    expect(await asyncErrorCode(hpkeOpen(s.enc, r.secretKey, info, Uint8Array.of(8), s.ciphertext))).toBe('wrong-key');
    expect(await asyncErrorCode(hpkeOpen(s.enc, other.secretKey, info, Uint8Array.of(9), s.ciphertext))).toBe('wrong-key');
    const bad = new Uint8Array(s.ciphertext);
    bad[0] = (bad[0] as number) ^ 1;
    expect(await asyncErrorCode(hpkeOpen(s.enc, r.secretKey, info, Uint8Array.of(9), bad))).toBe('wrong-key');
    expect(await asyncErrorCode(hpkeOpen(s.enc, r.secretKey, info, Uint8Array.of(9), new Uint8Array(3)))).toBe('wrong-key');
  });

  it('rejects low-order and malformed keys', async () => {
    expect(errorCode(() => hpkeSetupSender(new Uint8Array(32), info))).toBe('invalid-key');
    expect(errorCode(() => hpkeSetupSender(new Uint8Array(31), info))).toBe('invalid-key');
    expect(errorCode(() => hpkeSetupRecipient(new Uint8Array(32), r.secretKey, info))).toBe('invalid-key');
    expect(errorCode(() => hpkeSetupRecipient(r.publicKey, new Uint8Array(3), info))).toBe('invalid-argument');
    expect(errorCode(() => hpkeSetupSender(r.publicKey, info).context.export(info, -1))).toBe('invalid-argument');
  });

  it('recipient public key is X25519(skR)', () => {
    expect(hex(r.publicKey)).toBe(hex(x25519.getPublicKey(r.secretKey)));
  });
});
