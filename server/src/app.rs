//! HTTP API and static client.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::watch;

use crate::api;
use crate::assets::Assets;
use crate::blobs;
use crate::config::Settings;
use crate::datadir::{DataDir, check_admin_code, now_ms};
pub use crate::error::ApiError;
use crate::groups;
use crate::headers;
use crate::packs::{self, PackStore};
use crate::ratelimit::RateLimiter;
use crate::store::{Store, StoreConfig};
use crate::webpush::{PushClient, Subscription, VapidKey};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_WAIT_SECONDS: u64 = 60;
pub const MAX_PUSH_DELAY_SECONDS: u64 = 300;
/// How often old log days, blob folders and expired invitations are removed.
pub const MAINTENANCE_PERIOD: Duration = Duration::from_secs(3600);

pub struct AppState {
    pub settings: Settings,
    pub server_id: String,
    pub vapid: VapidKey,
    /// `None` when push is disabled in the settings.
    pub push: Option<PushClient>,
    /// `--m0`: the check endpoints are available.
    pub m0: bool,
    pub assets: Assets,
    /// Becomes `true` when the server starts shutting down.
    pub shutdown: watch::Receiver<bool>,
    pub store: Store,
    /// Sticker packs (`packs/`).
    pub packs: PackStore,
    pub limiter: RateLimiter,
}

impl AppState {
    /// Loads the state of an opened data folder.
    pub fn new(
        dir: &DataDir,
        settings: Settings,
        assets: Assets,
        m0: bool,
        shutdown: watch::Receiver<bool>,
    ) -> Result<Arc<AppState>, String> {
        let store = Store::open(
            &dir.path,
            dir.server.clone(),
            StoreConfig {
                retention_days: settings.retention_days,
                min_free_mb: settings.min_free_mb,
                max_blob_bytes: settings
                    .max_file_mb
                    .saturating_mul(1024 * 1024)
                    .saturating_add(blobs::TOTAL_SLACK_BYTES),
            },
        )?;
        let packs = PackStore::open(&dir.path, settings.min_free_mb);
        Ok(Arc::new(AppState {
            push: settings.push.then(|| PushClient::new(settings.push_subject.clone())),
            settings,
            server_id: dir.server.server_id.clone(),
            vapid: dir.vapid.clone(),
            m0,
            assets,
            shutdown,
            store,
            packs,
            limiter: RateLimiter::default(),
        }))
    }
}

/// Retention cleanup now and then every hour, until shutdown.
pub fn spawn_maintenance(st: Arc<AppState>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(MAINTENANCE_PERIOD);
        let mut shutdown = st.shutdown.clone();
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = shutdown.wait_for(|v| *v) => return,
            }
            st.store.write(|w| w.retention(now_ms())).await;
            let st2 = st.clone();
            let removed = tokio::task::spawn_blocking(move || st2.packs.remove_stale_drafts(now_ms()))
                .await
                .unwrap_or(0);
            if removed > 0 {
                tracing::info!("удалены неопубликованные черновики наборов стикеров: {removed}");
            }
        }
    });
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/join", post(api::join))
        .route("/v1/auth/challenge", post(api::auth_challenge))
        .route("/v1/auth/device", post(api::auth_device))
        .route("/v1/users", get(api::users))
        .route("/v1/me", get(api::me))
        .route("/v1/me/profile", put(api::put_profile))
        .route("/v1/me/avatar", put(api::put_avatar))
        .route("/v1/users/{id}/avatar/{sha}", get(api::get_avatar))
        .route("/v1/revoke", post(api::revoke))
        .route("/v1/invites/check", post(api::invite_check))
        .route("/v1/me/push", put(api::put_push).delete(api::delete_push))
        .route("/v1/chats", get(api::chats).post(groups::create))
        .route("/v1/chats/{id}/events", post(api::post_event).get(api::chat_events))
        .route("/v1/chats/{id}/events/{gseq}", delete(api::delete_event))
        .route("/v1/chats/{id}/state", put(groups::change))
        .route("/v1/chats/{id}/state/{version}", get(groups::get_state))
        .route("/v1/chats/{id}/leave", post(groups::leave))
        .route("/v1/keys", get(groups::keys))
        .route("/v1/blobs/{id}", get(blobs::info).delete(blobs::delete))
        .route("/v1/blobs/{id}/{part}", put(blobs::put_part).get(blobs::get_part))
        .route("/v1/events", get(api::events))
        .route("/v1/packs", get(packs::list))
        .route(
            "/v1/packs/{id}",
            get(packs::get).put(packs::publish).delete(packs::delete),
        )
        .route("/v1/packs/{id}/files/{hash}", get(packs::get_file).put(packs::put_file))
        .route("/v1/admin/invites", post(api::create_invite).get(api::list_invites))
        .route("/v1/admin/invites/{id}", delete(api::delete_invite))
        .route("/v1/admin/users", get(api::admin_users))
        .route("/v1/admin/users/{id}", delete(api::remove_user))
        .route("/v1/admin/stats", get(api::stats))
        .route("/v1/m0/wait", get(m0_wait))
        .route("/v1/m0/push", post(m0_push))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(fallback)
        .layer(middleware::from_fn(cors))
        .layer(middleware::from_fn(headers::security_headers))
        .with_state(state)
}

