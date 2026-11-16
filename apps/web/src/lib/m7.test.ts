// M7: the language choice and the appearance settings (pure logic), and the
// agreement of public/early.js (run before the first paint) with appearance.ts.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  appearanceAttributes,
  BACKGROUNDS,
  DEFAULT_APPEARANCE,
  isDefaultAppearance,
  PALETTES,
  parseAppearance,
  RADII,
  readAppearance,
  TEXT_SCALES,
  THEMES,
  writeAppearance,
  type Appearance,
} from './appearance.ts';
import { emblems, EMBLEM_COLORS } from './emblem.ts';
import { detectLang, LANG_STORAGE_KEY, readLangPref, resolveLang, writeLangPref } from './locale.ts';

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

describe('language', () => {
  it('takes the first of ru and en from the system list, else Russian', () => {
    expect(detectLang(['en-US', 'ru'])).toBe('en');
    expect(detectLang(['de-DE', 'ru-RU', 'en'])).toBe('ru');
    expect(detectLang(['uk-UA', 'en-GB'])).toBe('en');
    expect(detectLang(['EN_us'])).toBe('en');
    expect(detectLang(['de', 'fr'])).toBe('ru');
    expect(detectLang([])).toBe('ru');
    expect(detectLang(undefined)).toBe('ru');
  });

  it('an explicit choice wins over the system', () => {
    expect(resolveLang('ru', ['en-US'])).toBe('ru');
    expect(resolveLang('en', ['ru-RU'])).toBe('en');
    expect(resolveLang('system', ['en-US'])).toBe('en');
  });

  it('is stored per device; "system" is the absence of a value; junk reads as "system"', () => {
    const s = memoryStorage();
    expect(readLangPref(s)).toBe('system');
    writeLangPref('en', s);
    expect(s.map.get(LANG_STORAGE_KEY)).toBe('en');
    expect(readLangPref(s)).toBe('en');
    writeLangPref('system', s);
    expect(s.map.has(LANG_STORAGE_KEY)).toBe(false);
    expect(readLangPref(memoryStorage({ [LANG_STORAGE_KEY]: 'de' }))).toBe('system');
    expect(readLangPref(null)).toBe('system');
  });
});

describe('appearance settings', () => {
  it('parses stored values, falling back to the defaults part by part', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('[1,2]')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(JSON.stringify({ theme: 'dark', palette: 'rose', textSize: 4, radius: 'large', background: 'dots' }))).toEqual({
      theme: 'dark',
      palette: 'rose',
      textSize: 4,
      radius: 'large',
      background: 'dots',
    });
    expect(parseAppearance({ theme: 'sepia', palette: 'blue', textSize: 9, radius: 3, background: 'url(x)' })).toEqual({
      ...DEFAULT_APPEARANCE,
      palette: 'blue',
    });
    expect(parseAppearance({ textSize: 1.5 }).textSize).toBe(DEFAULT_APPEARANCE.textSize);
  });

  it('stores only what differs from the defaults; reset removes the value', () => {
    const s = memoryStorage();
    writeAppearance({ ...DEFAULT_APPEARANCE, palette: 'violet' }, s);
    expect(readAppearance(s).palette).toBe('violet');
    writeAppearance(DEFAULT_APPEARANCE, s);
    expect(s.map.has(APPEARANCE_STORAGE_KEY)).toBe(false);
    expect(isDefaultAppearance(readAppearance(s))).toBe(true);
  });

  it('maps settings to attributes; defaults leave no attribute', () => {
    expect(appearanceAttributes(DEFAULT_APPEARANCE)).toEqual({
      data: { theme: null, palette: null, radius: null, chatBg: null },
      scale: null,
      themeColor: { light: '#1e4e41', dark: '#1c211f' },
    });
    const a = appearanceAttributes({ theme: 'dark', palette: 'blue', textSize: 3, radius: 'small', background: 'grid' });
    expect(a.data).toEqual({ theme: 'dark', palette: 'blue', radius: 'small', chatBg: 'grid' });
    expect(a.scale).toBe(String(TEXT_SCALES[3]));
    // A forced theme gives the browser bar one colour whatever the system mode.
    expect(a.themeColor.light).toBe(a.themeColor.dark);
  });

  it('every palette is defined in the stylesheet for light and dark', () => {
    const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
    for (const p of PALETTES) {
      const block = p === 'green' ? css.slice(css.indexOf(":root[data-palette='green']")) : css.slice(css.indexOf(`:root[data-palette='${p}']`));
      const body = block.slice(0, block.indexOf('}'));
      for (const token of ['bg', 'surface', 'text', 'muted', 'accent', 'on-accent', 'accent-soft', 'on-accent-soft']) {
        expect(body, `${p} --l-${token}`).toContain(`--l-${token}:`);
        expect(body, `${p} --d-${token}`).toContain(`--d-${token}:`);
      }
    }
  });
});

