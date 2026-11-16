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

// ---- groups ----

/** Random nonce mixed into a group id, in bytes. */
export const GROUP_NONCE_BYTES = 16;
/** Group chat id: base32 of 16 bytes, like a direct chat id. */
export const CHAT_ID_BYTES = 16;
export const CHAT_ID_LENGTH = 26;
/** Epoch secret, in bytes. */
export const EPOCH_SECRET_BYTES = 32;
/** First epoch of a group (direct chats always stay at DM_EPOCH). */
export const FIRST_GROUP_EPOCH = 0;
/** First version of a group state. */
export const FIRST_STATE_VERSION = 1;
/** Members of one group. */
export const MAX_GROUP_MEMBERS = 100;
/** Group state payload (exact signed JSON bytes). */
export const MAX_STATE_PAYLOAD_BYTES = 65536;
/** Encrypted group state as stored by the server. */
export const MAX_STATE_BLOB_BYTES = 131072;

// ---- attachments ----

/** Part size of every attachment (the only allowed value of `partSize`). */
export const BLOB_PART_SIZE = 4 * 1024 * 1024;
export const ALLOWED_PART_SIZES: readonly number[] = [BLOB_PART_SIZE];
/** Blob id: base32 of 16 random bytes. */
export const BLOB_ID_BYTES = 16;
/** Hard upper bound of an attachment size; the server limit (`maxFileMB`) is usually lower. */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** Inline thumbnail (JPEG bytes before base64url). */
export const MAX_THUMB_BYTES = 4096;
/** Voice waveform: exactly this many peaks, each 0..255. */
export const VOICE_PEAKS = 64;
/** File name of an attachment, in Unicode code points and UTF-8 bytes. */
export const MAX_FILE_NAME_CHARS = 128;
export const MAX_FILE_NAME_BYTES = 255;

// ---- archive ----

/** Archive plaintext is encrypted in blocks of this size. */
export const ARCHIVE_BLOCK_SIZE = 1024 * 1024;
/** Largest single archive record (split bigger data into several records). */
export const MAX_ARCHIVE_RECORD_BYTES = 16 * 1024 * 1024;

// ---- sticker packs (the other limits are in sticker.ts) ----

/** Largest `sticker-pack` envelope payload (exact signed JSON bytes). */
export const MAX_PACK_PAYLOAD_BYTES = 65536;
