// Regenerates the gender vectors (docs/vectors/profile-gender.json): profiles with the optional
// `gender` field and the negative cases, from fixed inputs.
// Run: pnpm --filter @family-chat/protocol run vectors:generate
// The earlier files are written by the other gen-vectors scripts and do not change.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8, type Bytes } from '../src/bytes.ts';
import { base64urlDecode } from '../src/codec.ts';
import { createProfileEnvelope, envelopeSigningInput, sealBytes, serializeEnvelope, type Gender, type SignedEnvelope } from '../src/envelope.ts';
import { deriveIdentityKeys, type IdentityKeys } from '../src/keys.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Bytes => new Uint8Array(Buffer.from(h, 'hex'));
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const idv = JSON.parse(readFileSync(join(out, 'identity.json'), 'utf8'));
const K: Record<string, IdentityKeys> = {
  alice: deriveIdentityKeys(fromHex(idv.users.alice.seedHex)),
};
const T0 = 1767225600000;

function vector(name: string, env: SignedEnvelope, gender: Gender) {
  const payload = base64urlDecode(env.payload);
  return { name, signer: 'alice', gender, payloadText: text(payload), signingInputHex: hex(envelopeSigningInput('profile', payload)), envelope: serializeEnvelope(env) };
}

/** A profile with exactly this payload, signed by alice (for cases the API refuses to create). */
function forged(payload: string): string {
  return serializeEnvelope(sealBytes('profile', utf8(payload), K.alice!));
}

const uid = K.alice!.userId;
const base = (gender: string) =>
  `{"v":1,"userId":"${uid}","name":"Алиса","avatar":null,"gender":${gender},"rev":3,"updated":${T0 + 3000}}`;

writeFileSync(
  join(out, 'profile-gender.json'),
  `${JSON.stringify(
    {
      note: 'Test vectors for docs/PROTOCOL.md 4.3: the optional "gender" field of a profile. Users are the ones of identity.json. A profile without the field means "m".',
      rule: 'gender is absent, "m" or "f"; anything else (another string, another case, null, a number) is malformed. Field order when writing: v, userId, name, avatar, gender, rev, updated.',
      profiles: [
        vector('female', createProfileEnvelope(K.alice!, { name: 'Алиса', rev: 3, updated: T0 + 3000, gender: 'f' }), 'f'),
        vector('male', createProfileEnvelope(K.alice!, { name: 'Алиса', rev: 3, updated: T0 + 3000, gender: 'm' }), 'm'),
        vector('no field', createProfileEnvelope(K.alice!, { name: 'Алиса', rev: 3, updated: T0 + 3000 }), 'm'),
      ],
      negative: [
        { name: 'unknown value', envelope: forged(base('"x"')), expectedError: 'malformed' },
        { name: 'upper case', envelope: forged(base('"F"')), expectedError: 'malformed' },
        { name: 'null', envelope: forged(base('null')), expectedError: 'malformed' },
        { name: 'a number', envelope: forged(base('1')), expectedError: 'malformed' },
        { name: 'empty string', envelope: forged(base('""')), expectedError: 'malformed' },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log('written: profile-gender.json');
