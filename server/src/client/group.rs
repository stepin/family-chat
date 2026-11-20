//! Groups (docs/PROTOCOL.md, sections 14 and 15): the self-certifying group
//! id, the signed state with its ownership chain, the encrypted state blob,
//! the sealed epoch key and the owner's changes.
//!
//! ```text
//! chatId   = base32(SHA-256("fc/v1/group-id\n" || lp(creatorSignPub) || lp(nonce))[0..16])
//! state    = envelope "group-state" signed by the owner the chain yields for this version
//! transfer = Ed25519(previous owner, "fc/v1/group-transfer\n" || lp(serverId) || lp(chatId)
//!                    || u32 version || lp(fromSignPub) || lp(toSignPub))
//! blob     = "FCS" || 0x01 || u32 epoch || u32 version || serverTag(8) || chatTag(8) || nonce(12)
//!            || AES-256-GCM(encKey, nonce, u32 len || envelope JSON || zeros to 256, AAD)
//! key info = "fc/v1/group-key\n" || lp(serverId) || lp(chatId) || u32 epoch || lp(recipient)
//!            || u32 stateVersion || lp(stateHash)
//! ```

use serde_json::Value;

use super::bytes::{GCM_NONCE_BYTES, GCM_TAG_BYTES, cat, ct_eq, gcm_open, gcm_seal, is_zero, lp, read_u32, u32be};
use super::dm::{ChatKeys, derive_enc_key};
use super::error::{Code, Result, err, invalid, malformed};
use super::event::{PADDING_BLOCK, chat_tag, server_tag};
use super::hpke;
use super::json::{Obj, Writer, b32, b64, context_string_ok, js_trim, list, name_problem, parse_object, u32_of};
use super::keys::{IdentityKeys, check_sign_pub, sha256, verify};
use super::seal::{self, Kind, MAX_NAME_CHARS, Opened};
use crate::envelope::Envelope;
use crate::ids::{ChatId, UserId, b64_encode};

pub const MAX_GROUP_MEMBERS: usize = 100;
pub const MAX_STATE_BLOB_BYTES: usize = 131072;
pub const STATE_HEADER_BYTES: usize = 28;
const STATE_MAGIC: &[u8; 3] = b"FCS";
const STATE_FORMAT: u8 = 0x01;
const STATE_OVERHEAD: usize = STATE_HEADER_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES;
const LABEL_GROUP_ID: &[u8] = b"fc/v1/group-id\n";
const LABEL_GROUP_TRANSFER: &[u8] = b"fc/v1/group-transfer\n";
const LABEL_GROUP_KEY: &[u8] = b"fc/v1/group-key\n";
/// The sealed epoch secret: 32 bytes and the tag.
const SEALED_BYTES: usize = 48;

/// A member as the state lists it: identity keys bound to the userId.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMember {
    pub user_id: UserId,
    pub sign_pub: [u8; 32],
    pub box_pub: [u8; 32],
}

/// One ownership transfer, signed by the owner before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupTransfer {
    /// Version of the state that introduced the transfer.
    pub version: u32,
    pub to: UserId,
    pub to_sign_pub: [u8; 32],
    pub sig: [u8; 64],
}

/// A verified group state.
#[derive(Debug, Clone)]
pub struct GroupState {
    pub server_id: String,
    pub chat_id: ChatId,
    pub version: u32,
    pub epoch: u32,
    pub name: String,
    pub creator_sign_pub: [u8; 32],
    pub creator_nonce: [u8; 16],
    /// Owner after all transfers; only the owner writes the next version.
    pub owner: UserId,
    /// Who signed this version: the owner before a transfer this version introduces.
    pub by: UserId,
    pub by_sign_pub: [u8; 32],
    pub transfers: Vec<GroupTransfer>,
    /// Sorted by userId text, unique, includes the owner.
    pub members: Vec<GroupMember>,
    /// stateHash of the previous version; `None` for version 1.
    pub prev: Option<[u8; 32]>,
    /// SHA-256 of the exact payload bytes.
    pub state_hash: [u8; 32],
    pub payload_bytes: Vec<u8>,
    pub envelope: Envelope,
}

impl GroupState {
    pub fn member(&self, id: &UserId) -> Option<&GroupMember> {
        self.members.iter().find(|m| m.user_id == *id)
    }
}

pub fn group_chat_id(creator_sign_pub: &[u8; 32], nonce: &[u8; 16]) -> ChatId {
    let h = sha256(&cat(&[LABEL_GROUP_ID, &lp(creator_sign_pub), &lp(nonce)]));
    ChatId(h[..16].try_into().expect("16 bytes"))
}

/// Keys of an epoch: `encKey = HKDF(secret, "fc/v1/enc")`, as for direct chats.
pub fn derive_group_keys(secret: &[u8; 32], epoch: u32) -> ChatKeys {
    ChatKeys {
        epoch,
        enc_key: derive_enc_key(secret),
    }
}

pub fn transfer_signing_input(server_id: &str, chat_id: &str, version: u32, from: &[u8; 32], to: &[u8; 32]) -> Vec<u8> {
    cat(&[
        LABEL_GROUP_TRANSFER,
        &lp(server_id.as_bytes()),
        &lp(chat_id.as_bytes()),
        &u32be(version),
        &lp(from),
        &lp(to),
    ])
}

