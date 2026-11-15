import { describe, expect, it } from 'vitest';
import { buildEmojiSet, loadEmoji } from './emoji-data.ts';
import EN from './emoji-en.ts';
import RU from './emoji-ru.ts';
import { QUICK_REACTION_EMOJI } from './reactions.ts';

const ru = buildEmojiSet(RU);
const en = buildEmojiSet(EN);

describe('emoji data', () => {
  it('every entry has a character, a name in its language and search words', () => {
    for (const [set, letters] of [
      [ru, /[а-яё]/i],
      [en, /[a-z]/i],
    ] as const) {
      let total = 0;
      for (const c of set.categories) {
        expect(c.items.length).toBeGreaterThan(20);
        expect(set.byChar.has(c.icon)).toBe(true);
        for (const e of c.items) {
          total++;
          expect(e.char.length).toBeGreaterThan(0);
          expect(e.char).not.toMatch(/[\sa-zA-Zа-яА-Я]/);
          expect(e.name).toMatch(letters);
          expect(e.words.length).toBeGreaterThan(0);
          expect(e.words.every((w) => w === w.toLowerCase() && !w.includes('ё'))).toBe(true);
        }
      }
      expect(total).toBeGreaterThan(400);
      // Each character once (the picker keys its grid by it).
      expect(set.byChar.size).toBe(total);
    }
  });

  it('Russian and English have the same characters in the same categories and order', () => {
    expect(en.categories.map((c) => [c.id, c.icon])).toEqual(ru.categories.map((c) => [c.id, c.icon]));
    for (let i = 0; i < ru.categories.length; i++) {
      expect(en.categories[i]!.items.map((e) => e.char), ru.categories[i]!.id).toEqual(ru.categories[i]!.items.map((e) => e.char));
    }
  });

  it('finds common emoji by Russian words, ё or е, by prefix', () => {
    expect(ru.search('сердц').map((e) => e.char)).toContain('❤️');
    expect(ru.search('ёлка').map((e) => e.char)).toContain('🎄');
    expect(ru.search('елка').map((e) => e.char)).toContain('🎄');
    expect(ru.search('спасибо').map((e) => e.char)).toContain('🙏');
    expect(ru.search('смех').map((e) => e.char)).toContain('😂');
    expect(ru.search('красное сердце').map((e) => e.char)).toEqual(['❤️']);
    expect(ru.search('')).toEqual([]);
    expect(ru.search('qqqqq')).toEqual([]);
  });

  it('finds common emoji by English words', () => {
    expect(en.search('heart').map((e) => e.char)).toContain('❤️');
    expect(en.search('christmas').map((e) => e.char)).toContain('🎄');
    expect(en.search('thanks').map((e) => e.char)).toContain('🙏');
    expect(en.search('laugh').map((e) => e.char)).toContain('😂');
    expect(en.search('red heart').map((e) => e.char)).toEqual(['❤️']);
    expect(en.search('сердце')).toEqual([]);
  });

  it('loads the set of the interface language', async () => {
    expect((await loadEmoji('en')).byChar.get('🎄')!.name).toBe('christmas tree');
    expect((await loadEmoji('ru')).byChar.get('🎄')!.name).toBe('ёлка');
  });

  it('the quick reactions are in the set', () => {
    for (const emoji of QUICK_REACTION_EMOJI) expect(ru.byChar.has(emoji)).toBe(true);
  });
});
