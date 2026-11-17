import { describe, expect, it } from 'vitest';
import { sendStatus, statusLine } from './status.ts';
import { notifyState, type NotifyEnv } from './push.ts';
import { countWords, normalizePhrase, pickPositions } from './phrase.ts';
import type { AccountView } from '@family-chat/core';

describe('statusLine', () => {
  it('maps every connection state to the wording of the plan', () => {
    const since = new Date(2026, 10, 14, 9, 5).getTime();
    expect(statusLine({ kind: 'connected', since }, 'Семья')).toMatchObject({ text: 'На связи', tone: 'quiet' });
    expect(statusLine({ kind: 'connecting' }, 'Семья')).toMatchObject({ text: 'Соединяюсь…', tone: 'busy' });
    expect(statusLine(undefined, 'Семья').text).toBe('Соединяюсь…');
    expect(statusLine({ kind: 'offline', since }, 'Семья')).toMatchObject({ text: 'Нет связи с 09:05', tone: 'warn' });
    expect(statusLine({ kind: 'offline', since }, 'Семья', 2).text).toContain('отправятся, когда связь вернётся');
    expect(statusLine({ kind: 'login-invalid' }, 'Семья')).toMatchObject({ text: 'Вход недействителен', relogin: true });
    expect(statusLine({ kind: 'removed' }, 'Ивановы')).toMatchObject({ text: 'Вас отключили от семьи «Ивановы»', removed: true });
    // A family broken on its server (503 family_unavailable): the same words as in "Add a family".
    expect(statusLine({ kind: 'offline', since, unavailable: true }, 'Семья')).toMatchObject({
      text: 'Семья временно недоступна на сервере. Сообщите владельцу сервера.',
      tone: 'error',
    });
  });
});

describe('sendStatus', () => {
  it('words and actions of the three statuses', () => {
    expect(sendStatus('on-device')).toMatchObject({ label: 'На устройстве', actions: ['cancel'] });
    expect(sendStatus('on-server')).toMatchObject({ label: 'На сервере', actions: [] });
    expect(sendStatus('failed')).toMatchObject({ label: 'Не отправлено', actions: ['retry', 'cancel'] });
  });
});

describe('notifyState', () => {
  const env: NotifyEnv = { hasNotification: true, hasServiceWorker: true, hasPushManager: true, permission: 'default' };
  const account = { pushAvailable: true, vapidPublicKey: 'B', pushRegistered: false } as AccountView;
  const desktop = { os: 'other', inApp: false, standalone: false, iosSafari: false } as const;

  it('reports the real state', () => {
    expect(notifyState(env, desktop, account)).toBe('off');
    expect(notifyState({ ...env, permission: 'denied' }, desktop, account)).toBe('denied');
    expect(notifyState({ ...env, permission: 'granted' }, desktop, account)).toBe('granted-unregistered');
    expect(notifyState({ ...env, permission: 'granted' }, desktop, { ...account, pushRegistered: true })).toBe('allowed');
    expect(notifyState({ ...env, hasPushManager: false }, desktop, account)).toBe('unsupported');
    expect(notifyState(env, desktop, { ...account, pushAvailable: false })).toBe('server-off');
    expect(notifyState(env, { os: 'ios', inApp: false, standalone: false, iosSafari: true }, account)).toBe('ios-install');
    expect(notifyState(env, { os: 'ios', inApp: false, standalone: true, iosSafari: true }, account)).toBe('off');
  });
});

describe('phrase helpers', () => {
  it('normalises a pasted phrase', () => {
    expect(normalizePhrase(' 1. Abandon,\n2) ability\tABLE ')).toBe('abandon ability able');
    expect(countWords('')).toBe(0);
    expect(countWords('a b  c\n')).toBe(3);
  });

  it('picks distinct sorted positions', () => {
    let seed = 0.3;
    const rnd = () => (seed = (seed * 9301 + 0.49297) % 1);
    const p = pickPositions(24, 3, rnd);
    expect(p).toHaveLength(3);
    expect(new Set(p).size).toBe(3);
    expect([...p].sort((a, b) => a - b)).toEqual(p);
    expect(p.every((x) => x >= 0 && x < 24)).toBe(true);
  });
});
