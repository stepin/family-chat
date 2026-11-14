//! Groups (docs/PLAN-v2.md, 7.4): creation, state changes with a version
//! precondition, leaving, sealed keys. The state document and the sealed
//! keys are opaque bytes; the server keeps only the routing data (members,
//! owner, version, epoch) in `chats/<id>/meta.json`.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{Auth, chat_json, parse_chat, read_body};
use crate::app::AppState;
use crate::datadir::{create_private_dir, now_ms};
use crate::error::{ApiError, io_error};
use crate::ids::{ChatId, UserId, b64_decode};
use crate::notice::Notice;
use crate::store::{Chat, ChatKind, GroupChange, Period, Writer};

/// Largest state document, bytes.
pub const MAX_STATE_BYTES: usize = 256 * 1024;
/// Largest sealed key (an opaque string, UTF-8 bytes).
pub const MAX_SEALED_KEY_BYTES: usize = 8192;
/// Most members in a group.
pub const MAX_MEMBERS: usize = 100;
/// Largest body of `POST /v1/chats` and `PUT /v1/chats/<id>/state`.
pub const MAX_GROUP_BODY: usize = 1024 * 1024;
/// Most keys in one `GET /v1/keys` answer.
pub const MAX_KEYS_LIMIT: usize = 500;

/// Decoded `POST /v1/chats`.
pub struct NewGroup {
    pub chat: ChatId,
    pub state: Vec<u8>,
    pub members: Vec<UserId>,
    pub epoch: u32,
    pub keys: Vec<(UserId, String)>,
}

/// Decoded `PUT /v1/chats/<id>/state`.
pub struct StateChange {
    pub base_version: u64,
    pub state: Vec<u8>,
    pub members: Vec<UserId>,
    pub owner: UserId,
    pub epoch: u32,
    pub keys: Vec<(UserId, String)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealedKeyIn {
    user_id: UserId,
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    chat_id: ChatId,
    state: String,
    members: Vec<UserId>,
    epoch: u32,
    keys: Vec<SealedKeyIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeBody {
    base_version: u64,
    state: String,
    members: Vec<UserId>,
    owner: UserId,
    epoch: u32,
    keys: Vec<SealedKeyIn>,
}

fn decode_state(s: &str) -> Result<Vec<u8>, ApiError> {
    let b = b64_decode(s).ok_or_else(|| ApiError::bad_request("state must be base64url"))?;
    if b.is_empty() || b.len() > MAX_STATE_BYTES {
        return Err(ApiError::bad_request(format!(
            "state must be 1 to {MAX_STATE_BYTES} bytes"
        )));
    }
    Ok(b)
}

fn sorted_members(mut v: Vec<UserId>) -> Result<Vec<UserId>, ApiError> {
    if v.is_empty() || v.len() > MAX_MEMBERS {
        return Err(ApiError::bad_request(format!(
            "members must list 1 to {MAX_MEMBERS} users"
        )));
    }
    v.sort_by_key(|u| u.to_string());
    let n = v.len();
    v.dedup();
    if v.len() != n {
        return Err(ApiError::bad_request("members has repeats"));
    }
    Ok(v)
}

/// Sealed keys are opaque strings (the protocol puts a serialized
/// `group-key` envelope there); the server stores and returns them as is.
fn decode_keys(keys: Vec<SealedKeyIn>) -> Result<Vec<(UserId, String)>, ApiError> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(keys.len());
    for k in keys {
        if !seen.insert(k.user_id) {
            return Err(ApiError::bad_request("keys has two entries for one user"));
        }
        if k.key.is_empty() || k.key.len() > MAX_SEALED_KEY_BYTES {
            return Err(ApiError::bad_request(format!(
                "keys[].key must be 1 to {MAX_SEALED_KEY_BYTES} bytes"
            )));
        }
        out.push((k.user_id, k.key));
    }
    Ok(out)
}

fn bad_member(u: &UserId) -> ApiError {
    ApiError::bad_request(format!("{u} is not a current member of the family")).code("bad_member")
}

fn key_users(keys: &[(UserId, String)]) -> HashSet<UserId> {
    keys.iter().map(|(u, _)| *u).collect()
}

impl Writer {
    fn state_path(&self, chat: &ChatId, version: u64) -> std::path::PathBuf {
        self.chat_dir(chat).join("state").join(format!("{version}.enc"))
    }

