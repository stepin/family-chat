// Both catalogues have the same keys, the same kinds of values and the same
// placeholders: every argument a Russian string shows, the English one shows
// too. And the house rules for text: no em dash and no spaced en dash.

import { describe, expect, it, onTestFinished } from 'vitest';
import { setFormatLang } from '../format.ts';
import en from './en.ts';
import { g, pluralEn, pluralRu } from './forms.ts';
import ru from './ru.ts';

type Tree = { readonly [k: string]: unknown };

function leaves(tree: unknown, path = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
    for (const [k, v] of Object.entries(tree as Tree)) for (const [p, x] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, x);
  } else out.set(path, tree);
  return out;
}

/** What a value shows: for a function, its output for marker arguments, and which markers it shows. */
function render(fn: (...a: unknown[]) => unknown): { text: string; markers: string[] } {
  const n = fn.length;
  let text: string;
  try {
    text = String(fn(...Array.from({ length: n }, (_, i) => `ARG${i}X`)));
  } catch {
    // A date or a number argument: numbers that cannot be confused with other text.
    text = String(fn(...Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i)));
  }
  return { text, markers: [...text.matchAll(/ARG\d+X/g)].map((m) => m[0]).sort() };
}

const R = leaves(ru);
const E = leaves(en);

describe('string catalogues', () => {
  it('have the same keys', () => {
    expect([...E.keys()].sort()).toEqual([...R.keys()].sort());
  });

  it('have the same kinds of values and the same placeholders', () => {
    for (const [key, r] of R) {
      const e = E.get(key);
      expect(typeof e, key).toBe(typeof r);
      if (Array.isArray(r)) expect((e as unknown[]).length, key).toBe(r.length);
      if (typeof r === 'function') {
        expect((e as () => unknown).length, `${key}: arity`).toBe((r as () => unknown).length);
        expect(render(e as never).markers, `${key}: placeholders`).toEqual(render(r as never).markers);
      }
    }
  });

  it('have no empty strings, em dashes or spaced en dashes, in any form', () => {
    for (const [cat, tree] of [['ru', R], ['en', E]] as const) {
      for (const [key, v] of tree) {
        const texts: string[] = [];
        if (typeof v === 'string') texts.push(v);
        else if (Array.isArray(v)) texts.push(...v.map(String));
        else if (typeof v === 'function') {
          texts.push(render(v as never).text);
          if (v.length === 1) {
            for (const x of ['f', 'm', 1, 2, 5, 21, true, false, 'ios', 'android']) {
              try {
                texts.push(String((v as (a: unknown) => unknown)(x)));
              } catch {
                // Not an argument this function takes.
              }
            }
          }
        }
        for (const t of texts) {
          expect(t.trim().length, `${cat} ${key}`).toBeGreaterThan(0);
          expect(t, `${cat} ${key}`).not.toMatch(/\u2014| \u2013 /);
        }
      }
    }
  });

  it('English has no Cyrillic, except the names of the languages and the example sender', () => {
    const allowed = new Set(['lang.names.ru']);
    setFormatLang('en');
    onTestFinished(() => setFormatLang('ru'));
    for (const [key, v] of E) {
      if (allowed.has(key)) continue;
      const text = typeof v === 'function' ? render(v as never).text : String(v);
      expect(text, key).not.toMatch(/[а-яё]/i);
    }
  });
});

describe('word forms', () => {
  it('Russian plurals: one, few, many', () => {
    const forms = ['день', 'дня', 'дней'] as const;
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => pluralRu(n, forms))).toEqual([
      'дней', 'день', 'дня', 'дня', 'дней', 'дней', 'дней', 'дней', 'день', 'дня', 'дней', 'день', 'дней',
    ]);
  });

  it('English plurals: one, other', () => {
    expect([0, 1, 2].map((n) => pluralEn(n, 'day', 'days'))).toEqual(['days', 'day', 'days']);
  });

  it('gender: female only when the profile says so', () => {
    expect(g('f', 'вышел', 'вышла')).toBe('вышла');
    expect(g('m', 'вышел', 'вышла')).toBe('вышел');
    expect(g(undefined, 'вышел', 'вышла')).toBe('вышел');
    expect(ru.list.revokedPeer('f')).toBe('отозвала ключ');
    expect(en.contact.revoked('f')).toBe('She revoked her key. You can’t write to her.');
    expect(en.contact.revoked('m')).toBe('He revoked his key. You can’t write to him.');
  });
});
