// Groups end to end against a real fcd, each person in an isolated
// browser context: a group of three, adding members with and without the
// earlier history, removing a member (who sees "Вы больше не участник" while
// the others go on), transferring ownership, leaving; "Избранное"; an avatar
// change seen by another person; verifying a contact; axe on the new screens.

import { makePng } from './support/files.ts';
import { chatRow, createInvite, joinByLink, message, openChat, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';
import type { Page } from '@playwright/test';

const fcd = new Fcd();
const wide = { viewport: { width: 1200, height: 860 } };

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

async function openInfo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Сведения о группе' }).click();
  await expect(page.getByRole('heading', { name: 'О группе' })).toBeVisible();
}

function memberRow(page: Page, name: string) {
  return page.getByTestId('group-member').filter({ hasText: name });
}

function blocked(page: Page) {
  return page.getByTestId('composer-blocked');
}

test('groups, profiles and "Избранное"', async ({ newUser }) => {
  test.setTimeout(420_000);
  const mama = await newUser(wide);
  const { inviteLink } = await setupAdmin(mama.page, fcd, 'Мама', 'Ивановы', 'f');

  const people: Record<string, User> = {};
  async function join(name: string, link: string): Promise<User> {
    const u = await newUser(wide);
    await joinByLink(u.page, link, name, name === 'Катя' ? 'f' : 'm');
    people[name] = u;
    return u;
  }

  await test.step('three relatives join the family', async () => {
    await join('Петя', inviteLink);
    await join('Вася', await createInvite(mama.page));
    await join('Катя', await createInvite(mama.page));
    await join('Дима', await createInvite(mama.page));
  });
  const petya = people['Петя']!;
  const vasya = people['Вася']!;
  const katya = people['Катя']!;
  const dima = people['Дима']!;

  await test.step('"Избранное" is pinned first and keeps notes', async () => {
    const rows = mama.page.locator('button.chat');
    await expect(rows.first()).toContainText('Избранное');
    await openChat(mama.page, 'Избранное');
    await expect(mama.page.getByText('Здесь можно хранить заметки')).toBeVisible();
    await send(mama.page, 'Купить хлеб');
    await expect(message(mama.page, 'Купить хлеб')).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
    await expect(chatRow(mama.page, 'Избранное')).toContainText('Купить хлеб');

    // A deleted note just goes away: no quiet "deleted" line, the preview falls back to the previous note.
    await send(mama.page, 'Лишняя заметка');
    const note = message(mama.page, 'Лишняя заметка');
    await expect(note).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
    await expect(chatRow(mama.page, 'Избранное')).toContainText('Лишняя заметка');
    await note.hover();
    await note.getByTestId('message-more').click();
    await mama.page.getByTestId('message-menu').getByRole('menuitem', { name: 'Удалить' }).click();
    await mama.page.getByTestId('delete-dialog').getByRole('button', { name: 'Удалить у всех' }).click();
    await expect(chatRow(mama.page, 'Избранное')).toContainText('Купить хлеб');
    await expect(note).toHaveCount(0);
    await expect(mama.page.getByTestId('message-deleted')).toHaveCount(0);
  });

  await test.step('mama creates a group of three; messages arrive for all', async () => {
    await mama.page.getByRole('button', { name: 'Новый чат' }).click();
    await mama.page.getByRole('button', { name: /Новая группа/ }).click();
    await mama.page.getByLabel('Название группы').fill('Семья');
    await mama.page.getByRole('checkbox', { name: 'Петя' }).check();
    await mama.page.getByRole('checkbox', { name: 'Вася' }).check();
    await expect(mama.page.getByText('Выбрано: 2')).toBeVisible();
    await expectAccessible(mama.page, 'new group');
    await mama.page.getByRole('button', { name: 'Создать группу' }).click();
    await expect(mama.page.getByRole('heading', { name: 'Семья', exact: true })).toBeVisible();
    await expect(mama.page.getByTestId('service-line').first()).toContainText('Вы создали группу «Семья»');
    await send(mama.page, 'Привет всем');
    await expect(message(mama.page, 'Привет всем')).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
    await expect(chatRow(mama.page, 'Семья')).toContainText('3 участника');

    for (const u of [petya, vasya]) {
      await openChat(u.page, 'Семья');
      await expect(message(u.page, 'Привет всем')).toBeVisible({ timeout: 30_000 });
      await expect(message(u.page, 'Привет всем').getByTestId('message-author')).toHaveText('Мама');
      await expect(u.page.getByTestId('service-line').first()).toContainText('Мама создала группу «Семья»');
    }
    await send(vasya.page, 'Привет от Васи');
    await send(vasya.page, 'И ещё одно');
    await expect(message(mama.page, 'Привет от Васи')).toBeVisible({ timeout: 30_000 });
    await expect(message(petya.page, 'И ещё одно')).toBeVisible({ timeout: 30_000 });
    // Consecutive messages of one author: the name only on the first.
    await expect(message(petya.page, 'Привет от Васи').getByTestId('message-author')).toHaveText('Вася');
    await expect(message(petya.page, 'И ещё одно').getByTestId('message-author')).toHaveCount(0);
    await expectAccessible(petya.page, 'group chat');
  });

  await test.step('a fourth member is added with the earlier history', async () => {
    await openChat(mama.page, 'Семья');
    await openInfo(mama.page);
    await expectAccessible(mama.page, 'group info');
    await mama.page.getByRole('button', { name: 'Добавить участников' }).click();
    const dialog = mama.page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Катя' }).check();
    await dialog.getByRole('button', { name: 'Дальше' }).click();
    await expect(dialog).toContainText('Новый участник увидит переписку группы, которая ещё лежит на сервере (не больше 90 дней)');
    await expect(dialog.getByRole('button', { name: 'Добавить без прежней переписки' })).toBeVisible();
    await expectAccessible(mama.page, 'add member confirmation');
    await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(memberRow(mama.page, 'Катя')).toBeVisible();

    await openChat(katya.page, 'Семья');
    await expect(message(katya.page, 'Привет всем')).toBeVisible({ timeout: 30_000 });
    await expect(message(katya.page, 'Привет от Васи')).toBeVisible();
  });

  await test.step('a fifth member is added without the earlier history', async () => {
    await mama.page.getByRole('button', { name: 'Добавить участников' }).click();
    const dialog = mama.page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Дима' }).check();
    await dialog.getByRole('button', { name: 'Дальше' }).click();
    await dialog.getByRole('button', { name: 'Добавить без прежней переписки' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await mama.page.getByRole('button', { name: 'Назад' }).click();
    await send(mama.page, 'Дима с нами');

    await openChat(dima.page, 'Семья');
    await expect(message(dima.page, 'Дима с нами')).toBeVisible({ timeout: 30_000 });
    await expect(message(dima.page, 'Привет всем')).toHaveCount(0);
    // The others keep reading in the new epoch.
    await expect(message(katya.page, 'Дима с нами')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('a removed member sees "Вы больше не участник"; the others go on', async () => {
    await openInfo(mama.page);
    await memberRow(mama.page, 'Вася').getByRole('button', { name: 'Удалить из группы' }).click();
    const dialog = mama.page.getByRole('dialog');
    await expect(dialog).toContainText('Удалить Вася из группы?');
    await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(memberRow(mama.page, 'Вася')).toHaveCount(0);
    await mama.page.getByRole('button', { name: 'Назад' }).click();

    await expect(blocked(vasya.page)).toContainText('Вы больше не участник', { timeout: 30_000 });
    await expect(vasya.page.getByLabel('Сообщение')).toHaveCount(0);
    // The history stays readable.
    await expect(message(vasya.page, 'Привет всем')).toBeVisible();

    await send(mama.page, 'Без Васи');
    await expect(message(petya.page, 'Без Васи')).toBeVisible({ timeout: 30_000 });
    await expect(petya.page.getByTestId('service-line').filter({ hasText: 'Мама удалила из группы Вася' })).toBeVisible();
    await vasya.page.waitForTimeout(1500);
    await expect(message(vasya.page, 'Без Васи')).toHaveCount(0);
  });

  await test.step('ownership is transferred; the new owner renames the group', async () => {
    await openInfo(mama.page);
    await memberRow(mama.page, 'Петя').getByRole('button', { name: 'Сделать владельцем' }).click();
    const dialog = mama.page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Передать' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(memberRow(mama.page, 'Петя')).toContainText('владелец');
    await expect(mama.page.getByRole('button', { name: 'Добавить участников' })).toHaveCount(0);
    await mama.page.getByRole('button', { name: 'Назад' }).click();

    await openInfo(petya.page);
    await expect(memberRow(petya.page, 'Петя')).toContainText('владелец', { timeout: 30_000 });
    await petya.page.getByRole('button', { name: 'Переименовать' }).click();
    await petya.page.getByLabel('Новое название').fill('Родные');
    await petya.page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(petya.page.getByRole('heading', { name: 'Родные' })).toBeVisible({ timeout: 30_000 });
    // The owner must name a new owner before leaving.
    await petya.page.getByRole('button', { name: 'Выйти из группы' }).click();
    await expect(petya.page.getByRole('dialog')).toContainText('Сначала выберите нового владельца');
    await petya.page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
    await petya.page.getByRole('button', { name: 'Назад' }).click();

    await expect(mama.page.getByRole('heading', { name: 'Родные', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(mama.page.getByTestId('service-line').filter({ hasText: 'Петя переименовал группу в «Родные»' })).toBeVisible();
    await expect(mama.page.getByTestId('service-line').filter({ hasText: 'Новый владелец: Петя' })).toBeVisible();
  });

  await test.step('a member leaves; the others see it', async () => {
    await openChat(katya.page, 'Родные');
    await openInfo(katya.page);
    await katya.page.getByRole('button', { name: 'Выйти из группы' }).click();
    await katya.page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(blocked(katya.page)).toContainText('Вы больше не участник', { timeout: 30_000 });
    await expect(mama.page.getByTestId('service-line').filter({ hasText: 'Катя вышла из группы' })).toBeVisible({ timeout: 30_000 });
    await send(mama.page, 'После Кати');
    await expect(message(dima.page, 'После Кати')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('an avatar change is visible to another person', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Мой профиль/ }).click();
    await mama.page.getByTestId('avatar-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: makePng(600, 400, 40) });
    const crop = mama.page.getByRole('dialog');
    await expect(crop).toContainText('Фото профиля');
    await expectAccessible(mama.page, 'avatar crop');
    await crop.getByRole('button', { name: 'Сохранить' }).click();
    await expect(mama.page.getByText('Фото сохранено')).toBeVisible({ timeout: 30_000 });
    await expect(mama.page.locator('.head .avatar img')).toBeVisible();
    await expectAccessible(mama.page, 'my profile');

    await openChat(petya.page, 'Мама');
    await petya.page.getByRole('button', { name: 'Профиль контакта' }).click();
    await expect(petya.page.getByRole('heading', { name: 'Контакт' })).toBeVisible();
    await expect(petya.page.locator('.head .avatar img')).toBeVisible({ timeout: 30_000 });
    const size = await petya.page.locator('.head .avatar img').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
    expect(size).toEqual([256, 256]);
  });

  await test.step('a contact is verified by the fingerprint', async () => {
    await expect(petya.page.getByTestId('fingerprint')).toHaveText(/^\d{5} \d{5} \d{5}\s*\d{5} \d{5} \d{5}$/);
    await expectAccessible(petya.page, 'contact');
    await petya.page.getByRole('switch', { name: /Сверено/ }).check();
    await expect(petya.page.getByRole('heading', { name: /сверено/ })).toBeVisible();
    await petya.page.getByRole('button', { name: 'Назад' }).click();
    await expect(petya.page.locator('.subtitle')).toHaveText('сверено');
  });

  await test.step('settings screens are accessible', async () => {
    await mama.page.getByRole('button', { name: 'Назад' }).click();
    await mama.page.getByRole('button', { name: 'Безопасность' }).click();
    await expect(mama.page.getByRole('heading', { name: 'Отозвать мою идентичность' })).toBeVisible();
    await expectAccessible(mama.page, 'security');
    await mama.page.getByRole('button', { name: 'Отозвать идентичность…' }).click();
    await expect(mama.page.getByRole('dialog')).toContainText('Все ваши устройства в этой семье отключатся сразу и навсегда.');
    await expect(mama.page.getByRole('button', { name: 'Отозвать навсегда' })).toBeDisabled();
    await expectAccessible(mama.page, 'revoke confirmation');
    await mama.page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
    await mama.page.getByRole('button', { name: 'Назад' }).click();
    await mama.page.getByRole('button', { name: 'Хранилище и архив' }).click();
    await expect(mama.page.getByTestId('storage-used')).toBeVisible();
    await expectAccessible(mama.page, 'storage');
  });

  await test.step('a member revokes their identity; the group owner removes them', async () => {
    await dima.page.getByRole('button', { name: 'Настройки' }).click();
    await dima.page.getByRole('button', { name: 'Безопасность' }).click();
    await dima.page.getByRole('button', { name: 'Отозвать идентичность…' }).click();
    const dialog = dima.page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Я понимаю, что это нельзя отменить' }).check();
    await dialog.getByRole('button', { name: 'Отозвать навсегда' }).click();
    await expect(dima.page.getByText('Вы отозвали свою идентичность', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // Petya owns the group: his app removes the revoked member by itself.
    await openChat(petya.page, 'Родные');
    await expect(petya.page.getByTestId('service-line').filter({ hasText: 'Вы удалили из группы Дима' })).toBeVisible({ timeout: 30_000 });
  });
});
