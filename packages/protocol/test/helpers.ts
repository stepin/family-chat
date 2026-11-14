import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { ProtocolError, type ProtocolErrorCode } from '../src/errors.ts';

const vectorsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadVector(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), 'utf8'));
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(h, 'hex'));

export function errorCode(fn: () => unknown): ProtocolErrorCode | 'ok' {
  try {
    fn();
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return (e as ProtocolError).code;
  }
}

export async function asyncErrorCode(p: Promise<unknown>): Promise<ProtocolErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return (e as ProtocolError).code;
  }
}
