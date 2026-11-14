// M4 end to end against a real fcd: reply with a quote, edit, reactions seen
// by both, delete for everyone seen by the other person, the emoji picker
// with the keyboard, forwarding a picture to other chats, global search and
// search inside a chat. Axe checks of the new UI in both themes.

import { makePng } from './support/files.ts';
import { joinByLink, message, openChat, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';
import type { Page } from '@playwright/test';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

/** Messages whose own text is exactly `text` (a quote of it elsewhere does not count). */
function body(page: Page, text: string) {
  const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page.getByTestId('message').filter({ has: page.locator('p.text', { hasText: exact }) });
}

/** Opens the message menu with the "⋯" button (desktop: shown on hover). */
async function menuOf(page: Page, text: string) {
  const m = body(page, text).last();
  await m.hover();
  await m.getByTestId('message-more').click();
  const menu = page.getByTestId('message-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** A long press with a finger (touch pointer events). */
async function longPress(page: Page, text: string) {
  const bubble = body(page, text).last().locator('.bubble');
  const box = (await bubble.boundingBox())!;
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: 'touch', isPrimary: true, bubbles: true };
  await bubble.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(700);
  await bubble.dispatchEvent('pointerup', at);
  const menu = page.getByTestId('message-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('reply, edit, reactions, delete, emoji picker, forward and search between two people', async ({ newUser }) => {
  test.setTimeout(600_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const petya: User = await newUser({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
  const { inviteLink } = await setupAdmin(mama.page, fcd);
  await joinByLink(petya.page, inviteLink, 'Петя');
  await petya.page.getByLabel('Сообщение').fill('Купи молоко');
  await petya.page.getByRole('button', { name: 'Отправить' }).click();
  await petya.page.getByRole('button', { name: 'Позже' }).click();
  await openChat(mama.page, 'Петя');
  await expect(message(mama.page, 'Купи молоко')).toBeVisible();

  await test.step('the menu is a proper menu: arrows, Escape, focus back', async () => {
    const menu = await menuOf(mama.page, 'Купи молоко');
    await expect(menu).toHaveAttribute('role', 'menu');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Реакция: палец вверх' })).toBeFocused();
    await mama.page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Ответить' })).toBeFocused();
    await mama.page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Копировать' })).toBeFocused();
    await expectAccessible(mama.page, 'message menu (light)');
    await mama.page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(mama.page, 'message menu (dark)');
    await mama.page.emulateMedia({ colorScheme: 'light' });
    await mama.page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(body(mama.page, 'Купи молоко').getByTestId('message-more')).toBeFocused();
  });

  await test.step('reply: quote bar, cancel, then a reply with the quote', async () => {
    let menu = await menuOf(mama.page, 'Купи молоко');
    await menu.getByRole('menuitem', { name: 'Ответить' }).click();
    const bar = mama.page.getByTestId('reply-bar');
    await expect(bar).toContainText('Ответ Петя');
    await expect(bar).toContainText('Купи молоко');
    await expect(mama.page.getByLabel('Сообщение')).toBeFocused();
    await mama.page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
    menu = await menuOf(mama.page, 'Купи молоко');
    await menu.getByRole('menuitem', { name: 'Ответить' }).click();
    await send(mama.page, 'Хорошо');
    const reply = message(mama.page, 'Хорошо');
    await expect(reply.getByTestId('message-quote')).toContainText('Купи молоко');
    await expect(reply).toHaveAttribute('data-status', 'on-server');

    const got = message(petya.page, 'Хорошо');
    await expect(got).toBeVisible({ timeout: 30_000 });
    // Petya's own message is quoted as "Вы" on his side.
    await expect(got.getByTestId('message-quote')).toContainText('Вы');
    await expect(got.getByTestId('message-quote')).toHaveAccessibleName('Перейти к исходному сообщению: Вы Купи молоко');
    await got.getByTestId('message-quote').click();
    await expect(body(petya.page, 'Купи молоко')).toHaveClass(/highlight/);
    await expectAccessible(petya.page, 'chat with a reply (narrow)');
  });

  await test.step('edit: the composer holds the old text; Escape leaves; "изменено" on both sides', async () => {
    let menu = await menuOf(mama.page, 'Хорошо');
    await menu.getByRole('menuitem', { name: 'Изменить' }).click();
    const box = mama.page.getByLabel('Сообщение');
    await expect(mama.page.getByTestId('edit-bar')).toBeVisible();
    await expect(box).toHaveValue('Хорошо');
    await box.press('Escape');
    await expect(mama.page.getByTestId('edit-bar')).toBeHidden();
    await expect(box).toHaveValue('');
    menu = await menuOf(mama.page, 'Хорошо');
    await menu.getByRole('menuitem', { name: 'Изменить' }).click();
    await box.fill('Хорошо, куплю');
    await box.press('Enter');
    await expect(mama.page.getByTestId('edit-bar')).toBeHidden();
    await expect(message(mama.page, 'Хорошо, куплю')).toContainText('изменено');
    await expect(message(petya.page, 'Хорошо, куплю')).toContainText('изменено', { timeout: 30_000 });
    // Petya cannot edit Mama's message: no such item in his menu.
    const pm = await longPress(petya.page, 'Хорошо, куплю');
    await expect(pm.getByRole('menuitem', { name: 'Изменить' })).toHaveCount(0);
    await petya.page.keyboard.press('Escape');
  });

  await test.step('reactions: quick pick by a long press, chips with counts on both sides, toggle, who reacted', async () => {
    const menu = await longPress(petya.page, 'Хорошо, куплю');
    await menu.getByRole('menuitemcheckbox', { name: 'Реакция: палец вверх' }).click();
    const chipP = message(petya.page, 'Хорошо, куплю').getByTestId('reaction-chip').filter({ hasText: '👍' });
    await expect(chipP).toHaveAttribute('aria-pressed', 'true');
    const chipM = message(mama.page, 'Хорошо, куплю').getByTestId('reaction-chip').filter({ hasText: '👍' });
    await expect(chipM).toContainText('1', { timeout: 30_000 });
    await expect(chipM).toHaveAttribute('aria-pressed', 'false');
    await chipM.click();
    await expect(chipM).toContainText('2');
    await expect(chipM).toHaveAttribute('aria-pressed', 'true');
    await expect(chipP).toContainText('2', { timeout: 30_000 });
    // A second, different emoji from the same person is allowed.
    const m2 = await menuOf(mama.page, 'Хорошо, куплю');
    await m2.getByRole('menuitemcheckbox', { name: 'Реакция: сердце' }).click();
    await expect(message(petya.page, 'Хорошо, куплю').getByTestId('reaction-chip')).toHaveCount(2, { timeout: 30_000 });
    // Who reacted: right click on the chip.
    await chipM.click({ button: 'right' });
    const who = mama.page.getByTestId('who-dialog');
    await expect(who).toContainText('Вы');
    await expect(who).toContainText('Петя');
    await expectAccessible(mama.page, 'who reacted');
    await who.getByRole('button', { name: 'Закрыть' }).click();
    // Tapping my chip again removes my reaction.
    await chipM.click();
    await expect(chipM).toContainText('1');
    await expect(chipP).toContainText('1', { timeout: 30_000 });
    await expectAccessible(mama.page, 'chat with reactions (light)');
    await mama.page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(mama.page, 'chat with reactions (dark)');
    await mama.page.emulateMedia({ colorScheme: 'light' });
  });

  await test.step('delete for everyone: a quiet line on both sides; delete for me stays local', async () => {
    await send(mama.page, 'Лишнее сообщение');
    await expect(message(petya.page, 'Лишнее сообщение')).toBeVisible({ timeout: 30_000 });
    const menu = await menuOf(mama.page, 'Лишнее сообщение');
    await menu.getByRole('menuitem', { name: 'Удалить' }).click();
    const dlg = mama.page.getByTestId('delete-dialog');
    await expect(dlg).toContainText('Сообщение исчезнет с сервера');
    await expectAccessible(mama.page, 'delete dialog');
    await dlg.getByRole('button', { name: 'Удалить у всех' }).click();
    await expect(message(mama.page, 'Лишнее сообщение')).toHaveCount(0);
    await expect(petya.page.getByTestId('message-deleted')).toHaveCount(1, { timeout: 30_000 });
    await expect(message(petya.page, 'Лишнее сообщение')).toHaveCount(0);
    await expect(mama.page.getByTestId('message-deleted')).toHaveCount(1);

    // Petya deletes Mama's message only for himself: his menu has no "for everyone".
    const pm = await longPress(petya.page, 'Купи молоко');
    await pm.getByRole('menuitem', { name: 'Удалить' }).click();
    const pd = petya.page.getByTestId('delete-dialog');
    await expect(pd.getByRole('button', { name: 'Удалить у всех' })).toBeVisible(); // his own message
    await pd.getByRole('button', { name: 'Удалить у меня' }).click();
    await expect(body(petya.page, 'Купи молоко')).toHaveCount(0);
    await expect(body(mama.page, 'Купи молоко')).toHaveCount(1);
    // The quote of the reply now says the original is unavailable.
    await expect(message(petya.page, 'Хорошо, куплю').getByTestId('message-quote')).toContainText('Сообщение недоступно');
  });

  await test.step('emoji picker: keyboard, search, insert at the caret, reactions', async () => {
    const page = mama.page;
    const box = page.getByLabel('Сообщение');
    await box.fill('Привет !');
    await box.focus();
    await box.press('End');
    await box.press('ArrowLeft');
    await page.getByTestId('emoji-button').click();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    await expect(page.getByLabel('Найти эмодзи')).toBeFocused();
    await expectAccessible(page, 'emoji picker (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'emoji picker (dark)');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.type('сердц');
    await page.keyboard.press('ArrowDown');
    const first = picker.getByRole('option').first();
    await expect(first).toBeFocused();
    await expect(first).toHaveAccessibleName(/сердце/);
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('option').nth(1)).toBeFocused();
    const chosen = (await picker.getByRole('option').nth(1).textContent())!.trim();
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(box).toHaveValue(`Привет ${chosen}!`);
    // Escape closes the picker and the focus returns to the button.
    await page.getByTestId('emoji-button').click();
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByTestId('emoji-button')).toBeFocused();
    // The recently used emoji come first next time; arrows walk the category tabs.
    await page.getByTestId('emoji-button').click();
    await expect(picker.getByRole('tab', { name: 'Недавние' })).toHaveAttribute('aria-selected', 'true');
    await expect(picker.getByRole('option').first()).toHaveText(chosen);
    await picker.getByRole('tab', { name: 'Недавние' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(picker.getByRole('tab', { name: 'Смайлы' })).toBeFocused();
    await page.keyboard.press('Escape');
    await box.fill('');

    // "More" in the menu: any emoji as a reaction.
    const menu = await menuOf(page, 'Хорошо, куплю');
    await menu.getByRole('menuitem', { name: 'Другие реакции' }).click();
    await expect(picker).toBeVisible();
    await page.keyboard.type('ёлка');
    await picker.getByRole('option', { name: /ёлка/ }).first().click();
    await expect(message(page, 'Хорошо, куплю').getByTestId('reaction-chip').filter({ hasText: '🎄' })).toBeVisible();
    await expect(message(petya.page, 'Хорошо, куплю').getByTestId('reaction-chip').filter({ hasText: '🎄' })).toBeVisible({ timeout: 30_000 });
  });

  await test.step('forward a picture to two chats; the other person gets a re-encrypted copy', async () => {
    const page = mama.page;
    await page.getByRole('button', { name: 'Прикрепить' }).click();
    await page.getByTestId('photo-input').setInputFiles({ name: 'дача.png', mimeType: 'image/png', buffer: makePng(800, 600, 3) });
    const preview = page.getByRole('dialog');
    await preview.getByLabel('Подпись').fill('Наша дача');
    await preview.getByRole('button', { name: 'Отправить' }).click();
    const sent = message(page, 'Наша дача');
    await expect(sent).toHaveAttribute('data-status', 'on-server', { timeout: 60_000 });

    const menu = await menuOf(page, 'Наша дача');
    await menu.getByRole('menuitem', { name: 'Переслать' }).click();
    const sheet = page.getByTestId('forward-sheet');
    await expect(sheet).toBeVisible();
    await expectAccessible(page, 'forward sheet');
    await sheet.getByLabel('Избранное').check();
    await sheet.getByLabel('Петя').check();
    await sheet.getByTestId('forward-send').click();
    await expect(sheet).toBeHidden({ timeout: 30_000 });

    // Two copies in this chat now: the original and the forwarded one.
    const copies = message(page, 'Наша дача');
    await expect(copies).toHaveCount(2);
    const fwd = copies.filter({ has: page.getByTestId('message-forwarded') });
    await expect(fwd).toHaveAttribute('data-status', 'on-server', { timeout: 60_000 });
    await expect(fwd.getByTestId('attachment-image')).toBeVisible();

    const got = message(petya.page, 'Наша дача').filter({ has: petya.page.getByTestId('message-forwarded') });
    await expect(got).toBeVisible({ timeout: 30_000 });
    await expect(got).toContainText('Переслано');
    await expect(got.getByTestId('attachment-image')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await expect(got.locator('img.full')).toBeVisible();

    // Petya forwards the picture he received into his own "Избранное" (it is on his device already).
    const pm = await longPress(petya.page, 'Наша дача');
    await pm.getByRole('menuitem', { name: 'Переслать' }).click();
    const ps = petya.page.getByTestId('forward-sheet');
    await ps.getByLabel('Избранное').check();
    await ps.getByTestId('forward-send').click();
    await expect(ps).toBeHidden({ timeout: 30_000 });
    await petya.page.getByRole('button', { name: 'К списку чатов' }).click();
    await openChat(petya.page, 'Избранное');
    const saved = message(petya.page, 'Наша дача');
    await expect(saved.getByTestId('message-forwarded')).toBeVisible();
    await expect(saved.getByTestId('attachment-image')).toBeVisible();
    await petya.page.getByRole('button', { name: 'К списку чатов' }).click();
  });

  await test.step('search: prepare 56 messages', async () => {
    const page = mama.page;
    await openChat(page, 'Петя');
    const box = page.getByLabel('Сообщение');
    // 56 messages: the oldest match is beyond the first page of the chat (50 messages).
    for (let i = 0; i < 56; i++) {
      await box.fill(i % 20 === 0 ? `Ёлка номер ${i}` : `обычное сообщение ${i}`);
      await box.press('Enter');
    }
    await expect(message(page, 'обычное сообщение 55')).toHaveAttribute('data-status', 'on-server', { timeout: 60_000 });
  });
  const page = mama.page;

  await test.step('in the chat: count, next and previous, jump with highlight, older pages from this device', async () => {
    await page.getByTestId('chat-search-button').click();
    const bar = page.getByTestId('chat-search');
    await expect(page.getByLabel('Искать в этом чате')).toBeFocused();
    await expect(bar).toContainText('Поиск идёт только по сообщениям на этом устройстве.');
    await page.keyboard.type('ЕЛКА');
    const pos = page.getByTestId('chat-search-position');
    await expect(pos).toHaveText('1 из 3');
    await expect(message(page, 'Ёлка номер 40')).toHaveClass(/highlight/);
    await page.keyboard.press('Enter');
    await expect(pos).toHaveText('2 из 3');
    await expect(message(page, 'Ёлка номер 20')).toHaveClass(/highlight/);
    await page.getByRole('button', { name: 'Предыдущий результат' }).click();
    await expect(pos).toHaveText('3 из 3');
    // The oldest one was not shown at first: it is loaded from this device and scrolled to.
    const oldest = message(page, 'Ёлка номер 0');
    await expect(oldest).toHaveClass(/highlight/);
    await expect(oldest).toBeInViewport();
    await page.getByRole('button', { name: 'Следующий результат' }).click();
    await expect(pos).toHaveText('2 из 3');
    await expectAccessible(page, 'search in a chat');
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
    await expect(page.getByTestId('chat-search-button')).toBeFocused();
  });

  await test.step('global search: messages grouped by chat, chats by name, jump to the message', async () => {
    await page.getByTestId('open-search').click();
    const field = page.getByLabel('Искать в сообщениях, чатах и контактах');
    await expect(field).toBeFocused();
    await expect(page.getByText('Ищет по сообщениям, которые хранятся на этом устройстве')).toBeVisible();
    await field.fill('елк ном');
    const hits = page.getByTestId('search-hit');
    await expect(hits).toHaveCount(3);
    await expect(hits.first()).toContainText('Ёлка номер 40');
    await expect(hits.first().locator('mark').first()).toHaveText('Ёлка');
    await expectAccessible(page, 'global search (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'global search (dark)');
    await page.emulateMedia({ colorScheme: 'light' });
    await field.fill('пет');
    await expect(page.getByRole('heading', { name: 'Чаты' })).toBeVisible();
    await field.fill('ничегоподобного');
    await expect(page.getByTestId('search-nothing')).toBeVisible();
    await field.fill('Ёлка 20');
    await hits.first().click();
    await expect(page.getByRole('heading', { name: 'Петя', exact: true })).toBeVisible();
    await expect(message(page, 'Ёлка номер 20')).toHaveClass(/highlight/);
  });
});
