//! Files through MCP. Small ones travel inside a tool call (base64); larger
//! ones through a one-time link `<family>/mcp/files/<code>`: `PUT` to hand a
//! file to the server, `GET` to take one from it. A link works once, for ten
//! minutes, and needs no token: the code is the secret (32 random bytes).
//!
//! The server encrypts what it sends and decrypts what it gives out with the
//! connection's keys, part by part, the way a client does.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use hyper::body::{Frame, SizeHint};
use serde_json::json;

use crate::api::ClientIp;
use crate::app::{ApiError, AppState};
use crate::blobs::receive;
use crate::client::blob::{decrypt_part, encrypt_part, new_blob, part_length};
use crate::client::payload::BlobRef;
use crate::datadir::{hex, now_ms};
use crate::error::io_error;
use crate::ids::{UserId, b64_decode, b64_encode};
use crate::store::{Store, token_hash};
use crate::webpush::random_bytes;

/// A file inside a tool call, decoded.
pub const MAX_INLINE_BYTES: usize = 1024 * 1024;
/// How long a link works.
pub const LINK_TTL: Duration = Duration::from_secs(600);
/// Links to hand a file in that one connection may hold at a time.
pub const MAX_PENDING_UPLOADS: usize = 4;

enum Kind {
    /// Waiting for the `PUT`.
    Upload,
    /// Received: the plaintext waits in `tmp/` for the tool call that sends it.
    Uploaded { path: PathBuf, size: u64 },
    /// Gives out one attachment.
    Download { blob: BlobRef, name: String, mime: String },
}

struct Link {
    conn: String,
    expires: Instant,
    kind: Kind,
}

/// The one-time links of a family's connections (memory only).
#[derive(Default)]
pub struct Links {
    map: Mutex<HashMap<[u8; 32], Link>>,
}

/// A file a connection handed in through a link.
pub struct Uploaded {
    pub path: PathBuf,
    pub size: u64,
}

fn code_key(code: &str) -> [u8; 32] {
    token_hash(code)
}

impl Links {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<[u8; 32], Link>> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        // Expired links go, with the files handed in through them.
        let now = Instant::now();
        map.retain(|_, l| {
            let alive = l.expires > now;
            if !alive && let Kind::Uploaded { path, .. } = &l.kind {
                let _ = std::fs::remove_file(path);
            }
            alive
        });
        map
    }

    fn add(&self, conn: &str, kind: Kind) -> String {
        let code = b64_encode(&random_bytes::<32>());
        self.lock().insert(
            code_key(&code),
            Link {
                conn: conn.to_string(),
                expires: Instant::now() + LINK_TTL,
                kind,
            },
        );
        code
    }

    /// A link to hand a file in. `None`: the connection holds too many already.
    pub fn new_upload(&self, conn: &str) -> Option<String> {
        let pending = self
            .lock()
            .values()
            .filter(|l| l.conn == conn && !matches!(l.kind, Kind::Download { .. }))
            .count();
        (pending < MAX_PENDING_UPLOADS).then(|| self.add(conn, Kind::Upload))
    }

    /// A link to take one attachment.
    pub fn new_download(&self, conn: &str, blob: BlobRef, name: String, mime: String) -> String {
        self.add(conn, Kind::Download { blob, name, mime })
    }

    /// The file handed in through `code`, for the connection that asked for the link. Taken once.
    pub fn take_uploaded(&self, conn: &str, code: &str) -> Option<Uploaded> {
        let mut map = self.lock();
        let key = code_key(code.trim());
        match map.get(&key) {
            Some(l) if l.conn == conn && matches!(l.kind, Kind::Uploaded { .. }) => {}
            _ => return None,
        }
        match map.remove(&key)?.kind {
            Kind::Uploaded { path, size } => Some(Uploaded { path, size }),
            _ => None,
        }
    }

    /// Forgets the links of a deleted connection.
    pub fn forget(&self, conn: &str) {
        let mut map = self.lock();
        map.retain(|_, l| {
            if l.conn == conn
                && let Kind::Uploaded { path, .. } = &l.kind
            {
                let _ = std::fs::remove_file(path);
            }
            l.conn != conn
        });
    }
}