// ---- state payload ----

/// What a state says, before it is signed.
pub struct StateFields<'a> {
    pub server_id: &'a str,
    pub chat_id: ChatId,
    pub version: u32,
    pub epoch: u32,
    pub name: &'a str,
    pub creator_sign_pub: [u8; 32],
    pub nonce: [u8; 16],
    pub owner: UserId,
    pub transfers: &'a [GroupTransfer],
    pub members: &'a [GroupMember],
    pub prev: Option<[u8; 32]>,
}

/// Serialises and signs a state. Key order: `v, serverId, chatId, version,
/// epoch, name, creator, owner, by, transfers, members, prev`; members are
/// sorted by userId text.
pub fn encode_group_state(f: &StateFields<'_>, signer: &IdentityKeys) -> Result<Envelope> {
    let mut members: Vec<&GroupMember> = f.members.iter().collect();
    members.sort_by_key(|m| m.user_id.to_string());
    let creator = Writer::new()
        .str("signPub", &b64_encode(&f.creator_sign_pub))
        .str("nonce", &b64_encode(&f.nonce))
        .finish();
    let transfers: Vec<String> = f
        .transfers
        .iter()
        .map(|t| {
            Writer::new()
                .num("version", u64::from(t.version))
                .str("to", &t.to.to_string())
                .str("toSignPub", &b64_encode(&t.to_sign_pub))
                .str("sig", &b64_encode(&t.sig))
                .finish()
        })
        .collect();
    let members: Vec<String> = members
        .iter()
        .map(|m| {
            Writer::new()
                .str("userId", &m.user_id.to_string())
                .str("signPub", &b64_encode(&m.sign_pub))
                .str("boxPub", &b64_encode(&m.box_pub))
                .finish()
        })
        .collect();
    let prev = match &f.prev {
        None => "null".to_string(),
        Some(h) => super::json::quote(&b64_encode(h)),
    };
    let payload = Writer::new()
        .num("v", 1)
        .str("serverId", f.server_id)
        .str("chatId", &f.chat_id.to_string())
        .num("version", u64::from(f.version))
        .num("epoch", u64::from(f.epoch))
        .str("name", f.name)
        .raw("creator", &creator)
        .str("owner", &f.owner.to_string())
        .str("by", &signer.user_id.to_string())
        .raw("transfers", &list(&transfers))
        .raw("members", &list(&members))
        .raw("prev", &prev)
        .finish();
    seal::seal_bytes(Kind::GroupState, payload.as_bytes(), signer)
}

fn user_id(v: Option<&Value>, what: &str) -> Result<UserId> {
    b32::<16>(v)
        .map(UserId)
        .ok_or_else(|| malformed(format!("{what}: expected a userId")))
}

fn key32(v: Option<&Value>, what: &str) -> Result<[u8; 32]> {
    b64::<32>(v).ok_or_else(|| malformed(format!("{what}: expected 32 bytes")))
}

fn parse_members(v: Option<&Value>) -> Result<Vec<GroupMember>> {
    let list = v
        .and_then(Value::as_array)
        .filter(|l| !l.is_empty() && l.len() <= MAX_GROUP_MEMBERS);
    let list = list.ok_or_else(|| malformed(format!("state: members must be a list of 1..{MAX_GROUP_MEMBERS}")))?;
    let mut out: Vec<GroupMember> = Vec::with_capacity(list.len());
    for m in list {
        let m = m
            .as_object()
            .ok_or_else(|| malformed("state: member must be an object"))?;
        let member = GroupMember {
            user_id: user_id(m.get("userId"), "member userId")?,
            sign_pub: key32(m.get("signPub"), "member signPub")?,
            box_pub: key32(m.get("boxPub"), "member boxPub")?,
        };
        if out
            .last()
            .is_some_and(|l| l.user_id.to_string() >= member.user_id.to_string())
        {
            return Err(malformed("state: members must be sorted by userId and unique"));
        }
        out.push(member);
    }
    Ok(out)
}

fn parse_transfers(v: Option<&Value>) -> Result<Vec<GroupTransfer>> {
    let list = v
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("state: transfers must be a list"))?;
    list.iter()
        .map(|t| {
            let t = t
                .as_object()
                .ok_or_else(|| malformed("state: transfer must be an object"))?;
            Ok(GroupTransfer {
                version: u32_of(t.get("version")).ok_or_else(|| malformed("transfer: version must be a u32"))?,
                to: user_id(t.get("to"), "transfer to")?,
                to_sign_pub: key32(t.get("toSignPub"), "transfer toSignPub")?,
                sig: b64::<64>(t.get("sig")).ok_or_else(|| malformed("transfer sig: expected 64 bytes"))?,
            })
        })
        .collect()
}

/// What a state is checked against.
pub struct StateContext<'a> {
    pub server_id: &'a str,
    pub chat_id: &'a ChatId,
    /// The previous accepted state; when given, the new one must follow it.
    pub prev: Option<&'a GroupState>,
    /// stateHash from a sealed key; when given, the state must have exactly this hash.
    pub expected_hash: Option<&'a [u8; 32]>,
}

