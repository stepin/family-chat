// The Lottie player for `.tgs` stickers: the light build of lottie-web,
// SVG renderer only and without expression support (expressions would run
// arbitrary JavaScript; the core removes them from the data as well). Loaded
// on first use in its own chunk, bundled with the app (no CDN). It needs no
// `unsafe-eval` and no inline styles beyond CSSOM, so the CSP stays as is.

import { lazy } from './lazy.ts';

export type { LottieAnimation, LottiePlayer } from 'lottie-web/build/player/esm/lottie_light.min.js';

export const loadLottie = lazy(async () => {
  const m = await import('lottie-web/build/player/esm/lottie_light.min.js');
  return m.default;
});

/** `prefers-reduced-motion: reduce`: animated stickers stay on their first frame and play on tap. */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