/// Largest file a connection sends or takes, bytes (the server's `max_file_mb`).
pub fn max_file_bytes(st: &AppState) -> u64 {
    st.settings.max_file_mb.saturating_mul(1024 * 1024)
}

// ---- attachments: storing and reading ----

/// Encrypts `data` as a new attachment of `user` and stores its parts.
pub async fn store_blob(st: &Arc<AppState>, user: UserId, data: Vec<u8>) -> Result<BlobRef, ApiError> {
    let blob = new_blob(data.len() as u64, Some(max_file_bytes(st))).map_err(|e| ApiError::bad_request(e.message))?;
    let st = st.clone();
    tokio::task::spawn_blocking(move || {
        let blobs = st.store.blobs();
        let mut at = 0usize;
        for index in 0..blob.parts {
            let len = part_length(&blob, index).map_err(|e| ApiError::internal(e.message))? as usize;
            let part = encrypt_part(&blob, index, &data[at..at + len]).map_err(|e| ApiError::internal(e.message))?;
            at += len;
            blobs.check_put(&user, &blob.id, index, Some(part.len() as u64))?;
            let tmp = st
                .store
                .path()
                .join("tmp")
                .join(format!("mcp-blob-{}", hex(&random_bytes::<8>())));
            let written = crate::datadir::private_file_options()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .and_then(|mut f| {
                    use std::io::Write;
                    f.write_all(&part)?;
                    f.sync_all()
                });
            if let Err(e) = written {
                let _ = std::fs::remove_file(&tmp);
                return Err(io_error("writing an attachment part", e));
            }
            if let Err(e) = blobs.commit(&user, &blob.id, index, &tmp, part.len() as u64, now_ms()) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
        Ok(blob)
    })
    .await
    .map_err(|_| ApiError::internal("storing the attachment failed"))?
}

fn read_part(store: &Store, blob: &BlobRef, index: u32) -> Result<Vec<u8>, ApiError> {
    let gone = || ApiError::new(StatusCode::GONE, "file_gone", "the file is no longer on the server");
    let (path, _) = store.blobs().part_path(&blob.id, index).ok_or_else(gone)?;
    let bytes = std::fs::read(&path).map_err(|_| gone())?;
    decrypt_part(blob, index, &bytes).map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, "bad_file", e.message))
}

/// A whole attachment, decrypted (for small ones).
pub async fn read_blob(st: &Arc<AppState>, blob: BlobRef) -> Result<Vec<u8>, ApiError> {
    let st = st.clone();
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::with_capacity(blob.size as usize);
        for index in 0..blob.parts {
            out.extend_from_slice(&read_part(&st.store, &blob, index)?);
        }
        Ok(out)
    })
    .await
    .map_err(|_| ApiError::internal("reading the attachment failed"))?
}

type PartTask = tokio::task::JoinHandle<Result<Vec<u8>, ApiError>>;

/// An attachment streamed decrypted, one part in memory at a time.
struct PartsBody {
    store: Store,
    blob: BlobRef,
    next: u32,
    task: Option<PartTask>,
    remaining: u64,
}

