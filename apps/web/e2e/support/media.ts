// Shared by the media specs (voice, location, resume, large files): two people in their direct chat, and browser
// shims for the microphone.

import { expect, type BrowserContextOptions } from '@playwright/test';
import { joinByLink, setupAdmin } from './flows.ts';
import type { Fcd } from './fcd.ts';
import type { User } from './test.ts';

export const wide = { viewport: { width: 1200, height: 860 } };

type NewUser = (options?: BrowserContextOptions & { init?: string }) => Promise<User>;

/** Mama (admin) and Petya (invited), each with their direct chat open. */
export async function pairInChat(newUser: NewUser, fcd: Fcd, optsMama: BrowserContextOptions & { init?: string } = {}, optsPetya = optsMama) {
  const mama = await newUser({ ...wide, ...optsMama });
  const { inviteLink } = await setupAdmin(mama.page, fcd);
  const petya = await newUser({ ...wide, ...optsPetya });
  await joinByLink(petya.page, inviteLink, 'Петя');
  await petya.page.getByLabel('Сообщение').fill('Привет');
  await petya.page.getByLabel('Сообщение').press('Enter');
  await petya.page.getByRole('button', { name: 'Позже' }).click();
  await mama.page.locator('button.chat').filter({ hasText: 'Петя' }).click({ timeout: 30_000 });
  await expect(mama.page.getByRole('heading', { name: 'Петя', exact: true })).toBeVisible();
  return { mama, petya };
}

/**
 * Chromium's fake audio device (`--use-fake-device-for-media-stream`) is used
 * where it works (Linux, CI). On macOS, audio capture through it never
 * resolves in this Chromium build (headless and headed; video capture works),
 * and the pending capture also stalls every AudioContext for ~10 s. There the
 * shim does not call it and hands out a generated tone from Web Audio
 * instead, so MediaRecorder, the level meter and playback still run for real.
 * Elsewhere a capture that does not answer within 3 s falls back the same
 * way. `window.__fcMic` says which source was used.
 */
export const MIC_SHIM = `
(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    if (!c || !c.audio) return real(c);
    const tone = () => {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const lfo = ac.createOscillator();
      lfo.frequency.value = 2;
      lfo.connect(gain.gain);
      osc.frequency.value = 440;
      osc.connect(gain);
      const dst = ac.createMediaStreamDestination();
      gain.connect(dst);
      osc.start();
      lfo.start();
      window.__fcMic = 'web-audio-tone';
      // Created during the click on "record": allowed to run.
      void ac.resume();
      return dst.stream;
    };
    if (${JSON.stringify(process.platform === 'darwin')}) return tone();
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); });
    const attempt = real(c);
    const got = await Promise.race([attempt, late]);
    clearTimeout(timer);
    if (got) { window.__fcMic = 'chromium-fake-device'; return got; }
    attempt.then((s) => s.getTracks().forEach((t) => t.stop()), () => undefined);
    return tone();
  };
})();
`;

/** The microphone permission is refused (what Chromium answers when the person clicks "Block"). */
export const MIC_DENIED = `
(() => {
  const md = navigator.mediaDevices;
  if (!md) return;
  md.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
})();
`;
