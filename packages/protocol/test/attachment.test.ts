import { describe, expect, it } from 'vitest';
import {
  blobPartAad,
  blobPartCount,
  blobPartLength,
  checkAttachmentInput,
  decryptBlobPart,
  encryptBlobPart,
  newBlob,
  validateAttachment,
  type Attachment,
  type BlobRef,
} from '../src/attachment.ts';
import { base32Decode, base64urlEncode } from '../src/codec.ts';
import { BLOB_PART_SIZE, MAX_ATTACHMENT_BYTES } from '../src/constants.ts';
import { asyncErrorCode, errorCode, hex } from './helpers.ts';

const MiB = 1024 * 1024;
const jpeg = base64urlEncode(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));

function image(blob: BlobRef = newBlob(1000)): Record<string, unknown> {
  return { blob: { ...blob }, name: 'photo.jpg', mime: 'image/jpeg', kind: 'image', w: 800, h: 600, thumb: jpeg };
}
function voice(): Record<string, unknown> {
  return { blob: newBlob(5000), name: 'voice.m4a', mime: 'audio/mp4', kind: 'voice', dur: 3200, peaks: new Array(64).fill(7) };
}
function file(): Record<string, unknown> {
  return { blob: newBlob(0), name: 'notes.txt', mime: 'text/plain', kind: 'file' };
}

describe('blob layout', () => {
  it('part count is ceil(size / 4 MiB), one part for an empty file', () => {
    expect(blobPartCount(0)).toBe(1);
    expect(blobPartCount(1)).toBe(1);
    expect(blobPartCount(4 * MiB)).toBe(1);
    expect(blobPartCount(4 * MiB + 1)).toBe(2);
    expect(blobPartCount(200 * MiB)).toBe(50);
  });

  it('newBlob gives random ids and keys and the right part count', () => {
    const a = newBlob(9 * MiB);
    const b = newBlob(9 * MiB);
    expect(a.id).toMatch(/^[a-z2-7]{26}$/);
    expect(base32Decode(a.id)).toHaveLength(16);
    expect(a.id).not.toBe(b.id);
    expect(a.key).not.toBe(b.key);
    expect(a).toMatchObject({ parts: 3, partSize: BLOB_PART_SIZE, size: 9 * MiB });
    expect(blobPartLength(a, 0)).toBe(4 * MiB);
    expect(blobPartLength(a, 2)).toBe(MiB);
    expect(blobPartLength(newBlob(0), 0)).toBe(0);
    expect(errorCode(() => newBlob(-1))).toBe('invalid-argument');
    expect(errorCode(() => newBlob(11, { maxSize: 10 }))).toBe('invalid-argument');
    expect(errorCode(() => newBlob(MAX_ATTACHMENT_BYTES + 1))).toBe('invalid-argument');
    expect(errorCode(() => blobPartLength(a, 3))).toBe('invalid-argument');
    expect(errorCode(() => blobPartLength(a, -1))).toBe('invalid-argument');
  });
});

