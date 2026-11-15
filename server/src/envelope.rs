//! Signed envelopes: `{"payload":"<base64url>","sig":"<base64url>"}`.
//! `payload` is the exact UTF-8 bytes of a JSON document; `sig` is Ed25519
//! over `utf8("fc/v1/" + kind + "\n") || payload`.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{DevId, FileHash, PackId, UserId, b64_decode};

/// Longest accepted payload (decoded), bytes. Profiles carry no avatar
/// bytes (the avatar is a separate file), so this is generous.
pub const MAX_PAYLOAD: usize = 8 * 1024;
pub const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub payload: String,
    pub sig: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Identity,
    Profile,
    Auth,
    Revoked,
    StickerPack,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Identity => "identity",
            Kind::Profile => "profile",
            Kind::Auth => "auth",
            Kind::Revoked => "revoked",
            Kind::StickerPack => "sticker-pack",
        }
    }
}

/// Why an envelope was rejected. `BadSignature` is counted by the rate limiter.
#[derive(Debug, PartialEq, Eq)]
pub enum EnvError {
    Malformed(String),
    BadSignature,
}

fn malformed(m: impl Into<String>) -> EnvError {
    EnvError::Malformed(m.into())
}

/// Bytes covered by the signature.
pub fn signed_bytes(kind: Kind, payload: &[u8]) -> Vec<u8> {
    let mut msg = format!("fc/v1/{}\n", kind.as_str()).into_bytes();
    msg.extend_from_slice(payload);
    msg
}

impl Envelope {
    /// Decodes the payload into JSON (no signature check).
    fn decode(&self) -> Result<(Vec<u8>, serde_json::Map<String, Value>), EnvError> {
        self.decode_max(MAX_PAYLOAD)
    }

    fn decode_max(&self, max: usize) -> Result<(Vec<u8>, serde_json::Map<String, Value>), EnvError> {
        if self.payload.len() > max.div_ceil(3) * 4 {
            return Err(malformed("payload too large"));
        }
        let bytes = b64_decode(&self.payload).ok_or_else(|| malformed("payload is not base64url"))?;
        if bytes.len() > max {
            return Err(malformed("payload too large"));
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| malformed("payload is not JSON"))?;
        match v {
            Value::Object(m) => Ok((bytes, m)),
            _ => Err(malformed("payload is not a JSON object")),
        }
    }

    fn verify(&self, kind: Kind, payload: &[u8], key: &VerifyingKey) -> Result<(), EnvError> {
        let sig = b64_decode(&self.sig).ok_or_else(|| malformed("sig is not base64url"))?;
        let sig: [u8; 64] = sig.try_into().map_err(|_| malformed("sig must be 64 bytes"))?;
        key.verify_strict(&signed_bytes(kind, payload), &Signature::from_bytes(&sig))
            .map_err(|_| EnvError::BadSignature)
    }
}

fn str_field<'a>(m: &'a serde_json::Map<String, Value>, k: &str) -> Result<&'a str, EnvError> {
    m.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| malformed(format!("{k} must be a string")))
}

fn int_field(m: &serde_json::Map<String, Value>, k: &str) -> Result<i64, EnvError> {
    m.get(k)
        .and_then(Value::as_i64)
        .ok_or_else(|| malformed(format!("{k} must be an integer")))
}

fn check_version(m: &serde_json::Map<String, Value>) -> Result<(), EnvError> {
    if m.get("v").and_then(Value::as_i64) != Some(1) {
        return Err(malformed("v must be 1"));
    }
    Ok(())
}

fn key32(m: &serde_json::Map<String, Value>, k: &str) -> Result<[u8; 32], EnvError> {
    b64_decode(str_field(m, k)?)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| malformed(format!("{k} must be 32 bytes in base64url")))
}

fn user_field(m: &serde_json::Map<String, Value>) -> Result<UserId, EnvError> {
    UserId::parse(str_field(m, "userId")?).ok_or_else(|| malformed("bad userId"))
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub user_id: UserId,
    pub sign_pub: [u8; 32],
    pub key: VerifyingKey,
    pub envelope: Envelope,
}

