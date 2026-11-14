import { describe, expect, it } from 'vitest';
import { deriveDmKeys, deriveEncKey, dmChatId } from '../src/dm.ts';
import { deriveIdentityKeys, type IdentityKeys } from '../src/keys.ts';
import { newSeed } from '../src/random.ts';
import { errorCode, hex, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const v = loadVector('dm.json');
const keys: Record<string, IdentityKeys> = Object.fromEntries(
  Object.entries(ids.users).map(([n, u]) => [n, deriveIdentityKeys(unhex((u as { seedHex: string }).seedHex))]),
);

describe('direct-chat keys', () => {
  it.each(v.chats as { me: string; peer: string; serverId: string; dmKeyHex: string; encKeyHex: string; chatId: string }[])(
    'vector $me-$peer on $serverId',
    (c) => {
      const me = keys[c.me]!;
      const peer = keys[c.peer]!;
      const a = deriveDmKeys(me, peer, c.serverId);
      const b = deriveDmKeys(peer, me, c.serverId);
      expect(hex(a.dmKey)).toBe(c.dmKeyHex);
      expect(hex(b.dmKey)).toBe(c.dmKeyHex);
      expect(hex(a.encKey)).toBe(c.encKeyHex);
      expect(hex(deriveEncKey(a.dmKey))).toBe(c.encKeyHex);
      expect(a.epoch).toBe(0);
      expect(dmChatId(c.serverId, me.userId, peer.userId)).toBe(c.chatId);
      expect(dmChatId(c.serverId, peer.userId, me.userId)).toBe(c.chatId);
    },
  );

  it('differs per server and per pair', () => {
    const [ab, abOther, bc] = [v.chats[0], v.chats[2], v.chats[3]];
    expect(ab.dmKeyHex).not.toBe(abOther.dmKeyHex);
    expect(ab.chatId).not.toBe(abOther.chatId);
    expect(ab.dmKeyHex).not.toBe(bc.dmKeyHex);
  });

  it('the chat with yourself works', () => {
    const k = deriveIdentityKeys(newSeed());
    const self = deriveDmKeys(k, k, 'srv');
    expect(self.dmKey).toHaveLength(32);
    expect(dmChatId('srv', k.userId, k.userId)).toMatch(/^[a-z2-7]{26}$/);
  });

  it('rejects the all-zero shared secret and low-order points', () => {
    const alice = keys.alice!;
    const zero = unhex(v.zeroPeer.peerBoxPubHex);
    expect(errorCode(() => deriveDmKeys(alice, { userId: keys.bob!.userId, boxPub: zero }, 'srv'))).toBe(
      v.zeroPeer.expectedError,
    );
    const one = new Uint8Array(32);
    one[0] = 1; // u = 1, order 4
    expect(errorCode(() => deriveDmKeys(alice, { userId: keys.bob!.userId, boxPub: one }, 'srv'))).toBe('invalid-key');
  });

  it('rejects malformed arguments', () => {
    const alice = keys.alice!;
    const bob = keys.bob!;
    expect(errorCode(() => deriveDmKeys(alice, { userId: bob.userId, boxPub: new Uint8Array(31) }, 'srv'))).toBe(
      'invalid-key',
    );
    expect(errorCode(() => deriveDmKeys(alice, { userId: 'nope', boxPub: bob.boxPub }, 'srv'))).toBe('invalid-argument');
    expect(errorCode(() => deriveDmKeys(alice, bob, ''))).toBe('invalid-argument');
    expect(errorCode(() => dmChatId('srv', alice.userId, 'x'))).toBe('invalid-argument');
    expect(errorCode(() => dmChatId('', alice.userId, bob.userId))).toBe('invalid-argument');
  });
});
