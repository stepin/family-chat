// Notifications for several families on one device: families of one fcd
// share its push key, so one browser subscription is registered with all of
// them; each is turned off by itself; a family of another server gives the
// subscription up; a refresh registers only families that want it, and a
// family added later joins when its server's other families want it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView, FamilyChatCore } from '@family-chat/core';
import { disableNotifications, enableNotifications, refreshSubscription } from './push.ts';

const KEY_A = 'BAAA'; // one fcd (root and /f/ families)
const KEY_B = 'BBBB'; // another server

function acc(id: string, serverUrl: string, key: string, over: Partial<AccountView> = {}): AccountView {
  return {
    id,
    serverUrl,
    serverId: id,
    familyName: id,
    userId: 'u',
    devId: 'd',
    admin: false,
    status: 'active',
    retentionDays: 90,
    retentionGap: null,
    initialSyncDone: true,
    pushAvailable: true,
    pushRegistered: false,
    pushWanted: null,
    vapidPublicKey: key,
    lastSyncAt: null,
    revoked: false,
    selfChatId: 'x',
    oldestTime: null,
    historyTrimmed: false,
    ...over,
  };
}

const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A browser with one push subscription, and a core that records the servers' calls. */
function setup() {
  let current: { key: string; unsubscribed: boolean } | null = null;
  const subscription = () => ({
    options: { applicationServerKey: bytes(current!.key).buffer },
    toJSON: () => ({ endpoint: `https://push.example/${current!.key}`, keys: { p256dh: 'p', auth: 'a' }, expirationTime: null }),
    unsubscribe: async () => {
      current!.unsubscribed = true;
      current = null;
      return true;
    },
  });
  const pushManager = {
    getSubscription: async () => (current ? subscription() : null),
    subscribe: async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      current = { key: btoa(String.fromCharCode(...applicationServerKey)), unsubscribed: false };
      return subscription();
    },
  };
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
  const calls: string[] = [];
  const core = {
    push: {
      register: vi.fn(async (id: string) => void calls.push(`register ${id}`)),
      unregister: vi.fn(async (id: string) => void calls.push(`unregister ${id}`)),
    },
  } as unknown as FamilyChatCore;
  return { core, calls, browser: () => current };
}

describe('notifications for families of one server', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const root = acc('root', 'https://chat.example', KEY_A);
  const fam = acc('fam', 'https://chat.example/f/abcdefghijklmnop', KEY_A);
  const other = acc('other', 'https://elsewhere.example', KEY_B, { pushRegistered: true, pushWanted: true });

  it('enabling registers the one subscription with every family of the server; another server gives it up', async () => {
    const { core, calls, browser } = setup();
    const r = await enableNotifications(core, root, [root, fam, other]);
    expect(r.permission).toBe('granted');
    expect(r.failed).toEqual([]);
    expect(calls).toEqual(['unregister other', 'register root', 'register fam']);
    expect(browser()!.key).toBe(KEY_A);
  });

  it('a failure in one family is reported for it; the others stay on', async () => {
    const { core } = setup();
    vi.mocked(core.push.register).mockImplementation(async (id: string) => {
      if (id === 'fam') throw new Error('500');
    });
    const r = await enableNotifications(core, root, [root, fam]);
    expect(r.failed.map((a) => a.id)).toEqual(['fam']);
  });

  it('turning off one family keeps the subscription while another family of the server uses it', async () => {
    const { core, calls, browser } = setup();
    await enableNotifications(core, root, [root, fam]);
    calls.length = 0;
    await disableNotifications(core, fam, [{ ...root, pushRegistered: true }, { ...fam, pushRegistered: true }]);
    expect(calls).toEqual(['unregister fam']);
    expect(browser()).not.toBeNull();
    // The last one off removes the browser's subscription.
    await disableNotifications(core, root, [{ ...root, pushRegistered: true }, { ...fam, pushRegistered: false }]);
    expect(browser()).toBeNull();
  });

  it('a refresh registers wanted families only; a family turned off stays off; a new family joins', async () => {
    const { core, calls } = setup();
    await enableNotifications(core, root, [root]);
    calls.length = 0;
    const wantedRoot = { ...root, pushRegistered: true, pushWanted: true };
    // The family at /f/ was turned off: it stays off.
    await refreshSubscription(core, [wantedRoot, { ...fam, pushWanted: false }], 'https://chat.example');
    expect(calls).toEqual(['register root']);
    calls.length = 0;
    // A family of the same server added later (not decided yet) joins.
    await refreshSubscription(core, [wantedRoot, { ...fam, pushWanted: null }], 'https://chat.example/f/abcdefghijklmnop');
    expect(calls.sort()).toEqual(['register fam', 'register root']);
    calls.length = 0;
    // Nothing wanted and no subscription: nothing is sent.
    const fresh = setup();
    await refreshSubscription(fresh.core, [root, fam], 'https://chat.example');
    expect(fresh.calls).toEqual([]);
  });
});
