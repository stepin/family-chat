import '../styles/base.css';
import './page.css';
import { registerServiceWorker } from '../pwa.ts';
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

registerServiceWorker();

const LOG_KEY = 'fc.server-check.log';
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
waitBtn.textContent = `Проверить длинный запрос (${waitSeconds} с)`;
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

let pushHost = 'нет';

function updateReport(): void {
  reportArea.value = formatReport({
    now: new Date(),
    pageUrl: location.href,
    server: serverInput.value,
    userAgent: navigator.userAgent,
    standalone: standalone(),
    secureContext: window.isSecureContext,
    notificationPermission: 'Notification' in window ? Notification.permission : 'нет API',
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
    helloStatus.textContent = `Сервер не ответил: ${hello.error}`;
    return;
  }
  const h = hello.value;
  helloStatus.className = '';
  helloStatus.textContent = `Сервер отвечает (${hello.ms} мс).`;
  const rows: [string, string][] = [
    ['Семья', h.familyName],
    ['Версия', `fcd ${h.version}, протокол ${h.protocol}`],
    ['serverId', h.serverId],
    ['Хранение', `${h.retentionDays} дн.`],
    ['Предел файла', `${h.maxFileMb} МБ`],
    ['Push', h.push ? 'включён' : 'выключен'],
    ['Проверки M0', h.m0 ? 'включены' : 'выключены (запустите fcd с --m0)'],
    ['Часы сервера', `${new Date(h.time).toLocaleString()} (разница ${clockOffsetSec ?? '?'} с)`],
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
  helloStatus.textContent = 'Запрашиваю /v1/hello…';
  const base = server();
  const sentAt = Date.now();
  hello = await fetchHello(base);
  helloBase = base;
  if (hello.ok) {
    clockOffsetSec = Math.round((hello.value.time - (sentAt + hello.ms / 2)) / 1000);
    addLog(true, `hello с ${base}: ${hello.ms} мс, семья «${hello.value.familyName}», fcd ${hello.value.version}`);
  } else {
    addLog(false, `hello с ${base}: ${hello.error}`);
  }
  renderHello();
  updateReport();
  return hello;
}

function needCode(): string | null {
  const code = codeInput.value.trim();
  if (!code) {
    checkStatus.textContent = 'Введите код администратора.';
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
    checkStatus.textContent = `Жду ответа ${waitSeconds} с…`;
    const r = await longRequest(server(), code, waitSeconds);
    const sec = (r.ms / 1000).toFixed(1);
    if (r.ok) {
      checkStatus.textContent = `Длинный запрос прошёл за ${sec} с.`;
      addLog(true, `длинный запрос ${waitSeconds} с: ответ через ${sec} с`);
    } else {
      checkStatus.textContent = `Длинный запрос не прошёл: ${r.error}.`;
      addLog(false, `длинный запрос ${waitSeconds} с: ${r.error} через ${sec} с`);
    }
  }),
);

async function subscribe(report = true): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    addLog(false, isIos() && !standalone() ? 'push недоступен: откройте приложение с экрана «Домой»' : 'push не поддерживается этим браузером');
    return null;
  }
  // First await of the click handler: iOS asks for permission only during a user gesture.
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    addLog(false, `разрешение на уведомления: ${permission}`);
    return null;
  }
  const h = hello?.ok && helloBase === server() ? hello : await loadHello();
  if (!h.ok) return null;
  if (!h.value.vapidPublicKey) {
    addLog(false, 'push выключен на сервере (push = false)');
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
  if (report) addLog(true, `уведомления включены, push-сервис ${pushHost}`);
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
      checkStatus.textContent = `Сервер не отправил уведомление: ${r.error}.`;
      addLog(false, `пробное уведомление${delaySeconds ? ` через ${delaySeconds} с` : ''}: ${r.error}`);
      return;
    }
    if (r.value.scheduled) {
      const at = new Date(r.value.sendAt ?? Date.now() + delaySeconds * 1000).toLocaleTimeString();
      checkStatus.textContent = `Уведомление придёт около ${at}. Можно закрыть приложение.`;
      addLog(null, `пробное уведомление запланировано на ${at} (${pushHost})`);
    } else {
      const o = r.value.outcome;
      const ok = !!o && o.status >= 200 && o.status < 300;
      checkStatus.textContent = ok ? 'Push-сервис принял уведомление, оно должно появиться.' : `Push-сервис ответил ${o?.status}.`;
      addLog(ok, `пробное уведомление: push-сервис ${o?.service} ответил ${o?.status}${o?.detail ? ` (${o.detail})` : ''}`);
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
    status.textContent = 'Отчёт скопирован.';
  } catch {
    status.textContent = 'Не удалось скопировать: выделите текст ниже.';
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
    const lag = m.sentAt && m.receivedAt ? `, через ${((m.receivedAt - m.sentAt) / 1000).toFixed(1)} с после отправки` : '';
    if (m.type === 'fc-push') addLog(true, `уведомление получено при открытом приложении${lag}`);
    if (m.type === 'fc-notification-click') addLog(true, 'нажато уведомление');
  });
}

// Opened by tapping a notification while the app was closed.
const params = new URLSearchParams(location.search);
if (params.get('from') === 'push') {
  const sentAt = Number(params.get('sentAt'));
  const ago = sentAt ? `, отправлено ${new Date(sentAt).toLocaleTimeString()}` : '';
  addLog(true, `приложение открыто нажатием на уведомление${ago}`);
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
