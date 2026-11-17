import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hello } from '@family-chat/core';
import { forgetPageHello, pageHello } from './page-hello.ts';

describe('the page hello', () => {
  afterEach(() => forgetPageHello());

  it('shares one request per address and gives up after the timeout', async () => {
    const serverInfo = vi.fn(async () => ({ adminCodeActive: false }) as Hello);
    const core = { serverInfo };
    const [a, b] = await Promise.all([pageHello(core, 'https://s'), pageHello(core, 'https://s')]);
    expect(a).toBe(b);
    expect(serverInfo).toHaveBeenCalledTimes(1);
    const slow = { serverInfo: () => new Promise<Hello>(() => undefined) };
    expect(await pageHello(slow, 'https://slow', 10)).toBeNull();
  });
});
