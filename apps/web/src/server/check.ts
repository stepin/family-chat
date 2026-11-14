/**
 * Server check for M0v2 (docs/PLAN-v2.md, section 9): `/v1/hello`, a long
 * request through whatever provides HTTPS, and a test Web Push. No DOM here,
 * so it is unit-tested; the page wiring lives in main.ts.
 *
 * The administrator code is passed to requests only and never appears in the
 * report or in the stored log.
 */

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
  m0: boolean;
}

export type Outcome<T> = { ok: true; value: T; ms: number } | { ok: false; error: string; status?: number; ms: number };

export interface LogEntry {
  /** Milliseconds since the epoch, local clock. */
  at: number;
  ok: boolean | null;
  text: string;
}

/** Trims, adds `https://` when no scheme is given, drops path and trailing slash. */
export function normalizeServerUrl(input: string, fallback: string): string {
  const raw = input.trim() || fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    return u.origin;
  } catch {
    return fallback;
  }
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
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'истекло время ожидания';
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    return `HTTP ${res.status}${j.error ? ` ${j.error}` : ''}${j.message ? `: ${j.message}` : ''}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, url: string, init: RequestInit): Promise<Outcome<T>> {
  const t0 = performance.now();
  try {
    const res = await f(url, { ...init, cache: 'no-store', credentials: 'omit' });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, error: await errorText(res), status: res.status, ms };
    return { ok: true, value: (await res.json()) as T, ms };
  } catch (e) {
    return { ok: false, error: describeError(e), ms: Math.round(performance.now() - t0) };
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
  return call<WaitResult>(f, `${base}/v1/m0/wait?seconds=${seconds}`, {
    headers: authHeaders(code),
    signal: AbortSignal.timeout((seconds + 30) * 1000),
  });
}

export interface PushResult {
  sent: boolean;
  scheduled?: boolean;
  sendAt?: number;
  outcome?: { status: number; service: string; detail?: string };
}

export function sendTestPush(
  base: string,
  code: string,
  subscription: PushSubscriptionJSON,
  delaySeconds: number,
  f: Fetch = fetch,
): Promise<Outcome<PushResult>> {
  return call<PushResult>(f, `${base}/v1/m0/push`, {
    method: 'POST',
    headers: { ...authHeaders(code), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, delaySeconds }),
    signal: AbortSignal.timeout(40_000),
  });
}

/** Host of a push endpoint; the full endpoint is a secret capability URL. */
export function pushServiceHost(endpoint: string | undefined): string {
  if (!endpoint) return 'нет';
  try {
    return new URL(endpoint).host;
  } catch {
    return 'неизвестно';
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
  const mark = e.ok === true ? 'OK' : e.ok === false ? 'ОШИБКА' : '--';
  return `${new Date(e.at).toISOString().slice(0, 10)} ${time(e.at)} [${mark}] ${e.text}`;
}

/** Plain-text report for the owner to send back. Contains no secrets. */
export function formatReport(r: ReportInput): string {
  const page = new URL(r.pageUrl);
  const lines = [
    'Family Chat: проверка сервера (M0v2)',
    `Время: ${r.now.toISOString()}`,
    `Страница: ${page.origin}${page.pathname}`,
    `Сервер: ${r.server}`,
    `Браузер: ${r.userAgent}`,
    `HTTPS (защищённый контекст): ${r.secureContext ? 'да' : 'нет'}`,
    `Открыто как установленное приложение: ${r.standalone ? 'да' : 'нет'}`,
    `Push в браузере: ${r.pushSupported ? 'есть' : 'нет'}`,
    `Разрешение на уведомления: ${r.notificationPermission}`,
    `Push-сервис подписки: ${r.pushService}`,
    '',
  ];
  if (!r.hello) lines.push('hello: не запрашивался');
  else if (r.hello.ok) {
    const h = r.hello.value;
    lines.push(
      `hello: OK за ${r.hello.ms} мс`,
      `  fcd ${h.version}, протокол ${h.protocol}, serverId ${h.serverId}`,
      `  семья «${h.familyName}», хранение ${h.retentionDays} дн., файл до ${h.maxFileMb} МБ`,
      `  push ${h.push ? 'включён' : 'выключен'}, проверки M0 ${h.m0 ? 'включены' : 'выключены'}`,
      `  часы сервера минус часы устройства: ${r.clockOffsetSec ?? '?'} с`,
    );
  } else lines.push(`hello: ОШИБКА ${r.hello.error} (${r.hello.ms} мс)`);
  lines.push('', 'Журнал проверок:');
  if (r.log.length === 0) lines.push('  (пусто)');
  for (const e of r.log) lines.push(`  ${formatLogEntry(e)}`);
  return lines.join('\n');
}

/** Long-request duration: `?wait=N` on the page (used by the e2e test), else 25. */
export function waitSecondsFromQuery(search: string): number {
  const v = Number(new URLSearchParams(search).get('wait'));
  return Number.isInteger(v) && v >= 1 && v <= 60 ? v : 25;
}
