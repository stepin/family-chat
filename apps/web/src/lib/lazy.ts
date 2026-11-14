// A module loaded on first use, the same promise every time (so a screen
// shown again renders at once instead of flashing empty).

export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= load().catch((e: unknown) => {
      // A failed chunk load (offline right after an update) is tried again next time.
      p = undefined;
      throw e;
    });
    return p;
  };
}
