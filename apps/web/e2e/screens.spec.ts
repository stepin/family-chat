// Layout (two columns from 900 px, one column below), accessibility of the
// main screens with axe in both themes, the check pages, and a check that the
// CSP guard of these tests really catches violations.

import { joinByLink, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, makeUser, test, type User } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

test('layout, accessibility and keyboard on the main screens', async ({ newUser }) => {
  test.setTimeout(180_000);
  const admin: User = await newUser({ viewport: { width: 1200, height: 800 } });

  await test.step('welcome screen is accessible (light and dark)', async () => {
    await admin.page.goto(`${fcd.url}/`);
    await expect(admin.page.getByRole('button', { name: 'У меня есть приглашение' })).toBeVisible();
    await expectAccessible(admin.page, 'welcome (light)');
    await admin.page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(admin.page, 'welcome (dark)');
    await admin.page.emulateMedia({ colorScheme: 'light' });
  });

  const { inviteLink } = await setupAdmin(admin.page, fcd);
  const member = await newUser({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await joinByLink(member.page, inviteLink, 'Бабушка');
  // A touch device: Enter is a new line, the button sends.
  await member.page.getByLabel('Сообщение').fill('Здравствуйте');
  await member.page.getByRole('button', { name: 'Отправить' }).click();
  await member.page.getByRole('button', { name: 'Позже' }).click();

  await test.step('1200 px: two columns, list and chat side by side', async () => {
    const page = admin.page;
    await expect(page.locator('[data-layout="two-columns"]')).toBeVisible();
    await expect(page.getByText('Выберите чат')).toBeVisible();
    await expectAccessible(page, 'chat list (wide)');
    const row = page.getByRole('button', { name: /Бабушка/ });
    await row.click({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Бабушка' })).toBeVisible();
    await expect(row).toBeVisible();
    const list = await page.locator('.list-pane').boundingBox();
    const content = await page.locator('.content-pane').boundingBox();
    expect(list!.width).toBeGreaterThan(300);
    expect(content!.x).toBeGreaterThanOrEqual(list!.x + list!.width - 1);
    // Desktop keyboard: Shift+Enter breaks the line, Enter sends.
    const box = page.getByLabel('Сообщение');
    await box.focus();
    await page.keyboard.type('Строка один');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('строка два');
    await expect(box).toHaveValue('Строка один\nстрока два');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('');
    await expect(page.getByTestId('message').filter({ hasText: 'строка два' })).toBeVisible();
    await expectAccessible(page, 'chat (wide, light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'chat (wide, dark)');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('settings and family screen are accessible', async () => {
    const page = admin.page;
    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
    await expect(page.getByTestId('notify-state')).toBeVisible();
    await expectAccessible(page, 'settings');
    await page.getByRole('button', { name: /Семья и сервер/ }).click();
    await expect(page.getByText('Место на сервере')).toBeVisible();
    await expectAccessible(page, 'family and server');
  });

  await test.step('390 px: one column, screens stack over the list', async () => {
    const page = member.page;
    await expect(page.locator('[data-layout="one-column"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Мама' })).toBeVisible();
    await expect(page.locator('.list-pane')).toBeHidden();
    await expectAccessible(page, 'chat (narrow)');
    // The browser's Back closes the chat and shows the list.
    await page.goBack();
    await expect(page.locator('.list-pane')).toBeVisible();
    await expect(page.locator('.content-pane')).toHaveCount(0);
    await expectAccessible(page, 'chat list (narrow)');
    const box = await page.locator('.list-pane').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
    await expectAccessible(page, 'settings (narrow)');
    // Touch targets of the header and the settings items are at least 44 px.
    for (const el of await page.locator('.content-pane .screen-header button, .content-pane .item').all()) {
      const b = await el.boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(44);
    }
  });

  await test.step('arrow keys move between chats in the list', async () => {
    const page = admin.page;
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
    const row = page.getByRole('button', { name: /Бабушка/ });
    await row.focus();
    await page.keyboard.press('ArrowDown');
    await expect(row).toBeFocused();
  });
});

test('device and server check pages run under the CSP', async ({ newUser }) => {
  const { page } = await newUser();
  await page.goto(`${fcd.url}/device/`);
  await page.getByRole('button', { name: 'Проверить устройство' }).click();
  await expect(page.locator('#copy')).toBeVisible({ timeout: 60_000 });
  await page.goto(`${fcd.url}/server/`);
  await expect(page.locator('#hello-status')).toContainText('Сервер отвечает');
});

test('the CSP guard of these tests catches a violation', async ({ browser }) => {
  const problems: string[] = [];
  const { page, context } = await makeUser(browser, problems);
  await page.goto(`${fcd.url}/`);
  await expect(page.getByRole('button', { name: 'У меня есть приглашение' })).toBeVisible();
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 1';
    document.head.append(s);
  });
  await expect.poll(() => problems.length).toBeGreaterThan(0);
  expect(problems[0]).toContain('script-src');
  expect(await page.evaluate(() => (window as { __inline?: number }).__inline)).toBeUndefined();
  await context.close();
});

test('send on a touch device keeps the message', async ({ newUser }) => {
  // Regression guard for the composer: the button sends, Enter does not.
  const fresh = new Fcd();
  await fresh.start();
  try {
    const a = await newUser({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const { inviteLink } = await setupAdmin(a.page, fresh);
    const b = await newUser();
    await joinByLink(b.page, inviteLink, 'Дед');
    await send(b.page, 'Проверка');
    await a.page.getByRole('button', { name: /Дед/ }).click({ timeout: 30_000 });
    const box = a.page.getByLabel('Сообщение');
    await box.fill('первая');
    await box.press('Enter');
    await expect(box).toHaveValue('первая\n');
  } finally {
    await fresh.dispose();
  }
});
