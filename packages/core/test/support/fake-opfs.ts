// A minimal in-memory Origin Private File System for tests (the parts files.ts uses).

import type { OpfsDirectory, OpfsFile, OpfsWritable } from '../../src/files.ts';

class FakeFileHandle implements OpfsFile {
  data: Uint8Array = new Uint8Array(0);
  writes = 0;

  async getFile(): Promise<Blob> {
    return new Blob([this.data as Uint8Array<ArrayBuffer>]);
  }

  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<OpfsWritable> {
    let buf = options.keepExistingData ? this.data.slice() : new Uint8Array(0);
    return {
      write: async ({ position, data }) => {
        const end = position + data.length;
        if (end > buf.length) {
          const n = new Uint8Array(end);
          n.set(buf);
          buf = n;
        }
        buf.set(data, position);
      },
      close: async () => {
        this.data = buf;
        this.writes++;
      },
      abort: async () => undefined,
    };
  }
}

export class FakeOpfsDir implements OpfsDirectory {
  readonly files = new Map<string, FakeFileHandle>();
  readonly dirs = new Map<string, FakeOpfsDir>();
  /** Simulates a platform without writable streams (older Safari). */
  noWritable = false;

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsDirectory> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!options.create) throw new DOMException('not found', 'NotFoundError');
      d = new FakeOpfsDir();
      d.noWritable = this.noWritable;
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsFile> {
    let f = this.files.get(name);
    if (!f) {
      if (!options.create) throw new DOMException('not found', 'NotFoundError');
      f = new FakeFileHandle();
      this.files.set(name, f);
    }
    if (this.noWritable) return { getFile: () => f.getFile() } as unknown as OpfsFile;
    return f;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }
}
