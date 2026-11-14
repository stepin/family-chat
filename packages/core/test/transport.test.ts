import { describe, expect, it } from 'vitest';
import { ApiError, isApiError, isNetworkError, isServerErrorCode, isTransient, NetworkError } from '../src/api/errors.ts';
import { normalizeServerUrl, Transport, type ExchangeInfo, type FetchFn } from '../src/api/transport.ts';
import type { Clock } from '../src/util/clock.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function stub(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const ENV = { payload: 'cGF5', sig: 'c2ln' };
const USER = { userId: 'u1', identity: ENV, profile: ENV, admin: true, removed: false };
const EV = { gseq: 3, time: 10, chatId: 'c1', senderId: 'u1', devId: 'd1', epoch: 0, msgId: 'm1', body: 'AQID' };
const TOKEN = 'tok-secret-0123456789';

function client(respond: (call: Call) => Response | Promise<Response>, extra: Partial<ConstructorParameters<typeof Transport>[0]> = {}) {
  const s = stub(respond);
  const log: ExchangeInfo[] = [];
  const t = new Transport({ baseUrl: 'https://fc.test/', fetch: s.fetch, onExchange: (x) => log.push(x), ...extra });
  return { t, calls: s.calls, log };
}

describe('normalizeServerUrl', () => {
  it('adds https and strips the trailing slash, query and fragment', () => {
    expect(normalizeServerUrl(' chat.example.org/ ')).toBe('https://chat.example.org');
    expect(normalizeServerUrl('http://192.168.1.2:8787/')).toBe('http://192.168.1.2:8787');
    expect(normalizeServerUrl('https://x.org/fc/?a=1#invite=abc')).toBe('https://x.org/fc');
  });
  it('rejects other schemes and credentials', () => {
    expect(() => normalizeServerUrl('ftp://x.org')).toThrow(TypeError);
    expect(() => normalizeServerUrl('https://u:p@x.org')).toThrow(TypeError);
  });
});

