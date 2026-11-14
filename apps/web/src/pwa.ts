/**
 * Registers the app-shell service worker. Bundles live in `<root>/assets/`,
 * so `../sw.js` relative to this module is the app root on any path (6.11).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const root = new URL('../', import.meta.url);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.pathname }).catch(() => undefined);
  });
}
