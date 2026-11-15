// The six quick reactions of the message menu (docs/PLAN.md 8.6), with names
// for screen readers from the active catalogue (the menu does not load the
// emoji picker's data).
import { t } from './strings.ts';

const QUICK: readonly (readonly [string, keyof typeof t.reactions])[] = [
  ['👍', 'thumbsUp'],
  ['❤️', 'heart'],
  ['😂', 'joy'],
  ['😮', 'wow'],
  ['😢', 'cry'],
  ['🙏', 'thanks'],
];

/** The quick reactions: [emoji, name in the interface language]. */
export function quickReactions(): readonly (readonly [string, string])[] {
  return QUICK.map(([emoji, key]) => [emoji, t.reactions[key]] as const);
}

/** Just the characters (tests, the picker's data check). */
export const QUICK_REACTION_EMOJI: readonly string[] = QUICK.map(([emoji]) => emoji);
