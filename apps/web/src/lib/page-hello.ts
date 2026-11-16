// The hello of the server the app was opened from: Welcome and
// AdminSetup share one request per address, so both screens agree on
// pending/done/failed and the request is not sent twice.
//
// One server holds one family. "Set up for my family" is offered while the
// server has no administrator (the admin code is active), when the server
// runs with `--offer-setup`, or when the hello could not be read (never hide
// the only way to set up because of a network error).

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

/** Show the setup button? `undefined` while the hello is pending (the slot is kept, the button hidden). */
export function offerSetup(state: HelloState, hello: Pick<Hello, 'adminCodeActive' | 'offerSetup'> | null): boolean | undefined {
  if (state === 'pending') return undefined;
  if (state === 'failed' || !hello) return true;
  return hello.adminCodeActive || hello.offerSetup;
}

export type SetupField =
  /** The page's own server: its address. */
  | { kind: 'page' }
  /** This server is taken, setup goes to another server: an empty field with a hint. */
  | { kind: 'other' }
  /** This server is taken and setup is not offered: "an administrator already exists". */
  | { kind: 'taken' };

/** What AdminSetup puts in the server field, by the page server's hello. */
export function setupField(state: HelloState, hello: Pick<Hello, 'adminCodeActive' | 'offerSetup'> | null): SetupField {
  if (state !== 'done' || !hello || hello.adminCodeActive) return { kind: 'page' };
  return hello.offerSetup ? { kind: 'other' } : { kind: 'taken' };
}
