import { describe, expect, it } from 'vitest';
import { emojiMatcher, isSingleEmoji } from './single-emoji.ts';

describe('isSingleEmoji (M8)', () => {
  it('one fully-qualified emoji', () => {
    for (const s of ['😀', '👍🏽', '👨‍👩‍👧', '🇷🇺', '1️⃣', '❤️', ' 😀 ']) expect(isSingleEmoji(s), s).toBe(true);
  });

  it('not two, not text, not bare symbols', () => {
    for (const s of ['😀😀', 'a', '😀 a', '', '  ', '1', '©', '❤']) expect(isSingleEmoji(s), JSON.stringify(s)).toBe(false);
  });

  it('a browser without the v flag shows the normal size', () => {
    const none = emojiMatcher(() => {
      throw new SyntaxError('Invalid flags');
    });
    expect(none).toBeNull();
    expect(isSingleEmoji('😀', none)).toBe(false);
  });
});
