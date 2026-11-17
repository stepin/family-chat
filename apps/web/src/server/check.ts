/**
 * Server check: `/v1/hello`,
 * a long request through whatever provides HTTPS, and a test Web Push. No DOM
 * here, so it is unit-tested; the page wiring lives in main.ts.
 *
 * `describeCheckFailure` is the one table of answers, keyed by the error code
 * (not the message text): the `/server/` page and the app's "Server check"
 * section both use it.
 *
 * The administrator code is passed to requests only and never appears in the
 * report or in the stored log.
 *
 * The texts follow the page language (lib/page-lang.ts).
 */

import { pageLang, tr } from '../lib/page-lang.ts';

export interface Hello {
  protocol: number;
  server: string;
  version: string;
  serverId: string;
  familyName: string;
  retentionDays: number;
  maxFileMb: number;
  push: boolean;
  vapidPublicKey: string | null;
  time: number;
  adminCodeActive?: boolean;
  /** At the root address of fcd 1.0: the root family is set up. */
  rootSetUp?: boolean;
  /** A Telegram bot token is set (sticker sets by link). */
  telegramStickers?: boolean;
}

/** Why a check failed, in a shape both the page and the app can fill. */
export interface CheckFailure {
  /** HTTP status, 0 without an answer. */
  status: number;
  /** Server error code (`error` of the body). */
  code?: string | undefined;
  /** `reason` of `push_failed`. */
  reason?: string | undefined;
  /** `Retry-After`, seconds. */
  retryAfterSec?: number | undefined;
  /** The answer was not JSON: a page of a proxy, not of fcd. */
  notJson?: boolean;
  /** No answer: the network failed, or our own timeout or cancel ended it. */
  noAnswer?: 'network' | 'aborted';
  /** Time from the start of the request, ms. */
  ms: number;
}

export type Outcome<T> =
  | { ok: true; value: T; ms: number }
  | ({ ok: false; error: string } & CheckFailure);

export interface LogEntry {
  /** Milliseconds since the epoch, local clock. */
  at: number;
  ok: boolean | null;
  text: string;
}

/**
 * Trims, adds `https://` when no scheme is given, drops a trailing
 * `/server/` (the page itself), query and slash. The path stays: a family at
 * `https://host/f/<id>` is checked at its own address.
 */
/** The checks take a code now: the family's join code, or the server code before the root family is set up. */
export function codeWorks(h: Pick<Hello, 'adminCodeActive' | 'rootSetUp'>): boolean {
  return h.adminCodeActive !== false || h.rootSetUp === false;
}

export function normalizeServerUrl(input: string, fallback: string): string {
  const raw = input.trim() || fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    const path = u.pathname.replace(/\/(server\/?|server\/index\.html)$/, '/').replace(/\/+$/, '');
    return `${u.origin}${path}`;
  } catch {
    return fallback;
  }
}

/** The family whose page this is: the page address without its `/server/` tail. */
export function familyOfPage(href: string): string {
  const u = new URL(href);
  return normalizeServerUrl(`${u.origin}${u.pathname}`, u.origin);
}

/** Upper case, no spaces; dashes kept as typed (the server ignores them). */
export function normalizeAdminCode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sameBytes(a: ArrayBuffer | Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (x.byteLength !== b.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== b[i]) return false;
  return true;
}

