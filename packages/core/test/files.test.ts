// App-owned file storage: IndexedDB and OPFS stores, and the runtime choice.

import { describe, expect, it } from 'vitest';
import { FILE_CHUNK, FileStores, IdbFileStore, OpfsFileStore, openOpfs } from '../src/files.ts';
import { FakeOpfsDir } from './support/fake-opfs.ts';
import { memDb } from './support/helpers.ts';

function bytes(n: number, v = 1): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n).fill(v);
}

describe('file stores', () => {
  it('IndexedDB: chunks, partial reads, Blob of the whole file, delete', async () => {
    const db = memDb();
    await db.open();
    const s = new IdbFileStore(db);
    await s.write('k', 0, bytes(FILE_CHUNK, 1));
    await s.write('k', 1, bytes(10, 2));
    expect(await s.read('k', 1, 10)).toEqual(bytes(10, 2));
    expect((await s.read('k', 0, 5)).length).toBe(5);
    expect(await s.read('k', 3, 0)).toEqual(new Uint8Array(0));
    const b = await s.blob('k', FILE_CHUNK + 10, 'application/x-test');
    expect(b.size).toBe(FILE_CHUNK + 10);
    expect(b.type).toBe('application/x-test');
    await expect(s.blob('k', FILE_CHUNK + 11, 'x')).rejects.toThrow('incomplete');
    await expect(s.read('k', 7, 1)).rejects.toThrow('missing');
    await s.delete('k');
    expect(await db.fileChunks.count()).toBe(0);
  });

  it('OPFS: writes at chunk offsets, reads back, removes', async () => {
    const root = new FakeOpfsDir();
    const dir = await openOpfs(async () => root);
    expect(dir).toBeDefined();
    const s = new OpfsFileStore(dir!);
    await s.write('acc/blob', 1, bytes(3, 9));
    await s.write('acc/blob', 0, bytes(FILE_CHUNK, 4));
    expect(await s.read('acc/blob', 1, 3)).toEqual(bytes(3, 9));
    const b = await s.blob('acc/blob', FILE_CHUNK + 3, 'image/png');
    expect(b.size).toBe(FILE_CHUNK + 3);
    await expect(s.read('acc/blob', 2, 1)).rejects.toThrow();
    await s.delete('acc/blob');
    await s.delete('acc/blob'); // already gone: fine
    await expect(s.blob('acc/blob', 1, 'x')).rejects.toThrow();
  });

  it('the runtime choice: OPFS when it works, IndexedDB otherwise or when preferred', async () => {
    const db = memDb();
    await db.open();
    expect((await new FileStores(db, 'auto', async () => new FakeOpfsDir()).preferred()).kind).toBe('opfs');
    const old = new FakeOpfsDir();
    old.noWritable = true;
    expect((await new FileStores(db, 'auto', async () => old).preferred()).kind).toBe('idb');
    expect((await new FileStores(db, 'auto', async () => Promise.reject(new Error('no'))).preferred()).kind).toBe('idb');
    expect((await new FileStores(db, 'idb', async () => new FakeOpfsDir()).preferred()).kind).toBe('idb');
    // Node has no navigator.storage.getDirectory: IndexedDB.
    expect((await new FileStores(db).preferred()).kind).toBe('idb');
    await expect(new FileStores(db).of('opfs')).rejects.toThrow('OPFS');
  });
});
