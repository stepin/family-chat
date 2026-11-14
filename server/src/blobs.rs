//! Attachments (docs/PLAN-v2.md, sections 6 and 7.5): opaque encrypted
//! parts in `blobs/<YYYY-MM-DD>/<blobId>/<NNNN>`, the day being the day of
//! the first uploaded part. `meta.json` next to the parts names the uploader.
//!
//! Parts are streamed to a file in `tmp/` and renamed into place; a whole
//! part is never held in memory. Downloads are streamed from the file.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use hyper::body::{Frame, SizeHint};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

use crate::api::{Auth, parse_decimal, too_large};
use crate::app::AppState;
use crate::datadir::{create_private_dir, hex, now_ms, private_file_options, sync_dir, write_atomic_io};
use crate::error::{ApiError, io_error};
use crate::ids::{BlobId, UserId, day_name, day_of_ms, parse_day_name};
use crate::store::{dir_entries, disk_space, to_json};
use crate::webpush::random_bytes;

/// Largest part: 4 MiB of plaintext plus room for the encryption overhead.
pub const MAX_PART_BYTES: u64 = 4 * 1024 * 1024 + 256;
/// Parts are numbered 0..=9999 (`NNNN`).
pub const MAX_PART_INDEX: u32 = 9999;
/// The total size limit is `max_file_mb` MiB plus this, for the overhead.
pub const TOTAL_SLACK_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone)]
pub struct Blob {
    pub day: i64,
    pub owner: UserId,
    pub created_at: u64,
    /// Part number → size in bytes.
    pub parts: BTreeMap<u32, u64>,
}

