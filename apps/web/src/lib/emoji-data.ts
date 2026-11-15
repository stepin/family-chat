// A compact emoji set for the built-in picker (docs/PLAN.md 7.5, 8.6): the
// common emoji by category, each with a name and search words in the
// interface language (emoji-ru.ts, emoji-en.ts: each its own chunk, only the
// active one is loaded with the picker). Shipped with the app: nothing is
// fetched from anywhere, and the emoji are drawn by the system font.

import type { Lang } from './locale.ts';

export interface Emoji {
  readonly char: string;
  readonly name: string;
  /** Lower-case search words (name included), `ё` written as `е`. */
  readonly words: readonly string[];
}

export interface EmojiCategory {
  readonly id: string;
  readonly label: string;
  /** A representative emoji for the category tab. */
  readonly icon: string;
  readonly items: readonly Emoji[];
}

/** [id, label, icon, lines]; a line is `emoji|name|more search words`. */
export type EmojiRaw = readonly (readonly [string, string, string, string])[];

export interface EmojiSet {
  readonly categories: readonly EmojiCategory[];
  /** Every emoji by its character (for names of recent ones). */
  readonly byChar: ReadonlyMap<string, Emoji>;
  /** Emoji whose name or search words start with every word of the query. */
  search(query: string): Emoji[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

function words(name: string, extra: string): string[] {
  const out = new Set<string>();
  for (const w of normalize(`${name} ${extra}`).split(/[\s,]+/)) if (w) out.add(w);
  return [...out];
}

export function buildEmojiSet(raw: EmojiRaw): EmojiSet {
  const categories: EmojiCategory[] = raw.map(([id, label, icon, lines]) => ({
    id,
    label,
    icon,
    items: lines.split('\n').map((line) => {
      const [char = '', name = '', extra = ''] = line.split('|');
      return { char, name, words: words(name, extra) };
    }),
  }));
  const byChar = new Map(categories.flatMap((c) => c.items.map((e) => [e.char, e] as const)));
  return {
    categories,
    byChar,
    search(query: string): Emoji[] {
      const q = normalize(query).split(/\s+/).filter(Boolean);
      if (q.length === 0) return [];
      const out: Emoji[] = [];
      const seen = new Set<string>();
      for (const c of categories) {
        for (const e of c.items) {
          if (seen.has(e.char)) continue;
          if (q.every((w) => e.words.some((x) => x.startsWith(w)) || e.char === w)) {
            out.push(e);
            seen.add(e.char);
          }
        }
      }
      return out;
    },
  };
}

const cache = new Map<Lang, Promise<EmojiSet>>();

/** The emoji set with names in `lang` (loaded once). */
export function loadEmoji(lang: Lang): Promise<EmojiSet> {
  let p = cache.get(lang);
  if (!p) {
    p = (lang === 'en' ? import('./emoji-en.ts') : import('./emoji-ru.ts')).then((m) => buildEmojiSet(m.default));
    p.catch(() => cache.delete(lang));
    cache.set(lang, p);
  }
  return p;
}
