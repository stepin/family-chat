/**
 * WebDavStorage against real servers from tools/dav-dev (`pnpm dav:up`).
 * Node's fetch does not enforce CORS: this checks WebDAV semantics only;
 * CORS is covered by the Playwright probe tests in apps/web.
 */
import { describe, expect, it } from 'vitest';
import { WebDavStorage } from '../src/storage/webdav.ts';
import { StorageError } from '../src/storage/errors.ts';

const servers = {
  'apache (no CORS)': 'http://127.0.0.1:18080/family-chat/',
  dufs: 'http://127.0.0.1:18081/family-chat/',
  'nginx recipe': 'http://127.0.0.1:18082/family-chat/',
  'caddy recipe': 'http://127.0.0.1:18083/family-chat/',
};

const enc = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

for (const [name, url] of Object.entries(servers)) {
  describe(name, () => {
    const storage = new WebDavStorage({ url, username: 'fc', password: 'secret' });
    const dir = `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/`;

    it('round-trips files and folders', async () => {
      await storage.mkdir(dir);
      await storage.mkdir(dir); // idempotent
      await storage.mkdir(`${dir}2026-11-14/`);
      await storage.put(`${dir}2026-11-14/a.fc1`, enc('hello'));
      await storage.put(`${dir}2026-11-14/b.fc1`, new Uint8Array(300_000));
      const list = await storage.list(`${dir}2026-11-14/`);
      expect(list.map((e) => [e.name, e.size]).sort()).toEqual([
        ['a.fc1', 5],
        ['b.fc1', 300_000],
      ]);
      expect((await storage.list(dir)).map((e) => [e.name, e.isDir])).toEqual([['2026-11-14', true]]);
      expect(new TextDecoder().decode(await storage.get(`${dir}2026-11-14/a.fc1`))).toBe('hello');
      expect(storage.serverTime()?.serverMs).toBeTypeOf('number');
      await storage.delete(`${dir}2026-11-14/a.fc1`);
      await expect(storage.get(`${dir}2026-11-14/a.fc1`)).rejects.toMatchObject({ kind: 'NotFound' });
      await storage.delete(dir);
      await expect(storage.list(dir)).rejects.toMatchObject({ kind: 'NotFound' });
    });

    it('maps a wrong password to Auth', async () => {
      const bad = new WebDavStorage({ url, username: 'fc', password: 'nope' });
      const err = await bad.list('').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).kind).toBe('Auth');
    });
  });
}
