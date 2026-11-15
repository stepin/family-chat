import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlToBytes,
  fetchHello,
  formatReport,
  longRequest,
  normalizeServerUrl,
  pushServiceHost,
  sameBytes,
  sendTestPush,
  waitSecondsFromQuery,
  type Hello,
} from './check.ts';
import { setPageLang } from '../lib/page-lang.ts';

const hello: Hello = {
  protocol: 1,
  server: 'fcd',
  version: '0.1.0',
  serverId: 'abc',
  familyName: 'Ивановы',
  retentionDays: 90,
  maxFileMb: 200,
  push: true,
  vapidPublicKey: 'BAAA',
  time: 1_700_000_000_000,
  m0: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('server check', () => {
  it('normalizes server addresses', () => {
    expect(normalizeServerUrl('', 'http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServerUrl(' chat.example.net/ ', 'x')).toBe('https://chat.example.net');
    expect(normalizeServerUrl('http://192.168.1.10:8787/server/', 'x')).toBe('http://192.168.1.10:8787');
    expect(normalizeServerUrl('ftp://a', 'fallback')).toBe('fallback');
  });

  it('decodes base64url keys', () => {
    const b = base64UrlToBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    expect(b.length).toBe(65);
    expect(b[0]).toBe(4);
    expect(sameBytes(b.buffer, b)).toBe(true);
    expect(sameBytes(null, b)).toBe(false);
  });

  it('sends the admin code only as a bearer header, without cookies', async () => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ seconds: 2, startedAt: 1, finishedAt: 2001 }),
    );
    const r = await longRequest('https://s.example', 'abcd-efgh ijkl', 2, f as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://s.example/v1/m0/wait?seconds=2');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer ABCD-EFGHIJKL');
    expect(init!.credentials).toBe('omit');
  });

  it('reports server errors with status and code', async () => {
    const f = async () => jsonResponse({ error: 'unauthorized', message: 'administrator code required' }, 401);
    const r = await sendTestPush('https://s.example', 'x', { endpoint: 'https://p' }, 60, f as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 401, error: 'HTTP 401 unauthorized: administrator code required' });
    const net = async () => {
      throw new TypeError('Load failed');
    };
    const h = await fetchHello('https://s.example', net as typeof fetch);
    expect(h).toMatchObject({ ok: false, error: 'TypeError: Load failed' });
  });

  it('builds a report without secrets', () => {
    const code = 'K7PM-2QXD-9WRT-HB3F';
    const report = formatReport({
      now: new Date(1_700_000_000_000),
      pageUrl: 'https://chat.example.net/server/?wait=2#x',
      server: 'https://chat.example.net',
      userAgent: 'UA',
      standalone: true,
      secureContext: true,
      notificationPermission: 'granted',
      pushSupported: true,
      pushService: pushServiceHost('https://web.push.apple.com/QGx-secret-token'),
      hello: { ok: true, value: hello, ms: 12 },
      clockOffsetSec: 0,
      log: [{ at: 1_700_000_000_000, ok: true, text: 'длинный запрос 25 с: ответ через 25.0 с' }],
    });
    expect(report).toContain('Страница: https://chat.example.net/server/');
    expect(report).toContain('Push-сервис подписки: web.push.apple.com');
    expect(report).toContain('семья «Ивановы»');
    expect(report).toContain('[OK] длинный запрос');
    expect(report).not.toContain(code);
    expect(report).not.toContain('secret-token');
    expect(report).not.toContain('wait=2');
  });

  it('M7: the report in English when the page speaks English', () => {
    setPageLang('en');
    try {
      const report = formatReport({
        now: new Date(1_700_000_000_000),
        pageUrl: 'https://chat.example.net/server/',
        server: 'https://chat.example.net',
        userAgent: 'UA',
        standalone: false,
        secureContext: true,
        notificationPermission: 'default',
        pushSupported: false,
        pushService: pushServiceHost(undefined),
        hello: { ok: true, value: hello, ms: 12 },
        clockOffsetSec: 1,
        log: [],
      });
      expect(report).toContain('Family Chat: server check (M0v2)');
      expect(report).toContain('Opened as an installed app: no');
      expect(report).toContain('family “Ивановы”');
      expect(report).toContain('Check log:');
      expect(report).not.toMatch(/Время|Страница|Журнал/);
    } finally {
      setPageLang('ru');
    }
  });

  it('reads the long-request duration from the query', () => {
    expect(waitSecondsFromQuery('')).toBe(25);
    expect(waitSecondsFromQuery('?wait=2')).toBe(2);
    expect(waitSecondsFromQuery('?wait=61')).toBe(25);
    expect(waitSecondsFromQuery('?wait=abc')).toBe(25);
  });
});
