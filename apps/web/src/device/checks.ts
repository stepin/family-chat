/**
 * Device checks for M0 (docs/PLAN.md 7.8 and section 9): OPFS vs IndexedDB on
 * iOS, image encoding (WebP or JPEG), resize via createImageBitmap, and the
 * browser features the client relies on. Results go to a copyable report.
 */
import { tr } from '../lib/page-lang.ts';

export interface DeviceCheck {
  id: string;
  title: string;
  ok: boolean | null;
  detail: string;
}

type Step = () => Promise<Omit<DeviceCheck, 'id' | 'title'>>;

/** getRandomValues fills at most 65 536 bytes per call. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function blobFromCanvas(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.8));
}

function testCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 300;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2f5d50';
  g.fillRect(0, 0, 400, 300);
  g.fillStyle = '#f6f3ee';
  g.fillRect(50, 50, 120, 80);
  return c;
}

const steps: [string, string, Step][] = [
  ['secure', tr('Защищённый контекст (HTTPS)', 'Secure context (HTTPS)'), async () => ({ ok: window.isSecureContext, detail: String(window.isSecureContext) })],
  [
    'standalone',
    tr('Открыто как установленное приложение', 'Opened as an installed app'),
    async () => {
      const s = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      return { ok: null, detail: s ? tr('да', 'yes') : tr('нет (откройте с экрана Домой, чтобы проверить установленное приложение)', 'no (open it from the Home Screen to check the installed app)') };
    },
  ],
  [
    'sw',
    'Service worker',
    async () => {
      if (!('serviceWorker' in navigator)) return { ok: false, detail: tr('не поддерживается', 'not supported') };
      const reg = await navigator.serviceWorker.getRegistration();
      return { ok: !!reg, detail: reg ? tr(`зарегистрирован, управляет страницей: ${navigator.serviceWorker.controller ? 'да' : 'нет'}`, `registered, controls the page: ${navigator.serviceWorker.controller ? 'yes' : 'no'}`) : tr('не зарегистрирован', 'not registered') };
    },
  ],
  [
    'persist',
    tr('Постоянное хранилище (storage.persist)', 'Persistent storage (storage.persist)'),
    async () => {
      if (!navigator.storage?.persist) return { ok: false, detail: tr('не поддерживается', 'not supported') };
      const granted = await navigator.storage.persist();
      const est = await navigator.storage.estimate();
      const gb = (n?: number): string => (n === undefined ? '?' : `${(n / 1024 ** 3).toFixed(2)} ${tr('ГБ', 'GB')}`);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const note = granted
        ? ''
        : standalone
          ? tr(' (в установленном приложении отказ: данные могут быть вытеснены)', ' (refused in the installed app: data may be evicted)')
          : tr(' (во вкладке браузера отказ обычен; важен результат в установленном приложении)', ' (a refusal is normal in a browser tab; the result in the installed app is what matters)');
      return {
        ok: granted ? true : standalone ? false : null,
        detail: tr(`persist: ${granted}; занято ${gb(est.usage)} из ${gb(est.quota)}${note}`, `persist: ${granted}; used ${gb(est.usage)} of ${gb(est.quota)}${note}`),
      };
    },
  ],
  [
    'idb',
    tr('IndexedDB: запись и чтение 1 МБ', 'IndexedDB: write and read 1 MB'),
    async () => {
      const data = randomBytes(1024 * 1024);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open('fc-device-check', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('s');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error('indexedDB.open failed'));
      });
      const why = (e: unknown): string => (e instanceof Error || e instanceof DOMException ? `${e.name}: ${e.message}` : String(e));
      // Blob first (what the client would like to store), then ArrayBuffer:
      // some engines refuse Blobs, e.g. in private mode.
      const roundTrip = async (value: Blob | ArrayBuffer): Promise<Uint8Array> => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('s', 'readwrite');
          tx.objectStore('s').put(value, 'k');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('transaction error'));
          tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        });
        const back = await new Promise<unknown>((resolve, reject) => {
          const r = db.transaction('s').objectStore('s').get('k');
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error ?? new Error('get failed'));
        });
        return new Uint8Array(back instanceof Blob ? await back.arrayBuffer() : (back as ArrayBuffer));
      };
      const results: string[] = [];
      let ok = false;
      for (const [label, value] of [
        ['Blob', new Blob([data])],
        ['ArrayBuffer', data.buffer.slice(0)],
      ] as const) {
        try {
          const same = sameBytes(await roundTrip(value), data);
          results.push(`${label}: ${same ? tr('записан и прочитан без изменений', 'written and read back unchanged') : tr('содержимое отличается', 'the content differs')}`);
          ok ||= same;
          if (same && label === 'Blob') break;
        } catch (e) {
          results.push(`${label}: ${tr('ошибка', 'error')} ${why(e)}`);
        }
      }
      db.close();
      indexedDB.deleteDatabase('fc-device-check');
      return { ok, detail: results.join('; ') };
    },
  ],
  [
    'opfs-main',
    tr('OPFS: запись из страницы (createWritable)', 'OPFS: writing from the page (createWritable)'),
    async () => {
      if (!navigator.storage?.getDirectory) return { ok: false, detail: tr('OPFS не поддерживается', 'OPFS is not supported') };
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('fc-device-check.bin', { create: true });
      if (!('createWritable' in fh)) {
        await dir.removeEntry('fc-device-check.bin');
        return { ok: false, detail: tr('нет createWritable (возможна запись только из воркера)', 'no createWritable (writing may only work from a worker)') };
      }
      const w = await fh.createWritable();
      await w.write(new Uint8Array(1024 * 1024));
      await w.close();
      const size = (await fh.getFile()).size;
      await dir.removeEntry('fc-device-check.bin');
      return { ok: size === 1024 * 1024, detail: tr(`записан и прочитан файл ${size} байт`, `wrote and read a file of ${size} bytes`) };
    },
  ],
  [
    'opfs-worker',
    tr('OPFS: запись из воркера (createSyncAccessHandle)', 'OPFS: writing from a worker (createSyncAccessHandle)'),
    async () => {
      const worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, detail: tr('воркер не ответил за 10 с', 'the worker didn’t answer within 10 s') }), 10_000);
        worker.onmessage = (e) => {
          clearTimeout(timer);
          const m = e.data as { ok: boolean; size?: number; error?: string };
          resolve({
            ok: m.ok,
            detail: m.error !== undefined ? `${tr('ошибка', 'error')}: ${m.error}` : tr(`записан и прочитан файл ${m.size} байт`, `wrote and read a file of ${m.size} bytes`),
          });
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          resolve({ ok: false, detail: `${tr('ошибка воркера', 'worker error')}: ${e.message}` });
        };
      });
      worker.terminate();
      return result;
    },
  ],
  [
    'webp',
    tr('Кодирование WebP', 'WebP encoding'),
    async () => {
      const b = await blobFromCanvas(testCanvas(), 'image/webp');
      const webp = b?.type === 'image/webp';
      return { ok: webp ? true : null, detail: `${tr('получен', 'got')} ${b?.type ?? 'null'}${webp ? '' : tr(': WebP не кодируется, клиент будет использовать JPEG', ': WebP can’t be encoded, the app will use JPEG')}` };
    },
  ],
  [
    'jpeg',
    tr('Кодирование JPEG', 'JPEG encoding'),
    async () => {
      const b = await blobFromCanvas(testCanvas(), 'image/jpeg');
      return { ok: b?.type === 'image/jpeg', detail: tr(`получен ${b?.type ?? 'null'}, ${b?.size ?? 0} байт`, `got ${b?.type ?? 'null'}, ${b?.size ?? 0} bytes`) };
    },
  ],
  [
    'resize',
    tr('Уменьшение через createImageBitmap', 'Resizing with createImageBitmap'),
    async () => {
      const bmp = await createImageBitmap(testCanvas(), { resizeWidth: 100, resizeHeight: 75, resizeQuality: 'high' });
      const ok = bmp.width === 100 && bmp.height === 75;
      return { ok, detail: `${tr('получено', 'got')} ${bmp.width}x${bmp.height}${ok ? '' : tr(' (параметры resize не поддерживаются)', ' (resize options are not supported)')}` };
    },
  ],
  [
    'offscreen',
    tr('OffscreenCanvas с WebP', 'OffscreenCanvas with WebP'),
    async () => {
      if (typeof OffscreenCanvas === 'undefined') return { ok: false, detail: tr('нет OffscreenCanvas', 'no OffscreenCanvas') };
      const c = new OffscreenCanvas(64, 64);
      c.getContext('2d')!.fillRect(0, 0, 64, 64);
      const b = await c.convertToBlob({ type: 'image/webp' });
      const webp = b.type === 'image/webp';
      return { ok: webp ? true : null, detail: `${tr('convertToBlob дал', 'convertToBlob gave')} ${b.type}${webp ? '' : tr(': WebP не кодируется, клиент будет использовать JPEG', ': WebP can’t be encoded, the app will use JPEG')}` };
    },
  ],
  ['locks', 'Web Locks', async () => ({ ok: 'locks' in navigator, detail: 'locks' in navigator ? tr('есть', 'yes') : tr('нет', 'no') })],
  [
    'periodic',
    'Periodic Background Sync',
    async () => {
      const has = 'periodicSync' in ServiceWorkerRegistration.prototype;
      return {
        ok: null,
        detail: has
          ? tr('API есть (реальная частота проверяется отдельно)', 'the API exists (the real frequency is checked separately)')
          : tr('нет: фоновая проверка в закрытом приложении недоступна', 'no: checking in the background while the app is closed is not available'),
      };
    },
  ],
  [
    'notify',
    tr('Уведомления', 'Notifications'),
    async () => ({ ok: null, detail: 'Notification' in window ? tr(`API есть, разрешение: ${Notification.permission}`, `the API exists, permission: ${Notification.permission}`) : tr('нет API (на iOS только в установленном приложении)', 'no API (on iOS only in the installed app)') }),
  ],
  ['badge', tr('Бейдж на значке', 'Badge on the icon'), async () => ({ ok: null, detail: 'setAppBadge' in navigator ? tr('есть', 'yes') : tr('нет', 'no') })],
  [
    'lna',
    tr('Разрешение на доступ к локальной сети (Chrome)', 'Local network access permission (Chrome)'),
    async () => {
      try {
        const s = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
        return { ok: null, detail: s.state };
      } catch {
        return { ok: null, detail: tr('не поддерживается этим браузером', 'not supported by this browser') };
      }
    },
  ],
];

export async function runDeviceChecks(onProgress: (list: DeviceCheck[]) => void): Promise<DeviceCheck[]> {
  const out: DeviceCheck[] = [];
  for (const [id, title, step] of steps) {
    try {
      // A permission prompt nobody answers (Firefox asks for storage.persist) must not block the rest.
      const timeout = new Promise<Omit<DeviceCheck, 'id' | 'title'>>((resolve) =>
        setTimeout(() => resolve({ ok: null, detail: tr('нет ответа за 8 с: браузер, вероятно, ждёт ответа на запрос разрешения', 'no answer within 8 s: the browser is probably waiting for a permission prompt') }), 8_000),
      );
      out.push({ id, title, ...(await Promise.race([step(), timeout])) });
    } catch (e) {
      out.push({ id, title, ok: false, detail: `${tr('ошибка', 'error')}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` });
    }
    onProgress([...out]);
  }
  return out;
}

export function formatDeviceReport(list: DeviceCheck[]): string {
  return [
    tr('Family Chat: проверка устройства', 'Family Chat: device check'),
    `${tr('Адрес', 'Address')}: ${location.origin}`,
    `${tr('Браузер', 'Browser')}: ${navigator.userAgent}`,
    `${tr('Время', 'Time')}: ${new Date().toISOString()}`,
    '',
    ...list.map((c) => `${c.ok === true ? '[ok]' : c.ok === false ? '[x] ' : '[i] '} ${c.title}: ${c.detail}`),
  ].join('\n');
}
