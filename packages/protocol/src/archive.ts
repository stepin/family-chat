// Archive file .fcarchive (docs/PROTOCOL.md, section "Архив"): container format only.
//
// header     = "FCA" || 0x01 || salt(16) || check(16)                         (36 bytes)
// archiveKey = HKDF(selfKey, "fc/v1/archive" || salt)
// check      = HKDF(archiveKey, "fc/v1/archive-check")[0..16]
// block i    = AES-256-GCM(archiveKey, nonce = 0^8 || u32 i, plaintext_i,
//                          AAD = header || u32 i || u8 last)                   (1 MiB plaintext, last one shorter)
// plaintext  = records: u16 type || u32 len || data, concatenated across blocks
//
// Writing and reading are streaming: at most one block and one record are held in memory.

import { concat, copy, equalBytes, u32be, utf8, type Bytes } from './bytes.ts';
import { counterNonce, GCM_TAG_BYTES, gcmOpen, gcmSeal } from './aead.ts';
import { ARCHIVE_BLOCK_SIZE, MAX_ARCHIVE_RECORD_BYTES } from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';
import { hkdf32 } from './keys.ts';
import { randomBytes } from './random.ts';

export const ARCHIVE_MAGIC = utf8('FCA');
export const ARCHIVE_FORMAT = 0x01;
export const ARCHIVE_SALT_BYTES = 16;
export const ARCHIVE_CHECK_BYTES = 16;
export const ARCHIVE_HEADER_BYTES = 4 + ARCHIVE_SALT_BYTES + ARCHIVE_CHECK_BYTES;
export const LABEL_ARCHIVE = 'fc/v1/archive';
export const LABEL_ARCHIVE_CHECK = 'fc/v1/archive-check';
const RECORD_HEAD_BYTES = 6;
const MAX_RECORD_TYPE = 0xffff;
const MAX_BLOCKS = 0xffffffff;

/** One record: a type chosen by the client core (1..65535) and opaque bytes. */
export interface ArchiveRecord {
  readonly type: number;
  readonly data: Bytes;
}

/** Only `selfKey` is used; an IdentityKeys object fits. */
export interface ArchiveKeySource {
  readonly selfKey: Uint8Array;
}

function checkSelfKey(k: ArchiveKeySource): Uint8Array {
  if (!(k.selfKey instanceof Uint8Array) || k.selfKey.length !== 32) {
    throw new ProtocolError('invalid-argument', 'selfKey must be 32 bytes');
  }
  return k.selfKey;
}

export function deriveArchiveKey(selfKey: Uint8Array, salt: Uint8Array): { key: Bytes; check: Bytes } {
  const key = hkdf32(selfKey, concat(utf8(LABEL_ARCHIVE), salt));
  const check = hkdf32(key, utf8(LABEL_ARCHIVE_CHECK)).subarray(0, ARCHIVE_CHECK_BYTES);
  return { key, check };
}

function blockAad(header: Uint8Array, index: number, last: boolean): Bytes {
  return concat(header, u32be(index), Uint8Array.of(last ? 1 : 0));
}

function recordHead(type: number, len: number): Bytes {
  const h = new Uint8Array(RECORD_HEAD_BYTES);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, type, false);
  dv.setUint32(2, len, false);
  return h;
}

export interface ArchiveWriter {
  /** The 36-byte header: the first bytes of the file. */
  readonly header: Bytes;
  /** Append a record; returns encrypted blocks that are complete (write them in order after the header). */
  write(type: number, data: Uint8Array): Promise<Bytes[]>;
  /** Close the archive; returns the remaining blocks, the last of them flagged as last. */
  finish(): Promise<Bytes[]>;
}

