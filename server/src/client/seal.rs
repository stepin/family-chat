//! Signed envelopes as a client writes and checks them (docs/PROTOCOL.md,
//! section 4): `{"payload":"<base64url>","sig":"<base64url>"}` with
//! `sig = Ed25519(utf8("fc/v1/" + kind + "\n") || payload)`. Checks always run
//! over the received payload bytes.

use serde_json::Value;

use super::bytes::cat;
use super::error::{Code, Result, err, invalid, malformed};
use super::json::{Obj, Writer, b32, b64, context_string_ok, name_problem, parse_object, safe_uint};
use super::keys::{IdentityKeys, check_sign_pub, verify};
use crate::envelope::Envelope;
use crate::ids::{DevId, UserId, b64_decode, b64_encode};

pub const MAX_ENVELOPE_PAYLOAD_BYTES: usize = 8192;
pub const MAX_STATE_PAYLOAD_BYTES: usize = 65536;
pub const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Identity,
    Profile,
    Auth,
    Revoked,
    GroupState,
    GroupKey,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Identity => "identity",
            Kind::Profile => "profile",
            Kind::Auth => "auth",
            Kind::Revoked => "revoked",
            Kind::GroupState => "group-state",
            Kind::GroupKey => "group-key",
        }
    }

    /// Largest payload; a group state carries the member list and gets more room.
    pub fn max_payload(self) -> usize {
        match self {
            Kind::GroupState => MAX_STATE_PAYLOAD_BYTES,
            _ => MAX_ENVELOPE_PAYLOAD_BYTES,
        }
    }
}

/// The bytes a signature of this kind covers.
pub fn signing_input(kind: Kind, payload: &[u8]) -> Vec<u8> {
    cat(&[format!("fc/v1/{}\n", kind.as_str()).as_bytes(), payload])
}

/// Signs exact payload bytes.
pub fn seal_bytes(kind: Kind, payload: &[u8], keys: &IdentityKeys) -> Result<Envelope> {
    if payload.len() > kind.max_payload() {
        return Err(err(Code::TooLarge, format!("{} payload is too large", kind.as_str())));
    }
    Ok(Envelope {
        payload: b64_encode(payload),
        sig: b64_encode(&keys.sign(&signing_input(kind, payload))),
    })
}

/// The exact wire JSON of an envelope.
pub fn serialize(env: &Envelope) -> String {
    Writer::new().str("payload", &env.payload).str("sig", &env.sig).finish()
}

/// An envelope from a parsed value: exactly the keys `payload` and `sig`, both strings.
pub fn envelope_of(v: &Value) -> Result<Envelope> {
    let bad = || malformed("envelope: expected exactly \"payload\" and \"sig\" strings");
    let o = v.as_object().ok_or_else(|| malformed("envelope: not an object"))?;
    if o.len() != 2 {
        return Err(bad());
    }
    match (
        o.get("payload").and_then(Value::as_str),
        o.get("sig").and_then(Value::as_str),
    ) {
        (Some(p), Some(s)) => Ok(Envelope {
            payload: p.to_string(),
            sig: s.to_string(),
        }),
        _ => Err(bad()),
    }
}

pub fn parse_envelope(text: &str) -> Result<Envelope> {
    let v: Value = serde_json::from_str(text).map_err(|_| malformed("envelope: invalid JSON"))?;
    envelope_of(&v)
}

/// An envelope with its payload decoded; the signature is not checked yet.
pub struct Opened {
    pub env: Envelope,
    pub bytes: Vec<u8>,
    pub sig: [u8; 64],
    pub json: Obj,
}

/// Shape, size and version of an envelope; no signature check.
pub fn open(env: &Envelope, kind: Kind) -> Result<Opened> {
    let k = kind.as_str();
    let too_large = || err(Code::TooLarge, format!("{k} payload is too large"));
    if env.payload.len() > (kind.max_payload() * 4).div_ceil(3) {
        return Err(too_large());
    }
    let bytes = b64_decode(&env.payload).ok_or_else(|| malformed(format!("{k} payload: not base64url")))?;
    if bytes.len() > kind.max_payload() {
        return Err(too_large());
    }
    let sig: [u8; 64] = b64_decode(&env.sig)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| malformed(format!("{k} sig: expected 64 bytes")))?;
    let json = parse_object(&bytes, &format!("{k} payload"))?;
    if safe_uint(json.get("v")) != Some(1) {
        return Err(err(
            Code::UnsupportedVersion,
            format!("{k} payload version is not supported"),
        ));
    }
    Ok(Opened {
        env: env.clone(),
        bytes,
        sig,
        json,
    })
}

pub fn check_sig(o: &Opened, kind: Kind, sign_pub: &[u8; 32]) -> Result<()> {
    if verify(&o.sig, &signing_input(kind, &o.bytes), sign_pub) {
        Ok(())
    } else {
        Err(err(
            Code::BadSignature,
            format!("{} signature does not verify", kind.as_str()),
        ))
    }
}

/// A verified identity: public keys bound to the self-certifying userId.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerIdentity {
    pub user_id: UserId,
    pub sign_pub: [u8; 32],
    pub box_pub: [u8; 32],
}