impl Blob {
    pub fn total(&self) -> u64 {
        self.parts.values().sum()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobMeta {
    owner: UserId,
    created_at: u64,
}

pub struct BlobStore {
    root: PathBuf,
    max_total: u64,
    min_free: u64,
    index: Mutex<HashMap<BlobId, Blob>>,
}

fn part_name(part: u32) -> String {
    format!("{part:04}")
}

fn not_found() -> ApiError {
    ApiError::not_found("blob_not_found", "no such attachment or part")
}

fn not_owner() -> ApiError {
    ApiError::forbidden("not_owner", "only the uploader can change this attachment")
}

impl BlobStore {
    /// Reads the index of `blobs/`. Folders without a readable `meta.json`
    /// are left alone (and removed by the retention with their day).
    pub fn open(data: &Path, max_total: u64, min_free_mb: u64) -> BlobStore {
        let root = data.join("blobs");
        let mut index = HashMap::new();
        for (day_s, day_dir) in dir_entries(&root) {
            let Some(day) = parse_day_name(&day_s) else { continue };
            for (id_s, dir) in dir_entries(&day_dir) {
                let Some(id) = BlobId::parse(&id_s) else { continue };
                let meta: BlobMeta = match std::fs::read(dir.join("meta.json"))
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                {
                    Some(m) => m,
                    None => {
                        tracing::warn!("blobs/{day_s}/{id_s}: нет meta.json, пропускаю");
                        continue;
                    }
                };
                let mut parts = BTreeMap::new();
                for (name, p) in dir_entries(&dir) {
                    if name.len() == 4
                        && name.bytes().all(|b| b.is_ascii_digit())
                        && let (Ok(n), Ok(md)) = (name.parse::<u32>(), std::fs::metadata(&p))
                    {
                        parts.insert(n, md.len());
                    }
                }
                index.insert(
                    id,
                    Blob {
                        day,
                        owner: meta.owner,
                        created_at: meta.created_at,
                        parts,
                    },
                );
            }
        }
        BlobStore {
            root,
            max_total,
            min_free: min_free_mb.saturating_mul(1024 * 1024),
            index: Mutex::new(index),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<BlobId, Blob>> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn dir(&self, day: i64, id: &BlobId) -> PathBuf {
        self.root.join(day_name(day)).join(id.to_string())
    }

    pub fn max_total(&self) -> u64 {
        self.max_total
    }

    pub fn info(&self, id: &BlobId) -> Option<Blob> {
        self.lock().get(id).cloned()
    }

    fn check_space(&self, incoming: u64) -> Result<(), ApiError> {
        if let Some((free, _)) = disk_space(&self.root)
            && free < self.min_free.saturating_add(incoming)
        {
            tracing::warn!("мало места на диске для вложения: свободно {} МБ", free / (1024 * 1024));
            return Err(ApiError::storage_full());
        }
        Ok(())
    }

    fn check_total(&self, blob: Option<&Blob>, part: u32, size: u64) -> Result<(), ApiError> {
        let others = blob.map_or(0, |b| b.total() - b.parts.get(&part).copied().unwrap_or(0));
        if others + size > self.max_total {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "too_large",
                format!("the attachment would be larger than {} bytes", self.max_total),
            )
            .with("limit", self.max_total.into()));
        }
        Ok(())
    }

    /// Checks before receiving a part: owner, total size (with the declared
    /// length when known) and free space.
    pub fn check_put(&self, user: &UserId, id: &BlobId, part: u32, declared: Option<u64>) -> Result<(), ApiError> {
        {
            let idx = self.lock();
            let blob = idx.get(id);
            if blob.is_some_and(|b| b.owner != *user) {
                return Err(not_owner());
            }
            self.check_total(blob, part, declared.unwrap_or(0))?;
        }
        self.check_space(declared.unwrap_or(0))
    }

    /// Moves a received part (a complete, synced file in `tmp/`) into place.
    /// Blocking.
    pub fn commit(
        &self,
        user: &UserId,
        id: &BlobId,
        part: u32,
        tmp: &Path,
        size: u64,
        now: u64,
    ) -> Result<u64, ApiError> {
        let mut idx = self.lock();
        let dir = match idx.get(id) {
            Some(b) if b.owner != *user => return Err(not_owner()),
            Some(b) => {
                self.check_total(Some(b), part, size)?;
                self.dir(b.day, id)
            }
            None => {
                self.check_total(None, part, size)?;
                let day = day_of_ms(now);
                let dir = self.dir(day, id);
                create_private_dir(&dir).map_err(|e| io_error("создание папки вложения", e))?;
                let meta = BlobMeta {
                    owner: *user,
                    created_at: now,
                };
                let data = self.root.parent().unwrap_or(&self.root);
                write_atomic_io(data, &dir.join("meta.json"), &to_json(&meta))
                    .map_err(|e| io_error("запись вложения", e))?;
                idx.insert(
                    *id,
                    Blob {
                        day,
                        owner: *user,
                        created_at: now,
                        parts: BTreeMap::new(),
                    },
                );
                dir
            }
        };
        std::fs::rename(tmp, dir.join(part_name(part))).map_err(|e| io_error("запись части вложения", e))?;
        sync_dir(&dir);
        let b = idx.get_mut(id).expect("inserted above");
        b.parts.insert(part, size);
        Ok(b.total())
    }

    /// Path and size of a stored part.
    pub fn part_path(&self, id: &BlobId, part: u32) -> Option<(PathBuf, u64)> {
        let idx = self.lock();
        let b = idx.get(id)?;
        let size = *b.parts.get(&part)?;
        Some((self.dir(b.day, id).join(part_name(part)), size))
    }

    /// Deletes an attachment (uploader only). Blocking.
    pub fn delete(&self, user: &UserId, id: &BlobId) -> Result<(), ApiError> {
        let mut idx = self.lock();
        let b = idx.get(id).ok_or_else(not_found)?;
        if b.owner != *user {
            return Err(not_owner());
        }
        let dir = self.dir(b.day, id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("удаление вложения", e)),
        }
        idx.remove(id);
        Ok(())
    }

    /// Retention: removes the day folders for which `expired(day)` holds and
    /// forgets their attachments. Returns the removed day names.
    pub fn remove_days(&self, expired: impl Fn(i64) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        let mut idx = self.lock();
        for (name, path) in dir_entries(&self.root) {
            let Some(day) = parse_day_name(&name) else { continue };
            if !expired(day) || !path.is_dir() {
                continue;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    idx.retain(|_, b| b.day != day);
                    out.push(name);
                }
                Err(e) => tracing::error!("не удалось удалить {}: {e}", path.display()),
            }
        }
        out
    }
}

/// A file streamed as a response body, 64 KiB at a time.
struct FileBody {
    file: tokio::fs::File,
    buf: Box<[u8]>,
    remaining: u64,
}

impl hyper::body::Body for FileBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = &mut *self;
        if this.remaining == 0 {
            return Poll::Ready(None);
        }
        let want = this
            .buf
            .len()
            .min(usize::try_from(this.remaining).unwrap_or(usize::MAX));
        let mut rb = ReadBuf::new(&mut this.buf[..want]);
        match Pin::new(&mut this.file).poll_read(cx, &mut rb) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Ready(Ok(())) => {
                let n = rb.filled().len();
                if n == 0 {
                    return Poll::Ready(Some(Err(io::Error::from(io::ErrorKind::UnexpectedEof))));
                }
                this.remaining -= n as u64;
                Poll::Ready(Some(Ok(Frame::data(Bytes::copy_from_slice(rb.filled())))))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

// ---- handlers ----

fn parse_blob(s: &str) -> Result<BlobId, ApiError> {
    BlobId::parse(s).ok_or_else(|| ApiError::bad_request("bad blobId"))
}

fn parse_part(s: &str) -> Result<u32, ApiError> {
    parse_decimal(s)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n <= MAX_PART_INDEX)
        .ok_or_else(|| ApiError::bad_request(format!("part must be 0 to {MAX_PART_INDEX}")))
}

