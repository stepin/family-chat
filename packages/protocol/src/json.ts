// Strict JSON helpers for signed payloads. Internal.

import { fromUtf8, utf8 } from './bytes.ts';
import { MAX_CONTEXT_STRING_BYTES } from './constants.ts';
import { malformed, ProtocolError } from './errors.ts';

export type JsonObject = Record<string, unknown>;

/** Parse UTF-8 bytes as a JSON object. Rejects invalid UTF-8, a BOM, non-objects. */
export function parseJsonObject(bytes: Uint8Array, name: string): JsonObject {
  const text = fromUtf8(bytes);
  if (text === undefined) throw malformed(`${name}: invalid UTF-8`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed(`${name}: invalid JSON`);
  }
  if (!isObject(value)) throw malformed(`${name}: not a JSON object`);
  return value;
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSafeUint(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function requireUint(o: JsonObject, key: string, name: string): number {
  const v = o[key];
  if (!isSafeUint(v)) throw malformed(`${name}: ${key} must be a non-negative integer`);
  return v;
}

export function requireString(o: JsonObject, key: string, name: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw malformed(`${name}: ${key} must be a string`);
  return v;
}

/** serverId, chatId, auth nonce: opaque non-empty strings of bounded size. */
export function checkContextString(v: unknown, what: string, code: 'malformed' | 'invalid-argument'): string {
  if (typeof v !== 'string' || v.length === 0 || utf8(v).length > MAX_CONTEXT_STRING_BYTES) {
    throw new ProtocolError(code, `${what} must be a non-empty string of at most ${MAX_CONTEXT_STRING_BYTES} bytes`);
  }
  return v;
}

// C0, DEL, C1 controls and bidirectional formatting characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_NAME = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;

/** Problem with a display name, or undefined if it is acceptable. */
export function nameProblem(name: unknown, maxChars: number): string | undefined {
  if (typeof name !== 'string') return 'name must be a string';
  if (name.trim().length === 0) return 'name must not be empty';
  if ([...name].length > maxChars) return `name must be at most ${maxChars} characters`;
  if (FORBIDDEN_IN_NAME.test(name)) return 'name contains control or bidirectional characters';
  if (fromUtf8(utf8(name)) !== name) return 'name contains unpaired surrogates';
  return undefined;
}
