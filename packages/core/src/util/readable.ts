// A minimal observable value. The `subscribe` contract matches Svelte stores:
// the callback runs at once with the current value and on every change, and
// `subscribe` returns the function that unsubscribes. So `$store` works in
// Svelte without an adapter, and any other framework can wrap it in a few lines.

export type Unsubscribe = () => void;
export type Subscriber<T> = (value: T) => void;

export interface Readable<T> {
  subscribe(run: Subscriber<T>): Unsubscribe;
  /** Current value. For a lazy store with no subscribers it may be stale. */
  get(): T;
}

/**
 * `start` runs when the first subscriber arrives and may return a stop
 * function, which runs when the last one leaves.
 */
export type StartFn<T> = (set: (value: T) => void) => Unsubscribe | void;

export class Writable<T> implements Readable<T> {
  #value: T;
  readonly #subs = new Set<Subscriber<T>>();
  readonly #start: StartFn<T> | undefined;
  #stop: Unsubscribe | undefined;

  constructor(initial: T, start?: StartFn<T>) {
    this.#value = initial;
    this.#start = start;
  }

  get(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
    for (const run of [...this.#subs]) run(value);
  }

  update(fn: (value: T) => T): void {
    this.set(fn(this.#value));
  }

  subscribe(run: Subscriber<T>): Unsubscribe {
    if (this.#subs.size === 0 && this.#start) {
      this.#stop = this.#start((v) => this.set(v)) ?? undefined;
    }
    this.#subs.add(run);
    run(this.#value);
    return () => {
      if (!this.#subs.delete(run)) return;
      if (this.#subs.size === 0 && this.#stop) {
        const stop = this.#stop;
        this.#stop = undefined;
        stop();
      }
    };
  }
}

export function writable<T>(initial: T, start?: StartFn<T>): Writable<T> {
  return new Writable(initial, start);
}

/** A read-only view of a store. */
export function readonly<T>(store: Readable<T>): Readable<T> {
  return { subscribe: (run) => store.subscribe(run), get: () => store.get() };
}

/**
 * Resolves with the first value that satisfies `predicate` (handy in tests and
 * in code that waits for a state, for example "connected").
 */
export function until<T>(store: Readable<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: Unsubscribe | undefined;
    unsub = store.subscribe((v) => {
      if (done || !predicate(v)) return;
      done = true;
      resolve(v);
      queueMicrotask(() => unsub?.());
    });
    if (done) unsub();
  });
}