/// Checks a group state envelope by the rules of section 14.3, in their order.
pub fn verify_group_state(env: &Envelope, ctx: &StateContext<'_>) -> Result<GroupState> {
    let o = seal::open(env, Kind::GroupState)?;
    let j = &o.json;
    let server_id = j
        .get("serverId")
        .and_then(Value::as_str)
        .filter(|s| context_string_ok(s));
    let server_id = server_id.ok_or_else(|| malformed("state: bad serverId"))?;
    let chat_id = ChatId(b32::<16>(j.get("chatId")).ok_or_else(|| malformed("state: bad chatId"))?);
    let version = u32_of(j.get("version")).filter(|v| *v >= 1);
    let version = version.ok_or_else(|| malformed("state: version must be a u32 of at least 1"))?;
    let epoch = u32_of(j.get("epoch")).ok_or_else(|| malformed("state: epoch must be a u32"))?;
    let name = j
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("state: name must be a string"))?;
    if let Some(p) = name_problem(name, MAX_NAME_CHARS) {
        return Err(malformed(format!("state: {p}")));
    }
    let creator = j.get("creator").and_then(Value::as_object);
    let creator = creator.ok_or_else(|| malformed("state: creator must be an object"))?;
    let creator_sign_pub = key32(creator.get("signPub"), "creator signPub")?;
    let nonce = b64::<16>(creator.get("nonce")).ok_or_else(|| malformed("creator nonce: expected 16 bytes"))?;
    let owner = user_id(j.get("owner"), "state owner")?;
    let by = user_id(j.get("by"), "state by")?;
    let transfers = parse_transfers(j.get("transfers"))?;
    let members = parse_members(j.get("members"))?;
    let prev = match j.get("prev") {
        Some(Value::Null) => None,
        other => Some(key32(other, "state prev")?),
    };
    if (version == 1) != prev.is_none() {
        return Err(malformed("state: prev must be null exactly for version 1"));
    }

    if server_id != ctx.server_id {
        return Err(err(Code::WrongServer, "state belongs to another server"));
    }
    if chat_id != *ctx.chat_id {
        return Err(err(Code::WrongChat, "state belongs to another chat"));
    }
    let state_hash = sha256(&o.bytes);
    if ctx.expected_hash.is_some_and(|h| !ct_eq(h, &state_hash)) {
        return Err(err(Code::StateMismatch, "state hash differs from the expected one"));
    }
    for m in &members {
        if UserId::from_sign_pub(&m.sign_pub) != m.user_id {
            return Err(err(Code::UserIdMismatch, "member userId does not match signPub"));
        }
        check_sign_pub(&m.sign_pub)?;
    }

    // Origin: the chat id comes from the creator key, then every transfer is
    // signed by the owner before it.
    let bad_chain = |m: &str| err(Code::BadChain, format!("ownership chain: {m}"));
    if group_chat_id(&creator_sign_pub, &nonce) != chat_id {
        return Err(err(Code::BadChain, "chatId is not derived from the creator key"));
    }
    check_sign_pub(&creator_sign_pub).map_err(|_| bad_chain("creator key is invalid"))?;
    let chat_text = chat_id.to_string();
    let mut cur = (UserId::from_sign_pub(&creator_sign_pub), creator_sign_pub);
    let mut signer = cur;
    let mut last_version = 1u32;
    for t in &transfers {
        if t.version <= last_version || t.version > version {
            return Err(bad_chain(
                "transfer versions must grow and not exceed the state version",
            ));
        }
        if UserId::from_sign_pub(&t.to_sign_pub) != t.to {
            return Err(bad_chain("transfer target does not match its key"));
        }
        check_sign_pub(&t.to_sign_pub).map_err(|_| bad_chain("transfer target key is invalid"))?;
        if t.to == cur.0 {
            return Err(bad_chain("transfer to the current owner"));
        }
        let input = transfer_signing_input(server_id, &chat_text, t.version, &cur.1, &t.to_sign_pub);
        if !verify(&t.sig, &input, &cur.1) {
            return Err(bad_chain("transfer is not signed by the previous owner"));
        }
        if t.version < version {
            signer = (t.to, t.to_sign_pub);
        }
        cur = (t.to, t.to_sign_pub);
        last_version = t.version;
    }
    if owner != cur.0 {
        return Err(bad_chain("owner is not the end of the chain"));
    }
    if !members.iter().any(|m| m.user_id == owner) {
        return Err(malformed("state: the owner must be a member"));
    }
    if by != signer.0 {
        return Err(err(Code::NotOwner, "state is not signed by the owner"));
    }
    seal::check_sig(&o, Kind::GroupState, &signer.1)?;

    let state = GroupState {
        server_id: server_id.to_string(),
        chat_id,
        version,
        epoch,
        name: name.to_string(),
        creator_sign_pub,
        creator_nonce: nonce,
        owner,
        by,
        by_sign_pub: signer.1,
        transfers,
        members,
        prev,
        state_hash,
        payload_bytes: o.bytes,
        envelope: o.env,
    };
    if let Some(p) = ctx.prev {
        check_transition(p, &state)?;
    }
    Ok(state)
}