describe('Transport', () => {
  it('hello', async () => {
    const hello = {
      protocol: 1,
      server: 'fcd',
      version: '0.1.0',
      serverId: 'sid',
      familyName: 'Семья',
      retentionDays: 90,
      maxFileMb: 200,
      push: false,
      vapidPublicKey: null,
      time: 5,
      maxEventBytes: 262144,
      adminCodeActive: true,
      m0: false,
    };
    const { t, calls } = client(() => json(hello));
    // An M1 server sends no limits: the defaults of docs/API.md 1.7 fill in.
    expect(await t.hello()).toEqual({
      ...hello,
      maxPartBytes: 4194560,
      maxBlobBytes: 200 * 1048576 + 65536,
      maxAvatarBytes: 262144,
      maxStateBytes: 262144,
      maxSealedKeyBytes: 8192,
      maxGroupMembers: 100,
    });
    expect(calls[0]!.url).toBe('https://fc.test/v1/hello');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('join, challenge, auth/device', async () => {
    const issued = { token: TOKEN, userId: 'u1', devId: 'd1', admin: false };
    const { t, calls } = client((c) =>
      c.url.endsWith('/challenge') ? json({ nonce: 'n', expiresAt: 9 }) : json(issued),
    );
    expect(await t.join({ invite: 'code', identity: ENV, profile: ENV, devId: 'd1' })).toEqual(issued);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ invite: 'code', identity: ENV, profile: ENV, devId: 'd1' });
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(await t.authChallenge()).toEqual({ nonce: 'n', expiresAt: 9 });
    expect(calls[1]!.init.method).toBe('POST');
    expect(await t.authDevice(ENV)).toEqual(issued);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual(ENV);
  });

  it('users, me, profile, push', async () => {
    const { t, calls } = client((c) => {
      if (c.url.endsWith('/v1/users')) return json({ users: [USER, { ...USER, userId: 'u2', profile: null }] });
      if (c.url.endsWith('/v1/me')) return json({ ...USER, devId: 'd1', push: true });
      if (c.url.endsWith('/v1/me/profile')) return json({ profile: ENV });
      return new Response(null, { status: 204 });
    });
    const users = await t.users(TOKEN);
    expect(users).toHaveLength(2);
    expect(users[1]!.profile).toBeNull();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(await t.me(TOKEN)).toMatchObject({ devId: 'd1', push: true, userId: 'u1' });
    expect(await t.putProfile(TOKEN, ENV)).toEqual(ENV);
    expect(calls[2]!.init.method).toBe('PUT');
    await t.putPush(TOKEN, { endpoint: 'https://p', keys: { p256dh: 'k', auth: 'a' }, expirationTime: null });
    expect(JSON.parse(calls[3]!.init.body as string)).toEqual({
      endpoint: 'https://p',
      keys: { p256dh: 'k', auth: 'a' },
      expirationTime: null,
    });
    await t.deletePush(TOKEN);
    expect(calls[4]!.init.method).toBe('DELETE');
  });

  it('chats, events, history, post', async () => {
    const page = { events: [EV], cursor: 3, more: false, oldestGseq: 1 };
    const { t, calls, log } = client((c) => {
      if (c.url.endsWith('/v1/chats')) {
        return json({ chats: [{ chatId: 'c1', kind: 'dm', members: ['a', 'b'], epoch: 0, createdAt: 1, lastGseq: null, lastTime: null }] });
      }
      if (c.init.method === 'POST') return json({ gseq: 4, time: 11, duplicate: true });
      return json(page);
    });
    expect((await t.chats(TOKEN))[0]).toMatchObject({ chatId: 'c1', lastGseq: null, members: ['a', 'b'] });
    const p = await t.events(TOKEN, { after: 2, limit: 10, wait: 99 });
    expect(calls[1]!.url).toBe('https://fc.test/v1/events?after=2&limit=10&wait=30');
    expect(p.events[0]!.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(p.cursor).toBe(3);
    await t.events(TOKEN);
    expect(calls[2]!.url).toBe('https://fc.test/v1/events');
    await t.chatEvents(TOKEN, 'c1', { before: 7, limit: 5 });
    expect(calls[3]!.url).toBe('https://fc.test/v1/chats/c1/events?before=7&limit=5');
    const body = new Uint8Array([9, 9]);
    expect(await t.postEvent(TOKEN, { chatId: 'c1', msgId: 'm1', epoch: 0, body })).toEqual({ gseq: 4, time: 11, duplicate: true });
    const h = calls[4]!.init.headers as Record<string, string>;
    expect(h['Idempotency-Key']).toBe('m1');
    expect(h['X-FC-Epoch']).toBe('0');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(calls[4]!.init.body).toBe(body);
    expect(log.find((x) => x.path === '/v1/events')?.events).toBe(1);
    expect(log.map((x) => x.path)).toContain('/v1/chats/{chatId}/events');
  });

  it('admin endpoints', async () => {
    const { t, calls } = client((c) => {
      const u = c.url;
      if (c.init.method === 'DELETE') return new Response(null, { status: 204 });
      if (u.endsWith('/v1/admin/invites') && c.init.method === 'POST') {
        return json({ id: 'h', code: 'code', createdAt: 1, expiresAt: 2 }, 201);
      }
      if (u.endsWith('/v1/admin/invites')) {
        return json({ invites: [{ id: 'h', createdAt: 1, expiresAt: 2, createdBy: 'u1', usedAt: null, usedBy: null }] });
      }
      if (u.endsWith('/v1/admin/users')) {
        return json({ users: [{ userId: 'u1', name: 'Мама', admin: true, removed: false, removedAt: null, devices: [{ devId: 'd', createdAt: 1, push: false }] }] });
      }
      return json({
        version: '0.1.0',
        dataBytes: 1,
        freeBytes: null,
        totalBytes: 3,
        events: 4,
        oldestGseq: 1,
        lastGseq: 4,
        users: 1,
        removedUsers: 0,
        chats: 1,
        retentionDays: 90,
        push: true,
      });
    });
    expect(await t.createInvite(TOKEN)).toEqual({ id: 'h', code: 'code', createdAt: 1, expiresAt: 2 });
    expect((await t.listInvites(TOKEN))[0]!.usedBy).toBeNull();
    await t.revokeInvite(TOKEN, 'h/x');
    expect(calls[2]!.url).toBe('https://fc.test/v1/admin/invites/h%2Fx');
    expect((await t.adminUsers(TOKEN))[0]!.devices[0]!.devId).toBe('d');
    await t.removeUser(TOKEN, 'u2');
    expect(calls[4]!.url).toBe('https://fc.test/v1/admin/users/u2');
    expect((await t.stats(TOKEN)).freeBytes).toBeNull();
  });

  it('maps error bodies to ApiError with details and Retry-After', async () => {
    const { t, log } = client(() => json({ error: 'rate_limited', message: `secret ${TOKEN}`, limit: 5 }, 429, { 'Retry-After': '7' }));
    const e = await t.join({ adminCode: 'X', identity: ENV, profile: ENV, devId: 'd' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    const a = e as ApiError;
    expect(a.status).toBe(429);
    expect(a.code).toBe('rate_limited');
    expect(a.retryAfterMs).toBe(7000);
    expect(a.details).toEqual({ limit: 5 });
    expect(a.message).toBe('POST /v1/join: HTTP 429 rate_limited');
    expect(a.message).not.toContain(TOKEN);
    expect(isTransient(a)).toBe(true);
    expect(log[0]).toMatchObject({ status: 429, error: 'rate_limited', method: 'POST', path: '/v1/join' });
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it('treats unknown codes, HTML and broken JSON as unexpected_response', async () => {
    const { t: t1 } = client(() => json({ error: 'whatever' }, 418));
    await expect(t1.hello()).rejects.toMatchObject({ code: 'unexpected_response', status: 418 });
    const { t: t2 } = client(() => new Response('<html>portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const e2 = await t2.hello().catch((x: unknown) => x);
    expect(isApiError(e2, 'unexpected_response')).toBe(true);
    expect(isTransient(e2)).toBe(true);
    const { t: t3 } = client(() => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(t3.hello()).rejects.toMatchObject({ code: 'unexpected_response' });
    const { t: t4 } = client(() => json({ protocol: 'one' }));
    await expect(t4.hello()).rejects.toMatchObject({ code: 'unexpected_response' });
    const { t: t5 } = client(() => json({ events: [{ ...EV, body: 'not base64!' }], cursor: 1, more: false, oldestGseq: 1 }));
    await expect(t5.events(TOKEN)).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it('network failure, timeout and abort', async () => {
    const { t, log } = client(() => {
      throw new TypeError('fetch failed');
    });
    const e = await t.hello().catch((x: unknown) => x);
    expect(isNetworkError(e)).toBe(true);
    expect((e as NetworkError).reason).toBe('offline');
    expect(isTransient(e)).toBe(true);
    expect(log[0]).toMatchObject({ status: 0, error: 'offline' });

    // A fetch that never answers until aborted.
    const hang: FetchFn = (_u, init) =>
      new Promise((_r, reject) => {
        if (init.signal?.aborted) reject(new DOMException('a', 'AbortError'));
        init.signal?.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')));
      });
    const timers: (() => void)[] = [];
    const clock: Clock = {
      now: () => 0,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {},
    };
    const t2 = new Transport({ baseUrl: 'https://fc.test', fetch: hang, clock, timeoutMs: 10 });
    const p = t2.hello().catch((x: unknown) => x);
    await Promise.resolve();
    timers[0]!();
    expect(await p).toMatchObject({ name: 'NetworkError', reason: 'timeout' });

    const t3 = new Transport({ baseUrl: 'https://fc.test', fetch: hang });
    const ctl = new AbortController();
    const p3 = t3.events(TOKEN, { wait: 25 }, ctl.signal).catch((x: unknown) => x);
    ctl.abort();
    const e3 = await p3;
    expect(e3).toMatchObject({ reason: 'aborted' });
    expect(isTransient(e3)).toBe(false);
    // Already aborted signal.
    expect(await t3.hello(ctl.signal).catch((x: unknown) => x)).toMatchObject({ reason: 'aborted' });
  });

  it('long poll timeout covers the wait', async () => {
    let timeout = 0;
    const clock: Clock = {
      now: () => 0,
      setTimeout: (_fn, ms) => {
        timeout = ms;
        return 1;
      },
      clearTimeout: () => {},
    };
    const t = new Transport({
      baseUrl: 'https://fc.test',
      clock,
      timeoutMs: 1000,
      fetch: async () => json({ events: [], cursor: 0, more: false, oldestGseq: 1 }),
    });
    await t.events(TOKEN, { wait: 25 });
    expect(timeout).toBe(26_000);
  });

  it('error helpers', () => {
    expect(isServerErrorCode('removed')).toBe(true);
    expect(isServerErrorCode('nope')).toBe(false);
    expect(isTransient(new ApiError(507, 'storage_full', 'x'))).toBe(true);
    expect(isTransient(new ApiError(403, 'not_member', 'x'))).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
    expect(isApiError(new ApiError(401, 'unauthorized', 'x'), 'unauthorized')).toBe(true);
    expect(isApiError(new ApiError(401, 'unauthorized', 'x'), 'removed')).toBe(false);
  });

  it('an exchange hook that throws does not break the request', async () => {
    const t = new Transport({
      baseUrl: 'https://fc.test',
      fetch: async () => json({ nonce: 'n', expiresAt: 1 }),
      onExchange: () => {
        throw new Error('boom');
      },
    });
    expect(await t.authChallenge()).toEqual({ nonce: 'n', expiresAt: 1 });
  });
});
