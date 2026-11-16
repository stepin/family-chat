// The interface in English. The browser asks for en-US, so the app
// follows the system's language: onboarding, a message, Settings, switching
// to Russian and back (at once, without a reload), and axe on the main
// screens in English in both themes.

import { expect as pwExpect } from '@playwright/test';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start('Smiths');
});

test.afterAll(async () => {
  await fcd.dispose();
});

test('English: onboarding, a message, settings, switching the language', async ({ newUser }) => {
  test.setTimeout(240_000);
  const { page } = await newUser({ locale: 'en-US', timezoneId: 'Europe/London', viewport: { width: 1200, height: 800 } });

  await test.step('onboarding in English', async () => {
    await page.goto(`${fcd.url}/`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Family chat' })).toBeVisible();
    await expectAccessible(page, 'welcome (en)');
    await page.getByRole('button', { name: 'Set up for my family' }).click();
    await expect(page.getByLabel('Server address')).toHaveValue(fcd.url);
    await page.getByLabel('Admin code').fill(fcd.adminCode);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('The server is answering: family “Smiths”.')).toBeVisible();
    await page.getByLabel('Your name').fill('Mom');
    await page.getByRole('radio', { name: /F, female/ }).check();
    await expectAccessible(page, 'your name (en)');
    await page.getByRole('button', { name: 'Create family' }).click();
    await expect(page.locator('ol.words .w')).toHaveCount(24, { timeout: 20_000 });
    const words = await page.locator('ol.words .w').allTextContents();
    await page.getByRole('button', { name: 'I’ve written them down' }).click();
    const labels = await page.getByText(/^Word #\d+$/).allTextContents();
    expect(labels).toHaveLength(3);
    for (const label of labels) await page.getByLabel(label, { exact: true }).fill(words[Number(/\d+/.exec(label)![0]) - 1]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('The words are written down correctly.')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create invitation' }).click();
    await expect(page.getByRole('button', { name: 'Create another invitation' })).toBeVisible();
    await expectAccessible(page, 'invitation (en)');
    await page.getByRole('button', { name: 'Go to chats' }).click();
    await expect(page.getByTestId('status-line')).toContainText('Connected');
  });

  await test.step('a message in Saved Messages', async () => {
    await page.locator('button.chat').filter({ hasText: 'Saved Messages' }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('Hello from London');
    await box.press('Enter');
    await expect(page.getByTestId('message').filter({ hasText: 'Hello from London' })).toBeVisible();
    await expectAccessible(page, 'chat (en, light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'chat (en, dark)');
    await page.emulateMedia({ colorScheme: 'light' });
    // English emoji names in the picker.
    await page.getByRole('button', { name: 'Emoji' }).click();
    await page.getByLabel('Search emoji').fill('christmas');
    await pwExpect(page.getByTestId('emoji-picker').getByRole('option', { name: /christmas tree/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close emoji' }).click();
    await pwExpect(page.getByTestId('emoji-picker')).toBeHidden();
  });

  await test.step('settings in English; switch to Russian and back without a reload', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Same as the system/ })).toBeChecked();
    await expectAccessible(page, 'settings (en)');
    await page.getByRole('button', { name: /Appearance/ }).click();
    await expectAccessible(page, 'appearance (en)');
    await page.getByRole('button', { name: 'Back' }).click();
    const marker = await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));
    await page.getByRole('radio', { name: 'Русский', exact: true }).check();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('radio', { name: 'Русский', exact: true })).toBeChecked();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(marker);
    await expectAccessible(page, 'settings (switched to ru)');
    // The choice is kept for the next start.
    await page.reload();
    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
    await page.getByRole('radio', { name: /Как в системе/ }).check();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('radio', { name: 'English', exact: true }).check();
    await expect(page.getByRole('radio', { name: 'English', exact: true })).toBeChecked();
  });
});
