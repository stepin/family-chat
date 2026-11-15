// Every string the interface shows comes from the active catalogue `t`
// (M7: Russian in i18n/ru.ts, English in i18n/en.ts, the same shape). Only
// the active language is loaded: each catalogue is its own chunk, imported
// before the app is mounted and again when the person changes the language
// (the screens are then rendered anew, see App.svelte).
//
// `t` is a live binding: modules read it when they need a string, never keep
// a copy.

import type { Strings } from './i18n/ru.ts';
import { setFormatLang } from './format.ts';
import type { Lang } from './locale.ts';

export type { Strings };
export type { Gender } from './i18n/forms.ts';

/** The active string table (set by `loadStrings` before anything is shown). */
export let t: Strings = undefined as unknown as Strings;
let active: Lang | null = null;

/** Imports one catalogue (its own chunk). */
export async function importStrings(lang: Lang): Promise<Strings> {
  const m = lang === 'en' ? await import('./i18n/en.ts') : await import('./i18n/ru.ts');
  return m.default;
}

/** Makes `strings` the active table for `lang`: formatters, `<html lang>`. */
export function useStrings(lang: Lang, strings: Strings): void {
  t = strings;
  active = lang;
  setFormatLang(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export async function loadStrings(lang: Lang): Promise<void> {
  if (active === lang) return;
  useStrings(lang, await importStrings(lang));
}

/** The language of the active table. */
export function activeLang(): Lang {
  return active ?? 'ru';
}
