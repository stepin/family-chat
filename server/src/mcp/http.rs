//! `<family>/mcp`: the Model Context Protocol over Streamable HTTP, written
//! by hand (JSON-RPC 2.0, one message per POST, one JSON answer; no streams,
//! no sessions). Speaks revision 2026-07-28 (every request carries its
//! version) and the earlier ones that start with `initialize`.

use std::net::IpAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::{Map, Value, json};

use super::conn::Conn;
use super::manage::identity_active;
use super::tools::{self, Ctx, INSTRUCTIONS};
use crate::api::{ClientIp, bearer, read_body};
use crate::app::{ApiError, AppState};

/// The revision without a handshake: version, client and capabilities come with every request.
pub const MODERN: &str = "2026-07-28";
/// Revisions that begin with `initialize`, newest first.
pub const LEGACY: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
/// Largest request (a tool call may carry a file of 1 MiB in base64).
pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_VERSION: i64 = -32022;

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_SERVER: &str = "io.modelcontextprotocol/serverInfo";

fn supported() -> Vec<&'static str> {
    std::iter::once(MODERN).chain(LEGACY).collect()
}

fn server_info() -> Value {
    json!({ "name": "family-chat", "title": "Family Chat", "version": crate::VERSION })
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body.to_string(),
    )
        .into_response()
}

fn rpc_error(
    status: StatusCode,
    id: Option<&Value>,
    code: i64,
    message: impl Into<String>,
    data: Option<Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(d) = data {
        error["data"] = d;
    }
    let mut body = json!({ "jsonrpc": "2.0", "error": error });
    // An error about a message that had no usable id carries none.
    if let Some(id) = id {
        body["id"] = id.clone();
    }
    json_response(status, &body)
}

/// A header value as the client meant it: `=?base64?…?=` carries text that
/// does not fit a plain header.
fn header_text(v: &str) -> Option<String> {
    match v.strip_prefix("=?base64?").and_then(|r| r.strip_suffix("?=")) {
        Some(b64) => String::from_utf8(base64::engine::general_purpose::STANDARD.decode(b64).ok()?).ok(),
        None => Some(v.to_string()),
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim)
}

/// A browser page of another site must not talk to this endpoint: when
/// `Origin` is present it has to be the site the request came to.
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = header_str(headers, "origin") else {
        return true;
    };
    let host = header_str(headers, "x-forwarded-host").or_else(|| header_str(headers, "host"));
    let origin_host = origin.split_once("://").map(|(_, h)| h);
    matches!((origin_host, host), (Some(o), Some(h)) if o.eq_ignore_ascii_case(h))
}

/// The connection of the request's token, or the answer to send instead.
fn authorize(st: &AppState, ip: IpAddr, headers: &HeaderMap) -> Result<Arc<Conn>, ApiError> {
    st.limiter.check(ip)?;
    let Some(token) = bearer(headers) else {
        return Err(ApiError::unauthorized("an MCP connection token is required"));
    };
    let Some(conn) = st.mcp.by_token(token) else {
        st.limiter.fail(ip);
        tracing::info!(
            "{}",
            tr!("неверный токен MCP с адреса {ip}", "wrong MCP token from {ip}")
        );
        return Err(ApiError::unauthorized("unknown or replaced MCP connection token"));
    };
    if !identity_active(st, &conn) {
        return Err(ApiError::forbidden(
            "identity_gone",
            "the identity of this connection left the family or was revoked",
        ));
    }
    Ok(conn)
}

/// `GET` and `DELETE` of the endpoint: there are no streams and no sessions.
pub async fn not_allowed() -> Response {
    let mut res = ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "method_not_allowed",
        "the MCP endpoint takes POST only",
    )
    .into_response();
    res.headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    res
}

