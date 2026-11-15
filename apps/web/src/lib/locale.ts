// Which language the interface speaks (M7). Russian and English; Russian by
// default. The person can pick one in Settings, otherwise the system's
// language list decides: the first of ru/en in it wins, and Russian when
// neither is there. The choice is per device: kept in localStorage (read
// synchronously at start, before the first screen) and copied into the app
// database, where the service worker reads it for notification text
// (public/push-sw.js repeats the same rule).

export type Lang = 'ru' | 'en';
export type LangPref = 'system' | Lang;

export const LANGS: readonly Lang[] = ['ru', 'en'];
export const LANG_PREFS: readonly LangPref[] = ['system', 'ru', 'en'];
export const DEFAULT_LANG: Lang = 'ru';

/** localStorage key, and the key of the settings table the service worker reads. */
export const LANG_STORAGE_KEY = 'fc.lang';
export const LANG_SETTING_KEY = 'ui.lang';

export function isLangPref(v: unknown): v is LangPref {
  return v === 'system' || v === 'ru' || v === 'en';
}

/** The first of ru/en in the system list (`navigator.languages`), by the primary subtag; Russian if neither. */
export function detectLang(languages: readonly string[] | undefined | null): Lang {
  for (const tag of languages ?? []) {
    const primary = String(tag).trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'ru' || primary === 'en') return primary;
  }
  return DEFAULT_LANG;
}

export function resolveLang(pref: LangPref, languages: readonly string[] | undefined | null): Lang {
  return pref === 'system' ? detectLang(languages) : pref;
}

/** The stored preference; 'system' when nothing (or something unknown) is stored. */
export function readLangPref(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): LangPref {
  try {
    const v = storage?.getItem(LANG_STORAGE_KEY);
    return isLangPref(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function writeLangPref(pref: LangPref, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeLocalStorage()): void {
  try {
    if (pref === 'system') storage?.removeItem(LANG_STORAGE_KEY);
    else storage?.setItem(LANG_STORAGE_KEY, pref);
  } catch {
    // Private mode or storage disabled: the choice lasts until the app is closed.
  }
}

/** BCP 47 tag for Intl formatting. */
export function intlLocale(lang: Lang): string {
  return lang === 'en' ? 'en-US' : 'ru-RU';
}

export function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
