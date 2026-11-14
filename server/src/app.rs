//! HTTP API and static client.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::watch;

use crate::assets::Assets;
use crate::config::Settings;
use crate::datadir::{check_admin_code, now_ms};
use crate::webpush::{PushClient, Subscription, VapidKey};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_WAIT_SECONDS: u64 = 60;
pub const MAX_PUSH_DELAY_SECONDS: u64 = 300;

pub struct AppState {
    pub settings: Settings,
    pub server_id: String,
    pub admin_code_hash: String,
    pub vapid: VapidKey,
    /// `None` when push is disabled in the settings.
    pub push: Option<PushClient>,
    /// `--m0`: the check endpoints are available.
    pub m0: bool,
    pub assets: Assets,
    /// Becomes `true` when the server starts shutting down.
    pub shutdown: watch::Receiver<bool>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/m0/wait", get(m0_wait))
        .route("/v1/m0/push", post(m0_push))
        .fallback(fallback)
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

/// Error body: `{"error": "<code>", "message": "<text>"}`.
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut res = (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            res.headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        res
    }
}

/// CORS for every API response (docs/PLAN-v2.md, section 5): any origin,
/// no cookies; authorisation goes in the `Authorization` header.
async fn cors(req: Request, next: Next) -> Response {
    let is_api = req.uri().path().starts_with("/v1/") || req.uri().path() == "/v1";
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
        HeaderValue::from_static("Authorization, Content-Type, Idempotency-Key"),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
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
    if code.is_empty() || !check_admin_code(&st.admin_code_hash, code) {
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
fn endpoint_allowed(endpoint: &str) -> bool {
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