pub async fn post(State(st): State<Arc<AppState>>, ClientIp(ip): ClientIp, headers: HeaderMap, body: Body) -> Response {
    if !st.settings.mcp {
        return ApiError::not_found("mcp_disabled", "MCP is switched off on this server").into_response();
    }
    if !origin_ok(&headers) {
        return ApiError::forbidden("bad_origin", "requests from another site are not accepted").into_response();
    }
    let conn = match authorize(&st, ip, &headers) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let bytes = match read_body(&headers, body, MAX_REQUEST_BYTES).await {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let msg: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return rpc_error(StatusCode::BAD_REQUEST, None, PARSE_ERROR, "Parse error", None),
    };
    let Some(obj) = msg.as_object() else {
        // Batches left the protocol in 2025-06-18.
        return rpc_error(
            StatusCode::BAD_REQUEST,
            None,
            INVALID_REQUEST,
            "the body must be one JSON-RPC message",
            None,
        );
    };
    let id = obj.get("id").filter(|v| v.is_string() || v.is_number());
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return rpc_error(StatusCode::BAD_REQUEST, id, INVALID_REQUEST, "Invalid request", None);
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return rpc_error(
            StatusCode::BAD_REQUEST,
            id,
            INVALID_REQUEST,
            "jsonrpc must be \"2.0\"",
            None,
        );
    }
    let Some(id) = id else {
        // A notification (`notifications/initialized`, `notifications/cancelled`): taken, nothing to answer.
        return StatusCode::ACCEPTED.into_response();
    };
    let empty = Map::new();
    let params = obj.get("params").and_then(Value::as_object).unwrap_or(&empty);

    // Which revision the request speaks.
    let version = header_str(&headers, "mcp-protocol-version");
    let modern = match (method, version) {
        ("initialize", _) => false,
        (_, Some(MODERN)) => true,
        // Clients older than 2025-06-18 send no version header.
        (_, None) => false,
        (_, Some(v)) if LEGACY.contains(&v) => false,
        (_, Some(v)) => {
            return rpc_error(
                StatusCode::BAD_REQUEST,
                Some(id),
                UNSUPPORTED_VERSION,
                "Unsupported protocol version",
                Some(json!({ "supported": supported(), "requested": v })),
            );
        }
    };
    if modern && let Err(res) = check_modern(&headers, id, method, params) {
        return *res;
    }

    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            json!({
                "protocolVersion": if LEGACY.contains(&asked) { asked } else { LEGACY[0] },
                "capabilities": { "tools": {} },
                "serverInfo": server_info(),
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "server/discover" => json!({
            "supportedVersions": supported(),
            "capabilities": { "tools": {} },
            "instructions": INSTRUCTIONS,
            "ttlMs": 3_600_000,
            "cacheScope": "public",
        }),
        "tools/list" => {
            // Only what the connection's access levels allow: the list depends on the token alone.
            let list: Vec<Value> = tools::tools()
                .iter()
                .filter(|t| conn.allows(t.level))
                .map(|t| t.json())
                .collect();
            json!({ "tools": list, "ttlMs": 0, "cacheScope": "private" })
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return rpc_error(
                    StatusCode::OK,
                    Some(id),
                    INVALID_PARAMS,
                    "params.name is required",
                    None,
                );
            };
            let args = match params.get("arguments") {
                None | Some(Value::Null) => &empty,
                Some(Value::Object(o)) => o,
                Some(_) => {
                    return rpc_error(
                        StatusCode::OK,
                        Some(id),
                        INVALID_PARAMS,
                        "params.arguments must be an object",
                        None,
                    );
                }
            };
            let ctx = Ctx {
                st: st.clone(),
                conn: conn.clone(),
                base: super::files::public_base(&st, &headers),
            };
            let Some(outcome) = tools::call(&ctx, name, args).await else {
                return rpc_error(
                    StatusCode::OK,
                    Some(id),
                    INVALID_PARAMS,
                    format!("Unknown tool: {name}"),
                    None,
                );
            };
            // Who called what, never with what: arguments and results hold message texts.
            let line = tr!(
                "MCP: подключение {} вызвало {name}: {}",
                "MCP: connection {} called {name}: {}",
                conn.file.id,
                match &outcome {
                    Ok(_) => "ok",
                    Err(e) => e.code,
                }
            );
            if tools::find(name).is_some_and(|t| t.effect == tools::Effect::Read) {
                tracing::debug!("{line}");
            } else {
                tracing::info!("{line}");
            }
            match outcome {
                Ok(mut v) => {
                    // Blocks a tool adds next to its JSON (a picture as a picture).
                    let extra = v.as_object_mut().and_then(|o| o.remove("_content"));
                    let mut content = vec![json!({ "type": "text", "text": v.to_string() })];
                    if let Some(Value::Array(blocks)) = extra {
                        content.extend(blocks);
                    }
                    json!({ "content": content })
                }
                Err(e) => json!({
                    "content": [{ "type": "text", "text": json!({ "error": e.code, "message": e.message }).to_string() }],
                    "isError": true,
                }),
            }
        }
        _ => {
            // 2026-07-28 answers an unknown method with 404 and the JSON-RPC error.
            let status = if modern { StatusCode::NOT_FOUND } else { StatusCode::OK };
            return rpc_error(status, Some(id), METHOD_NOT_FOUND, "Method not found", None);
        }
    };
    let mut result = result;
    if modern {
        result["resultType"] = json!("complete");
        result["_meta"] = json!({ META_SERVER: server_info() });
    }
    json_response(StatusCode::OK, &json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// 2026-07-28: the version and what is called are repeated in headers (for
/// proxies that route without reading the body) and must agree with the body.
fn check_modern(
    headers: &HeaderMap,
    id: &Value,
    method: &str,
    params: &Map<String, Value>,
) -> Result<(), Box<Response>> {
    let fail = |code: i64, message: String| Box::new(rpc_error(StatusCode::BAD_REQUEST, Some(id), code, message, None));
    let in_body = params
        .get("_meta")
        .and_then(|m| m.get(META_VERSION))
        .and_then(Value::as_str);
    match in_body {
        None => {
            return Err(fail(
                INVALID_PARAMS,
                format!("params._meta[\"{META_VERSION}\"] is required"),
            ));
        }
        Some(v) if v != MODERN => {
            return Err(fail(
                HEADER_MISMATCH,
                "MCP-Protocol-Version differs from the version in the body".into(),
            ));
        }
        Some(_) => {}
    }
    if header_str(headers, "mcp-method") != Some(method) {
        return Err(fail(
            HEADER_MISMATCH,
            "the Mcp-Method header must repeat the method".into(),
        ));
    }
    if method == "tools/call" {
        let name = params.get("name").and_then(Value::as_str);
        let in_header = header_str(headers, "mcp-name").and_then(header_text);
        if name.is_none() || in_header.as_deref() != name {
            return Err(fail(
                HEADER_MISMATCH,
                "the Mcp-Name header must repeat params.name".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_static(v));
        }
        h
    }

    #[test]
    fn origin_must_be_this_site() {
        assert!(origin_ok(&headers(&[("host", "chat.example")])));
        assert!(origin_ok(&headers(&[
            ("host", "chat.example"),
            ("origin", "https://chat.example")
        ])));
        assert!(origin_ok(&headers(&[
            ("host", "127.0.0.1:8080"),
            ("x-forwarded-host", "chat.example"),
            ("origin", "https://Chat.Example")
        ])));
        assert!(!origin_ok(&headers(&[
            ("host", "chat.example"),
            ("origin", "https://evil.example")
        ])));
        assert!(!origin_ok(&headers(&[("host", "chat.example"), ("origin", "null")])));
    }

    #[test]
    fn base64_header_values() {
        assert_eq!(header_text("message_send").as_deref(), Some("message_send"));
        assert_eq!(header_text("=?base64?0L/RgNC40LLQtdGC?=").as_deref(), Some("привет"));
        assert_eq!(header_text("=?base64?!!!?="), None);
    }
}
