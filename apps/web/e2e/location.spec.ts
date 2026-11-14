// Places end to end against a real fcd: the position from an emulated
// geolocation, its accuracy shown before sending (with the warning when worse
// than 500 m), the card at the other person with the right map link, a
// refused permission explained, and not a single request to a third party.

import { pairInChat } from './support/m3.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test } from './support/test.ts';

let fcd: Fcd;

test.beforeEach(async () => {
  fcd = new Fcd();
  await fcd.start();
});

test.afterEach(async () => {
  await fcd.dispose();
});

test('a place is sent and opens in maps', async ({ newUser }) => {
  test.setTimeout(180_000);
  const here = { latitude: 55.7558, longitude: 37.6173, accuracy: 24 };
  const { mama, petya } = await pairInChat(newUser, fcd, { geolocation: here, permissions: ['geolocation'] });
  const foreign: string[] = [];
  for (const u of [mama, petya]) {
    u.page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http') && url.origin !== fcd.url) foreign.push(url.origin);
    });
  }

  await test.step('the sheet shows the position and its accuracy', async () => {
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page.getByRole('button', { name: 'Место', exact: true }).click();
    const sheet = mama.page.getByTestId('location-sheet');
    await expect(sheet.getByTestId('location-preview')).toContainText('55.75580, 37.61730');
    await expect(sheet.getByTestId('location-accuracy')).toHaveText('Точность: около 25 м');
    await expect(sheet.getByTestId('location-low')).toHaveCount(0);
    await expectAccessible(mama.page, 'place sheet');
    await sheet.getByRole('button', { name: 'Отправить место' }).click();
    await expect(sheet).toBeHidden();
    const card = mama.page.getByTestId('message').filter({ has: mama.page.getByTestId('location-card') });
    await expect(card).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
  });

  await test.step('the other person sees the card with an OpenStreetMap link (desktop)', async () => {
    const card = petya.page.getByTestId('location-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('location-coords')).toHaveText('55.75580, 37.61730');
    await expect(card).toContainText('Точность: около 25 м');
    const link = card.getByRole('link', { name: 'Открыть в картах' });
    await expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/?mlat=55.7558&mlon=37.6173#map=17/55.7558/37.6173');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(petya.page.locator('button.chat').filter({ hasText: 'Мама' })).toContainText('Место');
    await expectAccessible(petya.page, 'chat with a place');
  });

  await test.step('low accuracy is pointed out before sending', async () => {
    await mama.context.setGeolocation({ latitude: 55.75, longitude: 37.61, accuracy: 1800 });
    await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
    await mama.page.getByRole('button', { name: 'Место', exact: true }).click();
    const sheet = mama.page.getByTestId('location-sheet');
    await expect(sheet.getByTestId('location-accuracy')).toHaveText('Точность: около 1,8 км');
    await expect(sheet.getByTestId('location-low')).toContainText('Точность низкая');
    await sheet.getByRole('button', { name: 'Отмена' }).click();
    await expect(sheet).toBeHidden();
  });

  // Not a single map tile or any other request outside the family server.
  expect(foreign).toEqual([]);
});

test('Android gets a geo: link (iOS: Apple Maps, see lib/location.test.ts)', async ({ newUser }) => {
  test.setTimeout(180_000);
  const android = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    geolocation: { latitude: 59.9386, longitude: 30.3141, accuracy: 10 },
    permissions: ['geolocation'],
  };
  // The admin's browser says "Android" (a desktop-sized window: the flows stay the same). An
  // invited "iPhone" would be sent to "add to Home Screen" first, so iOS links are unit-tested.
  const { mama, petya } = await pairInChat(newUser, fcd, android, {});
  await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
  await mama.page.getByRole('button', { name: 'Место', exact: true }).click();
  await mama.page.getByTestId('location-sheet').getByRole('button', { name: 'Отправить место' }).click();
  await expect(mama.page.getByTestId('location-open')).toHaveAttribute('href', 'geo:59.9386,30.3141?q=59.9386,30.3141');
  await expect(mama.page.getByTestId('location-open')).not.toHaveAttribute('target', /.+/);
  await expect(petya.page.getByTestId('location-open')).toHaveAttribute('href', /^https:\/\/www\.openstreetmap\.org\/\?mlat=59\.9386&mlon=30\.3141#/, {
    timeout: 30_000,
  });
});

test('a refused location permission is explained', async ({ newUser }) => {
  // No geolocation permission granted: Chromium answers PERMISSION_DENIED.
  const { mama } = await pairInChat(newUser, fcd);
  await mama.page.getByRole('button', { name: 'Прикрепить' }).click();
  await mama.page.getByRole('button', { name: 'Место', exact: true }).click();
  const sheet = mama.page.getByTestId('location-sheet');
  const problem = sheet.getByTestId('location-problem');
  await expect(problem).toHaveAttribute('data-problem', 'denied', { timeout: 30_000 });
  await expect(problem).toContainText('Нет доступа к местоположению');
  await expect(problem).toContainText('Местоположение');
  await expect(sheet.getByRole('button', { name: 'Отправить место' })).toBeDisabled();
  await expectAccessible(mama.page, 'place refused');
  await mama.page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(mama.page.getByRole('heading', { name: 'Петя', exact: true })).toBeVisible();
});