/** Internal: writer with a chosen salt (test vectors). */
export function createArchiveWriterWithSalt(keys: ArchiveKeySource, salt: Uint8Array): ArchiveWriter {
  const selfKey = checkSelfKey(keys);
  if (!(salt instanceof Uint8Array) || salt.length !== ARCHIVE_SALT_BYTES) {
    throw new ProtocolError('invalid-argument', 'archive salt must be 16 bytes');
  }
  const { key, check } = deriveArchiveKey(selfKey, salt);
  const header = concat(ARCHIVE_MAGIC, Uint8Array.of(ARCHIVE_FORMAT), salt, check);
  const block = new Uint8Array(ARCHIVE_BLOCK_SIZE);
  let fill = 0;
  let index = 0;
  let done = false;

  const seal = async (plain: Uint8Array, last: boolean): Promise<Bytes> => {
    if (index >= MAX_BLOCKS) throw new ProtocolError('too-large', 'archive has too many blocks');
    const out = await gcmSeal(key, counterNonce(index), blockAad(header, index, last), plain);
    index++;
    return out;
  };

  // A full block is sealed as "not last" only when more data follows it, so the final block
  // (possibly empty) always carries the last flag.
  const push = async (bytes: Uint8Array, out: Bytes[]): Promise<void> => {
    let off = 0;
    while (off < bytes.length) {
      if (fill === ARCHIVE_BLOCK_SIZE) {
        out.push(await seal(block, false));
        fill = 0;
      }
      const n = Math.min(ARCHIVE_BLOCK_SIZE - fill, bytes.length - off);
      block.set(bytes.subarray(off, off + n), fill);
      fill += n;
      off += n;
    }
  };

  return {
    header,
    async write(type, data) {
      if (done) throw new ProtocolError('invalid-argument', 'archive is already finished');
      if (!Number.isInteger(type) || type < 1 || type > MAX_RECORD_TYPE) {
        throw new ProtocolError('invalid-argument', 'record type must be 1..65535');
      }
      if (!(data instanceof Uint8Array) || data.length > MAX_ARCHIVE_RECORD_BYTES) {
        throw new ProtocolError('too-large', `archive record exceeds ${MAX_ARCHIVE_RECORD_BYTES} bytes`);
      }
      const out: Bytes[] = [];
      await push(recordHead(type, data.length), out);
      await push(data, out);
      return out;
    },
    async finish() {
      if (done) throw new ProtocolError('invalid-argument', 'archive is already finished');
      done = true;
      return [await seal(block.subarray(0, fill), true)];
    },
  };
}

/** Start a new archive for this identity with a fresh random salt (every export gets its own key). */
export function createArchiveWriter(keys: ArchiveKeySource): ArchiveWriter {
  return createArchiveWriterWithSalt(keys, randomBytes(ARCHIVE_SALT_BYTES));
}

/** FIFO of byte chunks. */
class ByteQueue {
  #chunks: Uint8Array[] = [];
  #head = 0;
  length = 0;

  push(b: Uint8Array): void {
    if (b.length === 0) return;
    this.#chunks.push(copy(b));
    this.length += b.length;
  }

