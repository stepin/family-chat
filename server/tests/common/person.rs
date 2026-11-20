//! A family member with real keys (an identity from a seed, the way the app
//! makes one): joins, writes and reads events with the client side of the
//! protocol. The other end of the MCP tests.

use std::cell::Cell;

use fcd::client::IdentityKeys;
use fcd::client::blob::{decrypt_part, encrypt_part, new_blob, part_length};
use fcd::client::dm::{ChatKeys, derive_dm_keys};
use fcd::client::event::{EventContext, decode_event, encode_event};
use fcd::client::group::{
    GroupChange, GroupMember, GroupState, accept_group_key, create_group, derive_group_keys, open_group_state,
    parse_sealed_group_key, system_rng,
};
use fcd::client::payload::{
    Attachment, AttachmentKind, BlobRef, Common, Msg, MsgRef, Payload, encode_edit, encode_msg, encode_react,
};
use fcd::client::seal::{self, PeerIdentity, ProfileInput};
use fcd::envelope::Envelope;
use fcd::ids::{ChatId, DevId, MsgId, UserId};
use serde_json::{Value, json};

use super::{Res, TestServer, b64d, env_json, new_dev, request, request_bytes};

pub struct Person {
    pub seed: [u8; 32],
    pub keys: IdentityKeys,
    pub user: UserId,
    pub dev: DevId,
    pub token: String,
    seq: Cell<u64>,
}

/// An event of the feed, decrypted.
pub struct Seen {
    pub gseq: u64,
    pub sender: UserId,
    pub msg: MsgId,
    pub payload: Payload,
}

impl Person {
    /// Joins with a code; `field` is `invite` or `adminCode`.
    pub async fn join(srv: &TestServer, name: &str, field: &str, code: &str) -> Person {
        let seed = fcd::webpush::random_bytes::<32>();
        let keys = IdentityKeys::from_seed(&seed);
        let identity = seal::identity_envelope(&keys, 1);
        let profile = seal::profile_envelope(
            &keys,
            &ProfileInput {
                name,
                avatar: None,
                gender: None,
                rev: 1,
                updated: 1,
            },
        )
        .unwrap();
        let dev = new_dev();
        let mut body = json!({
            "identity": env_json(&identity),
            "profile": env_json(&profile),
            "devId": dev.to_string(),
        });
        body[field] = json!(code);
        let res = request(
            "POST",
            &srv.url("/v1/join"),
            &[("Content-Type", "application/json")],
            Some(&body.to_string()),
        )
        .await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        Person {
            seed,
            user: keys.user_id,
            keys,
            dev,
            token: res.json()["token"].as_str().unwrap().to_string(),
            seq: Cell::new(1),
        }
    }

    /// The administrator and one invited member.
    pub async fn family(srv: &TestServer) -> (Person, Person) {
        let mama = Person::join(srv, "Мама", "adminCode", &srv.setup_code).await;
        let papa = mama.invite(srv, "Папа").await;
        (mama, papa)
    }

    /// Invites and joins one more member (the caller is an administrator).
    pub async fn invite(&self, srv: &TestServer, name: &str) -> Person {
        let res = self.send(srv, "POST", "/v1/admin/invites", Some("{}")).await;
        assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
        Person::join(srv, name, "invite", res.json()["code"].as_str().unwrap()).await
    }

    pub async fn send(&self, srv: &TestServer, method: &str, path: &str, body: Option<&str>) -> Res {
        let auth = format!("Bearer {}", self.token);
        request(
            method,
            &srv.url(path),
            &[("Authorization", &auth), ("Content-Type", "application/json")],
            body,
        )
        .await
    }