    fn write_state(&self, chat: &ChatId, version: u64, bytes: &[u8]) -> Result<(), ApiError> {
        let dir = self.chat_dir(chat).join("state");
        create_private_dir(&dir).map_err(|e| io_error("создание папки состояния", e))?;
        // A file with this number can only be an orphan of a change that
        // crashed before `meta.json` was written: overwriting it is safe.
        self.write_file(&self.state_path(chat, version), bytes)
    }

    fn require_active(&self, users: &[UserId]) -> Result<(), ApiError> {
        let m = self.mem();
        for u in users {
            if !m.users.get(u).is_some_and(|x| x.active()) {
                return Err(bad_member(u));
            }
        }
        Ok(())
    }

    /// Writes the change notice; a failure is logged (the change itself is
    /// already committed).
    fn notice_after_commit(&mut self, c: &Chat, n: Notice, now: u64) -> Option<u64> {
        match self.write_notice(c.id, c.epoch, n, now) {
            Ok(g) => Some(g),
            Err(e) => {
                tracing::error!("служебное событие группы {} не записано: {}", c.id, e.message);
                None
            }
        }
    }

    /// `POST /v1/chats`. Order on disk: state, keys, `meta.json` (the
    /// commit point), notice.
    pub fn create_group(&mut self, by: UserId, g: NewGroup, now: u64) -> Result<GroupChange, ApiError> {
        {
            let sid = self.server_id().to_string();
            let m = self.mem();
            if m.chats.contains_key(&g.chat) || m.is_direct_id(&sid, &g.chat) {
                return Err(ApiError::conflict("chat_exists", "this chatId is already taken"));
            }
        }
        if !g.members.contains(&by) {
            return Err(ApiError::bad_request("members must include the creator"));
        }
        self.require_active(&g.members)?;
        if key_users(&g.keys) != g.members.iter().copied().collect() {
            return Err(ApiError::bad_request(
                "keys must have exactly one sealed key per member",
            ));
        }
        self.check_space_pub()?;
        let gseq = self.mem().last_gseq + 1;
        let chat = Chat {
            id: g.chat,
            kind: ChatKind::Group,
            periods: g
                .members
                .iter()
                .map(|u| Period {
                    user_id: *u,
                    from: gseq,
                    to: None,
                })
                .collect(),
            members: g.members,
            created_at: now,
            epoch: g.epoch,
            owner: Some(by),
            version: 1,
        };
        self.write_state(&chat.id, 1, &g.state)?;
        let keys = self.write_keys(&chat.id, chat.epoch, 1, &g.keys, now)?;
        self.write_meta(&chat)?;
        {
            let mut m = self.mem_mut();
            m.chats.insert(chat.id, chat.clone());
            Writer::commit_keys(&mut m, keys);
        }
        tracing::info!("создана группа {} ({} участн.)", chat.id, chat.members.len());
        let notice = self.notice_after_commit(&chat, Notice::group_created(&by, &chat), now);
        Ok(GroupChange { chat, notice })
    }

