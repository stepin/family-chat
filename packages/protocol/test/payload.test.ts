import { describe, expect, it } from 'vitest';
import { decodePayload, encodeMsgPayload } from '../src/payload.ts';
import { utf8 } from '../src/bytes.ts';
import { MAX_BODY_BYTES } from '../src/constants.ts';
import { newDevId, newMessageId } from '../src/random.ts';
import { errorCode } from './helpers.ts';

const id = newMessageId();
const dev = newDevId();
const author = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const json = (o: unknown) => utf8(JSON.stringify(o));

describe('msg payload', () => {
  it('encodes with fixed field order and decodes', () => {
    const bytes = encodeMsgPayload({ id, dev, seq: 7, body: 'hi *there*', reply: { author, id } });
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"v":1,"t":"msg","id":"${id}","dev":"${dev}","seq":7,"body":"hi *there*","reply":{"author":"${author}","id":"${id}"}}`,
    );
    expect(decodePayload(bytes)).toEqual({
      kind: 'msg',
      msg: { v: 1, t: 'msg', id, dev, seq: 7, body: 'hi *there*', reply: { author, id } },
    });
  });

  it('omits reply when absent and ignores unknown fields on decode', () => {
    const bytes = encodeMsgPayload({ id, dev, seq: 0, body: 'x' });
    expect(new TextDecoder().decode(bytes)).not.toContain('reply');
    const d = decodePayload(json({ v: 1, t: 'msg', id, dev, seq: 1, body: 'x', future: [1] }));
    expect(d).toEqual({ kind: 'msg', msg: { v: 1, t: 'msg', id, dev, seq: 1, body: 'x' } });
  });

  it('accepts a body of exactly 16 KB and rejects one byte more', () => {
    const max = 'я'.repeat(MAX_BODY_BYTES / 2);
    expect(decodePayload(encodeMsgPayload({ id, dev, seq: 1, body: max })).kind).toBe('msg');
    expect(errorCode(() => encodeMsgPayload({ id, dev, seq: 1, body: max + 'a' }))).toBe('too-large');
    expect(errorCode(() => decodePayload(json({ v: 1, t: 'msg', id, dev, seq: 1, body: max + 'a' })))).toBe('malformed');
  });

  it('decodes a msg without body (future attachment-only messages)', () => {
    const d = decodePayload(json({ v: 1, t: 'msg', id, dev, seq: 1 }));
    expect(d.kind === 'msg' && d.msg.body).toBeUndefined();
  });

  it.each([
    ['bad id', { id: 'x' }],
    ['bad dev', { dev: 'x' }],
    ['negative seq', { seq: -1 }],
    ['empty body', { body: '' }],
    ['bad reply author', { reply: { author: 'x', id } }],
    ['bad reply id', { reply: { author, id: 'x' } }],
  ])('rejects %s on encode', (_n, patch) => {
    expect(errorCode(() => encodeMsgPayload({ id, dev, seq: 1, body: 'b', ...patch }))).toBe('invalid-argument');
  });

  it.each([
    ['dev missing', { dev: undefined }],
    ['seq fractional', { seq: 1.5 }],
    ['body not a string', { body: 5 }],
    ['reply not an object', { reply: 'x' }],
    ['reply id bad', { reply: { author, id: 'zz' } }],
  ])('rejects %s on decode', (_n, patch) => {
    expect(errorCode(() => decodePayload(json({ v: 1, t: 'msg', id, dev, seq: 1, body: 'b', ...patch })))).toBe(
      'malformed',
    );
  });
});

describe('unknown kinds and versions', () => {
  it('critical unknown kind asks to update the app', () => {
    expect(decodePayload(json({ v: 1, t: 'poll', id, dev, seq: 4, crit: true }))).toEqual({
      kind: 'update-required',
      t: 'poll',
      id,
      dev,
      seq: 4,
    });
  });

  it('non-critical unknown kind is ignored', () => {
    expect(decodePayload(json({ v: 1, t: 'typing', id, crit: false }))).toEqual({ kind: 'ignore', t: 'typing', id });
    expect(decodePayload(json({ v: 2, t: 'react', id, dev, seq: 2 }))).toMatchObject({ kind: 'ignore', t: 'react' });
  });

  it('a newer version of msg follows the crit rule', () => {
    expect(decodePayload(json({ v: 2, t: 'msg', id, crit: true })).kind).toBe('update-required');
    expect(decodePayload(json({ v: 2, t: 'msg', id })).kind).toBe('ignore');
  });

  it.each([
    ['invalid JSON', utf8('{')],
    ['invalid UTF-8', Uint8Array.of(0xc3)],
    ['array', json([])],
    ['missing v', json({ t: 'msg', id })],
    ['v zero', json({ v: 0, t: 'msg', id })],
    ['missing t', json({ v: 1, id })],
    ['empty t', json({ v: 1, t: '', id })],
    ['crit not boolean', json({ v: 1, t: 'x', id, crit: 1 })],
    ['missing id', json({ v: 1, t: 'x' })],
  ])('rejects %s', (_n, bytes) => {
    expect(errorCode(() => decodePayload(bytes))).toBe('malformed');
  });
});
