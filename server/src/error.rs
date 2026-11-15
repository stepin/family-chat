//! API errors: status code and a small JSON body `{"error", "message"}`.

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Extra fields merged into the body (for example the current epoch).
    pub extra: Option<serde_json::Map<String, serde_json::Value>>,
    /// `Retry-After` seconds (429).
    pub retry_after: Option<u64>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            extra: None,
            retry_after: None,
        }
    }

    pub fn with(mut self, key: &str, value: serde_json::Value) -> Self {
        self.extra
            .get_or_insert_with(Default::default)
            .insert(key.into(), value);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    pub fn storage_full() -> Self {
        Self::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "storage_full",
            "not enough free disk space on the server",
        )
    }

    /// Wrong code, signature or nonce: counted by the rate limiter.
    pub fn is_auth_failure(&self) -> bool {
        matches!(
            self.code,
            "invalid_invite" | "invite_used" | "invite_expired" | "invalid_code" | "bad_signature" | "bad_nonce"
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = serde_json::Map::new();
        body.insert("error".into(), json!(self.code));
        body.insert("message".into(), json!(self.message));
        if let Some(extra) = self.extra {
            body.extend(extra);
        }
        let mut res = (self.status, Json(serde_json::Value::Object(body))).into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            res.headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        if let Some(s) = self.retry_after {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        res
    }
}

/// I/O failure inside the server: logged, answered with 500 (or 507 when the
/// disk is full).
pub fn io_error(what: &str, e: std::io::Error) -> ApiError {
    if is_disk_full(&e) {
        tracing::error!("{what}: {}: {e}", crate::lang::l("диск заполнен", "disk full"));
        return ApiError::storage_full();
    }
    tracing::error!("{what}: {e}");
    ApiError::internal("server storage error")
}

fn is_disk_full(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::StorageFull || e.kind() == std::io::ErrorKind::QuotaExceeded
}
