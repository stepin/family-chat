// End to end against a real fcd: the emoji picker with real mouse clicks
// and finger taps (send at once into an empty field, insert at the caret
// otherwise, never send while editing, reactions), the invitation flow, the
// header without the family name, the profile's gender, and the appearance
// settings with an axe matrix over every palette in light and dark.

import { devices, type Page } from '@playwright/test';
import { joinByLink, openChat, send, setupAdmin, toList } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

const PALETTES = ['green', 'blue', 'violet', 'rose', 'orange', 'graphite'] as const;
const PALETTE_NAMES: Record<(typeof PALETTES)[number], string> = {
  green: 'Зелёный',
  blue: 'Синий',
  violet: 'Фиолетовый',
  rose: 'Розовый',
  orange: 'Оранжевый',
  graphite: 'Графит',
};

/** Messages whose own text is exactly `text`. */
function body(page: Page, text: string) {
  const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page.getByTestId('message').filter({ has: page.locator('p.text', { hasText: exact }) });
}

/** The caret of the composer: [selectionStart, selectionEnd], and whether it has the focus. */
function caret(page: Page) {
  return page.getByLabel('Сообщение').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, document.activeElement === el] as const);
}

/** Clicks with the mouse at the centre of an element (a real pointer, not a synthetic click). */
async function mouseClick(page: Page, selector: ReturnType<Page['locator']>) {
  const b = (await selector.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function fingerTap(page: Page, selector: ReturnType<Page['locator']>) {
  const b = (await selector.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

test('emoji picker by mouse and touch, invitations, header, gender, appearance', async ({ newUser }) => {
  test.setTimeout(600_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const { inviteLink } = await setupAdmin(mama.page, fcd, 'Мама', 'Ивановы', 'f');

  await test.step('invitation: the next one is "another invitation"', async () => {
    const page = mama.page;
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Семья и сервер/ }).click();
    const create = page.getByTestId('create-invite');
    await expect(create).toHaveText('Создать приглашение');
    await expect(page.getByText('Одно приглашение впускает в семью одного человека.')).toBeVisible();
    await create.click();
    await expect(page.getByRole('heading', { name: 'Приглашение для одного человека' })).toBeFocused();
    const first = await page.getByTestId('invite-link').inputValue();
    await expect(create).toHaveText('Создать ещё одно приглашение');
    await expect(page.getByText('Приглашение выше продолжит действовать.', { exact: false })).toBeVisible();
    await expectAccessible(page, 'invitation created');
    await create.click();
    await expect(page.getByTestId('invite-link')).not.toHaveValue(first);
    await expect(create).toHaveText('Создать ещё одно приглашение');
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
  });

  const petya: User = await newUser({ viewport: { width: 1200, height: 800 } });
  await joinByLink(petya.page, inviteLink, 'Петя');
  await send(petya.page, 'Привет, мама');

  await test.step('one family: no family name at the top; the avatar opens Settings', async () => {
    const page = mama.page;
    const header = page.locator('.list-pane .screen-header');
    await expect(header.getByRole('heading', { name: 'Чаты' })).toBeVisible();
    await expect(header).not.toContainText('Ивановы');
    await expect(page.getByTestId('family-switcher')).toHaveCount(0);
    await expect(page.getByTestId('open-settings')).toHaveAccessibleName('Настройки');
    // The invitation says who invites, with the right form of the verb.
    await expect(petya.page.getByRole('heading', { name: 'Мама' })).toBeVisible();
  });

  await test.step('desktop, mouse: an emoji into an empty field is sent at once and the picker closes', async () => {
    const page = mama.page;
    await openChat(page, 'Петя');
    await page.getByTestId('emoji-button').click();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    const option = picker.getByTestId('emoji-option').nth(2);
    const chosen = (await option.textContent())!.trim();
    await mouseClick(page, option);
    await expect(picker).toBeHidden();
    await expect(body(page, chosen)).toHaveCount(1);
    await expect(page.getByLabel('Сообщение')).toHaveValue('');
    await expect(body(petya.page, chosen)).toHaveCount(1, { timeout: 30_000 });
  });

  await test.step('desktop, mouse: with text the emoji goes to the caret, replacing a selection, nothing is sent', async () => {
    const page = mama.page;
    const box = page.getByLabel('Сообщение');
    await box.fill('Привет мир');
    await box.focus();
    // Select "мир".
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 10));
    const sentBefore = await page.getByTestId('message').count();
    await page.getByTestId('emoji-button').click();
    const picker = page.getByTestId('emoji-picker');
    await page.getByLabel('Найти эмодзи').fill('сердц');
    const heart = picker.getByRole('option', { name: /красное сердце/ });
    await mouseClick(page, heart);
    await expect(picker).toBeHidden();
    await expect(box).toHaveValue('Привет ❤️');
    expect(await caret(page)).toEqual(['Привет ❤️'.length, 'Привет ❤️'.length, true]);
    // A second one at the caret in the middle.
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
    await page.getByTestId('emoji-button').click();
    await expect(picker.getByRole('tab', { name: 'Недавние' })).toHaveAttribute('aria-selected', 'true');
    await expect(picker.getByTestId('emoji-option').first()).toHaveText('❤️');
    await mouseClick(page, picker.getByTestId('emoji-option').first());
    await expect(box).toHaveValue('Привет❤️ ❤️');
    expect(await caret(page)).toEqual([6 + 2, 6 + 2, true]);
    expect(await page.getByTestId('message').count()).toBe(sentBefore);
    await box.press('Enter');
    await expect(body(page, 'Привет❤️ ❤️')).toHaveCount(1);
  });

  await test.step('editing: an emoji is always inserted, never sent', async () => {
    const page = mama.page;
    const m = body(page, 'Привет❤️ ❤️');
    await m.hover();
    await m.getByTestId('message-more').click();
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Изменить' }).click();
    const box = page.getByLabel('Сообщение');
    await box.fill('');
    await page.getByTestId('emoji-button').click();
    await mouseClick(page, page.getByTestId('emoji-picker').getByTestId('emoji-option').first());
    await expect(page.getByTestId('emoji-picker')).toBeHidden();
    await expect(box).toHaveValue('❤️');
    await expect(page.getByTestId('edit-bar')).toBeVisible();
    await page.getByTestId('save-edit').click();
    await expect(body(page, '❤️')).toHaveCount(1);
  });

  await test.step('a reply: the emoji goes out as the reply', async () => {
    const page = mama.page;
    const m = body(page, 'Привет, мама');
    await m.hover();
    await m.getByTestId('message-more').click();
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Ответить' }).click();
    await expect(page.getByTestId('reply-bar')).toBeVisible();
    await page.getByTestId('emoji-button').click();
    await page.getByLabel('Найти эмодзи').fill('спасибо');
    await mouseClick(page, page.getByTestId('emoji-picker').getByRole('option', { name: /спасибо/ }).first());
    await expect(page.getByTestId('reply-bar')).toHaveCount(0);
    const reply = body(page, '🙏').last();
    await expect(reply.getByTestId('message-quote')).toContainText('Привет, мама');
  });

  await test.step('reactions through the picker: pick reacts and closes', async () => {
    const page = mama.page;
    const m = body(page, 'Привет, мама');
    await m.hover();
    await m.getByTestId('message-more').click();
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Другие реакции' }).click();
    const picker = page.getByTestId('emoji-picker');
    await page.getByLabel('Найти эмодзи').fill('ёлка');
    await mouseClick(page, picker.getByRole('option', { name: /ёлка/ }).first());
    await expect(picker).toBeHidden();
    await expect(m.getByTestId('reaction-chip').filter({ hasText: '🎄' })).toBeVisible();
    // Recently used includes the reaction too.
    await page.getByTestId('emoji-button').click();
    await expect(picker.getByTestId('emoji-option').first()).toHaveText('🎄');
    await page.keyboard.press('Escape');
  });

  await test.step('phone, finger taps: send into an empty field, insert at the remembered caret', async () => {
    const phone: User = await newUser({ ...devices['Pixel 7'] });
    const page = phone.page;
    // Mama's invitation link is used up: Petya's phone restores into the family by joining anew is out of scope,
    // so the phone is a third relative.
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Семья и сервер/ }).click();
    await mama.page.getByTestId('create-invite').click();
    const link = await mama.page.getByTestId('invite-link').inputValue();
    await page.goto(link);
    await page.getByRole('button', { name: 'Продолжить в браузере' }).tap();
    await page.getByLabel('Как вас зовут').fill('Вася');
    await page.getByRole('button', { name: 'Войти в семейный чат' }).tap();
    const box = page.getByLabel('Сообщение');
    await expect(box).toBeVisible();

    await page.getByTestId('emoji-button').tap();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible();
    // On a touch screen the search is not focused (the keyboard would cover the grid).
    await expect(page.getByLabel('Найти эмодзи')).not.toBeFocused();
    const option = picker.getByTestId('emoji-option').nth(4);
    const chosen = (await option.textContent())!.trim();
    await fingerTap(page, option);
    await expect(picker).toBeHidden();
    await expect(body(page, chosen)).toHaveCount(1);
    await expect(box).toHaveValue('');

    await box.tap();
    await page.keyboard.type('Доброе утро');
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
    // Touching the emoji button takes the focus away from the field; the caret is remembered.
    await page.getByTestId('emoji-button').tap();
    await fingerTap(page, picker.getByTestId('emoji-option').first());
    await expect(picker).toBeHidden();
    await expect(box).toHaveValue(`Доброе${chosen} утро`);
    expect(await caret(page)).toEqual([6 + chosen.length, 6 + chosen.length, true]);
    await expectAccessible(page, 'chat on a phone after an emoji');
    await phone.context.close();
    await mama.page.getByRole('button', { name: 'Назад' }).click();
    await mama.page.getByRole('button', { name: 'Назад' }).click();
  });

  await test.step('gender in my profile: «Ж» is kept in the signed profile', async () => {
    const page = petya.page;
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Мой профиль/ }).click();
    const male = page.getByRole('radio', { name: /М, мужской/ });
    const female = page.getByRole('radio', { name: /Ж, женский/ });
    await expect(male).toBeChecked();
    await expectAccessible(page, 'my profile with gender');
    await female.check();
    await expect(page.getByText('Сохранено')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Мой профиль/ }).click();
    await expect(page.getByRole('radio', { name: /Ж, женский/ })).toBeChecked();
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
  });

  await test.step('appearance: changes apply at once, survive a reload without a flash, reset', async () => {
    const page = mama.page;
    await toList(page);
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Оформление/ }).click();
    await expect(page.getByTestId('appearance-preview')).toBeVisible();
    await expectAccessible(page, 'appearance');
    await page.getByTestId('palette-choice').getByRole('radio', { name: 'Синий' }).check();
    await page.getByTestId('theme-choice').getByRole('radio', { name: 'Тёмная' }).check();
    await page.getByTestId('radius-choice').getByRole('radio', { name: 'Круглые' }).check();
    await page.getByTestId('background-choice').getByRole('radio', { name: 'Точки' }).check();
    await page.getByTestId('text-size').fill('3');
    const attrs = () =>
      page.evaluate(() => {
        const r = document.documentElement;
        return {
          theme: r.dataset['theme'] ?? null,
          palette: r.dataset['palette'] ?? null,
          radius: r.dataset['radius'] ?? null,
          bg: r.dataset['chatBg'] ?? null,
          scale: r.style.getPropertyValue('--chat-scale'),
          color: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        };
      });
    const want = { theme: 'dark', palette: 'blue', radius: 'large', bg: 'dots', scale: '1.25', color: '#1a2029' };
    expect(await attrs()).toEqual(want);
    // The own message in the preview follows the palette.
    const outBg = await page.locator('[data-testid="appearance-preview"] .out .bubble').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(outBg).toBe('rgb(31, 58, 92)');
    await expectAccessible(page, 'appearance (blue, dark)');

    // After a reload the attributes are there before the app's own code runs (public/early.js).
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __early?: string | null }).__early = document.documentElement.getAttribute('data-palette');
      });
    });
    await page.reload();
    expect(await page.evaluate(() => (window as unknown as { __early?: string | null }).__early)).toBe('blue');
    expect(await attrs()).toEqual(want);

    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Оформление/ }).click();
    await page.getByTestId('appearance-reset').click();
    expect(await attrs()).toEqual({ theme: null, palette: null, radius: null, bg: null, scale: '', color: '#1e4e41' });
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
  });

  await test.step('axe over every palette in light and dark: chat list, chat, settings, appearance', async () => {
    const page = mama.page;
    for (const palette of PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(
          ([p, t]) => localStorage.setItem('fc.appearance', JSON.stringify({ palette: p, theme: t, background: 'tint' })),
          [palette, theme] as const,
        );
        await page.reload();
        const what = `${palette}, ${theme}`;
        await openChat(page, 'Петя');
        await expect(body(page, 'Привет, мама')).toBeVisible();
        await expectAccessible(page, `chat list and chat (${what})`);
        await page.getByRole('button', { name: 'Настройки' }).click();
        await expectAccessible(page, `settings (${what})`);
        await page.getByRole('button', { name: /Оформление/ }).click();
        await expect(page.getByTestId('palette-choice').getByRole('radio', { name: PALETTE_NAMES[palette] })).toBeChecked();
        await expectAccessible(page, `appearance (${what})`);
      }
    }
    await page.evaluate(() => localStorage.removeItem('fc.appearance'));
  });
});
