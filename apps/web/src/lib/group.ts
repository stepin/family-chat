// Messages of a chat grouped by local day, with a separator before each day.

import type { MessageView } from '@family-chat/core';
import { dayKey, formatDayLabel } from './format.ts';

export type FeedItem =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'message';
      readonly key: string;
      readonly message: MessageView;
      /** Same sender as the previous message of the same day (bubbles sit closer). */
      readonly continued: boolean;
    };

/**
 * Builds the feed. Messages still on the device have no server time; they
 * belong to "now". The input order is kept (the core sorts by server order,
 * queued messages last).
 */
export function groupByDay(messages: readonly MessageView[], now: number): FeedItem[] {
  const out: FeedItem[] = [];
  let lastDay: string | null = null;
  let lastSender: string | null = null;
  const usedDays = new Set<string>();
  for (const m of messages) {
    const time = m.time ?? now;
    const day = dayKey(time);
    if (day !== lastDay) {
      // A day can repeat only with a skewed server clock; keys must stay unique.
      let key = `day:${day}`;
      while (usedDays.has(key)) key += '+';
      usedDays.add(key);
      out.push({ kind: 'day', key, label: formatDayLabel(time, now) });
      lastDay = day;
      lastSender = null;
    }
    out.push({ kind: 'message', key: m.key, message: m, continued: lastSender === m.senderId });
    lastSender = m.senderId;
  }
  return out;
}
