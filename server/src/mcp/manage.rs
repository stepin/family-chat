//! Managing MCP connections from the app (`/v1/mcp`, docs/API.md): a family
//! administrator creates helpers, any member connects their own identity.
//! Tokens are shown once; access levels change only here, never through MCP.

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::conn::{self, Conn, ConnFile, Level, MAX_CONNECTIONS, Mode};
use crate::api::{Auth, read_json};
use crate::app::{ApiError, AppState};
use crate::client::IdentityKeys;
use crate::client::json::name_problem;
use crate::client::seal::{self, MAX_NAME_CHARS, ProfileInput};
use crate::datadir::now_ms;
use crate::envelope;
use crate::error::io_error;
use crate::ids::{DevId, b64_decode, b64_encode};
use crate::store::{Caller, JoinCode, env_error};
use crate::webpush::random_bytes;

fn enabled(st: &AppState) -> Result<(), ApiError> {
    if st.settings.mcp {
        Ok(())
    } else {
        Err(ApiError::not_found(
            "mcp_disabled",
            "MCP is switched off on this server",
        ))
    }
}

/// Who changes a connection: administrators their helpers, a member their own identity's connections.
fn may_manage(conn: &Conn, c: &Caller) -> bool {
    match conn.file.mode {
        Mode::Helper => c.admin,
        Mode::Me => conn.file.user_id == c.user,
    }
}

/// The identity can still act: a member who was not removed and did not revoke the identity.
pub fn identity_active(st: &AppState, conn: &Conn) -> bool {
    st.store.read(|m| {
        m.users
            .get(&conn.file.user_id)
            .is_some_and(|u| u.removed_at.is_none() && u.revoked.is_none())
    })
}

fn conn_json(st: &AppState, conn: &Conn, c: &Caller) -> Value {
    let f = &conn.file;
    json!({
        "active": identity_active(st, conn),
        "id": f.id,
        "name": f.name,
        "mode": f.mode,
        "userId": f.user_id,
        "levels": f.levels,
        "createdBy": f.created_by,
        "createdAt": f.created_at,
        "mine": may_manage(conn, c),
    })
}

fn find(st: &AppState, id: &str) -> Result<Arc<Conn>, ApiError> {
    st.mcp
        .get(id)
        .ok_or_else(|| ApiError::not_found("not_found", "no such MCP connection"))
}

fn label(name: &str) -> Result<String, ApiError> {
    let name = crate::client::json::js_trim(name);
    match name_problem(name, MAX_NAME_CHARS) {
        Some(p) => Err(ApiError::bad_request(p)),
        None => Ok(name.to_string()),
    }
}

