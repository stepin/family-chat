// Several families and stickers end to end against real fcd servers (Chromium):
// - a second family server added from the switcher with the same identity,
//   unread counts per family, switching, the badge and the title, removing a
//   family from the device;
// - a sticker pack imported from a generated .zip, published, sent as a
//   sticker (WebP and .tgs), seen by the other person; reduced motion keeps
//   the animation still until a tap; a deleted pack leaves a quiet placeholder;
// - the Web Share Target: the POST goes through the real service worker
//   (fetch from a controlled page, as the share sheet would send it), the app
//   opens with the chooser, the files land in the attachment preview.
// Axe checks of the new screens in light and dark themes.

import type { Page } from '@playwright/test';
import { createInvite, joinByLink, message, openChat, send, setupAdmin, toList } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { BADGE_STUB, tgs, webp, zipOf } from './support/stickers.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';

const one = new Fcd();
const two = new Fcd();
const three = new Fcd();
const four = new Fcd();

test.beforeAll(async () => {
  await Promise.all([one.start('Ивановы'), two.start('Петровы'), three.start('Ивановы'), four.start('Ивановы')]);
});

test.afterAll(async () => {
  await Promise.all([one.dispose(), two.dispose(), three.dispose(), four.dispose()]);
});

async function badges(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __badges: number[] }).__badges);
}

