import { describe, expect, it } from 'vitest';
import { newBlob } from '../src/attachment.ts';
import { utf8 } from '../src/bytes.ts';
import { base64urlEncode } from '../src/codec.ts';
import {
  decodePayload,
  encodeDeletePayload,
  encodeEditPayload,
  encodeMsgPayload,
  encodeReactPayload,
  parsePayload,
} from '../src/payload.ts';
import { newDevId, newMessageId } from '../src/random.ts';
import { errorCode } from './helpers.ts';

const id = newMessageId();
const dev = newDevId();
const author = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const target = { author, id: newMessageId() };
const json = (o: unknown) => utf8(JSON.stringify(o));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const att = () => ({
  blob: newBlob(10),
  name: 'a.jpg',
  mime: 'image/jpeg',
  kind: 'image' as const,
  w: 1,
  h: 1,
  thumb: base64urlEncode(Uint8Array.of(0xff, 0xd8, 0xff)),
});
const location = { lat: 55.75, lon: 37.62, accuracy: 12.5 };

describe('msg (M2 fields)', () => {
  it('attachments only, no body; field order v,t,id,dev,seq,body,reply,fwd,attachments,location', () => {
    const a = att();
    const bytes = encodeMsgPayload({ id, dev, seq: 1, body: 'b', reply: target, fwd: true, attachments: [a], location });
    const keys = Object.keys(JSON.parse(text(bytes)));
    expect(keys).toEqual(['v', 't', 'id', 'dev', 'seq', 'body', 'reply', 'fwd', 'attachments', 'location']);
    const d = parsePayload(bytes);
    expect(d.kind === 'msg' && d.msg.attachments?.[0]?.blob.id).toBe(a.blob.id);
    expect(d.kind === 'msg' && d.msg.fwd).toBe(true);
    expect(d.kind === 'msg' && d.msg.location).toEqual(location);
    const onlyAtt = encodeMsgPayload({ id, dev, seq: 2, attachments: [a] });
    expect(text(onlyAtt)).not.toContain('body');
    expect(decodePayload(onlyAtt).kind).toBe('msg');
    expect(decodePayload(encodeMsgPayload({ id, dev, seq: 3, location })).kind).toBe('msg');
    expect(text(encodeMsgPayload({ id, dev, seq: 3, body: 'x', fwd: false }))).not.toContain('fwd');
  });

  it('M1 payloads keep their exact bytes', () => {
    expect(text(encodeMsgPayload({ id, dev, seq: 7, body: 'hi', reply: target }))).toBe(
      `{"v":1,"t":"msg","id":"${id}","dev":"${dev}","seq":7,"body":"hi","reply":{"author":"${author}","id":"${target.id}"}}`,
    );
  });

  it.each([
    ['nothing to send', {}],
    ['empty attachments', { attachments: [] }],
    ['11 attachments', { attachments: new Array(11).fill(0).map(att) }],
    ['bad attachment', { attachments: [{ ...att(), kind: 'x' }] }],
    ['fwd not boolean', { body: 'x', fwd: 'yes' }],
    ['latitude 91', { location: { ...location, lat: 91 } }],
    ['longitude -181', { location: { ...location, lon: -181 } }],
    ['negative accuracy', { location: { ...location, accuracy: -1 } }],
    ['NaN latitude', { location: { ...location, lat: NaN } }],
    ['location not an object', { location: 'here' }],
  ])('rejects %s on encode', (_n, patch) => {
    expect(errorCode(() => encodeMsgPayload({ id, dev, seq: 1, ...(patch as object) }))).toBe('invalid-argument');
  });

  it.each([
    ['fwd false', { fwd: false }],
    ['fwd object', { fwd: { from: author } }],
    ['attachments empty', { attachments: [] }],
    ['attachments not a list', { attachments: {} }],
    ['11 attachments', { attachments: new Array(11).fill(0).map(att) }],
    ['attachment with wrong part count', { attachments: [{ ...att(), blob: { ...newBlob(10), parts: 2 } }] }],
    ['attachment with a path-like id', { attachments: [{ ...att(), blob: { ...newBlob(10), id: '../x' } }] }],
    ['location missing accuracy', { location: { lat: 1, lon: 2 } }],
    ['location as strings', { location: { lat: '1', lon: 2, accuracy: 3 } }],
  ])('rejects %s on decode', (_n, patch) => {
    expect(errorCode(() => parsePayload(json({ v: 1, t: 'msg', id, dev, seq: 1, ...patch })))).toBe('malformed');
  });
});

