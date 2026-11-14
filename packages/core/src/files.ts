// App-owned file storage for attachments: the Origin Private File System
// (OPFS) when the platform offers it with writable streams, IndexedDB
// otherwise. The choice is made at runtime; both are always usable, and every
// stored file remembers where it lives.
//
// Files are written and read in chunks of 4 MiB (the attachment part size),
// so a large file never has to be held in memory. `blob()` returns a Blob
// backed by the storage (OPFS file, or IndexedDB Blob values where the
// platform can store them).

import { BLOB_PART_SIZE } from '@family-chat/protocol';
import type { CoreDb } from './db/schema.ts';
import { CoreError } from './errors.ts';

/** Chunk size of stored files: one attachment part. */
export const FILE_CHUNK = BLOB_PART_SIZE;

export type FileStoreKind = 'opfs' | 'idb';

export interface FileStore {
  readonly kind: FileStoreKind;
  /** Writes chunk `index` (at offset index × 4 MiB). Every chunk but the last is exactly 4 MiB. */
  write(key: string, index: number, data: Uint8Array): Promise<void>;
  /** Reads `length` bytes of chunk `index`. */
  read(key: string, index: number, length: number): Promise<Uint8Array>;
  /** The whole file as a Blob of `size` bytes. */
  blob(key: string, size: number, type: string): Promise<Blob>;
  delete(key: string): Promise<void>;
}

/**
 * The device ran out of room: QuotaExceededError from IndexedDB or OPFS
 * (Dexie wraps the IndexedDB one, sometimes inside an AbortError).
 */
export function isQuotaError(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 4; i++) {
    const name = (x as { name?: unknown }).name;
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    x = (x as { inner?: unknown; cause?: unknown }).inner ?? (x as { cause?: unknown }).cause;
  }
  return false;
}

/** Rethrows a quota error as CoreError `no-space` (the UI says "not enough space on this device"). */
function noSpace(e: unknown): never {
  if (isQuotaError(e)) throw new CoreError('no-space', 'not enough space on this device');
  throw e;
}

/**
 * Whether the browser's storage estimate leaves room for `bytes` more. True
 * when the estimate is not available (the write itself then reports a quota
 * error). Only a clear shortage answers false.
 */
export async function roomFor(bytes: number): Promise<boolean> {
  try {
    const storage = (globalThis.navigator as { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } } | undefined)
      ?.storage;
    const e = await storage?.estimate?.();
    if (!e || typeof e.quota !== 'number' || typeof e.usage !== 'number') return true;
    return e.quota - e.usage >= bytes;
  } catch {
    return true;
  }
}

// ---- IndexedDB ----

export class IdbFileStore implements FileStore {
  readonly kind = 'idb' as const;
  #blobsOk: Promise<boolean> | undefined;

  constructor(private readonly db: CoreDb) {}

  /** Whether this IndexedDB keeps Blob values (browsers do; then reads stay on disk). */
  #canStoreBlobs(): Promise<boolean> {
    this.#blobsOk ??= (async () => {
      if (typeof Blob === 'undefined') return false;
      try {
        const key = '\u0000probe';
        await this.db.fileChunks.put({ key, index: 0, data: new Blob([new Uint8Array([1, 2, 3])]) });
        const back = await this.db.fileChunks.get([key, 0]);
        await this.db.fileChunks.delete([key, 0]);
        return back?.data instanceof Blob && (await back.data.arrayBuffer()).byteLength === 3;
      } catch {
        return false;
      }
    })();
    return this.#blobsOk;
  }

  async write(key: string, index: number, data: Uint8Array): Promise<void> {
    const value = (await this.#canStoreBlobs()) ? new Blob([data as Uint8Array<ArrayBuffer>]) : data.slice();
    await this.db.fileChunks.put({ key, index, data: value }).catch(noSpace);
  }

  async read(key: string, index: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const row = await this.db.fileChunks.get([key, index]);
    if (!row) throw new Error('file chunk is missing');
    const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(await row.data.arrayBuffer());
    if (bytes.length < length) throw new Error('file chunk is short');
    return bytes.length === length ? bytes : bytes.subarray(0, length);
  }

  async blob(key: string, size: number, type: string): Promise<Blob> {
    const rows = await this.db.fileChunks.where('key').equals(key).sortBy('index');
    const parts = rows.map((r) => r.data as BlobPart);
    const b = new Blob(parts, { type });
    if (b.size < size) throw new Error('file is incomplete');
    return b.size === size ? b : b.slice(0, size, type);
  }

  async delete(key: string): Promise<void> {
    await this.db.fileChunks.where('key').equals(key).delete();
  }
}

// ---- OPFS ----

/** The parts of the File System Access API the store uses (also implemented by test fakes). */
export interface OpfsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface OpfsFile {
  getFile(): Promise<Blob>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
}

