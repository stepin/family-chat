// Interrupted transfers against a real fcd: an upload broken after its first
// part continues after a page reload with the missing parts only; a download
// broken the same way continues after a reload; a full server disk (507)
// keeps the message and its text, says why it waits, and sends it when space
// is back.

import type { Page, Request } from '@playwright/test';
import { makeBytes } from './support/files.ts';
import { message } from './support/flows.ts';
import { pairInChat } from './support/media.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test } from './support/test.ts';

let fcd: Fcd;

test.beforeEach(async () => {
  fcd = new Fcd();
  await fcd.start('Ивановы', ['--max-file-mb', '12']);
});

test.afterEach(async () => {
  await fcd.dispose();
});

const PART = /\/v1\/blobs\/[a-z2-7]{26}\/(\d+)$/;

function partsSeen(page: Page, method: string): string[] {
  const seen: string[] = [];
  page.on('request', (r: Request) => {
    const m = PART.exec(new URL(r.url()).pathname);
    if (m && r.method() === method) seen.push(m[1]!);
  });
  return seen;
}

test('an upload and a download continue after a page reload', async ({ newUser }) => {
  test.setTimeout(300_000);
  const { mama, petya } = await pairInChat(newUser, fcd);
  const data = makeBytes(9 * 1024 * 1024 + 1234, 11); // three parts

  await test.step('the upload breaks after part 0; after a reload only parts 1 and 2 go up', async () => {
    let broken = 0;
    await mama.page.route(PART, (route) => {
      if (route.request().method() === 'PUT' && PART.exec(new URL(route.request().url()).pathname)![1] !== '0') {
        broken++;
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page.getByTestId('file-input').setInputFiles({ name: 'дача.bin', mimeType: 'application/octet-stream', buffer: data });
    await mama.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
    const sent = message(mama.page, 'дача.bin');
    await expect(sent.getByTestId('upload-progress')).toHaveText(/Загружается 4[0-9]%/, { timeout: 60_000 });
    await expect.poll(() => broken, { timeout: 30_000 }).toBeGreaterThan(0);
    await mama.page.unroute(PART);
    const after = partsSeen(mama.page, 'PUT');
    await mama.page.reload();
    await mama.page.locator('button.chat').filter({ hasText: 'Петя' }).click();
    await expect(message(mama.page, 'дача.bin')).toHaveAttribute('data-status', 'on-server', { timeout: 120_000 });
    expect([...new Set(after)].sort()).toEqual(['1', '2']);
  });

  await test.step('the download breaks after part 0; after a reload it goes on from part 1', async () => {
    let broken = 0;
    await petya.page.route(PART, (route) => {
      if (route.request().method() === 'GET' && PART.exec(new URL(route.request().url()).pathname)![1] !== '0') {
        broken++;
        return route.abort('connectionreset');
      }
      return route.continue();
    });
    const card = petya.page.getByTestId('attachment-file').filter({ hasText: 'дача.bin' });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Скачать: дача.bin' }).click();
    await expect(card).toContainText(/Скачивается 4[0-9]%/, { timeout: 60_000 });
    await expect.poll(() => broken, { timeout: 30_000 }).toBeGreaterThan(0);
    await petya.page.unroute(PART);
    const after = partsSeen(petya.page, 'GET');
    await petya.page.reload();
    await petya.page.locator('button.chat').filter({ hasText: 'Мама' }).click();
    const again = petya.page.getByTestId('attachment-file').filter({ hasText: 'дача.bin' });
    await expect(again).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
    expect([...new Set(after)].sort()).toEqual(['1', '2']);
    const download = petya.page.waitForEvent('download');
    await again.getByRole('button', { name: 'Сохранить: дача.bin' }).click();
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(await (await download).path());
    expect(bytes.equals(data)).toBe(true);
  });
});

test('a full server disk (507): the message and its text wait, then go out', async ({ newUser }) => {
  test.setTimeout(180_000);
  const { mama, petya } = await pairInChat(newUser, fcd);
  await mama.page.route(PART, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'storage_full', message: 'not enough free disk space on the server' }) })
      : route.continue(),
  );
  await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
  await mama.page.getByTestId('file-input').setInputFiles({ name: 'план.txt', mimeType: 'text/plain', buffer: Buffer.from('план на лето\n'.repeat(100)) });
  await mama.page.getByRole('dialog').getByLabel('Подпись').fill('Посмотри план');
  await mama.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
  const sent = message(mama.page, 'Посмотри план');
  await expect(sent.getByTestId('server-full')).toContainText('На сервере семьи не хватает места', { timeout: 30_000 });
  await expect(sent).toHaveAttribute('data-status', 'on-device');
  await expect(sent.getByTestId('attachment-file')).toContainText('На сервере не хватает места');
  await mama.page.unroute(PART);
  await expect(sent).toHaveAttribute('data-status', 'on-server', { timeout: 90_000 });
  await expect(sent.getByTestId('server-full')).toHaveCount(0);
  await expect(message(petya.page, 'Посмотри план')).toBeVisible({ timeout: 30_000 });
});
