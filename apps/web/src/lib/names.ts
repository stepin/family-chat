// How people are named in the interface: fingerprints for comparing aloud,
// and names made unique with a short fingerprint when two relatives share one
//.

import { formatLang, formatList } from './format.ts';
import { intlLocale } from './locale.ts';

/** Groups of a fingerprint ("12345 67890 …", 6 groups of 5 digits). */
function groups(fp: string): string[] {
  return fp.trim().split(/\s+/).filter((g) => g.length > 0);
}

/** The fingerprint in lines of three groups, for reading aloud. */
export function fingerprintLines(fp: string): string[] {
  const g = groups(fp);
  const lines: string[] = [];
  for (let i = 0; i < g.length; i += 3) lines.push(g.slice(i, i + 3).join(' '));
  return lines;
}

/** The first group of a fingerprint: enough to tell two people with the same name apart. */
export function shortFingerprint(fp: string): string {
  return groups(fp)[0] ?? '';
}

export interface Named {
  readonly userId: string;
  readonly name: string | null;
  readonly fingerprint: string;
}

function key(name: string | null): string {
  return (name ?? '').trim().toLocaleLowerCase('ru');
}

/**
 * Names to show for a list of people: the name as is, and with " · 12345"
 * (the short fingerprint) when another person in the list has the same name.
 * People without a name get `unknown`.
 */
export function displayNames(people: readonly Named[], unknown: string): Map<string, string> {
  const count = new Map<string, number>();
  for (const p of people) count.set(key(p.name), (count.get(key(p.name)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of people) {
    const base = p.name?.trim() || unknown;
    const short = shortFingerprint(p.fingerprint);
    out.set(p.userId, (count.get(key(p.name)) ?? 0) > 1 && short ? `${base} · ${short}` : base);
  }
  return out;
}

/** The letter in an avatar placeholder. */
export function initial(name: string | null | undefined): string {
  const s = (name ?? '').trim();
  if (s.length === 0) return '?';
  return (Array.from(s)[0] ?? '?').toLocaleUpperCase(intlLocale(formatLang()));
}

/** "Петя", "Петя и Вася", "Петя, Вася и Катя" (or the English forms: Intl list formatting). */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return formatList(names);
}
