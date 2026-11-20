//! HPKE (RFC 9180), base mode, single shot: KEM DHKEM(X25519, HKDF-SHA256)
//! (0x0020), KDF HKDF-SHA256 (0x0001), AEAD AES-256-GCM (0x0002). Used to
//! seal a group's epoch secret to a member (docs/PROTOCOL.md, section 15).

use hkdf::Hkdf;
use sha2::Sha256;

use super::bytes::{GCM_NONCE_BYTES, cat, gcm_open, gcm_seal, random};
use super::error::{Code, Result, err};
use super::keys::{x25519, x25519_public};

pub const ENC_BYTES: usize = 32;
const VERSION_LABEL: &[u8] = b"HPKE-v1";
/// "KEM" || I2OSP(0x0020, 2)
const KEM_SUITE: &[u8] = b"KEM\x00\x20";
/// "HPKE" || I2OSP(0x0020, 2) || I2OSP(0x0001, 2) || I2OSP(0x0002, 2)
const HPKE_SUITE: &[u8] = b"HPKE\x00\x20\x00\x01\x00\x02";

fn labeled_extract(suite: &[u8], salt: &[u8], label: &[u8], ikm: &[u8]) -> [u8; 32] {
    let (prk, _) = Hkdf::<Sha256>::extract(Some(salt), &cat(&[VERSION_LABEL, suite, label, ikm]));
    prk.into()
}

fn labeled_expand<const N: usize>(suite: &[u8], prk: &[u8; 32], label: &[u8], info: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    let full = cat(&[&(N as u16).to_be_bytes(), VERSION_LABEL, suite, label, info]);
    Hkdf::<Sha256>::from_prk(prk)
        .expect("a 32-byte PRK")
        .expand(&full, &mut out)
        .expect("a short HKDF output");
    out
}

/// `DeriveKeyPair(ikm)` of DHKEM(X25519, HKDF-SHA256): (secret key, public key).
pub fn derive_key_pair(ikm: &[u8]) -> ([u8; 32], [u8; 32]) {
    let prk = labeled_extract(KEM_SUITE, &[], b"dkp_prk", ikm);
    let sk: [u8; 32] = labeled_expand(KEM_SUITE, &prk, b"sk", &[]);
    (sk, x25519_public(&sk))
}

fn extract_and_expand(dh: &[u8; 32], kem_context: &[u8]) -> [u8; 32] {
    let prk = labeled_extract(KEM_SUITE, &[], b"eae_prk", dh);
    labeled_expand(KEM_SUITE, &prk, b"shared_secret", kem_context)
}

/// Key and nonce of sequence number 0 (all that a single-shot seal uses).
fn key_schedule(shared_secret: &[u8; 32], info: &[u8]) -> ([u8; 32], [u8; GCM_NONCE_BYTES]) {
    let psk_id_hash = labeled_extract(HPKE_SUITE, &[], b"psk_id_hash", &[]);
    let info_hash = labeled_extract(HPKE_SUITE, &[], b"info_hash", info);
    // mode_base = 0x00
    let context = cat(&[&[0u8], &psk_id_hash, &info_hash]);
    let secret = labeled_extract(HPKE_SUITE, shared_secret, b"secret", &[]);
    (
        labeled_expand(HPKE_SUITE, &secret, b"key", &context),
        labeled_expand(HPKE_SUITE, &secret, b"base_nonce", &context),
    )
}

/// Single-shot Seal with a caller-chosen ephemeral seed (test vectors and the builders).
/// Returns `(enc, ciphertext)`.
pub fn seal_with(
    pk_r: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
    ikm_e: &[u8; 32],
) -> Result<([u8; ENC_BYTES], Vec<u8>)> {
    let (sk_e, enc) = derive_key_pair(ikm_e);
    let dh = x25519(&sk_e, pk_r)?;
    let shared = extract_and_expand(&dh, &cat(&[&enc, pk_r]));
    let (key, nonce) = key_schedule(&shared, info);
    Ok((enc, gcm_seal(&key, &nonce, aad, plaintext)))
}

/// Single-shot Seal; the ephemeral key comes from 32 random bytes.
pub fn seal(pk_r: &[u8; 32], info: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<([u8; ENC_BYTES], Vec<u8>)> {
    seal_with(pk_r, info, aad, plaintext, &random::<32>())
}

/// Single-shot Open. `wrong-key` when the ciphertext does not open.
pub fn open(enc: &[u8; ENC_BYTES], sk_r: &[u8; 32], info: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let dh = x25519(sk_r, enc)?;
    let shared = extract_and_expand(&dh, &cat(&[enc, &x25519_public(sk_r)]));
    let (key, nonce) = key_schedule(&shared, info);
    gcm_open(&key, &nonce, aad, ciphertext).ok_or_else(|| {
        err(
            Code::WrongKey,
            "HPKE ciphertext does not open with this key and context",
        )
    })
}
