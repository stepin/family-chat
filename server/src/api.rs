//! M1 API: join, devices, users, direct chats, events, push, admin.
//! The exact wire format is documented in docs/API.md.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, FromRequestParts, Path as UrlPath, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::app::{AppState, endpoint_allowed};
use crate::datadir::now_ms;
use crate::envelope::{self, Envelope};
use crate::error::ApiError;
use crate::eventlog::MAX_BODY;
use crate::ids::{ChatId, DevId, MsgId, UserId, b64_decode, b64_encode};
use crate::store::{Appended, Caller, Entry, Issued, JoinCode, Mem, Page, Store, User, env_error};
use crate::webpush::Subscription;

/// Longest long poll, seconds.
pub const MAX_EVENTS_WAIT: u64 = 30;
pub const MAX_EVENTS_LIMIT: usize = 500;
pub const DEFAULT_HISTORY_LIMIT: usize = 200;
/// Upper bound of event bodies (before base64) in one response.
pub const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
/// Largest JSON request body (join, profile, auth, push).
pub const MAX_JSON_BODY: usize = 64 * 1024;

// ---- extractors ----

/// Client address for rate limiting: the TCP peer, or the rightmost
/// `X-Forwarded-For` entry when `trust_forwarded_for` is on.
pub struct ClientIp(pub IpAddr);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<AppState>) -> Result<Self, Infallible> {
        if st.settings.trust_forwarded_for {
            let forwarded = parts
                .headers
                .get_all("x-forwarded-for")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|v| v.split(','))
                .filter_map(|s| s.trim().parse::<IpAddr>().ok())
                .next_back();
            if let Some(ip) = forwarded {
                return Ok(ClientIp(ip));
            }
        }
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        Ok(ClientIp(peer))
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// A member's device, from `Authorization: Bearer <token>`.
pub struct Auth(pub Caller);

impl FromRequestParts<Arc<AppState>> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<AppState>) -> Result<Self, ApiError> {
        let token = bearer(&parts.headers).ok_or_else(|| ApiError::unauthorized("device token required"))?;
        let c = st
            .store
            .caller(token)
            .ok_or_else(|| ApiError::unauthorized("unknown or revoked device token"))?;
        if c.removed {
            return Err(ApiError::forbidden("removed", "removed from the family"));
        }
        Ok(Auth(c))
    }
}

/// An administrator's device.
pub struct Admin(pub Caller);

impl FromRequestParts<Arc<AppState>> for Admin {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<AppState>) -> Result<Self, ApiError> {
        let Auth(c) = Auth::from_request_parts(parts, st).await?;
        if !c.admin {
            return Err(ApiError::forbidden("not_admin", "administrator only"));
        }
        Ok(Admin(c))
    }
}

fn too_large(limit: usize) -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "too_large",
        format!("request body is larger than {limit} bytes"),
    )
    .with("limit", limit.into())
}

async fn read_body(headers: &HeaderMap, body: Body, limit: usize) -> Result<Bytes, ApiError> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit as u64) {
        return Err(too_large(limit));
    }
    match Limited::new(body, limit).collect().await {
        Ok(b) => Ok(b.to_bytes()),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => Err(too_large(limit)),
        Err(_) => Err(ApiError::bad_request("could not read the request body")),
    }
}

async fn read_json<T: DeserializeOwned>(headers: &HeaderMap, body: Body) -> Result<T, ApiError> {
    let bytes = read_body(headers, body, MAX_JSON_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))
}

/// Runs a join/auth step and counts a wrong code or signature for the address.
fn count_failure<T>(st: &AppState, ip: IpAddr, r: Result<T, ApiError>) -> Result<T, ApiError> {
    if let Err(e) = &r
        && e.is_auth_failure()
    {
        st.limiter.fail(ip);
        tracing::info!("неверный код или подпись с адреса {ip}");
    }
    r
}

fn issued_json(i: &Issued) -> Response {
    Json(json!({
        "token": i.token,
        "userId": i.user,
        "devId": i.dev,
        "admin": i.admin,
    }))
    .into_response()
}