export function describeError(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return tr('истекло время ожидания', 'timed out');
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

type Fetch = typeof fetch;

async function failure(res: Response, ms: number): Promise<{ ok: false; error: string } & CheckFailure> {
  const ra = Number(res.headers.get('retry-after'));
  const base = { status: res.status, ms, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  try {
    const j = (await res.json()) as { error?: string; message?: string; reason?: string };
    return {
      ok: false,
      ...base,
      code: j.error,
      reason: j.reason,
      error: `HTTP ${res.status}${j.error ? ` ${j.error}` : ''}${j.message ? `: ${j.message}` : ''}`,
    };
  } catch {
    return { ok: false, ...base, notJson: true, error: `HTTP ${res.status}` };
  }
}

async function call<T>(f: Fetch, url: string, init: RequestInit): Promise<Outcome<T>> {
  const t0 = performance.now();
  try {
    const res = await f(url, { ...init, cache: 'no-store', credentials: 'omit' });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return failure(res, ms);
    return { ok: true, value: (await res.json()) as T, ms };
  } catch (e) {
    const aborted = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, status: 0, noAnswer: aborted ? 'aborted' : 'network', error: describeError(e), ms: Math.round(performance.now() - t0) };
  }
}

function authHeaders(code: string): Record<string, string> {
  return { Authorization: `Bearer ${normalizeAdminCode(code)}` };
}

export function fetchHello(base: string, f: Fetch = fetch): Promise<Outcome<Hello>> {
  return call<Hello>(f, `${base}/v1/hello`, { signal: AbortSignal.timeout(15_000) });
}

export interface WaitResult {
  seconds: number;
  startedAt: number;
  finishedAt: number;
}

export function longRequest(base: string, code: string, seconds: number, f: Fetch = fetch): Promise<Outcome<WaitResult>> {
  return call<WaitResult>(f, `${base}/v1/check/wait?seconds=${seconds}`, {
    headers: authHeaders(code),
    signal: AbortSignal.timeout(seconds * 1000 + 10_000),
  });
}

export interface PushResult {
  sent: boolean;
  scheduled?: boolean;
  sendAt?: number;
  outcome?: { status: number; service: string };
}

export function sendTestPush(
  base: string,
  code: string,
  subscription: PushSubscriptionJSON,
  delaySeconds: number,
  f: Fetch = fetch,
): Promise<Outcome<PushResult>> {
  return call<PushResult>(f, `${base}/v1/check/push`, {
    method: 'POST',
    headers: { ...authHeaders(code), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, delaySeconds, from: 'page' }),
    signal: AbortSignal.timeout(40_000),
  });
}

/** Host of a push endpoint; the full endpoint is a secret capability URL. */
export function pushServiceHost(endpoint: string | undefined): string {
  if (!endpoint) return tr('нет', 'none');
  try {
    return new URL(endpoint).host;
  } catch {
    return tr('неизвестно', 'unknown');
  }
}

export interface ReportInput {
  now: Date;
  pageUrl: string;
  server: string;
  userAgent: string;
  standalone: boolean;
  secureContext: boolean;
  notificationPermission: string;
  pushSupported: boolean;
  pushService: string;
  hello: Outcome<Hello> | null;
  /** Server clock minus device clock, seconds, measured with hello. */
  clockOffsetSec: number | null;
  log: LogEntry[];
}

