//! API: join, devices, users, profiles and avatars, revocation, chats and
//! events, push, admin. Groups are in `groups.rs`, attachments in
//! `blobs.rs`. The exact wire format is documented in docs/API.md.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, FromRequestParts, Path as UrlPath, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::app::{AppState, endpoint_allowed};
use crate::datadir::now_ms;
use crate::envelope::ImageKind;
use crate::envelope::{self, Envelope};
use crate::error::ApiError;
use crate::eventlog::MAX_BODY;
use crate::ids::{ChatId, DevId, MsgId, UserId, b64_decode, b64_encode};
use crate::store::{
    Appended, Caller, Chat, ChatKind, Entry, Issued, JoinCode, Mem, NOTICE_SENDER, Page, Store, User, env_error,
    invite_hash,
};
use crate::webpush::Subscription;

/// Longest long poll, seconds.
pub const MAX_EVENTS_WAIT: u64 = 30;
pub const MAX_EVENTS_LIMIT: usize = 500;
pub const DEFAULT_HISTORY_LIMIT: usize = 200;
/// Upper bound of event bodies (before base64) in one response.
pub const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
/// Largest JSON request body (join, profile, auth, push).
pub const MAX_JSON_BODY: usize = 64 * 1024;
/// Largest avatar image, bytes.
pub const MAX_AVATAR_BYTES: usize = 256 * 1024;

// ---- extractors ----

/// Client address for rate limiting: the TCP peer, or the rightmost
/// `X-Forwarded-For` entry when `trust_forwarded_for` is on.
pub struct ClientIp(pub IpAddr);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<AppState>) -> Result<Self, Infallible> {
        Ok(ClientIp(client_ip(
            &parts.headers,
            &parts.extensions,
            st.settings.trust_forwarded_for,
        )))
    }
}

/// The TCP peer, or the rightmost `X-Forwarded-For` entry with `trust_forwarded_for`.
pub fn client_ip(headers: &HeaderMap, extensions: &axum::http::Extensions, trust_forwarded_for: bool) -> IpAddr {
    if trust_forwarded_for {
        let forwarded = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(|s| s.trim().parse::<IpAddr>().ok())
            .next_back();
        if let Some(ip) = forwarded {
            return ip;
        }
    }
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
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
        if c.revoked {
            return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
        }
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

pub fn too_large(limit: usize) -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "too_large",
        format!("request body is larger than {limit} bytes"),
    )
    .with("limit", limit.into())
}

/// A decimal number without sign, leading zeros or other characters.
pub fn parse_decimal(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 19 || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    s.parse().ok()
}

pub async fn read_body(headers: &HeaderMap, body: Body, limit: usize) -> Result<Bytes, ApiError> {
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

pub async fn read_json<T: DeserializeOwned>(headers: &HeaderMap, body: Body) -> Result<T, ApiError> {
    let bytes = read_body(headers, body, MAX_JSON_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))
}

/// Runs a join/auth step and counts a wrong code or signature for the address.
fn count_failure<T>(st: &AppState, ip: IpAddr, r: Result<T, ApiError>) -> Result<T, ApiError> {
    if let Err(e) = &r
        && e.is_auth_failure()
    {
        st.limiter.fail(ip);
        tracing::info!(
            "{}",
            tr!(
                "неверный код или подпись с адреса {ip}",
                "wrong code or signature from {ip}"
            )
        );
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
        "revoked": u.revoked.as_ref().map(|r| &r.envelope),
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

// ---- avatars ----

pub async fn put_avatar(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let bytes = read_body(&headers, body, MAX_AVATAR_BYTES).await?;
    let kind = ImageKind::sniff(&bytes)
        .ok_or_else(|| ApiError::bad_request("the avatar must be a JPEG or WebP image").code("bad_image"))?;
    let a = st.store.write(move |w| w.set_avatar(&c.user, &bytes, kind)).await?;
    Ok(Json(json!({ "sha256": b64_encode(&a.sha256), "type": a.kind.mime() })).into_response())
}

pub async fn get_avatar(
    State(st): State<Arc<AppState>>,
    Auth(_): Auth,
    UrlPath((user, sha)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let user = UserId::parse(&user).ok_or_else(|| ApiError::bad_request("bad userId"))?;
    let sha: [u8; 32] = b64_decode(&sha)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("bad sha256"))?;
    let a = st
        .store
        .read(|m| {
            m.users
                .get(&user)
                .and_then(|u| u.avatars.iter().find(|a| a.sha256 == sha).copied())
        })
        .ok_or_else(|| ApiError::not_found("not_found", "no such avatar"))?;
    let path = st.store.path().join("users").join(user.to_string()).join(a.file_name());
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found("not_found", "no such avatar"));
        }
        Err(e) => {
            return Err(crate::error::io_error(
                crate::lang::l("чтение аватара", "reading an avatar"),
                e,
            ));
        }
    };
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(a.kind.mime()));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(res)
}