fn check_transition(p: &GroupState, s: &GroupState) -> Result<()> {
    let bad = |m: &str| err(Code::InvalidTransition, format!("state transition: {m}"));
    let chain = |m: &str| err(Code::BadChain, format!("ownership chain: {m}"));
    if p.server_id != s.server_id || p.chat_id != s.chat_id {
        return Err(bad("another group"));
    }
    if p.creator_sign_pub != s.creator_sign_pub || p.creator_nonce != s.creator_nonce {
        return Err(bad("creator changed"));
    }
    if p.version.checked_add(1) != Some(s.version) {
        return Err(bad("version must be the previous version + 1"));
    }
    if s.prev != Some(p.state_hash) {
        return Err(bad("prev is not the hash of the previous state"));
    }
    if s.transfers.len() < p.transfers.len() || s.transfers.len() > p.transfers.len() + 1 {
        return Err(chain("must extend the previous chain by at most one transfer"));
    }
    if p.transfers.iter().zip(&s.transfers).any(|(a, b)| a != b) {
        return Err(chain("earlier transfers changed"));
    }
    if s.transfers
        .get(p.transfers.len())
        .is_some_and(|t| t.version != s.version)
    {
        return Err(chain("a new transfer must belong to this version"));
    }
    if s.by != p.owner {
        return Err(err(
            Code::NotOwner,
            "change is not signed by the owner of the previous state",
        ));
    }
    if s.epoch != p.epoch && Some(s.epoch) != p.epoch.checked_add(1) {
        return Err(bad("epoch must stay or grow by one"));
    }
    let removed = p.members.iter().any(|m| s.member(&m.user_id).is_none());
    if removed && Some(s.epoch) != p.epoch.checked_add(1) {
        return Err(bad("removing a member requires a new epoch"));
    }
    // A member's keys never change inside one group (a new key is a new identity).
    if s.members
        .iter()
        .any(|m| p.member(&m.user_id).is_some_and(|old| old != m))
    {
        return Err(bad("member keys changed"));
    }
    Ok(())
}

// ---- encrypted state blob ----

fn state_header(server_id: &str, chat_id: &str, epoch: u32, version: u32) -> Vec<u8> {
    cat(&[
        STATE_MAGIC,
        &[STATE_FORMAT],
        &u32be(epoch),
        &u32be(version),
        &server_tag(server_id),
        &chat_tag(chat_id),
    ])
}

fn state_aad(header: &[u8], server_id: &str, chat_id: &str) -> Vec<u8> {
    cat(&[header, &lp(server_id.as_bytes()), &lp(chat_id.as_bytes())])
}

/// Encrypts a verified state with its epoch key and a caller-chosen nonce.
pub fn encrypt_group_state(state: &GroupState, keys: &ChatKeys, nonce: &[u8; GCM_NONCE_BYTES]) -> Result<Vec<u8>> {
    if state.epoch != keys.epoch {
        return Err(invalid("keys belong to another epoch"));
    }
    let env = seal::serialize(&state.envelope);
    let used = 4 + env.len();
    let mut plaintext = vec![0u8; used.div_ceil(PADDING_BLOCK) * PADDING_BLOCK];
    plaintext[..4].copy_from_slice(&u32be(env.len() as u32));
    plaintext[4..used].copy_from_slice(env.as_bytes());
    if STATE_OVERHEAD + plaintext.len() > MAX_STATE_BLOB_BYTES {
        return Err(err(Code::TooLarge, "state is too large"));
    }
    let chat = state.chat_id.to_string();
    let header = state_header(&state.server_id, &chat, state.epoch, state.version);
    let ct = gcm_seal(
        &keys.enc_key,
        nonce,
        &state_aad(&header, &state.server_id, &chat),
        &plaintext,
    );
    Ok(cat(&[&header, nonce, &ct]))
}

/// Epoch and version from the clear header of a state blob, to pick the key.
pub fn read_state_header(blob: &[u8]) -> Result<(u32, u32)> {
    if blob.len() < STATE_HEADER_BYTES {
        return Err(malformed("state blob: too short"));
    }
    if &blob[..3] != STATE_MAGIC {
        return Err(malformed("state blob: bad magic"));
    }
    if blob[3] != STATE_FORMAT {
        return Err(err(Code::UnsupportedVersion, "state blob format is not supported"));
    }
    Ok((read_u32(blob, 4), read_u32(blob, 8)))
}