/// identity payload: `{"v":1,"userId","signPub","boxPub","created"}`, signed
/// by `signPub` itself; `userId` must match `signPub`.
pub fn verify_identity(env: &Envelope) -> Result<Identity, EnvError> {
    let (bytes, m) = env.decode()?;
    check_version(&m)?;
    let user_id = user_field(&m)?;
    let sign_pub = key32(&m, "signPub")?;
    key32(&m, "boxPub")?;
    int_field(&m, "created")?;
    if UserId::from_sign_pub(&sign_pub) != user_id {
        return Err(malformed("userId does not match signPub"));
    }
    let key = VerifyingKey::from_bytes(&sign_pub).map_err(|_| malformed("signPub is not an Ed25519 key"))?;
    env.verify(Kind::Identity, &bytes, &key)?;
    Ok(Identity {
        user_id,
        sign_pub,
        key,
        envelope: env.clone(),
    })
}

/// Characters a profile name must not contain (the same set as
/// `packages/protocol`, docs/PROTOCOL.md 4.3): C0 controls, DEL, C1 controls
/// and bidirectional formatting characters.
fn forbidden_in_name(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{61c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

/// Why a display name is unacceptable, or `None`. Unpaired surrogates cannot
/// reach this point: `serde_json` rejects them while parsing the payload.
pub fn name_problem(name: &str) -> Option<String> {
    // JavaScript's `trim()` also strips U+FEFF, Rust's does not; strip it too
    // so both sides agree on "empty".
    if name
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
    {
        return Some("name must not be empty".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Some(format!("name must be at most {MAX_NAME_CHARS} characters"));
    }
    if name.chars().any(forbidden_in_name) {
        return Some("name contains control or bidirectional characters".into());
    }
    None
}

/// Image formats accepted for avatars (checked by signature bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageKind {
    Jpeg,
    Webp,
}

impl ImageKind {
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Webp => "image/webp",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            ImageKind::Jpeg => "jpg",
            ImageKind::Webp => "webp",
        }
    }

    pub fn from_mime(s: &str) -> Option<Self> {
        match s {
            "image/jpeg" => Some(ImageKind::Jpeg),
            "image/webp" => Some(ImageKind::Webp),
            _ => None,
        }
    }

    pub fn from_ext(s: &str) -> Option<Self> {
        match s {
            "jpg" => Some(ImageKind::Jpeg),
            "webp" => Some(ImageKind::Webp),
            _ => None,
        }
    }

    /// JPEG starts with `FF D8 FF`; WebP is `RIFF <size> WEBP`.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
            return Some(ImageKind::Jpeg);
        }
        if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            return Some(ImageKind::Webp);
        }
        None
    }
}

/// The `avatar` field of a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvatarRef {
    /// `null`.
    None,
    /// `{"sha256":"<base64url>","type":"image/jpeg"|"image/webp"}`, exactly
    /// these two keys (docs/PROTOCOL.md 4.3).
    Image { sha256: [u8; 32], kind: ImageKind },
    /// Anything else the M1 server accepted (a short string). Kept when
    /// loading old data; new profiles must use `null` or an image.
    Legacy,
}

fn parse_avatar(v: Option<&Value>) -> Result<AvatarRef, EnvError> {
    match v {
        Some(Value::Null) => Ok(AvatarRef::None),
        Some(Value::String(s)) if s.len() <= 128 => Ok(AvatarRef::Legacy),
        Some(Value::Object(o)) => {
            if o.len() != 2 {
                return Err(malformed("avatar must have exactly the keys sha256 and type"));
            }
            let sha256 = o
                .get("sha256")
                .and_then(Value::as_str)
                .and_then(b64_decode)
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .ok_or_else(|| malformed("avatar.sha256 must be 32 bytes in base64url"))?;
            let kind = o
                .get("type")
                .and_then(Value::as_str)
                .and_then(ImageKind::from_mime)
                .ok_or_else(|| malformed("avatar.type must be image/jpeg or image/webp"))?;
            Ok(AvatarRef::Image { sha256, kind })
        }
        _ => Err(malformed("avatar must be null or {sha256, type}")),
    }
}