// ---- revocation ----

/// `POST /v1/revoke`: no device token needed; the signature by the
/// identity key is the authority.
pub async fn revoke(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    st.limiter.check(ip)?;
    let env: Envelope = read_json(&headers, body).await?;
    let r = st.store.write(move |w| w.revoke(&env, now_ms())).await;
    count_failure(&st, ip, r)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- invitation details ----

#[derive(Deserialize)]
struct InviteCheckBody {
    invite: String,
}

/// `POST /v1/invites/check`: without a token; rate limited like `join`.
pub async fn invite_check(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    st.limiter.check(ip)?;
    let b: InviteCheckBody = read_json(&headers, body).await?;
    let id = invite_hash(&b.invite);
    let now = now_ms();
    let r = st.store.read(|m| {
        let inv = m
            .invites
            .get(&id)
            .ok_or_else(|| ApiError::forbidden("invalid_invite", "unknown invitation"))?;
        let status = if inv.used_at.is_some() {
            "used"
        } else if now >= inv.expires_at {
            "expired"
        } else {
            "valid"
        };
        let profile = m.users.get(&inv.created_by).and_then(|u| u.profile.as_ref());
        let name = profile.map(|p| p.name.clone());
        // The inviter's gender, for "пригласил" or "пригласила" (male without a profile).
        let gender = profile.map(|p| p.gender).unwrap_or_default().as_str();
        Ok(json!({
            "status": status,
            "familyName": st.family_name(),
            "createdBy": { "userId": inv.created_by, "name": name, "gender": gender },
            "createdAt": inv.created_at,
            "expiresAt": inv.expires_at,
        }))
    });
    Ok(Json(count_failure(&st, ip, r)?).into_response())
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

/// Devices that get a push for a new event: every subscribed device of the
/// chat's members, the sender's other devices included, except the device
/// that sent it. Removed and revoked users get nothing.
///
/// One browser has one push subscription for all accounts of this fcd on it
/// (several people on one device, see apps/web/src/lib/push.ts), so the
/// devices are matched by endpoint: nothing goes to the endpoint of the
/// sending device (it would notify its own author), and each endpoint gets
/// one push.
pub fn push_targets(m: &Mem, chat: &Chat, sender: &UserId, sender_dev: &DevId) -> Vec<(UserId, DevId, Subscription)> {
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(s) = m
        .users
        .get(sender)
        .and_then(|u| u.devices.get(sender_dev))
        .and_then(|d| d.push.as_ref())
    {
        seen.insert(s.endpoint.clone());
    }
    for uid in chat.unique_members() {
        let Some(u) = m.users.get(&uid).filter(|u| u.active()) else {
            continue;
        };
        for (dev, d) in &u.devices {
            if uid == *sender && dev == sender_dev {
                continue;
            }
            if let Some(s) = &d.push
                && seen.insert(s.endpoint.clone())
            {
                out.push((uid, *dev, s.clone()));
            }
        }
    }
    out
}

/// Sends `{"chatId","gseq"}` to the devices of [`push_targets`].
/// Subscriptions reported gone (404/410) are deleted.
fn push_new_event(st: &Arc<AppState>, a: &Appended, sender: UserId, sender_dev: DevId) {
    let Some(client) = st.push.clone() else { return };
    let targets = st.store.read(|m| push_targets(m, &a.chat, &sender, &sender_dev));
    let payload = json!({ "chatId": a.chat.id, "gseq": a.gseq }).to_string().into_bytes();
    for (uid, dev, sub) in targets {
        let st = st.clone();
        let client = client.clone();
        let payload = payload.clone();
        tokio::spawn(async move {
            match client.send(&st.vapid, &sub, &payload).await {
                Ok(o) if o.status == 404 || o.status == 410 => {
                    tracing::info!(
                        service = %o.service,
                        "{}",
                        tr!(
                            "подписка на уведомления устройства {dev} больше не действует, удаляю",
                            "the push subscription of device {dev} is no longer valid, removing it"
                        )
                    );
                    let ep = sub.endpoint.clone();
                    let _ = st.store.write(move |w| w.set_push(&uid, &dev, None, Some(&ep))).await;
                }
                Ok(o) if !(200..300).contains(&o.status) => {
                    tracing::warn!(
                        service = %o.service,
                        status = o.status,
                        "{}",
                        crate::lang::l("push-сервис отклонил уведомление", "the push service refused the notification")
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(
                    "{}",
                    tr!("уведомление не отправлено: {e}", "notification not sent: {e}")
                ),
            }
        });
    }
}

// ---- chats and events ----

pub fn parse_chat(s: &str) -> Result<ChatId, ApiError> {
    ChatId::parse(s).ok_or_else(|| ApiError::bad_request("bad chatId"))
}

/// An element of `GET /v1/chats` (also the answer of group requests).
pub fn chat_json(ch: &Chat, last: Option<&Entry>) -> Value {
    json!({
        "chatId": ch.id,
        "kind": match ch.kind { ChatKind::Dm => "dm", ChatKind::Group => "group" },
        "members": ch.members,
        "owner": ch.owner,
        "version": (ch.kind == ChatKind::Group).then_some(ch.version),
        "epoch": ch.epoch,
        "createdAt": ch.created_at,
        "lastGseq": last.map(|e| e.h.gseq),
        "lastTime": last.map(|e| e.h.time),
    })
}

fn notice_json(e: &Entry, n: &crate::notice::Notice) -> Value {
    json!({
        "kind": "notice",
        "gseq": e.h.gseq,
        "time": e.h.time,
        "chatId": e.h.chat,
        "notice": n.public,
    })
}

fn event_json(e: &Entry, body: &[u8]) -> Value {
    let mut v = json!({
        "kind": "event",
        "gseq": e.h.gseq,
        "time": e.h.time,
        "chatId": e.h.chat,
        "senderId": e.h.sender,
        "devId": e.h.dev,
        "epoch": e.h.epoch,
        "msgId": e.h.msg,
        "body": if e.deleted { String::new() } else { b64_encode(body) },
    });
    if e.deleted {
        v["deleted"] = json!(true);
    }
    v
}

async fn page_json(store: &Store, page: Page, oldest: (u64, Option<u64>)) -> Result<Response, ApiError> {
    let reader = store.clone();
    let to_read: Vec<Entry> = page
        .events
        .iter()
        .filter(|e| e.h.sender != NOTICE_SENDER)
        .copied()
        .collect();
    let bodies = tokio::task::spawn_blocking(move || reader.read_bodies(&to_read))
        .await
        .map_err(|_| ApiError::internal("reading events failed"))?;
    let mut bodies = bodies.into_iter().peekable();
    let mut events: Vec<Value> = Vec::with_capacity(page.events.len());
    for e in &page.events {
        if e.h.sender == NOTICE_SENDER {
            if let Some(n) = page.notices.get(&e.h.gseq) {
                events.push(notice_json(e, n));
            }
            continue;
        }
        // Bodies come in the same order; one whose segment vanished is skipped.
        if bodies.peek().is_some_and(|(b, _)| b.h.gseq == e.h.gseq) {
            let (b, body) = bodies.next().expect("peeked");
            events.push(event_json(&b, &body));
        }
    }
    Ok(Json(json!({
        "events": events,
        "cursor": page.cursor,
        "more": page.more,
        "oldestGseq": oldest.0,
        "oldestTime": oldest.1,
    }))
    .into_response())
}

pub async fn chats(State(st): State<Arc<AppState>>, Auth(c): Auth) -> Response {
    let list: Vec<Value> = st.store.read(|m| {
        let last = m.last_events();
        let mut v: Vec<_> = m.chats.values().filter(|ch| ch.is_member(&c.user)).collect();
        v.sort_by_key(|ch| ch.id.to_string());
        v.into_iter().map(|ch| chat_json(ch, last.get(&ch.id))).collect()
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
    let silent = no_push_hint(&headers)?;
    let body = read_body(&headers, body, MAX_BODY).await?;
    if body.is_empty() {
        return Err(ApiError::bad_request("event body is empty"));
    }
    let a = st
        .store
        .write(move |w| w.append(chat, c.user, c.dev, epoch, msg, &body, now_ms()))
        .await?;
    if !a.duplicate && !silent {
        push_new_event(&st, &a, c.user, c.dev);
    }
    Ok(Json(json!({ "gseq": a.gseq, "time": a.time, "duplicate": a.duplicate })).into_response())
}

/// `X-FC-Push: none` on `POST /v1/chats/<id>/events`: the sender's hint that
/// the event is not worth a notification (an edit, a deletion, a reaction).
/// The server skips push for it; delivery is the same. Any other value is an
/// error, so a typo does not silently notify.
pub fn no_push_hint(headers: &HeaderMap) -> Result<bool, ApiError> {
    match headers.get("x-fc-push").map(|v| v.to_str()) {
        None => Ok(false),
        Some(Ok("none")) => Ok(true),
        Some(_) => Err(ApiError::bad_request("X-FC-Push must be \"none\" when present")),
    }
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
        let (gone, page, oldest) = st.store.read(|m| {
            let gone = match m.users.get(&c.user) {
                Some(u) if u.revoked.is_some() => Some("revoked"),
                Some(u) if u.removed_at.is_some() || !u.devices.contains_key(&c.dev) => Some("removed"),
                Some(_) => None,
                None => Some("removed"),
            };
            (
                gone,
                m.events_after(&c.user, after, limit, MAX_PAGE_BYTES),
                (m.oldest_gseq(), m.oldest_time()),
            )
        });
        match gone {
            Some("revoked") => {
                return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
            }
            Some(_) => return Err(ApiError::forbidden("removed", "removed from the family")),
            None => {}
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
    page_json(&st.store, page, oldest).await
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
            Some(ch) if ch.is_member(&c.user) => {}
            Some(_) => return Err(ApiError::forbidden("not_member", "not a member of this chat")),
            None if m.derive_direct(&server_id, &c.user, &chat).is_some() => {}
            None => return Err(ApiError::not_found("chat_not_found", "no such chat")),
        }
        Ok((
            m.chat_history(&c.user, &chat, before, limit, MAX_PAGE_BYTES),
            (m.oldest_gseq(), m.oldest_time()),
        ))
    })?;
    page_json(&st.store, page, oldest).await
}

/// `DELETE /v1/chats/<id>/events/<gseq>`: delete for everyone.
pub async fn delete_event(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath((chat, gseq)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let chat = parse_chat(&chat)?;
    let gseq = parse_decimal(&gseq)
        .filter(|g| *g >= 1)
        .ok_or_else(|| ApiError::bad_request("bad gseq"))?;
    st.store
        .write(move |w| w.delete_event(chat, gseq, c.user, now_ms()))
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- admin ----

pub async fn create_invite(State(st): State<Arc<AppState>>, Admin(c): Admin) -> Result<Response, ApiError> {
    let (inv, code) = st.store.write(move |w| w.create_invite(&c.user, now_ms())).await?;
    tracing::info!(
        "{}",
        tr!(
            "администратор {} выпустил приглашение",
            "administrator {} created an invitation",
            c.user
        )
    );
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
                    "revoked": u.revoked.is_some(),
                    "revokedAt": u.revoked.as_ref().map(|r| r.at),
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
    // The root family's own data: the extra families in families/ are not counted.
    let (data_bytes, space) = tokio::task::spawn_blocking(move || {
        let families = path.join(crate::datadir::FAMILIES_DIR);
        (
            dir_size(&path).saturating_sub(dir_size(&families)),
            crate::store::disk_space(&path),
        )
    })
    .await
    .map_err(|_| ApiError::internal("stats failed"))?;
    let v = st.store.read(|m| {
        json!({
            "version": crate::VERSION,
            "commit": (!crate::GIT_COMMIT.is_empty()).then_some(crate::GIT_COMMIT),
            "dataBytes": data_bytes,
            "freeBytes": space.map(|s| s.0),
            "totalBytes": space.map(|s| s.1),
            "events": m.log.len(),
            "oldestGseq": m.oldest_gseq(),
            "lastGseq": m.last_gseq,
            "users": m.users.values().filter(|u| u.removed_at.is_none()).count(),
            "removedUsers": m.users.values().filter(|u| u.removed_at.is_some()).count(),
            "chats": m.chats.len(),
            "groups": m.chats.values().filter(|c| c.kind == ChatKind::Group).count(),
            "retentionDays": st.settings.retention_days,
            "push": st.settings.push,
            "telegram": st.telegram.as_ref().map(|tg| {
                let (health, bot) = tg.health();
                json!({ "status": health.as_str(), "bot": bot })
            }),
        })
    });
    Ok(Json(v).into_response())
}
