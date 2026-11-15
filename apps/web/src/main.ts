import './styles/tokens.css';
import './styles/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { app, type InstallPromptEvent } from './lib/app.svelte.ts';
import { applyAppearance, readAppearance } from './lib/appearance.ts';
import { readLangPref, resolveLang, systemLanguages } from './lib/locale.ts';
import { loadStrings } from './lib/strings.ts';
import { registerServiceWorker } from './pwa.ts';

// public/early.js has already set the appearance before the first paint;
// this repeats it with the app's own code (the same rules).
applyAppearance(readAppearance());

// The composer stays above the on-screen keyboard: iOS shrinks only the
// visual viewport, so the app follows its height (set through CSSOM, which
// the CSP allows).
function trackViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    // iOS scrolls the page under the keyboard; keep the app pinned to the top.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

trackViewport();
// Android Chrome: keep the install prompt for the invitation gateway.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  app.installPrompt = e as InstallPromptEvent;
});
window.addEventListener('appinstalled', () => (app.installPrompt = null));
registerServiceWorker((apply) => {
  app.applyUpdate = apply;
  app.updateReady = true;
});
// Only the catalogue of the interface language is loaded (its own chunk).
const lang = resolveLang(readLangPref(), systemLanguages());
await loadStrings(lang).catch(() => loadStrings('ru'));
app.lang = lang;
mount(App, { target: document.getElementById('app')! });