describe('edit, delete, react', () => {
  it('encode with fixed field order; parsePayload types them; decodePayload ignores them', () => {
    const e = encodeEditPayload({ id, dev, seq: 2, target, body: 'fixed' });
    expect(text(e)).toBe(
      `{"v":1,"t":"edit","id":"${id}","dev":"${dev}","seq":2,"target":{"author":"${author}","id":"${target.id}"},"body":"fixed"}`,
    );
    expect(parsePayload(e)).toEqual({ kind: 'edit', edit: { v: 1, t: 'edit', id, dev, seq: 2, target, body: 'fixed' } });
    expect(decodePayload(e)).toEqual({ kind: 'ignore', t: 'edit', id, dev, seq: 2 });
    expect(parsePayload(encodeEditPayload({ id, dev, seq: 2, target, body: '' })).kind).toBe('edit');

    const d = encodeDeletePayload({ id, dev, seq: 3, target, targetDev: dev, targetSeq: 1 });
    expect(Object.keys(JSON.parse(text(d)))).toEqual(['v', 't', 'id', 'dev', 'seq', 'target', 'targetDev', 'targetSeq']);
    expect(parsePayload(d)).toMatchObject({ kind: 'delete', delete: { targetDev: dev, targetSeq: 1 } });
    expect(decodePayload(d).kind).toBe('ignore');

    const r = encodeReactPayload({ id, dev, seq: 4, target, emoji: '👍🏽', on: true });
    expect(Object.keys(JSON.parse(text(r)))).toEqual(['v', 't', 'id', 'dev', 'seq', 'target', 'emoji', 'on']);
    expect(parsePayload(r)).toMatchObject({ kind: 'react', react: { emoji: '👍🏽', on: true } });
    expect(parsePayload(encodeReactPayload({ id, dev, seq: 4, target, emoji: '👨‍👩‍👧', on: false })).kind).toBe('react');
    expect(decodePayload(r)).toEqual({ kind: 'ignore', t: 'react', id, dev, seq: 4 });
  });

  it('parsePayload still reports unknown kinds', () => {
    expect(parsePayload(json({ v: 1, t: 'poll', id, crit: true })).kind).toBe('update-required');
    expect(parsePayload(json({ v: 2, t: 'edit', id })).kind).toBe('ignore');
  });

  it.each([
    ['edit without target', { t: 'edit', body: 'x' }],
    ['edit with bad target', { t: 'edit', target: { author: 'x', id }, body: 'x' }],
    ['edit without body', { t: 'edit', target }],
    ['edit with a huge body', { t: 'edit', target, body: 'a'.repeat(16385) }],
    ['delete without targetSeq', { t: 'delete', target, targetDev: dev }],
    ['delete with bad targetDev', { t: 'delete', target, targetDev: 'x', targetSeq: 1 }],
    ['react without on', { t: 'react', target, emoji: '👍' }],
    ['react with empty emoji', { t: 'react', target, emoji: '', on: true }],
    ['react with a long emoji', { t: 'react', target, emoji: '👍'.repeat(17), on: true }],
    ['react with a control character', { t: 'react', target, emoji: '\u0007', on: true }],
    ['react with spaces', { t: 'react', target, emoji: ' 👍', on: true }],
    ['react without dev', { t: 'react', target, emoji: '👍', on: true, dev: undefined }],
  ])('rejects %s', (_n, patch) => {
    const bytes = json({ v: 1, id, dev, seq: 1, ...patch });
    expect(errorCode(() => parsePayload(bytes))).toBe('malformed');
    expect(errorCode(() => decodePayload(bytes))).toBe('malformed');
  });

  it('encoders reject bad input', () => {
    expect(errorCode(() => encodeEditPayload({ id, dev, seq: 1, target: { author, id: 'x' }, body: 'x' }))).toBe('invalid-argument');
    expect(errorCode(() => encodeEditPayload({ id, dev, seq: 1, target, body: 'a'.repeat(16385) }))).toBe('too-large');
    expect(errorCode(() => encodeEditPayload({ id, dev, seq: 1, target, body: 5 as unknown as string }))).toBe('invalid-argument');
    expect(errorCode(() => encodeDeletePayload({ id, dev, seq: 1, target, targetDev: 'x', targetSeq: 1 }))).toBe('invalid-argument');
    expect(errorCode(() => encodeDeletePayload({ id, dev, seq: 1, target, targetDev: dev, targetSeq: -1 }))).toBe('invalid-argument');
    expect(errorCode(() => encodeDeletePayload({ id, dev, seq: 1, target: { author: 'x', id }, targetDev: dev, targetSeq: 1 }))).toBe(
      'invalid-argument',
    );
    expect(errorCode(() => encodeReactPayload({ id, dev, seq: 1, target, emoji: '', on: true }))).toBe('invalid-argument');
    expect(errorCode(() => encodeReactPayload({ id, dev, seq: 1, target, emoji: '👍', on: 1 as unknown as boolean }))).toBe(
      'invalid-argument',
    );
    expect(errorCode(() => encodeReactPayload({ id: 'x', dev, seq: 1, target, emoji: '👍', on: true }))).toBe('invalid-argument');
    expect(errorCode(() => encodeReactPayload({ id, dev: 'x', seq: 1, target, emoji: '👍', on: true }))).toBe('invalid-argument');
    expect(errorCode(() => encodeReactPayload({ id, dev, seq: -1, target, emoji: '👍', on: true }))).toBe('invalid-argument');
  });
});
