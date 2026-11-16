// The invitation gateway's platform branches, by
// user-agent emulation. One real invitation is issued in beforeAll and never
// spent: neither the gateway nor the invitation check uses it up. The
// unknown code is well formed but was never issued.

import { setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test } from './support/test.ts';

const fcd = new Fcd();
const CODE = 'abcdefghijklmnopqrstuvwxyz';
let inviteLink = '';

const UA = {
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  telegramAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.157 Mobile Safari/537.36 Telegram-Android/11.14.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
};

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
// The installed app on iOS: navigator.standalone is true.
const STANDALONE = `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });`;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  await fcd.start();
  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();
  inviteLink = (await setupAdmin(page, fcd, 'Мама', 'Ивановы', 'f')).inviteLink;
  await context.close();
});

test.afterAll(async () => {
  await fcd.dispose();
});

const link = () => inviteLink;

test('iOS Safari: install first, copy the invitation, no identity created', async ({ newUser }) => {
  const { page, context } = await newUser({ ...phone, userAgent: UA.iosSafari });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fcd.url });
  await page.goto(link());
  await expect.poll(() => page.url()).toBe(`${fcd.url}/`);
  await expect(page.getByRole('heading', { name: 'Вас пригласили в «Ивановы»' })).toBeVisible();
  await expect(page.getByText('Нажмите «Поделиться»')).toBeVisible();
  await expect(page.getByText('Выберите «На экран "Домой"»')).toBeVisible();
  await expect(page.getByLabel('Как вас зовут')).toHaveCount(0);
  await page.getByRole('button', { name: 'Скопировать приглашение' }).click();
  await expect(page.getByText('Приглашение скопировано')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link());
  // Nothing was created in Safari's storage.
  const identities = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('family-chat');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('identities')) return resolve(0);
          const count = db.transaction('identities').objectStore('identities').count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );
  expect(identities).toBe(0);

  // Restore is also deferred until the app is installed. This server already
  // has its administrator, so setup is not offered at all.
  await page.goto(`${fcd.url}/`);
  await expect(page.locator('main.welcome')).toHaveAttribute('data-hello', 'done');
  await expect(page.getByRole('button', { name: 'Настроить для своей семьи' })).toHaveCount(0);
  await expect(page.getByTestId('server-taken')).toBeVisible();
  await page.getByRole('button', { name: 'Восстановить по фразе' }).click();
  await expect(page.getByRole('heading', { name: 'Сначала установите приложение' })).toBeVisible();
});

test('iOS installed app: the first screen pastes the invitation', async ({ newUser }) => {
  const { page } = await newUser({ ...phone, userAgent: UA.iosSafari, init: STANDALONE });
  await page.goto(`${fcd.url}/`);
  await expect(page.getByRole('heading', { name: 'Добро пожаловать' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вставить приглашение' })).toBeVisible();
  await page.getByLabel('Ссылка-приглашение').fill(`Вот приглашение: ${link()}`);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByRole('heading', { name: 'Вас пригласила Мама в «Ивановы»' })).toBeVisible();
  await expect(page.getByLabel('Как вас зовут')).toBeVisible();
});

test('another browser on iOS: open in Safari', async ({ newUser }) => {
  const { page } = await newUser({ ...phone, userAgent: UA.iosChrome });
  await page.goto(link());
  await expect(page.getByRole('heading', { name: 'Откройте ссылку в Safari' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скопировать ссылку' })).toBeVisible();
});

test('messenger in-app browser: open in Safari or Chrome and copy the link', async ({ newUser }) => {
  const { page, context } = await newUser({ ...phone, userAgent: UA.telegramAndroid });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fcd.url });
  await page.goto(link());
  await expect(page.getByRole('heading', { name: 'Откройте ссылку в браузере' })).toBeVisible();
  await expect(page.getByText('Открыть в браузере')).toBeVisible();
  await page.getByRole('button', { name: 'Скопировать ссылку' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link());
  await expect(page.getByLabel('Как вас зовут')).toHaveCount(0);
});

test('Android Chrome: installation offered, joining continues in the browser', async ({ newUser }) => {
  const { page } = await newUser({ ...phone, userAgent: UA.androidChrome });
  await page.goto(link());
  await expect(page.getByRole('heading', { name: 'Установите приложение' })).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить в браузере' }).click();
  await expect(page.getByLabel('Как вас зовут')).toBeVisible();
});

test('desktop: straight to the name', async ({ newUser }) => {
  const { page } = await newUser();
  await page.goto(link());
  await expect(page.getByRole('heading', { name: 'Вас пригласила Мама в «Ивановы»' })).toBeVisible();
  await expect(page.getByLabel('Как вас зовут')).toBeVisible();
  expect(page.url()).toBe(`${fcd.url}/`);
});

test('an unknown invitation is refused with a plain message before the name', async ({ newUser }) => {
  const { page } = await newUser();
  await page.goto(`${fcd.url}/#invite=${CODE}`);
  await expect(page.getByText('Это приглашение не найдено')).toBeVisible();
  await expect(page.getByLabel('Как вас зовут')).toHaveCount(0);
});

test('an unreachable server is reported', async ({ newUser }) => {
  const { page } = await newUser();
  await page.goto(`${fcd.url}/`);
  await page.getByRole('button', { name: 'У меня есть приглашение' }).click();
  await page.getByLabel('Ссылка-приглашение').fill(`https://127.0.0.1:1/#invite=${CODE}`);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByText('Не удаётся связаться с сервером семьи')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
});

test('a database from a newer app version is not touched', async ({ newUser }) => {
  const { page } = await newUser();
  await page.goto(`${fcd.url}/device/`);
  // Dexie stores schema version n as IndexedDB version n * 10; 100 means schema 10.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('family-chat', 100);
        req.onupgradeneeded = () => req.result.createObjectStore('accounts', { keyPath: 'id' });
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.goto(`${fcd.url}/`);
  await expect(page.getByRole('heading', { name: 'Нужна более новая версия приложения' })).toBeVisible();
});
