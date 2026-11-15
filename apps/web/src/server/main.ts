import '../styles/base.css';
import './page.css';
import { registerServiceWorker } from '../pwa.ts';
import { intlLocale } from '../lib/locale.ts';
import { localizePage, pageLang, tr } from '../lib/page-lang.ts';
import {
  base64UrlToBytes,
  describeError,
  fetchHello,
  formatLogEntry,
  formatReport,
  longRequest,
  normalizeServerUrl,
  pushServiceHost,
  sameBytes,
  sendTestPush,
  waitSecondsFromQuery,
  type Hello,
  type LogEntry,
  type Outcome,
} from './check.ts';

localizePage();
registerServiceWorker();

const LOG_KEY = 'fc.server-check.log';
const locale = intlLocale(pageLang);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serverInput = $<HTMLInputElement>('server');
const codeInput = $<HTMLInputElement>('code');
const helloStatus = $('hello-status');
const helloList = $<HTMLDListElement>('hello');
const checkStatus = $('check-status');
const logList = $<HTMLUListElement>('log');
const reportArea = $<HTMLTextAreaElement>('report');
const waitBtn = $<HTMLButtonElement>('wait-btn');
const notifyBtn = $<HTMLButtonElement>('notify-btn');
const pushNowBtn = $<HTMLButtonElement>('push-now-btn');
const pushLaterBtn = $<HTMLButtonElement>('push-later-btn');

const waitSeconds = waitSecondsFromQuery(location.search);
waitBtn.textContent = tr(`Проверить длинный запрос (${waitSeconds} с)`, `Check a long request (${waitSeconds} s)`);
serverInput.value = location.origin;

let hello: Outcome<Hello> | null = null;
let helloBase = '';
let clockOffsetSec: number | null = null;
let log: LogEntry[] = loadLog();

function loadLog(): LogEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as LogEntry[]).slice(-100) : [];
  } catch {
    return [];
  }
}

function addLog(ok: boolean | null, text: string): void {
  log.push({ at: Date.now(), ok, text });
  log = log.slice(-100);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // storage full or unavailable: the log stays in memory
  }
  renderLog();
}

function renderLog(): void {
  logList.replaceChildren(
    ...log
      .slice()
      .reverse()
      .map((e) => {
        const li = document.createElement('li');
        li.className = e.ok === true ? 'ok' : e.ok === false ? 'fail' : 'info';
        li.textContent = formatLogEntry(e);
        return li;
      }),
  );
  updateReport();
}

function server(): string {
  const s = normalizeServerUrl(serverInput.value, location.origin);
  serverInput.value = s;
  return s;
}

function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

let pushHost = tr('нет', 'none');

function updateReport(): void {
  reportArea.value = formatReport({
    now: new Date(),
    pageUrl: location.href,
    server: serverInput.value,
    userAgent: navigator.userAgent,
    standalone: standalone(),
    secureContext: window.isSecureContext,
    notificationPermission: 'Notification' in window ? Notification.permission : tr('нет API', 'no API'),
    pushSupported: pushSupported(),
    pushService: pushHost,
    hello,
    clockOffsetSec,
    log,
  });
}

function renderHello(): void {
  helloList.replaceChildren();
  if (!hello) return;
  if (!hello.ok) {
    helloStatus.className = 'bad';
    helloStatus.textContent = tr(`Сервер не ответил: ${hello.error}`, `The server didn’t answer: ${hello.error}`);
    return;
  }
  const h = hello.value;
  helloStatus.className = '';
  helloStatus.textContent = tr(`Сервер отвечает (${hello.ms} мс).`, `The server is answering (${hello.ms} ms).`);
  const rows: [string, string][] = [
    [tr('Семья', 'Family'), h.familyName],
    [tr('Версия', 'Version'), tr(`fcd ${h.version}, протокол ${h.protocol}`, `fcd ${h.version}, protocol ${h.protocol}`)],
    ['serverId', h.serverId],
    [tr('Хранение', 'Kept for'), tr(`${h.retentionDays} дн.`, `${h.retentionDays} days`)],
    [tr('Предел файла', 'File limit'), `${h.maxFileMb} ${tr('МБ', 'MB')}`],
    ['Push', h.push ? tr('включён', 'on') : tr('выключен', 'off')],
    [tr('Проверки M0', 'M0 checks'), h.m0 ? tr('включены', 'on') : tr('выключены (запустите fcd с --m0)', 'off (start fcd with --m0)')],
    [
      tr('Часы сервера', 'Server clock'),
      tr(`${new Date(h.time).toLocaleString(locale)} (разница ${clockOffsetSec ?? '?'} с)`, `${new Date(h.time).toLocaleString(locale)} (off by ${clockOffsetSec ?? '?'} s)`),
    ],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    helloList.append(dt, dd);
  }
}

