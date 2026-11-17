//! HTTP API and static client.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use serde_json::json;
use tokio::sync::watch;

use crate::api;
use crate::assets::Assets;
use crate::blobs;
use crate::check::{self, Checks};
use crate::config::Settings;
use crate::datadir::{DataDir, now_ms};
pub use crate::error::ApiError;
use crate::groups;
use crate::headers;
use crate::packs::{self, PackStore};
use crate::ratelimit::RateLimiter;
use crate::store::{Store, StoreConfig};
use crate::webpush::{PushClient, VapidKey};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_WAIT_SECONDS: u64 = 60;
pub const MAX_PUSH_DELAY_SECONDS: u64 = 300;
/// How often old log days, blob folders and expired invitations are removed.
pub const MAINTENANCE_PERIOD: Duration = Duration::from_secs(3600);

/// What every family of one fcd shares: settings, the web client, the
/// failure limiter (so guessing codes does not multiply by the number of
/// families), the push client and key, the Telegram client, the stop signal.
#[derive(Clone)]
pub struct Common {
    pub settings: Settings,
    pub assets: Assets,
    pub shutdown: watch::Receiver<bool>,
    pub limiter: Arc<RateLimiter>,
    pub push: Option<PushClient>,
    pub telegram: Option<Arc<crate::telegram::Telegram>>,
}

impl Common {
    pub fn new(settings: Settings, assets: Assets, shutdown: watch::Receiver<bool>) -> Common {
        Common {
            push: settings.push.then(|| PushClient::new(settings.push_subject.clone())),
            telegram: settings.telegram.as_ref().map(crate::telegram::Telegram::new),
            settings,
            assets,
            shutdown,
            limiter: Arc::new(RateLimiter::default()),
        }
    }
}

/// The state of one family (the root one or one at `/f/<id>`).
pub struct AppState {
    pub settings: Settings,
    /// `None` for the root family.
    pub family_id: Option<String>,
    pub server_id: String,
    pub vapid: VapidKey,
    /// `None` when push is disabled in the settings.
    pub push: Option<PushClient>,
    pub assets: Assets,
    /// Becomes `true` when the server starts shutting down.
    pub shutdown: watch::Receiver<bool>,
    pub store: Store,
    /// Sticker packs (`packs/`).
    pub packs: PackStore,
    pub limiter: Arc<RateLimiter>,
    /// Server checks (`/v1/check/*`): pending delayed pushes, last outcomes.
    pub checks: Checks,
    /// Telegram sticker sets by link; `None` without a bot token.
    pub telegram: Option<Arc<crate::telegram::Telegram>>,
}

impl AppState {
    /// Loads the state of an opened data folder with its own shared parts
    /// (a single family; tests).
    pub fn new(
        dir: &DataDir,
        settings: Settings,
        assets: Assets,
        shutdown: watch::Receiver<bool>,
    ) -> Result<Arc<AppState>, String> {
        AppState::open(dir, &Common::new(settings, assets, shutdown), None)
    }

    /// Loads a family's state; `family_id` is `None` for the root family.
    pub fn open(dir: &DataDir, common: &Common, family_id: Option<String>) -> Result<Arc<AppState>, String> {
        let settings = common.settings.clone();
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
            push: common.push.clone(),
            telegram: common.telegram.clone(),
            settings,
            family_id,
            server_id: dir.server.server_id.clone(),
            vapid: dir.vapid.clone(),
            assets: common.assets.clone(),
            shutdown: common.shutdown.clone(),
            store,
            packs,
            limiter: common.limiter.clone(),
            checks: Checks::default(),
        }))
    }

    /// The family's name: `family_name` of config.toml for the root one,
    /// `familyName` of its server.json for an extra one.
    pub fn family_name(&self) -> String {
        match self.family_id {
            None => self.settings.family_name.clone(),
            Some(_) => self
                .store
                .read(|m| m.server.family_name.clone())
                .unwrap_or_else(|| self.settings.family_name.clone()),
        }
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
                tracing::info!(
                    "{}",
                    tr!(
                        "удалены неопубликованные черновики наборов стикеров: {removed}",
                        "removed unpublished sticker pack drafts: {removed}"
                    )
                );
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
        .route("/v1/telegram/sets/{name}", get(crate::telegram::get_set))
        .route("/v1/telegram/sets/{name}/files/{id}", get(crate::telegram::get_file))
        .route("/v1/admin/invites", post(api::create_invite).get(api::list_invites))
        .route("/v1/admin/invites/{id}", delete(api::delete_invite))
        .route("/v1/admin/users", get(api::admin_users))
        .route("/v1/admin/users/{id}", delete(api::remove_user))
        .route("/v1/admin/stats", get(api::stats))
        .route("/v1/check/wait", get(check::wait))
        .route("/v1/check/push", get(check::last_push).post(check::push))
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

/// CORS for every API response: any origin,
/// no cookies; authorisation goes in the `Authorization` header.
pub(crate) async fn cors(req: Request, next: Next) -> Response {
    let is_api = headers::is_api_path(req.uri().path());
    if !is_api {
        return next.run(req).await;
    }
    let mut res = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    add_cors(res.headers_mut());
    res
}

/// The CORS headers of an API answer.
pub(crate) fn add_cors(h: &mut HeaderMap) {
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
        HeaderValue::from_static("Retry-After, X-Request-Id"),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
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
    // Web Share Target: the installed app's service worker answers this
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
    let mut body = json!({
        "protocol": PROTOCOL_VERSION,
        "server": "fcd",
        "version": crate::VERSION,
            "commit": (!crate::GIT_COMMIT.is_empty()).then_some(crate::GIT_COMMIT),
        "serverId": st.server_id,
        "familyName": st.family_name(),
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
        // The family has a join code that works (setup or recovery).
        "adminCodeActive": st.store.read(|m| m.server.join_code_active(now_ms())),
        // Kept, always true, for one release: installed apps of 0.1.0 need the field.
        "offerSetup": true,
        "telegramStickers": st.telegram.is_some(),
    });
    if st.family_id.is_none() {
        body["rootSetUp"] = json!(st.store.read(|m| m.server.is_set_up()));
    }
    Json(body).into_response()
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