/// Grammatical gender of a profile (M7, docs/PROTOCOL.md 4.3): the optional
/// `gender` field, `"m"` or `"f"`; absent means male.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Gender {
    #[default]
    Male,
    Female,
}

impl Gender {
    pub fn as_str(self) -> &'static str {
        match self {
            Gender::Male => "m",
            Gender::Female => "f",
        }
    }
}

/// The `gender` field: absent, `"m"` or `"f"` (the same rule as `packages/protocol`).
fn parse_gender(v: Option<&Value>) -> Result<Gender, EnvError> {
    match v {
        None => Ok(Gender::Male),
        Some(Value::String(s)) if s == "m" => Ok(Gender::Male),
        Some(Value::String(s)) if s == "f" => Ok(Gender::Female),
        _ => Err(malformed("gender must be \"m\" or \"f\"")),
    }
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub rev: i64,
    pub name: String,
    pub avatar: AvatarRef,
    pub gender: Gender,
    pub envelope: Envelope,
}

/// profile payload: `{"v":1,"userId","name","avatar","gender"?,"rev","updated"}`,
/// signed by the user's identity key. `gender` is optional (M7).
pub fn verify_profile(env: &Envelope, user: &UserId, key: &VerifyingKey) -> Result<Profile, EnvError> {
    let (bytes, m) = env.decode()?;
    check_version(&m)?;
    if user_field(&m)? != *user {
        return Err(malformed("profile userId is not the identity's userId"));
    }
    let name = str_field(&m, "name")?;
    if let Some(problem) = name_problem(name) {
        return Err(malformed(problem));
    }
    let avatar = parse_avatar(m.get("avatar"))?;
    let gender = parse_gender(m.get("gender"))?;
    let rev = int_field(&m, "rev")?;
    if rev < 0 {
        return Err(malformed("rev must not be negative"));
    }
    int_field(&m, "updated")?;
    env.verify(Kind::Profile, &bytes, key)?;
    Ok(Profile {
        rev,
        name: name.to_string(),
        avatar,
        gender,
        envelope: env.clone(),
    })
}

#[derive(Debug, Clone)]
pub struct AuthRequest {
    pub user_id: UserId,
    pub server_id: String,
    pub nonce: String,
    pub dev_id: DevId,
    bytes: Vec<u8>,
}

/// auth payload: `{"v":1,"userId","serverId","nonce","devId"}`. Parsed first
/// (to find the user's key), then verified with [`verify_auth`].
pub fn parse_auth(env: &Envelope) -> Result<AuthRequest, EnvError> {
    let (bytes, m) = env.decode()?;
    check_version(&m)?;
    Ok(AuthRequest {
        user_id: user_field(&m)?,
        server_id: str_field(&m, "serverId")?.to_string(),
        nonce: str_field(&m, "nonce")?.to_string(),
        dev_id: DevId::parse(str_field(&m, "devId")?).ok_or_else(|| malformed("bad devId"))?,
        bytes,
    })
}

pub fn verify_auth(env: &Envelope, req: &AuthRequest, key: &VerifyingKey) -> Result<(), EnvError> {
    env.verify(Kind::Auth, &req.bytes, key)
}

/// A parsed `revoked` envelope: `{"v":1,"userId","revokedAt"}`.
#[derive(Debug, Clone)]
pub struct Revocation {
    pub user_id: UserId,
    pub revoked_at: i64,
    bytes: Vec<u8>,
}

/// Parses a `revoked` envelope (no signature check yet: the key is found
/// by `userId`, then [`verify_revocation`]).
pub fn parse_revocation(env: &Envelope) -> Result<Revocation, EnvError> {
    let (bytes, m) = env.decode()?;
    check_version(&m)?;
    let revoked_at = int_field(&m, "revokedAt")?;
    if revoked_at < 0 {
        return Err(malformed("revokedAt must not be negative"));
    }
    Ok(Revocation {
        user_id: user_field(&m)?,
        revoked_at,
        bytes,
    })
}

pub fn verify_revocation(env: &Envelope, r: &Revocation, key: &VerifyingKey) -> Result<(), EnvError> {
    env.verify(Kind::Revoked, &r.bytes, key)
}