async function loadHello(): Promise<Outcome<Hello>> {
  helloStatus.textContent = tr('Запрашиваю /v1/hello…', 'Requesting /v1/hello…');
  const base = server();
  const sentAt = Date.now();
  hello = await fetchHello(base);
  helloBase = base;
  if (hello.ok) {
    clockOffsetSec = Math.round((hello.value.time - (sentAt + hello.ms / 2)) / 1000);
    addLog(
      true,
      tr(
        `hello с ${base}: ${hello.ms} мс, семья «${hello.value.familyName}», fcd ${hello.value.version}`,
        `hello from ${base}: ${hello.ms} ms, family “${hello.value.familyName}”, fcd ${hello.value.version}`,
      ),
    );
  } else {
    addLog(false, tr(`hello с ${base}: ${hello.error}`, `hello from ${base}: ${hello.error}`));
  }
  renderHello();
  updateReport();
  return hello;
}

function needCode(): string | null {
  const code = codeInput.value.trim();
  if (!code) {
    checkStatus.textContent = tr('Введите код администратора.', 'Enter the admin code.');
    codeInput.focus();
    return null;
  }
  return code;
}

async function withButton(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    addLog(false, describeError(e));
  } finally {
    btn.disabled = false;
  }
}

waitBtn.addEventListener('click', () =>
  withButton(waitBtn, async () => {
    const code = needCode();
    if (!code) return;
    checkStatus.textContent = tr(`Жду ответа ${waitSeconds} с…`, `Waiting ${waitSeconds} s for the answer…`);
    const r = await longRequest(server(), code, waitSeconds);
    const sec = (r.ms / 1000).toFixed(1);
    if (r.ok) {
      checkStatus.textContent = tr(`Длинный запрос прошёл за ${sec} с.`, `The long request went through in ${sec} s.`);
      addLog(true, tr(`длинный запрос ${waitSeconds} с: ответ через ${sec} с`, `long request ${waitSeconds} s: answered after ${sec} s`));
    } else {
      checkStatus.textContent = tr(`Длинный запрос не прошёл: ${r.error}.`, `The long request failed: ${r.error}.`);
      addLog(false, tr(`длинный запрос ${waitSeconds} с: ${r.error} через ${sec} с`, `long request ${waitSeconds} s: ${r.error} after ${sec} s`));
    }
  }),
);

async function subscribe(report = true): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    addLog(
      false,
      isIos() && !standalone()
        ? tr('push недоступен: откройте приложение с экрана «Домой»', 'push isn’t available: open the app from the Home Screen')
        : tr('push не поддерживается этим браузером', 'this browser doesn’t support push'),
    );
    return null;
  }
  // First await of the click handler: iOS asks for permission only during a user gesture.
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    addLog(false, tr(`разрешение на уведомления: ${permission}`, `notification permission: ${permission}`));
    return null;
  }
  const h = hello?.ok && helloBase === server() ? hello : await loadHello();
  if (!h.ok) return null;
  if (!h.value.vapidPublicKey) {
    addLog(false, tr('push выключен на сервере (push = false)', 'push is off on the server (push = false)'));
    return null;
  }
  const reg = await navigator.serviceWorker.ready;
  const key = base64UrlToBytes(h.value.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    // Subscribed for another server (or the keys were regenerated).
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  pushHost = pushServiceHost(sub.endpoint);
  if (report) addLog(true, tr(`уведомления включены, push-сервис ${pushHost}`, `notifications on, push service ${pushHost}`));
  return sub;
}

notifyBtn.addEventListener('click', () => withButton(notifyBtn, async () => void (await subscribe())));

