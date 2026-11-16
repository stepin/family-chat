// A text message that is exactly one emoji is shown twice as large, like a
// sticker. "One emoji" is one fully-qualified RGI emoji (flags, keycaps,
// ZWJ sequences, skin tones); bare ©, ❤ without VS16 and digits are not.
//
// `\p{RGI_Emoji}` needs the `v` flag (ES2024) while the build targets ES2022,
// so the expression is made at run time, once; a browser without it simply
// shows such messages at the normal size.

export type RegExpFactory = () => RegExp;

const realFactory: RegExpFactory = () => new RegExp('^\\p{RGI_Emoji}$', 'v');

/** The matcher, or null when the browser does not know the `v` flag. */
export function emojiMatcher(factory: RegExpFactory = realFactory): RegExp | null {
  try {
    return factory();
  } catch {
    return null;
  }
}

const matcher = emojiMatcher();

/** True when `text`, trimmed, is exactly one emoji. */
export function isSingleEmoji(text: string, re: RegExp | null = matcher): boolean {
  if (!re) return false;
  const s = text.trim();
  return s.length > 0 && s.length <= 32 && re.test(s);
}
