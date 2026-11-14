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
    await this.db.fileChunks.put({ key, index, data: value });
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
  removeEntry(name: string): Promise<void>;
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

export class OpfsFileStore implements FileStore {
  readonly kind = 'opfs' as const;

  constructor(private readonly dir: OpfsDirectory) {}

  async write(key: string, index: number, data: Uint8Array): Promise<void> {
    const h = await this.dir.getFileHandle(fileName(key), { create: true });
    const w = await h.createWritable({ keepExistingData: true });
    try {
      await w.write({ type: 'write', position: index * FILE_CHUNK, data });
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => undefined);
      throw e;
    }
  }

  async read(key: string, index: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const f = await (await this.dir.getFileHandle(fileName(key))).getFile();
    const start = index * FILE_CHUNK;
    if (f.size < start + length) throw new Error('file is short');
    return new Uint8Array(await f.slice(start, start + length).arrayBuffer());
  }

  async blob(key: string, size: number, type: string): Promise<Blob> {
    const f = await (await this.dir.getFileHandle(fileName(key))).getFile();
    if (f.size < size) throw new Error('file is incomplete');
    return f.slice(0, size, type);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.dir.removeEntry(fileName(key));
    } catch {
      // Already gone.
    }
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
