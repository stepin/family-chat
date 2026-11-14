/**
 * Device checks for M0 (docs/PLAN.md 7.8 and section 9): OPFS vs IndexedDB on
 * iOS, image encoding (WebP or JPEG), resize via createImageBitmap, and the
 * browser features the client relies on. Results go to a copyable report.
 */
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
  ['secure', 'Защищённый контекст (HTTPS)', async () => ({ ok: window.isSecureContext, detail: String(window.isSecureContext) })],
  [
    'standalone',
    'Открыто как установленное приложение',
    async () => {
      const s = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      return { ok: null, detail: s ? 'да' : 'нет (откройте с экрана Домой, чтобы проверить установленное приложение)' };
    },
  ],
  [
    'sw',
    'Service worker',
    async () => {
      if (!('serviceWorker' in navigator)) return { ok: false, detail: 'не поддерживается' };
      const reg = await navigator.serviceWorker.getRegistration();
      return { ok: !!reg, detail: reg ? `зарегистрирован, управляет страницей: ${navigator.serviceWorker.controller ? 'да' : 'нет'}` : 'не зарегистрирован' };
    },
  ],
  [
    'persist',
    'Постоянное хранилище (storage.persist)',
    async () => {
      if (!navigator.storage?.persist) return { ok: false, detail: 'не поддерживается' };
      const granted = await navigator.storage.persist();
      const est = await navigator.storage.estimate();
      const gb = (n?: number): string => (n === undefined ? '?' : `${(n / 1024 ** 3).toFixed(2)} ГБ`);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const note = granted ? '' : standalone ? ' (в установленном приложении отказ: данные могут быть вытеснены)' : ' (во вкладке браузера отказ обычен; важен результат в установленном приложении)';
      return {
        ok: granted ? true : standalone ? false : null,
        detail: `persist: ${granted}; занято ${gb(est.usage)} из ${gb(est.quota)}${note}`,
      };
    },
  ],
  [
    'idb',
    'IndexedDB: запись и чтение 1 МБ',
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
          results.push(`${label}: ${same ? 'записан и прочитан без изменений' : 'содержимое отличается'}`);
          ok ||= same;
          if (same && label === 'Blob') break;
        } catch (e) {
          results.push(`${label}: ошибка ${why(e)}`);
        }
      }
      db.close();
      indexedDB.deleteDatabase('fc-device-check');
      return { ok, detail: results.join('; ') };
    },
  ],
  [
    'opfs-main',
    'OPFS: запись из страницы (createWritable)',
    async () => {
      if (!navigator.storage?.getDirectory) return { ok: false, detail: 'OPFS не поддерживается' };
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('fc-device-check.bin', { create: true });
      if (!('createWritable' in fh)) {
        await dir.removeEntry('fc-device-check.bin');
        return { ok: false, detail: 'нет createWritable (возможна запись только из воркера)' };
      }
      const w = await fh.createWritable();
      await w.write(new Uint8Array(1024 * 1024));
      await w.close();
      const size = (await fh.getFile()).size;
      await dir.removeEntry('fc-device-check.bin');
      return { ok: size === 1024 * 1024, detail: `записан и прочитан файл ${size} байт` };
    },
  ],
  [
    'opfs-worker',
    'OPFS: запись из воркера (createSyncAccessHandle)',
    async () => {
      const worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
      const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, detail: 'воркер не ответил за 10 с' }), 10_000);
        worker.onmessage = (e) => {
          clearTimeout(timer);
          resolve(e.data as { ok: boolean; detail: string });
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          resolve({ ok: false, detail: `ошибка воркера: ${e.message}` });
        };
      });
      worker.terminate();
      return result;
    },
  ],
  [
    'webp',
    'Кодирование WebP',
    async () => {
      const b = await blobFromCanvas(testCanvas(), 'image/webp');
      const webp = b?.type === 'image/webp';
      return { ok: webp ? true : null, detail: `получен ${b?.type ?? 'null'}${webp ? '' : ': WebP не кодируется, клиент будет использовать JPEG'}` };
    },
  ],
  [
    'jpeg',
    'Кодирование JPEG',
    async () => {
      const b = await blobFromCanvas(testCanvas(), 'image/jpeg');
      return { ok: b?.type === 'image/jpeg', detail: `получен ${b?.type ?? 'null'}, ${b?.size ?? 0} байт` };
    },
  ],
  [
    'resize',
    'Уменьшение через createImageBitmap',
    async () => {
      const bmp = await createImageBitmap(testCanvas(), { resizeWidth: 100, resizeHeight: 75, resizeQuality: 'high' });
      const ok = bmp.width === 100 && bmp.height === 75;
      return { ok, detail: `получено ${bmp.width}x${bmp.height}${ok ? '' : ' (параметры resize не поддерживаются)'}` };
    },
  ],
  [
    'offscreen',
    'OffscreenCanvas с WebP',
    async () => {
      if (typeof OffscreenCanvas === 'undefined') return { ok: false, detail: 'нет OffscreenCanvas' };
      const c = new OffscreenCanvas(64, 64);
      c.getContext('2d')!.fillRect(0, 0, 64, 64);
      const b = await c.convertToBlob({ type: 'image/webp' });
      const webp = b.type === 'image/webp';
      return { ok: webp ? true : null, detail: `convertToBlob дал ${b.type}${webp ? '' : ': WebP не кодируется, клиент будет использовать JPEG'}` };
    },
  ],
  ['locks', 'Web Locks', async () => ({ ok: 'locks' in navigator, detail: 'locks' in navigator ? 'есть' : 'нет' })],
  [
    'periodic',
    'Periodic Background Sync',
    async () => {
      const has = 'periodicSync' in ServiceWorkerRegistration.prototype;
      return { ok: null, detail: has ? 'API есть (реальная частота проверяется отдельно)' : 'нет: фоновая проверка в закрытом приложении недоступна' };
    },
  ],
  [
    'notify',
    'Уведомления',
    async () => ({ ok: null, detail: 'Notification' in window ? `API есть, разрешение: ${Notification.permission}` : 'нет API (на iOS только в установленном приложении)' }),
  ],
  ['badge', 'Бейдж на значке', async () => ({ ok: null, detail: 'setAppBadge' in navigator ? 'есть' : 'нет' })],
  [
    'lna',
    'Разрешение на доступ к локальной сети (Chrome)',
    async () => {
      try {
        const s = await navigator.permissions.query({ name: 'local-network-access' as PermissionName });
        return { ok: null, detail: s.state };
      } catch {
        return { ok: null, detail: 'не поддерживается этим браузером' };
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
        setTimeout(() => resolve({ ok: null, detail: 'нет ответа за 8 с: браузер, вероятно, ждёт ответа на запрос разрешения' }), 8_000),
      );
      out.push({ id, title, ...(await Promise.race([step(), timeout])) });
    } catch (e) {
      out.push({ id, title, ok: false, detail: `ошибка: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` });
    }
    onProgress([...out]);
  }
  return out;
}

export function formatDeviceReport(list: DeviceCheck[]): string {
  return [
    'Family Chat: проверка устройства',
    `Адрес: ${location.origin}`,
    `Браузер: ${navigator.userAgent}`,
    `Время: ${new Date().toISOString()}`,
    '',
    ...list.map((c) => `${c.ok === true ? '[ok]' : c.ok === false ? '[x] ' : '[i] '} ${c.title}: ${c.detail}`),
  ].join('\n');
}
