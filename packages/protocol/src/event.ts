// Encrypted, signed events (docs/PROTOCOL.md, section "События").
//
// body      = header(40) || nonce(12) || AES-256-GCM(encKey, nonce, plaintext, AAD) (ciphertext || tag(16))
// header    = "FC1" || 0x01 || epoch u32 || serverTag(8) || chatTag(8) || msgId(16)
// AAD       = header || lp(serverId) || lp(chatId)
// plaintext = senderId(16) || sig(64) || u32 len || payload || zeros up to a multiple of 256
// sig       = Ed25519("fc/v1/event\n" || lp(serverId) || lp(chatId) || u32 epoch
//                     || lp(msgId) || lp(senderId) || lp(payload))

import { concat, copy, equalBytes, isAllZero, lp, readU32be, u32be, utf8, type Bytes } from './bytes.ts';
import { base32DecodeExact, base32Encode } from './codec.ts';
import {
  EVENT_PADDING_BLOCK,
  MAX_EVENT_BYTES,
  MESSAGE_ID_BYTES,
  SIGNATURE_BYTES,
  USER_ID_BYTES,
} from './constants.ts';
import type { ChatKeys } from './dm.ts';
import type { Identity } from './envelope.ts';
import { malformed, ProtocolError } from './errors.ts';
import { checkContextString } from './json.ts';
import { sha256Bytes, sign, verify, type IdentityKeys } from './keys.ts';
import { decodePayload, payloadCommon, type DecodedPayload } from './payload.ts';

export const EVENT_MAGIC = utf8('FC1');
export const EVENT_FORMAT = 0x01;
export const LABEL_EVENT = 'fc/v1/event\n';
export const LABEL_SERVER_TAG = 'fc/v1/server-tag\n';
export const LABEL_CHAT_TAG = 'fc/v1/chat-tag\n';

export const HEADER_BYTES = 40;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const PREFIX_BYTES = USER_ID_BYTES + SIGNATURE_BYTES + 4; // senderId || sig || len
const OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;
/** Largest plaintext (multiple of the padding block) that keeps the event within the limit. */
const MAX_PLAINTEXT = Math.floor((MAX_EVENT_BYTES - OVERHEAD) / EVENT_PADDING_BLOCK) * EVENT_PADDING_BLOCK;
export const MAX_PAYLOAD_BYTES = MAX_PLAINTEXT - PREFIX_BYTES;

export interface EventContext {
  readonly serverId: string;
  readonly chatId: string;
  /** Epoch number and encryption key of the chat (from deriveDmKeys for direct chats). */
  readonly chat: ChatKeys;
}

export interface EncodeEventInput extends EventContext {
  readonly author: IdentityKeys;
  /** Payload bytes, for example from encodeMsgPayload. Its `id` becomes the event's message id. */
  readonly payload: Uint8Array;
}

export interface DecodeEventInput extends EventContext {
  /**
   * Returns the verified identity of a chat member, or undefined if the user is unknown or
   * not a member of this chat. Only members may author events.
   */
  readonly lookupAuthor: (userId: string) => Identity | undefined;
  /** Sender reported by the server for this event; when given, it must match the signed author. */
  readonly expectedSender?: string;
}

export interface DecodedEvent {
  readonly senderId: string;
  readonly msgId: string;
  readonly epoch: number;
  readonly payload: DecodedPayload;
  /** The exact signed payload bytes (for storage or later re-verification). */
  readonly payloadBytes: Bytes;
}

export function serverTag(serverId: string): Bytes {
  return sha256Bytes(concat(utf8(LABEL_SERVER_TAG), lp(serverId))).subarray(0, 8);
}

export function chatTag(chatId: string): Bytes {
  return sha256Bytes(concat(utf8(LABEL_CHAT_TAG), lp(chatId))).subarray(0, 8);
}

function checkEpoch(epoch: unknown): number {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
    throw new ProtocolError('invalid-argument', 'epoch must be a u32');
  }
  return epoch;
}

function checkContext(ctx: EventContext): void {
  checkContextString(ctx.serverId, 'serverId', 'invalid-argument');
  checkContextString(ctx.chatId, 'chatId', 'invalid-argument');
  checkEpoch(ctx.chat.epoch);
  if (!(ctx.chat.encKey instanceof Uint8Array) || ctx.chat.encKey.length !== 32) {
    throw new ProtocolError('invalid-argument', 'encKey must be 32 bytes');
  }
}

export function eventHeader(ctx: EventContext, msgId: Uint8Array): Bytes {
  return concat(
    EVENT_MAGIC,
    Uint8Array.of(EVENT_FORMAT),
    u32be(ctx.chat.epoch),
    serverTag(ctx.serverId),
    chatTag(ctx.chatId),
    msgId,
  );
}

export function eventAad(header: Uint8Array, ctx: EventContext): Bytes {
  return concat(header, lp(ctx.serverId), lp(ctx.chatId));
}

export function eventSigningInput(
  ctx: EventContext,
  msgId: Uint8Array,
  senderId: Uint8Array,
  payload: Uint8Array,
): Bytes {
  return concat(
    utf8(LABEL_EVENT),
    lp(ctx.serverId),
    lp(ctx.chatId),
    u32be(ctx.chat.epoch),
    lp(msgId),
    lp(senderId),
    lp(payload),
  );
}

function importKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', copy(raw), { name: 'AES-GCM' }, false, [usage]);
}

