//! Encrypted, signed events (docs/PROTOCOL.md, section 6).
//!
//! ```text
//! body      = header(40) || nonce(12) || AES-256-GCM(encKey, nonce, plaintext, AAD)
//! header    = "FC1" || 0x01 || epoch u32 || serverTag(8) || chatTag(8) || msgId(16)
//! AAD       = header || lp(serverId) || lp(chatId)
//! plaintext = senderId(16) || sig(64) || u32 len || payload || zeros to a multiple of 256
//! sig       = Ed25519("fc/v1/event\n" || lp(serverId) || lp(chatId) || u32 epoch
//!                     || lp(msgId) || lp(senderId) || lp(payload))
//! ```

use super::bytes::{
    GCM_NONCE_BYTES, GCM_TAG_BYTES, cat, ct_eq, gcm_open, gcm_seal, is_zero, lp, random, read_u32, u32be,
};
use super::dm::ChatKeys;
use super::error::{Code, Result, err, invalid, malformed};
use super::json::context_string_ok;
use super::keys::{IdentityKeys, sha256, verify};
use super::payload::{Payload, parse_payload};
use crate::ids::{MsgId, UserId};

pub const MAX_EVENT_BYTES: usize = 262144;
pub const PADDING_BLOCK: usize = 256;
pub const HEADER_BYTES: usize = 40;
const MAGIC: &[u8; 3] = b"FC1";
const FORMAT: u8 = 0x01;
const LABEL_EVENT: &[u8] = b"fc/v1/event\n";
const LABEL_SERVER_TAG: &[u8] = b"fc/v1/server-tag\n";
const LABEL_CHAT_TAG: &[u8] = b"fc/v1/chat-tag\n";
/// senderId || sig || len
const PREFIX_BYTES: usize = 16 + 64 + 4;
const OVERHEAD: usize = HEADER_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES;
/// Largest payload that keeps the event within the size limit.
pub const MAX_PAYLOAD_BYTES: usize = (MAX_EVENT_BYTES - OVERHEAD) / PADDING_BLOCK * PADDING_BLOCK - PREFIX_BYTES;

/// What an event is bound to: the server, the chat and the keys of its epoch.
pub struct EventContext<'a> {
    pub server_id: &'a str,
    /// The chat id as text (26 characters of base32).
    pub chat_id: &'a str,
    pub chat: &'a ChatKeys,
}

pub struct DecodedEvent {
    pub sender: UserId,
    pub msg_id: MsgId,
    pub epoch: u32,
    pub payload: Payload,
    /// The exact signed payload bytes.
    pub payload_bytes: Vec<u8>,
}

pub fn server_tag(server_id: &str) -> [u8; 8] {
    let h = sha256(&cat(&[LABEL_SERVER_TAG, &lp(server_id.as_bytes())]));
    h[..8].try_into().expect("8 bytes")
}

pub fn chat_tag(chat_id: &str) -> [u8; 8] {
    let h = sha256(&cat(&[LABEL_CHAT_TAG, &lp(chat_id.as_bytes())]));
    h[..8].try_into().expect("8 bytes")
}

fn check_context(ctx: &EventContext<'_>) -> Result<()> {
    if !context_string_ok(ctx.server_id) || !context_string_ok(ctx.chat_id) {
        return Err(invalid("serverId and chatId must be strings of 1 to 256 bytes"));
    }
    Ok(())
}

pub fn header(ctx: &EventContext<'_>, msg_id: &[u8; 16]) -> Vec<u8> {
    cat(&[
        MAGIC,
        &[FORMAT],
        &u32be(ctx.chat.epoch),
        &server_tag(ctx.server_id),
        &chat_tag(ctx.chat_id),
        msg_id,
    ])
}

pub fn aad(header: &[u8], ctx: &EventContext<'_>) -> Vec<u8> {
    cat(&[header, &lp(ctx.server_id.as_bytes()), &lp(ctx.chat_id.as_bytes())])
}

pub fn signing_input(ctx: &EventContext<'_>, msg_id: &[u8; 16], sender: &[u8; 16], payload: &[u8]) -> Vec<u8> {
    cat(&[
        LABEL_EVENT,
        &lp(ctx.server_id.as_bytes()),
        &lp(ctx.chat_id.as_bytes()),
        &u32be(ctx.chat.epoch),
        &lp(msg_id),
        &lp(sender),
        &lp(payload),
    ])
}

