/**
 * The root of this fcd from the app's own address: bundles live in
 * `<base>/assets/`, and a family at `<root>/f/<id>/` has `<root>` as its root
 * (also behind a proxy in a subfolder).
 */
export function rootOf(moduleUrl: string): URL {
  const base = new URL('../', moduleUrl);
  const m = /^(.*\/)f\/[a-z2-7]{16}\/$/.exec(base.pathname);
  if (m) base.pathname = m[1]!;
  return base;
}

/**
 * Registers the app-shell service worker: one per fcd, at its root, also
 * from the pages of other families (`/f/<id>/`). The browser's one push
 * subscription belongs to it, so pages of the root and of `/f/` families
 * never overwrite each other's subscription.
 *
 * A new version waits until the person confirms it:
 * `onUpdate` receives a function that activates it and reloads the page.
 */
export function registerServiceWorker(onUpdate?: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const root = rootOf(import.meta.url);
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