    /// `PUT /v1/chats/<id>/state`: only the owner, only from the current
    /// version. Runs on the single writer, so two changes from the same
    /// version cannot both succeed.
    pub fn change_state(
        &mut self,
        by: UserId,
        chat_id: ChatId,
        ch: StateChange,
        now: u64,
    ) -> Result<GroupChange, ApiError> {
        let old = {
            let m = self.mem();
            let c = m
                .chats
                .get(&chat_id)
                .ok_or_else(|| ApiError::not_found("chat_not_found", "no such chat"))?;
            if c.kind != ChatKind::Group {
                return Err(ApiError::bad_request("not a group"));
            }
            if !c.is_member(&by) {
                return Err(ApiError::forbidden("not_member", "not a member of this chat"));
            }
            if c.owner != Some(by) {
                return Err(ApiError::forbidden(
                    "not_owner",
                    "only the group owner can change its state",
                ));
            }
            c.clone()
        };
        if ch.base_version != old.version {
            return Err(
                ApiError::conflict("stale_version", format!("the current state version is {}", old.version))
                    .with("version", old.version.into()),
            );
        }
        let bump = match ch.epoch {
            e if e == old.epoch => false,
            e if Some(e) == old.epoch.checked_add(1) => true,
            _ => {
                return Err(
                    ApiError::bad_request("epoch must be the current one or the next").with("epoch", old.epoch.into())
                );
            }
        };
        if !ch.members.contains(&ch.owner) {
            return Err(ApiError::bad_request("the owner must be a member"));
        }
        let added: Vec<UserId> = ch.members.iter().filter(|u| !old.is_member(u)).copied().collect();
        let removed: Vec<UserId> = old
            .members
            .iter()
            .filter(|u| !ch.members.contains(u))
            .copied()
            .collect();
        self.require_active(&added)?;
        if ch.owner != by {
            self.require_active(&[ch.owner])?;
        }
        let with_keys = key_users(&ch.keys);
        if with_keys.iter().any(|u| !ch.members.contains(u)) {
            return Err(ApiError::bad_request("keys may only be sealed for members"));
        }
        if bump && with_keys != ch.members.iter().copied().collect() {
            return Err(ApiError::bad_request(
                "a new epoch needs exactly one sealed key per member",
            ));
        }
        if !removed.is_empty() && !bump {
            return Err(ApiError::bad_request("removing a member needs a new epoch").with("epoch", old.epoch.into()));
        }
        if added.iter().any(|u| !with_keys.contains(u)) {
            return Err(ApiError::bad_request("every added member needs a sealed key"));
        }
        self.check_space_pub()?;
        let gseq = self.mem().last_gseq + 1;
        let mut chat = old;
        chat.version += 1;
        chat.epoch = ch.epoch;
        chat.owner = Some(ch.owner);
        chat.members = ch.members;
        for p in chat.periods.iter_mut() {
            if p.to.is_none() && removed.contains(&p.user_id) {
                p.to = Some(gseq);
            }
        }
        chat.periods.extend(added.iter().map(|u| Period {
            user_id: *u,
            from: gseq,
            to: None,
        }));
        self.write_state(&chat.id, chat.version, &ch.state)?;
        let keys = self.write_keys(&chat.id, chat.epoch, chat.version, &ch.keys, now)?;
        self.write_meta(&chat)?;
        {
            let mut m = self.mem_mut();
            m.chats.insert(chat.id, chat.clone());
            Writer::commit_keys(&mut m, keys);
        }
        let notice = self.notice_after_commit(&chat, Notice::group_state(&by, &chat, &added, &removed), now);
        Ok(GroupChange { chat, notice })
    }

