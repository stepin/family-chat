// Helpers for the recovery phrase screens.

/** `k` distinct random positions in `0..n-1`, ascending. */
export function pickPositions(n: number, k: number, random: () => number = cryptoRandom): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

function cryptoRandom(): number {
  const v = new Uint32Array(1);
  crypto.getRandomValues(v);
  return v[0]! / 2 ** 32;
}

/**
 * Normalises a pasted phrase: any whitespace, commas, numbering ("1. word")
 * and letter case are tolerated.
 */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+[.)]?/g, ' ')
    .split(/[\s,;]+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

export function countWords(text: string): number {
  const n = normalizePhrase(text);
  return n.length === 0 ? 0 : n.split(' ').length;
}
