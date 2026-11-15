// Dates and times for the UI. Everything shown is in the device's time zone;
// message times come from the server (docs/PLAN-v2.md 7.6). Words and number
// formats follow the interface language (M7), through Intl.

import { intlLocale, type Lang } from './locale.ts';

const DAY_MS = 86_400_000;

/** Local calendar day key `YYYY-MM-DD`. */
export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(time: number): number {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local days between two moments (0 = same day, 1 = yesterday). */
export function daysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY_MS);
}

let lang: Lang = 'ru';
let fmt = makeFormatters(lang);

function makeFormatters(l: Lang) {
  const loc = intlLocale(l);
  return {
    time: new Intl.DateTimeFormat(loc, l === 'en' ? { hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }),
    dayMonth: new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long' }),
    dayMonthYear: new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }),
    shortDate: new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', year: '2-digit' }),
    weekday: new Intl.DateTimeFormat(loc, { weekday: 'short' }),
    relative: new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }),
    list: new Intl.ListFormat(loc, { type: 'conjunction' }),
  };
}

/** Switches every formatter to the interface language (called when the string catalogue changes). */
export function setFormatLang(l: Lang): void {
  lang = l;
  fmt = makeFormatters(l);
}

export function formatLang(): Lang {
  return lang;
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase(intlLocale(lang)) + s.slice(1);
}

/** `ЧЧ:ММ` (Russian) or `7:05 PM` (English). */
export function formatTime(time: number): string {
  return fmt.time.format(time);
}

/** Day separator in a chat: "Сегодня", "Вчера", "12 ноября", "3 марта 2025 г." (or the English forms). */
export function formatDayLabel(time: number, now: number): string {
  const days = daysBetween(time, now);
  if (days === 0 || days === 1) return capitalize(fmt.relative.format(-days, 'day'));
  if (new Date(time).getFullYear() === new Date(now).getFullYear()) return fmt.dayMonth.format(time);
  return fmt.dayMonthYear.format(time);
}

/** Time in the chat list: today the time, yesterday the word, this week the weekday, otherwise a short date. */
export function formatListTime(time: number, now: number): string {
  const days = daysBetween(time, now);
  if (days <= 0) return formatTime(time);
  if (days === 1) return fmt.relative.format(-1, 'day');
  if (days < 7) return fmt.weekday.format(time);
  return fmt.shortDate.format(time);
}

/**
 * A date inside a sentence: "12 ноября 2026", "November 12, 2026". The
 * Russian "г." is dropped: the sentence around it puts its own period, and
 * "2026 г.." is what came out.
 */
export function formatDate(time: number): string {
  return fmt.dayMonthYear.format(time).replace(/\s*г\.$/u, '');
}

const BYTE_UNITS: Record<Lang, readonly string[]> = {
  ru: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
};

/** Human-readable size: "12,3 МБ", "12.3 MB". */
export function formatBytes(bytes: number): string {
  const units = BYTE_UNITS[lang];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${formatNumber(v, digits)} ${units[i]}`;
}

/** A size given in whole megabytes (the family's file limit): "200 МБ", "200 MB". */
export function formatMegabytes(mb: number): string {
  return `${formatNumber(mb, 0)} ${BYTE_UNITS[lang][2]}`;
}

export function formatNumber(n: number, maxFractionDigits = 0): string {
  return n.toLocaleString(intlLocale(lang), { maximumFractionDigits: maxFractionDigits });
}

/** Names joined as people say them: "Петя и Вася", "Petya, Vasya, and Masha". */
export function formatList(items: readonly string[]): string {
  return fmt.list.format(items);
}

/** Russian plural form (kept for older callers; the catalogues use i18n/forms.ts). */
export { pluralRu as plural } from './i18n/forms.ts';
