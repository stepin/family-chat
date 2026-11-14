import { beforeEach, describe, expect, it } from 'vitest';
import { WebDavStorage, type DavExchange } from '../src/storage/webdav.ts';
import { StorageError, isStorageError, kindForStatus } from '../src/storage/errors.ts';
import { FakeDav } from '../src/testing/fake-dav.ts';

const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof StorageError) return `${e.kind}/${e.reason}`;
    throw e;
  }
}

describe('WebDavStorage', () => {
  let dav: FakeDav;
  let storage: WebDavStorage;
  let exchanges: DavExchange[];

  beforeEach(() => {
    dav = new FakeDav();
    dav.mkdirp('/webdav/family-chat');
    exchanges = [];
    storage = new WebDavStorage({
      url: 'https://user:pw@dav.test/webdav/family-chat?x=1#y',
      username: 'fc',
      password: 'secret',
      fetch: dav.fetch,
      now: () => 1_000,
      observer: (e) => exchanges.push(e),
    });
  });

  it('normalises the root and never puts credentials into URLs', () => {
    expect(storage.root.href).toBe('https://dav.test/webdav/family-chat/');
    expect(storage.url('log/2026-11-14/').pathname).toBe('/webdav/family-chat/log/2026-11-14/');
  });

  it('rejects invalid path segments', async () => {
    for (const p of ['../x', 'a/../b', 'A', 'a b', 'x/./y', 'a'.repeat(65)]) {
      expect(await kindOf(storage.get(p))).toBe('Fatal/invalid-path');
    }
  });

  it('mkdir, put, list, get, delete', async () => {
    await storage.mkdir('log');
    await storage.mkdir('log/2026-11-14/');
    await storage.put('log/2026-11-14/a.txt', bytes('hello'));
    await storage.put('log/2026-11-14/b.bin', new Blob([bytes('xyz')]));
    const entries = await storage.list('log/2026-11-14');
    expect(entries.map((e) => [e.name, e.isDir, e.size]).sort()).toEqual([
      ['a.txt', false, 5],
      ['b.bin', false, 3],
    ]);
    expect(entries[0]?.mtime).toBeTypeOf('number');
    expect(text(await storage.get('log/2026-11-14/a.txt'))).toBe('hello');
    await storage.delete('log/2026-11-14/a.txt');
    expect(await kindOf(storage.get('log/2026-11-14/a.txt'))).toBe('NotFound/http');
    await storage.delete('log/');
    expect(await kindOf(storage.list('log/'))).toBe('NotFound/http');
  });

  it('lists the root and marks collections', async () => {
    await storage.mkdir('users');
    await storage.put('server.json', bytes('{}'));
    const entries = await storage.list('');
    expect(entries.map((e) => [e.name, e.isDir]).sort()).toEqual([
      ['server.json', false],
      ['users', true],
    ]);
  });

  it('mkdir succeeds when the collection exists and fails when a file has the name', async () => {
    await storage.mkdir('chats');
    await storage.mkdir('chats');
    await storage.put('x', bytes('1'));
    expect(await kindOf(storage.mkdir('x'))).toBe('Conflict/not-a-collection');
  });

  it('mkdir without parent is a Conflict', async () => {
    expect(await kindOf(storage.mkdir('a/b'))).toBe('Conflict/http');
  });

  it('handles absolute and prefixed hrefs', async () => {
    await storage.mkdir('d');
    await storage.put('d/f', bytes('1'));
    dav.quirks = { absoluteHrefs: true };
    expect((await storage.list('d/')).map((e) => e.name)).toEqual(['f']);
    dav.quirks = { hrefPrefix: '/proxy' };
    expect((await storage.list('d/')).map((e) => e.name)).toEqual(['f']);
  });

  it('decodes percent-encoded names', async () => {
    dav.files.set('/webdav/family-chat/a b', { dir: false, data: bytes('1'), mtime: new Date() });
    expect((await storage.list('')).map((e) => e.name)).toEqual(['a b']);
  });

  it('treats a 200 HTML answer to PROPFIND as transient, not as an empty folder', async () => {
    dav.quirks = { htmlInsteadOfListing: true };
    expect(await kindOf(storage.list(''))).toBe('Transient/not-multistatus');
  });

  it('treats a truncated listing as transient', async () => {
    dav.quirks = { truncateListing: true };
    expect(await kindOf(storage.list(''))).toBe('Transient/bad-xml');
  });

  it('enforces the listing size limit', async () => {
    const small = new WebDavStorage({ url: 'https://dav.test/webdav/family-chat/', username: 'fc', password: 'secret', fetch: dav.fetch, maxListingBytes: 100 });
    expect(await kindOf(small.list(''))).toBe('Fatal/listing-too-large');
  });

  it('maps 207 on DELETE with a failed member to an error', async () => {
    await storage.mkdir('d');
    dav.quirks = { multiStatusDelete: true };
    expect(await kindOf(storage.delete('d/'))).toBe('Transient/http');
  });

  it('reports redirects as Fatal', async () => {
    await storage.mkdir('d');
    dav.quirks = { redirectNoSlash: true };
    expect(await kindOf(storage.get('d'))).toBe('Fatal/redirect');
  });

  it('maps a wrong password to Auth', async () => {
    const bad = new WebDavStorage({ url: 'https://dav.test/webdav/family-chat/', username: 'fc', password: 'nope', fetch: dav.fetch });
    expect(await kindOf(bad.list(''))).toBe('Auth/http');
  });

  it('records the server clock from Date, including on errors', async () => {
    dav.quirks = { date: 'Sat, 14 Nov 2026 10:00:00 GMT' };
    await kindOf(storage.get('missing'));
    expect(storage.serverTime()).toEqual({ serverMs: Date.parse('Sat, 14 Nov 2026 10:00:00 GMT'), localMs: 1_000 });
  });

  it('keeps no clock sample when Date is not readable', async () => {
    dav.quirks = { date: null };
    await storage.list('');
    expect(storage.serverTime()).toBeNull();
  });

  it('maps network errors to Transient', async () => {
    const s = new WebDavStorage({
      url: 'https://dav.test/',
      username: 'a',
      password: 'b',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await kindOf(s.list(''))).toBe('Transient/network');
  });

  it('maps timeouts to Transient and passes through caller aborts', async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const s = new WebDavStorage({ url: 'https://dav.test/', username: 'a', password: 'b', fetch: hang, timeoutMs: 10 });
    expect(await kindOf(s.list(''))).toBe('Transient/timeout');
    const ctl = new AbortController();
    const p = new WebDavStorage({ url: 'https://dav.test/', username: 'a', password: 'b', fetch: hang }).list('', { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('enforces maxBytes on get', async () => {
    await storage.put('big', new Uint8Array(1000));
    expect(await kindOf(storage.get('big', { maxBytes: 10 }))).toBe('Fatal/response-too-large');
  });

  it('sends Basic auth with UTF-8 credentials and never records the password', async () => {
    dav.auth = 'Basic ' + Buffer.from('мама:пароль', 'utf8').toString('base64');
    const s = new WebDavStorage({ url: 'https://dav.test/webdav/family-chat/', username: 'мама', password: 'пароль', fetch: dav.fetch, observer: (e) => exchanges.push(e) });
    await s.list('');
    const json = JSON.stringify(exchanges);
    expect(json).not.toContain(Buffer.from('мама:пароль', 'utf8').toString('base64'));
    expect(json).toContain('Basic <redacted>');
  });

  it('records exchanges with listing bodies', async () => {
    await storage.list('');
    const ex = exchanges.find((e) => e.method === 'PROPFIND');
    expect(ex?.status).toBe(207);
    expect(ex?.requestHeaders['Depth']).toBe('1');
    expect(ex?.responseBody).toContain('multistatus');
  });

  it('requests exactly three properties for listings', async () => {
    await storage.list('');
    const body = exchanges.find((e) => e.method === 'PROPFIND')?.requestBody ?? '';
    expect(body.match(/<d:(\w+)\/>/g)).toEqual(['<d:resourcetype/>', '<d:getcontentlength/>', '<d:getlastmodified/>']);
  });
});

describe('kindForStatus', () => {
  it('maps statuses', () => {
    expect([401, 403, 404, 409, 413, 429, 507, 503, 400, 405].map(kindForStatus)).toEqual([
      'Auth',
      'Forbidden',
      'NotFound',
      'Conflict',
      'TooLarge',
      'RateLimited',
      'Full',
      'Transient',
      'Fatal',
      'Fatal',
    ]);
    expect(isStorageError(new StorageError('Full', 'x'), 'Full')).toBe(true);
  });
});