    /// The verified identity of a member, from the server's list.
    pub async fn identity_of(&self, srv: &TestServer, user: &UserId) -> PeerIdentity {
        let users = self.send(srv, "GET", "/v1/users", None).await.json();
        let u = users["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["userId"] == user.to_string().as_str())
            .unwrap_or_else(|| panic!("no member {user}"));
        let env: Envelope = serde_json::from_value(u["identity"].clone()).unwrap();
        seal::verify_identity(&env).unwrap()
    }

    async fn chat_with(&self, srv: &TestServer, peer: &UserId) -> (ChatId, ChatKeys, PeerIdentity) {
        let id = self.identity_of(srv, peer).await;
        let keys = derive_dm_keys(&self.keys, peer, &id.box_pub, &srv.server_id()).unwrap();
        (ChatId::direct(&srv.server_id(), &self.user, peer), keys, id)
    }

    fn common(&self) -> Common {
        let seq = self.seq.get();
        self.seq.set(seq + 1);
        Common {
            id: MsgId(fcd::webpush::random_bytes::<16>()),
            dev: self.dev,
            seq,
        }
    }

    async fn post(&self, srv: &TestServer, peer: &UserId, common: &Common, payload: &[u8]) -> u64 {
        let (chat, keys, _) = self.chat_with(srv, peer).await;
        let body = encode_event(
            &EventContext {
                server_id: &srv.server_id(),
                chat_id: &chat.to_string(),
                chat: &keys,
            },
            &self.keys,
            payload,
        )
        .unwrap();
        let auth = format!("Bearer {}", self.token);
        let res = request_bytes(
            "POST",
            &srv.url(&format!("/v1/chats/{chat}/events")),
            &[
                ("Authorization", &auth),
                ("Content-Type", "application/octet-stream"),
                ("Idempotency-Key", &common.id.to_string()),
                ("X-FC-Epoch", "0"),
            ],
            body,
        )
        .await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        res.json()["gseq"].as_u64().unwrap()
    }

    /// Sends a text to the direct chat with `peer`; returns `(gseq, reference)`.
    pub async fn say(&self, srv: &TestServer, peer: &UserId, text: &str) -> (u64, MsgRef) {
        let common = self.common();
        let payload = encode_msg(&Msg {
            common,
            body: Some(text.to_string()),
            reply: None,
            fwd: false,
            attachments: Vec::new(),
            location: None,
            sticker: None,
        })
        .unwrap();
        let gseq = self.post(srv, peer, &common, &payload).await;
        (
            gseq,
            MsgRef {
                author: self.user,
                id: common.id,
            },
        )
    }

    pub async fn react(&self, srv: &TestServer, peer: &UserId, target: &MsgRef, emoji: &str, on: bool) -> u64 {
        let common = self.common();
        let payload = encode_react(&common, target, emoji, on).unwrap();
        self.post(srv, peer, &common, &payload).await
    }

    pub async fn edit(&self, srv: &TestServer, peer: &UserId, target: &MsgRef, text: &str) -> u64 {
        let common = self.common();
        let payload = encode_edit(&common, target, text).unwrap();
        self.post(srv, peer, &common, &payload).await
    }

    /// The raw feed after `after`.
    pub async fn feed(&self, srv: &TestServer, after: u64) -> Vec<Value> {
        let res = self.send(srv, "GET", &format!("/v1/events?after={after}"), None).await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        res.json()["events"].as_array().unwrap().clone()
    }

    /// The events of the direct chat with `peer` after `after`, decrypted and
    /// verified the way the app does it. Records deleted on the server are left out.
    pub async fn read(&self, srv: &TestServer, peer: &UserId, after: u64) -> Vec<Seen> {
        let (chat, keys, id) = self.chat_with(srv, peer).await;
        let (me, my_key, peer_id, peer_key) = (self.user, self.keys.sign_pub, *peer, id.sign_pub);
        let lookup = move |u: &UserId| {
            if *u == me {
                Some(my_key)
            } else if *u == peer_id {
                Some(peer_key)
            } else {
                None
            }
        };
        let mut out = Vec::new();
        for e in self.feed(srv, after).await {
            if e["kind"] != "event" || e["chatId"] != chat.to_string().as_str() || e["deleted"] == true {
                continue;
            }
            let sender = UserId::parse(e["senderId"].as_str().unwrap()).unwrap();
            let d = decode_event(
                &b64d(&e["body"]),
                &EventContext {
                    server_id: &srv.server_id(),
                    chat_id: &chat.to_string(),
                    chat: &keys,
                },
                &lookup,
                Some(&sender),
            )
            .unwrap_or_else(|err| panic!("event {} does not verify: {err}", e["gseq"]));
            assert_eq!(d.msg_id.to_string(), e["msgId"].as_str().unwrap());
            out.push(Seen {
                gseq: e["gseq"].as_u64().unwrap(),
                sender: d.sender,
                msg: d.msg_id,
                payload: d.payload,
            });
        }
        out
    }
}

/// A group as one member's app holds it: the last verified state and the secret of its epoch.
pub struct GroupSide {
    pub chat: ChatId,
    pub state: GroupState,
    pub secret: [u8; 32],
}

impl GroupSide {
    pub fn keys(&self) -> ChatKeys {
        derive_group_keys(&self.secret, self.state.epoch)
    }
}

impl Person {
    pub fn member(&self) -> GroupMember {
        GroupMember {
            user_id: self.user,
            sign_pub: self.keys.sign_pub,
            box_pub: self.keys.box_pub,
        }
    }