/** Encode with a caller-chosen nonce. Internal: used for reproducible test vectors only. */
export async function encodeEventWithNonce(input: EncodeEventInput, nonce: Uint8Array): Promise<Bytes> {
  checkContext(input);
  if (nonce.length !== NONCE_BYTES) throw new ProtocolError('invalid-argument', 'nonce must be 12 bytes');
  const payload = copy(input.payload);
  if (payload.length > MAX_PAYLOAD_BYTES) throw new ProtocolError('too-large', 'event payload is too large');
  let decoded: DecodedPayload;
  try {
    decoded = decodePayload(payload);
  } catch (e) {
    throw new ProtocolError('invalid-argument', `payload is invalid: ${(e as Error).message}`);
  }
  const msgId = base32DecodeExact(payloadCommon(decoded).id, MESSAGE_ID_BYTES, 'id');
  const senderId = base32DecodeExact(input.author.userId, USER_ID_BYTES, 'author userId');

  const sig = sign(eventSigningInput(input, msgId, senderId, payload), input.author.signSecret);
  const used = PREFIX_BYTES + payload.length;
  const padded = Math.ceil(used / EVENT_PADDING_BLOCK) * EVENT_PADDING_BLOCK;
  const plaintext = new Uint8Array(padded);
  plaintext.set(concat(senderId, sig, u32be(payload.length), payload), 0);

  const header = eventHeader(input, msgId);
  const key = await importKey(input.chat.encKey, 'encrypt');
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copy(nonce), additionalData: eventAad(header, input), tagLength: 128 },
      key,
      plaintext,
    ),
  );
  return concat(header, nonce, ct);
}

/** Encrypt and sign an event. A fresh random 96-bit nonce is used every time. */
export async function encodeEvent(input: EncodeEventInput): Promise<Bytes> {
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  return encodeEventWithNonce(input, nonce);
}

/**
 * Decrypt and verify an event. Checks in order, each with its own error code:
 * size and layout (`malformed`), format byte (`unsupported-version`), epoch (`wrong-epoch`),
 * server (`wrong-server`), chat (`wrong-chat`), AES-GCM (`wrong-key`), plaintext layout and
 * zero padding (`malformed`), author lookup (`unknown-author`), server-reported sender
 * (`sender-mismatch`), signature (`bad-signature`), payload JSON and id (`malformed`).
 */
export async function decodeEvent(body: Uint8Array, input: DecodeEventInput): Promise<DecodedEvent> {
  checkContext(input);
  if (!(body instanceof Uint8Array)) throw malformed('event: not bytes');
  if (body.length > MAX_EVENT_BYTES) throw new ProtocolError('too-large', 'event exceeds the size limit');
  if (body.length < OVERHEAD + EVENT_PADDING_BLOCK || (body.length - OVERHEAD) % EVENT_PADDING_BLOCK !== 0) {
    throw malformed('event: invalid length');
  }
  if (!equalBytes(body.subarray(0, 3), EVENT_MAGIC)) throw malformed('event: bad magic');
  if (body[3] !== EVENT_FORMAT) throw new ProtocolError('unsupported-version', 'event format is not supported');
  const header = copy(body.subarray(0, HEADER_BYTES));
  if (readU32be(header, 4) !== input.chat.epoch) throw new ProtocolError('wrong-epoch', 'event belongs to another epoch');
  if (!equalBytes(header.subarray(8, 16), serverTag(input.serverId))) {
    throw new ProtocolError('wrong-server', 'event belongs to another server');
  }
  if (!equalBytes(header.subarray(16, 24), chatTag(input.chatId))) {
    throw new ProtocolError('wrong-chat', 'event belongs to another chat');
  }
  const msgIdBytes = header.subarray(24, 40);
  const nonce = copy(body.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES));
  const ct = copy(body.subarray(HEADER_BYTES + NONCE_BYTES));

  let plaintext: Bytes;
  try {
    const key = await importKey(input.chat.encKey, 'decrypt');
    plaintext = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: eventAad(header, input), tagLength: 128 },
        key,
        ct,
      ),
    );
  } catch {
    throw new ProtocolError('wrong-key', 'event does not decrypt with this chat key');
  }

  const senderIdBytes = plaintext.subarray(0, USER_ID_BYTES);
  const sig = plaintext.subarray(USER_ID_BYTES, USER_ID_BYTES + SIGNATURE_BYTES);
  const len = readU32be(plaintext, USER_ID_BYTES + SIGNATURE_BYTES);
  if (len > plaintext.length - PREFIX_BYTES) throw malformed('event: payload length exceeds plaintext');
  const payloadBytes = copy(plaintext.subarray(PREFIX_BYTES, PREFIX_BYTES + len));
  const used = PREFIX_BYTES + len;
  // The padding must be minimal and all zero: one plaintext, one encoding.
  if (Math.ceil(used / EVENT_PADDING_BLOCK) * EVENT_PADDING_BLOCK !== plaintext.length) {
    throw malformed('event: padding is not minimal');
  }
  if (!isAllZero(plaintext.subarray(used))) throw malformed('event: padding is not zero');

  const senderId = base32Encode(senderIdBytes);
  const author = input.lookupAuthor(senderId);
  if (!author || author.userId !== senderId) {
    throw new ProtocolError('unknown-author', 'event author is not a known member of this chat');
  }
  if (input.expectedSender !== undefined && input.expectedSender !== senderId) {
    throw new ProtocolError('sender-mismatch', 'event author differs from the sender reported by the server');
  }
  if (!verify(sig, eventSigningInput(input, msgIdBytes, senderIdBytes, payloadBytes), author.signPub)) {
    throw new ProtocolError('bad-signature', 'event signature does not verify');
  }

  const payload = decodePayload(payloadBytes);
  const msgId = base32Encode(msgIdBytes);
  const payloadId = payloadCommon(payload).id;
  if (payloadId !== msgId) throw malformed('event: payload id differs from the header message id');
  return { senderId, msgId, epoch: input.chat.epoch, payload, payloadBytes };
}
