//! Server checks: a long request and a
//! test notification. Always on. Before setup the `/server/` page calls them
//! with the administrator code; after setup an administrator's device calls
//! them with its device token (app: Settings → Family and server → Server check).
//! Errors are listed in docs/API.md ("Server checks").

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::api::{self, ClientIp};
use crate::app::{AppState, MAX_PUSH_DELAY_SECONDS, MAX_WAIT_SECONDS, endpoint_allowed};
use crate::datadir::{check_admin_code, now_ms};
use crate::error::ApiError;
use crate::ids::{DevId, UserId};
use crate::webpush::{PushError, PushOutcome, Subscription};

/// At most this many delayed test notifications wait at once on a server.
pub const MAX_PENDING_PUSHES: usize = 3;
/// At most this many "last test push" records are kept (one per device).
pub const MAX_OUTCOMES: usize = 64;
/// Key of the record for checks made with the administrator code.
const SETUP_KEY: &str = "setup";

/// Who may run the checks.
pub enum Access {
    /// The active administrator code (before the first administrator joined).
    AdminCode,
    /// An administrator's device, by its device token.
    Device { user: UserId, dev: DevId },
}

impl Access {
    fn key(&self) -> String {
        match self {
            Access::AdminCode => SETUP_KEY.to_string(),
            Access::Device { user, dev } => format!("{user}/{dev}"),
        }
    }
}

/// In-memory state of the checks.
#[derive(Default)]
pub struct Checks {
    pending: AtomicUsize,
    /// Last test push per device: (time, result class).
    outcomes: Mutex<HashMap<String, (u64, &'static str)>>,
}

impl Checks {
    fn record(&self, key: String, result: &'static str) {
        let mut m = self.outcomes.lock().expect("check outcomes lock");
        if !m.contains_key(&key)
            && m.len() >= MAX_OUTCOMES
            && let Some(oldest) = m.iter().min_by_key(|(_, (t, _))| *t).map(|(k, _)| k.clone())
        {
            m.remove(&oldest);
        }
        m.insert(key, (now_ms(), result));
    }

    fn last(&self, key: &str) -> Option<(u64, &'static str)> {
        self.outcomes.lock().expect("check outcomes lock").get(key).copied()
    }
}

/// Access order (docs/API.md): (a) no value: rate limit checked, 401, not
/// counted as a failure; (b) a known device token decides by role and never
/// touches the rate limit (tokens cannot be guessed, and family members'
/// wrong codes behind the same NAT must not lock the administrator out);
/// (c) rate limit; (d) the administrator code: a mismatch counts as a failure,
/// shared with joining (it is the same secret). The value is never logged.
pub fn access(st: &AppState, ip: IpAddr, headers: &HeaderMap) -> Result<Access, ApiError> {
    let Some(value) = api::bearer(headers) else {
        st.limiter.check(ip)?;
        return Err(ApiError::unauthorized(
            "administrator code or administrator device token required",
        ));
    };
    if let Some(c) = st.store.caller(value) {
        if c.revoked {
            return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
        }
        if c.removed {
            return Err(ApiError::forbidden("removed", "removed from the family"));
        }
        if !c.admin {
            return Err(ApiError::forbidden("not_admin", "administrator only"));
        }
        return Ok(Access::Device {
            user: c.user,
            dev: c.dev,
        });
    }
    st.limiter.check(ip)?;
    let hash = st.store.read(|m| m.server.admin_code_hash.clone());
    if hash.is_empty() {
        st.limiter.fail(ip);
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "admin_code_inactive",
            "admin code is no longer active after the first administrator signed in; use an administrator \
             device token (app: Settings → Family and server → Server check)",
        ));
    }
    if check_admin_code(&hash, value) {
        return Ok(Access::AdminCode);
    }
    st.limiter.fail(ip);
    Err(ApiError::unauthorized("wrong administrator code"))
}

#[derive(Deserialize)]
pub struct WaitQuery {
    seconds: Option<u64>,
}

/// `GET /v1/check/wait`: answers after `seconds` (default 25, at most 60),
/// sending nothing before that. Checks that proxies keep such requests open.
pub async fn wait(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Query(q): Query<WaitQuery>,
) -> Result<Response, ApiError> {
    access(&st, ip, &headers)?;
    let seconds = q.seconds.unwrap_or(25);
    if seconds > MAX_WAIT_SECONDS {
        return Err(ApiError::bad_request("seconds must be at most 60"));
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushRequest {
    subscription: Option<Subscription>,
    #[serde(default)]
    delay_seconds: u64,
    from: Option<String>,
}

/// The test notification carries no human text: the service worker
/// words it in the language of the app (public/push-sw.js). `kind` is
/// `check-test`; `from` says which screen asked for it.
fn test_payload(delay: u64, from: &str) -> Vec<u8> {
    json!({ "kind": "check-test", "delay": delay, "sentAt": now_ms(), "from": from })
        .to_string()
        .into_bytes()
}

/// Result class of one attempt: `sent`, or the `reason` of `push_failed`.
fn classify(r: &Result<PushOutcome, PushError>) -> &'static str {
    match r {
        Ok(o) if (200..300).contains(&o.status) => "sent",
        Ok(o) if o.status == 404 || o.status == 410 => "gone",
        Ok(o) if o.status == 401 || o.status == 403 => "unauthorized",
        Ok(_) => "rejected",
        Err(PushError::Transport(_)) => "network",
        Err(_) => "rejected",
    }
}

fn push_failed(reason: &'static str) -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "push_failed",
        format!("the push service did not accept the notification ({reason})"),
    )
    .with("reason", reason.into())
}

