import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlToBytes,
  describeCheckFailure,
  docsLink,
  failureFromError,
  fetchHello,
  formatReport,
  longRequest,
  normalizeServerUrl,
  pushServiceHost,
  sameBytes,
  sendTestPush,
  waitSecondsFromQuery,
  type CheckFailure,
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
  adminCodeActive: true,
  offerSetup: false,
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
    expect(url).toBe('https://s.example/v1/check/wait?seconds=2');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer ABCD-EFGHIJKL');
    expect(init!.credentials).toBe('omit');
  });

  it('reports server errors with status and code', async () => {
    const f = async () => jsonResponse({ error: 'unauthorized', message: 'administrator code required' }, 401);
    const r = await sendTestPush('https://s.example', 'x', { endpoint: 'https://p' }, 60, f as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 401, code: 'unauthorized', error: 'HTTP 401 unauthorized: administrator code required' });
    const net = async () => {
      throw new TypeError('Load failed');
    };
    const h = await fetchHello('https://s.example', net as typeof fetch);
    expect(h).toMatchObject({ ok: false, status: 0, noAnswer: 'network', error: 'TypeError: Load failed' });
    // A proxy's own page is not JSON; Retry-After is read.
    const proxy = async () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'Retry-After': '7' } });
    const p = await longRequest('https://s.example', 'x', 25, proxy as typeof fetch);
    expect(p).toMatchObject({ ok: false, status: 502, notJson: true, retryAfterSec: 7 });
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

  it('the report in English when the page speaks English', () => {
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
      expect(report).toContain('Family Chat: server check');
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

describe('the one table of check answers', () => {
  const path = 'Настройки → Семья и сервер → Проверка сервера';
  const page = (f: Partial<CheckFailure> & { ms?: number }, longRequestSeconds?: number) =>
    describeCheckFailure({ status: 0, ms: 0, ...f }, { context: 'page', settingsPath: path, lang: 'ru', ...(longRequestSeconds ? { longRequestSeconds } : {}) });
  const app = (f: Partial<CheckFailure>, longRequestSeconds?: number) =>
    describeCheckFailure({ status: 0, ms: 0, ...f }, { context: 'app', settingsPath: path, lang: 'ru', ...(longRequestSeconds ? { longRequestSeconds } : {}) });

  it('a long request cut on the way: network error after 1 s, or a proxy page before the answer was due', () => {
    expect(app({ noAnswer: 'network', ms: 12_400 }, 25)).toMatchObject({ kind: 'cut', link: 'proxy' });
    expect(app({ noAnswer: 'network', ms: 12_400 }, 25).text).toContain('через 12 с');
    expect(app({ status: 504, notJson: true, ms: 10_000 }, 25)).toMatchObject({ kind: 'cut' });
    expect(app({ status: 502, notJson: true, ms: 10_000 }, 25)).toMatchObject({ kind: 'cut' });
  });

  it('no answer: an error under a second, a refused connection, DNS', () => {
    expect(app({ noAnswer: 'network', ms: 200 }, 25)).toMatchObject({ kind: 'no-answer', text: 'Сервер не ответил.' });
    expect(app({ noAnswer: 'network', ms: 3000 })).toMatchObject({ kind: 'no-answer' });
  });

  it('our own timeout or cancel is "stopped", never a cut proxy', () => {
    expect(app({ noAnswer: 'aborted', ms: 30_000 }, 25)).toMatchObject({ kind: 'aborted' });
    expect(failureFromError({ name: 'NetworkError', reason: 'timeout' }, 35_000)).toMatchObject({ noAnswer: 'aborted' });
    expect(failureFromError({ name: 'NetworkError', reason: 'offline' }, 5)).toMatchObject({ noAnswer: 'network' });
  });

  it('401: the page points to the app, the app asks to sign in again', () => {
    const p = page({ status: 401, code: 'admin_code_inactive' });
    expect(p.kind).toBe('bad-code');
    expect(p.text).toContain(path);
    expect(app({ status: 401, code: 'unauthorized' })).toMatchObject({ kind: 'unknown-device' });
  });

  it('403, 429 with and without Retry-After, too many pending', () => {
    expect(app({ status: 403, code: 'not_admin' }).text).toBe('Вы больше не администратор.');
    expect(page({ status: 429, code: 'rate_limited', retryAfterSec: 42 }).text).toBe('Слишком много попыток, подождите 42 с.');
    expect(page({ status: 429, code: 'rate_limited' }).text).toBe('Слишком много попыток, подождите минуту.');
    expect(app({ status: 429, code: 'too_many_pending' })).toMatchObject({ kind: 'too-many-pending' });
  });

  it('503, 502 push_failed, 409 push_disabled and no_subscription, 400, other', () => {
    expect(app({ status: 503, code: 'shutting_down' })).toMatchObject({ kind: 'restarting' });
    expect(app({ status: 502, code: 'push_failed', reason: 'gone' })).toMatchObject({ kind: 'push-rejected', link: 'faq' });
    expect(app({ status: 502, code: 'push_failed', reason: 'network' })).toMatchObject({ kind: 'push-unreachable' });
    expect(app({ status: 409, code: 'push_disabled' })).toMatchObject({ kind: 'push-disabled', link: 'push', text: 'Уведомления на сервере выключены.' });
    expect(app({ status: 409, code: 'no_subscription' })).toMatchObject({ kind: 'no-subscription' });
    expect(app({ status: 400, code: 'bad_request' })).toMatchObject({ kind: 'bad-subscription' });
    expect(app({ status: 418, code: 'teapot' })).toMatchObject({ kind: 'other' });
    expect(failureFromError({ name: 'ApiError', status: 502, code: 'unexpected_response' }, 9)).toMatchObject({ notJson: true, code: undefined });
  });

  it('speaks English and links the English docs', () => {
    const en = describeCheckFailure({ status: 503, ms: 0, code: 'shutting_down' }, { context: 'app', settingsPath: 'x', lang: 'en' });
    expect(en.text).toBe('The server is restarting; try again in a minute.');
    expect(docsLink('proxy', 'en')).toBe('https://github.com/stepin/family-chat/blob/main/docs/en/ADMIN.md#reverse-proxy');
    expect(docsLink('proxy', 'ru')).toContain('/docs/ADMIN.md#');
  });
});
