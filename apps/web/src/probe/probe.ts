/**
 * Compatibility probe (docs/PLAN.md 5, 6.11, 6.12; M0 in section 9).
 *
 * Runs on the client's origin, so it checks CORS for the address the client
 * will really use. Framework-free so that Vitest can run it against fakes.
 * Creates one temporary folder `fc-probe-<random>/` in the chat folder and
 * deletes it at the end.
 */
import { StorageError, WebDavStorage, type DavExchange } from '@family-chat/core';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'skip';
/** What a failed check means for the verdict. */
export type Impact = 'config' | 'fatal';
export type Verdict = 'suitable' | 'needs-setup' | 'unsuitable';

export const VERDICT_TEXT: Record<Verdict, string> = {
  suitable: 'Сервер подходит',
  'needs-setup': 'Нужна настройка сервера',
  unsuitable: 'Не подходит',
};

export const REPO_URL = 'https://github.com/stepin/family-chat';

/**
 * Where "Нужна настройка сервера" leads: the recipes in the public repository.
 * VITE_RECIPES_URL overrides it at build time (e.g. the site's docs page in M6).
 */
export const RECIPES_URL: string =
  (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_RECIPES_URL'] ||
  `${REPO_URL}/blob/main/docs/recipes/README.md`;

export const CHECKS = {
  https: 'HTTPS',
  reachable: 'Сервер отвечает',
  cors: 'CORS: запросы с адреса клиента',
  auth: 'Вход по Basic',
  webdav: 'Папка WebDAV (PROPFIND, ответ 207)',
  date: 'Заголовок Date и часы',
  'preflight-cache': 'Кэш предварительных запросов (Access-Control-Max-Age)',
  mkcol: 'Создание папки (MKCOL)',
  'errors-cors': 'CORS на ответах с ошибками',
  put: 'Запись файла (PUT)',
  list: 'Список файлов (PROPFIND Depth 1)',
  'put-large': 'Файл 5 МБ',
  html: 'Загруженный .html',
  delete: 'Удаление файла (DELETE)',
  space: 'Свободное место',
  'space-per-file': 'Место на маленький файл и на папку',
  'preflight-cost': 'Цена предварительных запросов',
  'delete-recursive': 'Рекурсивное удаление папки',
  scope: 'Что видит учётная запись кроме папки чата',
} as const;

export type CheckId = keyof typeof CHECKS;

export interface CheckResult {
  id: CheckId;
  title: string;
  status: CheckStatus;
  impact?: Impact;
  detail: string;
  data?: Record<string, unknown>;
}

export interface ProbeEnvironment {
  pageOrigin: string;
  userAgent: string;
  isSecureContext: boolean;
  localNetworkAccess: string;
  standalone: boolean;
}

export interface ProbeReport {
  probeVersion: number;
  startedAt: string;
  finishedAt: string;
  serverUrl: string;
  username: string;
  environment: ProbeEnvironment;
  verdict: Verdict;
  verdictText: string;
  summary: string;
  nextAction: string;
  /** Instructions link for the next action, if any. */
  nextActionUrl?: string;
  checks: CheckResult[];
  exchanges: DavExchange[];
}

export interface ProbeInput {
  url: string;
  username: string;
  password: string;
  environment: ProbeEnvironment;
  fetch?: typeof fetch;
  /** Called after every check with the list so far. */
  onProgress?: (checks: CheckResult[], running: CheckId | null) => void;
  /** Size of the large PUT. Default 5 MiB. */
  largeBytes?: number;
  random?: (n: number) => Uint8Array;
}

export const PROBE_VERSION = 1;
const SKEW_LIMIT_MS = 10 * 60 * 1000;
const SMALL_FILES = 8;
const KNOWN_ROOT_NAMES = new Set(['server.json', 'users', 'chats', 'log', 'blobs', 'packs', 'logpacks', 'app']);

class Stop extends Error {}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

function randomName(random: (n: number) => Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return [...random(10)].map((b) => alphabet[b % 32]).join('');
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} ГБ`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${n} Б`;
}

