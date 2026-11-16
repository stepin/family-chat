// Regenerates the sticker vectors (docs/vectors/stickers.json): a signed sticker-pack manifest, file
// names (hash32), a sticker message payload and the negative cases, from fixed inputs.
// Run: pnpm --filter @family-chat/protocol run vectors:generate
// The other files are written by gen-vectors.ts and gen-vectors-groups.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8, type Bytes } from '../src/bytes.ts';
import { base64urlDecode, base64urlEncode } from '../src/codec.ts';
import { envelopeSigningInput, sealBytes, serializeEnvelope, type SignedEnvelope } from '../src/envelope.ts';
import { deriveIdentityKeys, type IdentityKeys } from '../src/keys.ts';
import { encodeMsgPayload } from '../src/payload.ts';
import { createStickerPackEnvelope, stickerFileHash, type PackSticker } from '../src/sticker.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/vectors');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Bytes => new Uint8Array(Buffer.from(h, 'hex'));
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const NOTE =
  'Test vectors for docs/PROTOCOL.md (sticker packs). Binary values are lowercase hex unless the field name says otherwise. Secret keys here are test keys only. Users alice and bob are the ones of identity.json.';

const idv = JSON.parse(readFileSync(join(out, 'identity.json'), 'utf8'));
const K: Record<string, IdentityKeys> = {
  alice: deriveIdentityKeys(fromHex(idv.users.alice.seedHex)),
  bob: deriveIdentityKeys(fromHex(idv.users.bob.seedHex)),
};
const serverId = 'vxbbn4ruwvo3jpqh6s3xbp64fi';
const packId = 'mfrggzdfmztwq2lknnwg23tpoa';

// Two tiny files (the bytes only need to be fixed; the server sniffs the first bytes).
const webp = utf8('RIFF\u0010\u0000\u0000\u0000WEBPVP8 test sticker one');
const tgs = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, ...utf8('test sticker two')]);
const files = [
  { name: 'webp', bytesHex: hex(webp), hash32: stickerFileHash(webp) },
  { name: 'tgs', bytesHex: hex(tgs), hash32: stickerFileHash(tgs) },
];
const stickers: PackSticker[] = [
  { file: files[0]!.hash32, type: 'webp', size: webp.length, emoji: '😺', w: 512, h: 512 },
  { file: files[1]!.hash32, type: 'tgs', size: tgs.length, emoji: '🎉', w: 512, h: 512 },
];
const manifest = createStickerPackEnvelope(K.alice!, { packId, serverId, name: 'Котики', created: 1767225600000, stickers });
const payloadBytes = base64urlDecode(manifest.payload);

/** A manifest with the given payload text signed by `keys` (for the negative cases). */
function signed(keys: IdentityKeys, payload: unknown): SignedEnvelope {
  return sealBytes('sticker-pack', utf8(JSON.stringify(payload)), keys);
}
const base = JSON.parse(text(payloadBytes));
const negative = [
  { name: 'payload changed after signing', envelope: serializeEnvelope({ payload: base64urlEncode(utf8(text(payloadBytes).replace('Котики', 'Собачки'))), sig: manifest.sig }), expectedError: 'bad-signature' },
  { name: 'signed by bob, author alice', envelope: serializeEnvelope(signed(K.bob!, base)), expectedError: 'bad-signature' },
  { name: 'author is not the signer', envelope: serializeEnvelope(signed(K.bob!, { ...base, author: K.bob!.userId })), expectedError: 'user-id-mismatch' },
  { name: 'another server', envelope: serializeEnvelope(signed(K.alice!, { ...base, serverId: 'another-server' })), expectedError: 'wrong-server' },
  { name: 'file name is not a hash32', envelope: serializeEnvelope(signed(K.alice!, { ...base, stickers: [{ ...stickers[0], file: 'not-a-hash' }] })), expectedError: 'malformed' },
  { name: 'unknown sticker type', envelope: serializeEnvelope(signed(K.alice!, { ...base, stickers: [{ ...stickers[0], type: 'svg' }] })), expectedError: 'malformed' },
  { name: 'tgs larger than allowed', envelope: serializeEnvelope(signed(K.alice!, { ...base, stickers: [{ ...stickers[1], size: 128 * 1024 + 1 }] })), expectedError: 'malformed' },
  { name: 'the same file twice', envelope: serializeEnvelope(signed(K.alice!, { ...base, stickers: [stickers[0], stickers[0]] })), expectedError: 'malformed' },
  { name: 'no stickers', envelope: serializeEnvelope(signed(K.alice!, { ...base, stickers: [] })), expectedError: 'malformed' },
  { name: 'version 2', envelope: serializeEnvelope(signed(K.alice!, { ...base, v: 2 })), expectedError: 'unsupported-version' },
  { name: 'signed as a profile', envelope: serializeEnvelope({ payload: manifest.payload, sig: sealBytes('profile', payloadBytes, K.alice!).sig }), expectedError: 'bad-signature' },
];

const MSG_ID = 'aebagbafaydqqcikbmga2dqpca';
const DEV_ID = 'mfrggzdfmztwq2lk';
const sticker = { pack: packId, file: stickers[0]!.file, type: 'webp' as const, w: 512, h: 512 };
const msg = text(encodeMsgPayload({ id: MSG_ID, dev: DEV_ID, seq: 9, body: '😺', sticker }));
const badMessages = [
  { name: 'sticker without the emoji body', text: JSON.stringify({ v: 1, t: 'msg', id: MSG_ID, dev: DEV_ID, seq: 9, sticker }), expectedError: 'malformed' },
  { name: 'sticker with an attachment', text: msg.replace('"sticker"', `"location":{"lat":1,"lon":2,"accuracy":3},"sticker"`), expectedError: 'malformed' },
  { name: 'sticker file is not a hash32', text: msg.replace(stickers[0]!.file, 'x'), expectedError: 'malformed' },
  { name: 'body is text, not an emoji', text: msg.replace('"body":"😺"', `"body":"${'длинный текст'.repeat(2)}"`), expectedError: 'malformed' },
];

writeFileSync(
  join(out, 'stickers.json'),
  JSON.stringify(
    {
      note: NOTE,
      serverId,
      signer: 'alice',
      files,
      manifest: {
        envelope: serializeEnvelope(manifest),
        payloadText: text(payloadBytes),
        signingInputHex: hex(envelopeSigningInput('sticker-pack', payloadBytes)),
      },
      negativeManifests: negative,
      message: { text: msg, fallbackBody: '😺' },
      negativeMessages: badMessages,
    },
    null,
    2,
  ) + '\n',
);
