// Steps a person takes in the interface, shared by the specs.

import { expect, type Page } from '@playwright/test';
import type { Fcd } from './fcd.ts';

export interface AdminResult {
  readonly phrase: string;
  readonly inviteLink: string;
}

/** The administrator route: admin code, name, recovery phrase with confirmation, first invitation. */
/** `gender: 'f'` picks «Ж» next to the name; the default is «М». */
export async function setupAdmin(page: Page, fcd: Fcd, name = 'Мама', family = 'Ивановы', gender: 'm' | 'f' = 'm'): Promise<AdminResult> {
  await page.goto(`${fcd.url}/`);
  await page.getByRole('button', { name: 'Настроить для своей семьи' }).click();
  await expect(page.getByLabel('Адрес сервера')).toHaveValue(fcd.url);
  await page.getByLabel('Код администратора').fill(fcd.adminCode);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByText(`Сервер отвечает: семья «${family}».`)).toBeVisible();
  await page.getByLabel('Как вас зовут').fill(name);
  if (gender === 'f') await page.getByRole('radio', { name: /Ж/ }).check();
  await page.getByRole('button', { name: 'Создать семью' }).click();

  await expect(page.locator('ol.words .w')).toHaveCount(24, { timeout: 20_000 });
  const words = await page.locator('ol.words .w').allTextContents();
  await page.getByRole('button', { name: gender === 'f' ? 'Я записала' : 'Я записал' }).click();
  await expect(page.getByText(/^Слово № \d+$/)).toHaveCount(3);
  const labels = await page.getByText(/^Слово № \d+$/).allTextContents();
  expect(labels).toHaveLength(3);
  for (const label of labels) {
    const n = Number(/\d+/.exec(label)![0]);
    await page.getByLabel(label, { exact: true }).fill(words[n - 1]!);
  }
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByText('Слова записаны верно.')).toBeVisible();
  await page.getByRole('button', { name: 'Дальше' }).click();

  await page.getByRole('button', { name: 'Создать приглашение' }).click();
  const inviteLink = await page.getByTestId('invite-link').inputValue();
  expect(inviteLink).toMatch(/#invite=[a-z2-7]{26}$/);
  await page.getByRole('button', { name: 'К чатам' }).click();
  await expect(page.getByTestId('status-line')).toContainText('На связи');
  return { phrase: words.join(' '), inviteLink };
}

/** A new invitation from the family screen (administrator). */
export async function createInvite(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: /Семья и сервер/ }).click();
  await page.getByRole('button', { name: /Создать приглашение/ }).click();
  const link = await page.getByTestId('invite-link').inputValue();
  await page.getByRole('button', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Назад' }).click();
  return link;
}

/** The invited route on a desktop browser: link → name → chat with the inviter. */
export async function joinByLink(page: Page, link: string, name: string, gender: 'm' | 'f' = 'm'): Promise<void> {
  await page.goto(link);
  await page.getByLabel('Как вас зовут').fill(name);
  if (gender === 'f') await page.getByRole('radio', { name: /Ж/ }).check();
  await page.getByRole('button', { name: 'Войти в семейный чат' }).click();
  await expect(page.getByLabel('Сообщение')).toBeVisible();
}

export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('Сообщение');
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

export function message(page: Page, text: string) {
  return page.getByTestId('message').filter({ hasText: text });
}

/** A chat row in the list by its title (the first line starts with it). */
export function chatRow(page: Page, title: string) {
  return page.locator('button.chat').filter({ has: page.locator('.name', { hasText: new RegExp(`^${title}`) }) });
}

/** Opens a chat from the list by its title. */
export async function openChat(page: Page, title: string): Promise<void> {
  await chatRow(page, title).click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** Returns to the chat list in the one-column layout, or does nothing in two columns. */
export async function toList(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: 'К списку чатов' });
  if (await back.isVisible()) await back.click();
}
