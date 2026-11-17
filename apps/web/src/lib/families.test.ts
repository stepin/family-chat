// Interface helpers for several families: which family gets the notifications, the
// notification state with several families, the badge and the title,
// recognising the same server.

import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@family-chat/core';
import { showUnread } from './badge.ts';
import { familyAddressLabel, sameServer } from './invite.ts';
import { notifyState, pushAccountOf, type NotifyEnv } from './push.ts';

function acc(over: Partial<AccountView>): AccountView {
  return {
    id: 'a',
    serverUrl: 'https://one.example',
    serverId: 's',
    familyName: 'Ивановы',
    userId: 'u',
    devId: 'd',
    admin: false,
    status: 'active',
    retentionDays: 90,
    retentionGap: null,
    initialSyncDone: true,
    pushAvailable: true,
    pushRegistered: false,
    vapidPublicKey: 'B',
    lastSyncAt: null,
    revoked: false,
    selfChatId: 'x',
    oldestTime: null,
    historyTrimmed: false,
    ...over,
  };
}

describe('push with several families', () => {
  const one = acc({ id: 'one', serverUrl: 'https://one.example' });
  const two = acc({ id: 'two', serverUrl: 'https://two.example:8443/chat', familyName: 'Петровы' });

  it('prefers the registered family, then the one the app was opened from, then the first', () => {
    expect(pushAccountOf([one, two], 'https://two.example:8443')?.id).toBe('two');
    expect(pushAccountOf([one, two], 'https://elsewhere.example')?.id).toBe('one');
    expect(pushAccountOf([one, { ...two, pushRegistered: true }], 'https://one.example')?.id).toBe('two');
    expect(pushAccountOf([{ ...one, status: 'removed' }, two], 'https://one.example')?.id).toBe('two');
    expect(pushAccountOf([], 'https://one.example')).toBeNull();
  });

  it('says honestly that another family sends the notifications', () => {
    const env: NotifyEnv = { hasNotification: true, hasServiceWorker: true, hasPushManager: true, permission: 'granted' };
    const desktop = { os: 'other' as const, inApp: false, standalone: false, iosSafari: false };
    const registered = { ...two, pushRegistered: true };
    expect(notifyState(env, desktop, one, registered)).toBe('other-family');
    expect(notifyState(env, desktop, registered, registered)).toBe('allowed');
    // Nothing registered yet: every family may enable them.
    expect(notifyState(env, desktop, one, two)).toBe('granted-unregistered');
  });
});

describe('badge and title', () => {
  it('sets the badge and the title, clears both at zero', () => {
    const nav = { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) };
    const doc = { title: '' };
    showUnread(3, nav, doc);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    expect(doc.title).toBe('(3) Family Chat');
    showUnread(0, nav, doc);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(doc.title).toBe('Family Chat');
  });
});

describe('sameServer', () => {
  it('ignores case of the host and a trailing slash', () => {
    expect(sameServer('https://Chat.Example.org/', 'https://chat.example.org')).toBe(true);
    expect(sameServer('https://chat.example.org/a', 'https://chat.example.org/b')).toBe(false);
    expect(sameServer('http://127.0.0.1:1', 'http://127.0.0.1:2')).toBe(false);
  });
});

describe('badge without the API', () => {
  it('only changes the title', () => {
    const doc = { title: '' };
    expect(() => showUnread(5, {}, doc)).not.toThrow();
    expect(doc.title).toBe('(5) Family Chat');
    const throwing = { setAppBadge: () => { throw new Error('denied'); } };
    expect(() => showUnread(1, throwing, doc)).not.toThrow();
  });
});

describe('family address labels', () => {
  it('tells families of one host apart', () => {
    const root = familyAddressLabel('https://chat.example.org');
    const a = familyAddressLabel('https://chat.example.org/f/abcdefghijklmnop');
    const b = familyAddressLabel('https://chat.example.org/f/qrstuvwxyz234567/');
    expect(root).toBe('chat.example.org');
    expect(a).toBe('chat.example.org · /f/abcd…');
    expect(b).toBe('chat.example.org · /f/qrst…');
    expect(new Set([root, a, b]).size).toBe(3);
    expect(familyAddressLabel('https://example.org/chat')).toBe('example.org/chat');
  });
});
