// Recovery phrase: the 32-byte seed itself encoded as BIP39 entropy (24 English words,
// 8-bit checksum). No PBKDF2 stretching: the phrase is the seed, nothing more.

import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { copy, type Bytes } from './bytes.ts';
import { PHRASE_WORDS, SEED_BYTES } from './constants.ts';
import { ProtocolError } from './errors.ts';

const WORDS = new Set(wordlist);

/** Seed (32 bytes) to the 24-word phrase, words separated by single spaces. */
export function seedToPhrase(seed: Uint8Array): string {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new ProtocolError('invalid-argument', `seed must be ${SEED_BYTES} bytes`);
  }
  return entropyToMnemonic(seed, wordlist);
}

/**
 * Split user input into normalised words: NFKD, lower case, any whitespace as separator.
 * Pasted phrases with line breaks, double spaces or capitals are accepted.
 */
export function normalizePhrase(input: string): string[] {
  return input.normalize('NFKD').toLowerCase().split(/\s+/u).filter((w) => w.length > 0);
}

/**
 * Phrase to seed. Throws ProtocolError with code
 * `phrase-word-count`, `phrase-unknown-word` (with 1-based `positions`) or `phrase-checksum`.
 * Error messages name positions only, never the words.
 */
export function phraseToSeed(input: string): Bytes {
  if (typeof input !== 'string') throw new ProtocolError('invalid-argument', 'phrase must be a string');
  const words = normalizePhrase(input);
  if (words.length !== PHRASE_WORDS) {
    throw new ProtocolError(
      'phrase-word-count',
      `the recovery phrase must have ${PHRASE_WORDS} words, got ${words.length}`,
    );
  }
  const unknown: number[] = [];
  words.forEach((w, i) => {
    if (!WORDS.has(w)) unknown.push(i + 1);
  });
  if (unknown.length > 0) {
    throw new ProtocolError(
      'phrase-unknown-word',
      `word${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} not in the word list`,
      unknown,
    );
  }
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(words.join(' '), wordlist);
  } catch {
    throw new ProtocolError(
      'phrase-checksum',
      'the recovery phrase checksum does not match: a word is probably mistyped or out of order',
    );
  }
  return copy(entropy);
}

/** True when the input is a valid 24-word phrase. */
export function isValidPhrase(input: string): boolean {
  try {
    phraseToSeed(input);
    return true;
  } catch {
    return false;
  }
}