function time(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatLogEntry(e: LogEntry): string {
  const mark = e.ok === true ? 'OK' : e.ok === false ? tr('ОШИБКА', 'FAILED') : '--';
  return `${new Date(e.at).toISOString().slice(0, 10)} ${time(e.at)} [${mark}] ${e.text}`;
}

/** Plain-text report for the owner to send back. Contains no secrets. */
export function formatReport(r: ReportInput): string {
  const page = new URL(r.pageUrl);
  const yes = tr('да', 'yes');
  const no = tr('нет', 'no');
  const lines = [
    tr('Family Chat: проверка сервера', 'Family Chat: server check'),
    `${tr('Время', 'Time')}: ${r.now.toISOString()}`,
    `${tr('Страница', 'Page')}: ${page.origin}${page.pathname}`,
    `${tr('Сервер', 'Server')}: ${r.server}`,
    `${tr('Браузер', 'Browser')}: ${r.userAgent}`,
    `${tr('HTTPS (защищённый контекст)', 'HTTPS (secure context)')}: ${r.secureContext ? yes : no}`,
    `${tr('Открыто как установленное приложение', 'Opened as an installed app')}: ${r.standalone ? yes : no}`,
    `${tr('Push в браузере', 'Push in the browser')}: ${r.pushSupported ? tr('есть', 'yes') : no}`,
    `${tr('Разрешение на уведомления', 'Notification permission')}: ${r.notificationPermission}`,
    `${tr('Push-сервис подписки', 'Push service of the subscription')}: ${r.pushService}`,
    '',
  ];
  if (!r.hello) lines.push(tr('hello: не запрашивался', 'hello: not requested'));
  else if (r.hello.ok) {
    const h = r.hello.value;
    lines.push(
      tr(`hello: OK за ${r.hello.ms} мс`, `hello: OK in ${r.hello.ms} ms`),
      tr(`  fcd ${h.version}, протокол ${h.protocol}, serverId ${h.serverId}`, `  fcd ${h.version}, protocol ${h.protocol}, serverId ${h.serverId}`),
      tr(
        `  семья «${h.familyName}», хранение ${h.retentionDays} дн., файл до ${h.maxFileMb} МБ`,
        `  family “${h.familyName}”, kept for ${h.retentionDays} days, files up to ${h.maxFileMb} MB`,
      ),
      tr(
        `  push ${h.push ? 'включён' : 'выключен'}, код администратора ${codeWorks(h) ? 'действует' : 'уже использован'}`,
        `  push ${h.push ? 'on' : 'off'}, admin code ${codeWorks(h) ? 'active' : 'already used'}`,
      ),
      tr(`  стикеры Telegram по ссылке: ${h.telegramStickers ? 'включено' : 'выключено'}`, `  Telegram stickers by link: ${h.telegramStickers ? 'on' : 'off'}`),
      tr(`  часы сервера минус часы устройства: ${r.clockOffsetSec ?? '?'} с`, `  server clock minus device clock: ${r.clockOffsetSec ?? '?'} s`),
    );
  } else lines.push(tr(`hello: ОШИБКА ${r.hello.error} (${r.hello.ms} мс)`, `hello: FAILED ${r.hello.error} (${r.hello.ms} ms)`));
  lines.push('', tr('Журнал проверок:', 'Check log:'));
  if (r.log.length === 0) lines.push(tr('  (пусто)', '  (empty)'));
  for (const e of r.log) lines.push(`  ${formatLogEntry(e)}`);
  return lines.join('\n');
}

/** Long-request duration: `?wait=N` on the page (used by the e2e test), else 25. */
export function waitSecondsFromQuery(search: string): number {
  const v = Number(new URLSearchParams(search).get('wait'));
  return Number.isInteger(v) && v >= 1 && v <= 60 ? v : 25;
}

// ---- the one table of check answers ----

/** Project documentation (the project's GitHub repository). */
export const DOCS_BASE = 'https://github.com/stepin/family-chat/blob/main/docs';

export type CheckLink = 'proxy' | 'push' | 'faq';

/** Address of a documentation section in the given language. */
export function docsLink(link: CheckLink, lang: 'ru' | 'en'): string {
  const en = lang === 'en';
  switch (link) {
    case 'proxy':
      return en ? `${DOCS_BASE}/en/ADMIN.md#reverse-proxy` : `${DOCS_BASE}/ADMIN.md#обратный-прокси`;
    case 'push':
      return en ? `${DOCS_BASE}/en/ADMIN.md#settings` : `${DOCS_BASE}/ADMIN.md#настройки`;
    case 'faq':
      return en ? `${DOCS_BASE}/en/FAQ.md#notifications-do-not-arrive` : `${DOCS_BASE}/FAQ.md#уведомления-не-приходят`;
  }
}

export type CheckKind =
  | 'cut'
  | 'no-answer'
  | 'aborted'
  | 'bad-code'
  | 'unknown-device'
  | 'not-admin'
  | 'rate-limited'
  | 'too-many-pending'
  | 'restarting'
  | 'push-rejected'
  | 'push-unreachable'
  | 'push-disabled'
  | 'no-subscription'
  | 'bad-subscription'
  | 'other';

export interface CheckMessage {
  kind: CheckKind;
  text: string;
  link: CheckLink | null;
}

export interface DescribeOptions {
  /** Who asked: the `/server/` page (administrator code) or the app (device token). */
  context: 'page' | 'app';
  /** The failed request was the long request of this many seconds. */
  longRequestSeconds?: number;
  /** "Settings → Family and server → Server check", built from the app's strings. */
  settingsPath: string;
  lang?: 'ru' | 'en';
}

/** Seconds to wait from `Retry-After`, else "a minute". */
function waitText(sec: number | undefined, L: (ru: string, en: string) => string): string {
  return sec ? L(`${sec} с`, `${sec} s`) : L('минуту', 'a minute');
}

/** What to tell a person about a failed check (one row per case, keyed by code). */
export function describeCheckFailure(f: CheckFailure, o: DescribeOptions): CheckMessage {
  const lang = o.lang ?? pageLang;
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const m = (kind: CheckKind, text: string, link: CheckLink | null = null): CheckMessage => ({ kind, text, link });
  const long = o.longRequestSeconds;
  const sec = Math.round(f.ms / 1000);
  if (f.noAnswer === 'aborted') return m('aborted', L('Проверка прервана.', 'The check was stopped.'));
  // A long request cut on the way: the connection broke after it started, or a
  // proxy answered with its own error page before the server's answer was due.
  if (
    long !== undefined &&
    ((f.noAnswer === 'network' && f.ms >= 1000) ||
      ((f.status === 502 || f.status === 504) && f.notJson === true && f.ms < long * 1000))
  ) {
    return m(
      'cut',
      L(
        `Соединение оборвалось через ${sec} с: прокси обрывает долгие запросы, увеличьте таймаут.`,
        `The connection broke after ${sec} s: the proxy cuts long requests, raise its timeout.`,
      ),
      'proxy',
    );
  }
  if (f.noAnswer === 'network' || f.notJson === true) return m('no-answer', L('Сервер не ответил.', 'The server didn’t answer.'));
  switch (f.status) {
    case 401:
      return o.context === 'page'
        ? m(
            'bad-code',
            L(
              `Код не подходит. Если семья уже настроена, проверьте сервер в приложении: ${o.settingsPath}.`,
              `The code doesn’t match. If the family is already set up, check the server in the app: ${o.settingsPath}.`,
            ),
          )
        : m('unknown-device', L('Устройство не узнано сервером, войдите заново.', 'The server doesn’t know this device; sign in again.'));
    case 403:
      return m('not-admin', L('Вы больше не администратор.', 'You are no longer an administrator.'));
    case 429:
      if (f.code === 'too_many_pending') {
        return m(
          'too-many-pending',
          L('Уже ждут отправки три пробных уведомления, подождите несколько минут.', 'Three test notifications are already waiting; wait a few minutes.'),
        );
      }
      return m('rate-limited', L(`Слишком много попыток, подождите ${waitText(f.retryAfterSec, L)}.`, `Too many attempts, wait ${waitText(f.retryAfterSec, L)}.`));
    case 503:
      return m('restarting', L('Сервер перезапускается, попробуйте через минуту.', 'The server is restarting; try again in a minute.'));
    case 502:
      if (f.code === 'push_failed' && f.reason === 'network') {
        return m(
          'push-unreachable',
          L('Сервер не достучался до push-сервиса, попробуйте позже.', 'The server couldn’t reach the push service; try again later.'),
          'faq',
        );
      }
      if (f.code === 'push_failed') {
        return m(
          'push-rejected',
          L(
            'Push-сервис отклонил подписку: выключите и включите уведомления на этом устройстве.',
            'The push service refused the subscription: turn notifications off and on again on this device.',
          ),
          'faq',
        );
      }
      break;
    case 409:
      if (f.code === 'push_disabled') return m('push-disabled', L('Уведомления на сервере выключены.', 'Notifications are off on the server.'), 'push');
      if (f.code === 'no_subscription') {
        return m('no-subscription', L('Уведомления на этом устройстве не включены.', 'Notifications aren’t on for this device.'));
      }
      break;
    case 400:
      return m(
        'bad-subscription',
        L('Подписка устройства не подходит, включите уведомления заново.', 'The device subscription doesn’t fit; turn notifications on again.'),
      );
  }
  return m('other', L(`Ошибка сервера: HTTP ${f.status}${f.code ? ` ${f.code}` : ''}.`, `Server error: HTTP ${f.status}${f.code ? ` ${f.code}` : ''}.`));
}

/**
 * A failed core call (ApiError / NetworkError of @family-chat/core) as a
 * CheckFailure. Duck-typed, so the /server/ page bundle does not pull in core.
 * Our own timeout or cancel is "aborted", never a cut proxy.
 */
export function failureFromError(e: unknown, ms: number): CheckFailure {
  const x = (e ?? {}) as { name?: unknown; status?: unknown; code?: unknown; reason?: unknown; retryAfterMs?: unknown };
  if (x.name === 'NetworkError') {
    return { status: 0, noAnswer: x.reason === 'offline' ? 'network' : 'aborted', ms };
  }
  if (x.name === 'ApiError' && typeof x.status === 'number') {
    const code = typeof x.code === 'string' ? x.code : undefined;
    return {
      status: x.status,
      code: code === 'unexpected_response' ? undefined : code,
      notJson: code === 'unexpected_response',
      reason: typeof x.reason === 'string' ? x.reason : undefined,
      retryAfterSec: typeof x.retryAfterMs === 'number' ? Math.round(x.retryAfterMs / 1000) : undefined,
      ms,
    };
  }
  return { status: 0, noAnswer: 'network', ms };
}
