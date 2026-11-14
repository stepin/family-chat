import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_HEADER_BYTES,
  createArchiveReader,
  createArchiveWriter,
  createArchiveWriterWithSalt,
  deriveArchiveKey,
  readArchive,
  type ArchiveRecord,
} from '../src/archive.ts';
import { counterNonce, gcmSeal } from '../src/aead.ts';
import { concat, u32be } from '../src/bytes.ts';
import { ARCHIVE_BLOCK_SIZE } from '../src/constants.ts';
import { deriveIdentityKeys } from '../src/keys.ts';
import { newSeed } from '../src/random.ts';
import { asyncErrorCode, errorCode, hex } from './helpers.ts';

const me = deriveIdentityKeys(newSeed());
const other = deriveIdentityKeys(newSeed());
const MiB = ARCHIVE_BLOCK_SIZE;

async function write(records: [number, Uint8Array][], keys = me): Promise<Uint8Array> {
  const w = createArchiveWriter(keys);
  const parts: Uint8Array[] = [w.header];
  for (const [t, d] of records) parts.push(...(await w.write(t, d)));
  parts.push(...(await w.finish()));
  return concat(...parts);
}

async function read(file: Uint8Array, chunk = 65536, keys = me): Promise<ArchiveRecord[]> {
  const r = createArchiveReader(keys);
  const out: ArchiveRecord[] = [];
  for (let i = 0; i < file.length; i += chunk) out.push(...(await r.push(file.subarray(i, i + chunk))));
  out.push(...(await r.finish()));
  return out;
}

const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

