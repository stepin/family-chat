// Voice messages end to end against a real fcd: recorded with Chromium's
// fake audio device (see MIC_SHIM), sent, received and played by the other
// person with the "не прослушано" mark clearing; speed; one player at a
// time; a recording cancelled; a refused microphone explained.

import { MIC_DENIED, MIC_SHIM, pairInChat } from './support/m3.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test } from './support/test.ts';

// A fresh server per test: each one sets up its own family.
let fcd: Fcd;

test.beforeEach(async () => {
  fcd = new Fcd();
  await fcd.start();
});

test.afterEach(async () => {
  await fcd.dispose();
});

test('a voice message is recorded, sent, played and marked as heard', async ({ newUser }) => {
  test.setTimeout(240_000);
  const { mama, petya } = await pairInChat(newUser, fcd, { permissions: ['microphone'], init: MIC_SHIM });

  await test.step('a click records (desktop), the timer runs, Escape cancels', async () => {
    await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
    const panel = mama.page.getByTestId('voice-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-mode', 'locked');
    await expect(mama.page.getByTestId('voice-timer')).toHaveText(/^0:0[1-9]$/, { timeout: 15_000 });
    await expectAccessible(mama.page, 'voice recording');
    // Focus moved to "send"; Escape cancels the recording.
    await expect(mama.page.getByRole('button', { name: 'Отправить голосовое' })).toBeFocused();
    await mama.page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(mama.page.getByTestId('voice-message')).toHaveCount(0);
    // The chat is still open (Escape went to the recorder only).
    await expect(mama.page.getByRole('heading', { name: 'Петя', exact: true })).toBeVisible();
  });

  await test.step('cancel with the button', async () => {
    await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
    await expect(mama.page.getByTestId('voice-timer')).toHaveText(/^0:0[1-9]$/, { timeout: 15_000 });
    await mama.page.getByRole('button', { name: 'Отменить запись' }).click();
    await expect(mama.page.getByTestId('voice-panel')).toBeHidden();
    await expect(mama.page.getByTestId('voice-message')).toHaveCount(0);
  });

  const mic = await mama.page.evaluate(() => (window as { __fcMic?: string }).__fcMic ?? 'none');
  test.info().annotations.push({ type: 'microphone', description: mic });

  await test.step('record about three seconds from the keyboard and send', async () => {
    await mama.page.getByRole('button', { name: 'Записать голосовое' }).focus();
    await mama.page.keyboard.press('Enter');
    await expect(mama.page.getByTestId('voice-timer')).toHaveText('0:03', { timeout: 20_000 });
    await mama.page.getByRole('button', { name: 'Отправить голосовое' }).click();
    const mine = mama.page.getByTestId('message').filter({ has: mama.page.getByTestId('voice-message') });
    await expect(mine).toHaveCount(1);
    await expect(mine).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });
    // Own voice messages carry no "не прослушано" mark.
    await expect(mine.getByTestId('voice-unheard')).toHaveCount(0);
  });

  await test.step('the other person sees it unheard, plays it, the mark clears', async () => {
    const got = petya.page.getByTestId('voice-message');
    await expect(got).toHaveCount(1, { timeout: 30_000 });
    await expect(got).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(got.getByTestId('voice-unheard')).toHaveText('не прослушано');
    await expect(got.getByTestId('voice-time')).toHaveText(/^0:0[34]$/);
    await expect(got.locator('.track .bar')).toHaveCount(48);
    await expectAccessible(petya.page, 'chat with a voice message');
    // The list shows what it is.
    await expect(petya.page.locator('button.chat').filter({ hasText: 'Мама' })).toContainText('Голосовое сообщение');

    const play = got.getByTestId('voice-play');
    await expect(play).toBeEnabled();
    await got.getByTestId('voice-speed').click();
    await expect(got.getByTestId('voice-speed')).toHaveText('1,5x');
    await got.getByTestId('voice-speed').click();
    await expect(got.getByTestId('voice-speed')).toHaveText('2x');
    await play.click();
    await expect(got.getByRole('button', { name: 'Пауза' })).toBeVisible();
    await expect(got).toHaveAttribute('data-heard', 'true', { timeout: 10_000 });
    await expect(got.getByTestId('voice-unheard')).toHaveCount(0);
    // Played to the end at 2x: back to the play button.
    await expect(got.getByRole('button', { name: /Воспроизвести голосовое/ })).toBeVisible({ timeout: 15_000 });
    const playing = await got.locator('audio').evaluate((a: HTMLAudioElement) => ({ rate: a.playbackRate, ended: a.ended, src: a.src.slice(0, 5) }));
    expect(playing).toEqual({ rate: 2, ended: true, src: 'blob:' });

    // Seeking from the keyboard on the waveform.
    const track = got.getByRole('slider', { name: 'Позиция воспроизведения' });
    await track.focus();
    await petya.page.keyboard.press('Home');
    await expect(track).toHaveAttribute('aria-valuenow', '0');
    await petya.page.keyboard.press('End');
    await expect(track).toHaveAttribute('aria-valuenow', /^[34]$/);
  });

  const mime = await petya.page.getByTestId('voice-message').getAttribute('data-mime');
  test.info().annotations.push({ type: 'recorded format', description: mime ?? '' });
  // Chromium records MP4 (AAC where the build has an encoder, else Opus in MP4; see lib/recorder.ts).
  expect(mime).toBe('audio/mp4');

  await test.step('the format plays in Chromium; the heard mark survives a reload', async () => {
    await petya.page.reload();
    await petya.page.locator('button.chat').filter({ hasText: 'Мама' }).click();
    const got = petya.page.getByTestId('voice-message');
    await expect(got).toHaveAttribute('data-heard', 'true', { timeout: 30_000 });
    await expect(got.getByTestId('voice-cannot-play')).toHaveCount(0);
  });

  await test.step('only one voice message plays at a time', async () => {
    // A second, longer message.
    await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
    await expect(mama.page.getByTestId('voice-timer')).toHaveText('0:04', { timeout: 20_000 });
    await mama.page.getByRole('button', { name: 'Отправить голосовое' }).click();
    const all = petya.page.getByTestId('voice-message');
    await expect(all).toHaveCount(2, { timeout: 30_000 });
    await expect(all.nth(1)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    for (const i of [0, 1]) await all.nth(i).getByTestId('voice-speed').click(); // 1,5x / 1x: slower, still playing when checked
    await all.nth(1).getByTestId('voice-play').click();
    await expect(all.nth(1).getByRole('button', { name: 'Пауза' })).toBeVisible();
    await all.nth(0).getByTestId('voice-play').click();
    await expect(all.nth(0).getByRole('button', { name: 'Пауза' })).toBeVisible();
    await expect(all.nth(1).getByRole('button', { name: /Воспроизвести/ })).toBeVisible();
    await all.nth(0).getByRole('button', { name: 'Пауза' }).click();
  });
});