  take(n: number): Bytes {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.#chunks[0] as Uint8Array;
      const k = Math.min(n - off, c.length - this.#head);
      out.set(c.subarray(this.#head, this.#head + k), off);
      off += k;
      this.#head += k;
      if (this.#head === c.length) {
        this.#chunks.shift();
        this.#head = 0;
      }
    }
    this.length -= n;
    return out;
  }
}

export interface ArchiveReader {
  /** Feed the next bytes of the file (any chunking); returns the records completed so far. */
  push(chunk: Uint8Array): Promise<ArchiveRecord[]>;
  /** Signal the end of the file; returns the last records. Throws if the archive is truncated. */
  finish(): Promise<ArchiveRecord[]>;
}

/**
 * Read an archive from its first byte. Errors: not an archive (`malformed`), newer format
 * (`unsupported-version`), written by another identity (`wrong-identity`), altered, reordered
 * or truncated data (`malformed`).
 */
export function createArchiveReader(keys: ArchiveKeySource): ArchiveReader {
  const selfKey = checkSelfKey(keys);
  const input = new ByteQueue();
  const blockCt = ARCHIVE_BLOCK_SIZE + GCM_TAG_BYTES;
  let header: Bytes | undefined;
  let key: Bytes | undefined;
  let index = 0;
  let done = false;
  // Record parser state.
  let head = new Uint8Array(RECORD_HEAD_BYTES);
  let headFill = 0;
  let rec: { type: number; data: Bytes; fill: number } | undefined;

  const readHeader = (): void => {
    const h = input.take(ARCHIVE_HEADER_BYTES);
    if (!equalBytes(h.subarray(0, 3), ARCHIVE_MAGIC)) throw malformed('archive: not a Family Chat archive');
    if (h[3] !== ARCHIVE_FORMAT) throw new ProtocolError('unsupported-version', 'archive format is not supported');
    const salt = h.subarray(4, 4 + ARCHIVE_SALT_BYTES);
    const derived = deriveArchiveKey(selfKey, salt);
    if (!equalBytes(h.subarray(4 + ARCHIVE_SALT_BYTES), derived.check)) {
      throw new ProtocolError('wrong-identity', 'archive belongs to another identity');
    }
    header = h;
    key = derived.key;
  };

  const parse = (plain: Uint8Array, out: ArchiveRecord[]): void => {
    let off = 0;
    while (off < plain.length) {
      if (!rec) {
        const n = Math.min(RECORD_HEAD_BYTES - headFill, plain.length - off);
        head.set(plain.subarray(off, off + n), headFill);
        headFill += n;
        off += n;
        if (headFill < RECORD_HEAD_BYTES) break;
        const dv = new DataView(head.buffer);
        const type = dv.getUint16(0, false);
        const len = dv.getUint32(2, false);
        if (type === 0) throw malformed('archive: record type 0');
        if (len > MAX_ARCHIVE_RECORD_BYTES) throw malformed('archive: record is too large');
        rec = { type, data: new Uint8Array(len), fill: 0 };
        head = new Uint8Array(RECORD_HEAD_BYTES);
        headFill = 0;
      }
      const n = Math.min(rec.data.length - rec.fill, plain.length - off);
      rec.data.set(plain.subarray(off, off + n), rec.fill);
      rec.fill += n;
      off += n;
      if (rec.fill === rec.data.length) {
        out.push({ type: rec.type, data: rec.data });
        rec = undefined;
      }
    }
  };

  const open = async (ct: Uint8Array, last: boolean): Promise<Bytes> => {
    const plain = await gcmOpen(key as Bytes, counterNonce(index), blockAad(header as Bytes, index, last), ct);
    if (!plain) throw malformed(`archive: block ${index} is damaged, out of order or the archive is truncated`);
    index++;
    return plain;
  };

  return {
    async push(chunk) {
      if (done) throw new ProtocolError('invalid-argument', 'archive reader is finished');
      input.push(chunk);
      const out: ArchiveRecord[] = [];
      if (!header) {
        if (input.length < ARCHIVE_HEADER_BYTES) return out;
        readHeader();
      }
      // More than one block's worth buffered: the first block is certainly not the last.
      while (input.length > blockCt) parse(await open(input.take(blockCt), false), out);
      return out;
    },
    async finish() {
      if (done) throw new ProtocolError('invalid-argument', 'archive reader is finished');
      done = true;
      if (!header) {
        if (input.length < ARCHIVE_HEADER_BYTES) throw malformed('archive: too short');
        readHeader();
      }
      const out: ArchiveRecord[] = [];
      while (input.length > blockCt) parse(await open(input.take(blockCt), false), out);
      if (input.length < GCM_TAG_BYTES) throw malformed('archive: truncated');
      parse(await open(input.take(input.length), true), out);
      if (rec || headFill > 0) throw malformed('archive: truncated inside a record');
      return out;
    },
  };
}

/** Read all records from a stream of file chunks. */
export async function* readArchive(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, keys: ArchiveKeySource): AsyncGenerator<ArchiveRecord> {
  const reader = createArchiveReader(keys);
  for await (const chunk of source) yield* await reader.push(chunk);
  yield* await reader.finish();
}