// ---- sticker packs (docs/PROTOCOL.md, "Наборы стикеров") ----

/// Largest `sticker-pack` payload: a manifest of up to 200 stickers.
pub const MAX_PACK_PAYLOAD: usize = 64 * 1024;
/// Stickers in one pack.
pub const MAX_PACK_STICKERS: usize = 200;
/// Largest `.webp` sticker file.
pub const MAX_WEBP_BYTES: u64 = 512 * 1024;
/// Largest `.tgs` sticker file (gzip-compressed Lottie JSON).
pub const MAX_TGS_BYTES: u64 = 128 * 1024;
/// All files of one pack together.
pub const MAX_PACK_BYTES: u64 = 50 * 1024 * 1024;
/// Width and height of a sticker, pixels.
pub const MAX_STICKER_SIDE: i64 = 1024;
pub const MAX_EMOJI_CHARS: usize = 16;
pub const MAX_EMOJI_BYTES: usize = 64;

/// Sticker file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StickerType {
    Webp,
    Tgs,
}

impl StickerType {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "webp" => Some(Self::Webp),
            "tgs" => Some(Self::Tgs),
            _ => None,
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Webp => "webp",
            Self::Tgs => "tgs",
        }
    }

    pub fn max_bytes(self) -> u64 {
        match self {
            Self::Webp => MAX_WEBP_BYTES,
            Self::Tgs => MAX_TGS_BYTES,
        }
    }

    /// WebP is `RIFF <size> WEBP`; `.tgs` is gzip (`1F 8B`).
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if ImageKind::sniff(bytes) == Some(ImageKind::Webp) {
            return Some(Self::Webp);
        }
        if bytes.len() >= 2 && bytes[..2] == [0x1F, 0x8B] {
            return Some(Self::Tgs);
        }
        None
    }
}

/// Why an emoji (of a sticker or a reaction) is unacceptable: the rules of
/// `packages/protocol` (1 to 16 code points, at most 64 bytes, no control or
/// bidirectional characters, no surrounding spaces).
pub fn emoji_problem(e: &str) -> Option<String> {
    if e.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
    {
        return Some("emoji must not be empty".into());
    }
    if e.chars().count() > MAX_EMOJI_CHARS || e.len() > MAX_EMOJI_BYTES {
        return Some("emoji is too long".into());
    }
    if e.chars().any(forbidden_in_name) {
        return Some("emoji contains control or bidirectional characters".into());
    }
    if e.trim() != e {
        return Some("emoji must not contain surrounding spaces".into());
    }
    None
}

#[derive(Debug, Clone)]
pub struct PackSticker {
    pub file: FileHash,
    pub kind: StickerType,
    pub size: u64,
}

/// A verified sticker pack manifest.
#[derive(Debug, Clone)]
pub struct PackManifest {
    pub pack_id: PackId,
    pub author: UserId,
    pub name: String,
    pub stickers: Vec<PackSticker>,
    pub envelope: Envelope,
}

impl PackManifest {
    pub fn total_bytes(&self) -> u64 {
        self.stickers.iter().map(|s| s.size).sum()
    }
}