/// Decrypts and checks a state blob (section 14.4), then everything
/// `verify_group_state` checks, and that the clear header matches the signed
/// version and epoch.
pub fn open_group_state(
    blob: &[u8],
    server_id: &str,
    chat_id: &ChatId,
    keys: &ChatKeys,
    prev: Option<&GroupState>,
    expected_hash: Option<&[u8; 32]>,
) -> Result<GroupState> {
    if blob.len() > MAX_STATE_BLOB_BYTES {
        return Err(err(Code::TooLarge, "state blob exceeds the size limit"));
    }
    if blob.len() < STATE_OVERHEAD + PADDING_BLOCK || !(blob.len() - STATE_OVERHEAD).is_multiple_of(PADDING_BLOCK) {
        return Err(malformed("state blob: invalid length"));
    }
    let (epoch, version) = read_state_header(blob)?;
    if epoch != keys.epoch {
        return Err(err(Code::WrongEpoch, "state blob belongs to another epoch"));
    }
    let chat = chat_id.to_string();
    if !ct_eq(&blob[12..20], &server_tag(server_id)) {
        return Err(err(Code::WrongServer, "state blob belongs to another server"));
    }
    if !ct_eq(&blob[20..28], &chat_tag(&chat)) {
        return Err(err(Code::WrongChat, "state blob belongs to another chat"));
    }
    let header = &blob[..STATE_HEADER_BYTES];
    let nonce: [u8; GCM_NONCE_BYTES] = blob[STATE_HEADER_BYTES..STATE_HEADER_BYTES + GCM_NONCE_BYTES]
        .try_into()
        .expect("12 bytes");
    let plaintext = gcm_open(
        &keys.enc_key,
        &nonce,
        &state_aad(header, server_id, &chat),
        &blob[STATE_HEADER_BYTES + GCM_NONCE_BYTES..],
    )
    .ok_or_else(|| err(Code::WrongKey, "state blob does not decrypt with this epoch key"))?;
    let len = read_u32(&plaintext, 0) as usize;
    if len > plaintext.len() - 4 {
        return Err(malformed("state blob: length exceeds plaintext"));
    }
    let used = 4 + len;
    if used.div_ceil(PADDING_BLOCK) * PADDING_BLOCK != plaintext.len() {
        return Err(malformed("state blob: padding is not minimal"));
    }
    if !is_zero(&plaintext[used..]) {
        return Err(malformed("state blob: padding is not zero"));
    }
    let env_json = parse_object(&plaintext[4..used], "state envelope")?;
    let env = seal::envelope_of(&Value::Object(env_json))?;
    let state = verify_group_state(
        &env,
        &StateContext {
            server_id,
            chat_id,
            prev,
            expected_hash,
        },
    )?;
    if state.version != version || state.epoch != epoch {
        return Err(malformed("state blob: header does not match the signed state"));
    }
    Ok(state)
}

// ---- sealed epoch key ----

/// Public fields of a sealed key, readable without decrypting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupKeyHeader {
    pub server_id: String,
    pub chat_id: ChatId,
    pub epoch: u32,
    pub recipient: UserId,
    pub state_version: u32,
    pub state_hash: [u8; 32],
    pub by: UserId,
}

/// A sealed key opened by its recipient. Holds the epoch secret.
pub struct OpenedGroupKey {
    pub header: GroupKeyHeader,
    pub secret: [u8; 32],
    pub envelope: Envelope,
}

pub fn group_key_info(h: &GroupKeyHeader) -> Vec<u8> {
    cat(&[
        LABEL_GROUP_KEY,
        &lp(h.server_id.as_bytes()),
        &lp(h.chat_id.to_string().as_bytes()),
        &u32be(h.epoch),
        &lp(h.recipient.to_string().as_bytes()),
        &u32be(h.state_version),
        &lp(&h.state_hash),
    ])
}

/// Seals an epoch secret for one member with a chosen HPKE ephemeral seed.
/// `header.by` is ignored: the signer is `signer`.
pub fn seal_group_key_with(
    header: &GroupKeyHeader,
    secret: &[u8; 32],
    recipient_box_pub: &[u8; 32],
    signer: &IdentityKeys,
    ikm_e: &[u8; 32],
) -> Result<Envelope> {
    if !context_string_ok(&header.server_id) || header.state_version < 1 {
        return Err(invalid("group key: bad serverId or stateVersion"));
    }
    let (enc, ct) = hpke::seal_with(recipient_box_pub, &group_key_info(header), &[], secret, ikm_e)?;
    let payload = Writer::new()
        .num("v", 1)
        .str("serverId", &header.server_id)
        .str("chatId", &header.chat_id.to_string())
        .num("epoch", u64::from(header.epoch))
        .str("recipient", &header.recipient.to_string())
        .num("stateVersion", u64::from(header.state_version))
        .str("stateHash", &b64_encode(&header.state_hash))
        .str("by", &signer.user_id.to_string())
        .str("enc", &b64_encode(&enc))
        .str("ct", &b64_encode(&ct))
        .finish();
    seal::seal_bytes(Kind::GroupKey, payload.as_bytes(), signer)
}

struct ParsedKey {
    opened: Opened,
    header: GroupKeyHeader,
    enc: [u8; 32],
    ct: [u8; SEALED_BYTES],
}

