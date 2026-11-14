// Screenshots of the app for the site, from a real fcd with an invented
// family (the Sokolovs). Run: pnpm --filter @family-chat/site run screenshots
// (with FCD_BIN=<path to fcd>, or it builds the client and fcd first). The
// PNG files go to apps/site/screenshots/ and are committed: the site build
// then needs neither a browser nor a Rust toolchain.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { Fcd } from '../../web/e2e/support/fcd.ts';
import { chatRow, createInvite, joinByLink, message, openChat, send, setupAdmin } from '../../web/e2e/support/flows.ts';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const FAMILY = 'Соколовы';

/** A person in a fresh browser. */
async function person(browser: Browser, viewport = { width: 1100, height: 760 }): Promise<Page> {
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport,
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  return context.newPage();
}

/** Opens the "⋯" menu of the last message with this text. */
async function menuOf(page: Page, text: string) {
  const m = message(page, text).last();
  await m.hover();
  await m.getByTestId('message-more').click();
  const menu = page.getByTestId('message-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Back to the chat list in the one-column layout, through any screens on the way. */
async function home(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (await page.getByRole('button', { name: 'Новый чат' }).isVisible()) return;
    const back = page.getByRole('button', { name: /^(К списку чатов|Назад)$/ }).first();
    await back.click();
  }
  await expect(page.getByRole('button', { name: 'Новый чат' })).toBeVisible();
}

/** Light and dark, after animations settle. `css`: one image pixel per CSS pixel. */
async function shoot(page: Page, name: string, scale: 'device' | 'css' = 'device'): Promise<void> {
  // No hover buttons and no focus ring from the last click.
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${name}-${scheme}.png`, scale, animations: 'disabled', caret: 'hide' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('screenshots of the app with the Sokolov family', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const fcd = new Fcd();
  await fcd.start(FAMILY);
  try {
    const anna = await person(browser, { width: 390, height: 844 });
    await setupAdmin(anna, fcd, 'Анна', FAMILY);
    const links = [await createInvite(anna), await createInvite(anna), await createInvite(anna)];

    const sergey = await person(browser);
    await joinByLink(sergey, links[0]!, 'Сергей');
    const nina = await person(browser);
    await joinByLink(nina, links[1]!, 'Бабушка Нина');
    const masha = await person(browser);
    await joinByLink(masha, links[2]!, 'Маша');

    // Direct chats with Anna (each joined straight into the chat with the inviter).
    await send(sergey, 'Купить по дороге молоко и хлеб?');
    await send(masha, 'Мам, я сегодня задержусь в школе до пяти');

    // The family group.
    await expect(chatRow(anna, 'Маша')).toBeVisible({ timeout: 30_000 });
    await anna.getByRole('button', { name: 'Новый чат' }).click();
    await anna.getByRole('button', { name: /Новая группа/ }).click();
    await anna.getByLabel('Название группы').fill(FAMILY);
    for (const name of ['Сергей', 'Бабушка Нина', 'Маша']) await anna.getByRole('checkbox', { name }).check();
    await anna.getByRole('button', { name: 'Создать группу' }).click();
    await expect(anna.getByRole('heading', { name: FAMILY, exact: true })).toBeVisible();
    await send(anna, 'Всем привет! В субботу едем на дачу, кто с нами?');
    for (const p of [sergey, nina, masha]) {
      await openChat(p, FAMILY);
      await expect(message(p, 'В субботу едем на дачу')).toBeVisible({ timeout: 30_000 });
    }
    await send(sergey, 'Я за рулём, выезжаем в 9:00');
    await expect(message(nina, 'выезжаем в 9:00')).toBeVisible({ timeout: 30_000 });
    await send(nina, 'Испеку пирог с яблоками');
    await expect(message(masha, 'пирог с яблоками')).toBeVisible({ timeout: 30_000 });
    let menu = await menuOf(masha, 'Испеку пирог с яблоками');
    await menu.getByRole('menuitem', { name: 'Ответить' }).click();
    await send(masha, 'Ура! Можно я помогу?');
    await expect(message(nina, 'Можно я помогу')).toBeVisible({ timeout: 30_000 });
    for (const p of [masha, nina]) {
      menu = await menuOf(p, 'Я за рулём, выезжаем в 9:00');
      await menu.getByRole('menuitemcheckbox', { name: 'Реакция: палец вверх' }).click();
    }
    menu = await menuOf(sergey, 'Испеку пирог с яблоками');
    await menu.getByRole('menuitemcheckbox', { name: 'Реакция: сердце' }).click();
    await expect(message(anna, 'Можно я помогу')).toBeVisible({ timeout: 30_000 });
    await expect(message(anna, 'Я за рулём').getByTestId('reaction-chip')).toContainText('2', { timeout: 30_000 });

    // Anna answers in the direct chats and keeps a note in "Избранное".
    await home(anna);
    await openChat(anna, 'Маша');
    await send(anna, 'Хорошо, позвони, как выйдешь');
    await home(anna);
    await openChat(anna, 'Сергей');
    await send(anna, 'Да, и ещё яблоки для пирога');
    await home(anna);
    await openChat(anna, 'Избранное');
    await send(anna, 'На дачу: удлинитель, семена, лейка');
    await home(anna);
    await expect(chatRow(anna, FAMILY)).toBeVisible();

    // A phone has a touch screen (pointer: coarse): the app's own touch layout.
    const cdp = await anna.context().newCDPSession(anna);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await shoot(anna, 'chat-list');
    await openChat(anna, FAMILY);
    await expect(message(anna, 'Можно я помогу')).toBeVisible();
    await shoot(anna, 'chat');

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await anna.setViewportSize({ width: 1100, height: 700 });
    await expect(anna.getByRole('heading', { name: FAMILY, exact: true })).toBeVisible();
    await shoot(anna, 'desktop', 'css');
  } finally {
    await fcd.dispose();
  }
});