// ---- join and devices ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinBody {
    invite: Option<String>,
    admin_code: Option<String>,
    identity: Envelope,
    profile: Envelope,
    dev_id: String,
}

pub async fn join(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    st.limiter.check(ip)?;
    let b: JoinBody = read_json(&headers, body).await?;
    let code = match (b.invite, b.admin_code) {
        (Some(c), None) => JoinCode::Invite(c),
        (None, Some(c)) => JoinCode::Admin(c),
        _ => return Err(ApiError::bad_request("exactly one of invite and adminCode is required")),
    };
    let dev = DevId::parse(&b.dev_id).ok_or_else(|| ApiError::bad_request("bad devId"))?;
    let identity = count_failure(
        &st,
        ip,
        envelope::verify_identity(&b.identity).map_err(|e| env_error(e, "identity")),
    )?;
    let profile = count_failure(
        &st,
        ip,
        envelope::verify_profile(&b.profile, &identity.user_id, &identity.key).map_err(|e| env_error(e, "profile")),
    )?;
    let r = st
        .store
        .write(move |w| w.join(code, identity, profile, dev, now_ms()))
        .await;
    Ok(issued_json(&count_failure(&st, ip, r)?))
}

pub async fn auth_challenge(State(st): State<Arc<AppState>>) -> Response {
    let (nonce, expires) = st.store.new_nonce();
    Json(json!({ "nonce": nonce, "expiresAt": expires })).into_response()
}

pub async fn auth_device(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    st.limiter.check(ip)?;
    let env: Envelope = read_json(&headers, body).await?;
    let req = envelope::parse_auth(&env).map_err(|e| env_error(e, "auth"))?;
    let nonce_ok = st.store.take_nonce(&req.nonce);
    let r = st
        .store
        .write(move |w| w.auth_device(&env, &req, nonce_ok, now_ms()))
        .await;
    Ok(issued_json(&count_failure(&st, ip, r)?))
}

// ---- users ----

fn user_json(m: &Mem, u: &User) -> Value {
    json!({
        "userId": u.id,
        "identity": u.identity.envelope,
        "profile": u.profile.as_ref().map(|p| &p.envelope),
        "admin": m.is_admin(&u.id),
        "removed": u.removed_at.is_some(),
    })
}

fn sorted_users(m: &Mem) -> Vec<&User> {
    let mut v: Vec<&User> = m.users.values().collect();
    v.sort_by_key(|u| u.id.to_string());
    v
}

pub async fn users(State(st): State<Arc<AppState>>, Auth(_): Auth) -> Response {
    let users: Vec<Value> = st
        .store
        .read(|m| sorted_users(m).into_iter().map(|u| user_json(m, u)).collect());
    Json(json!({ "users": users })).into_response()
}

pub async fn me(State(st): State<Arc<AppState>>, Auth(c): Auth) -> Result<Response, ApiError> {
    st.store.read(|m| {
        let u = m
            .users
            .get(&c.user)
            .ok_or_else(|| ApiError::internal("caller vanished"))?;
        let mut v = user_json(m, u);
        v["devId"] = json!(c.dev);
        v["push"] = json!(u.devices.get(&c.dev).is_some_and(|d| d.push.is_some()));
        Ok(Json(v).into_response())
    })
}

pub async fn put_profile(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let env: Envelope = read_json(&headers, body).await?;
    let p = st.store.write(move |w| w.set_profile(&c.user, &env)).await?;
    Ok(Json(json!({ "profile": p.envelope })).into_response())
}

// ---- push subscription ----