/// How much of a rejected upload is still read before answering. Answering while the client is
/// still sending makes it see a connection reset instead of the error, so the rest of a body of
/// plausible size is read and discarded first.
const DRAIN_CAP_BYTES: u64 = 2 * MAX_PART_BYTES;

/// Reads and discards the rest of a request body, up to `DRAIN_CAP_BYTES`.
async fn drain(mut body: Body) {
    let mut n: u64 = 0;
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(data) = frame.into_data() {
            n += data.len() as u64;
            if n > DRAIN_CAP_BYTES {
                break;
            }
        }
    }
}

/// Streams the request body into `path`, at most `max` bytes; returns the size.
/// A longer body is read to its end (within `DRAIN_CAP_BYTES`) before the error is returned.
async fn receive(body: Body, path: &Path, max: u64) -> Result<u64, ApiError> {
    let mut f = tokio::fs::OpenOptions::from(private_file_options().write(true).create_new(true).to_owned())
        .open(path)
        .await
        .map_err(|e| io_error("временный файл вложения", e))?;
    let mut body = body;
    let mut n: u64 = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| ApiError::bad_request("could not read the request body"))?;
        if let Ok(data) = frame.into_data() {
            n += data.len() as u64;
            if n > max {
                if n > DRAIN_CAP_BYTES {
                    break;
                }
                continue;
            }
            f.write_all(&data)
                .await
                .map_err(|e| io_error("запись части вложения", e))?;
        }
    }
    if n > max {
        return Err(too_large(max as usize));
    }
    f.sync_all().await.map_err(|e| io_error("запись части вложения", e))?;
    Ok(n)
}

pub async fn put_part(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath((id, part)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let id = parse_blob(&id)?;
    let part = parse_part(&part)?;
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_PART_BYTES) {
        drain(body).await;
        return Err(too_large(MAX_PART_BYTES as usize));
    }
    if let Err(e) = st.store.blobs().check_put(&c.user, &id, part, declared) {
        drain(body).await;
        return Err(e);
    }
    let tmp = st
        .store
        .path()
        .join("tmp")
        .join(format!("blob-{}", hex(&random_bytes::<8>())));
    let size = match receive(body, &tmp, MAX_PART_BYTES).await {
        Ok(0) => Err(ApiError::bad_request("part body is empty")),
        r => r,
    };
    let size = match size {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    let st2 = st.clone();
    let tmp2 = tmp.clone();
    let total =
        tokio::task::spawn_blocking(move || st2.store.blobs().commit(&c.user, &id, part, &tmp2, size, now_ms()))
            .await
            .map_err(|_| ApiError::internal("storing the part failed"))
            .and_then(|r| r);
    let total = match total {
        Ok(t) => t,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    Ok(Json(json!({ "blobId": id, "part": part, "size": size, "total": total })).into_response())
}

pub async fn get_part(
    State(st): State<Arc<AppState>>,
    Auth(_): Auth,
    UrlPath((id, part)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let id = parse_blob(&id)?;
    let part = parse_part(&part)?;
    let (path, _) = st.store.blobs().part_path(&id, part).ok_or_else(not_found)?;
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(not_found()),
        Err(e) => return Err(io_error("чтение вложения", e)),
    };
    let len = file.metadata().await.map_err(|e| io_error("чтение вложения", e))?.len();
    let mut res = Response::new(Body::new(FileBody {
        file,
        buf: vec![0u8; 64 * 1024].into_boxed_slice(),
        remaining: len,
    }));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    Ok(res)
}

pub async fn info(
    State(st): State<Arc<AppState>>,
    Auth(_): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let id = parse_blob(&id)?;
    let b = st.store.blobs().info(&id).ok_or_else(not_found)?;
    let parts: Vec<_> = b.parts.iter().map(|(p, s)| json!({ "part": p, "size": s })).collect();
    Ok(Json(json!({
        "blobId": id,
        "owner": b.owner,
        "createdAt": b.created_at,
        "parts": parts,
        "total": b.total(),
        "maxBytes": st.store.blobs().max_total(),
    }))
    .into_response())
}

pub async fn delete(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let id = parse_blob(&id)?;
    let st2 = st.clone();
    tokio::task::spawn_blocking(move || st2.store.blobs().delete(&c.user, &id))
        .await
        .map_err(|_| ApiError::internal("deleting the attachment failed"))??;
    Ok(StatusCode::NO_CONTENT.into_response())
}
