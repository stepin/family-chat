import { describe, expect, it } from 'vitest';
import {
  decodeEvent,
  encodeEvent,
  encodeEventWithNonce,
  eventAad,
  eventHeader,
  eventSigningInput,
  MAX_PAYLOAD_BYTES,
  type EventContext,
} from '../src/event.ts';
import { concat, u32be, utf8 } from '../src/bytes.ts';
import { base32Decode } from '../src/codec.ts';
import { MAX_EVENT_BYTES } from '../src/constants.ts';
import { deriveDmKeys, dmChatId } from '../src/dm.ts';
import { createIdentityEnvelope, verifyIdentityEnvelope, type Identity } from '../src/envelope.ts';
import { deriveIdentityKeys, sign, type IdentityKeys } from '../src/keys.ts';
import { encodeMsgPayload } from '../src/payload.ts';
import { newDevId, newMessageId } from '../src/random.ts';
import { asyncErrorCode, hex, loadVector, unhex } from './helpers.ts';

const ids = loadVector('identity.json');
const v = loadVector('event.json');
const neg = loadVector('negative.json');

const keys: Record<string, IdentityKeys> = Object.fromEntries(
  Object.entries(ids.users).map(([n, u]) => [n, deriveIdentityKeys(unhex((u as { seedHex: string }).seedHex))]),
);
const identities: Record<string, Identity> = Object.fromEntries(
  Object.entries(keys).map(([n, k]) => [n, verifyIdentityEnvelope(createIdentityEnvelope(k, 0))]),
);
const lookup = (members: string[]) => (userId: string) =>
  members.map((m) => identities[m]!).find((i) => i.userId === userId);

const alice = keys.alice!;
const bob = keys.bob!;
const ctx: EventContext = {
  serverId: v.inputs.serverId,
  chatId: v.inputs.chatId,
  chat: { epoch: v.inputs.epoch, encKey: unhex(v.inputs.encKeyHex) },
};

describe('event vector', () => {
  it('the inputs come from the DM derivation', () => {
    const dm = deriveDmKeys(alice, bob, ctx.serverId);
    expect(hex(dm.encKey)).toBe(v.inputs.encKeyHex);
    expect(dmChatId(ctx.serverId, alice.userId, bob.userId)).toBe(ctx.chatId);
  });

  it('is reproduced byte for byte with the fixed nonce', async () => {
    const body = await encodeEventWithNonce({ ...ctx, author: alice, payload: utf8(v.inputs.payloadText) }, unhex(v.inputs.nonceHex));
    expect(hex(body)).toBe(v.bodyHex);
    const header = eventHeader(ctx, base32Decode(v.inputs.msgId));
    expect(hex(header)).toBe(v.intermediate.headerHex);
    expect(hex(eventAad(header, ctx))).toBe(v.intermediate.aadHex);
  });

  it('decodes and verifies', async () => {
    const e = await decodeEvent(unhex(v.bodyHex), { ...ctx, lookupAuthor: lookup(['alice', 'bob']), expectedSender: alice.userId });
    expect(e.senderId).toBe(alice.userId);
    expect(e.msgId).toBe(v.inputs.msgId);
    expect(e.epoch).toBe(0);
    expect(new TextDecoder().decode(e.payloadBytes)).toBe(v.inputs.payloadText);
    expect(e.payload.kind).toBe('msg');
    if (e.payload.kind === 'msg') expect(e.payload.msg.body).toBe('Привет! **Hello**');
  });

  it.each(neg.events as { name: string; bodyHex: string; context: Record<string, never>; members: string[]; expectedError: string }[])(
    'negative vector: $name',
    async (c) => {
      const context = c.context as unknown as { serverId: string; chatId: string; epoch: number; encKeyHex: string };
      const code = await asyncErrorCode(
        decodeEvent(unhex(c.bodyHex), {
          serverId: context.serverId,
          chatId: context.chatId,
          chat: { epoch: context.epoch, encKey: unhex(context.encKeyHex) },
          lookupAuthor: lookup(c.members),
        }),
      );
      expect(code).toBe(c.expectedError);
    },
  );
});