/// `POST /v1/check/push`: a test notification now or after `delaySeconds`
/// (at most 300). With a device token it goes to that device's stored
/// subscription (`PUT /v1/me/push`); a subscription in the body is accepted
/// only with the administrator code (the `/server/` page before setup).
pub async fn push(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let who = access(&st, ip, &headers)?;
    let bytes = api::read_body(&headers, body, api::MAX_JSON_BODY).await?;
    let req: PushRequest =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))?;
    let from = match req.from.as_deref() {
        None | Some("page") => "page",
        Some("app") => "app",
        Some(_) => return Err(ApiError::bad_request("from must be \"app\" or \"page\"")),
    };
    let Some(client) = st.push.clone() else {
        return Err(ApiError::conflict("push_disabled", "push is disabled on this server"));
    };
    if req.delay_seconds > MAX_PUSH_DELAY_SECONDS {
        return Err(ApiError::bad_request("delaySeconds must be at most 300"));
    }
    let sub = match (&who, req.subscription) {
        (Access::AdminCode, Some(s)) => s,
        (Access::AdminCode, None) => return Err(ApiError::bad_request("subscription is required")),
        (Access::Device { .. }, Some(_)) => {
            return Err(ApiError::bad_request(
                "with a device token the test goes to this device's own subscription; omit subscription",
            ));
        }
        (Access::Device { user, dev }, None) => {
            let stored = st.store.read(|m| {
                m.users
                    .get(user)
                    .and_then(|u| u.devices.get(dev))
                    .and_then(|d| d.push.clone())
            });
            stored.ok_or_else(|| {
                ApiError::conflict(
                    "no_subscription",
                    "this device has no push subscription; turn notifications on first",
                )
            })?
        }
    };
    if !endpoint_allowed(&sub.endpoint) {
        return Err(ApiError::bad_request("subscription endpoint must be https"));
    }
    let key = who.key();
    let delay = req.delay_seconds;
    if delay == 0 {
        let r = client.send(&st.vapid, &sub, &test_payload(0, from)).await;
        let class = classify(&r);
        st.checks.record(key, class);
        return match r {
            Ok(o) if class == "sent" => {
                tracing::info!(service = %o.service, status = o.status, "test push sent");
                Ok(Json(json!({
                    "sent": true,
                    "outcome": { "status": o.status, "service": o.service },
                }))
                .into_response())
            }
            Ok(o) => {
                tracing::warn!(service = %o.service, status = o.status, reason = class, "test push failed");
                Err(push_failed(class))
            }
            Err(_) => {
                tracing::warn!(reason = class, "test push failed");
                Err(push_failed(class))
            }
        };
    }

    // Reserve a slot for the delayed send; give it back when it is done.
    if st
        .checks
        .pending
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_PENDING_PUSHES).then_some(n + 1)
        })
        .is_err()
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_pending",
            "too many delayed test notifications are waiting; try again in a few minutes",
        ));
    }
    let send_at = now_ms() + delay * 1000;
    let st2 = st.clone();
    tokio::spawn(async move {
        let mut shutdown = st2.shutdown.clone();
        let go = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => true,
            _ = shutdown.wait_for(|v| *v) => false,
        };
        if go {
            let r = client.send(&st2.vapid, &sub, &test_payload(delay, from)).await;
            let class = classify(&r);
            st2.checks.record(key, class);
            if class == "sent" {
                tracing::info!(delay, "delayed test push sent");
            } else {
                tracing::warn!(delay, reason = class, "delayed test push failed");
            }
        }
        st2.checks.pending.fetch_sub(1, Ordering::SeqCst);
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "sent": false, "scheduled": true, "sendAt": send_at })),
    )
        .into_response())
}

/// `GET /v1/check/push`: the last test notification of the caller (its
/// device, or the administrator code), time and result class only.
pub async fn last_push(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let who = access(&st, ip, &headers)?;
    let last = st
        .checks
        .last(&who.key())
        .map(|(at, result)| json!({ "at": at, "result": result }));
    Ok(Json(json!({ "last": last })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_are_capped() {
        let c = Checks::default();
        for i in 0..(MAX_OUTCOMES + 10) {
            c.record(format!("d{i}"), "sent");
        }
        assert_eq!(c.outcomes.lock().unwrap().len(), MAX_OUTCOMES);
        c.record("d70".into(), "gone");
        assert_eq!(c.last("d70").map(|x| x.1), Some("gone"));
    }

    #[test]
    fn classes() {
        let o = |status| {
            Ok(PushOutcome {
                status,
                service: "x".into(),
                detail: None,
            })
        };
        assert_eq!(classify(&o(201)), "sent");
        assert_eq!(classify(&o(410)), "gone");
        assert_eq!(classify(&o(404)), "gone");
        assert_eq!(classify(&o(403)), "unauthorized");
        assert_eq!(classify(&o(400)), "rejected");
        assert_eq!(classify(&Err(PushError::Transport("x".into()))), "network");
        assert_eq!(classify(&Err(PushError::TooLarge)), "rejected");
    }
}