describe('part encryption', () => {
  it('round trip over a multi-part file, deterministic per part', async () => {
    const blob = newBlob(4 * MiB + 10);
    const p0 = new Uint8Array(4 * MiB).fill(1);
    const p1 = new Uint8Array(10).fill(2);
    const c0 = await encryptBlobPart(blob, 0, p0);
    const c1 = await encryptBlobPart(blob, 1, p1);
    expect(c0.length).toBe(4 * MiB + 16);
    expect(c1.length).toBe(26);
    expect(hex(await encryptBlobPart(blob, 1, p1))).toBe(hex(c1)); // resumed upload: same bytes
    expect(hex(await decryptBlobPart(blob, 1, c1))).toBe(hex(p1));
    expect((await decryptBlobPart(blob, 0, c0)).length).toBe(4 * MiB);
  });

  it('empty file is one empty part', async () => {
    const blob = newBlob(0);
    const c = await encryptBlobPart(blob, 0, new Uint8Array(0));
    expect(c.length).toBe(16);
    expect((await decryptBlobPart(blob, 0, c)).length).toBe(0);
  });

  it('detects reordering, truncation, foreign parts and a changed part count', async () => {
    const blob = newBlob(4 * MiB + 4 * MiB);
    const p0 = new Uint8Array(4 * MiB).fill(3);
    const p1 = new Uint8Array(4 * MiB).fill(4);
    const c0 = await encryptBlobPart(blob, 0, p0);
    const c1 = await encryptBlobPart(blob, 1, p1);
    // Swapped parts (same length) fail authentication.
    expect(await asyncErrorCode(decryptBlobPart(blob, 0, c1))).toBe('wrong-key');
    expect(await asyncErrorCode(decryptBlobPart(blob, 1, c0))).toBe('wrong-key');
    // A truncated part does not match the descriptor.
    expect(await asyncErrorCode(decryptBlobPart(blob, 1, c1.subarray(0, c1.length - 1)))).toBe('malformed');
    // Truncating the file to one part: the descriptor claiming one part gives another AAD and key schedule.
    const shorter = { ...blob, size: 4 * MiB, parts: 1 };
    expect(await asyncErrorCode(decryptBlobPart(shorter, 0, c0))).toBe('wrong-key');
    // Part of another file with the same key but another id.
    const otherId = { ...blob, id: newBlob(1).id };
    expect(await asyncErrorCode(decryptBlobPart(otherId, 0, c0))).toBe('wrong-key');
    const otherKey = { ...blob, key: newBlob(1).key };
    expect(await asyncErrorCode(decryptBlobPart(otherKey, 0, c0))).toBe('wrong-key');
    const altered = new Uint8Array(c0);
    altered[5] = (altered[5] as number) ^ 1;
    expect(await asyncErrorCode(decryptBlobPart(blob, 0, altered))).toBe('wrong-key');
  });

  it('rejects bad arguments', async () => {
    const blob = newBlob(10);
    expect(await asyncErrorCode(encryptBlobPart(blob, 0, new Uint8Array(9)))).toBe('invalid-argument');
    expect(await asyncErrorCode(encryptBlobPart(blob, 1, new Uint8Array(10)))).toBe('invalid-argument');
    expect(await asyncErrorCode(encryptBlobPart({ ...blob, parts: 2 }, 0, new Uint8Array(10)))).toBe('invalid-argument');
    expect(await asyncErrorCode(decryptBlobPart({ ...blob, id: '../etc/passwd' }, 0, new Uint8Array(26)))).toBe('malformed');
  });

  it('AAD layout', () => {
    const aad = blobPartAad(new Uint8Array(16).fill(0xaa), 2, 3);
    expect(hex(aad)).toBe(hex(new TextEncoder().encode('fc/v1/blob\n')) + '00000010' + 'aa'.repeat(16) + '00000002' + '00000003');
  });
});

