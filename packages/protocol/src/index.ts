// @family-chat/protocol: identity, direct chats, groups, signed envelopes, encrypted events,
// attachments and the archive file.
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
  createRevocationEnvelope,
  verifyRevocationEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from './envelope.ts';
export type {
  SignedEnvelope,
  EnvelopeKind,
  Identity,
  Profile,
  Avatar,
  AvatarRef,
  AvatarType,
  Revocation,
  ProfileInput,
  AuthInput,
  AuthRequest,
} from './envelope.ts';

export { deriveDmKeys, dmChatId } from './dm.ts';
export type { ChatKeys, DmKeys } from './dm.ts';

export {
  encodeMsgPayload,
  encodeEditPayload,
  encodeDeletePayload,
  encodeReactPayload,
  decodePayload,
  payloadCommon,
  parsePayload,
} from './payload.ts';
export type {
  MsgRef,
  MsgInput,
  EditInput,
  DeleteInput,
  ReactInput,
  Location,
  ParsedPayload,
  MsgPayload,
  EditPayload,
  DeletePayload,
  ReactPayload,
  Payload,
  DecodedPayload,
} from './payload.ts';

export { encodeEvent, decodeEvent, MAX_PAYLOAD_BYTES } from './event.ts';
export type { EventContext, EncodeEventInput, DecodeEventInput, DecodedEvent } from './event.ts';

export {
  newBlob,
  blobPartCount,
  blobPartLength,
  encryptBlobPart,
  decryptBlobPart,
  validateAttachment,
  checkAttachmentInput,
  IMAGE_TYPES,
  VOICE_TYPES,
} from './attachment.ts';
export type { Attachment, AttachmentKind, BlobRef } from './attachment.ts';

export {
  groupChatId,
  newGroupNonce,
  newEpochSecret,
  deriveGroupKeys,
  verifyGroupState,
  encryptGroupState,
  openGroupState,
  readGroupStateHeader,
} from './group.ts';
export type { GroupMember, GroupMemberInput, GroupTransfer, GroupState, GroupStateContext, StateBlobContext } from './group.ts';

export { sealGroupKey, openGroupKey, verifyGroupKey, readGroupKey, parseSealedGroupKey } from './group-key.ts';
export type { SealGroupKeyInput, GroupKeyHeader, OpenedGroupKey } from './group-key.ts';

export {
  createGroup,
  renameGroup,
  addGroupMembers,
  removeGroupMembers,
  transferGroupOwnership,
  acceptGroupKey,
  groupStateActions,
  compareGroupMembers,
} from './group-ops.ts';
export type {
  GroupChange,
  SealedGroupKey,
  CreateGroupInput,
  RenameGroupInput,
  AddGroupMembersInput,
  RemoveGroupMembersInput,
  TransferGroupOwnershipInput,
  GroupStateActions,
} from './group-ops.ts';

export { createArchiveWriter, createArchiveReader, readArchive, ARCHIVE_HEADER_BYTES } from './archive.ts';
export type { ArchiveWriter, ArchiveReader, ArchiveRecord, ArchiveKeySource } from './archive.ts';
