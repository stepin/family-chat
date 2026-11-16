import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hello } from '@family-chat/core';
import { forgetPageHello, offerSetup, pageHello, setupField } from './page-hello.ts';

const h = (adminCodeActive: boolean, offer: boolean) => ({ adminCodeActive, offerSetup: offer });

describe('setup button on the first screen', () => {
  afterEach(() => forgetPageHello());

  it('is offered on a free server, with the flag, or when hello failed', () => {
    expect(offerSetup('pending', null)).toBeUndefined();
    expect(offerSetup('done', h(true, false))).toBe(true);
    expect(offerSetup('done', h(false, false))).toBe(false);
    expect(offerSetup('done', h(false, true))).toBe(true);
    expect(offerSetup('failed', null)).toBe(true);
  });

  it('decides the server field of AdminSetup', () => {
    expect(setupField('pending', null)).toEqual({ kind: 'page' });
    expect(setupField('failed', null)).toEqual({ kind: 'page' });
    expect(setupField('done', h(true, true))).toEqual({ kind: 'page' });
    expect(setupField('done', h(false, true))).toEqual({ kind: 'other' });
    expect(setupField('done', h(false, false))).toEqual({ kind: 'taken' });
  });

  it('shares one request per address and gives up after the timeout', async () => {
    const serverInfo = vi.fn(async () => ({ adminCodeActive: false, offerSetup: false }) as Hello);
    const core = { serverInfo };
    const [a, b] = await Promise.all([pageHello(core, 'https://s'), pageHello(core, 'https://s')]);
    expect(a).toBe(b);
    expect(serverInfo).toHaveBeenCalledTimes(1);
    const slow = { serverInfo: () => new Promise<Hello>(() => undefined) };
    expect(await pageHello(slow, 'https://slow', 10)).toBeNull();
  });
});
