// The hello of the server the app was opened from, one request per address
// (AdminSetup reads it to fill the server field). "Set up for my family" is
// always offered: one fcd holds several families, and setting one up needs
// the server admin code anyway.

import type { FamilyChatCore, Hello } from '@family-chat/core';

/** No answer in this time counts as "hello not received". */
export const HELLO_TIMEOUT_MS = 5000;

export type HelloState = 'pending' | 'done' | 'failed';

const cache = new Map<string, Promise<Hello | null>>();

/** The hello of `url`, or null when it failed or took longer than 5 s. */
export function pageHello(core: Pick<FamilyChatCore, 'serverInfo'>, url: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<Hello | null> {
  let p = cache.get(url);
  if (!p) {
    p = Promise.race([
      core.serverInfo(url).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    // A failure is not remembered: the next screen asks again.
    void p.then((h) => {
      if (!h) cache.delete(url);
    });
    cache.set(url, p);
  }
  return p;
}

/** For tests. */
export function forgetPageHello(): void {
  cache.clear();
}