    /// A member entry for someone whose keys are on the server only (an MCP helper).
    pub async fn member_of(&self, srv: &TestServer, user: &UserId) -> GroupMember {
        let i = self.identity_of(srv, user).await;
        GroupMember {
            user_id: i.user_id,
            sign_pub: i.sign_pub,
            box_pub: i.box_pub,
        }
    }

    fn group_upload(change: &GroupChange) -> Value {
        let mut members: Vec<String> = change.state.members.iter().map(|m| m.user_id.to_string()).collect();
        members.sort();
        let keys: Vec<Value> = change
            .sealed_keys
            .iter()
            .map(|(u, env)| json!({ "userId": u.to_string(), "key": seal::serialize(env) }))
            .collect();
        json!({
            "state": super::b64e(&change.blob),
            "members": members,
            "epoch": change.state.epoch,
            "keys": keys,
        })
    }

    /// Creates a group this person owns.
    pub async fn create_group(&self, srv: &TestServer, name: &str, others: &[GroupMember]) -> GroupSide {
        let change = create_group(&srv.server_id(), &self.keys, name, others, &mut system_rng).unwrap();
        let mut body = Person::group_upload(&change);
        body["chatId"] = json!(change.state.chat_id.to_string());
        let res = self.send(srv, "POST", "/v1/chats", Some(&body.to_string())).await;
        assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
        GroupSide {
            chat: change.state.chat_id,
            secret: change.secret,
            state: change.state,
        }
    }

    /// Uploads the next state of a group this person owns.
    pub async fn change_group(&self, srv: &TestServer, g: &GroupSide, change: GroupChange) -> GroupSide {
        let mut body = Person::group_upload(&change);
        body["baseVersion"] = json!(g.state.version);
        body["owner"] = json!(change.state.owner.to_string());
        let res = self
            .send(
                srv,
                "PUT",
                &format!("/v1/chats/{}/state", g.chat),
                Some(&body.to_string()),
            )
            .await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        GroupSide {
            chat: g.chat,
            secret: change.secret,
            state: change.state,
        }
    }

    async fn state_blob(&self, srv: &TestServer, chat: &ChatId, version: u64) -> Vec<u8> {
        let auth = format!("Bearer {}", self.token);
        let res = request(
            "GET",
            &srv.url(&format!("/v1/chats/{chat}/state/{version}")),
            &[("Authorization", &auth)],
            None,
        )
        .await;
        assert_eq!(
            res.status,
            200,
            "state {version}: {}",
            String::from_utf8_lossy(&res.body)
        );
        res.body
    }

    /// Opens a group as a member's app does: the newest key sealed to this
    /// person, the state it names, then every later state of the same epoch.
    pub async fn open_group(&self, srv: &TestServer, chat: &ChatId) -> GroupSide {
        let keys = self.send(srv, "GET", "/v1/keys", None).await.json();
        let key = keys["keys"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|k| k["chatId"] == chat.to_string().as_str())
            .max_by_key(|k| k["version"].as_u64())
            .unwrap_or_else(|| panic!("no key for {chat}"))
            .clone();
        let env = parse_sealed_group_key(key["key"].as_str().unwrap()).unwrap();
        let version = key["version"].as_u64().unwrap();
        let blob = self.state_blob(srv, chat, version).await;
        let (mut state, opened, chat_keys) = accept_group_key(&env, &blob, &self.keys, &srv.server_id(), None).unwrap();
        let chats = self.send(srv, "GET", "/v1/chats", None).await.json();
        let current = chats["chats"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["chatId"] == chat.to_string().as_str())
            .map_or(version, |c| c["version"].as_u64().unwrap());
        for v in version + 1..=current {
            let blob = self.state_blob(srv, chat, v).await;
            match open_group_state(&blob, &srv.server_id(), chat, &chat_keys, Some(&state), None) {
                Ok(next) => state = next,
                Err(_) => break,
            }
        }
        GroupSide {
            chat: *chat,
            state,
            secret: opened.secret,
        }
    }