async function bothThemes(page: Page, what: string): Promise<void> {
  await expectAccessible(page, `${what} (light)`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, `${what} (dark)`);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The family open now, read from the switcher's sheet (the header no longer shows it). */
async function currentFamily(page: Page): Promise<string> {
  await page.getByTestId('family-switcher').click();
  const menu = page.getByTestId('family-menu');
  await expect(menu).toBeVisible();
  const text = (await menu.locator('[aria-current="true"]').textContent()) ?? '';
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return text;
}

async function firstMessage(page: Page, text: string): Promise<void> {
  await send(page, text);
  const later = page.getByRole('button', { name: 'Позже' });
  if (await later.isVisible().catch(() => false)) await later.click();
}

test('two family servers: add, switch with unread counts, badge, remove', async ({ newUser }) => {
  test.setTimeout(300_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 }, init: BADGE_STUB });
  const papa: User = await newUser({ viewport: { width: 1000, height: 760 } });
  const babushka: User = await newUser({ viewport: { width: 1000, height: 760 } });

  const { inviteLink } = await setupAdmin(mama.page, one, 'Мама', 'Ивановы');
  await joinByLink(papa.page, inviteLink, 'Папа');
  await firstMessage(papa.page, 'Привет из Ивановых');
  await setupAdmin(babushka.page, two, 'Бабушка', 'Петровы');
  const linkTwo = await createInvite(babushka.page);
  await openChat(mama.page, 'Папа');
  await expect(message(mama.page, 'Привет из Ивановых')).toBeVisible();

  await test.step('add the second family from Settings, with the same identity', async () => {
    // With one family there is no family label or switcher at the top.
    await toList(mama.page);
    await expect(mama.page.getByTestId('family-switcher')).toHaveCount(0);
    await expect(mama.page.locator('.list-pane .screen-header')).not.toContainText('Ивановы');
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Семьи на этом устройстве/ }).click();
    await mama.page.getByRole('button', { name: 'Добавить семью' }).click();
    await expect(mama.page.getByRole('heading', { name: 'Добавить семью', exact: true })).toBeVisible();
    await mama.page.getByLabel('Ссылка-приглашение').fill(linkTwo);
    await mama.page.getByRole('button', { name: 'Проверить' }).click();
    await expect(mama.page.getByTestId('add-invited')).toContainText('«Петровы»');
    await expect(mama.page.getByLabel(/Та же личность, что в семье «Ивановы»/)).toBeChecked();
    await expect(mama.page.getByLabel('Как вас зовут в этой семье')).toHaveValue('Мама');
    await bothThemes(mama.page, 'add a family');
    await mama.page.getByTestId('add-family-submit').click();
    await expect(mama.page.getByText('Семья «Петровы» добавлена')).toBeVisible();
    // Two families: a compact switcher named "Семьи", without the name as text.
    const switcher = mama.page.getByTestId('family-switcher');
    await expect(switcher).toHaveAccessibleName('Семьи');
    await expect(switcher).not.toContainText('Петровы');
    expect(await currentFamily(mama.page)).toContain('Петровы');
    await switcher.click();
    await expect(mama.page.getByTestId('family-menu').getByTestId('family-item')).toHaveCount(2);
    await bothThemes(mama.page, 'family switcher');
    await mama.page.keyboard.press('Escape');
  });

  await test.step('write in the second family; unread from the first shows on the switcher', async () => {
    // Joining by invitation opens the chat with the person who invited.
    await openChat(mama.page, 'Бабушка');
    await firstMessage(mama.page, 'Привет, бабушка');
    await expect(babushka.page.locator('button.chat', { hasText: 'Мама' })).toBeVisible({ timeout: 30_000 });
    // Leave the chat, so that new messages stay unread.
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await send(papa.page, 'Как дела?');
    await openChat(babushka.page, 'Мама');
    await send(babushka.page, 'Бабушка отвечает');
    await expect(mama.page.getByTestId('unread-elsewhere')).toHaveText('1', { timeout: 30_000 });
    await expect(mama.page.locator('button.chat', { hasText: 'Бабушка' }).locator('.badge')).toHaveText('1');
    await expect.poll(() => mama.page.title()).toBe('(2) Family Chat');
    await expect.poll(async () => (await badges(mama.page)).at(-1)).toBe(2);
  });

  await test.step('switch families; reading clears the badge', async () => {
    await mama.page.getByTestId('family-switcher').click();
    const items = mama.page.getByTestId('family-item');
    await expect(items).toHaveCount(2);
    await expect(items.filter({ hasText: 'Ивановы' })).toContainText('1');
    await items.filter({ hasText: 'Ивановы' }).click();
    expect(await currentFamily(mama.page)).toContain('Ивановы');
    await openChat(mama.page, 'Папа');
    await expect(message(mama.page, 'Как дела?')).toBeVisible();
    await expect.poll(async () => (await badges(mama.page)).at(-1)).toBe(1);
    await mama.page.getByTestId('family-switcher').click();
    await mama.page.getByTestId('family-item').filter({ hasText: 'Петровы' }).click();
    await openChat(mama.page, 'Бабушка');
    await expect(message(mama.page, 'Бабушка отвечает')).toBeVisible();
    await expect.poll(async () => (await badges(mama.page)).at(-1)).toBe(0);
    await expect.poll(() => mama.page.title()).toBe('Family Chat');
  });

  await test.step('the identity is the same in both families', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Безопасность/ }).click();
    await expect(mama.page.getByTestId('identity-families')).toContainText('«Ивановы», «Петровы»');
    await mama.page.getByRole('button', { name: 'Назад' }).click();
  });

  await test.step('remove the second family from this device', async () => {
    await mama.page.getByRole('button', { name: /Семьи на этом устройстве/ }).click();
    await expect(mama.page.getByTestId('family-row')).toHaveCount(2);
    await bothThemes(mama.page, 'families');
    await mama.page.getByTestId('family-row').filter({ hasText: 'Петровы' }).getByTestId('family-remove').click();
    const confirm = mama.page.getByTestId('family-remove-confirm');
    await expect(confirm).toBeDisabled();
    await bothThemes(mama.page, 'remove a family');
    await mama.page.getByLabel('Я понимаю, что переписка пропадёт с этого устройства').check();
    await confirm.click();
    await expect(mama.page.getByText('Семья «Петровы» убрана с этого устройства')).toBeVisible();
    await expect(mama.page.getByTestId('family-row')).toHaveCount(1);
    // One family again: the switcher is gone.
    await expect(mama.page.getByTestId('family-switcher')).toHaveCount(0);
    await send(papa.page, 'Всё ещё здесь?');
    await openChat(mama.page, 'Папа');
    await expect(message(mama.page, 'Всё ещё здесь?')).toBeVisible();
  });
});

