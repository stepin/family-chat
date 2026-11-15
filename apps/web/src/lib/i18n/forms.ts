// Word forms shared by the string catalogues: plurals and grammatical gender.
// Small on purpose: both catalogues import it, whichever one is loaded.

/** Grammatical gender of a person (profile field, docs/PROTOCOL.md 4.3): male unless the profile says otherwise. */
export type Gender = 'm' | 'f';

/** The form for a person's gender: g(gender, 'создал', 'создала'). Unknown means male. */
export function g<T>(gender: Gender | null | undefined, male: T, female: T): T {
  return gender === 'f' ? female : male;
}

/** Russian plural form: pluralRu(5, ['день', 'дня', 'дней']) is 'дней'. */
export function pluralRu(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** English plural form: pluralEn(1, 'day', 'days') is 'day'. */
export function pluralEn(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other;
}
