//! Identity keys (docs/PROTOCOL.md, section 3): the seed, the recovery
//! phrase, key derivation, signatures, X25519 and the fingerprint.

use std::fmt;
use std::sync::OnceLock;

use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::bytes::{cat, is_zero, lp};
use super::error::{Code, ProtoError, Result, err};
use crate::ids::UserId;

pub const SEED_BYTES: usize = 32;
pub const PHRASE_WORDS: usize = 24;

const LABEL_SIGN: &[u8] = b"fc/v1/sign";
const LABEL_BOX: &[u8] = b"fc/v1/box";
const LABEL_SELF: &[u8] = b"fc/v1/self";
const LABEL_FINGERPRINT: &[u8] = b"fc/v1/fingerprint\n";

/// HKDF-SHA-256 with an empty salt, 32 bytes of output.
pub fn hkdf32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, &mut out)
        .expect("32 bytes is a valid HKDF-SHA-256 output length");
    out
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Secret and public keys of one identity. Holds secrets: never logged.
#[derive(Clone)]
pub struct IdentityKeys {
    pub user_id: UserId,
    pub sign_pub: [u8; 32],
    pub box_pub: [u8; 32],
    sign: SigningKey,
    box_secret: [u8; 32],
    /// Key of the archive format (section 17); kept for completeness.
    self_key: [u8; 32],
}

impl fmt::Debug for IdentityKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "IdentityKeys({})", self.user_id)
    }
}

impl IdentityKeys {
    pub fn from_seed(seed: &[u8; SEED_BYTES]) -> IdentityKeys {
        let sign = SigningKey::from_bytes(&hkdf32(seed, LABEL_SIGN));
        let box_secret = hkdf32(seed, LABEL_BOX);
        let sign_pub = sign.verifying_key().to_bytes();
        IdentityKeys {
            user_id: UserId::from_sign_pub(&sign_pub),
            sign_pub,
            box_pub: x25519_public(&box_secret),
            sign,
            box_secret,
            self_key: hkdf32(seed, LABEL_SELF),
        }
    }

    /// Ed25519 signature (RFC 8032, deterministic).
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.sign.sign(message).to_bytes()
    }

    pub fn box_secret(&self) -> &[u8; 32] {
        &self.box_secret
    }

    pub fn self_key(&self) -> &[u8; 32] {
        &self.self_key
    }

    /// The Ed25519 secret in seed form (test vectors compare it).
    pub fn sign_secret(&self) -> [u8; 32] {
        self.sign.to_bytes()
    }
}

/// Ed25519 verification by the strict rules (no ZIP-215 leniency).
pub fn verify(signature: &[u8], message: &[u8], sign_pub: &[u8; 32]) -> bool {
    let Ok(sig) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(sign_pub) else {
        return false;
    };
    key.verify_strict(message, &Signature::from_bytes(&sig)).is_ok()
}

/// `invalid-key` unless `sign_pub` is an Ed25519 point of large order.
pub fn check_sign_pub(sign_pub: &[u8; 32]) -> Result<()> {
    match VerifyingKey::from_bytes(sign_pub) {
        Ok(k) if !k.is_weak() => Ok(()),
        _ => Err(err(Code::InvalidKey, "signPub is not a valid Ed25519 public key")),
    }
}

pub fn x25519_public(secret: &[u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(*secret).to_bytes()
}

/// X25519; the all-zero result (a low-order peer key) is `invalid-key`.
pub fn x25519(secret: &[u8; 32], public: &[u8; 32]) -> Result<[u8; 32]> {
    let shared = MontgomeryPoint(*public).mul_clamped(*secret).to_bytes();
    if is_zero(&shared) {
        return Err(err(Code::InvalidKey, "X25519 shared secret is all zero"));
    }
    Ok(shared)
}

/// 30 decimal digits in 6 groups of 5, for comparing a person's keys by hand.
pub fn fingerprint(sign_pub: &[u8; 32], box_pub: &[u8; 32]) -> String {
    let h = sha256(&cat(&[LABEL_FINGERPRINT, &lp(sign_pub), &lp(box_pub)]));
    (0..6)
        .map(|g| {
            let n = h[g * 5..g * 5 + 5].iter().fold(0u64, |n, b| n * 256 + u64::from(*b));
            format!("{:05}", n % 100_000)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- recovery phrase (BIP39, English, the seed itself as entropy) ----

const WORDLIST: &str = include_str!("bip39-english.txt");

fn words() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| WORDLIST.lines().collect())
}

/// The bytes of the embedded word list (a test compares their hash with the document).
pub fn wordlist_bytes() -> &'static [u8] {
    WORDLIST.as_bytes()
}

/// Seed to the 24-word phrase, words separated by single spaces.
pub fn seed_to_phrase(seed: &[u8; SEED_BYTES]) -> String {
    let mut bits = seed.to_vec();
    bits.push(sha256(seed)[0]);
    let list = words();
    (0..PHRASE_WORDS)
        .map(|i| list[index_at(&bits, i)])
        .collect::<Vec<_>>()
        .join(" ")
}

/// The 11-bit group `i` of a 33-byte string, most significant bit first.
fn index_at(bits: &[u8], i: usize) -> usize {
    let mut n = 0usize;
    for b in i * 11..i * 11 + 11 {
        n = (n << 1) | usize::from((bits[b / 8] >> (7 - b % 8)) & 1);
    }
    n
}

/// Phrase to seed: NFKD, lower case, any white space between words. Errors
/// name word positions only, never the words.
pub fn phrase_to_seed(input: &str) -> Result<[u8; SEED_BYTES]> {
    let normalized: String = input.nfkd().collect::<String>().to_lowercase();
    let given: Vec<&str> = normalized.split_whitespace().collect();
    if given.len() != PHRASE_WORDS {
        return Err(err(
            Code::PhraseWordCount,
            format!(
                "the recovery phrase must have {PHRASE_WORDS} words, got {}",
                given.len()
            ),
        ));
    }
    let list = words();
    let mut indexes = Vec::with_capacity(PHRASE_WORDS);
    let mut unknown = Vec::new();
    for (i, w) in given.iter().enumerate() {
        match list.binary_search(w) {
            Ok(n) => indexes.push(n),
            Err(_) => unknown.push(i + 1),
        }
    }
    if !unknown.is_empty() {
        let list = unknown.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ");
        return Err(ProtoError {
            code: Code::PhraseUnknownWord,
            message: format!("words not in the word list: {list}"),
            positions: unknown,
        });
    }
    let mut bits = [0u8; 33];
    for (i, n) in indexes.iter().enumerate() {
        for k in 0..11 {
            if (n >> (10 - k)) & 1 == 1 {
                let b = i * 11 + k;
                bits[b / 8] |= 1 << (7 - b % 8);
            }
        }
    }
    let mut seed = [0u8; SEED_BYTES];
    seed.copy_from_slice(&bits[..32]);
    if sha256(&seed)[0] != bits[32] {
        return Err(err(
            Code::PhraseChecksum,
            "the recovery phrase checksum does not match: a word is probably mistyped or out of order",
        ));
    }
    Ok(seed)
}