test('stickers: import, publish, send, reduced motion, deletion', async ({ newUser }) => {
  test.setTimeout(300_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const papa: User = await newUser({ viewport: { width: 400, height: 800 }, reducedMotion: 'reduce' });
  const { inviteLink } = await setupAdmin(mama.page, three);
  await joinByLink(papa.page, inviteLink, 'Папа');
  await firstMessage(papa.page, 'Жду стикеры');

  await test.step('import a pack from a .zip and publish it', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Стикеры/ }).click();
    await expect(mama.page.getByRole('heading', { name: 'Наборы стикеров' })).toBeVisible();
    const zip = zipOf([
      { name: 'cats/😺.webp', data: await webp(mama.page) },
      { name: 'cats/🎉.tgs', data: tgs() },
      { name: 'cats/evil.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') },
    ]);
    await mama.page.getByTestId('sticker-input').setInputFiles({ name: 'cats.zip', mimeType: 'application/zip', buffer: zip });
    await expect(mama.page.getByTestId('local-sticker')).toHaveCount(2);
    await expect(mama.page.getByTestId('sticker-skipped')).toContainText('evil.svg: не стикер');
    await expect(mama.page.getByLabel('Название набора')).toHaveValue('cats');
    await mama.page.getByLabel('Название набора').fill('Котики');
    await bothThemes(mama.page, 'sticker pack preview');
    await mama.page.getByTestId('sticker-publish').click();
    await expect(mama.page.getByText('Набор опубликован')).toBeVisible();
    await expect(mama.page.getByTestId('sticker-pack')).toContainText('Ваш набор');
    await bothThemes(mama.page, 'sticker packs');
  });

  await test.step('send stickers from the picker', async () => {
    await openChat(mama.page, 'Папа');
    await mama.page.getByTestId('emoji-button').click();
    await mama.page.getByTestId('picker-mode-stickers').click();
    await expect(mama.page.getByTestId('sticker-cell')).toHaveCount(2);
    await bothThemes(mama.page, 'sticker picker');
    await mama.page.getByRole('button', { name: 'Отправить стикер 🎉' }).click();
    const animated = mama.page.getByTestId('message').locator('[data-testid="sticker"][data-type="tgs"]');
    await expect(animated).toBeVisible();
    await expect(animated.locator('svg')).toBeVisible();
    await expect(animated.getByTestId('sticker-lottie')).toHaveAttribute('data-playing', 'true');
    // The picker remembers the tab and the sticker.
    await mama.page.getByTestId('emoji-button').click();
    await expect(mama.page.getByTestId('picker-mode-stickers')).toHaveAttribute('aria-selected', 'true');
    await expect(mama.page.getByTestId('sticker-tab').first()).toHaveText('Недавние');
    await mama.page.getByTestId('sticker-tab').filter({ hasText: 'Котики' }).click();
    await mama.page.getByRole('button', { name: 'Отправить стикер 😺' }).click();
    await expect(mama.page.getByTestId('message').locator('[data-testid="sticker"][data-type="webp"] img')).toBeVisible();
    // The expression inside the animation never ran.
    expect(await mama.page.evaluate(() => (window as unknown as { __lottieExpression?: boolean }).__lottieExpression)).toBeUndefined();
    await bothThemes(mama.page, 'chat with stickers');
  });

  await test.step('the other person sees them; reduced motion waits for a tap', async () => {
    const still = papa.page.getByTestId('message').locator('button[data-testid="sticker"][data-type="tgs"]');
    await expect(still).toBeVisible({ timeout: 30_000 });
    await expect(still).toHaveAccessibleName('Стикер 🎉. Проиграть стикер');
    await expect(still.getByTestId('sticker-lottie')).toHaveAttribute('data-playing', 'false');
    await still.click();
    await expect(still.getByTestId('sticker-lottie')).toHaveAttribute('data-playing', 'true');
    await expect(papa.page.getByTestId('message').locator('[data-testid="sticker"][data-type="webp"] img')).toBeVisible();
  });

  await test.step('the uploader deletes the pack: a quiet placeholder stays', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Стикеры/ }).click();
    await mama.page.getByTestId('sticker-pack-delete').click();
    await mama.page.getByTestId('sticker-pack-delete-confirm').click();
    await expect(mama.page.getByText('Набор удалён')).toBeVisible();
    // Papa's app learns it with the next pack list (the manager reads it).
    await toList(papa.page);
    await papa.page.getByRole('button', { name: 'Настройки' }).click();
    await papa.page.getByRole('button', { name: /Стикеры/ }).click();
    await expect(papa.page.getByText('В этой семье пока нет стикеров.')).toBeVisible();
    await papa.page.getByRole('button', { name: 'Назад' }).click();
    await papa.page.getByRole('button', { name: 'Назад' }).click();
    await openChat(papa.page, 'Мама');
    await expect(papa.page.getByTestId('sticker-missing')).toHaveCount(2);
    await expect(papa.page.getByTestId('message').filter({ has: papa.page.getByTestId('sticker-missing') }).first()).toContainText('🎉');
  });
});

