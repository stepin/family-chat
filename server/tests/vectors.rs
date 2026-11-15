//! Cross-check with the protocol package's test vectors in docs/vectors:
//! the server accepts the envelopes the client signs, rejects the negative
//! ones, and derives the same direct chat ids.

use std::path::PathBuf;

use ed25519_dalek::VerifyingKey;
use fcd::envelope::{self, Envelope};
use fcd::ids::{ChatId, UserId};
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/vectors")
        .join(name);
    serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

fn users() -> Value {
    load("identity.json")["users"].clone()
}

fn user_id(users: &Value, name: &str) -> UserId {
    UserId::parse(users[name]["userId"].as_str().unwrap()).unwrap()
}

fn key(users: &Value, name: &str) -> VerifyingKey {
    let hex = users[name]["signPubHex"].as_str().unwrap();
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    VerifyingKey::from_bytes(&bytes.try_into().unwrap()).unwrap()
}

fn env(v: &Value) -> Envelope {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap(),
        other => serde_json::from_value(other.clone()).unwrap(),
    }
}

#[test]
fn envelopes_verify() {
    let users = users();
    let v = load("envelopes.json");
    let list = v["envelopes"].as_array().unwrap();
    assert!(!list.is_empty());
    for e in list {
        let signer = e["signer"].as_str().unwrap();
        let uid = user_id(&users, signer);
        let envelope = env(&e["envelope"]);
        match e["kind"].as_str().unwrap() {
            "identity" => {
                let id = envelope::verify_identity(&envelope).unwrap();
                assert_eq!(id.user_id, uid);
            }
            "profile" => {
                envelope::verify_profile(&envelope, &uid, &key(&users, signer)).unwrap();
            }
            "auth" => {
                let req = envelope::parse_auth(&envelope).unwrap();
                assert_eq!(req.user_id, uid);
                envelope::verify_auth(&envelope, &req, &key(&users, signer)).unwrap();
            }
            k => panic!("unknown kind {k}"),
        }
    }
}

#[test]
fn negative_envelopes_fail() {
    let users = users();
    let v = load("negative.json");
    for e in v["envelopes"].as_array().unwrap() {
        let name = e["name"].as_str().unwrap();
        let envelope = env(&e["envelope"]);
        let signer = e["signer"].as_str();
        let failed = match e["kind"].as_str().unwrap() {
            "identity" => envelope::verify_identity(&envelope).is_err(),
            "profile" => {
                let s = signer.unwrap();
                envelope::verify_profile(&envelope, &user_id(&users, s), &key(&users, s)).is_err()
            }
            "auth" => {
                let s = signer.unwrap();
                match envelope::parse_auth(&envelope) {
                    Err(_) => true,
                    Ok(req) => {
                        req.user_id != user_id(&users, s)
                            || envelope::verify_auth(&envelope, &req, &key(&users, s)).is_err()
                    }
                }
            }
            k => panic!("unknown kind {k}"),
        };
        assert!(failed, "server accepted negative vector: {name}");
    }
}

#[test]
fn direct_chat_ids_match() {
    let users = users();
    let v = load("dm.json");
    let chats = v["chats"].as_array().unwrap();
    assert!(!chats.is_empty());
    for c in chats {
        let me = user_id(&users, c["me"].as_str().unwrap());
        let peer = user_id(&users, c["peer"].as_str().unwrap());
        let id = ChatId::direct(c["serverId"].as_str().unwrap(), &me, &peer);
        assert_eq!(id.to_string(), c["chatId"].as_str().unwrap(), "{c}");
    }
}

/// M5: the server accepts the vector manifest and rejects every negative one
/// (it only distinguishes "malformed" from "bad signature"; another author is
/// refused by the handler before the signature, another server is malformed).
#[test]
fn sticker_pack_vectors() {
    let users = users();
    let v = load("stickers.json");
    let server_id = v["serverId"].as_str().unwrap();
    let signer = v["signer"].as_str().unwrap();
    let alice = key(&users, signer);
    let e = env(&v["manifest"]["envelope"]);
    let (m, bytes) = envelope::parse_sticker_pack(&e, server_id).unwrap();
    assert_eq!(m.author, user_id(&users, signer));
    envelope::verify_sticker_pack(&e, &bytes, &alice).unwrap();
    for (f, s) in v["files"].as_array().unwrap().iter().zip(&m.stickers) {
        let hex = f["bytesHex"].as_str().unwrap();
        let b: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        assert_eq!(fcd::ids::FileHash::of(&b), s.file);
        assert_eq!(f["hash32"].as_str().unwrap(), s.file.to_string());
        assert_eq!(fcd::envelope::StickerType::sniff(&b), Some(s.kind));
    }
    for c in v["negativeManifests"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let e = env(&c["envelope"]);
        let refused = match envelope::parse_sticker_pack(&e, server_id) {
            Err(_) => true,
            Ok((m, bytes)) => {
                m.author != user_id(&users, signer) || envelope::verify_sticker_pack(&e, &bytes, &alice).is_err()
            }
        };
        assert!(refused, "{name} must be refused");
    }
}

/// M7: the optional `gender` field of a profile, the same rule as the protocol package.
#[test]
fn profile_gender_vectors() {
    let users = users();
    let v = load("profile-gender.json");
    let alice = user_id(&users, "alice");
    let k = key(&users, "alice");
    for p in v["profiles"].as_array().unwrap() {
        let prof = envelope::verify_profile(&env(&p["envelope"]), &alice, &k)
            .unwrap_or_else(|e| panic!("{}: {e:?}", p["name"]));
        assert_eq!(prof.gender.as_str(), p["gender"].as_str().unwrap(), "{}", p["name"]);
    }
    for c in v["negative"].as_array().unwrap() {
        assert!(
            envelope::verify_profile(&env(&c["envelope"]), &alice, &k).is_err(),
            "{} must be rejected",
            c["name"]
        );
    }
}
