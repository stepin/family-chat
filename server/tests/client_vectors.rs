//! The Rust client side of the protocol (`fcd::client`) against the vectors
//! of `docs/vectors/`, the same files the TypeScript package is checked with:
//! what one implementation writes the other must accept, byte for byte where
//! the vectors fix the bytes, and both must reject the negative cases with
//! the same error code.

use std::path::PathBuf;

use fcd::client::blob::{decrypt_part, encrypt_part};
use fcd::client::dm::{ChatKeys, derive_dm_key, derive_enc_key};
use fcd::client::event::{EventContext, decode_event, encode_event_with_nonce};
use fcd::client::group::{
    GroupMember, GroupState, StateContext, accept_group_key, create_group, open_group_key, open_group_state,
    parse_sealed_group_key, remove_group_members, transfer_group_ownership, verify_group_state,
};
use fcd::client::keys::{self, IdentityKeys, fingerprint, phrase_to_seed, seed_to_phrase};
use fcd::client::payload::{self, BlobRef, Payload, parse_payload, validate_attachment};
use fcd::client::seal::{self, PeerIdentity, ProfileInput};
use fcd::client::{Code, hpke};
use fcd::envelope::Envelope;
use fcd::ids::{BlobId, ChatId, DevId, UserId, b64_decode};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn load(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/vectors")
        .join(name);
    serde_json::from_slice(&std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn arr<const N: usize>(s: &str) -> [u8; N] {
    unhex(s).try_into().unwrap_or_else(|_| panic!("expected {N} bytes"))
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// Keys of alice, bob or carol (identity.json), or of dave and mallory (group.json).
fn user(name: &str) -> IdentityKeys {
    let id = load("identity.json");
    let seed = match id["users"].get(name) {
        Some(u) => arr::<32>(text(&u["seedHex"])),
        None => arr::<32>(text(&load("group.json")["extraUsers"][name]["seedHex"])),
    };
    IdentityKeys::from_seed(&seed)
}

fn member(name: &str) -> GroupMember {
    let k = user(name);
    GroupMember {
        user_id: k.user_id,
        sign_pub: k.sign_pub,
        box_pub: k.box_pub,
    }
}

fn peer(name: &str) -> PeerIdentity {
    let k = user(name);
    PeerIdentity {
        user_id: k.user_id,
        sign_pub: k.sign_pub,
        box_pub: k.box_pub,
    }
}

fn envelope(json: &str) -> Envelope {
    seal::parse_envelope(json).unwrap()
}

fn code_of<T>(r: Result<T, fcd::client::ProtoError>) -> String {
    match r {
        Ok(_) => "ok".to_string(),
        Err(e) => e.code.as_str().to_string(),
    }
}

#[test]
fn word_list_is_the_documented_one() {
    assert_eq!(
        hex(&Sha256::digest(keys::wordlist_bytes())),
        text(&load("identity.json")["bip39Wordlist"]["sha256"])
    );
}

#[test]
fn identity_vectors() {
    let v = load("identity.json");
    for p in v["phrases"].as_array().unwrap() {
        let seed = arr::<32>(text(&p["seedHex"]));
        assert_eq!(seed_to_phrase(&seed), text(&p["phrase"]));
        assert_eq!(phrase_to_seed(text(&p["phrase"])).unwrap(), seed);
    }
    for (name, u) in v["users"].as_object().unwrap() {
        let seed = arr::<32>(text(&u["seedHex"]));
        let k = IdentityKeys::from_seed(&seed);
        assert_eq!(seed_to_phrase(&seed), text(&u["phrase"]), "{name}");
        assert_eq!(hex(&k.sign_secret()), text(&u["signSecretHex"]), "{name}");
        assert_eq!(hex(&k.sign_pub), text(&u["signPubHex"]), "{name}");
        assert_eq!(hex(k.box_secret()), text(&u["boxSecretHex"]), "{name}");
        assert_eq!(hex(&k.box_pub), text(&u["boxPubHex"]), "{name}");
        assert_eq!(hex(k.self_key()), text(&u["selfKeyHex"]), "{name}");
        assert_eq!(k.user_id.to_string(), text(&u["userId"]), "{name}");
        assert_eq!(fingerprint(&k.sign_pub, &k.box_pub), text(&u["fingerprint"]), "{name}");
    }
    // Pasted phrases with capitals, line breaks and double spaces are accepted.
    let alice = text(&v["users"]["alice"]["phrase"]);
    let messy = alice.to_uppercase().replace(' ', "  \n");
    assert_eq!(
        hex(&phrase_to_seed(&messy).unwrap()),
        text(&v["users"]["alice"]["seedHex"])
    );
}

#[test]
fn negative_phrases() {
    for p in load("negative.json")["phrases"].as_array().unwrap() {
        let e = phrase_to_seed(text(&p["phrase"])).unwrap_err();
        assert_eq!(e.code.as_str(), text(&p["expectedError"]), "{}", p["name"]);
        if let Some(pos) = p.get("positions") {
            let want: Vec<usize> = pos
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as usize)
                .collect();
            assert_eq!(e.positions, want);
        }
        assert!(!e.message.contains("notaword"), "an error names positions, never words");
    }
}

#[test]
fn envelopes_are_written_and_checked_alike() {
    let v = load("envelopes.json");
    for e in v["envelopes"].as_array().unwrap() {
        let keys = user(text(&e["signer"]));
        let payload: Value = serde_json::from_str(text(&e["payloadText"])).unwrap();
        let env = envelope(text(&e["envelope"]));
        let written = match text(&e["kind"]) {
            "identity" => {
                assert_eq!(seal::verify_identity(&env).unwrap(), peer(text(&e["signer"])));
                seal::identity_envelope(&keys, payload["created"].as_u64().unwrap())
            }
            "profile" => {
                let name = seal::verify_profile(&env, &peer(text(&e["signer"]))).unwrap();
                assert_eq!(name, text(&payload["name"]));
                seal::profile_envelope(
                    &keys,
                    &ProfileInput {
                        name: text(&payload["name"]),
                        avatar: None,
                        gender: payload.get("gender").and_then(Value::as_str),
                        rev: payload["rev"].as_u64().unwrap(),
                        updated: payload["updated"].as_u64().unwrap(),
                    },
                )
                .unwrap()
            }
            "auth" => {
                seal::verify_auth(&env, &peer(text(&e["signer"]))).unwrap();
                let dev = DevId::parse(text(&payload["devId"])).unwrap();
                seal::auth_envelope(&keys, text(&payload["serverId"]), text(&payload["nonce"]), &dev).unwrap()
            }
            other => panic!("unexpected kind {other}"),
        };
        assert_eq!(seal::serialize(&written), text(&e["envelope"]), "{}", e["kind"]);
    }
}

#[test]
fn negative_envelopes() {
    for e in load("negative.json")["envelopes"].as_array().unwrap() {
        let env = envelope(text(&e["envelope"]));
        let got = match text(&e["kind"]) {
            "identity" => code_of(seal::verify_identity(&env)),
            "profile" => code_of(seal::verify_profile(&env, &peer("bob"))),
            "auth" => code_of(seal::verify_auth(&env, &peer("alice"))),
            other => panic!("unexpected kind {other}"),
        };
        assert_eq!(got, text(&e["expectedError"]), "{}", e["name"]);
    }
}

#[test]
fn direct_chat_keys() {
    let v = load("dm.json");
    for c in v["chats"].as_array().unwrap() {
        let (me, other) = (user(text(&c["me"])), user(text(&c["peer"])));
        let server = text(&c["serverId"]);
        let dm = derive_dm_key(&me, &other.user_id, &other.box_pub, server).unwrap();
        assert_eq!(hex(&dm), text(&c["dmKeyHex"]));
        assert_eq!(hex(&derive_enc_key(&dm)), text(&c["encKeyHex"]));
        // Both sides derive the same key without exchanging anything.
        assert_eq!(derive_dm_key(&other, &me.user_id, &me.box_pub, server).unwrap(), dm);
        assert_eq!(
            ChatId::direct(server, &me.user_id, &other.user_id).to_string(),
            text(&c["chatId"])
        );
    }
    let z = &v["zeroPeer"];
    let me = user(text(&z["me"]));
    let r = derive_dm_key(&me, &me.user_id, &arr::<32>(text(&z["peerBoxPubHex"])), "s");
    assert_eq!(code_of(r), text(&z["expectedError"]));
}

fn lookup(names: Vec<String>) -> impl Fn(&UserId) -> Option<[u8; 32]> {
    let known: Vec<IdentityKeys> = names.iter().map(|n| user(n)).collect();
    move |id| known.iter().find(|k| k.user_id == *id).map(|k| k.sign_pub)
}

#[test]
fn event_vector() {
    let v = load("event.json");
    let i = &v["inputs"];
    let chat = ChatKeys {
        epoch: i["epoch"].as_u64().unwrap() as u32,
        enc_key: arr::<32>(text(&i["encKeyHex"])),
    };
    let ctx = EventContext {
        server_id: text(&i["serverId"]),
        chat_id: text(&i["chatId"]),
        chat: &chat,
    };
    let author = user(text(&i["author"]));
    let payload = text(&i["payloadText"]).as_bytes();
    let body = encode_event_with_nonce(&ctx, &author, payload, &arr::<12>(text(&i["nonceHex"]))).unwrap();
    assert_eq!(hex(&body), text(&v["bodyHex"]));

    let known = lookup(vec!["alice".into(), "bob".into()]);
    let e = decode_event(&body, &ctx, &known, Some(&author.user_id)).unwrap();
    assert_eq!(e.sender, author.user_id);
    assert_eq!(e.msg_id.to_string(), text(&i["msgId"]));
    assert_eq!(e.payload_bytes, payload);
    let Payload::Msg(m) = e.payload else { panic!("a msg") };
    assert_eq!(m.body.as_deref(), Some("Привет! **Hello**"));
    assert!(m.reply.is_some());
    // The sender the server reports must be the signed author.
    let bob = user("bob").user_id;
    assert_eq!(
        code_of(decode_event(&body, &ctx, &known, Some(&bob))),
        Code::SenderMismatch.as_str()
    );
}

#[test]
fn negative_events() {
    for e in load("negative.json")["events"].as_array().unwrap() {
        let c = &e["context"];
        let chat = ChatKeys {
            epoch: c["epoch"].as_u64().unwrap() as u32,
            enc_key: arr::<32>(text(&c["encKeyHex"])),
        };
        let ctx = EventContext {
            server_id: text(&c["serverId"]),
            chat_id: text(&c["chatId"]),
            chat: &chat,
        };
        let members: Vec<String> = e["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| text(m).to_string())
            .collect();
        let got = code_of(decode_event(&unhex(text(&e["bodyHex"])), &ctx, &lookup(members), None));
        assert_eq!(got, text(&e["expectedError"]), "{}", e["name"]);
    }
}

#[test]
fn payloads_parse_and_are_written_back_identically() {
    for p in load("payloads.json")["payloads"].as_array().unwrap() {
        let src = text(&p["text"]);
        let written = match parse_payload(src.as_bytes()).unwrap() {
            Payload::Msg(m) => payload::encode_msg(&m).unwrap(),
            Payload::Edit { common, target, body } => payload::encode_edit(&common, &target, &body).unwrap(),
            Payload::Delete {
                common,
                target,
                target_dev,
                target_seq,
            } => payload::encode_delete(&common, &target, &target_dev, target_seq).unwrap(),
            Payload::React {
                common,
                target,
                emoji,
                on,
            } => payload::encode_react(&common, &target, &emoji, on).unwrap(),
            Payload::Unknown { .. } => panic!("an implemented kind"),
        };
        assert_eq!(String::from_utf8(written).unwrap(), src, "{}", p["name"]);
    }
}

#[test]
fn unknown_kinds_are_skipped_or_ask_for_an_update() {
    let base = r#""id":"aebagbafaydqqcikbmga2dqpca","dev":"mfrggzdfmztwq2lk","seq":9"#;
    let quiet = format!(r#"{{"v":1,"t":"poll",{base}}}"#);
    let loud = format!(r#"{{"v":1,"t":"poll",{base},"crit":true}}"#);
    let future = format!(r#"{{"v":2,"t":"msg",{base},"body":"x"}}"#);
    for (src, want) in [(quiet, false), (loud, true), (future, false)] {
        match parse_payload(src.as_bytes()).unwrap() {
            Payload::Unknown { critical, seq, .. } => {
                assert_eq!(critical, want);
                assert_eq!(seq, Some(9));
            }
            other => panic!("expected an unknown kind, got {other:?}"),
        }
    }
    // A sender never writes an empty message.
    let empty = format!(r#"{{"v":1,"t":"msg",{base}}}"#);
    let Payload::Msg(m) = parse_payload(empty.as_bytes()).unwrap() else {
        panic!("a msg")
    };
    assert_eq!(code_of(payload::encode_msg(&m)), "invalid-argument");
}

#[test]
fn hpke_key_derivation_matches_rfc_9180() {
    for v in load("hpke-rfc9180.json")["vectors"].as_array().unwrap() {
        let (_, enc) = hpke::derive_key_pair(&unhex(text(&v["ikmE"])));
        assert_eq!(hex(&enc), text(&v["enc"]));
        let (sk, pk) = hpke::derive_key_pair(&unhex(text(&v["ikmR"])));
        assert_eq!(hex(&sk), text(&v["skRm"]));
        assert_eq!(hex(&pk), text(&v["pkRm"]));
    }
}

/// Replays the "random" values a vector lists, in the order the builders draw them.
fn replay(values: Vec<Vec<u8>>) -> impl FnMut(&mut [u8]) {
    let mut it = values.into_iter();
    move |buf: &mut [u8]| {
        let next = it
            .next()
            .expect("the builder drew more randomness than the vector lists");
        assert_eq!(next.len(), buf.len(), "a draw of another size than the vector lists");
        buf.copy_from_slice(&next);
    }
}

fn draws(step: &Value, with_nonce: bool, with_secret: bool) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    if with_nonce {
        out.push(unhex(text(&step["groupNonceHex"])));
    }
    if with_secret {
        out.push(unhex(text(&step["epochSecretHex"])));
    }
    out.push(unhex(text(&step["blob"]["nonceHex"])));
    for k in step["sealedKeys"].as_array().unwrap() {
        out.push(unhex(text(&k["ikmEHex"])));
    }
    out
}

fn check_step(step: &Value, change: &fcd::client::group::GroupChange, server_id: &str) {
    let name = &step["name"];
    assert_eq!(
        String::from_utf8(change.state.payload_bytes.clone()).unwrap(),
        text(&step["state"]["payloadText"]),
        "{name}"
    );
    assert_eq!(
        seal::serialize(&change.state.envelope),
        text(&step["state"]["envelope"]),
        "{name}"
    );
    assert_eq!(
        hex(&change.state.state_hash),
        text(&step["state"]["stateHashHex"]),
        "{name}"
    );
    assert_eq!(hex(&change.secret), text(&step["epochSecretHex"]), "{name}");
    assert_eq!(hex(&change.keys.enc_key), text(&step["encKeyHex"]), "{name}");
    assert_eq!(hex(&change.blob), text(&step["blob"]["blobHex"]), "{name}");
    assert_eq!(change.new_epoch, step["newEpochSecret"].as_bool().unwrap(), "{name}");
    let sealed = step["sealedKeys"].as_array().unwrap();
    assert_eq!(change.sealed_keys.len(), sealed.len(), "{name}");
    for (k, (recipient, env)) in sealed.iter().zip(&change.sealed_keys) {
        let who = user(text(&k["recipient"]));
        assert_eq!(*recipient, who.user_id, "{name}");
        assert_eq!(seal::serialize(env), text(&k["envelope"]), "{name}");
        // The recipient opens the key, decrypts the state it names and checks both.
        let stored = parse_sealed_group_key(text(&k["envelope"])).unwrap();
        let (state, key, keys) = accept_group_key(&stored, &change.blob, &who, server_id, None).unwrap();
        assert_eq!(hex(&key.secret), text(&k["openedSecretHex"]), "{name}");
        assert_eq!(state.state_hash, change.state.state_hash, "{name}");
        assert_eq!(keys.enc_key, change.keys.enc_key, "{name}");
    }
}

/// The three steps of group.json built by the Rust builders: create, transfer, remove.
fn build_group() -> (String, Vec<fcd::client::group::GroupChange>) {
    let v = load("group.json");
    let server_id = text(&v["serverId"]).to_string();
    let steps = v["steps"].as_array().unwrap();
    let (alice, bob, carol) = (user("alice"), user("bob"), user("carol"));

    let created = create_group(
        &server_id,
        &alice,
        "Семья",
        &[member("bob"), member("carol")],
        &mut replay(draws(&steps[0], true, true)),
    )
    .unwrap();
    assert_eq!(created.state.chat_id.to_string(), text(&v["groupId"]["chatId"]));
    check_step(&steps[0], &created, &server_id);

    let transferred = transfer_group_ownership(
        &created.state,
        &alice,
        &created.secret,
        &bob.user_id,
        &mut replay(draws(&steps[1], false, false)),
    )
    .unwrap();
    check_step(&steps[1], &transferred, &server_id);
    assert_eq!(transferred.state.owner, bob.user_id);
    assert_eq!(
        transferred.state.by, alice.user_id,
        "the previous owner signs the transfer"
    );

    let removed = remove_group_members(
        &transferred.state,
        &bob,
        &[carol.user_id],
        &mut replay(draws(&steps[2], false, true)),
    )
    .unwrap();
    check_step(&steps[2], &removed, &server_id);
    assert_eq!(removed.state.epoch, 1);
    (server_id, vec![created, transferred, removed])
}

#[test]
fn group_vectors() {
    let (server_id, steps) = build_group();
    // A member who follows the chain accepts every version in turn with its epoch key.
    let chat = steps[0].state.chat_id;
    let mut prev: Option<GroupState> = None;
    for s in &steps {
        let state = open_group_state(&s.blob, &server_id, &chat, &s.keys, prev.as_ref(), None).unwrap();
        prev = Some(state);
    }
    // Only the owner changes the group.
    let carol = user("carol");
    let r = remove_group_members(
        &steps[0].state,
        &carol,
        &[user("bob").user_id],
        &mut fcd::client::group::system_rng,
    );
    assert_eq!(code_of(r), "not-owner");
}

#[test]
fn negative_group_states_and_keys() {
    let (server_id, steps) = build_group();
    let chat = steps[0].state.chat_id;
    let v = load("negative-groups.json");
    for s in v["groupStates"].as_array().unwrap() {
        let prev = match s.get("prev").and_then(Value::as_str) {
            None => None,
            Some("transfer") => Some(&steps[1].state),
            Some(other) => panic!("unknown prev {other}"),
        };
        let ctx = StateContext {
            server_id: &server_id,
            chat_id: &chat,
            prev,
            expected_hash: None,
        };
        let got = code_of(verify_group_state(&envelope(text(&s["envelope"])), &ctx));
        assert_eq!(got, text(&s["expectedError"]), "{}", s["name"]);
    }
    for k in v["sealedKeys"].as_array().unwrap() {
        let me = user(text(&k["openAs"]));
        let got = code_of(open_group_key(&envelope(text(&k["envelope"])), &me, &server_id));
        assert_eq!(got, text(&k["expectedError"]), "{}", k["name"]);
    }
    for d in v["descriptors"].as_array().unwrap() {
        let got = code_of(validate_attachment(&d["descriptor"], None));
        assert_eq!(got, text(&d["expectedError"]), "{}", d["name"]);
    }
}

fn blob_of(v: &Value) -> BlobRef {
    BlobRef {
        id: BlobId::parse(text(&v["id"])).unwrap(),
        key: b64_decode(text(&v["key"])).unwrap().try_into().unwrap(),
        parts: v["parts"].as_u64().unwrap() as u32,
        part_size: v["partSize"].as_u64().unwrap(),
        size: v["size"].as_u64().unwrap(),
    }
}

/// Byte `j` of a vector's file is `(j * 31 + seed) mod 256`.
fn pattern(from: u64, len: u64, seed: u64) -> Vec<u8> {
    (from..from + len).map(|j| ((j * 31 + seed) % 256) as u8).collect()
}

#[test]
fn attachment_vectors() {
    let v = load("attachment.json");
    let single = &v["single"];
    let blob = blob_of(&single["blob"]);
    let plain = unhex(text(&single["plaintextHex"]));
    assert_eq!(plain, pattern(0, blob.size, single["seed"].as_u64().unwrap()));
    let ct = encrypt_part(&blob, 0, &plain).unwrap();
    assert_eq!(hex(&ct), text(&single["ciphertextHex"]));
    assert_eq!(decrypt_part(&blob, 0, &ct).unwrap(), plain);

    let two = &v["twoParts"];
    let blob2 = blob_of(&two["blob"]);
    let seed = two["seed"].as_u64().unwrap();
    let mut cts = Vec::new();
    for p in two["parts"].as_array().unwrap() {
        let i = p["index"].as_u64().unwrap();
        let len = p["plaintextLength"].as_u64().unwrap();
        let ct = encrypt_part(&blob2, i as u32, &pattern(i * blob2.part_size, len, seed)).unwrap();
        assert_eq!(ct.len() as u64, p["ciphertextLength"].as_u64().unwrap());
        assert_eq!(hex(&Sha256::digest(&ct)), text(&p["ciphertextSha256"]));
        assert_eq!(hex(&ct[ct.len() - 16..]), text(&p["tagHex"]));
        cts.push(ct);
    }
    validate_attachment(&v["descriptor"], None).unwrap();

    for n in load("negative-groups.json")["attachmentParts"].as_array().unwrap() {
        let (blob, parts) = match text(&n["vector"]) {
            "single" => (&blob, vec![ct.clone()]),
            "twoParts" => (&blob2, cts.clone()),
            other => panic!("unknown vector {other}"),
        };
        let mut presented = parts[n["present"].as_u64().unwrap() as usize].clone();
        let name = text(&n["name"]);
        if name.contains("truncated") {
            presented.pop();
        }
        if name.contains("tag altered") {
            *presented.last_mut().unwrap() ^= 1;
        }
        let got = code_of(decrypt_part(blob, n["as"].as_u64().unwrap() as u32, &presented));
        assert_eq!(got, text(&n["expectedError"]), "{name}");
    }
}