    /// `POST /v1/chats/<id>/leave`: removed from delivery at once.
    pub fn leave_group(&mut self, by: UserId, chat_id: ChatId, now: u64) -> Result<GroupChange, ApiError> {
        let old = {
            let m = self.mem();
            let c = m
                .chats
                .get(&chat_id)
                .ok_or_else(|| ApiError::not_found("chat_not_found", "no such chat"))?;
            if c.kind != ChatKind::Group {
                return Err(ApiError::bad_request("not a group"));
            }
            if !c.is_member(&by) {
                return Err(ApiError::forbidden("not_member", "not a member of this chat"));
            }
            if c.owner == Some(by) {
                return Err(ApiError::conflict(
                    "owner_cannot_leave",
                    "the owner must transfer ownership before leaving",
                ));
            }
            c.clone()
        };
        let gseq = self.mem().last_gseq + 1;
        let mut chat = old;
        chat.members.retain(|u| *u != by);
        for p in chat.periods.iter_mut() {
            if p.user_id == by && p.to.is_none() {
                p.to = Some(gseq);
            }
        }
        self.write_meta(&chat)?;
        self.mem_mut().chats.insert(chat.id, chat.clone());
        let notice = self.notice_after_commit(&chat, Notice::member_left(&by, &chat), now);
        Ok(GroupChange { chat, notice })
    }
}

// ---- handlers ----

fn chat_response(st: &AppState, status: StatusCode, c: &Chat) -> Response {
    let v = st.store.read(|m| chat_json(c, m.last_events().get(&c.id)));
    (status, Json(v)).into_response()
}

pub async fn create(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let bytes = read_body(&headers, body, MAX_GROUP_BODY).await?;
    let b: CreateBody =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))?;
    let g = NewGroup {
        chat: b.chat_id,
        state: decode_state(&b.state)?,
        members: sorted_members(b.members)?,
        epoch: b.epoch,
        keys: decode_keys(b.keys)?,
    };
    let r = st.store.write(move |w| w.create_group(c.user, g, now_ms())).await?;
    Ok(chat_response(&st, StatusCode::CREATED, &r.chat))
}

pub async fn change(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(chat): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    let bytes = read_body(&headers, body, MAX_GROUP_BODY).await?;
    let b: ChangeBody =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))?;
    let ch = StateChange {
        base_version: b.base_version,
        state: decode_state(&b.state)?,
        members: sorted_members(b.members)?,
        owner: b.owner,
        epoch: b.epoch,
        keys: decode_keys(b.keys)?,
    };
    let r = st
        .store
        .write(move |w| w.change_state(c.user, chat, ch, now_ms()))
        .await?;
    Ok(chat_response(&st, StatusCode::OK, &r.chat))
}

pub async fn leave(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(chat): UrlPath<String>,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    st.store.write(move |w| w.leave_group(c.user, chat, now_ms())).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn get_state(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath((chat, version)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    let version = crate::api::parse_decimal(&version).ok_or_else(|| ApiError::bad_request("bad version"))?;
    st.store.read(|m| match m.chats.get(&chat) {
        Some(ch) if ch.kind != ChatKind::Group => Err(ApiError::bad_request("not a group")),
        Some(ch) if !ch.is_member(&c.user) => Err(ApiError::forbidden("not_member", "not a member of this chat")),
        Some(ch) if version == 0 || version > ch.version => {
            Err(ApiError::not_found("not_found", "no such state version"))
        }
        Some(_) => Ok(()),
        None => Err(ApiError::not_found("chat_not_found", "no such chat")),
    })?;
    let path = st
        .store
        .path()
        .join("chats")
        .join(chat.to_string())
        .join("state")
        .join(format!("{version}.enc"));
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found("not_found", "no such state version"));
        }
        Err(e) => return Err(io_error("чтение состояния группы", e)),
    };
    let mut res = Response::new(Body::from(bytes));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(res)
}

#[derive(Deserialize)]
pub struct KeysQuery {
    after: Option<u64>,
    limit: Option<usize>,
}

pub async fn keys(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    q: Result<Query<KeysQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(q) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let after = q.after.unwrap_or(0);
    let limit = q.limit.unwrap_or(MAX_KEYS_LIMIT).clamp(1, MAX_KEYS_LIMIT);
    let (list, more) = st.store.read(|m| m.keys_after(&c.user, after, limit));
    let cursor = list.last().map_or(after, |k| k.n);
    let keys: Vec<Value> = list
        .iter()
        .map(|k| {
            json!({
                "n": k.n,
                "chatId": k.chat,
                "epoch": k.epoch,
                "version": k.version,
                "time": k.created_at,
                "key": k.key,
            })
        })
        .collect();
    Ok(Json(json!({ "keys": keys, "cursor": cursor, "more": more })).into_response())
}