test('a refused microphone is explained with how to allow it', async ({ newUser }) => {
  const { mama } = await pairInChat(newUser, fcd, { init: MIC_DENIED });
  await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
  const problem = mama.page.getByTestId('voice-problem');
  await expect(problem).toBeVisible();
  await expect(problem).toContainText('Нет доступа к микрофону');
  await expect(problem).toContainText('Микрофон');
  await expectAccessible(mama.page, 'microphone refused');
  await problem.getByRole('button', { name: 'Понятно' }).click();
  await expect(problem).toBeHidden();
  await expect(mama.page.getByTestId('voice-panel')).toHaveCount(0);
});

test('hold to record on a touch screen; slide left cancels', async ({ newUser }) => {
  test.setTimeout(180_000);
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['microphone'], init: MIC_SHIM };
  const { mama, petya } = await pairInChat(newUser, fcd, phone, { viewport: { width: 1200, height: 860 } });
  const page = mama.page;
  const btn = page.getByTestId('voice-record');
  const box = (await btn.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', px: number, py: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });

  await test.step('hold, then slide left: nothing is sent', async () => {
    await touch('touchStart', x, y);
    await expect(page.getByTestId('voice-panel')).toHaveAttribute('data-mode', 'hold');
    await expect(page.getByTestId('voice-timer')).toHaveText(/^0:0[1-9]$/, { timeout: 15_000 });
    for (const dx of [20, 50, 90, 120]) await touch('touchMove', x - dx, y);
    await expect(page.getByTestId('voice-panel')).toBeHidden();
    await touch('touchEnd', x - 120, y);
    await expect(page.getByTestId('voice-message')).toHaveCount(0);
  });

  await test.step('hold and release: sent', async () => {
    await touch('touchStart', x, y);
    await expect(page.getByTestId('voice-timer')).toHaveText('0:02', { timeout: 15_000 });
    await touch('touchEnd', x, y);
    await expect(page.getByTestId('voice-panel')).toBeHidden();
    await expect(petya.page.getByTestId('voice-message')).toHaveCount(1, { timeout: 30_000 });
  });

  await test.step('hold, slide up to lock, release: still recording until "send"', async () => {
    await touch('touchStart', x, y);
    await expect(page.getByTestId('voice-timer')).toHaveText(/^0:0[1-9]$/, { timeout: 15_000 });
    for (const dy of [20, 40, 70]) await touch('touchMove', x, y - dy);
    await touch('touchEnd', x, y - 70);
    await expect(page.getByTestId('voice-panel')).toHaveAttribute('data-mode', 'locked');
    await page.getByRole('button', { name: 'Отправить голосовое' }).click();
    await expect(petya.page.getByTestId('voice-message')).toHaveCount(2, { timeout: 30_000 });
  });
});