/// Encodes with a caller-chosen nonce (test vectors only).
pub fn encode_event_with_nonce(
    ctx: &EventContext<'_>,
    author: &IdentityKeys,
    payload: &[u8],
    nonce: &[u8; GCM_NONCE_BYTES],
) -> Result<Vec<u8>> {
    check_context(ctx)?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(err(Code::TooLarge, "event payload is too large"));
    }
    let decoded = parse_payload(payload).map_err(|e| invalid(format!("payload is invalid: {}", e.message)))?;
    let msg_id = decoded.id().0;
    let sender = author.user_id.0;
    let sig = author.sign(&signing_input(ctx, &msg_id, &sender, payload));

    let used = PREFIX_BYTES + payload.len();
    let mut plaintext = vec![0u8; used.div_ceil(PADDING_BLOCK) * PADDING_BLOCK];
    plaintext[..16].copy_from_slice(&sender);
    plaintext[16..80].copy_from_slice(&sig);
    plaintext[80..84].copy_from_slice(&u32be(payload.len() as u32));
    plaintext[84..used].copy_from_slice(payload);

    let header = header(ctx, &msg_id);
    let ct = gcm_seal(&ctx.chat.enc_key, nonce, &aad(&header, ctx), &plaintext);
    Ok(cat(&[&header, nonce, &ct]))
}

/// Encrypts and signs an event with a fresh random 96-bit nonce.
pub fn encode_event(ctx: &EventContext<'_>, author: &IdentityKeys, payload: &[u8]) -> Result<Vec<u8>> {
    encode_event_with_nonce(ctx, author, payload, &random::<GCM_NONCE_BYTES>())
}

/// Decrypts and checks an event, in the order of section 6.5, each check
/// with its own code. `lookup_author` returns the signing key of a member of
/// this chat (only members may author events); `expected_sender` is the
/// sender the server recorded.
pub fn decode_event(
    body: &[u8],
    ctx: &EventContext<'_>,
    lookup_author: &dyn Fn(&UserId) -> Option<[u8; 32]>,
    expected_sender: Option<&UserId>,
) -> Result<DecodedEvent> {
    check_context(ctx)?;
    if body.len() > MAX_EVENT_BYTES {
        return Err(err(Code::TooLarge, "event exceeds the size limit"));
    }
    if body.len() < OVERHEAD + PADDING_BLOCK || !(body.len() - OVERHEAD).is_multiple_of(PADDING_BLOCK) {
        return Err(malformed("event: invalid length"));
    }
    if &body[..3] != MAGIC {
        return Err(malformed("event: bad magic"));
    }
    if body[3] != FORMAT {
        return Err(err(Code::UnsupportedVersion, "event format is not supported"));
    }
    let header = &body[..HEADER_BYTES];
    if read_u32(header, 4) != ctx.chat.epoch {
        return Err(err(Code::WrongEpoch, "event belongs to another epoch"));
    }
    if !ct_eq(&header[8..16], &server_tag(ctx.server_id)) {
        return Err(err(Code::WrongServer, "event belongs to another server"));
    }
    if !ct_eq(&header[16..24], &chat_tag(ctx.chat_id)) {
        return Err(err(Code::WrongChat, "event belongs to another chat"));
    }
    let msg_id: [u8; 16] = header[24..40].try_into().expect("16 bytes");
    let nonce: [u8; GCM_NONCE_BYTES] = body[HEADER_BYTES..HEADER_BYTES + GCM_NONCE_BYTES]
        .try_into()
        .expect("12 bytes");
    let plaintext = gcm_open(
        &ctx.chat.enc_key,
        &nonce,
        &aad(header, ctx),
        &body[HEADER_BYTES + GCM_NONCE_BYTES..],
    )
    .ok_or_else(|| err(Code::WrongKey, "event does not decrypt with this chat key"))?;

    let sender: [u8; 16] = plaintext[..16].try_into().expect("16 bytes");
    let sig = &plaintext[16..80];
    let len = read_u32(&plaintext, 80) as usize;
    if len > plaintext.len() - PREFIX_BYTES {
        return Err(malformed("event: payload length exceeds plaintext"));
    }
    let used = PREFIX_BYTES + len;
    // The padding is minimal and all zero: one plaintext, one encoding.
    if used.div_ceil(PADDING_BLOCK) * PADDING_BLOCK != plaintext.len() {
        return Err(malformed("event: padding is not minimal"));
    }
    if !is_zero(&plaintext[used..]) {
        return Err(malformed("event: padding is not zero"));
    }
    let payload_bytes = plaintext[PREFIX_BYTES..used].to_vec();

    let sender_id = UserId(sender);
    let sign_pub = lookup_author(&sender_id)
        .ok_or_else(|| err(Code::UnknownAuthor, "event author is not a known member of this chat"))?;
    if expected_sender.is_some_and(|e| *e != sender_id) {
        return Err(err(
            Code::SenderMismatch,
            "event author differs from the sender reported by the server",
        ));
    }
    if !verify(sig, &signing_input(ctx, &msg_id, &sender, &payload_bytes), &sign_pub) {
        return Err(err(Code::BadSignature, "event signature does not verify"));
    }
    let payload = parse_payload(&payload_bytes)?;
    if payload.id().0 != msg_id {
        return Err(malformed("event: payload id differs from the header message id"));
    }
    Ok(DecodedEvent {
        sender: sender_id,
        msg_id: MsgId(msg_id),
        epoch: ctx.chat.epoch,
        payload,
        payload_bytes,
    })
}
