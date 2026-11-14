// Protocol constants and limits (docs/PROTOCOL.md, section "Пределы").

/** Version of the envelope payloads (`v` field) and of the event payload format. */
export const PROTOCOL_VERSION = 1;

export const SEED_BYTES = 32;
export const PHRASE_WORDS = 24;

export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

/** userId: base32 of 16 bytes. */
export const USER_ID_BYTES = 16;
export const USER_ID_LENGTH = 26;
/** devId: base32 of 10 bytes. */
export const DEV_ID_BYTES = 10;
export const DEV_ID_LENGTH = 16;
/** Message id (also the Idempotency-Key header): base32 of 16 bytes. */
export const MESSAGE_ID_BYTES = 16;
export const MESSAGE_ID_LENGTH = 26;

/** Profile name, in Unicode code points. */
export const MAX_NAME_CHARS = 64;
/** Envelope payload, in bytes (before base64url). */
export const MAX_ENVELOPE_PAYLOAD_BYTES = 8192;
/** Auth challenge nonce and serverId / chatId strings, in UTF-8 bytes. */
export const MAX_CONTEXT_STRING_BYTES = 256;

/** Message body (Markdown), in UTF-8 bytes. */
export const MAX_BODY_BYTES = 16384;
/** Whole encoded event (what the server stores), in bytes. */
export const MAX_EVENT_BYTES = 262144;
/** Event plaintext is zero-padded to a multiple of this. */
export const EVENT_PADDING_BLOCK = 256;
/** Epoch of every direct chat. */
export const DM_EPOCH = 0;
