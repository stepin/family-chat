// Dates and times for the UI. Everything shown is in the device's time zone;
// message times come from the server (docs/PLAN-v2.md 7.6).

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

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayMonthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayMonthYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

/** `ЧЧ:ММ`. */
export function formatTime(time: number): string {
  return timeFmt.format(time);
}

/** Day separator in a chat: "Сегодня", "Вчера", "12 ноября", "3 марта 2025". */
export function formatDayLabel(time: number, now: number): string {
  const days = daysBetween(time, now);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (new Date(time).getFullYear() === new Date(now).getFullYear()) return dayMonthFmt.format(time);
  return dayMonthYearFmt.format(time);
}

/** Time in the chat list: today `ЧЧ:ММ`, this week the weekday, otherwise `ДД.ММ.ГГ`. */
export function formatListTime(time: number, now: number): string {
  const days = daysBetween(time, now);
  if (days <= 0) return formatTime(time);
  if (days === 1) return 'вчера';
  if (days < 7) return weekdayFmt.format(time);
  return shortDateFmt.format(time);
}

/** A date for notices: "12 ноября 2026". */
export function formatDate(time: number): string {
  return dayMonthYearFmt.format(time);
}

/** Human-readable size: "12,3 МБ". */
export function formatBytes(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ${units[i]}`;
}

/** Russian plural form: plural(5, ['день', 'дня', 'дней']). */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