impl hyper::body::Body for PartsBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        let this = &mut *self;
        if this.task.is_none() {
            if this.next >= this.blob.parts {
                return Poll::Ready(None);
            }
            let (store, blob, index) = (this.store.clone(), this.blob.clone(), this.next);
            this.next += 1;
            this.task = Some(tokio::task::spawn_blocking(move || read_part(&store, &blob, index)));
        }
        let task = this.task.as_mut().expect("set above");
        match Pin::new(task).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(r) => {
                this.task = None;
                match r {
                    Ok(Ok(bytes)) => {
                        this.remaining = this.remaining.saturating_sub(bytes.len() as u64);
                        Poll::Ready(Some(Ok(Frame::data(Bytes::from(bytes)))))
                    }
                    Ok(Err(e)) => Poll::Ready(Some(Err(std::io::Error::other(e.message)))),
                    Err(_) => Poll::Ready(Some(Err(std::io::Error::other("reading the attachment failed")))),
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.task.is_none() && self.next >= self.blob.parts
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

// ---- the link endpoints ----

fn no_link() -> ApiError {
    ApiError::not_found("no_link", "this link was used, has expired or never existed")
}

/// A wrong code counts like a wrong token: ten a minute per address.
fn refuse(st: &AppState, ip: std::net::IpAddr) -> Response {
    st.limiter.fail(ip);
    no_link().into_response()
}

/// `PUT <family>/mcp/files/<code>`: the body is the file.
pub async fn put(
    State(st): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    UrlPath(code): UrlPath<String>,
    body: Body,
) -> Response {
    if !st.settings.mcp {
        return ApiError::not_found("mcp_disabled", "MCP is switched off on this server").into_response();
    }
    if let Err(e) = st.limiter.check(ip) {
        return e.into_response();
    }
    let key = code_key(&code);
    // The link is taken before the body is read: it works once, also when the upload fails.
    let conn = {
        let mut map = st.mcp_links.lock();
        match map.get(&key) {
            Some(l) if matches!(l.kind, Kind::Upload) => map.remove(&key).map(|l| l.conn),
            _ => None,
        }
    };
    let Some(conn) = conn else { return refuse(&st, ip) };
    let tmp = st
        .store
        .path()
        .join("tmp")
        .join(format!("mcp-upload-{}", hex(&random_bytes::<8>())));
    let size = match receive(body, &tmp, max_file_bytes(&st)).await {
        Ok(0) => Err(ApiError::bad_request("the file is empty")),
        r => r,
    };
    let size = match size {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return e.into_response();
        }
    };
    // The same code now names the received file, for the tool call that sends it.
    st.mcp_links.lock().insert(
        key,
        Link {
            conn,
            expires: Instant::now() + LINK_TTL,
            kind: Kind::Uploaded { path: tmp, size },
        },
    );
    axum::Json(json!({ "ok": true, "size": size })).into_response()
}

/// `GET <family>/mcp/files/<code>`: the attachment, decrypted.
pub async fn get(State(st): State<Arc<AppState>>, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>) -> Response {
    if !st.settings.mcp {
        return ApiError::not_found("mcp_disabled", "MCP is switched off on this server").into_response();
    }
    if let Err(e) = st.limiter.check(ip) {
        return e.into_response();
    }
    let key = code_key(&code);
    let link = {
        let mut map = st.mcp_links.lock();
        match map.get(&key) {
            Some(l) if matches!(l.kind, Kind::Download { .. }) => map.remove(&key),
            _ => None,
        }
    };
    let Some(Link {
        kind: Kind::Download { blob, name, mime },
        ..
    }) = link
    else {
        return refuse(&st, ip);
    };
    let size = blob.size;
    let mut res = Response::new(Body::new(PartsBody {
        store: st.store.clone(),
        blob,
        next: 0,
        task: None,
        remaining: size,
    }));
    let h = res.headers_mut();
    // Whatever the file claims to be, a browser must save it, not show or run it.
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    h.insert(
        "x-fc-content-type",
        HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("")),
    );
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let star: String = name.bytes().map(|b| format!("%{b:02X}")).collect();
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{star}")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

/// The public address of this family's endpoint, as the request reached it:
/// what a link is built from.
pub fn public_base(st: &AppState, headers: &HeaderMap) -> Option<String> {
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').next().unwrap_or("").trim())
            .filter(|v| !v.is_empty())
    };
    let host = get("x-forwarded-host").or_else(|| get("host"))?;
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
    {
        return None;
    }
    let scheme = match get("x-forwarded-proto") {
        Some("https") => "https",
        Some("http") => "http",
        _ if st.settings.tls => "https",
        _ => "http",
    };
    let prefix = st.family_id.as_ref().map(|id| format!("/f/{id}")).unwrap_or_default();
    Some(format!("{scheme}://{host}{prefix}"))
}

/// Decodes a file given inside a tool call.
pub fn decode_inline(data: &str) -> Result<Vec<u8>, &'static str> {
    use base64::Engine;
    let trimmed: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if trimmed.len() > MAX_INLINE_BYTES.div_ceil(3) * 4 + 4 {
        return Err("too_large");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&trimmed)
        .ok()
        .or_else(|| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&trimmed).ok())
        .or_else(|| b64_decode(&trimmed))
        .ok_or("bad_base64")?;
    if bytes.len() > MAX_INLINE_BYTES {
        return Err("too_large");
    }
    Ok(bytes)
}
