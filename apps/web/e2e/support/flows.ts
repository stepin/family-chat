// Steps a person takes in the interface, shared by the specs.

import { expect, type Page } from '@playwright/test';
import type { Fcd } from './fcd.ts';

export interface AdminResult {
  readonly phrase: string;
  readonly inviteLink: string;
}

/** The administrator route: admin code, name, recovery phrase with confirmation, first invitation. */
export async function setupAdmin(page: Page, fcd: Fcd, name = 'Мама'): Promise<AdminResult> {
  await page.goto(`${fcd.url}/`);
  await page.getByRole('button', { name: 'Настроить для своей семьи' }).click();
  await expect(page.getByLabel('Адрес сервера')).toHaveValue(fcd.url);
  await page.getByLabel('Код администратора').fill(fcd.adminCode);
  await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByText('Сервер отвечает: семья «Ивановы».')).toBeVisible();
  await page.getByLabel('Как вас зовут').fill(name);
  await page.getByRole('button', { name: 'Создать семью' }).click();

  await expect(page.locator('ol.words .w')).toHaveCount(24, { timeout: 20_000 });
  const words = await page.locator('ol.words .w').allTextContents();
  await page.getByRole('button', { name: 'Я записал(а)' }).click();
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
export async function joinByLink(page: Page, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByLabel('Как вас зовут').fill(name);
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