fn parse_key(env: &Envelope) -> Result<ParsedKey> {
    let opened = seal::open(env, Kind::GroupKey)?;
    let j: &Obj = &opened.json;
    let server_id = j
        .get("serverId")
        .and_then(Value::as_str)
        .filter(|s| context_string_ok(s));
    let header = GroupKeyHeader {
        server_id: server_id
            .ok_or_else(|| malformed("group key: bad serverId"))?
            .to_string(),
        chat_id: ChatId(b32::<16>(j.get("chatId")).ok_or_else(|| malformed("group key: bad chatId"))?),
        epoch: u32_of(j.get("epoch")).ok_or_else(|| malformed("group key: epoch must be a u32"))?,
        recipient: user_id(j.get("recipient"), "group key recipient")?,
        state_version: u32_of(j.get("stateVersion"))
            .filter(|v| *v >= 1)
            .ok_or_else(|| malformed("group key: stateVersion must be a positive u32"))?,
        state_hash: key32(j.get("stateHash"), "group key stateHash")?,
        by: user_id(j.get("by"), "group key by")?,
    };
    let enc = key32(j.get("enc"), "group key enc")?;
    let ct = b64::<SEALED_BYTES>(j.get("ct")).ok_or_else(|| malformed("group key ct: expected 48 bytes"))?;
    Ok(ParsedKey {
        opened,
        header,
        enc,
        ct,
    })
}

/// The sealed key as the server stores it: the JSON text of the envelope.
pub fn parse_sealed_group_key(text: &str) -> Result<Envelope> {
    let v: Value = serde_json::from_str(text).map_err(|_| malformed("group key: not JSON"))?;
    seal::envelope_of(&v)
}

/// Public fields of a sealed key, without decrypting or checking the signature.
pub fn read_group_key(env: &Envelope) -> Result<GroupKeyHeader> {
    Ok(parse_key(env)?.header)
}

/// Opens a sealed key addressed to `me` (section 15.3). The owner's
/// signature needs the state and is checked by `verify_group_key`.
pub fn open_group_key(env: &Envelope, me: &IdentityKeys, server_id: &str) -> Result<OpenedGroupKey> {
    let k = parse_key(env)?;
    if k.header.server_id != server_id {
        return Err(err(Code::WrongServer, "group key belongs to another server"));
    }
    if k.header.recipient != me.user_id {
        return Err(err(Code::WrongRecipient, "group key is addressed to another member"));
    }
    let secret = hpke::open(&k.enc, me.box_secret(), &group_key_info(&k.header), &[], &k.ct)
        .ok()
        .and_then(|s| <[u8; 32]>::try_from(s).ok())
        .ok_or_else(|| err(Code::WrongKey, "group key does not open for this member and context"))?;
    Ok(OpenedGroupKey {
        header: k.header,
        secret,
        envelope: k.opened.env,
    })
}

/// Checks an opened key against the verified state it refers to.
pub fn verify_group_key(key: &OpenedGroupKey, state: &GroupState) -> Result<()> {
    // The signed fields are read from the envelope again, not from the copy in memory.
    let k = parse_key(&key.envelope)?;
    if k.header.server_id != state.server_id {
        return Err(err(Code::WrongServer, "group key belongs to another server"));
    }
    if k.header.chat_id != state.chat_id {
        return Err(err(Code::WrongChat, "group key belongs to another chat"));
    }
    if k.header.state_version != state.version || !ct_eq(&k.header.state_hash, &state.state_hash) {
        return Err(err(Code::StateMismatch, "group key refers to another state"));
    }
    if k.header.epoch != state.epoch {
        return Err(err(Code::WrongEpoch, "group key belongs to another epoch"));
    }
    if k.header.by != state.by {
        return Err(err(Code::NotOwner, "group key is not signed by the owner"));
    }
    seal::check_sig(&k.opened, Kind::GroupKey, &state.by_sign_pub)
}

/// A newcomer's entry point: opens a sealed key, decrypts the state it
/// refers to and checks both against each other.
pub fn accept_group_key(
    sealed: &Envelope,
    state_blob: &[u8],
    me: &IdentityKeys,
    server_id: &str,
    prev: Option<&GroupState>,
) -> Result<(GroupState, OpenedGroupKey, ChatKeys)> {
    let key = open_group_key(sealed, me, server_id)?;
    let keys = derive_group_keys(&key.secret, key.header.epoch);
    let state = open_group_state(
        state_blob,
        server_id,
        &key.header.chat_id,
        &keys,
        prev,
        Some(&key.header.state_hash),
    )?;
    verify_group_key(&key, &state)?;
    Ok((state, key, keys))
}

// ---- the owner's changes ----

/// Source of randomness: fills the buffer. Only tests pass anything but the system one.
pub type Rng<'a> = &'a mut dyn FnMut(&mut [u8]);

pub fn system_rng(buf: &mut [u8]) {
    getrandom::fill(buf).expect("operating system random number generator failed");
}

fn draw<const N: usize>(rng: Rng<'_>) -> [u8; N] {
    let mut out = [0u8; N];
    rng(&mut out);
    out
}

/// Everything the owner uploads for one change: the state blob and the sealed keys.
pub struct GroupChange {
    pub state: GroupState,
    /// Encrypted state, as the server stores it.
    pub blob: Vec<u8>,
    /// Epoch secret of `state.epoch` (new when `new_epoch`). A secret.
    pub secret: [u8; 32],
    pub keys: ChatKeys,
    pub new_epoch: bool,
    /// Sealed keys for the members who need the secret of `state.epoch`.
    pub sealed_keys: Vec<(UserId, Envelope)>,
}

