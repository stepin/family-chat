// The M1 goal end to end against a real fcd: the administrator sets up the
// family and invites a relative; they exchange messages that arrive without
// a reload; messages and drafts survive a reload; a used invitation is
// refused; the phrase restores the administrator on a new device; a removed
// member sees the "removed" screen.

import { createInvite, joinByLink, message, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

test('family from setup to removal', async ({ newUser }) => {
  test.setTimeout(240_000);
  const mama = await newUser();
  const petya = await newUser();
  let phrase = '';
  let firstLink = '';

  await test.step('administrator sets up the family with the admin code', async () => {
    const r = await setupAdmin(mama.page, fcd);
    phrase = r.phrase;
    firstLink = r.inviteLink;
    // The empty state of the administrator.
    await expect(mama.page.getByRole('heading', { name: 'Пригласите семью' })).toBeVisible();
  });

  await test.step('a relative joins by the link and lands in the chat with the administrator', async () => {
    await petya.page.goto(firstLink);
    // The invitation fragment is removed from the address bar at once.
    await expect.poll(() => petya.page.url()).not.toContain('#');
    // The invitation check names the inviter before asking for the name.
    await expect(petya.page.getByRole('heading', { name: 'Вас пригласил(а) Мама в «Ивановы»' })).toBeVisible();
    await petya.page.getByLabel('Как вас зовут').fill('Петя');
    await petya.page.getByRole('button', { name: 'Войти в семейный чат' }).click();
    await expect(petya.page.getByRole('heading', { name: 'Мама' })).toBeVisible();
    await expect(petya.page.getByLabel('Сообщение')).toBeFocused();
    expect(petya.page.url()).not.toContain('invite');
  });

  await test.step('both exchange messages that arrive without a reload', async () => {
    await send(petya.page, 'Привет, мама! https://example.org/путь?x=1');
    await expect(message(petya.page, 'Привет, мама!')).toHaveAttribute('data-status', 'on-server');
    // The phrase is offered to the invited relative after the first message.
    await expect(petya.page.getByRole('heading', { name: 'Сохраните слова для восстановления' })).toBeVisible();
    await petya.page.getByRole('button', { name: 'Позже' }).click();

    // Mama sees the chat appear in the list and opens it.
    const row = mama.page.getByRole('button', { name: /Петя/ });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('1 непрочитанное');
    await row.click();
    await expect(message(mama.page, 'Привет, мама!')).toBeVisible();
    // A short chat loads its whole history at once and says so.
    await expect(mama.page.getByText('Это начало переписки.')).toBeVisible();
    await expect(row).not.toContainText('непрочитанн');
    const link = message(mama.page, 'Привет, мама!').getByRole('link');
    await expect(link).toHaveAttribute('href', 'https://example.org/%D0%BF%D1%83%D1%82%D1%8C?x=1');
    await expect(link).toHaveAttribute('rel', /noopener/);

    await send(mama.page, 'Привет, Петя!\n<b>не жирный</b>');
    await expect(message(petya.page, 'Привет, Петя!')).toBeVisible({ timeout: 30_000 });
    // Plain text: markup is shown as typed, never interpreted.
    await expect(message(petya.page, 'Привет, Петя!').locator('b')).toHaveCount(0);
    await expect(message(petya.page, 'Привет, Петя!')).toContainText('<b>не жирный</b>');
    await expect(petya.page.getByText('Сегодня')).toBeVisible();
    // Read while open: no unread counter in the list next to the open chat.
    await expect(petya.page.getByRole('button', { name: /Мама/ })).not.toContainText('непрочитанн');
  });

  await test.step('offline: the composer works and the message waits in the queue', async () => {
    await petya.context.setOffline(true);
    await send(petya.page, 'Пишу без связи');
    await expect(message(petya.page, 'Пишу без связи')).toHaveAttribute('data-status', 'on-device');
    await expect(message(petya.page, 'Пишу без связи')).toContainText('На устройстве');
    await petya.context.setOffline(false);
    await petya.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(message(petya.page, 'Пишу без связи')).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
    await expect(message(mama.page, 'Пишу без связи')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('messages and the draft survive a reload', async () => {
    const box = petya.page.getByLabel('Сообщение');
    await box.fill('Недописанное сообщение');
    await petya.page.waitForTimeout(700);
    await petya.page.reload();
    await petya.page.getByRole('button', { name: /Мама/ }).click();
    await expect(message(petya.page, 'Привет, Петя!')).toBeVisible();
    await expect(message(petya.page, 'Привет, мама!')).toBeVisible();
    await expect(petya.page.getByLabel('Сообщение')).toHaveValue('Недописанное сообщение');
    // The draft mark in the chat list (visible in the two-column layout).
    await expect(petya.page.getByRole('button', { name: /Мама/ })).toContainText('Черновик:');
  });

  await test.step('a used invitation shows the right message', async () => {
    const stranger = await newUser();
    await stranger.page.goto(firstLink);
    // Reported at once by the invitation check, before any name is asked.
    await expect(stranger.page.getByText('Это приглашение уже использовано. Попросите новое.')).toBeVisible();
    await expect(stranger.page.getByLabel('Как вас зовут')).toHaveCount(0);
  });

  await test.step('a third context restores the administrator by the phrase and sees the history', async () => {
    const mamaPhone = await newUser();
    await mamaPhone.page.goto(`${fcd.url}/`);
    await mamaPhone.page.getByRole('button', { name: 'Восстановить по фразе' }).click();
    await expect(mamaPhone.page.getByLabel('Приглашение или адрес сервера')).toHaveValue(fcd.url);
    await mamaPhone.page.getByRole('button', { name: 'Дальше' }).click();
    await mamaPhone.page.getByLabel('24 слова').fill(`  ${phrase.toUpperCase().split(' ').join('\n')}  `);
    await expect(mamaPhone.page.getByText('Слов: 24 из 24')).toBeVisible();
    await mamaPhone.page.getByRole('button', { name: 'Восстановить' }).click();
    await expect(mamaPhone.page.getByRole('heading', { name: 'Доступ восстановлен' })).toBeVisible();
    await expect(mamaPhone.page.getByText('за последние 90 дней')).toBeVisible();
    await mamaPhone.page.getByRole('button', { name: 'К чатам' }).click();
    await mamaPhone.page.getByRole('button', { name: /Петя/ }).click({ timeout: 30_000 });
    await expect(message(mamaPhone.page, 'Привет, мама!')).toBeVisible();
    await expect(message(mamaPhone.page, 'Привет, Петя!')).toHaveClass(/out/);
  });

  await test.step('a second relative joins; the administrator removes them; they see the removed screen', async () => {
    const link = await createInvite(mama.page);
    const vasya = await newUser();
    await joinByLink(vasya.page, link, 'Вася');
    await send(vasya.page, 'Я тоже здесь');
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Семья и сервер/ }).click();
    await expect(mama.page.getByTestId('trust-line')).toContainText('Приложение загружено с семейного сервера');
    const row = mama.page.locator('.members li').filter({ hasText: 'Вася' });
    await row.getByRole('button', { name: 'Отключить' }).click();
    const dialog = mama.page.getByRole('dialog');
    await expect(dialog).toContainText('Отключить Вася от семьи?');
    await dialog.getByRole('button', { name: 'Отключить' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('отключён(а)');

    await expect(vasya.page.getByText('Вас отключили от семьи: писать нельзя.')).toBeVisible({ timeout: 30_000 });
    await expect(vasya.page.getByLabel('Сообщение')).toHaveCount(0);
    // Local history stays readable.
    await expect(message(vasya.page, 'Я тоже здесь')).toBeVisible();
    await vasya.page.reload();
    await expect(vasya.page.getByText('Вас отключили от семьи «Ивановы»').first()).toBeVisible();
  });
});
