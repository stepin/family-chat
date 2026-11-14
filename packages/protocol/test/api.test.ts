import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.ts';

describe('public API', () => {
  it('exports exactly the documented runtime names', () => {
    const functions = Object.entries(api)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(
      [
        'ProtocolError',
        'base32Decode',
        'base32Encode',
        'base64urlDecode',
        'base64urlEncode',
        'createAuthEnvelope',
        'createIdentityEnvelope',
        'createProfileEnvelope',
        'decodeEvent',
        'decodePayload',
        'deriveDmKeys',
        'deriveIdentityKeys',
        'dmChatId',
        'encodeEvent',
        'encodeMsgPayload',
        'fingerprint',
        'isProtocolError',
        'isValidPhrase',
        'newDevId',
        'newMessageId',
        'newSeed',
        'parseEnvelope',
        'phraseToSeed',
        'randomBytes',
        'seedToPhrase',
        'serializeEnvelope',
        'userIdFromSignPub',
        'verifyAuthEnvelope',
        'verifyIdentityEnvelope',
        'verifyProfileEnvelope',
      ].sort(),
    );
    expect('encodeEventWithNonce' in api).toBe(false);
  });

  it('exports the limits', () => {
    expect(api.MAX_BODY_BYTES).toBe(16384);
    expect(api.MAX_EVENT_BYTES).toBe(262144);
    expect(api.MAX_NAME_CHARS).toBe(64);
    expect(api.MAX_PAYLOAD_BYTES).toBe(261804);
    expect(api.DM_EPOCH).toBe(0);
  });

  it('package.json exposes only the entry point', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@noble/curves', '@noble/hashes', '@scure/bip39']);
  });

  it('isProtocolError narrows by code', () => {
    const e = new api.ProtocolError('wrong-chat', 'x');
    expect(api.isProtocolError(e)).toBe(true);
    expect(api.isProtocolError(e, 'wrong-chat')).toBe(true);
    expect(api.isProtocolError(e, 'wrong-key')).toBe(false);
    expect(api.isProtocolError(new Error('x'))).toBe(false);
    expect(e.name).toBe('ProtocolError');
  });

  it('end to end: phrase, identity, DM, event', async () => {
    const seedA = api.newSeed();
    const restored = api.phraseToSeed(api.seedToPhrase(seedA));
    const a = api.deriveIdentityKeys(restored);
    const b = api.deriveIdentityKeys(api.newSeed());
    const idA = api.verifyIdentityEnvelope(api.serializeEnvelope(api.createIdentityEnvelope(a)));
    const idB = api.verifyIdentityEnvelope(api.createIdentityEnvelope(b));
    const serverId = 'home';
    const chatId = api.dmChatId(serverId, a.userId, b.userId);
    const id = api.newMessageId();
    const body = await api.encodeEvent({
      serverId,
      chatId,
      chat: api.deriveDmKeys(a, idB, serverId),
      author: a,
      payload: api.encodeMsgPayload({ id, dev: api.newDevId(), seq: 1, body: 'привет' }),
    });
    const e = await api.decodeEvent(body, {
      serverId,
      chatId,
      chat: api.deriveDmKeys(b, idA, serverId),
      lookupAuthor: (u) => [idA, idB].find((i) => i.userId === u),
    });
    expect(e.msgId).toBe(id);
    expect(e.payload.kind === 'msg' && e.payload.msg.body).toBe('привет');
  });
});
