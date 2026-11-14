import { describe, expect, it } from 'vitest';
import { FakeDav } from '@family-chat/core/testing';
import { formatReport, runProbe, type ProbeEnvironment, type ProbeReport } from './probe.ts';

const ORIGIN = 'https://chat.example.net';
const env: ProbeEnvironment = {
  pageOrigin: ORIGIN,
  userAgent: 'vitest',
  isSecureContext: true,
  localNetworkAccess: 'granted',
  standalone: false,
};

interface CorsOptions {
  /** none: no CORS at all; no-errors: CORS only on 2xx; full: everywhere. */
  cors?: 'full' | 'none' | 'no-errors';
  exposeDate?: boolean;
  maxAge?: number | null;
  allowOrigin?: string;
  unreachable?: boolean;
  /** Extra server behaviour applied before CORS. */
  server?: (req: { method: string; url: string; bodyBytes: number }) => Response | null;
}

const SAFELISTED = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

/** Emulates what a browser page sees for cross-origin requests with credentials: 'omit'. */
function browser(inner: typeof fetch, o: CorsOptions = {}): typeof fetch {
  const cors = o.cors ?? 'full';
  const allowOrigin = o.allowOrigin ?? ORIGIN;
  const maxAge = o.maxAge === undefined ? 7200 : o.maxAge;
  const exposed = new Set<string>([
    ...(o.exposeDate === false ? [] : ['date']),
    'access-control-max-age',
    'access-control-allow-origin',
    'content-security-policy',
  ]);
  return async (input, init) => {
    if (o.unreachable) throw new TypeError('Failed to fetch');
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    const simple = (method === 'GET' || method === 'HEAD') && !headers.has('authorization') && !headers.has('depth');
    if (!simple && cors === 'none') throw new TypeError('Failed to fetch: preflight');
    const corsHeaders = (res: Headers): Headers => {
      const out = new Headers();
      res.forEach((v, k) => {
        if (SAFELISTED.has(k) || exposed.has(k)) out.set(k, v);
      });
      out.set('access-control-allow-origin', allowOrigin);
      if (maxAge !== null) out.set('access-control-max-age', String(maxAge));
      return out;
    };
    if (method === 'OPTIONS') {
      const h = new Headers({ date: new Date().toUTCString() });
      return new Response(null, { status: 204, headers: corsHeaders(h) });
    }
    const body = init?.body;
    const bodyBytes = body instanceof Uint8Array ? body.byteLength : body instanceof Blob ? body.size : 0;
    const res = o.server?.({ method, url, bodyBytes }) ?? (await inner(input, init));
    if (cors === 'none') throw new TypeError('Failed to fetch: no ACAO');
    if (cors === 'no-errors' && res.status >= 400) throw new TypeError('Failed to fetch: no ACAO on error');
    const buf = res.status === 204 || res.status === 201 ? null : await res.arrayBuffer();
    return new Response(buf, { status: res.status, headers: corsHeaders(res.headers) });
  };
}

function setup(o: CorsOptions = {}, password = 'secret'): { dav: FakeDav; run: () => Promise<ProbeReport> } {
  const dav = new FakeDav('https://dav.example.net');
  dav.mkdirp('/webdav/family-chat');
  dav.mkdirp('/webdav/other');
  return {
    dav,
    run: () =>
      runProbe({
        url: 'https://dav.example.net/webdav/family-chat/',
        username: 'fc',
        password,
        environment: env,
        fetch: browser(dav.fetch, o),
        largeBytes: 64 * 1024,
      }),
  };
}

const status = (r: ProbeReport, id: string): string | undefined => r.checks.find((c) => c.id === id)?.status;
const leftovers = (dav: FakeDav): string[] => [...dav.files.keys()].filter((k) => k.includes('fc-probe-'));