function errText(e: unknown): string {
  if (e instanceof StorageError) return e.status ? `HTTP ${e.status}` : e.reason === 'network' ? 'сетевая ошибка' : e.reason;
  return e instanceof Error ? e.message : String(e);
}

function header(ex: DavExchange | undefined, name: string): string | undefined {
  return ex?.responseHeaders?.find(([k]) => k.toLowerCase() === name)?.[1];
}

export function verdictOf(checks: CheckResult[]): Verdict {
  if (checks.some((c) => c.status === 'fail' && c.impact === 'fatal')) return 'unsuitable';
  if (checks.some((c) => c.status === 'fail')) return 'needs-setup';
  return 'suitable';
}

export async function runProbe(input: ProbeInput): Promise<ProbeReport> {
  const startedAt = new Date().toISOString();
  const random = input.random ?? defaultRandom;
  const exchanges: DavExchange[] = [];
  const checks: CheckResult[] = [];
  const env = input.environment;
  let storage: WebDavStorage;
  try {
    storage = new WebDavStorage({
      url: input.url.trim(),
      username: input.username,
      password: input.password,
      timeoutMs: 30_000,
      observer: (ex) => exchanges.push(ex),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  } catch {
    const c: CheckResult = {
      id: 'https',
      title: CHECKS.https,
      status: 'fail',
      impact: 'fatal',
      detail: 'Адрес не похож на адрес папки WebDAV. Пример: https://home.example.net/webdav/family-chat/',
    };
    return finish([c]);
  }
  const root = storage.root;
  const client = storage.client;
  const probeDir = `fc-probe-${randomName(random)}/`;
  let probeCreated = false;
  let recursiveDeleteOk = false;
  /** False when error responses come without CORS: 404 then looks like a network failure. */
  let errorsVisible = true;
  const invisible404 = (e: unknown): boolean =>
    !errorsVisible && e instanceof StorageError && e.kind === 'Transient' && e.reason === 'network';
  const smallFiles: string[] = [];

  function add(id: CheckId, status: CheckStatus, detail: string, extra: Partial<CheckResult> = {}): CheckResult {
    const c: CheckResult = { id, title: CHECKS[id], status, detail, ...extra };
    checks.push(c);
    input.onProgress?.([...checks], null);
    return c;
  }
  function fail(id: CheckId, impact: Impact, detail: string, data?: Record<string, unknown>): never {
    add(id, 'fail', detail, { impact, ...(data ? { data } : {}) });
    throw new Stop();
  }
  function running(id: CheckId): void {
    input.onProgress?.([...checks], id);
  }

  try {
    // 1. HTTPS
    running('https');
    if (root.protocol === 'https:') add('https', 'ok', 'Адрес начинается с https://.');
    else if (isLoopback(root.hostname)) add('https', 'ok', 'Локальный адрес без HTTPS: годится только для разработки.');
    else fail('https', 'config', 'Нужен HTTPS с действительным сертификатом: без него браузер не даст приложению работать.');
    if (!env.isSecureContext) {
      add('https', 'warn', 'Страница зонда открыта не по HTTPS: часть проверок браузера недоступна.');
    }

    // 2. Reachability without CORS (an opaque answer still proves the server is there).
    running('reachable');
    try {
      await client.send('GET', root, { auth: false, mode: 'no-cors' });
      add('reachable', 'ok', 'Сервер отвечает по этому адресу.');
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      const lna =
        env.localNetworkAccess === 'denied'
          ? ' Браузер запретил доступ к домашней сети: разрешите его в настройках сайта.'
          : '';
      fail(
        'reachable',
        'fatal',
        `Сервер не отвечает: проверьте адрес, сертификат HTTPS и доступ к сети с этого устройства.${lna}`,
      );
    }

    // 3-5. CORS, Basic auth, PROPFIND on the chat folder.
    running('cors');
    let rootStat;
    try {
      rootStat = await storage.stat('');
      add('cors', 'ok', `Сервер разрешает запросы с ${env.pageOrigin}.`);
      add('auth', 'ok', 'Логин и пароль подошли.');
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      if (e.reason === 'network' || e.reason === 'timeout') {
        fail(
          'cors',
          'config',
          `Сервер отвечает, но не разрешает запросы с ${env.pageOrigin}: нет заголовков CORS, или предварительный запрос (OPTIONS) требует пароль. Нужен сервер или прокси с CORS.`,
        );
      }
      add('cors', 'ok', `Сервер разрешает запросы с ${env.pageOrigin}.`);
      if (e.kind === 'Auth') {
        fail(
          'auth',
          'fatal',
          'Сервер отклонил логин и пароль (401). Проверьте их. Если они верны, сервер требует Digest: нужен сервер или прокси с Basic.',
        );
      }
      add('auth', 'ok', 'Сервер не отклонил логин и пароль.');
      if (e.kind === 'Forbidden') fail('webdav', 'fatal', 'Учётной записи запрещён доступ к этой папке (403).');
      if (e.kind === 'NotFound') fail('webdav', 'fatal', 'Папка не найдена (404). Создайте её на сервере или исправьте адрес.');
      if (e.reason === 'redirect') {
        fail('webdav', 'config', 'Сервер перенаправляет запрос. Укажите точный адрес папки со слешем в конце или уберите перенаправление.');
      }
      if (e.reason === 'not-multistatus') {
        fail('webdav', 'fatal', `Сервер ответил кодом ${e.status} вместо списка WebDAV (207): это не папка WebDAV или страница входа.`);
      }
      if (e.status === 405 || e.status === 501) fail('webdav', 'fatal', `Сервер не поддерживает PROPFIND (${e.status}): это не WebDAV.`);
      fail('webdav', 'fatal', `Не удалось прочитать папку: ${errText(e)}.`);
    }
    if (!rootStat?.isDir) fail('webdav', 'fatal', 'По этому адресу файл, а не папка.');
    add('webdav', 'ok', 'Папка читается, ответ 207 Multi-Status.');

    // 6. Date header.
    running('date');
    const t = storage.serverTime();
    if (!t) {
      add('date', 'fail', 'Браузер не видит заголовок Date. Нужен Access-Control-Expose-Headers: Date.', { impact: 'config' });
    } else {
      const skew = t.serverMs - t.localMs;
      const skewText = `${skew >= 0 ? '+' : ''}${Math.round(skew / 1000)} с`;
      if (Math.abs(skew) > SKEW_LIMIT_MS) {
        add('date', 'warn', `Часы сервера и устройства расходятся на ${skewText}. Клиент не пишет при расхождении больше 10 минут.`, {
          data: { skewMs: skew },
        });
      } else {
        add('date', 'ok', `Date виден; расхождение часов ${skewText}.`, { data: { skewMs: skew } });
      }
    }

    // 7. Preflight cache: read the headers of an explicit OPTIONS without auth.
    running('preflight-cache');
    try {
      const { res, ex } = await client.send('OPTIONS', root, { auth: false });
      await res.body?.cancel().catch(() => undefined);
      const maxAge = header(ex, 'access-control-max-age');
      const acao = header(ex, 'access-control-allow-origin');
      const parts: string[] = [];
      let status: CheckStatus = 'ok';
      if (res.status < 200 || res.status > 299) {
        status = 'warn';
        parts.push(`OPTIONS без пароля ответил ${res.status}.`);
      }
      if (maxAge !== undefined) {
        const n = Number(maxAge);
        if (n >= 600) parts.push(`Access-Control-Max-Age: ${maxAge}.`);
        else {
          status = 'warn';
          parts.push(`Access-Control-Max-Age: ${maxAge}, меньше 600: каждый опрос будет платить предварительным запросом.`);
        }
      } else if (acao !== undefined) {
        status = 'warn';
        parts.push('Access-Control-Max-Age нет: каждый запрос к новому адресу идёт с предварительным, опрос дороже.');
      } else {
        status = 'warn';
        parts.push(
          `Значение не видно из браузера. Проверьте вручную: curl -si -X OPTIONS -H 'Origin: ${env.pageOrigin}' -H 'Access-Control-Request-Method: PROPFIND' ${root.href}`,
        );
      }
      if (acao === '*') {
        status = 'warn';
        parts.push('Access-Control-Allow-Origin: * (рецепты ставят точный адрес клиента).');
      } else if (acao !== undefined && acao !== env.pageOrigin) {
        status = 'warn';
        parts.push(`Access-Control-Allow-Origin: ${acao}.`);
      }
      add('preflight-cache', status, parts.join(' '), { data: { maxAge: maxAge ?? null, allowOrigin: acao ?? null } });
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      add('preflight-cache', 'warn', 'Явный запрос OPTIONS не прошёл CORS; значение Access-Control-Max-Age неизвестно.');
    }

    // 8. MKCOL of the temporary folder.
    running('mkcol');
    try {
      await storage.mkdir(probeDir);
      probeCreated = true;
      add('mkcol', 'ok', `Создана временная папка ${probeDir}; созданная папка видна при повторном чтении.`);
    } catch (e) {
      if (e instanceof StorageError && e.kind === 'Forbidden') fail('mkcol', 'fatal', 'Нет права записи в папку (403).');
      if (e instanceof StorageError && e.kind === 'Full') fail('mkcol', 'fatal', 'На сервере нет места (507).');
      fail('mkcol', 'fatal', `Не удалось создать папку: ${errText(e)}.`);
    }

    // 9. CORS on error responses (6.11): 404, 401, 405, 409.
    running('errors-cors');
    {
      const seen: Record<string, string> = {};
      let blocked = false;
      let anonymous = false;
      const probe = async (label: string, method: string, path: string, init: { auth?: boolean; body?: Uint8Array } = {}): Promise<number | null> => {
        try {
          const { res } = await client.send(method, storage.url(path), {
            ...init,
            ...(init.body ? { headers: { 'Content-Type': 'application/octet-stream' } } : {}),
          });
          await res.body?.cancel().catch(() => undefined);
          seen[label] = String(res.status);
          return res.status;
        } catch (e) {
          if (!(e instanceof StorageError)) throw e;
          seen[label] = 'заблокировано браузером';
          blocked = true;
          return null;
        }
      };
      await probe('GET несуществующего файла', 'GET', `${probeDir}missing.bin`);
      const anon = await probe('GET без пароля', 'GET', `${probeDir}missing.bin`, { auth: false });
      if (anon !== null && anon !== 401) anonymous = true;
      await probe('MKCOL существующей папки', 'MKCOL', probeDir);
      const put409 = await probe('PUT в несуществующую папку', 'PUT', `${probeDir}no-such-dir/x.bin`, { body: new Uint8Array([1]) });
      const list = Object.entries(seen)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      if (blocked) {
        errorsVisible = false;
        add('errors-cors', 'fail', `Часть ответов с ошибками приходит без заголовков CORS, браузер видит их как обрыв сети (${list}). В nginx нужен add_header ... always.`, {
          impact: 'config',
          data: seen,
        });
      } else if (anonymous) {
        add('errors-cors', 'warn', `Заголовки CORS есть на всех ответах (${list}). Но без пароля сервер ответил ${anon}: папка может читаться без пароля.`, {
          data: seen,
        });
      } else {
        const note = put409 !== null && put409 >= 200 && put409 < 300 ? ' Сервер сам создаёт недостающие папки при PUT.' : '';
        add('errors-cors', 'ok', `Ответы с ошибками видны приложению (${list}).${note}`, { data: seen });
      }
    }

    // 10. PUT + GET of a small file.
    running('put');
    const small = new TextEncoder().encode('family-chat probe\n');
    try {
      await storage.put(`${probeDir}a.txt`, small);
      const back = await storage.get(`${probeDir}a.txt`);
      if (!equalBytes(back, small)) fail('put', 'fatal', 'Файл записан, но читается с другим содержимым.');
      add('put', 'ok', 'Файл записан и прочитан без изменений.');
    } catch (e) {
      if (e instanceof Stop) throw e;
      if (e instanceof StorageError && e.kind === 'Full') fail('put', 'fatal', 'На сервере нет места (507).');
      fail('put', 'fatal', `Не удалось записать файл: ${errText(e)}.`);
    }

    // 11. PROPFIND Depth 1.
    running('list');
    try {
      const entries = await storage.list(probeDir);
      const a = entries.find((e) => e.name === 'a.txt');
      if (!a) fail('list', 'fatal', 'Записанного файла нет в списке.', { names: entries.map((e) => e.name) });
      if (a.size !== small.byteLength) fail('list', 'fatal', `Размер в списке ${a.size} вместо ${small.byteLength}.`);
      const t2 = storage.serverTime();
      const mtimeDiff = a.mtime !== undefined && t2 ? Math.round((a.mtime - t2.serverMs) / 1000) : null;
      add(
        'list',
        'ok',
        `Список содержит файл с верным размером.${mtimeDiff === null ? ' Время изменения не сообщается.' : ` Время файла отличается от Date на ${mtimeDiff} с (только для диагностики).`}`,
        { data: { mtimeMinusDateSec: mtimeDiff } },
      );
    } catch (e) {
      if (e instanceof Stop) throw e;
      fail('list', 'fatal', `Не удалось получить список: ${errText(e)}.`);
    }

    // 12. 5 MB PUT.
    running('put-large');
    {
      const size = input.largeBytes ?? 5 * 1024 * 1024;
      const big = random(size);
      try {
        const t0 = performance.now();
        await storage.put(`${probeDir}big.bin`, big);
        const up = (performance.now() - t0) / 1000;
        const t1 = performance.now();
        const back = await storage.get(`${probeDir}big.bin`);
        const down = (performance.now() - t1) / 1000;
        if (!equalBytes(back, big)) fail('put-large', 'fatal', `Файл ${fmtBytes(size)} читается с другим содержимым (${back.byteLength} байт).`);
        const speed = (s: number): string => `${(size / 1024 / 1024 / Math.max(s, 0.001)).toFixed(1)} МБ/с`;
        add('put-large', 'ok', `${fmtBytes(size)} записаны (${speed(up)}) и прочитаны (${speed(down)}) без изменений.`, {
          data: { bytes: size, uploadMs: Math.round(up * 1000), downloadMs: Math.round(down * 1000) },
        });
      } catch (e) {
        if (e instanceof Stop) throw e;
        if (e instanceof StorageError && e.kind === 'TooLarge') fail('put-large', 'fatal', `Сервер не принимает файлы ${fmtBytes(size)} (413).`);
        if (e instanceof StorageError && e.kind === 'Full') fail('put-large', 'fatal', 'На сервере нет места (507).');
        fail('put-large', 'fatal', `Не удалось передать файл ${fmtBytes(size)}: ${errText(e)}.`);
      }
    }

    // 13. Uploaded .html.
    running('html');
    try {
      await storage.put(`${probeDir}page.html`, new TextEncoder().encode('<!doctype html><title>probe</title><p>probe</p>\n'));
      const { res, ex } = await client.send('GET', storage.url(`${probeDir}page.html`));
      await res.body?.cancel().catch(() => undefined);
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      const csp = header(ex, 'content-security-policy');
      const nosniff = header(ex, 'x-content-type-options');
      const extra = `${csp ? ` Content-Security-Policy: ${csp}.` : ''}${nosniff ? ` X-Content-Type-Options: ${nosniff}.` : ''}`;
      if (!type.startsWith('text/html')) add('html', 'ok', `Отдаётся как ${type || 'без типа'}, не как страница.${extra}`);
      else if (csp && /\bsandbox\b/.test(csp)) add('html', 'ok', `Отдаётся как text/html, но под CSP sandbox.${extra}`);
      else {
        add(
          'html',
          'warn',
          `Отдаётся как text/html${csp ? '' : ', заголовок CSP sandbox не виден'}: участник может выложить страницу под адресом семьи. Прокси из рецептов добавляет Content-Security-Policy: sandbox.${extra}`,
        );
      }
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      add('html', 'warn', `Не удалось проверить: ${errText(e)}.`);
    }

    // 14. DELETE of a file.
    running('delete');
    try {
      await storage.delete(`${probeDir}a.txt`);
      let verified = true;
      try {
        await storage.get(`${probeDir}a.txt`);
        fail('delete', 'fatal', 'После DELETE файл всё ещё читается.');
      } catch (e) {
        if (invisible404(e)) verified = false;
        else if (!(e instanceof StorageError) || e.kind !== 'NotFound') throw e;
      }
      if (verified) add('delete', 'ok', 'Файл удалён, повторное чтение даёт 404.');
      else add('delete', 'warn', 'DELETE прошёл, но проверить нельзя: ответ 404 не виден приложению.');
    } catch (e) {
      if (e instanceof Stop) throw e;
      fail('delete', 'fatal', `Не удалось удалить файл: ${errText(e)}.`);
    }

    // 15-17. Free space, space per small file and per folder, preflight cost.
    running('space');
    let before: number | undefined;
    try {
      before = (await storage.space()).availableBytes;
    } catch {
      before = undefined;
    }
    if (before === undefined) add('space', 'info', 'Сервер не сообщает свободное место (quota-available-bytes).');
    else add('space', 'ok', `Свободно ${fmtBytes(before)}.`, { data: { availableBytes: before } });

    running('space-per-file');
    try {
      await storage.mkdir(`${probeDir}small/`);
      for (let i = 0; i < SMALL_FILES; i++) {
        const p = `${probeDir}small/f${i}.bin`;
        await storage.put(p, new Uint8Array([i]));
        smallFiles.push(p);
      }
      const afterFiles = before === undefined ? undefined : (await storage.space()).availableBytes;
      for (let i = 0; i < SMALL_FILES; i++) await storage.mkdir(`${probeDir}d${i}/`);
      const afterDirs = afterFiles === undefined ? undefined : (await storage.space()).availableBytes;
      if (before === undefined || afterFiles === undefined || afterDirs === undefined) {
        add('space-per-file', 'info', 'Не измерить: сервер не сообщает свободное место. Посмотрите размер кластера файловой системы накопителя роутера.');
      } else {
        const perFile = (before - afterFiles) / SMALL_FILES;
        const perDir = (afterFiles - afterDirs) / SMALL_FILES;
        if (perFile <= 0 && perDir <= 0) {
          add('space-per-file', 'info', 'Не измерить: свободное место не изменилось (сервер, вероятно, кэширует значение).', {
            data: { before, afterFiles, afterDirs },
          });
        } else {
          // Worst case from section 2 (P5): 73 000 files and 9 000 folders per year.
          const year = Math.max(perFile, 0) * 73_000 + Math.max(perDir, 0) * 9_000;
          add(
            'space-per-file',
            'info',
            `Файл в 1 байт занимает около ${fmtBytes(Math.round(perFile))}, папка около ${fmtBytes(Math.round(perDir))}. Год журнала при предельной нагрузке: около ${fmtBytes(Math.round(year))}.`,
            { data: { perFileBytes: Math.round(perFile), perDirBytes: Math.round(perDir), yearBytes: Math.round(year), before, afterFiles, afterDirs } },
          );
        }
      }
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      add('space-per-file', 'warn', `Не удалось создать маленькие файлы: ${errText(e)}.`);
    }

    running('preflight-cost');
    if (smallFiles.length === SMALL_FILES) {
      try {
        const time = async (path: string): Promise<number> => {
          const t0 = performance.now();
          await storage.get(path);
          return Math.round(performance.now() - t0);
        };
        const fresh: number[] = [];
        for (const p of smallFiles) fresh.push(await time(p));
        const repeat: number[] = [];
        for (let i = 0; i < SMALL_FILES; i++) repeat.push(await time(smallFiles[0] as string));
        const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
        const a = Math.round(avg(fresh));
        const b = Math.round(avg(repeat));
        add(
          'preflight-cost',
          'info',
          `GET нового адреса в среднем ${a} мс, повторный GET того же адреса ${b} мс; предварительный запрос стоит около ${Math.max(0, a - b)} мс.`,
          { data: { freshMs: fresh, repeatMs: repeat } },
        );
      } catch (e) {
        if (!(e instanceof StorageError)) throw e;
        add('preflight-cost', 'warn', `Не удалось измерить: ${errText(e)}.`);
      }
    } else {
      add('preflight-cost', 'skip', 'Нет тестовых файлов.');
    }

    // 18. Recursive DELETE of the temporary folder.
    running('delete-recursive');
    try {
      await storage.delete(probeDir);
      try {
        await storage.stat(probeDir);
        add('delete-recursive', 'warn', 'DELETE папки прошёл, но папка осталась. Клиенту придётся удалять файлы по одному.');
      } catch (e) {
        if (invisible404(e)) {
          recursiveDeleteOk = true;
          add('delete-recursive', 'warn', 'DELETE папки прошёл, но проверить нельзя: ответ 404 не виден приложению.');
        } else {
          if (!(e instanceof StorageError) || e.kind !== 'NotFound') throw e;
          recursiveDeleteOk = true;
          add('delete-recursive', 'ok', 'Папка с файлами и вложенными папками удалена одним запросом.');
        }
      }
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      add('delete-recursive', 'warn', `Папка с содержимым не удаляется одним запросом (${errText(e)}). Клиенту придётся удалять файлы по одному.`);
    }

    // 19. What else the account can see.
    running('scope');
    await checkScope(storage, add);
  } catch (e) {
    if (!(e instanceof Stop)) {
      add(checks.length ? (checks[checks.length - 1]?.id ?? 'https') : 'https', 'fail', `Сбой зонда: ${errText(e)}`, { impact: 'fatal' });
    }
  } finally {
    if (probeCreated && !recursiveDeleteOk) await cleanup(storage, probeDir, smallFiles);
  }
  // Mark the checks that never ran.
  for (const id of Object.keys(CHECKS) as CheckId[]) {
    if (!checks.some((c) => c.id === id)) checks.push({ id, title: CHECKS[id], status: 'skip', detail: 'Не выполнялась.' });
  }
  input.onProgress?.([...checks], null);
  return finish(checks);

  function finish(list: CheckResult[]): ProbeReport {
    const verdict = verdictOf(list);
    const firstFail = list.find((c) => c.status === 'fail' && (verdict === 'unsuitable' ? c.impact === 'fatal' : true));
    const summary = firstFail ? firstFail.detail : 'Все обязательные проверки пройдены.';
    const nextAction =
      verdict === 'suitable'
        ? 'Сервер можно подключать к приложению.'
        : verdict === 'needs-setup'
          ? `Настройте сервер или прокси с CORS по инструкции: ${RECIPES_URL}`
          : 'С этим сервером приложение работать не сможет. Исправьте причину выше или поставьте рядом сервер WebDAV по инструкции: ' +
            RECIPES_URL;
    return {
      probeVersion: PROBE_VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      serverUrl: safeUrl(input.url),
      username: input.username,
      environment: env,
      verdict,
      verdictText: VERDICT_TEXT[verdict],
      summary,
      nextAction,
      ...(verdict === 'suitable' ? {} : { nextActionUrl: RECIPES_URL }),
      checks: list,
      exchanges,
    };
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return '(неверный адрес)';
  }
}

async function checkScope(
  storage: WebDavStorage,
  add: (id: CheckId, status: CheckStatus, detail: string, extra?: Partial<CheckResult>) => CheckResult,
): Promise<void> {
  const foreignInRoot: string[] = [];
  try {
    for (const e of await storage.list('')) {
      if (!KNOWN_ROOT_NAMES.has(e.name) && !e.name.startsWith('fc-probe-')) foreignInRoot.push(e.name);
    }
  } catch {
    // ignore: reported by other checks
  }
  const rootNote = foreignInRoot.length
    ? ` В папке чата есть посторонние файлы: ${foreignInRoot.slice(0, 10).join(', ')}${foreignInRoot.length > 10 ? '…' : ''}.`
    : '';
  const root = storage.root;
  if (root.pathname === '/') {
    add('scope', foreignInRoot.length ? 'warn' : 'info', `Папка чата это корень WebDAV.${rootNote}`, {
      data: { foreignInRoot },
    });
    return;
  }
  const parent = new URL('../', root);
  const chatName = decodeURIComponent(root.pathname.split('/').filter(Boolean).pop() ?? '');
  try {
    const { res, ex } = await storage.client.send('PROPFIND', parent, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body:
        '<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    });
    if (res.status !== 207) {
      await res.body?.cancel().catch(() => undefined);
      add('scope', foreignInRoot.length ? 'warn' : 'ok', `Папка выше закрыта (${res.status}).${rootNote}`, { data: { parentStatus: res.status, foreignInRoot } });
      return;
    }
    const rs = await storage.client.readMultistatus(res, ex, 1024 * 1024);
    const names = rs
      .map((r) => {
        try {
          return decodeURIComponent(new URL(r.href, parent).pathname.replace(/\/$/, '').split('/').pop() ?? '');
        } catch {
          return '';
        }
      })
      .filter((n, i) => i > 0 && n !== '' && n !== chatName);
    if (names.length === 0) {
      add('scope', foreignInRoot.length ? 'warn' : 'ok', `Выше видна только папка чата.${rootNote}`, { data: { foreignInRoot } });
    } else {
      add(
        'scope',
        'warn',
        `Учётная запись видит папки рядом с папкой чата: ${names.slice(0, 10).join(', ')}${names.length > 10 ? '…' : ''}. Лучше отдельная учётная запись с доступом только к папке чата.${rootNote}`,
        { data: { visibleOutside: names, foreignInRoot } },
      );
    }
  } catch (e) {
    if (!(e instanceof StorageError)) throw e;
    add('scope', foreignInRoot.length ? 'warn' : 'ok', `Папка выше недоступна (${errText(e)}).${rootNote}`, { data: { foreignInRoot } });
  }
}

async function cleanup(storage: WebDavStorage, probeDir: string, smallFiles: string[]): Promise<void> {
  const files = [...smallFiles, `${probeDir}a.txt`, `${probeDir}big.bin`, `${probeDir}page.html`, `${probeDir}no-such-dir/x.bin`];
  const dirs = [`${probeDir}small/`, `${probeDir}no-such-dir/`, ...Array.from({ length: SMALL_FILES }, (_, i) => `${probeDir}d${i}/`), probeDir];
  try {
    await storage.delete(probeDir);
    return;
  } catch {
    // fall through to one by one
  }
  for (const p of [...files, ...dirs]) {
    try {
      await storage.delete(p);
    } catch {
      // best effort
    }
  }
}

/** Plain-text report for "Скопировать отчёт". Never contains the password. */
export function formatReport(r: ProbeReport, password?: string): string {
  const icon: Record<CheckStatus, string> = { ok: '[ok]  ', warn: '[!]   ', fail: '[x]   ', info: '[i]   ', skip: '[-]   ' };
  const lines = [
    `Family Chat: отчёт зонда совместимости v${r.probeVersion}`,
    `Вердикт: ${r.verdictText}`,
    `Причина: ${r.summary}`,
    `Что дальше: ${r.nextAction}`,
    '',
    `Сервер: ${r.serverUrl}`,
    `Логин: ${r.username}`,
    `Адрес клиента: ${r.environment.pageOrigin}`,
    `Браузер: ${r.environment.userAgent}`,
    `Защищённый контекст: ${r.environment.isSecureContext ? 'да' : 'нет'}; установлено как приложение: ${r.environment.standalone ? 'да' : 'нет'}; доступ к локальной сети: ${r.environment.localNetworkAccess}`,
    `Начало: ${r.startedAt}; конец: ${r.finishedAt}`,
    '',
    'Проверки:',
    ...r.checks.map((c) => `${icon[c.status]}${c.title}: ${c.detail}${c.data ? `  ${JSON.stringify(c.data)}` : ''}`),
    '',
    `Сырые обмены с сервером (${r.exchanges.length}), JSON:`,
    JSON.stringify(r.exchanges, null, 1),
  ];
  let text = lines.join('\n');
  if (password && password.length >= 3) {
    text = text.split(password).join('<redacted>');
  }
  return text;
}