fn check_subscription(s: &Subscription) -> Result<(), ApiError> {
    if s.endpoint.len() > 2048 || !endpoint_allowed(&s.endpoint) {
        return Err(ApiError::bad_request("endpoint must be an https URL"));
    }
    let p256dh = b64_decode(s.keys.p256dh.trim_end_matches('='));
    if !p256dh.is_some_and(|k| k.len() == 65 && k[0] == 4) {
        return Err(ApiError::bad_request("keys.p256dh must be an uncompressed P-256 key"));
    }
    if !b64_decode(s.keys.auth.trim_end_matches('=')).is_some_and(|k| k.len() == 16) {
        return Err(ApiError::bad_request("keys.auth must be 16 bytes"));
    }
    Ok(())
}

pub async fn put_push(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    if st.push.is_none() {
        return Err(ApiError::conflict("push_disabled", "push is disabled on this server"));
    }
    let sub: Subscription = read_json(&headers, body).await?;
    check_subscription(&sub)?;
    st.store
        .write(move |w| w.set_push(&c.user, &c.dev, Some(sub), None))
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn delete_push(State(st): State<Arc<AppState>>, Auth(c): Auth) -> Result<Response, ApiError> {
    st.store.write(move |w| w.set_push(&c.user, &c.dev, None, None)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Sends `{"chatId","gseq"}` to every device with a subscription of the
/// chat's other members. Subscriptions reported gone (404/410) are deleted.
fn push_new_event(st: &Arc<AppState>, a: &Appended, sender: UserId) {
    let Some(client) = st.push.clone() else { return };
    let targets: Vec<(UserId, DevId, Subscription)> = st.store.read(|m| {
        let mut out = Vec::new();
        for uid in a.chat.members.iter().filter(|u| **u != sender) {
            let Some(u) = m.users.get(uid).filter(|u| u.removed_at.is_none()) else {
                continue;
            };
            for (dev, d) in &u.devices {
                if let Some(s) = &d.push {
                    out.push((*uid, *dev, s.clone()));
                }
            }
        }
        out
    });
    let payload = json!({ "chatId": a.chat.id, "gseq": a.gseq }).to_string().into_bytes();
    for (uid, dev, sub) in targets {
        let st = st.clone();
        let client = client.clone();
        let payload = payload.clone();
        tokio::spawn(async move {
            match client.send(&st.vapid, &sub, &payload).await {
                Ok(o) if o.status == 404 || o.status == 410 => {
                    tracing::info!(service = %o.service, "подписка на уведомления устройства {dev} больше не действует, удаляю");
                    let ep = sub.endpoint.clone();
                    let _ = st.store.write(move |w| w.set_push(&uid, &dev, None, Some(&ep))).await;
                }
                Ok(o) if !(200..300).contains(&o.status) => {
                    tracing::warn!(service = %o.service, status = o.status, "push-сервис отклонил уведомление");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("уведомление не отправлено: {e}"),
            }
        });
    }
}

// ---- chats and events ----

fn parse_chat(s: &str) -> Result<ChatId, ApiError> {
    ChatId::parse(s).ok_or_else(|| ApiError::bad_request("bad chatId"))
}

fn event_json(e: &Entry, body: &[u8]) -> Value {
    json!({
        "gseq": e.h.gseq,
        "time": e.h.time,
        "chatId": e.h.chat,
        "senderId": e.h.sender,
        "devId": e.h.dev,
        "epoch": e.h.epoch,
        "msgId": e.h.msg,
        "body": b64_encode(body),
    })
}

async fn page_json(store: &Store, page: Page, oldest: u64, cursor_key: &str) -> Result<Response, ApiError> {
    let path = store.path().to_path_buf();
    let events = page.events;
    let bodies = tokio::task::spawn_blocking(move || Store::read_bodies(&path, &events))
        .await
        .map_err(|_| ApiError::internal("reading events failed"))?;
    let events: Vec<Value> = bodies.iter().map(|(e, b)| event_json(e, b)).collect();
    let mut out = json!({
        "events": events,
        "more": page.more,
        "oldestGseq": oldest,
    });
    out[cursor_key] = json!(page.cursor);
    Ok(Json(out).into_response())
}

pub async fn chats(State(st): State<Arc<AppState>>, Auth(c): Auth) -> Response {
    let list: Vec<Value> = st.store.read(|m| {
        let last = m.last_events();
        let mut v: Vec<_> = m.chats.values().filter(|ch| ch.members.contains(&c.user)).collect();
        v.sort_by_key(|ch| ch.id.to_string());
        v.into_iter()
            .map(|ch| {
                let l = last.get(&ch.id);
                json!({
                    "chatId": ch.id,
                    "kind": "dm",
                    "members": ch.members,
                    "epoch": ch.epoch,
                    "createdAt": ch.created_at,
                    "lastGseq": l.map(|e| e.h.gseq),
                    "lastTime": l.map(|e| e.h.time),
                })
            })
            .collect()
    });
    Json(json!({ "chats": list })).into_response()
}

pub async fn post_event(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(chat): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    let msg = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("Idempotency-Key header is required"))
        .and_then(|v| MsgId::parse(v).ok_or_else(|| ApiError::bad_request("bad Idempotency-Key")))?;
    let epoch = headers
        .get("x-fc-epoch")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("X-FC-Epoch header is required"))
        .and_then(|v| v.parse::<u32>().map_err(|_| ApiError::bad_request("bad X-FC-Epoch")))?;
    let body = read_body(&headers, body, MAX_BODY).await?;
    if body.is_empty() {
        return Err(ApiError::bad_request("event body is empty"));
    }
    let a = st
        .store
        .write(move |w| w.append(chat, c.user, c.dev, epoch, msg, &body, now_ms()))
        .await?;
    if !a.duplicate {
        push_new_event(&st, &a, c.user);
    }
    Ok(Json(json!({ "gseq": a.gseq, "time": a.time, "duplicate": a.duplicate })).into_response())
}

#[derive(Deserialize)]
pub struct EventsQuery {
    after: Option<u64>,
    limit: Option<usize>,
    wait: Option<u64>,
}

pub async fn events(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    q: Result<Query<EventsQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(q) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let after = q.after.unwrap_or(0);
    let limit = q.limit.unwrap_or(MAX_EVENTS_LIMIT).clamp(1, MAX_EVENTS_LIMIT);
    let wait = Duration::from_secs(q.wait.unwrap_or(0).min(MAX_EVENTS_WAIT));
    let deadline = tokio::time::Instant::now() + wait;
    let mut changes = st.store.subscribe();
    let mut shutdown = st.shutdown.clone();
    let (page, oldest) = loop {
        changes.borrow_and_update();
        let (removed, page, oldest) = st.store.read(|m| {
            let gone = m
                .users
                .get(&c.user)
                .is_none_or(|u| u.removed_at.is_some() || !u.devices.contains_key(&c.dev));
            (
                gone,
                m.events_after(&c.user, after, limit, MAX_PAGE_BYTES),
                m.oldest_gseq(),
            )
        });
        if removed {
            return Err(ApiError::forbidden("removed", "removed from the family"));
        }
        if !page.events.is_empty() || tokio::time::Instant::now() >= deadline || *shutdown.borrow() {
            break (page, oldest);
        }
        tokio::select! {
            r = changes.changed() => if r.is_err() { break (page, oldest) },
            _ = tokio::time::sleep_until(deadline) => {}
            _ = shutdown.wait_for(|v| *v) => {}
        }
    };
    page_json(&st.store, page, oldest, "cursor").await
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    before: Option<u64>,
    limit: Option<usize>,
}

pub async fn chat_events(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(chat): UrlPath<String>,
    q: Result<Query<HistoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    let Query(q) = q.map_err(|e| ApiError::bad_request(e.body_text()))?;
    let before = q.before.unwrap_or(u64::MAX);
    let limit = q.limit.unwrap_or(DEFAULT_HISTORY_LIMIT).clamp(1, MAX_EVENTS_LIMIT);
    let server_id = st.server_id.clone();
    let (page, oldest) = st.store.read(|m| {
        match m.chats.get(&chat) {
            Some(ch) if ch.members.contains(&c.user) => {}
            Some(_) => return Err(ApiError::forbidden("not_member", "not a member of this chat")),
            None if m.derive_direct(&server_id, &c.user, &chat).is_some() => {}
            None => return Err(ApiError::not_found("chat_not_found", "no such chat")),
        }
        Ok((m.chat_history(&chat, before, limit, MAX_PAGE_BYTES), m.oldest_gseq()))
    })?;
    page_json(&st.store, page, oldest, "cursor").await
}

// ---- admin ----

pub async fn create_invite(State(st): State<Arc<AppState>>, Admin(c): Admin) -> Result<Response, ApiError> {
    let (inv, code) = st.store.write(move |w| w.create_invite(&c.user, now_ms())).await?;
    tracing::info!("администратор {} выпустил приглашение", c.user);
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": inv.id,
            "code": code,
            "createdAt": inv.created_at,
            "expiresAt": inv.expires_at,
        })),
    )
        .into_response())
}