async fn method_not_allowed() -> Response {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "method not allowed for this endpoint",
    )
    .into_response()
}

/// CORS for every API response (docs/PLAN-v2.md, section 5): any origin,
/// no cookies; authorisation goes in the `Authorization` header.
async fn cors(req: Request, next: Next) -> Response {
    let is_api = headers::is_api_path(req.uri().path());
    if !is_api {
        return next.run(req).await;
    }
    let mut res = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Idempotency-Key, X-FC-Epoch, X-FC-Push"),
    );
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Retry-After"),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    res
}

async fn fallback(
    State(st): State<Arc<AppState>>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    if uri.path().starts_with("/v1/") || uri.path() == "/v1" {
        return ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such API endpoint").into_response();
    }
    // Web Share Target (M5): the installed app's service worker answers this
    // POST itself. When it reaches the server (no service worker yet), the
    // shared content is dropped and the app opens with an explanation.
    if method == Method::POST && uri.path().ends_with("/share-target") {
        return (
            StatusCode::SEE_OTHER,
            [
                (header::LOCATION, "./?share=unavailable"),
                (header::CACHE_CONTROL, "no-store"),
            ],
        )
            .into_response();
    }
    st.assets.serve(&method, &uri, &headers).await
}

async fn hello(State(st): State<Arc<AppState>>) -> Response {
    let s = &st.settings;
    Json(json!({
        "protocol": PROTOCOL_VERSION,
        "server": "fcd",
        "version": env!("CARGO_PKG_VERSION"),
        "serverId": st.server_id,
        "familyName": s.family_name,
        "retentionDays": s.retention_days,
        "maxFileMb": s.max_file_mb,
        "push": s.push,
        "vapidPublicKey": if s.push { Some(st.vapid.public_key_b64()) } else { None },
        "time": now_ms(),
        "maxEventBytes": crate::eventlog::MAX_BODY,
        "maxPartBytes": blobs::MAX_PART_BYTES,
        "maxBlobBytes": st.store.blobs().max_total(),
        "maxAvatarBytes": api::MAX_AVATAR_BYTES,
        "maxStateBytes": groups::MAX_STATE_BYTES,
        "maxSealedKeyBytes": groups::MAX_SEALED_KEY_BYTES,
        "maxGroupMembers": groups::MAX_MEMBERS,
        "maxPackStickers": crate::envelope::MAX_PACK_STICKERS,
        "maxPackBytes": crate::envelope::MAX_PACK_BYTES,
        "adminCodeActive": st.store.read(|m| !m.server.admin_code_hash.is_empty()),
        "m0": st.m0,
    }))
    .into_response()
}