describe('archive', () => {
  it('round trip with records spanning blocks and odd chunking', async () => {
    const records: [number, Uint8Array][] = [
      [1, new TextEncoder().encode('{"server":"home"}')],
      [2, new Uint8Array(0)],
      [3, pattern(MiB + 123, 1)],
      [65535, pattern(2 * MiB, 2)],
      [7, pattern(5, 3)],
    ];
    const file = await write(records);
    for (const chunk of [1 << 20, 7777, file.length]) {
      const got = await read(file, chunk);
      expect(got.map((r) => r.type)).toEqual(records.map((r) => r[0]));
      got.forEach((r, i) => expect(hex(r.data)).toBe(hex(records[i]![1])));
    }
    const viaGen: ArchiveRecord[] = [];
    for await (const r of readArchive([file.subarray(0, 100), file.subarray(100)], me)) viaGen.push(r);
    expect(viaGen).toHaveLength(records.length);
  });

  it('empty archive and an archive of exactly one block', async () => {
    const empty = await write([]);
    expect(empty.length).toBe(ARCHIVE_HEADER_BYTES + 16);
    expect(await read(empty)).toEqual([]);
    const exact = await write([[1, new Uint8Array(MiB - 6)]]);
    expect(exact.length).toBe(ARCHIVE_HEADER_BYTES + MiB + 16);
    expect((await read(exact))[0]!.data.length).toBe(MiB - 6);
    const overOne = await write([[1, new Uint8Array(MiB - 5)]]);
    expect(overOne.length).toBe(ARCHIVE_HEADER_BYTES + MiB + 16 + 1 + 16);
    expect((await read(overOne))[0]!.data.length).toBe(MiB - 5);
  });

  it('every export uses a new salt and key', async () => {
    const a = createArchiveWriter(me).header;
    const b = createArchiveWriter(me).header;
    expect(hex(a.subarray(4, 20))).not.toBe(hex(b.subarray(4, 20)));
    expect(hex(deriveArchiveKey(me.selfKey, a.subarray(4, 20)).key)).not.toBe(hex(deriveArchiveKey(me.selfKey, b.subarray(4, 20)).key));
  });

  it('another identity gets a clear error', async () => {
    const file = await write([[1, pattern(10, 0)]]);
    expect(await asyncErrorCode(read(file, 65536, other))).toBe('wrong-identity');
    expect(await asyncErrorCode(read(file.subarray(0, 10), 65536, other))).toBe('malformed'); // too short to tell
  });

  it('detects truncation, reordering, alteration and header changes', async () => {
    const file = await write([[1, pattern(3 * MiB, 9)]]);
    const blockCt = MiB + 16;
    const h = ARCHIVE_HEADER_BYTES;
    // Truncated at a block boundary: the last remaining block was not sealed as last.
    expect(await asyncErrorCode(read(file.subarray(0, h + 2 * blockCt)))).toBe('malformed');
    // Truncated inside the last block.
    expect(await asyncErrorCode(read(file.subarray(0, file.length - 1)))).toBe('malformed');
    // Truncated to fewer than 16 bytes of the final block.
    expect(await asyncErrorCode(read(file.subarray(0, h + 3 * blockCt + 5)))).toBe('malformed');
    // Two blocks swapped.
    const swapped = concat(
      file.subarray(0, h),
      file.subarray(h + blockCt, h + 2 * blockCt),
      file.subarray(h, h + blockCt),
      file.subarray(h + 2 * blockCt),
    );
    expect(await asyncErrorCode(read(swapped))).toBe('malformed');
    const flip = (i: number) => {
      const b = new Uint8Array(file);
      b[i] = (b[i] as number) ^ 1;
      return b;
    };
    expect(await asyncErrorCode(read(flip(h + 10)))).toBe('malformed');
    expect(await asyncErrorCode(read(flip(0)))).toBe('malformed');
    expect(await asyncErrorCode(read(flip(3)))).toBe('unsupported-version');
    expect(await asyncErrorCode(read(flip(5)))).toBe('wrong-identity'); // salt changed: key check fails
    expect(await asyncErrorCode(read(flip(30)))).toBe('wrong-identity'); // check changed
    // Extra bytes after the end.
    expect(await asyncErrorCode(read(concat(file, new Uint8Array(1))))).toBe('malformed');
  });

  it('rejects a truncated record inside a valid archive and bad record framing', async () => {
    // Build a stream whose plaintext ends inside a record: head says 10 bytes, only 3 follow.
    const salt = new Uint8Array(16).fill(1);
    const w = createArchiveWriterWithSalt(me, salt);
    const { key } = deriveArchiveKey(me.selfKey, salt);
    expect(key).toHaveLength(32);
    const okFile = concat(w.header, ...(await w.write(1, pattern(10, 1))), ...(await w.finish()));
    expect(await read(okFile)).toHaveLength(1);
    // Hand-made single-block archives with broken framing inside valid encryption.
    const handMade = async (plain: Uint8Array) =>
      concat(w.header, await gcmSeal(key, counterNonce(0), concat(w.header, u32be(0), Uint8Array.of(1)), plain));
    const head = (type: number, len: number) => concat(Uint8Array.of(type >> 8, type & 0xff), u32be(len));
    expect(await read(await handMade(concat(head(1, 3), pattern(3, 0))))).toHaveLength(1);
    expect(await asyncErrorCode(read(await handMade(concat(head(1, 10), pattern(3, 0)))))).toBe('malformed');
    expect(await asyncErrorCode(read(await handMade(head(1, 10).subarray(0, 4))))).toBe('malformed');
    expect(await asyncErrorCode(read(await handMade(concat(head(0, 1), pattern(1, 0)))))).toBe('malformed');
    expect(await asyncErrorCode(read(await handMade(head(2, 16 * MiB + 1))))).toBe('malformed');
    // Records cannot be type 0 or too large on write.
    const w2 = createArchiveWriter(me);
    expect(await asyncErrorCode(w2.write(0, new Uint8Array(1)))).toBe('invalid-argument');
    expect(await asyncErrorCode(w2.write(65536, new Uint8Array(1)))).toBe('invalid-argument');
    expect(await asyncErrorCode(w2.write(1, new Uint8Array(16 * MiB + 1)))).toBe('too-large');
    await w2.finish();
    expect(await asyncErrorCode(w2.finish())).toBe('invalid-argument');
    expect(await asyncErrorCode(w2.write(1, new Uint8Array(1)))).toBe('invalid-argument');
    expect(errorCode(() => createArchiveWriterWithSalt(me, new Uint8Array(3)))).toBe('invalid-argument');
    expect(errorCode(() => createArchiveWriter({ selfKey: new Uint8Array(3) }))).toBe('invalid-argument');
    expect(errorCode(() => createArchiveReader({ selfKey: new Uint8Array(3) }))).toBe('invalid-argument');
    const r = createArchiveReader(me);
    await r.push(okFile);
    await r.finish();
    expect(await asyncErrorCode(r.push(new Uint8Array(1)))).toBe('invalid-argument');
    expect(await asyncErrorCode(r.finish())).toBe('invalid-argument');
  });
});