/// Checks a self-signed identity envelope (section 4.2).
pub fn verify_identity(env: &Envelope) -> Result<PeerIdentity> {
    let o = open(env, Kind::Identity)?;
    let user_id = b32::<16>(o.json.get("userId")).ok_or_else(|| malformed("identity: bad userId"))?;
    let sign_pub = b64::<32>(o.json.get("signPub")).ok_or_else(|| malformed("identity: bad signPub"))?;
    let box_pub = b64::<32>(o.json.get("boxPub")).ok_or_else(|| malformed("identity: bad boxPub"))?;
    safe_uint(o.json.get("created")).ok_or_else(|| malformed("identity: bad created"))?;
    if UserId::from_sign_pub(&sign_pub).0 != user_id {
        return Err(err(Code::UserIdMismatch, "identity userId does not match signPub"));
    }
    check_sign_pub(&sign_pub)?;
    check_sig(&o, Kind::Identity, &sign_pub)?;
    Ok(PeerIdentity {
        user_id: UserId(user_id),
        sign_pub,
        box_pub,
    })
}

/// Checks a profile envelope against its owner's identity; returns the name.
pub fn verify_profile(env: &Envelope, identity: &PeerIdentity) -> Result<String> {
    let o = open(env, Kind::Profile)?;
    let user_id = b32::<16>(o.json.get("userId")).ok_or_else(|| malformed("profile: bad userId"))?;
    let name = o
        .json
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("profile: name must be a string"))?;
    if let Some(p) = name_problem(name, MAX_NAME_CHARS) {
        return Err(malformed(format!("profile: {p}")));
    }
    safe_uint(o.json.get("rev")).ok_or_else(|| malformed("profile: bad rev"))?;
    safe_uint(o.json.get("updated")).ok_or_else(|| malformed("profile: bad updated"))?;
    if UserId(user_id) != identity.user_id {
        return Err(err(Code::UserIdMismatch, "profile belongs to another user"));
    }
    check_sig(&o, Kind::Profile, &identity.sign_pub)?;
    Ok(name.to_string())
}

/// Checks an auth envelope against the user's identity (signature only).
pub fn verify_auth(env: &Envelope, identity: &PeerIdentity) -> Result<()> {
    let o = open(env, Kind::Auth)?;
    let user_id = b32::<16>(o.json.get("userId")).ok_or_else(|| malformed("auth: bad userId"))?;
    if UserId(user_id) != identity.user_id {
        return Err(err(Code::UserIdMismatch, "auth belongs to another user"));
    }
    check_sig(&o, Kind::Auth, &identity.sign_pub)
}

// ---- writing ----

pub fn identity_envelope(keys: &IdentityKeys, created: u64) -> Envelope {
    let payload = Writer::new()
        .num("v", 1)
        .str("userId", &keys.user_id.to_string())
        .str("signPub", &b64_encode(&keys.sign_pub))
        .str("boxPub", &b64_encode(&keys.box_pub))
        .num("created", created)
        .finish();
    seal_bytes(Kind::Identity, payload.as_bytes(), keys).expect("an identity payload is small")
}

/// A reference to an uploaded avatar: base64url SHA-256 of the file and its type.
pub struct AvatarRef<'a> {
    pub sha256: &'a str,
    pub mime: &'a str,
}

pub struct ProfileInput<'a> {
    pub name: &'a str,
    pub avatar: Option<AvatarRef<'a>>,
    /// `m` or `f`; absent means no `gender` field (a reader takes `m`).
    pub gender: Option<&'a str>,
    pub rev: u64,
    pub updated: u64,
}

pub fn profile_envelope(keys: &IdentityKeys, input: &ProfileInput<'_>) -> Result<Envelope> {
    let name = super::json::js_trim(input.name);
    if let Some(p) = name_problem(name, MAX_NAME_CHARS) {
        return Err(invalid(p));
    }
    let avatar = match &input.avatar {
        None => "null".to_string(),
        Some(a) => {
            let hash_ok = b64_decode(a.sha256).is_some_and(|h| h.len() == 32);
            if !hash_ok || !matches!(a.mime, "image/jpeg" | "image/webp") {
                return Err(invalid("avatar must be a SHA-256 and image/jpeg or image/webp"));
            }
            Writer::new().str("sha256", a.sha256).str("type", a.mime).finish()
        }
    };
    let mut w = Writer::new()
        .num("v", 1)
        .str("userId", &keys.user_id.to_string())
        .str("name", name)
        .raw("avatar", &avatar);
    if let Some(g) = input.gender {
        if !matches!(g, "m" | "f") {
            return Err(invalid("gender must be \"m\" or \"f\""));
        }
        w = w.str("gender", g);
    }
    let payload = w.num("rev", input.rev).num("updated", input.updated).finish();
    seal_bytes(Kind::Profile, payload.as_bytes(), keys)
}

pub fn auth_envelope(keys: &IdentityKeys, server_id: &str, nonce: &str, dev: &DevId) -> Result<Envelope> {
    if !context_string_ok(server_id) || !context_string_ok(nonce) {
        return Err(invalid("serverId and nonce must be strings of 1 to 256 bytes"));
    }
    let payload = Writer::new()
        .num("v", 1)
        .str("userId", &keys.user_id.to_string())
        .str("serverId", server_id)
        .str("nonce", nonce)
        .str("devId", &dev.to_string())
        .finish();
    seal_bytes(Kind::Auth, payload.as_bytes(), keys)
}

pub fn revocation_envelope(keys: &IdentityKeys, revoked_at: u64) -> Envelope {
    let payload = Writer::new()
        .num("v", 1)
        .str("userId", &keys.user_id.to_string())
        .num("revokedAt", revoked_at)
        .finish();
    seal_bytes(Kind::Revoked, payload.as_bytes(), keys).expect("a revocation payload is small")
}
