//! Attachment parts (docs/PROTOCOL.md, section 16):
//!
//! ```text
//! part i = AES-256-GCM(key, nonce = 00×8 || u32(i), plaintext_i,
//!                      AAD = "fc/v1/blob\n" || lp(blobId, raw 16 bytes) || u32(i) || u32(parts))
//! ```
//!
//! One part at a time, so a whole file is never in memory.

use super::bytes::{GCM_TAG_BYTES, cat, counter_nonce, gcm_open, gcm_seal, lp, random, u32be};
use super::error::{Code, Result, err, invalid, malformed};
use super::payload::{BLOB_PART_SIZE, BlobRef, MAX_ATTACHMENT_BYTES, blob_part_count};
use crate::ids::BlobId;

const LABEL_BLOB: &[u8] = b"fc/v1/blob\n";

/// A new blob reference for a file of `size` bytes: random id and key.
pub fn new_blob(size: u64, max_size: Option<u64>) -> Result<BlobRef> {
    if size > max_size.unwrap_or(MAX_ATTACHMENT_BYTES).min(MAX_ATTACHMENT_BYTES) {
        return Err(invalid("blob size is out of range"));
    }
    Ok(BlobRef {
        id: BlobId(random::<16>()),
        key: random::<32>(),
        parts: blob_part_count(size, BLOB_PART_SIZE) as u32,
        part_size: BLOB_PART_SIZE,
        size,
    })
}

/// Plaintext length of part `index`.
pub fn part_length(blob: &BlobRef, index: u32) -> Result<u64> {
    if index >= blob.parts {
        return Err(invalid("part index is out of range"));
    }
    Ok(if index < blob.parts - 1 {
        blob.part_size
    } else {
        blob.size - u64::from(blob.parts - 1) * blob.part_size
    })
}

pub fn part_aad(id: &BlobId, index: u32, parts: u32) -> Vec<u8> {
    cat(&[LABEL_BLOB, &lp(&id.0), &u32be(index), &u32be(parts)])
}

/// Encrypts one part; its plaintext must have exactly the part's length.
pub fn encrypt_part(blob: &BlobRef, index: u32, plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.len() as u64 != part_length(blob, index)? {
        return Err(invalid("part plaintext has the wrong length"));
    }
    Ok(gcm_seal(
        &blob.key,
        &counter_nonce(index),
        &part_aad(&blob.id, index, blob.parts),
        plaintext,
    ))
}

/// Decrypts one part. A wrong length is `malformed` (a truncated part); a
/// failed tag is `wrong-key` (altered bytes, another part or another file).
pub fn decrypt_part(blob: &BlobRef, index: u32, ciphertext: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.len() as u64 != part_length(blob, index)? + GCM_TAG_BYTES as u64 {
        return Err(malformed("blob part: length does not match the descriptor"));
    }
    gcm_open(
        &blob.key,
        &counter_nonce(index),
        &part_aad(&blob.id, index, blob.parts),
        ciphertext,
    )
    .ok_or_else(|| {
        err(
            Code::WrongKey,
            "blob part does not decrypt (altered, reordered or foreign part)",
        )
    })
}
