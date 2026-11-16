// Appearance settings of this device (Settings → "Оформление"): theme,
// colour palette, text size in chats, message corners, chat background.
//
// Stored in localStorage (per device, read synchronously) and applied as
// attributes on <html> that styles/tokens.css and styles/app.css react to.
// The CSP forbids inline scripts, so the very first application happens in
// public/early.js: a tiny same-origin classic script in <head>, run before
// the stylesheet and the body, so the page never paints in the default theme
// first. It repeats `parseAppearance` and `appearanceAttributes` below in
// plain JavaScript; a unit test keeps the two in agreement.

export type ThemeMode = 'system' | 'light' | 'dark';
export type Palette = 'green' | 'blue' | 'violet' | 'rose' | 'orange' | 'graphite';
export type Radius = 'small' | 'medium' | 'large';
export type ChatBackground = 'plain' | 'tint' | 'dots' | 'grid' | 'diagonal' | 'waves';

export interface Appearance {
  readonly theme: ThemeMode;
  readonly palette: Palette;
  /** Index into TEXT_SCALES. */
  readonly textSize: number;
  readonly radius: Radius;
  readonly background: ChatBackground;
}

export const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark'];
export const PALETTES: readonly Palette[] = ['green', 'blue', 'violet', 'rose', 'orange', 'graphite'];
export const RADII: readonly Radius[] = ['small', 'medium', 'large'];
export const BACKGROUNDS: readonly ChatBackground[] = ['plain', 'tint', 'dots', 'grid', 'diagonal', 'waves'];
/** Text size in chats: factors of the normal size (which itself follows the system setting). */
export const TEXT_SCALES: readonly number[] = [0.875, 1, 1.125, 1.25, 1.4];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  palette: 'green',
  textSize: 1,
  radius: 'medium',
  background: 'plain',
};

export const APPEARANCE_STORAGE_KEY = 'fc.appearance';

/**
 * Colour of the browser's bar (`theme-color`) per palette: the light value
 * is the accent (green: the icon's background), the dark one the surface
 * of the dark theme.
 */
export const THEME_COLORS: Record<Palette, { readonly light: string; readonly dark: string }> = {
  green: { light: '#1e4e41', dark: '#1c211f' },
  blue: { light: '#1e5aa0', dark: '#1a2029' },
  violet: { light: '#5b3d99', dark: '#1f1b26' },
  rose: { light: '#a3325a', dark: '#251b1e' },
  orange: { light: '#a34a12', dark: '#241d16' },
  graphite: { light: '#3d4250', dark: '#1c1d21' },
};

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Any stored value into valid settings: unknown or broken parts fall back to the defaults. */
export function parseAppearance(raw: unknown): Appearance {
  let o: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
    } catch {
      o = {};
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) o = raw as Record<string, unknown>;
  const size = o['textSize'];
  return {
    theme: pick(o['theme'], THEMES, DEFAULT_APPEARANCE.theme),
    palette: pick(o['palette'], PALETTES, DEFAULT_APPEARANCE.palette),
    textSize: typeof size === 'number' && Number.isInteger(size) && size >= 0 && size < TEXT_SCALES.length ? size : DEFAULT_APPEARANCE.textSize,
    radius: pick(o['radius'], RADII, DEFAULT_APPEARANCE.radius),
    background: pick(o['background'], BACKGROUNDS, DEFAULT_APPEARANCE.background),
  };
}

export function isDefaultAppearance(a: Appearance): boolean {
  return (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every((k) => a[k] === DEFAULT_APPEARANCE[k]);
}

export interface AppearanceAttributes {
  /** data-* attributes of <html>; null removes the attribute (the default). */
  readonly data: Readonly<Record<'theme' | 'palette' | 'radius' | 'chatBg', string | null>>;
  /** Value of --chat-scale on <html>; null removes it. */
  readonly scale: string | null;
  /** theme-color for the light and the dark system mode. */
  readonly themeColor: { readonly light: string; readonly dark: string };
}

export function appearanceAttributes(a: Appearance): AppearanceAttributes {
  const colors = THEME_COLORS[a.palette];
  const forced = a.theme === 'light' ? colors.light : a.theme === 'dark' ? colors.dark : null;
  return {
    data: {
      theme: a.theme === 'system' ? null : a.theme,
      palette: a.palette === 'green' ? null : a.palette,
      radius: a.radius === 'medium' ? null : a.radius,
      chatBg: a.background === 'plain' ? null : a.background,
    },
    scale: a.textSize === DEFAULT_APPEARANCE.textSize ? null : String(TEXT_SCALES[a.textSize]),
    themeColor: { light: forced ?? colors.light, dark: forced ?? colors.dark },
  };
}

/** Applies the settings to the document at once (no reload). */
export function applyAppearance(a: Appearance, doc: Document = document): void {
  const attrs = appearanceAttributes(a);
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(attrs.data)) {
    if (v === null) delete root.dataset[k];
    else root.dataset[k] = v;
  }
  if (attrs.scale === null) root.style.removeProperty('--chat-scale');
  else root.style.setProperty('--chat-scale', attrs.scale);
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const dark = (meta.getAttribute('media') ?? '').includes('dark');
    meta.content = dark ? attrs.themeColor.dark : attrs.themeColor.light;
  }
}

export function readAppearance(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Appearance {
  try {
    return parseAppearance(storage?.getItem(APPEARANCE_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearance(a: Appearance, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (isDefaultAppearance(a)) storage?.removeItem(APPEARANCE_STORAGE_KEY);
    else storage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(a));
  } catch {
    // Storage disabled: the settings last until the app is closed.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