test('a WebM/Opus recording (browsers without MP4 recording) plays too', async ({ newUser }) => {
  test.setTimeout(180_000);
  const noMp4 = `${MIC_SHIM}
    (() => {
      const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = (t) => !t.startsWith('audio/mp4') && orig(t);
    })();`;
  const { mama, petya } = await pairInChat(newUser, fcd, { permissions: ['microphone'], init: noMp4 }, {});
  await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
  await expect(mama.page.getByTestId('voice-timer')).toHaveText('0:02', { timeout: 20_000 });
  await mama.page.getByRole('button', { name: 'Отправить голосовое' }).click();
  const got = petya.page.getByTestId('voice-message');
  await expect(got).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  await expect(got).toHaveAttribute('data-mime', 'audio/webm');
  await expect(got.getByTestId('voice-cannot-play')).toHaveCount(0);
  await got.getByTestId('voice-play').click();
  await expect(got).toHaveAttribute('data-heard', 'true', { timeout: 10_000 });
  await expect(got.getByRole('button', { name: /Воспроизвести голосовое/ })).toBeVisible({ timeout: 15_000 });
  expect(await got.locator('audio').evaluate((a: HTMLAudioElement) => a.ended)).toBe(true);
});

test('a format this browser cannot play is said plainly, with a download', async ({ newUser }) => {
  test.setTimeout(180_000);
  // The receiving browser claims it cannot play WebM (as Safari before 17 did).
  const noWebm = `(() => {
    const orig = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (t) { return t.startsWith('audio/webm') ? '' : orig.call(this, t); };
  })();`;
  const noMp4 = `${MIC_SHIM}
    (() => {
      const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      MediaRecorder.isTypeSupported = (t) => !t.startsWith('audio/mp4') && orig(t);
    })();`;
  const { mama, petya } = await pairInChat(newUser, fcd, { permissions: ['microphone'], init: noMp4 }, { init: noWebm });
  await mama.page.getByRole('button', { name: 'Записать голосовое' }).click();
  await expect(mama.page.getByTestId('voice-timer')).toHaveText('0:02', { timeout: 20_000 });
  await mama.page.getByRole('button', { name: 'Отправить голосовое' }).click();
  const got = petya.page.getByTestId('voice-message');
  await expect(got.getByTestId('voice-cannot-play')).toHaveText('Не удаётся воспроизвести на этом устройстве', { timeout: 30_000 });
  await expectAccessible(petya.page, 'voice message that cannot play');
  const download = petya.page.waitForEvent('download');
  await got.getByRole('button', { name: 'Скачать' }).click();
  expect((await download).suggestedFilename()).toMatch(/^Голосовое .*\.webm$/);
});