pub async fn list_invites(State(st): State<Arc<AppState>>, Admin(_): Admin) -> Response {
    let list: Vec<Value> = st.store.read(|m| {
        let mut v: Vec<_> = m.invites.values().collect();
        v.sort_by_key(|i| (i.created_at, i.id.clone()));
        v.into_iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "createdAt": i.created_at,
                    "expiresAt": i.expires_at,
                    "createdBy": i.created_by,
                    "usedAt": i.used_at,
                    "usedBy": i.used_by,
                })
            })
            .collect()
    });
    Json(json!({ "invites": list })).into_response()
}

pub async fn delete_invite(
    State(st): State<Arc<AppState>>,
    Admin(_): Admin,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ApiError::bad_request("bad invitation id"));
    }
    st.store.write(move |w| w.delete_invite(&id)).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn admin_users(State(st): State<Arc<AppState>>, Admin(_): Admin) -> Response {
    let list: Vec<Value> = st.store.read(|m| {
        sorted_users(m)
            .into_iter()
            .map(|u| {
                let mut devices: Vec<_> = u.devices.iter().collect();
                devices.sort_by_key(|(_, d)| d.created_at);
                json!({
                    "userId": u.id,
                    "name": u.profile.as_ref().map(|p| p.name.clone()),
                    "admin": m.is_admin(&u.id),
                    "removed": u.removed_at.is_some(),
                    "removedAt": u.removed_at,
                    "devices": devices.into_iter().map(|(id, d)| json!({
                        "devId": id,
                        "createdAt": d.created_at,
                        "push": d.push.is_some(),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect()
    });
    Json(json!({ "users": list })).into_response()
}

pub async fn remove_user(
    State(st): State<Arc<AppState>>,
    Admin(c): Admin,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let user = UserId::parse(&id).ok_or_else(|| ApiError::bad_request("bad userId"))?;
    if user == c.user {
        return Err(ApiError::conflict(
            "cannot_remove_self",
            "an administrator cannot remove themselves",
        ));
    }
    st.store.write(move |w| w.remove_user(&user, now_ms())).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

pub async fn stats(State(st): State<Arc<AppState>>, Admin(_): Admin) -> Result<Response, ApiError> {
    let path = st.store.path().to_path_buf();
    let (data_bytes, space) = tokio::task::spawn_blocking(move || (dir_size(&path), crate::store::disk_space(&path)))
        .await
        .map_err(|_| ApiError::internal("stats failed"))?;
    let v = st.store.read(|m| {
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "dataBytes": data_bytes,
            "freeBytes": space.map(|s| s.0),
            "totalBytes": space.map(|s| s.1),
            "events": m.log.len(),
            "oldestGseq": m.oldest_gseq(),
            "lastGseq": m.last_gseq,
            "users": m.users.values().filter(|u| u.removed_at.is_none()).count(),
            "removedUsers": m.users.values().filter(|u| u.removed_at.is_some()).count(),
            "chats": m.chats.len(),
            "retentionDays": st.settings.retention_days,
            "push": st.settings.push,
        })
    });
    Ok(Json(v).into_response())
}
