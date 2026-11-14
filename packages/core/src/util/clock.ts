// Time is injected so tests can control it and so the engine does not depend
// on window globals (it must run in a worker or a service worker too).

export interface Clock {
  /** Milliseconds since 1970 (local clock; only for timers and local bookkeeping). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

/** Waits `ms`; resolves early (without throwing) when `signal` aborts. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clock.clearTimeout(handle);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const handle = clock.setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * A wake-up signal for loops: `wait(ms)` resolves after `ms` or as soon as
 * `kick()` is called, whichever comes first. A kick that arrives while nobody
 * waits is remembered, so it is never lost between two waits.
 */
export class Waker {
  #pending = false;
  #resolve: (() => void) | undefined;

  constructor(private readonly clock: Clock) {}

  kick(): void {
    if (this.#resolve) {
      const r = this.#resolve;
      this.#resolve = undefined;
      r();
    } else {
      this.#pending = true;
    }
  }

  wait(ms: number): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const handle = Number.isFinite(ms)
        ? this.clock.setTimeout(() => {
            if (this.#resolve === finish) this.#resolve = undefined;
            resolve();
          }, Math.max(0, ms))
        : undefined;
      const finish = () => {
        if (handle !== undefined) this.clock.clearTimeout(handle);
        resolve();
      };
      this.#resolve = finish;
    });
  }
}