/// Parses a `sticker-pack` envelope: `{"v":1,"packId","serverId","author",
/// "name","created","stickers":[{"file","type","size","emoji","w","h"}]}`.
/// The signature is checked by [`verify_sticker_pack`] once the author's key is known.
pub fn parse_sticker_pack(env: &Envelope, server_id: &str) -> Result<(PackManifest, Vec<u8>), EnvError> {
    let (bytes, m) = env.decode_max(MAX_PACK_PAYLOAD)?;
    check_version(&m)?;
    let pack_id = PackId::parse(str_field(&m, "packId")?).ok_or_else(|| malformed("bad packId"))?;
    if str_field(&m, "serverId")? != server_id {
        return Err(malformed("the manifest belongs to another server"));
    }
    let author = UserId::parse(str_field(&m, "author")?).ok_or_else(|| malformed("bad author"))?;
    let name = str_field(&m, "name")?;
    if let Some(problem) = name_problem(name) {
        return Err(malformed(problem));
    }
    if int_field(&m, "created")? < 0 {
        return Err(malformed("created must not be negative"));
    }
    let list = m
        .get("stickers")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("stickers must be a list"))?;
    if list.is_empty() || list.len() > MAX_PACK_STICKERS {
        return Err(malformed(format!("a pack has 1 to {MAX_PACK_STICKERS} stickers")));
    }
    let mut stickers = Vec::with_capacity(list.len());
    let mut seen = std::collections::HashSet::new();
    for s in list {
        let o = s.as_object().ok_or_else(|| malformed("a sticker must be an object"))?;
        let file = FileHash::parse(str_field(o, "file")?).ok_or_else(|| malformed("bad sticker file"))?;
        if !seen.insert(file) {
            return Err(malformed("the same file is listed twice"));
        }
        let kind =
            StickerType::parse(str_field(o, "type")?).ok_or_else(|| malformed("sticker type must be webp or tgs"))?;
        let size = int_field(o, "size")?;
        if size < 1 || size as u64 > kind.max_bytes() {
            return Err(malformed("sticker size is out of range"));
        }
        if let Some(p) = emoji_problem(str_field(o, "emoji")?) {
            return Err(malformed(p));
        }
        for k in ["w", "h"] {
            let v = int_field(o, k)?;
            if !(1..=MAX_STICKER_SIDE).contains(&v) {
                return Err(malformed(format!("sticker {k} must be 1 to {MAX_STICKER_SIDE}")));
            }
        }
        stickers.push(PackSticker {
            file,
            kind,
            size: size as u64,
        });
    }
    let p = PackManifest {
        pack_id,
        author,
        name: name.to_string(),
        stickers,
        envelope: env.clone(),
    };
    if p.total_bytes() > MAX_PACK_BYTES {
        return Err(malformed("the pack is larger than allowed"));
    }
    Ok((p, bytes))
}

/// Checks the manifest's signature by the author's identity key.
pub fn verify_sticker_pack(env: &Envelope, bytes: &[u8], key: &VerifyingKey) -> Result<(), EnvError> {
    env.verify(Kind::StickerPack, bytes, key)
}

#[doc(hidden)]
pub mod testkit {
    //! Signing side, for tests (unit and integration).
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    use super::*;
    use crate::ids::b64_encode;

    pub fn seal(key: &SigningKey, kind: Kind, payload: &str) -> Envelope {
        let sig = key.sign(&signed_bytes(kind, payload.as_bytes()));
        Envelope {
            payload: b64_encode(payload.as_bytes()),
            sig: b64_encode(&sig.to_bytes()),
        }
    }

    pub fn identity(key: &SigningKey) -> (UserId, Envelope) {
        let pk = key.verifying_key().to_bytes();
        let uid = UserId::from_sign_pub(&pk);
        let p = json!({"v":1,"userId":uid.to_string(),"signPub":b64_encode(&pk),"boxPub":b64_encode(&[9u8;32]),"created":1});
        (uid, seal(key, Kind::Identity, &p.to_string()))
    }

    pub fn profile(key: &SigningKey, uid: &UserId, name: &str, rev: i64) -> Envelope {
        let p = json!({"v":1,"userId":uid.to_string(),"name":name,"avatar":null,"rev":rev,"updated":2});
        seal(key, Kind::Profile, &p.to_string())
    }

    pub fn profile_with_avatar(key: &SigningKey, uid: &UserId, name: &str, rev: i64, avatar: Value) -> Envelope {
        let p = json!({"v":1,"userId":uid.to_string(),"name":name,"avatar":avatar,"rev":rev,"updated":2});
        seal(key, Kind::Profile, &p.to_string())
    }

    pub fn revocation(key: &SigningKey, uid: &UserId, at: i64) -> Envelope {
        let p = json!({"v":1,"userId":uid.to_string(),"revokedAt":at});
        seal(key, Kind::Revoked, &p.to_string())
    }
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::testkit::*;
    use super::*;
    use crate::ids::b64_encode;