    async fn post_to(&self, srv: &TestServer, chat: &ChatId, keys: &ChatKeys, common: &Common, payload: &[u8]) -> Res {
        let body = encode_event(
            &EventContext {
                server_id: &srv.server_id(),
                chat_id: &chat.to_string(),
                chat: keys,
            },
            &self.keys,
            payload,
        )
        .unwrap();
        let auth = format!("Bearer {}", self.token);
        request_bytes(
            "POST",
            &srv.url(&format!("/v1/chats/{chat}/events")),
            &[
                ("Authorization", &auth),
                ("Content-Type", "application/octet-stream"),
                ("Idempotency-Key", &common.id.to_string()),
                ("X-FC-Epoch", &keys.epoch.to_string()),
            ],
            body,
        )
        .await
    }

    /// Sends a text into a group; returns `(gseq, reference)`.
    pub async fn say_group(&self, srv: &TestServer, g: &GroupSide, text: &str) -> (u64, MsgRef) {
        let common = self.common();
        let payload = encode_msg(&Msg {
            common,
            body: Some(text.to_string()),
            reply: None,
            fwd: false,
            attachments: Vec::new(),
            location: None,
            sticker: None,
        })
        .unwrap();
        let res = self.post_to(srv, &g.chat, &g.keys(), &common, &payload).await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        (
            res.json()["gseq"].as_u64().unwrap(),
            MsgRef {
                author: self.user,
                id: common.id,
            },
        )
    }

    /// The group's events of the state's epoch after `after`, decrypted and
    /// verified against the members the signed state lists.
    pub async fn read_group(&self, srv: &TestServer, g: &GroupSide, after: u64) -> Vec<Seen> {
        let keys = g.keys();
        let state = &g.state;
        let lookup = |u: &UserId| state.member(u).map(|m| m.sign_pub);
        let mut out = Vec::new();
        for e in self.feed(srv, after).await {
            if e["kind"] != "event" || e["chatId"] != g.chat.to_string().as_str() || e["deleted"] == true {
                continue;
            }
            if e["epoch"].as_u64() != Some(u64::from(state.epoch)) {
                continue;
            }
            let sender = UserId::parse(e["senderId"].as_str().unwrap()).unwrap();
            let d = decode_event(
                &b64d(&e["body"]),
                &EventContext {
                    server_id: &srv.server_id(),
                    chat_id: &g.chat.to_string(),
                    chat: &keys,
                },
                &lookup,
                Some(&sender),
            )
            .unwrap_or_else(|err| panic!("group event {} does not verify: {err}", e["gseq"]));
            out.push(Seen {
                gseq: e["gseq"].as_u64().unwrap(),
                sender: d.sender,
                msg: d.msg_id,
                payload: d.payload,
            });
        }
        out
    }
}

// ---- files, as a member's app handles them ----

impl Person {
    /// Encrypts and uploads a file; returns its reference.
    pub async fn upload(&self, srv: &TestServer, data: &[u8]) -> BlobRef {
        let blob = new_blob(data.len() as u64, None).unwrap();
        let auth = format!("Bearer {}", self.token);
        let mut at = 0usize;
        for index in 0..blob.parts {
            let len = part_length(&blob, index).unwrap() as usize;
            let part = encrypt_part(&blob, index, &data[at..at + len]).unwrap();
            at += len;
            let res = request_bytes(
                "PUT",
                &srv.url(&format!("/v1/blobs/{}/{index}", blob.id)),
                &[("Authorization", &auth), ("Content-Type", "application/octet-stream")],
                part,
            )
            .await;
            assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        }
        blob
    }

    /// Downloads and decrypts a file. `None` when the server no longer has it.
    pub async fn download(&self, srv: &TestServer, blob: &BlobRef) -> Option<Vec<u8>> {
        let auth = format!("Bearer {}", self.token);
        let mut out = Vec::new();
        for index in 0..blob.parts {
            let res = request(
                "GET",
                &srv.url(&format!("/v1/blobs/{}/{index}", blob.id)),
                &[("Authorization", &auth)],
                None,
            )
            .await;
            if res.status != 200 {
                return None;
            }
            out.extend_from_slice(&decrypt_part(blob, index, &res.body).expect("the part decrypts"));
        }
        Some(out)
    }

