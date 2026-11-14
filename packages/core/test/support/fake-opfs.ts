// A minimal in-memory Origin Private File System for tests (the parts files.ts uses).

import type { OpfsDirectory, OpfsFile, OpfsWritable } from '../../src/files.ts';

/** Shared byte budget of one fake OPFS tree (QuotaExceededError when spent). */
export class FakeQuota {
  constructor(public left = Infinity) {}
}

class FakeFileHandle implements OpfsFile {
  data: Uint8Array = new Uint8Array(0);
  writes = 0;

  constructor(private readonly quota: FakeQuota) {}

  async getFile(): Promise<Blob> {
    return new Blob([this.data as Uint8Array<ArrayBuffer>]);
  }

  async createWritable(options: { keepExistingData?: boolean } = {}): Promise<OpfsWritable> {
    let buf = options.keepExistingData ? this.data.slice() : new Uint8Array(0);
    return {
      write: async ({ position, data }) => {
        if (data.length > this.quota.left) throw new DOMException('quota', 'QuotaExceededError');
        this.quota.left -= data.length;
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
  quota = new FakeQuota();

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsDirectory> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!options.create) throw new DOMException('not found', 'NotFoundError');
      d = new FakeOpfsDir();
      d.noWritable = this.noWritable;
      d.quota = this.quota;
      this.dirs.set(name, d);
    }
    return d;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<OpfsFile> {
    let f = this.files.get(name);
    if (!f) {
      if (!options.create) throw new DOMException('not found', 'NotFoundError');
      f = new FakeFileHandle(this.quota);
      this.files.set(name, f);
    }
    if (this.noWritable) return { getFile: () => f.getFile() } as unknown as OpfsFile;
    return f;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (this.files.delete(name)) return;
    const d = this.dirs.get(name);
    if (!d) throw new DOMException('not found', 'NotFoundError');
    if (!options.recursive && (d.files.size > 0 || d.dirs.size > 0)) throw new DOMException('not empty', 'InvalidModificationError');
    this.dirs.delete(name);
  }

  /** Total bytes stored below this folder. */
  bytes(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.data.length;
    for (const d of this.dirs.values()) n += d.bytes();
    return n;
  }
}
