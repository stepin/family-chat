// @family-chat/protocol: identity, direct-chat keys, signed envelopes and encrypted events.
// Pure TypeScript, no I/O. Specification: docs/PROTOCOL.md. Not independently audited.

export * from './constants.ts';
export { ProtocolError, isProtocolError } from './errors.ts';
export type { ProtocolErrorCode } from './errors.ts';

export { base64urlEncode, base64urlDecode, base32Encode, base32Decode } from './codec.ts';
export { randomBytes, newSeed, newDevId, newMessageId } from './random.ts';

export { seedToPhrase, phraseToSeed, isValidPhrase } from './phrase.ts';
export { deriveIdentityKeys, userIdFromSignPub } from './keys.ts';
export type { IdentityKeys } from './keys.ts';
export { fingerprint } from './fingerprint.ts';

export {
  createIdentityEnvelope,
  verifyIdentityEnvelope,
  createProfileEnvelope,
  verifyProfileEnvelope,
  createAuthEnvelope,
  verifyAuthEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from './envelope.ts';
export type {
  SignedEnvelope,
  EnvelopeKind,
  Identity,
  Profile,
  Avatar,
  ProfileInput,
  AuthInput,
  AuthRequest,
} from './envelope.ts';

export { deriveDmKeys, dmChatId } from './dm.ts';
export type { ChatKeys, DmKeys } from './dm.ts';

export { encodeMsgPayload, decodePayload } from './payload.ts';
export type {
  MsgRef,
  MsgInput,
  MsgPayload,
  EditPayload,
  DeletePayload,
  ReactPayload,
  Payload,
  DecodedPayload,
} from './payload.ts';

export { encodeEvent, decodeEvent, MAX_PAYLOAD_BYTES } from './event.ts';
export type { EventContext, EncodeEventInput, DecodeEventInput, DecodedEvent } from './event.ts';