/// `GET /v1/mcp`: an administrator sees every connection, a member their own.
pub async fn list(State(st): State<Arc<AppState>>, Auth(c): Auth) -> Result<Response, ApiError> {
    enabled(&st)?;
    let list: Vec<Value> = st
        .mcp
        .list()
        .iter()
        .filter(|conn| c.admin || may_manage(conn, &c))
        .map(|conn| conn_json(&st, conn, &c))
        .collect();
    Ok(Json(json!({ "connections": list })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBody {
    mode: Mode,
    name: String,
    /// Helper: `m` or `f` for its profile (default `m`).
    gender: Option<String>,
    /// Me: base64url of the caller's 32-byte identity seed.
    seed: Option<String>,
}

/// `POST /v1/mcp`: a helper with an identity of its own (administrators), or
/// the caller's own identity (`seed` in the body; any member).
pub async fn create(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    enabled(&st)?;
    let b: CreateBody = read_json(&headers, body).await?;
    let name = label(&b.name)?;
    if st.mcp.len() >= MAX_CONNECTIONS {
        return Err(ApiError::conflict(
            "too_many",
            "too many MCP connections in this family",
        ));
    }
    let now = now_ms();
    let (seed, keys) = match b.mode {
        Mode::Helper => {
            if !c.admin {
                return Err(ApiError::forbidden(
                    "not_admin",
                    "only an administrator creates a helper",
                ));
            }
            if b.seed.is_some() {
                return Err(ApiError::bad_request(
                    "a helper gets a new identity; seed is not accepted",
                ));
            }
            let seed = random_bytes::<32>();
            (seed, IdentityKeys::from_seed(&seed))
        }
        Mode::Me => {
            let seed: [u8; 32] = b
                .seed
                .as_deref()
                .and_then(b64_decode)
                .and_then(|s| s.try_into().ok())
                .ok_or_else(|| ApiError::bad_request("seed must be base64url of 32 bytes"))?;
            let keys = IdentityKeys::from_seed(&seed);
            if keys.user_id != c.user {
                return Err(ApiError::bad_request("the seed is not the caller's identity").code("seed_mismatch"));
            }
            (seed, keys)
        }
    };
    let dev = DevId(random_bytes::<10>());
    let (token, token_hash) = conn::new_token();
    let file = ConnFile {
        id: conn::new_id(),
        name: name.clone(),
        mode: b.mode,
        user_id: keys.user_id,
        dev_id: dev,
        seed: b64_encode(&seed),
        token_hash,
        levels: Level::DEFAULT.to_vec(),
        created_by: c.user,
        created_at: now,
        seq: Default::default(),
        hidden: Default::default(),
    };
    // The record (with the seed) goes to disk before the family learns about
    // a helper: a crash in between never leaves a member whose key nobody
    // holds. A member's own identity needs nothing more: the seed proved who
    // asks, and the server writes events for it without a device token.
    let conn = st
        .mcp
        .insert(file)
        .map_err(|e| io_error("write the MCP connection", e))?;
    if b.mode == Mode::Helper
        && let Err(e) = register_helper(&st, &c, &keys, &name, b.gender.as_deref(), dev, now).await
    {
        let _ = st.mcp.remove(&conn.file.id);
        return Err(e);
    }
    tracing::info!(
        "{}",
        tr!(
            "участник {} создал подключение MCP {} для {}",
            "member {} created the MCP connection {} for {}",
            c.user,
            conn.file.id,
            conn.file.user_id
        )
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({ "connection": conn_json(&st, &conn, &c), "token": token })),
    )
        .into_response())
}

/// A new member with its own identity, invited by the administrator who asked for it.
async fn register_helper(
    st: &AppState,
    admin: &Caller,
    keys: &IdentityKeys,
    name: &str,
    gender: Option<&str>,
    dev: DevId,
    now: u64,
) -> Result<(), ApiError> {
    let identity_env = seal::identity_envelope(keys, now);
    let profile_env = seal::profile_envelope(
        keys,
        &ProfileInput {
            name,
            avatar: None,
            gender: Some(gender.unwrap_or("m")),
            rev: 1,
            updated: now,
        },
    )
    .map_err(|e| ApiError::bad_request(e.message))?;
    let identity = envelope::verify_identity(&identity_env).map_err(|e| env_error(e, "identity"))?;
    let profile = envelope::verify_profile(&profile_env, &identity.user_id, &identity.key)
        .map_err(|e| env_error(e, "profile"))?;
    let by = admin.user;
    st.store
        .write(move |w| {
            let (_, code) = w.create_invite(&by, now)?;
            w.join(JoinCode::Invite(code), identity, profile, dev, now)
        })
        .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBody {
    name: Option<String>,
    levels: Option<Vec<Level>>,
}

/// `PUT /v1/mcp/<id>`: the label and the access levels.
pub async fn update(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    enabled(&st)?;
    let b: UpdateBody = read_json(&headers, body).await?;
    let conn = find(&st, &id)?;
    if !may_manage(&conn, &c) {
        return Err(ApiError::forbidden(
            "not_allowed",
            "this connection is managed by someone else",
        ));
    }
    let name = b.name.as_deref().map(label).transpose()?;
    let levels = b.levels.map(|mut l| {
        l.sort();
        l.dedup();
        l
    });
    let updated = st
        .mcp
        .update(&id, |f| {
            if let Some(n) = name {
                f.name = n;
            }
            if let Some(l) = levels {
                f.levels = l;
            }
        })
        .map_err(|e| io_error("write the MCP connection", e))?
        .ok_or_else(|| ApiError::not_found("not_found", "no such MCP connection"))?;
    Ok(Json(json!({ "connection": conn_json(&st, &updated, &c) })).into_response())
}

/// `POST /v1/mcp/<id>/token`: a new token; the old one stops working at once.
pub async fn rotate(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    enabled(&st)?;
    let conn = find(&st, &id)?;
    if !may_manage(&conn, &c) {
        return Err(ApiError::forbidden(
            "not_allowed",
            "this connection is managed by someone else",
        ));
    }
    let (token, hash) = conn::new_token();
    st.mcp
        .update(&id, |f| f.token_hash = hash)
        .map_err(|e| io_error("write the MCP connection", e))?
        .ok_or_else(|| ApiError::not_found("not_found", "no such MCP connection"))?;
    Ok(Json(json!({ "token": token })).into_response())
}

/// `DELETE /v1/mcp/<id>`: the token stops working and the keys are deleted
/// from the server. A helper is also removed from the family: without its
/// keys nobody can act for it again.
pub async fn remove(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    enabled(&st)?;
    let conn = find(&st, &id)?;
    if !(may_manage(&conn, &c) || c.admin) {
        return Err(ApiError::forbidden(
            "not_allowed",
            "this connection is managed by someone else",
        ));
    }
    st.mcp
        .remove(&id)
        .map_err(|e| io_error("delete the MCP connection", e))?;
    st.mcp_views.forget(&id);
    st.mcp_links.forget(&id);
    if conn.file.mode == Mode::Helper {
        let user = conn.file.user_id;
        // A helper another connection still uses stays (there is none today; the check keeps it true).
        if !st.mcp.list().iter().any(|other| other.file.user_id == user) {
            let r = st.store.write(move |w| w.remove_user(&user, now_ms())).await;
            if let Err(e) = r {
                tracing::warn!(
                    "{}",
                    tr!(
                        "подключение MCP {id} удалено, но участник {user} не исключён: {}",
                        "the MCP connection {id} is deleted, but member {user} was not removed: {}",
                        e.message
                    )
                );
            }
        }
    }
    tracing::info!(
        "{}",
        tr!(
            "участник {} удалил подключение MCP {id}",
            "member {} deleted the MCP connection {id}",
            c.user
        )
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}
