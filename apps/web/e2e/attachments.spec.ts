// Attachments end to end against a real fcd (file limit 6 MB): a photo is
// downscaled, sent and received (thumbnail, then the picture; the viewer
// opens and closes with Escape); a file is sent, downloaded and saved; a
// file larger than one 4 MiB part goes through; an image pasted from the
// clipboard opens the preview; a file over the limit is refused before
// uploading, with the limit named.

import { readFileSync } from 'node:fs';
import { makeBytes, makePng } from './support/files.ts';
import { joinByLink, message, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test } from './support/test.ts';

const fcd = new Fcd();
const wide = { viewport: { width: 1200, height: 860 } };

test.beforeAll(async () => {
  await fcd.start('Ивановы', ['--max-file-mb', '6']);
});

test.afterAll(async () => {
  await fcd.dispose();
});

test('photos and files', async ({ newUser }) => {
  test.setTimeout(300_000);
  const mama = await newUser(wide);
  const { inviteLink } = await setupAdmin(mama.page, fcd);
  const petya = await newUser(wide);
  await joinByLink(petya.page, inviteLink, 'Петя');
  await petya.page.getByLabel('Сообщение').fill('Привет');
  await petya.page.getByLabel('Сообщение').press('Enter');
  await petya.page.getByRole('button', { name: 'Позже' }).click();
  await mama.page.locator('button.chat').filter({ hasText: 'Петя' }).click({ timeout: 30_000 });
  await expect(mama.page.getByRole('heading', { name: 'Петя', exact: true })).toBeVisible();

  await test.step('a photo is downscaled, sent with a caption and received', async () => {
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await expect(mama.page.getByRole('button', { name: 'Фото' })).toBeVisible();
    await mama.page.getByTestId('photo-input').setInputFiles({ name: 'дача.png', mimeType: 'image/png', buffer: makePng(3000, 2000) });
    const preview = mama.page.getByRole('dialog');
    await expect(preview.getByTestId('preview-item')).toHaveCount(1);
    await expect(preview.getByRole('switch', { name: /Отправить оригинал/ })).not.toBeChecked();
    await expectAccessible(mama.page, 'attachment preview');
    await preview.getByLabel('Подпись').fill('Дача летом');
    await preview.getByRole('button', { name: 'Отправить' }).click();
    await expect(preview).toBeHidden({ timeout: 30_000 });
    const sent = message(mama.page, 'Дача летом');
    await expect(sent).toHaveAttribute('data-status', 'on-server', { timeout: 60_000 });
    await expect(sent.getByTestId('attachment-image')).toBeVisible();

    const got = message(petya.page, 'Дача летом');
    await expect(got).toBeVisible({ timeout: 30_000 });
    const image = got.getByTestId('attachment-image');
    // The list does not jump: the frame has the picture's proportions from the start.
    const box = await image.locator('.frame').boundingBox();
    expect(Math.abs(box!.width / box!.height - 1.5)).toBeLessThan(0.05);
    await expect(image).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    const full = image.locator('img.full');
    await expect(full).toBeVisible();
    const dims = await full.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
    expect(dims).toEqual([2048, 1365]);
    expect(await full.getAttribute('src')).toMatch(/^blob:/);
    await expectAccessible(petya.page, 'chat with a photo');
  });

  await test.step('the viewer opens, and closes with Escape', async () => {
    await petya.page.getByRole('button', { name: /Открыть фото/ }).click();
    const viewer = petya.page.getByTestId('image-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId('viewer-image')).toBeVisible({ timeout: 30_000 });
    await viewer.getByRole('button', { name: 'Увеличить' }).click();
    await expect(viewer.getByRole('button', { name: 'Уменьшить' })).toBeEnabled();
    await expectAccessible(petya.page, 'image viewer');
    await petya.page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    // Escape closed only the viewer, not the chat.
    await expect(petya.page.getByRole('heading', { name: 'Мама', exact: true })).toBeVisible();
  });

  await test.step('a file is sent, downloaded and saved', async () => {
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page
      .getByTestId('file-input')
      .setInputFiles({ name: 'отчёт.txt', mimeType: 'text/plain', buffer: Buffer.from('Отчёт за неделю\n'.repeat(50)) });
    await mama.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
    const card = petya.page.getByTestId('attachment-file').filter({ hasText: 'отчёт.txt' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Files are not downloaded by themselves; the card says how long they stay.
    await expect(card).toContainText('Доступно ещё 90 дней');
    await card.getByRole('button', { name: 'Скачать: отчёт.txt' }).click();
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    const download = petya.page.waitForEvent('download');
    await card.getByRole('button', { name: 'Сохранить: отчёт.txt' }).click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('отчёт.txt');
    expect(readFileSync(await d.path()).toString()).toBe('Отчёт за неделю\n'.repeat(50));
  });

  await test.step('a file larger than one part', async () => {
    const big = makeBytes(4 * 1024 * 1024 + 300_000, 7);
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page.getByTestId('file-input').setInputFiles({ name: 'видео.bin', mimeType: 'application/octet-stream', buffer: big });
    await mama.page.getByRole('dialog').getByRole('button', { name: 'Отправить' }).click();
    const card = petya.page.getByTestId('attachment-file').filter({ hasText: 'видео.bin' });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Скачать: видео.bin' }).click();
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    const download = petya.page.waitForEvent('download');
    await card.getByRole('button', { name: 'Сохранить: видео.bin' }).click();
    const bytes = readFileSync(await (await download).path());
    expect(bytes.length).toBe(big.length);
    expect(bytes.equals(big)).toBe(true);
  });

  await test.step('a file over the limit is refused before uploading', async () => {
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page
      .getByTestId('file-input')
      .setInputFiles({ name: 'огромный.bin', mimeType: 'application/octet-stream', buffer: makeBytes(7 * 1024 * 1024, 3) });
    const preview = mama.page.getByRole('dialog');
    await expect(preview.getByRole('alert')).toHaveText('«огромный.bin» больше предела семьи (6 МБ). Такой файл не отправить.');
    await expect(preview.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await preview.getByRole('button', { name: 'Отмена' }).click();
    await expect(preview).toBeHidden();
  });

  await test.step('an image pasted from the clipboard opens the preview', async () => {
    const png = makePng(320, 240, 90).toString('base64');
    await mama.page.getByLabel('Сообщение').fill('Скриншот');
    await mama.page.getByLabel('Сообщение').evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    const preview = mama.page.getByRole('dialog');
    await expect(preview.getByTestId('preview-item')).toHaveCount(1);
    // The text typed so far becomes the caption.
    await expect(preview.getByLabel('Подпись')).toHaveValue('Скриншот');
    await preview.getByRole('button', { name: 'Отправить' }).click();
    await expect(mama.page.getByLabel('Сообщение')).toHaveValue('');
    const got = message(petya.page, 'Скриншот');
    await expect(got.getByTestId('attachment-image')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  });

  await test.step('the viewer swipes between the images of the chat', async () => {
    await message(petya.page, 'Скриншот').getByRole('button', { name: /Открыть фото/ }).click();
    const viewer = petya.page.getByTestId('image-viewer');
    await expect(viewer).toContainText('2 из 2');
    await petya.page.keyboard.press('ArrowLeft');
    await expect(viewer).toContainText('1 из 2');
    await viewer.getByRole('button', { name: 'Закрыть' }).click();
    await expect(viewer).toBeHidden();
  });
});
