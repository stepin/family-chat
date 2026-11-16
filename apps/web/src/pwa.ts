/**
 * Registers the app-shell service worker. Bundles live in `<root>/assets/`,
 * so `../sw.js` relative to this module is the app root on any path.
 *
 * A new version waits until the person confirms it:
 * `onUpdate` receives a function that activates it and reloads the page.
 */
export function registerServiceWorker(onUpdate?: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const root = new URL('../', import.meta.url);
  const start = async () => {
    const reg = await navigator.serviceWorker.register(new URL('sw.js', root), { scope: root.pathname });
    if (!onUpdate) return;
    const offer = (worker: ServiceWorker) =>
      onUpdate(() => {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        worker.postMessage({ type: 'SKIP_WAITING' });
      });
    // Only an update of an already controlling worker is offered; the very first install is silent.
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) offer(installing);
      });
    });
    // Check for a new version when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
    });
  };
  if (document.readyState === 'complete') void start().catch(() => undefined);
  else window.addEventListener('load', () => void start().catch(() => undefined));
}