    #[test]
    fn identity_and_profile() {
        let k = SigningKey::from_bytes(&[3; 32]);
        let (uid, env) = identity(&k);
        let id = verify_identity(&env).unwrap();
        assert_eq!(id.user_id, uid);

        // Signature over another kind does not verify.
        let wrong = seal(
            &k,
            Kind::Profile,
            &String::from_utf8(b64_decode(&env.payload).unwrap()).unwrap(),
        );
        assert_eq!(verify_identity(&wrong).unwrap_err(), EnvError::BadSignature);

        // userId of another key.
        let other = SigningKey::from_bytes(&[4; 32]);
        let pk = k.verifying_key().to_bytes();
        let p = format!(
            r#"{{"v":1,"userId":"{}","signPub":"{}","boxPub":"{}","created":1}}"#,
            UserId::from_sign_pub(&other.verifying_key().to_bytes()),
            b64_encode(&pk),
            b64_encode(&[0; 32])
        );
        assert!(matches!(
            verify_identity(&seal(&k, Kind::Identity, &p)),
            Err(EnvError::Malformed(_))
        ));

        let prof = verify_profile(&profile(&k, &uid, "Мама", 1), &uid, &id.key).unwrap();
        assert_eq!(prof.name, "Мама");
        assert_eq!(prof.rev, 1);
        assert!(verify_profile(&profile(&k, &uid, &"я".repeat(64), 1), &uid, &id.key).is_ok());
        assert!(verify_profile(&profile(&k, &uid, &"я".repeat(65), 1), &uid, &id.key).is_err());
        assert!(verify_profile(&profile(&k, &uid, "  ", 1), &uid, &id.key).is_err());
        assert_eq!(
            verify_profile(&profile(&other, &uid, "x", 1), &uid, &id.key).unwrap_err(),
            EnvError::BadSignature
        );
    }