describe('public/early.js agrees with appearance.ts', () => {
  const CODE = readFileSync(new URL('../../public/early.js', import.meta.url), 'utf8');

  /** Runs early.js against a fake document; returns what it set. */
  function runEarly(stored: string | null, languages: string[] = ['ru-RU'], lang: string | null = null) {
    const attrs = new Map<string, string>();
    const props = new Map<string, string>();
    const metas = [
      { media: '(prefers-color-scheme: light)', content: '' },
      { media: '(prefers-color-scheme: dark)', content: '' },
    ];
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v), style: { setProperty: (k: string, v: string) => void props.set(k, v) } },
      querySelectorAll: () => metas.map((m) => ({ getAttribute: () => m.media, setAttribute: (_: string, v: string) => (m.content = v) })),
    };
    const window = { localStorage: memoryStorage({ ...(stored === null ? {} : { [APPEARANCE_STORAGE_KEY]: stored }), ...(lang ? { [LANG_STORAGE_KEY]: lang } : {}) }) };
    new Function('window', 'document', 'navigator', CODE)(window, document, { languages });
    return { attrs, props, metas };
  }

  const samples: Appearance[] = [DEFAULT_APPEARANCE];
  for (const theme of THEMES) for (const palette of PALETTES) samples.push({ ...DEFAULT_APPEARANCE, theme, palette });
  for (let textSize = 0; textSize < TEXT_SCALES.length; textSize++) for (const radius of RADII) samples.push({ ...DEFAULT_APPEARANCE, textSize, radius });
  for (const background of BACKGROUNDS) samples.push({ ...DEFAULT_APPEARANCE, background });

  it('sets the same attributes for every setting', () => {
    for (const a of samples) {
      const want = appearanceAttributes(a);
      const got = runEarly(JSON.stringify(a));
      const name = JSON.stringify(a);
      expect(got.attrs.get('data-theme') ?? null, name).toBe(want.data.theme);
      expect(got.attrs.get('data-palette') ?? null, name).toBe(want.data.palette);
      expect(got.attrs.get('data-radius') ?? null, name).toBe(want.data.radius);
      expect(got.attrs.get('data-chat-bg') ?? null, name).toBe(want.data.chatBg);
      expect(got.props.get('--chat-scale') ?? null, name).toBe(want.scale);
      expect(got.metas.map((m) => m.content), name).toEqual([want.themeColor.light, want.themeColor.dark]);
    }
  });

  it('ignores broken values like appearance.ts does', () => {
    for (const raw of ['nope', '[]', JSON.stringify({ theme: 'x', palette: 7, textSize: 99 })]) {
      expect(runEarly(raw).attrs.has('data-theme')).toBe(false);
      expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
    }
  });

  it('sets <html lang> by the same rule as locale.ts', () => {
    for (const [languages, lang, want] of [
      [['en-US'], null, 'en'],
      [['de', 'fr'], null, 'ru'],
      [['en-US'], 'ru', 'ru'],
      [['ru-RU'], 'en', 'en'],
    ] as const) {
      expect(runEarly(null, [...languages], lang).attrs.get('lang')).toBe(want);
      expect(resolveLang(lang ?? 'system', languages)).toBe(want);
    }
  });
});

describe('family emblems', () => {
  it('are stable and different for families on one device', () => {
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd'];
    const a = emblems(ids);
    const b = emblems([...ids].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(new Set([...a.values()].map((e) => e.color)).size).toBe(ids.length);
    expect(new Set([...a.values()].map((e) => e.symbol)).size).toBe(ids.length);
    const many = emblems(Array.from({ length: EMBLEM_COLORS.length }, (_, i) => `family${i}xxxxxxxxx`));
    expect(new Set([...many.values()].map((e) => e.color)).size).toBe(EMBLEM_COLORS.length);
  });
});