async function testPush(btn: HTMLButtonElement, delaySeconds: number): Promise<void> {
  await withButton(btn, async () => {
    const code = needCode();
    if (!code) return;
    // Also asks for permission if needed and re-subscribes when the existing
    // subscription belongs to another server.
    const sub = await subscribe(!('Notification' in window) || Notification.permission !== 'granted');
    if (!sub) return;
    const r = await sendTestPush(server(), code, sub.toJSON(), delaySeconds);
    if (!r.ok) {
      checkStatus.textContent = tr(`Сервер не отправил уведомление: ${r.error}.`, `The server didn’t send the notification: ${r.error}.`);
      addLog(false, tr(`пробное уведомление${delaySeconds ? ` через ${delaySeconds} с` : ''}: ${r.error}`, `test notification${delaySeconds ? ` in ${delaySeconds} s` : ''}: ${r.error}`));
      return;
    }
    if (r.value.scheduled) {
      const at = new Date(r.value.sendAt ?? Date.now() + delaySeconds * 1000).toLocaleTimeString(locale);
      checkStatus.textContent = tr(`Уведомление придёт около ${at}. Можно закрыть приложение.`, `The notification will arrive around ${at}. You can close the app.`);
      addLog(null, tr(`пробное уведомление запланировано на ${at} (${pushHost})`, `test notification scheduled for ${at} (${pushHost})`));
    } else {
      const o = r.value.outcome;
      const ok = !!o && o.status >= 200 && o.status < 300;
      checkStatus.textContent = ok
        ? tr('Push-сервис принял уведомление, оно должно появиться.', 'The push service accepted the notification; it should appear.')
        : tr(`Push-сервис ответил ${o?.status}.`, `The push service answered ${o?.status}.`);
      const detail = o?.detail ? ` (${o.detail})` : '';
      addLog(ok, tr(`пробное уведомление: push-сервис ${o?.service} ответил ${o?.status}${detail}`, `test notification: push service ${o?.service} answered ${o?.status}${detail}`));
    }
  });
}

pushNowBtn.addEventListener('click', () => void testPush(pushNowBtn, 0));
pushLaterBtn.addEventListener('click', () => void testPush(pushLaterBtn, 60));

$<HTMLButtonElement>('hello-btn').addEventListener('click', () => void loadHello());

$<HTMLButtonElement>('copy-btn').addEventListener('click', async () => {
  updateReport();
  const status = $('copy-status');
  try {
    await navigator.clipboard.writeText(reportArea.value);
    status.textContent = tr('Отчёт скопирован.', 'Report copied.');
  } catch {
    status.textContent = tr('Не удалось скопировать: выделите текст ниже.', 'Couldn’t copy: select the text below.');
    reportArea.closest('details')?.setAttribute('open', '');
  }
});

$<HTMLButtonElement>('clear-btn').addEventListener('click', () => {
  log = [];
  localStorage.removeItem(LOG_KEY);
  renderLog();
});

// Messages from the service worker: a push arrived while a page was open,
// or a notification was clicked.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as { type?: string; sentAt?: number; receivedAt?: number } | null;
    if (!m?.type) return;
    const sec = m.sentAt && m.receivedAt ? ((m.receivedAt - m.sentAt) / 1000).toFixed(1) : null;
    const lag = sec ? tr(`, через ${sec} с после отправки`, `, ${sec} s after sending`) : '';
    if (m.type === 'fc-push') addLog(true, tr(`уведомление получено при открытом приложении${lag}`, `notification received while the app was open${lag}`));
    if (m.type === 'fc-notification-click') addLog(true, tr('нажато уведомление', 'notification tapped'));
  });
}

// Opened by tapping a notification while the app was closed.
const params = new URLSearchParams(location.search);
if (params.get('from') === 'push') {
  const sentAt = Number(params.get('sentAt'));
  const ago = sentAt ? tr(`, отправлено ${new Date(sentAt).toLocaleTimeString(locale)}`, `, sent ${new Date(sentAt).toLocaleTimeString(locale)}`) : '';
  addLog(true, tr(`приложение открыто нажатием на уведомление${ago}`, `app opened by tapping a notification${ago}`));
  params.delete('from');
  params.delete('sentAt');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}

$('ios-hint').hidden = !(isIos() && !standalone());
void currentSubscription().then((s) => {
  if (s) pushHost = pushServiceHost(s.endpoint);
  updateReport();
});
renderLog();
void loadHello();