/// M0 check endpoints exist only with `--m0` and need the administrator code
/// as `Authorization: Bearer <code>`.
fn require_m0_admin(st: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if !st.m0 {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such API endpoint",
        ));
    }
    let code = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    let hash = st.store.read(|m| m.server.admin_code_hash.clone());
    if code.is_empty() || !check_admin_code(&hash, code) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "administrator code required",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct WaitQuery {
    seconds: Option<u64>,
}

/// Long request: answers after `seconds` (default 25, at most 60), sending
/// nothing before that. Checks that proxies keep such requests open.
async fn m0_wait(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<WaitQuery>,
) -> Result<Response, ApiError> {
    require_m0_admin(&st, &headers)?;
    let seconds = q.seconds.unwrap_or(25);
    if seconds > MAX_WAIT_SECONDS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "seconds must be at most 60",
        ));
    }
    let started = now_ms();
    let mut shutdown = st.shutdown.clone();
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {}
        _ = shutdown.wait_for(|v| *v) => {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "shutting_down", "server is shutting down"));
        }
    }
    Ok(Json(json!({ "seconds": seconds, "startedAt": started, "finishedAt": now_ms() })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushRequest {
    subscription: Subscription,
    #[serde(default)]
    delay_seconds: u64,
}

/// Push endpoints must be HTTPS; plain HTTP only to loopback (tests).
pub fn endpoint_allowed(endpoint: &str) -> bool {
    if endpoint.starts_with("https://") {
        return crate::webpush::origin_of(endpoint).is_some();
    }
    if let Some(rest) = endpoint.strip_prefix("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
        return matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    }
    false
}

fn test_payload(delay: u64) -> Vec<u8> {
    let body = if delay == 0 {
        "Пробное уведомление дошло.".to_string()
    } else {
        format!("Пробное уведомление дошло (отправлено через {delay} с).")
    };
    json!({ "kind": "m0-test", "title": "Family Chat", "body": body, "sentAt": now_ms() })
        .to_string()
        .into_bytes()
}

/// Sends a test notification to the given subscription, now or after
/// `delaySeconds` (at most 300, enough to close the app).
async fn m0_push(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Json<PushRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Response, ApiError> {
    require_m0_admin(&st, &headers)?;
    let Json(req) = body.map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, "bad_request", e.body_text()))?;
    let Some(client) = st.push.clone() else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "push_disabled",
            "push is disabled on this server",
        ));
    };
    if req.delay_seconds > MAX_PUSH_DELAY_SECONDS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "delaySeconds must be at most 300",
        ));
    }
    if !endpoint_allowed(&req.subscription.endpoint) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "subscription endpoint must be https",
        ));
    }
    let delay = req.delay_seconds;
    if delay == 0 {
        let outcome = client
            .send(&st.vapid, &req.subscription, &test_payload(0))
            .await
            .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "push_failed", e.to_string()))?;
        tracing::info!(service = %outcome.service, status = outcome.status, "test push sent");
        return Ok(Json(json!({ "sent": true, "outcome": outcome })).into_response());
    }

    let send_at = now_ms() + delay * 1000;
    let st2 = st.clone();
    tokio::spawn(async move {
        let mut shutdown = st2.shutdown.clone();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            _ = shutdown.wait_for(|v| *v) => return,
        }
        match client.send(&st2.vapid, &req.subscription, &test_payload(delay)).await {
            Ok(o) => tracing::info!(service = %o.service, status = o.status, delay, "delayed test push sent"),
            Err(e) => tracing::warn!(delay, "delayed test push failed: {e}"),
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "sent": false, "scheduled": true, "sendAt": send_at })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::endpoint_allowed;

    #[test]
    fn endpoint_rules() {
        assert!(endpoint_allowed("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(endpoint_allowed("http://127.0.0.1:1234/push"));
        assert!(!endpoint_allowed("http://192.168.1.1/push"));
        assert!(!endpoint_allowed("ftp://x/y"));
        assert!(!endpoint_allowed("https://"));
    }
}
