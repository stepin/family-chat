// Typed errors. Messages never contain key material, seeds, phrase words or plaintext.

export type ProtocolErrorCode =
  // Input is not well formed: bad encoding, wrong length, wrong JSON shape, bad padding.
  | 'malformed'
  // A value exceeds a protocol limit (name length, body size, event size).
  | 'too-large'
  // A caller passed an invalid argument when creating something.
  | 'invalid-argument'
  // Recovery phrase: wrong number of words.
  | 'phrase-word-count'
  // Recovery phrase: a word is not in the BIP39 English list (see `position`).
  | 'phrase-unknown-word'
  // Recovery phrase: all words are known but the checksum does not match.
  | 'phrase-checksum'
  // Unknown format version (envelope payload `v`, event format byte).
  | 'unsupported-version'
  // A public key is invalid (small order, wrong length) or X25519 gave an all-zero secret.
  | 'invalid-key'
  // Ed25519 signature does not verify over the received bytes.
  | 'bad-signature'
  // userId does not match SHA-256(signPub), or the envelope belongs to another user.
  | 'user-id-mismatch'
  // Auth envelope: serverId or nonce differ from what the verifier expected.
  | 'context-mismatch'
  // Event: produced for another server.
  | 'wrong-server'
  // Event: produced for another chat.
  | 'wrong-chat'
  // Event: produced for another epoch.
  | 'wrong-epoch'
  // Event: AES-GCM authentication failed (wrong key, or the bytes were altered).
  | 'wrong-key'
  // Event: author is not known to the caller (not a member of the chat).
  | 'unknown-author'
  // Event: author inside the ciphertext differs from the sender reported by the server.
  | 'sender-mismatch';

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
  readonly code: ProtocolErrorCode;
  /** 1-based word positions for `phrase-unknown-word`. */
  readonly positions?: readonly number[];

  constructor(code: ProtocolErrorCode, message: string, positions?: readonly number[]) {
    super(message);
    this.code = code;
    if (positions) this.positions = positions;
  }
}

export function isProtocolError(e: unknown, code?: ProtocolErrorCode): e is ProtocolError {
  return e instanceof ProtocolError && (code === undefined || e.code === code);
}

export function malformed(message: string): ProtocolError {
  return new ProtocolError('malformed', message);
}
