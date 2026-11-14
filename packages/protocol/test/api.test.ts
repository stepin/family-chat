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
        'acceptGroupKey',
        'addGroupMembers',
        'base32Decode',
        'base32Encode',
        'base64urlDecode',
        'base64urlEncode',
        'blobPartCount',
        'blobPartLength',
        'checkAttachmentInput',
        'compareGroupMembers',
        'createArchiveReader',
        'createArchiveWriter',
        'createAuthEnvelope',
        'createGroup',
        'createIdentityEnvelope',
        'createProfileEnvelope',
        'createRevocationEnvelope',
        'decodeEvent',
        'decodePayload',
        'decryptBlobPart',
        'deriveDmKeys',
        'deriveGroupKeys',
        'deriveIdentityKeys',
        'dmChatId',
        'encodeDeletePayload',
        'encodeEditPayload',
        'encodeEvent',
        'encodeMsgPayload',
        'encodeReactPayload',
        'encryptBlobPart',
        'encryptGroupState',
        'fingerprint',
        'groupChatId',
        'groupStateActions',
        'isProtocolError',
        'isValidPhrase',
        'newBlob',
        'newDevId',
        'newEpochSecret',
        'newGroupNonce',
        'newMessageId',
        'newSeed',
        'openGroupKey',
        'openGroupState',
        'parseEnvelope',
        'parsePayload',
        'parseSealedGroupKey',
        'payloadCommon',
        'phraseToSeed',
        'randomBytes',
        'readArchive',
        'readGroupKey',
        'readGroupStateHeader',
        'removeGroupMembers',
        'renameGroup',
        'sealGroupKey',
        'seedToPhrase',
        'serializeEnvelope',
        'transferGroupOwnership',
        'userIdFromSignPub',
        'validateAttachment',
        'verifyAuthEnvelope',
        'verifyGroupKey',
        'verifyGroupState',
        'verifyIdentityEnvelope',
        'verifyProfileEnvelope',
        'verifyRevocationEnvelope',
      ].sort(),
    );
    for (const internal of [
      'encodeEventWithNonce',
      'encryptGroupStateWithNonce',
      'sealGroupKeyWith',
      'createGroupWith',
      'createArchiveWriterWithSalt',
      'hpkeSeal',
    ]) {
      expect(internal in api).toBe(false);
    }
  });

  it('exports the limits', () => {
    expect(api.MAX_BODY_BYTES).toBe(16384);
    expect(api.MAX_EVENT_BYTES).toBe(262144);
    expect(api.MAX_NAME_CHARS).toBe(64);
    expect(api.MAX_PAYLOAD_BYTES).toBe(261804);
    expect(api.DM_EPOCH).toBe(0);
    expect(api.BLOB_PART_SIZE).toBe(4 * 1024 * 1024);
    expect(api.ARCHIVE_BLOCK_SIZE).toBe(1024 * 1024);
    expect(api.MAX_ATTACHMENTS).toBe(10);
    expect(api.MAX_THUMB_BYTES).toBe(4096);
    expect(api.VOICE_PEAKS).toBe(64);
    expect(api.ARCHIVE_HEADER_BYTES).toBe(36);
    expect(api.IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(api.VOICE_TYPES).toEqual(['audio/mp4', 'audio/webm', 'audio/ogg']);
  });

  it('package.json exposes only the entry point', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@noble/curves', '@noble/hashes', '@scure/bip39']);
  });

  it('parseSealedGroupKey reads the stored key text', () => {
    expect(api.parseSealedGroupKey('{"a":1}')).toEqual({ a: 1 });
    expect(() => api.parseSealedGroupKey('{not json')).toThrow(api.ProtocolError);
    try {
      api.parseSealedGroupKey('');
    } catch (e) {
      expect(api.isProtocolError(e, 'malformed')).toBe(true);
    }
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