    /// Sends a file to the direct chat with `peer`; returns `(gseq, reference)`.
    pub async fn say_file(
        &self,
        srv: &TestServer,
        peer: &UserId,
        name: &str,
        mime: &str,
        data: &[u8],
    ) -> (u64, MsgRef) {
        let blob = self.upload(srv, data).await;
        let common = self.common();
        let payload = encode_msg(&Msg {
            common,
            body: None,
            reply: None,
            fwd: false,
            attachments: vec![Attachment {
                blob,
                name: name.to_string(),
                mime: mime.to_string(),
                kind: AttachmentKind::File,
                w: None,
                h: None,
                thumb: None,
                dur: None,
                peaks: None,
            }],
            location: None,
            sticker: None,
        })
        .unwrap();
        let gseq = self.post(srv, peer, &common, &payload).await;
        (
            gseq,
            MsgRef {
                author: self.user,
                id: common.id,
            },
        )
    }

    /// An Ed25519 key for envelopes the test kit signs (sticker packs).
    pub fn signing_key(&self) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&self.keys.sign_secret())
    }
}

/// An MCP connection as an assistant uses it: a token and JSON-RPC calls.
pub struct Mcp {
    pub id: String,
    pub token: String,
    pub user: UserId,
}

impl Mcp {
    async fn create(srv: &TestServer, by: &Person, body: Value) -> Mcp {
        let res = by.send(srv, "POST", "/v1/mcp", Some(&body.to_string())).await;
        assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
        let j = res.json();
        Mcp {
            id: j["connection"]["id"].as_str().unwrap().to_string(),
            token: j["token"].as_str().unwrap().to_string(),
            user: UserId::parse(j["connection"]["userId"].as_str().unwrap()).unwrap(),
        }
    }

    /// A helper with its own identity, created by an administrator.
    pub async fn helper(srv: &TestServer, admin: &Person, name: &str) -> Mcp {
        Mcp::create(srv, admin, json!({ "mode": "helper", "name": name })).await
    }

    /// The member's own identity.
    pub async fn me(srv: &TestServer, p: &Person, name: &str) -> Mcp {
        Mcp::create(
            srv,
            p,
            json!({ "mode": "me", "name": name, "seed": super::b64e(&p.seed) }),
        )
        .await
    }

    /// Sets the access levels (by whoever manages the connection).
    pub async fn set_levels(&self, srv: &TestServer, by: &Person, levels: &[&str]) {
        let body = json!({ "levels": levels }).to_string();
        let res = by.send(srv, "PUT", &format!("/v1/mcp/{}", self.id), Some(&body)).await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    }

    /// One request of revision 2026-07-28 (version, method and name repeated in headers).
    pub async fn rpc(&self, srv: &TestServer, method: &str, mut params: Value) -> Res {
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1" },
        });
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let auth = format!("Bearer {}", self.token);
        let name = params["name"].as_str().unwrap_or("").to_string();
        let mut headers = vec![
            ("Authorization", auth.as_str()),
            ("Content-Type", "application/json"),
            ("Accept", "application/json, text/event-stream"),
            ("MCP-Protocol-Version", "2026-07-28"),
            ("Mcp-Method", method),
        ];
        if method == "tools/call" {
            headers.push(("Mcp-Name", name.as_str()));
        }
        request("POST", &srv.url("/mcp"), &headers, Some(&body)).await
    }

    /// Calls a tool: `Ok` with what it returned, `Err` with `{"error","message"}`.
    pub async fn call(&self, srv: &TestServer, tool: &str, args: Value) -> Result<Value, Value> {
        let res = self
            .rpc(srv, "tools/call", json!({ "name": tool, "arguments": args }))
            .await;
        assert_eq!(res.status, 200, "{tool}: {}", String::from_utf8_lossy(&res.body));
        let j = res.json();
        let result = &j["result"];
        assert_eq!(result["resultType"], "complete", "{j}");
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("{tool}: {j}"));
        let v: Value = serde_json::from_str(text).unwrap();
        if result["isError"] == true { Err(v) } else { Ok(v) }
    }

    /// Calls a tool that must succeed.
    pub async fn ok(&self, srv: &TestServer, tool: &str, args: Value) -> Value {
        self.call(srv, tool, args.clone())
            .await
            .unwrap_or_else(|e| panic!("{tool}({args}) failed: {e}"))
    }

    /// Calls a tool that must fail; returns the error code.
    pub async fn err(&self, srv: &TestServer, tool: &str, args: Value) -> String {
        match self.call(srv, tool, args.clone()).await {
            Ok(v) => panic!("{tool}({args}) should fail, got {v}"),
            Err(e) => e["error"].as_str().unwrap().to_string(),
        }
    }
}
