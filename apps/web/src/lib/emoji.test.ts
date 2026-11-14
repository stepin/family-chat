import { describe, expect, it } from 'vitest';
import { EMOJI_BY_CHAR, EMOJI_CATEGORIES, searchEmoji } from './emoji-data.ts';
import { QUICK_REACTIONS } from './reactions.ts';

describe('emoji data', () => {
  it('every entry has a character, a Russian name and search words', () => {
    let total = 0;
    for (const c of EMOJI_CATEGORIES) {
      expect(c.items.length).toBeGreaterThan(20);
      expect(EMOJI_BY_CHAR.has(c.icon)).toBe(true);
      for (const e of c.items) {
        total++;
        expect(e.char.length).toBeGreaterThan(0);
        expect(e.char).not.toMatch(/[\sa-zA-Zа-яА-Я]/);
        expect(e.name).toMatch(/[а-яё]/i);
        expect(e.words.length).toBeGreaterThan(0);
        expect(e.words.every((w) => w === w.toLowerCase() && !w.includes('ё'))).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(400);
    // Each character once (the picker keys its grid by it).
    expect(EMOJI_BY_CHAR.size).toBe(total);
  });

  it('finds common emoji by Russian words, ё or е, by prefix', () => {
    expect(searchEmoji('сердц').map((e) => e.char)).toContain('❤️');
    expect(searchEmoji('ёлка').map((e) => e.char)).toContain('🎄');
    expect(searchEmoji('елка').map((e) => e.char)).toContain('🎄');
    expect(searchEmoji('спасибо').map((e) => e.char)).toContain('🙏');
    expect(searchEmoji('смех').map((e) => e.char)).toContain('😂');
    expect(searchEmoji('красное сердце').map((e) => e.char)).toEqual(['❤️']);
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('qqqqq')).toEqual([]);
  });

  it('the quick reactions are in the set', () => {
    for (const [emoji] of QUICK_REACTIONS) expect(EMOJI_BY_CHAR.has(emoji)).toBe(true);
  });
});