    #[test]
    fn profile_name_rules_match_the_protocol_package() {
        let k = SigningKey::from_bytes(&[6; 32]);
        let (uid, env) = identity(&k);
        let id = verify_identity(&env).unwrap();
        let check = |name: &str| verify_profile(&profile(&k, &uid, name, 1), &uid, &id.key);
        for ok in ["Мама", "Папа 👨‍👩‍👧", "a b", "O'Brien", "\u{200d}x"] {
            assert!(check(ok).is_ok(), "{ok:?} must be accepted");
        }
        for bad in [
            "a\u{0}b",
            "tab\there",
            "line\nbreak",
            "del\u{7f}",
            "c1\u{85}",
            "c1\u{9f}",
            "\u{61c}arabic mark",
            "lrm\u{200e}",
            "rlm\u{200f}",
            "embed\u{202a}",
            "override\u{202e}evil",
            "isolate\u{2066}",
            "pop\u{2069}",
            "\u{feff}",
            " \u{feff} ",
        ] {
            assert!(
                matches!(check(bad), Err(EnvError::Malformed(_))),
                "{bad:?} must be rejected"
            );
        }
        // An unpaired surrogate escape is rejected while parsing the JSON.
        let p = format!(r#"{{"v":1,"userId":"{uid}","name":"a\ud800b","avatar":null,"rev":1,"updated":2}}"#);
        assert!(matches!(
            verify_profile(&seal(&k, Kind::Profile, &p), &uid, &id.key),
            Err(EnvError::Malformed(_))
        ));
    }

    #[test]
    fn gender_field() {
        let k = SigningKey::from_bytes(&[7; 32]);
        let (uid, env) = identity(&k);
        let id = verify_identity(&env).unwrap();
        let with = |g: &str| {
            let p = format!(r#"{{"v":1,"userId":"{uid}","name":"x","avatar":null,"gender":{g},"rev":1,"updated":2}}"#);
            verify_profile(&seal(&k, Kind::Profile, &p), &uid, &id.key).map(|p| p.gender)
        };
        assert_eq!(with("\"f\"").unwrap(), Gender::Female);
        assert_eq!(with("\"m\"").unwrap(), Gender::Male);
        // Profiles from before M7 have no field: male.
        assert_eq!(
            verify_profile(&profile(&k, &uid, "x", 1), &uid, &id.key)
                .unwrap()
                .gender,
            Gender::Male
        );
        for bad in ["\"x\"", "\"F\"", "null", "1", "\"\""] {
            assert!(matches!(with(bad), Err(EnvError::Malformed(_))), "{bad}");
        }
    }

    #[test]
    fn avatar_field() {
        let k = SigningKey::from_bytes(&[7; 32]);
        let (uid, env) = identity(&k);
        let id = verify_identity(&env).unwrap();
        let check =
            |a: Value| verify_profile(&profile_with_avatar(&k, &uid, "x", 1, a), &uid, &id.key).map(|p| p.avatar);
        assert_eq!(check(Value::Null).unwrap(), AvatarRef::None);
        let sha = b64_encode(&[3u8; 32]);
        assert_eq!(
            check(serde_json::json!({"sha256": sha, "type": "image/webp"})).unwrap(),
            AvatarRef::Image {
                sha256: [3; 32],
                kind: ImageKind::Webp
            }
        );
        // M1 accepted short strings; they still load.
        assert_eq!(check(serde_json::json!("x")).unwrap(), AvatarRef::Legacy);
        for bad in [
            serde_json::json!({"sha256": sha, "type": "image/png"}),
            serde_json::json!({"sha256": sha, "type": "image/jpeg", "extra": 1}),
            serde_json::json!({"sha256": b64_encode(&[3u8; 31]), "type": "image/jpeg"}),
            serde_json::json!({"type": "image/jpeg"}),
            serde_json::json!(5),
            serde_json::json!("y".repeat(129)),
        ] {
            assert!(matches!(check(bad.clone()), Err(EnvError::Malformed(_))), "{bad}");
        }
    }

    #[test]
    fn image_signatures() {
        assert_eq!(ImageKind::sniff(&[0xFF, 0xD8, 0xFF, 0xDB]), Some(ImageKind::Jpeg));
        assert_eq!(ImageKind::sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(ImageKind::sniff(b"RIFF1234WEBP"), Some(ImageKind::Webp));
        assert_eq!(ImageKind::sniff(b"RIFF1234WAVE"), None);
        assert_eq!(ImageKind::sniff(b"\x89PNG\r\n"), None);
        assert_eq!(ImageKind::sniff(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn revocation_payload() {
        let k = SigningKey::from_bytes(&[8; 32]);
        let (uid, _) = identity(&k);
        let env = revocation(&k, &uid, 42);
        let r = parse_revocation(&env).unwrap();
        assert_eq!((r.user_id, r.revoked_at), (uid, 42));
        verify_revocation(&env, &r, &k.verifying_key()).unwrap();
        let other = SigningKey::from_bytes(&[9; 32]);
        assert_eq!(
            verify_revocation(&env, &r, &other.verifying_key()).unwrap_err(),
            EnvError::BadSignature
        );
        let p = format!(r#"{{"v":1,"userId":"{uid}"}}"#);
        assert!(parse_revocation(&seal(&k, Kind::Revoked, &p)).is_err());
        let p = format!(r#"{{"v":1,"userId":"{uid}","revokedAt":-1}}"#);
        assert!(parse_revocation(&seal(&k, Kind::Revoked, &p)).is_err());
    }

    #[test]
    fn auth_payload() {
        let k = SigningKey::from_bytes(&[5; 32]);
        let (uid, _) = identity(&k);
        let p = format!(
            r#"{{"v":1,"userId":"{uid}","serverId":"S","nonce":"N","devId":"{}"}}"#,
            DevId([1; 10])
        );
        let env = seal(&k, Kind::Auth, &p);
        let req = parse_auth(&env).unwrap();
        assert_eq!(req.server_id, "S");
        verify_auth(&env, &req, &k.verifying_key()).unwrap();
        let tampered = Envelope {
            payload: b64_encode(p.replace("\"S\"", "\"T\"").as_bytes()),
            sig: env.sig.clone(),
        };
        let req2 = parse_auth(&tampered).unwrap();
        assert_eq!(
            verify_auth(&tampered, &req2, &k.verifying_key()).unwrap_err(),
            EnvError::BadSignature
        );
    }
}