describe('event round trip', () => {
  const dm = deriveDmKeys(alice, bob, 'srv');
  const live: EventContext = { serverId: 'srv', chatId: dmChatId('srv', alice.userId, bob.userId), chat: dm };
  const decodeAs = (body: Uint8Array, extra: Partial<Parameters<typeof decodeEvent>[1]> = {}) =>
    decodeEvent(body, { ...live, lookupAuthor: lookup(['alice', 'bob']), ...extra });
  const msg = (body = 'hello', id = newMessageId()) => encodeMsgPayload({ id, dev: newDevId(), seq: 1, body });

  it('uses a fresh nonce each time and pads to 256 bytes', async () => {
    const payload = msg();
    const a = await encodeEvent({ ...live, author: alice, payload });
    const b = await encodeEvent({ ...live, author: alice, payload });
    expect(hex(a.subarray(40, 52))).not.toBe(hex(b.subarray(40, 52)));
    expect((a.length - 68) % 256).toBe(0);
    expect(a.length).toBe(68 + 256);
    const e = await decodeAs(a);
    expect(hex(e.payloadBytes)).toBe(hex(payload));
  });

  it('Bob decodes with his own derivation of the key', async () => {
    const body = await encodeEvent({ ...live, author: alice, payload: msg('от Алисы') });
    const bobSide = deriveDmKeys(bob, alice, 'srv');
    const e = await decodeEvent(body, { ...live, chat: bobSide, lookupAuthor: lookup(['alice', 'bob']) });
    expect(e.payload.kind === 'msg' && e.payload.msg.body).toBe('от Алисы');
  });

  it('padding grows in 256-byte steps', async () => {
    const sizes = new Set<number>();
    for (const n of [1, 100, 171, 172, 400, 16000]) {
      const body = await encodeEvent({ ...live, author: alice, payload: msg('x'.repeat(n)) });
      expect((body.length - 68) % 256).toBe(0);
      sizes.add(body.length);
      await decodeAs(body);
    }
    expect(sizes.size).toBeGreaterThan(3);
  });

  it('carries unknown critical kinds through to the caller', async () => {
    const id = newMessageId();
    const payload = utf8(JSON.stringify({ v: 1, t: 'poll', id, dev: newDevId(), seq: 3, crit: true }));
    const e = await decodeAs(await encodeEvent({ ...live, author: alice, payload }));
    expect(e.payload).toMatchObject({ kind: 'update-required', t: 'poll', id });
  });

  it('reports a sender that differs from the server header', async () => {
    const body = await encodeEvent({ ...live, author: alice, payload: msg() });
    expect(await asyncErrorCode(decodeAs(body, { expectedSender: bob.userId }))).toBe('sender-mismatch');
  });

  it('treats a lookup returning the wrong identity as unknown author', async () => {
    const body = await encodeEvent({ ...live, author: alice, payload: msg() });
    expect(await asyncErrorCode(decodeAs(body, { lookupAuthor: () => identities.bob }))).toBe('unknown-author');
  });

  it('rejects an unsupported format byte, bad magic and oversized bodies', async () => {
    const body = await encodeEvent({ ...live, author: alice, payload: msg() });
    const fmt = new Uint8Array(body);
    fmt[3] = 2;
    expect(await asyncErrorCode(decodeAs(fmt))).toBe('unsupported-version');
    const magic = new Uint8Array(body);
    magic[0] = 0x47;
    expect(await asyncErrorCode(decodeAs(magic))).toBe('malformed');
    expect(await asyncErrorCode(decodeAs(new Uint8Array(MAX_EVENT_BYTES + 256)))).toBe('too-large');
    expect(await asyncErrorCode(decodeAs(new Uint8Array(10)))).toBe('malformed');
    expect(await asyncErrorCode(decodeAs('x' as unknown as Uint8Array))).toBe('malformed');
  });

  /** Encrypt a hand-built plaintext under header id `msgId`, signing `payload` correctly. */
  async function handBuilt(payload: Uint8Array, msgId: Uint8Array, opts: { extraPad?: number; lenDelta?: number } = {}) {
    const senderId = base32Decode(alice.userId);
    const sig = sign(eventSigningInput(live, msgId, senderId, payload), alice.signSecret);
    const used = 84 + payload.length;
    const plain = new Uint8Array(Math.ceil(used / 256) * 256 + (opts.extraPad ?? 0));
    plain.set(concat(senderId, sig, u32be(payload.length + (opts.lenDelta ?? 0)), payload));
    const header = eventHeader(live, msgId);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', live.chat.encKey, 'AES-GCM', false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: eventAad(header, live) }, key, plain);
    return concat(header, nonce, new Uint8Array(ct));
  }

  it('hand-built events decode when well formed', async () => {
    const id = newMessageId();
    expect((await decodeAs(await handBuilt(msg('x', id), base32Decode(id)))).msgId).toBe(id);
  });

  it('rejects a payload whose id differs from the header id', async () => {
    const body = await handBuilt(msg('x', newMessageId()), base32Decode(newMessageId()));
    expect(await asyncErrorCode(decodeAs(body))).toBe('malformed');
  });

  it('rejects non-minimal padding and a length beyond the plaintext', async () => {
    const id = newMessageId();
    expect(await asyncErrorCode(decodeAs(await handBuilt(msg('x', id), base32Decode(id), { extraPad: 256 })))).toBe('malformed');
    expect(await asyncErrorCode(decodeAs(await handBuilt(msg('x', id), base32Decode(id), { lenDelta: 1000 })))).toBe('malformed');
  });

  it('rejects a valid signature over an invalid payload', async () => {
    const id = newMessageId();
    const body = await handBuilt(utf8('not json'), base32Decode(id));
    expect(await asyncErrorCode(decodeAs(body))).toBe('malformed');
  });

  it('rejects bad arguments on encode', async () => {
    const payload = msg();
    expect(await asyncErrorCode(encodeEvent({ ...live, serverId: '', author: alice, payload }))).toBe('invalid-argument');
    expect(await asyncErrorCode(encodeEvent({ ...live, chat: { epoch: -1, encKey: dm.encKey }, author: alice, payload }))).toBe(
      'invalid-argument',
    );
    expect(await asyncErrorCode(encodeEvent({ ...live, chat: { epoch: 0, encKey: new Uint8Array(16) }, author: alice, payload }))).toBe(
      'invalid-argument',
    );
    expect(await asyncErrorCode(encodeEvent({ ...live, author: alice, payload: utf8('{}') }))).toBe('invalid-argument');
    expect(await asyncErrorCode(encodeEventWithNonce({ ...live, author: alice, payload }, new Uint8Array(8)))).toBe(
      'invalid-argument',
    );
    expect(await asyncErrorCode(encodeEvent({ ...live, author: alice, payload: new Uint8Array(MAX_PAYLOAD_BYTES + 1) }))).toBe(
      'too-large',
    );
  });

  it('the largest payload fits within the event limit', async () => {
    const id = newMessageId();
    const prefix = `{"v":1,"t":"x","id":"${id}","pad":"`;
    const pad = 'a'.repeat(MAX_PAYLOAD_BYTES - prefix.length - 2);
    const payload = utf8(`${prefix}${pad}"}`);
    expect(payload.length).toBe(MAX_PAYLOAD_BYTES);
    const body = await encodeEvent({ ...live, author: alice, payload });
    expect(body.length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect((await decodeAs(body)).payload.kind).toBe('ignore');
  });
});
