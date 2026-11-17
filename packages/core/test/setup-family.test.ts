// Setting up a family with the server admin code: the root family of a fresh
// server, a new family at /f/<id> of the same fcd, a lost answer repeated
// with the same key and identity, no code over plain HTTP to another
// computer, and a 0.1.0 server whose one-time code joins directly.

import { afterEach, describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/api/transport.ts';
import { isSecureServer, rootServerUrl, SETTING_FAMILY_SETUP } from '../src/accounts.ts';
import { createCore, type FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { FakeServer } from './support/fake-server.ts';
import { FAST, memDb } from './support/helpers.ts';

const cores: FamilyChatCore[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

const ID = 'abcdefghijklmnop';

/**
 * One fcd: the root at https://one.test, a family at /f/<ID>; POST
 * /v1/families answers the root's setup code until the root is set up, then
 * the family's. `lose` drops the next answers of that request.
 */
function fcd() {
  const root = new FakeServer({ familyName: 'Ивановы' });
  const fam = new FakeServer({ familyName: 'Петровы' });
  root.rootSetUp = false;
  const creates: { key: string | null; body: Record<string, unknown> }[] = [];
  let lose = 0;
  const fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v1/families' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      creates.push({ key: new Headers(init.headers).get('idempotency-key'), body });
      if (body.adminCode !== 'SERV-ERCO-DE00-0000') {
        return new Response(JSON.stringify({ error: 'bad_admin_code', message: 'x' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      const atRoot = root.rootSetUp === false;
      const res = new Response(
        JSON.stringify({
          familyId: atRoot ? null : ID,
          path: atRoot ? '' : `/f/${ID}`,
          setupCode: atRoot ? root.adminCode : fam.adminCode,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
      if (lose > 0) {
        lose--;
        throw new TypeError('fetch failed');
      }
      return res;
    }
    if (u.pathname.startsWith(`/f/${ID}/`)) return fam.fetch(url.replace(`/f/${ID}`, ''), init);
    return root.fetch(url, init);
  };
  return { root, fam, creates, fetch, loseNext: (n: number) => (lose = n) };
}

function core(fetch: FetchFn, db = memDb()): FamilyChatCore {
  const c = createCore({ db, fetch, ...FAST });
  cores.push(c);
  return c;
}

describe('setUpFamily', () => {
  it('addresses: the root of a family address; HTTPS or this computer only', () => {
    expect(rootServerUrl(`https://chat.example.org/f/${ID}/`)).toBe('https://chat.example.org');
    expect(rootServerUrl('https://chat.example.org/sub/')).toBe('https://chat.example.org/sub');
    expect(rootServerUrl(`https://chat.example.org/sub/f/${ID}`)).toBe('https://chat.example.org/sub');
    expect(isSecureServer('https://chat.example.org')).toBe(true);
    expect(isSecureServer('http://127.0.0.1:8787')).toBe(true);
    expect(isSecureServer('http://localhost:8787')).toBe(true);
    expect(isSecureServer('http://192.168.1.5:8787')).toBe(false);
  });

  it('the root family of a fresh server, then a second family from another device', async () => {
    const s = fcd();
    const mama = core(s.fetch);
    await mama.start();
    const a = await mama.setUpFamily({ serverUrl: 'https://one.test', serverCode: 'SERV-ERCO-DE00-0000', familyName: 'ignored', name: 'Мама' });
    expect(a.familyUrl).toBe('https://one.test');
    expect(a.admin).toBe(true);
    // The root name stays the server's; nothing named for the root.
    expect(s.creates[0]!.body.familyName).toBeUndefined();
    s.root.rootSetUp = true;

    // From the same device (the root already here): a new family at /f/<id> with the same identity.
    const b = await mama.setUpFamily({ serverUrl: 'https://one.test', serverCode: 'SERV-ERCO-DE00-0000', familyName: 'Петровы', name: 'Мама', userId: a.userId });
    expect(b.familyUrl).toBe(`https://one.test/f/${ID}`);
    expect(b.userId).toBe(a.userId);
    expect(b.familyName).toBe('Петровы');
    expect(s.creates[1]!.body.familyName).toBe('Петровы');
    expect((await mama.accountList()).map((x) => x.serverUrl).sort()).toEqual(['https://one.test', `https://one.test/f/${ID}`]);
    // The pending state is gone after success.
    expect(await mama.db.settings.get(SETTING_FAMILY_SETUP)).toBeUndefined();
  });

  it('a lost answer is repeated with the same key, and the identity is kept', async () => {
    const s = fcd();
    s.root.rootSetUp = true;
    const c = core(s.fetch);
    await c.start();
    s.loseNext(1);
    await expect(c.setUpFamily({ serverUrl: 'https://one.test', serverCode: 'SERV-ERCO-DE00-0000', familyName: 'Петровы', name: 'Петя' })).rejects.toThrow();
    // The join's answer is lost too, after the server took it.
    s.fam.loseAnswer.push({ match: 'POST /v1/join', times: 1 });
    await expect(c.setUpFamily({ serverUrl: 'https://one.test', serverCode: 'SERV-ERCO-DE00-0000', familyName: 'Петровы', name: 'Петя' })).rejects.toThrow();
    const r = await c.setUpFamily({ serverUrl: 'https://one.test', serverCode: 'SERV-ERCO-DE00-0000', familyName: 'Петровы', name: 'Петя' });
    const keys = new Set(s.creates.map((x) => x.key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[a-z2-7]{26}$/);
    // One member on the family's server: the second join with the same identity was already_member.
    expect(s.fam.users.size).toBe(1);
    expect(s.fam.users.has(r.userId)).toBe(true);
  });

  it('never sends the server code over plain HTTP to another computer', async () => {
    const s = fcd();
    const c = core(s.fetch);
    await c.start();
    const e = await c.setUpFamily({ serverUrl: 'http://192.168.1.5:8787', serverCode: 'SERV-ERCO-DE00-0000', name: 'Мама' }).catch((x) => x);
    expect(isCoreError(e, 'insecure-server')).toBe(true);
    expect(s.creates).toHaveLength(0);
  });

  it('a 0.1.0 server: the one-time code joins its only family', async () => {
    const old = new FakeServer({ familyName: 'Старые' });
    const c = core(old.fetch);
    await c.start();
    const r = await c.setUpFamily({ serverUrl: 'https://old.test', serverCode: old.adminCode, familyName: 'X', name: 'Мама' });
    expect(r.familyUrl).toBe('https://old.test');
    expect(r.admin).toBe(true);
  });
});
