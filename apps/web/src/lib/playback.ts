// Only one voice message plays at a time: starting one pauses the other.

let current: HTMLMediaElement | null = null;

/** Call before `play()`: pauses whatever else was playing. */
export function claimPlayback(el: HTMLMediaElement): void {
  if (current && current !== el && !current.paused) current.pause();
  current = el;
}

/** The element is going away. */
export function releasePlayback(el: HTMLMediaElement): void {
  if (current === el) current = null;
}