export interface OpfsWritable {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

function fileName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function isNotFound(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === 'NotFoundError' || (e as { name?: unknown } | null)?.name === 'TypeMismatchError';
}

/**
 * Every chunk is its own file in a folder per stored file (`<key>.parts/<n>`).
 * Writing one chunk therefore never touches the others: a writable stream
 * with `keepExistingData` on one big file makes Chromium copy the whole file
 * into a swap file first, which for a 200 MB attachment written in 50 chunks
 * means about 5 GB of disk traffic. The whole file is a Blob concatenated from
 * the chunk files (still backed by the disk, never read into memory).
 *
 * Files written by M2 (one file per attachment, chunks at offsets) are still
 * read and removed.
 */
export class OpfsFileStore implements FileStore {
  readonly kind = 'opfs' as const;

  constructor(private readonly dir: OpfsDirectory) {}

  #parts(key: string, create: boolean): Promise<OpfsDirectory> {
    return this.dir.getDirectoryHandle(`${fileName(key)}.parts`, { create });
  }

  async write(key: string, index: number, data: Uint8Array): Promise<void> {
    try {
      const parts = await this.#parts(key, true);
      const h = await parts.getFileHandle(String(index), { create: true });
      const w = await h.createWritable({ keepExistingData: false });
      try {
        await w.write({ type: 'write', position: 0, data });
        await w.close();
      } catch (e) {
        await w.abort?.().catch(() => undefined);
        throw e;
      }
    } catch (e) {
      noSpace(e);
    }
  }

  async read(key: string, index: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    let parts: OpfsDirectory | undefined;
    try {
      parts = await this.#parts(key, false);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (parts) {
      const f = await (await parts.getFileHandle(String(index))).getFile();
      if (f.size < length) throw new Error('file chunk is short');
      return new Uint8Array(await f.slice(0, length).arrayBuffer());
    }
    // M2 layout: one file, chunk at its offset.
    const f = await (await this.dir.getFileHandle(fileName(key))).getFile();
    const start = index * FILE_CHUNK;
    if (f.size < start + length) throw new Error('file is short');
    return new Uint8Array(await f.slice(start, start + length).arrayBuffer());
  }

  async blob(key: string, size: number, type: string): Promise<Blob> {
    let parts: OpfsDirectory | undefined;
    try {
      parts = await this.#parts(key, false);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (parts) {
      const count = Math.ceil(size / FILE_CHUNK);
      const files: Blob[] = [];
      for (let i = 0; i < count; i++) files.push(await (await parts.getFileHandle(String(i))).getFile());
      const b = new Blob(files, { type });
      if (b.size < size) throw new Error('file is incomplete');
      return b.size === size ? b : b.slice(0, size, type);
    }
    const f = await (await this.dir.getFileHandle(fileName(key))).getFile();
    if (f.size < size) throw new Error('file is incomplete');
    return f.slice(0, size, type);
  }

  async delete(key: string): Promise<void> {
    await this.dir.removeEntry(`${fileName(key)}.parts`, { recursive: true }).catch(() => undefined);
    await this.dir.removeEntry(fileName(key)).catch(() => undefined);
  }
}

/** Opens the OPFS folder of the app and checks that writable streams work; undefined otherwise. */
export async function openOpfs(root?: () => Promise<OpfsDirectory>): Promise<OpfsDirectory | undefined> {
  try {
    const getRoot =
      root ??
      (() => {
        const storage = (globalThis.navigator as { storage?: { getDirectory?: () => Promise<unknown> } } | undefined)?.storage;
        if (!storage?.getDirectory) throw new Error('no OPFS');
        return storage.getDirectory() as Promise<OpfsDirectory>;
      });
    const top = await getRoot();
    const dir = await top.getDirectoryHandle('family-chat-files', { create: true });
    const probe = await dir.getFileHandle('.probe', { create: true });
    if (typeof probe.createWritable !== 'function') return undefined;
    const w = await probe.createWritable({ keepExistingData: false });
    await w.write({ type: 'write', position: 0, data: new Uint8Array([1]) });
    await w.close();
    await dir.removeEntry('.probe').catch(() => undefined);
    return dir;
  } catch {
    return undefined;
  }
}

export type FileStorePreference = 'auto' | FileStoreKind;

/** Both stores, the preferred one chosen once at runtime. */
export class FileStores {
  readonly idb: IdbFileStore;
  #opfs: Promise<OpfsFileStore | undefined> | undefined;

  constructor(
    db: CoreDb,
    private readonly preference: FileStorePreference = 'auto',
    private readonly opfsRoot?: () => Promise<OpfsDirectory>,
  ) {
    this.idb = new IdbFileStore(db);
  }

  #openOpfs(): Promise<OpfsFileStore | undefined> {
    this.#opfs ??= openOpfs(this.opfsRoot).then((d) => (d ? new OpfsFileStore(d) : undefined));
    return this.#opfs;
  }

  /** Where new files go: OPFS when available (unless IndexedDB is preferred). */
  async preferred(): Promise<FileStore> {
    if (this.preference === 'idb') return this.idb;
    return (await this.#openOpfs()) ?? this.idb;
  }

  /** The store a file was written to. */
  async of(kind: FileStoreKind): Promise<FileStore> {
    if (kind === 'idb') return this.idb;
    const o = await this.#openOpfs();
    if (!o) throw new Error('OPFS is not available any more');
    return o;
  }
}
