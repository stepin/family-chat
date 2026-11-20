//! Byte helpers, randomness and AES-256-GCM.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use subtle::ConstantTimeEq;

pub const GCM_NONCE_BYTES: usize = 12;
pub const GCM_TAG_BYTES: usize = 16;

pub fn u32be(n: u32) -> [u8; 4] {
    n.to_be_bytes()
}

/// Reads a big-endian u32; the caller has checked the length.
pub fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// Length-prefixed field: u32 big-endian length, then the bytes.
pub fn lp(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + b.len());
    out.extend_from_slice(&u32be(b.len() as u32));
    out.extend_from_slice(b);
    out
}

pub fn cat(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// Constant-time comparison.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub fn is_zero(b: &[u8]) -> bool {
    b.iter().fold(0u8, |acc, x| acc | x) == 0
}

/// Random bytes from the operating system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("operating system random number generator failed");
    buf
}

/// 96-bit nonce equal to a counter: 8 zero bytes, then u32 big-endian.
pub fn counter_nonce(n: u32) -> [u8; GCM_NONCE_BYTES] {
    let mut out = [0u8; GCM_NONCE_BYTES];
    out[8..].copy_from_slice(&u32be(n));
    out
}

/// AES-256-GCM: ciphertext followed by the 16-byte tag.
pub fn gcm_seal(key: &[u8; 32], nonce: &[u8; GCM_NONCE_BYTES], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let nonce = Nonce::try_from(&nonce[..]).expect("12-byte nonce");
    cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .expect("AES-GCM encryption of a bounded input")
}

/// AES-256-GCM decryption; `None` when authentication fails.
pub fn gcm_open(key: &[u8; 32], nonce: &[u8; GCM_NONCE_BYTES], aad: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    if ciphertext.len() < GCM_TAG_BYTES {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let nonce = Nonce::try_from(&nonce[..]).expect("12-byte nonce");
    cipher.decrypt(&nonce, Payload { msg: ciphertext, aad }).ok()
}
