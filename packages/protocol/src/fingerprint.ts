// Contact fingerprint for manual verification: 30 decimal digits in 6 groups of 5.

import { concat, lp, utf8 } from './bytes.ts';
import { sha256Bytes } from './keys.ts';

export const LABEL_FINGERPRINT = 'fc/v1/fingerprint\n';
const GROUPS = 6;

/**
 * Fingerprint of an identity's public keys. Both people compare the same string for the
 * same person (for example, Alice reads hers aloud and Bob compares it with what his app
 * shows for Alice).
 */
export function fingerprint(identity: { readonly signPub: Uint8Array; readonly boxPub: Uint8Array }): string {
  const h = sha256Bytes(concat(utf8(LABEL_FINGERPRINT), lp(identity.signPub), lp(identity.boxPub)));
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + (h[g * 5 + i] as number);
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