fn check_name(name: &str) -> Result<&str> {
    let n = js_trim(name);
    match name_problem(n, MAX_NAME_CHARS) {
        Some(p) => Err(invalid(format!("group name: {p}"))),
        None => Ok(n),
    }
}

fn check_member(m: &GroupMember) -> Result<()> {
    if UserId::from_sign_pub(&m.sign_pub) != m.user_id {
        return Err(err(Code::UserIdMismatch, "member userId does not match signPub"));
    }
    check_sign_pub(&m.sign_pub)
}

fn check_owner(prev: &GroupState, owner: &IdentityKeys) -> Result<()> {
    if owner.user_id != prev.owner {
        return Err(err(Code::NotOwner, "only the owner can change the group"));
    }
    Ok(())
}

struct Next<'a> {
    epoch: u32,
    name: &'a str,
    members: Vec<GroupMember>,
    owner: UserId,
    transfers: Vec<GroupTransfer>,
    secret: [u8; 32],
    /// Members who get a sealed key: everyone on a new epoch, or only newcomers.
    seal_for: Vec<GroupMember>,
}

/// Signs the next version, checks it as a receiver would, encrypts it and seals the secret.
fn finish(
    prev: Option<&GroupState>,
    server_id: &str,
    chat_id: ChatId,
    creator: ([u8; 32], [u8; 16]),
    next: Next<'_>,
    signer: &IdentityKeys,
    rng: Rng<'_>,
) -> Result<GroupChange> {
    if next.members.len() > MAX_GROUP_MEMBERS {
        return Err(err(
            Code::TooLarge,
            format!("a group has at most {MAX_GROUP_MEMBERS} members"),
        ));
    }
    let version = match prev {
        None => 1,
        Some(p) => p
            .version
            .checked_add(1)
            .ok_or_else(|| invalid("state version overflow"))?,
    };
    let envelope = encode_group_state(
        &StateFields {
            server_id,
            chat_id,
            version,
            epoch: next.epoch,
            name: next.name,
            creator_sign_pub: creator.0,
            nonce: creator.1,
            owner: next.owner,
            transfers: &next.transfers,
            members: &next.members,
            prev: prev.map(|p| p.state_hash),
        },
        signer,
    )?;
    let state = verify_group_state(
        &envelope,
        &StateContext {
            server_id,
            chat_id: &chat_id,
            prev,
            expected_hash: None,
        },
    )?;
    let keys = derive_group_keys(&next.secret, state.epoch);
    let blob = encrypt_group_state(&state, &keys, &draw::<GCM_NONCE_BYTES>(rng))?;
    let mut sealed_keys = Vec::with_capacity(next.seal_for.len());
    for m in &next.seal_for {
        let header = GroupKeyHeader {
            server_id: state.server_id.clone(),
            chat_id: state.chat_id,
            epoch: state.epoch,
            recipient: m.user_id,
            state_version: state.version,
            state_hash: state.state_hash,
            by: signer.user_id,
        };
        let env = seal_group_key_with(&header, &next.secret, &m.box_pub, signer, &draw::<32>(rng))?;
        sealed_keys.push((m.user_id, env));
    }
    Ok(GroupChange {
        new_epoch: prev.is_none_or(|p| p.epoch != state.epoch),
        state,
        blob,
        secret: next.secret,
        keys,
        sealed_keys,
    })
}

fn creator_of(prev: &GroupState) -> ([u8; 32], [u8; 16]) {
    (prev.creator_sign_pub, prev.creator_nonce)
}

/// Creates a group: version 1, epoch 0, a new secret sealed to every member,
/// the owner included (for the owner's other devices).
pub fn create_group(
    server_id: &str,
    owner: &IdentityKeys,
    name: &str,
    others: &[GroupMember],
    rng: Rng<'_>,
) -> Result<GroupChange> {
    if !context_string_ok(server_id) {
        return Err(invalid("serverId must be a string of 1 to 256 bytes"));
    }
    let name = check_name(name)?;
    let mut members = vec![GroupMember {
        user_id: owner.user_id,
        sign_pub: owner.sign_pub,
        box_pub: owner.box_pub,
    }];
    for m in others {
        check_member(m)?;
        if m.user_id == owner.user_id {
            continue;
        }
        if members.iter().any(|x| x.user_id == m.user_id) {
            return Err(invalid("duplicate member"));
        }
        members.push(m.clone());
    }
    let nonce = draw::<16>(rng);
    let chat_id = group_chat_id(&owner.sign_pub, &nonce);
    let secret = draw::<32>(rng);
    let next = Next {
        epoch: 0,
        name,
        seal_for: members.clone(),
        members,
        owner: owner.user_id,
        transfers: Vec::new(),
        secret,
    };
    finish(None, server_id, chat_id, (owner.sign_pub, nonce), next, owner, rng)
}

