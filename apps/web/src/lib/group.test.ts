import { describe, expect, it } from 'vitest';
import type { MessageView } from '@family-chat/core';
import { groupByDay } from './group.ts';
import { formatListTime, plural } from './format.ts';

function msg(key: string, senderId: string, time: number | null): MessageView {
  return {
    key,
    accountId: 'a',
    chatId: 'c',
    msgId: key,
    senderId,
    outgoing: senderId === 'me',
    kind: 'msg',
    body: key,
    reply: null,
    gseq: time === null ? null : time,
    time,
    status: time === null ? 'on-device' : 'on-server',
    error: null,
  };
}

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('groupByDay', () => {
  const now = at(2026, 11, 14, 18);

  it('puts a separator before each local day and labels today and yesterday', () => {
    const feed = groupByDay(
      [msg('1', 'peer', at(2026, 3, 2)), msg('2', 'peer', at(2026, 11, 13, 9)), msg('3', 'me', at(2026, 11, 14, 8)), msg('4', 'me', null)],
      now,
    );
    expect(feed.map((f) => (f.kind === 'day' ? `day:${f.label}` : f.key))).toEqual([
      'day:2 марта',
      '1',
      'day:Вчера',
      '2',
      'day:Сегодня',
      '3',
      '4',
    ]);
  });

  it('marks consecutive messages of one sender within a day', () => {
    const feed = groupByDay([msg('1', 'peer', at(2026, 11, 14, 9)), msg('2', 'peer', at(2026, 11, 14, 10)), msg('3', 'me', at(2026, 11, 14, 11))], now);
    const flags = feed.filter((f) => f.kind === 'message').map((f) => (f.kind === 'message' ? f.continued : null));
    expect(flags).toEqual([false, true, false]);
  });

  it('shows the year for older years and keeps keys unique with a skewed clock', () => {
    const feed = groupByDay([msg('1', 'peer', at(2025, 1, 5)), msg('2', 'peer', at(2026, 11, 15)), msg('3', 'me', null)], now);
    expect(feed[0]).toMatchObject({ kind: 'day', label: '5 января 2025 г.' });
    const keys = feed.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('format', () => {
  it('list times and plurals', () => {
    const now = at(2026, 11, 14, 18);
    expect(formatListTime(at(2026, 11, 14, 9), now)).toBe('09:00');
    expect(formatListTime(at(2026, 11, 13, 9), now)).toBe('вчера');
    expect(formatListTime(at(2026, 10, 1, 9), now)).toBe('01.10.26');
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, ['день', 'дня', 'дней']))).toEqual(['день', 'дня', 'дней', 'дней', 'день', 'дня']);
  });
});