test('share into the app: through the service worker, choose the chat, send', async ({ newUser }) => {
  test.setTimeout(240_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const papa: User = await newUser({ viewport: { width: 1000, height: 760 } });
  const { inviteLink } = await setupAdmin(mama.page, four);
  await joinByLink(papa.page, inviteLink, 'Папа');
  await firstMessage(papa.page, 'Пришли ссылку');

  // The installed app's service worker takes the share; the page must be controlled by it.
  await mama.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await mama.page.reload();
  await expect(mama.page.getByTestId('status-line')).toContainText('На связи');
  expect(await mama.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const post = (files: number) =>
    mama.page.evaluate(async (n) => {
      const form = new FormData();
      form.set('title', 'Статья');
      form.set('text', 'Посмотри');
      form.set('url', 'https://example.org/a');
      for (let i = 0; i < n; i++) form.append('files', new File([`заметка ${i}`], `note${i}.txt`, { type: 'text/plain' }));
      const res = await fetch('./share-target', { method: 'POST', body: form, redirect: 'manual' });
      return res.type;
    }, files);

  await test.step('too many files are refused with a reason', async () => {
    expect(await post(11)).toBe('opaqueredirect');
    await mama.page.goto(`${four.url}/?share=1`);
    await expect(mama.page.getByText('Можно поделиться не больше чем 10 файлами за раз.')).toBeVisible();
  });

  await test.step('text and a file reach the chosen chat', async () => {
    expect(await post(1)).toBe('opaqueredirect');
    await mama.page.goto(`${four.url}/?share=1`);
    const sheet = mama.page.getByTestId('share-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('share-summary')).toContainText('Статья');
    await bothThemes(mama.page, 'share chooser');
    await sheet.getByLabel('Папа').check();
    await sheet.getByTestId('share-next').click();
    await expect(mama.page.getByText('Проверьте и отправьте.')).toBeVisible();
    await expect(mama.page.getByText('note0.txt')).toBeVisible();
    await expect(mama.page.getByLabel('Подпись')).toHaveValue('Статья\nПосмотри\nhttps://example.org/a');
    await mama.page.getByRole('button', { name: 'Отправить', exact: true }).last().click();
    await expect(papa.page.getByTestId('message').filter({ hasText: 'note0.txt' })).toBeVisible({ timeout: 30_000 });
    await expect(papa.page.getByTestId('message').filter({ hasText: 'Посмотри' })).toBeVisible();
    // The stash is used once: opening the address again shares nothing.
    await mama.page.goto(`${four.url}/?share=1`);
    await expect(mama.page.getByText('То, чем вы поделились, не дошло до приложения. Попробуйте ещё раз.')).toBeVisible();
  });
});