/// Renames the group: same epoch, no new keys.
pub fn rename_group(
    prev: &GroupState,
    owner: &IdentityKeys,
    secret: &[u8; 32],
    name: &str,
    rng: Rng<'_>,
) -> Result<GroupChange> {
    check_owner(prev, owner)?;
    let next = Next {
        epoch: prev.epoch,
        name: check_name(name)?,
        members: prev.members.clone(),
        owner: prev.owner,
        transfers: prev.transfers.clone(),
        secret: *secret,
        seal_for: Vec::new(),
    };
    finish(
        Some(prev),
        &prev.server_id,
        prev.chat_id,
        creator_of(prev),
        next,
        owner,
        rng,
    )
}

/// Adds members. `history: true` keeps the epoch (newcomers get the current
/// secret and read this epoch's history); `false` starts a new epoch with a
/// new secret sealed to everyone.
pub fn add_group_members(
    prev: &GroupState,
    owner: &IdentityKeys,
    secret: &[u8; 32],
    new_members: &[GroupMember],
    history: bool,
    rng: Rng<'_>,
) -> Result<GroupChange> {
    check_owner(prev, owner)?;
    if new_members.is_empty() {
        return Err(invalid("no members to add"));
    }
    let mut added: Vec<GroupMember> = Vec::new();
    for m in new_members {
        check_member(m)?;
        if prev.member(&m.user_id).is_some() || added.iter().any(|x| x.user_id == m.user_id) {
            return Err(invalid("member is already in the group"));
        }
        added.push(m.clone());
    }
    let members: Vec<GroupMember> = prev.members.iter().cloned().chain(added.iter().cloned()).collect();
    let (epoch, secret) = if history {
        (prev.epoch, *secret)
    } else {
        let epoch = prev.epoch.checked_add(1).ok_or_else(|| invalid("epoch overflow"))?;
        (epoch, draw::<32>(rng))
    };
    let next = Next {
        epoch,
        name: &prev.name,
        seal_for: if history { added } else { members.clone() },
        members,
        owner: prev.owner,
        transfers: prev.transfers.clone(),
        secret,
    };
    finish(
        Some(prev),
        &prev.server_id,
        prev.chat_id,
        creator_of(prev),
        next,
        owner,
        rng,
    )
}

/// Removes members: a new epoch and a new secret sealed to those who remain.
pub fn remove_group_members(
    prev: &GroupState,
    owner: &IdentityKeys,
    user_ids: &[UserId],
    rng: Rng<'_>,
) -> Result<GroupChange> {
    check_owner(prev, owner)?;
    if user_ids.is_empty() {
        return Err(invalid("no members to remove"));
    }
    for id in user_ids {
        if prev.member(id).is_none() {
            return Err(invalid("not a member"));
        }
        if *id == prev.owner {
            return Err(invalid("the owner cannot be removed; transfer ownership first"));
        }
    }
    let members: Vec<GroupMember> = prev
        .members
        .iter()
        .filter(|m| !user_ids.contains(&m.user_id))
        .cloned()
        .collect();
    let epoch = prev.epoch.checked_add(1).ok_or_else(|| invalid("epoch overflow"))?;
    let secret = draw::<32>(rng);
    let next = Next {
        epoch,
        name: &prev.name,
        seal_for: members.clone(),
        members,
        owner: prev.owner,
        transfers: prev.transfers.clone(),
        secret,
    };
    finish(
        Some(prev),
        &prev.server_id,
        prev.chat_id,
        creator_of(prev),
        next,
        owner,
        rng,
    )
}

/// Transfers ownership: a version signed by the current owner that names the new one.
pub fn transfer_group_ownership(
    prev: &GroupState,
    owner: &IdentityKeys,
    secret: &[u8; 32],
    to: &UserId,
    rng: Rng<'_>,
) -> Result<GroupChange> {
    check_owner(prev, owner)?;
    let target = prev
        .member(to)
        .ok_or_else(|| invalid("the new owner must be a member"))?;
    if target.user_id == prev.owner {
        return Err(invalid("already the owner"));
    }
    let version = prev
        .version
        .checked_add(1)
        .ok_or_else(|| invalid("state version overflow"))?;
    let input = transfer_signing_input(
        &prev.server_id,
        &prev.chat_id.to_string(),
        version,
        &owner.sign_pub,
        &target.sign_pub,
    );
    let mut transfers = prev.transfers.clone();
    transfers.push(GroupTransfer {
        version,
        to: target.user_id,
        to_sign_pub: target.sign_pub,
        sig: owner.sign(&input),
    });
    let next = Next {
        epoch: prev.epoch,
        name: &prev.name,
        members: prev.members.clone(),
        owner: target.user_id,
        transfers,
        secret: *secret,
        seal_for: Vec::new(),
    };
    finish(
        Some(prev),
        &prev.server_id,
        prev.chat_id,
        creator_of(prev),
        next,
        owner,
        rng,
    )
}

/// Members the signed state lists and the server's delivery list lacks, and the reverse.
pub fn compare_group_members(state: &GroupState, server_members: &[UserId]) -> (Vec<UserId>, Vec<UserId>) {
    let missing = state
        .members
        .iter()
        .map(|m| m.user_id)
        .filter(|id| !server_members.contains(id))
        .collect();
    let extra = server_members
        .iter()
        .copied()
        .filter(|id| state.member(id).is_none())
        .collect();
    (missing, extra)
}
