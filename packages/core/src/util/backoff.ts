// Exponential backoff with jitter, so that many clients do not retry in step
// after a router reboot.

export interface BackoffOptions {
  /** Delay of the first retry, ms. */
  readonly baseMs: number;
  /** Upper bound of the delay before jitter, ms. */
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000 };

/**
 * Delay before retry number `attempt` (1-based): base * 2^(attempt-1), capped
 * at max, then multiplied by a random factor in [0.5, 1.5).
 */
export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(n - 1, 30));
  return Math.round(raw * (0.5 + random()));
}
