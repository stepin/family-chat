// Sticker packs: the manifest envelope, file names, the sticker message and the vectors.

import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import { base64urlDecode } from '../src/codec.ts';
import { createIdentityEnvelope, verifyIdentityEnvelope } from '../src/envelope.ts';
import { deriveIdentityKeys } from '../src/keys.ts';
import { encodeMsgPayload, parsePayload } from '../src/payload.ts';
import {
  createStickerPackEnvelope,
  MAX_PACK_STICKERS,
  readStickerPackHeader,
  stickerFileHash,
  stickerFileMatches,
  verifyStickerPackEnvelope,
  type PackSticker,
} from '../src/sticker.ts';
import { errorCode, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const sv = loadVector('stickers.json');
const alice = deriveIdentityKeys(unhex(ids.users.alice.seedHex));
const bob = deriveIdentityKeys(unhex(ids.users.bob.seedHex));
const aliceId = verifyIdentityEnvelope(createIdentityEnvelope(alice, 1));
const bobId = verifyIdentityEnvelope(createIdentityEnvelope(bob, 1));
const serverId: string = sv.serverId;
const packId = 'mfrggzdfmztwq2lknnwg23tpoa';

function sticker(n: number, over: Partial<PackSticker> = {}): PackSticker {
  const bytes = utf8(`file ${n}`);
  return { file: stickerFileHash(bytes), type: 'webp', size: 1000 + n, emoji: '😺', w: 512, h: 512, ...over };
}

describe('stickers.json', () => {
  it('reproduces the manifest byte for byte and verifies it', () => {
    const files = sv.files.map((f: { bytesHex: string }) => unhex(f.bytesHex));
    expect(files.map((f: Uint8Array) => stickerFileHash(f))).toEqual(sv.files.map((f: { hash32: string }) => f.hash32));
    const p = verifyStickerPackEnvelope(sv.manifest.envelope, aliceId, { serverId, packId });
    expect(p.name).toBe('Котики');
    expect(p.author).toBe(alice.userId);
    expect(p.stickers.map((s) => s.file)).toEqual(sv.files.map((f: { hash32: string }) => f.hash32));
    expect(new TextDecoder().decode(base64urlDecode(p.envelope.payload))).toBe(sv.manifest.payloadText);
    const again = createStickerPackEnvelope(alice, { packId, serverId, name: 'Котики', created: 1767225600000, stickers: p.stickers });
    expect(JSON.stringify(again)).toBe(sv.manifest.envelope);
    for (const [i, f] of files.entries()) expect(stickerFileMatches(f, p.stickers[i]!)).toBe(true);
    expect(stickerFileMatches(utf8('other'), p.stickers[0]!)).toBe(false);
  });

  it('negative manifests fail with the documented error', () => {
    for (const c of sv.negativeManifests) {
      expect([c.name, errorCode(() => verifyStickerPackEnvelope(c.envelope, aliceId, { serverId }))]).toEqual([c.name, c.expectedError]);
    }
  });

  it('the sticker message and its negative cases', () => {
    const p = parsePayload(utf8(sv.message.text));
    expect(p.kind).toBe('msg');
    if (p.kind !== 'msg') return;
    expect(p.msg.body).toBe(sv.message.fallbackBody);
    expect(p.msg.sticker).toEqual({ pack: packId, file: sv.files[0].hash32, type: 'webp', w: 512, h: 512 });
    for (const c of sv.negativeMessages) {
      expect([c.name, errorCode(() => parsePayload(utf8(c.text)))]).toEqual([c.name, c.expectedError]);
    }
  });
});

describe('sticker-pack envelope', () => {
  it('checks author, server and pack id', () => {
    const env = createStickerPackEnvelope(alice, { packId, serverId, name: 'Набор', created: 5, stickers: [sticker(1)] });
    expect(readStickerPackHeader(env)).toEqual({ packId, author: alice.userId });
    expect(errorCode(() => verifyStickerPackEnvelope(env, bobId, { serverId }))).toBe('user-id-mismatch');
    expect(errorCode(() => verifyStickerPackEnvelope(env, aliceId, { serverId: 'other' }))).toBe('wrong-server');
    expect(errorCode(() => verifyStickerPackEnvelope(env, aliceId, { serverId, packId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }))).toBe('context-mismatch');
    expect(errorCode(() => verifyStickerPackEnvelope(env, aliceId, { serverId, packId }))).toBe('ok');
  });

  it('refuses bad input when signing', () => {
    const make = (over: object) => () =>
      createStickerPackEnvelope(alice, { packId, serverId, name: 'Набор', created: 5, stickers: [sticker(1)], ...over });
    expect(errorCode(make({ name: ' ' }))).toBe('invalid-argument');
    expect(errorCode(make({ name: 'я'.repeat(65) }))).toBe('invalid-argument');
    expect(errorCode(make({ packId: 'x' }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1), sticker(1)] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1, { type: 'gif' as never })] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1, { type: 'tgs', size: 128 * 1024 + 1 })] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1, { emoji: 'a‮b' })] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1, { w: 0 })] }))).toBe('invalid-argument');
    expect(errorCode(make({ stickers: [sticker(1, { h: 1025 })] }))).toBe('invalid-argument');
    const many = Array.from({ length: MAX_PACK_STICKERS + 1 }, (_, i) => sticker(i, { size: 10 }));
    expect(errorCode(make({ stickers: many }))).toBe('invalid-argument');
    const full = Array.from({ length: MAX_PACK_STICKERS }, (_, i) => sticker(i, { size: 100 + i }));
    expect(errorCode(make({ stickers: full }))).toBe('ok');
  });
});

describe('sticker message', () => {
  const ref = { pack: packId, file: stickerFileHash(utf8('x')), type: 'tgs' as const, w: 512, h: 400 };
  const base = { id: 'aebagbafaydqqcikbmga2dqpca', dev: 'mfrggzdfmztwq2lk', seq: 1 };

  it('round trips, with the emoji as body', () => {
    const bytes = encodeMsgPayload({ ...base, body: '🎉', sticker: ref });
    const p = parsePayload(bytes);
    expect(p.kind === 'msg' && p.msg.sticker).toEqual(ref);
    expect(p.kind === 'msg' && p.msg.body).toBe('🎉');
  });

  it('needs an emoji body and no attachments or place', () => {
    expect(errorCode(() => encodeMsgPayload({ ...base, sticker: ref }))).toBe('invalid-argument');
    expect(errorCode(() => encodeMsgPayload({ ...base, body: 'привет, как дела у тебя', sticker: ref }))).toBe('invalid-argument');
    expect(errorCode(() => encodeMsgPayload({ ...base, body: '🎉', sticker: ref, location: { lat: 1, lon: 1, accuracy: 1 } }))).toBe(
      'invalid-argument',
    );
    expect(errorCode(() => encodeMsgPayload({ ...base, body: '🎉', sticker: { ...ref, file: 'x' } }))).toBe('invalid-argument');
  });

  it('a client that ignores the field sees a plain emoji message', () => {
    // Unknown fields of a msg are ignored: an unknown one is still accepted.
    const p = parsePayload(utf8(JSON.stringify({ v: 1, t: 'msg', ...base, body: '🎉', future: { anything: 1 } })));
    expect(p.kind === 'msg' && p.msg.body).toBe('🎉');
  });
});