describe('runProbe', () => {
  it('passes a server with full CORS', async () => {
    const { dav, run } = setup();
    const r = await run();
    expect(r.verdictText).toBe('Сервер подходит');
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.checks.filter((c) => c.status === 'skip')).toEqual([]);
    expect(status(r, 'delete-recursive')).toBe('ok');
    expect(status(r, 'scope')).toBe('warn'); // the account also sees /webdav/other
    expect(leftovers(dav)).toEqual([]);
  });

  it('says "Нужна настройка сервера" without CORS and stops', async () => {
    const { dav, run } = setup({ cors: 'none' });
    const r = await run();
    expect(r.verdict).toBe('needs-setup');
    expect(r.verdictText).toBe('Нужна настройка сервера');
    expect(status(r, 'reachable')).toBe('ok');
    expect(status(r, 'cors')).toBe('fail');
    expect(status(r, 'mkcol')).toBe('skip');
    expect(r.nextAction).toContain('CORS');
    expect(r.nextActionUrl).toBe('https://github.com/stepin/family-chat/blob/main/docs/recipes/README.md');
    expect(leftovers(dav)).toEqual([]);
  });

  it('needs setup when Date is not exposed', async () => {
    const { run } = setup({ exposeDate: false });
    const r = await run();
    expect(r.verdict).toBe('needs-setup');
    expect(status(r, 'date')).toBe('fail');
    expect(status(r, 'delete-recursive')).toBe('ok');
  });

  it('needs setup when error responses lack CORS headers', async () => {
    const { dav, run } = setup({ cors: 'no-errors' });
    const r = await run();
    expect(r.verdict).toBe('needs-setup');
    expect(status(r, 'errors-cors')).toBe('fail');
    expect(leftovers(dav)).toEqual([]);
  });

  it('only warns about a missing Access-Control-Max-Age and a wildcard origin', async () => {
    const { run } = setup({ maxAge: null, allowOrigin: '*' });
    const r = await run();
    expect(r.verdict).toBe('suitable');
    expect(status(r, 'preflight-cache')).toBe('warn');
  });

  it('is unsuitable with a rejected password and hints at Digest', async () => {
    const { run } = setup({}, 'wrong');
    const r = await run();
    expect(r.verdictText).toBe('Не подходит');
    expect(status(r, 'auth')).toBe('fail');
    expect(r.summary).toContain('Digest');
  });

  it('is unsuitable when the server does not answer', async () => {
    const { run } = setup({ unreachable: true });
    const r = await run();
    expect(r.verdict).toBe('unsuitable');
    expect(status(r, 'reachable')).toBe('fail');
  });

  it('is unsuitable when PROPFIND returns an HTML page', async () => {
    const { dav, run } = setup();
    dav.quirks = { htmlInsteadOfListing: true };
    const r = await run();
    expect(r.verdict).toBe('unsuitable');
    expect(status(r, 'webdav')).toBe('fail');
  });

  it('is unsuitable when 5 MB uploads are rejected, and cleans up', async () => {
    const { dav, run } = setup({
      server: ({ method, bodyBytes }) => (method === 'PUT' && bodyBytes > 1000 ? new Response('too big', { status: 413 }) : null),
    });
    const r = await run();
    expect(r.verdict).toBe('unsuitable');
    expect(status(r, 'put-large')).toBe('fail');
    expect(leftovers(dav)).toEqual([]);
  });

  it('needs HTTPS for non-local addresses', async () => {
    const dav = new FakeDav('http://dav.example.net');
    const r = await runProbe({ url: 'http://dav.example.net/x/', username: 'a', password: 'b', environment: env, fetch: browser(dav.fetch) });
    expect(r.verdict).toBe('needs-setup');
    expect(status(r, 'https')).toBe('fail');
  });

  it('accepts plain HTTP on loopback for development', async () => {
    const dav = new FakeDav('http://127.0.0.1:18081');
    dav.mkdirp('/family-chat');
    const r = await runProbe({
      url: 'http://127.0.0.1:18081/family-chat/',
      username: 'fc',
      password: 'secret',
      environment: env,
      fetch: browser(dav.fetch),
      largeBytes: 1024,
    });
    expect(status(r, 'https')).toBe('ok');
    expect(r.verdict).toBe('suitable');
  });

  it('rejects a malformed address', async () => {
    const r = await runProbe({ url: 'not a url', username: 'a', password: 'b', environment: env });
    expect(r.verdict).toBe('unsuitable');
  });

  it('produces a report with raw exchanges and without the password', async () => {
    const { run } = setup({}, 'secret');
    const r = await run();
    const text = formatReport(r, 'secret');
    expect(text).toContain('Вердикт: Сервер подходит');
    expect(text).toContain('PROPFIND');
    expect(text).toContain('multistatus');
    expect(text).not.toContain('secret');
    expect(text).not.toContain(btoa('fc:secret'));
  });
});