describe('attachment descriptor', () => {
  it('accepts valid image, voice and file descriptors and drops unknown fields', () => {
    const a = validateAttachment({ ...image(), extra: 1 });
    expect(a).not.toHaveProperty('extra');
    expect(Object.keys(a)).toEqual(['blob', 'name', 'mime', 'kind', 'w', 'h', 'thumb']);
    expect(Object.keys(a.blob)).toEqual(['id', 'key', 'parts', 'partSize', 'size']);
    expect(validateAttachment(voice()).peaks).toHaveLength(64);
    expect(validateAttachment(file()).kind).toBe('file');
    expect(validateAttachment({ ...file(), w: 10, h: 20, thumb: jpeg }).w).toBe(10);
    expect(checkAttachmentInput(image()).kind).toBe('image');
  });

  it.each<[string, (a: Record<string, unknown>) => void]>([
    ['wrong part count', (a) => ((a.blob as Record<string, unknown>).parts = 2)],
    ['zero parts', (a) => ((a.blob as Record<string, unknown>).parts = 0)],
    ['path-like id', (a) => ((a.blob as Record<string, unknown>).id = '../../../../etc/passwd')],
    ['dot id', (a) => ((a.blob as Record<string, unknown>).id = '..')],
    ['uppercase id', (a) => ((a.blob as Record<string, unknown>).id = ((a.blob as Record<string, string>).id as string).toUpperCase())],
    ['short key', (a) => ((a.blob as Record<string, unknown>).key = base64urlEncode(new Uint8Array(16)))],
    ['other part size', (a) => ((a.blob as Record<string, unknown>).partSize = 1024)],
    ['negative size', (a) => ((a.blob as Record<string, unknown>).size = -1)],
    ['size over the hard limit', (a) => Object.assign(a.blob as object, { size: MAX_ATTACHMENT_BYTES + 1, parts: blobPartCount(MAX_ATTACHMENT_BYTES + 1) })],
    ['blob missing', (a) => delete a.blob],
    ['name with slash', (a) => (a.name = 'a/b.jpg')],
    ['name with backslash', (a) => (a.name = 'a\\b.jpg')],
    ['name ..', (a) => (a.name = '..')],
    ['name with bidi', (a) => (a.name = 'gpj.‮exe')],
    ['name with control', (a) => (a.name = 'a\nb')],
    ['name empty', (a) => (a.name = '')],
    ['name with outer spaces', (a) => (a.name = ' a.jpg')],
    ['name too long', (a) => (a.name = 'я'.repeat(129))],
    ['mime with parameters', (a) => (a.mime = 'image/jpeg; q=1')],
    ['mime uppercase', (a) => (a.mime = 'IMAGE/JPEG')],
    ['image mime not allowed', (a) => (a.mime = 'image/svg+xml')],
    ['kind unknown', (a) => (a.kind = 'video')],
    ['image without size', (a) => delete a.w],
    ['zero width', (a) => (a.w = 0)],
    ['huge height', (a) => (a.h = 70000)],
    ['thumb too large', (a) => (a.thumb = base64urlEncode(Uint8Array.from({ length: 4097 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i]! : 0))))],
    ['thumb not JPEG', (a) => (a.thumb = base64urlEncode(Uint8Array.of(0x89, 0x50, 0x4e, 0x47)))],
    ['thumb not base64url', (a) => (a.thumb = '!!')],
    ['thumb not a string', (a) => (a.thumb = 5)],
    ['dur on an image', (a) => (a.dur = 5)],
  ])('rejects %s', (_n, patch) => {
    const a = image();
    patch(a);
    expect(errorCode(() => validateAttachment(a))).toBe('malformed');
    expect(errorCode(() => checkAttachmentInput(a))).toBe('invalid-argument');
  });

  it.each<[string, (a: Record<string, unknown>) => void]>([
    ['63 peaks', (a) => (a.peaks = new Array(63).fill(0))],
    ['peak 256', (a) => ((a.peaks as number[])[0] = 256)],
    ['peak fractional', (a) => ((a.peaks as number[])[0] = 1.5)],
    ['no duration', (a) => delete a.dur],
    ['duration over a day', (a) => (a.dur = 86_400_001)],
    ['voice with size', (a) => Object.assign(a, { w: 1, h: 1 })],
    ['voice with thumb', (a) => (a.thumb = jpeg)],
    ['voice mime not allowed', (a) => (a.mime = 'audio/x-wav')],
  ])('rejects voice with %s', (_n, patch) => {
    const a = voice();
    patch(a);
    expect(errorCode(() => validateAttachment(a))).toBe('malformed');
  });

  it('honours the server limit', () => {
    const a = image(newBlob(2000));
    expect(errorCode(() => validateAttachment(a, { maxSize: 1999 }))).toBe('malformed');
    expect(validateAttachment(a, { maxSize: 2000 }).blob.size).toBe(2000);
    expect(errorCode(() => validateAttachment(null))).toBe('malformed');
    const typed: Attachment = validateAttachment(a);
    expect(typed.kind).toBe('image');
  });
});
