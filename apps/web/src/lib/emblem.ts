// A family's emblem (M7): a coloured circle with a symbol, instead of the
// family's name at the top of the screen (a name can be a sore point; the
// main case is one family, where nothing is shown at all). Derived from the
// account id, so it stays the same; families on one device get different
// emblems while there are no more than EMBLEMS.length of them.

export const EMBLEM_COLORS: readonly string[] = ['#2f5d50', '#1e5aa0', '#5b3d99', '#a3325a', '#a34a12', '#3d4250', '#0f6464', '#6b5000'];
export const EMBLEM_SYMBOLS = ['circle', 'diamond', 'triangle', 'star', 'heart', 'leaf', 'sun', 'house'] as const;
export type EmblemSymbol = (typeof EMBLEM_SYMBOLS)[number];

export interface Emblem {
  readonly color: string;
  readonly symbol: EmblemSymbol;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Emblems of all families on the device, by account id: each starts from its hash and moves on past taken ones. */
export function emblems(accountIds: readonly string[]): ReadonlyMap<string, Emblem> {
  const n = EMBLEM_COLORS.length;
  const taken = new Set<number>();
  const out = new Map<string, Emblem>();
  for (const id of [...accountIds].sort()) {
    let i = hash(id) % n;
    for (let k = 0; k < n && taken.has(i); k++) i = (i + 1) % n;
    taken.add(i);
    // The symbol is shifted against the colour, so two emblems also differ in shape.
    out.set(id, { color: EMBLEM_COLORS[i]!, symbol: EMBLEM_SYMBOLS[(i * 3) % n]! });
  }
  return out;
}
