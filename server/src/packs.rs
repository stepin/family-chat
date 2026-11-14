//! Sticker packs (docs/PLAN.md 6.1 and 7.5, docs/API.md section 10):
//! `packs/<packId>/` holds `meta.json` (uploader, times), the files named
//! `<hash32>.<webp|tgs>` (the name is the hash of the bytes) and, once the
//! pack is published, `pack.json`: the manifest envelope signed by the
//! uploader exactly as received.
//!
//! A pack is uploaded file by file (a draft only its uploader sees), then
//! published with the signed manifest, after which it is immutable and every
//! member can list it and fetch its files. Only the uploader can delete it.
//! Packs are not encrypted (the plan publishes them readable by the family
//! and the server) and are not subject to the message retention: they stay
//! until the uploader deletes them. Drafts that were never published are
//! removed after a day.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::api::{Auth, read_body};
use crate::app::AppState;
use crate::datadir::{create_private_dir, now_ms, write_atomic_io};
use crate::envelope::{
    self, EnvError, Envelope, MAX_PACK_BYTES, MAX_PACK_PAYLOAD, MAX_PACK_STICKERS, MAX_TGS_BYTES, MAX_WEBP_BYTES,
    StickerType,
};
use crate::error::{ApiError, io_error};
use crate::ids::{FileHash, PackId, UserId};
use crate::store::{dir_entries, disk_space, to_json};

/// Packs on one server (published and drafts together).
pub const MAX_PACKS: usize = 200;
/// A draft that was never published is removed after this long.
pub const DRAFT_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// Largest request body of `PUT /v1/packs/<id>`: the envelope JSON.
pub const MAX_MANIFEST_BODY: usize = MAX_PACK_PAYLOAD * 2;
/// Largest sticker file of either type.
pub const MAX_FILE_BYTES: u64 = if MAX_WEBP_BYTES > MAX_TGS_BYTES {
    MAX_WEBP_BYTES
} else {
    MAX_TGS_BYTES
};

#[derive(Debug, Clone)]
pub struct Pack {
    pub owner: UserId,
    pub created_at: u64,
    /// Uploaded files: hash → (type, size).
    pub files: BTreeMap<FileHash, (StickerType, u64)>,
    /// The manifest once published.
    pub manifest: Option<Envelope>,
    pub published_at: Option<u64>,
}

impl Pack {
    pub fn total(&self) -> u64 {
        self.files.values().map(|(_, s)| *s).sum()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackMeta {
    owner: UserId,
    created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published_at: Option<u64>,
}

pub struct PackStore {
    data: PathBuf,
    root: PathBuf,
    min_free: u64,
    index: Mutex<HashMap<PackId, Pack>>,
}

fn file_name(hash: &FileHash, kind: StickerType) -> String {
    format!("{hash}.{}", kind.ext())
}

fn not_found() -> ApiError {
    ApiError::not_found("pack_not_found", "no such sticker pack")
}

fn not_owner() -> ApiError {
    ApiError::forbidden("not_owner", "only the uploader can change or delete this pack")
}

fn too_large(message: impl Into<String>, limit: u64) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", message).with("limit", limit.into())
}

impl PackStore {
    /// Reads `packs/`. Folders without a readable `meta.json` are skipped.
    pub fn open(data: &Path, min_free_mb: u64) -> PackStore {
        let root = data.join("packs");
        let mut index = HashMap::new();
        for (id_s, dir) in dir_entries(&root) {
            let Some(id) = PackId::parse(&id_s) else { continue };
            let meta: PackMeta = match std::fs::read(dir.join("meta.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
            {
                Some(m) => m,
                None => {
                    tracing::warn!("packs/{id_s}: нет meta.json, пропускаю");
                    continue;
                }
            };
            let mut files = BTreeMap::new();
            let mut manifest = None;
            for (name, p) in dir_entries(&dir) {
                if name == "pack.json" {
                    manifest = std::fs::read(&p)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<Envelope>(&b).ok());
                    if manifest.is_none() {
                        tracing::warn!("packs/{id_s}/pack.json повреждён, набор считается черновиком");
                    }
                    continue;
                }
                let Some((stem, ext)) = name.split_once('.') else {
                    continue;
                };
                let (Some(hash), Some(kind)) = (FileHash::parse(stem), StickerType::parse(ext)) else {
                    continue;
                };
                if let Ok(md) = std::fs::metadata(&p) {
                    files.insert(hash, (kind, md.len()));
                }
            }
            let published_at = manifest.as_ref().and(meta.published_at.or(Some(meta.created_at)));
            index.insert(
                id,
                Pack {
                    owner: meta.owner,
                    created_at: meta.created_at,
                    files,
                    manifest,
                    published_at,
                },
            );
        }
        PackStore {
            data: data.to_path_buf(),
            root,
            min_free: min_free_mb.saturating_mul(1024 * 1024),
            index: Mutex::new(index),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PackId, Pack>> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn dir(&self, id: &PackId) -> PathBuf {
        self.root.join(id.to_string())
    }

    pub fn get(&self, id: &PackId) -> Option<Pack> {
        self.lock().get(id).cloned()
    }

    /// Published packs, oldest first.
    pub fn published(&self) -> Vec<(PackId, Pack)> {
        let mut v: Vec<_> = self
            .lock()
            .iter()
            .filter(|(_, p)| p.manifest.is_some())
            .map(|(id, p)| (*id, p.clone()))
            .collect();
        v.sort_by_key(|(id, p)| (p.published_at, id.to_string()));
        v
    }

    fn write_meta(&self, id: &PackId, p: &Pack) -> Result<(), ApiError> {
        let meta = PackMeta {
            owner: p.owner,
            created_at: p.created_at,
            published_at: p.published_at,
        };
        write_atomic_io(&self.data, &self.dir(id).join("meta.json"), &to_json(&meta))
            .map_err(|e| io_error("запись набора стикеров", e))
    }

    fn check_space(&self, incoming: u64) -> Result<(), ApiError> {
        if let Some((free, _)) = disk_space(&self.root)
            && free < self.min_free.saturating_add(incoming)
        {
            tracing::warn!("мало места на диске для стикеров: свободно {} МБ", free / (1024 * 1024));
            return Err(ApiError::storage_full());
        }
        Ok(())
    }

    /// Stores one file of a draft (blocking). Repeating an upload is fine.
    pub fn put_file(
        &self,
        user: &UserId,
        id: &PackId,
        hash: &FileHash,
        bytes: &[u8],
        now: u64,
    ) -> Result<(StickerType, u64), ApiError> {
        let kind = StickerType::sniff(bytes).ok_or_else(|| {
            ApiError::bad_request("a sticker must be a WebP image or a .tgs file").code("bad_sticker")
        })?;
        let size = bytes.len() as u64;
        if size > kind.max_bytes() {
            return Err(too_large(
                format!("a .{} sticker must be at most {} bytes", kind.ext(), kind.max_bytes()),
                kind.max_bytes(),
            ));
        }
        if FileHash::of(bytes) != *hash {
            return Err(ApiError::bad_request("the file name is not the hash of its bytes").code("hash_mismatch"));
        }
        let mut idx = self.lock();
        let creating = match idx.get(id) {
            Some(p) if p.owner != *user => return Err(not_owner()),
            Some(p) if p.manifest.is_some() => {
                return Err(ApiError::conflict(
                    "pack_published",
                    "a published pack cannot be changed",
                ));
            }
            Some(p) => {
                if let Some((k, s)) = p.files.get(hash) {
                    return Ok((*k, *s));
                }
                if p.files.len() >= MAX_PACK_STICKERS {
                    return Err(too_large(
                        format!("a pack has at most {MAX_PACK_STICKERS} files"),
                        MAX_PACK_STICKERS as u64,
                    ));
                }
                if p.total() + size > MAX_PACK_BYTES {
                    return Err(too_large(
                        format!("a pack is at most {MAX_PACK_BYTES} bytes"),
                        MAX_PACK_BYTES,
                    ));
                }
                false
            }
            None => {
                if idx.len() >= MAX_PACKS {
                    return Err(ApiError::new(
                        StatusCode::INSUFFICIENT_STORAGE,
                        "too_many_packs",
                        "the server keeps no more sticker packs",
                    )
                    .with("limit", MAX_PACKS.into()));
                }
                true
            }
        };
        self.check_space(size)?;
        let dir = self.dir(id);
        if creating {
            create_private_dir(&dir).map_err(|e| io_error("создание папки набора", e))?;
            let p = Pack {
                owner: *user,
                created_at: now,
                files: BTreeMap::new(),
                manifest: None,
                published_at: None,
            };
            self.write_meta(id, &p)?;
            idx.insert(*id, p);
        }
        write_atomic_io(&self.data, &dir.join(file_name(hash, kind)), bytes)
            .map_err(|e| io_error("запись стикера", e))?;
        idx.get_mut(id).expect("present").files.insert(*hash, (kind, size));
        Ok((kind, size))
    }

    /// Publishes a draft with its verified manifest (blocking). Files the
    /// manifest does not list are removed. Publishing the same manifest again
    /// succeeds; a different one is refused.
    pub fn publish(&self, user: &UserId, id: &PackId, m: &envelope::PackManifest, now: u64) -> Result<Pack, ApiError> {
        let mut idx = self.lock();
        let p = idx.get(id).ok_or_else(not_found)?;
        if p.owner != *user {
            return Err(not_owner());
        }
        if let Some(existing) = &p.manifest {
            if *existing == m.envelope {
                return Ok(p.clone());
            }
            return Err(ApiError::conflict(
                "pack_published",
                "a published pack cannot be changed",
            ));
        }
        for s in &m.stickers {
            match p.files.get(&s.file) {
                Some((k, size)) if *k == s.kind && *size == s.size => {}
                Some(_) => {
                    return Err(
                        ApiError::conflict("file_mismatch", "a listed file has another type or size")
                            .with("file", s.file.to_string().into()),
                    );
                }
                None => {
                    return Err(ApiError::conflict("missing_file", "a listed file was not uploaded")
                        .with("file", s.file.to_string().into()));
                }
            }
        }
        let dir = self.dir(id);
        let listed: std::collections::HashSet<FileHash> = m.stickers.iter().map(|s| s.file).collect();
        let extra: Vec<(FileHash, StickerType)> = p
            .files
            .iter()
            .filter(|(h, _)| !listed.contains(h))
            .map(|(h, (k, _))| (*h, *k))
            .collect();
        let envelope_json = serde_json::to_vec(&m.envelope).expect("serialisable");
        write_atomic_io(&self.data, &dir.join("pack.json"), &envelope_json)
            .map_err(|e| io_error("запись набора стикеров", e))?;
        let mut next = p.clone();
        next.manifest = Some(m.envelope.clone());
        next.published_at = Some(now);
        for (h, k) in &extra {
            let _ = std::fs::remove_file(dir.join(file_name(h, *k)));
            next.files.remove(h);
        }
        self.write_meta(id, &next)?;
        idx.insert(*id, next.clone());
        Ok(next)
    }

    /// Path and size of a file of a published pack.
    pub fn file_path(&self, id: &PackId, hash: &FileHash) -> Option<(PathBuf, u64)> {
        let idx = self.lock();
        let p = idx.get(id).filter(|p| p.manifest.is_some())?;
        let (kind, size) = p.files.get(hash)?;
        Some((self.dir(id).join(file_name(hash, *kind)), *size))
    }

    /// Deletes a pack (uploader only), published or not. Blocking.
    pub fn delete(&self, user: &UserId, id: &PackId) -> Result<(), ApiError> {
        let mut idx = self.lock();
        let p = idx.get(id).ok_or_else(not_found)?;
        if p.owner != *user {
            return Err(not_owner());
        }
        match std::fs::remove_dir_all(self.dir(id)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("удаление набора стикеров", e)),
        }
        idx.remove(id);
        Ok(())
    }

    /// Removes drafts older than [`DRAFT_TTL_MS`]. Returns how many.
    pub fn remove_stale_drafts(&self, now: u64) -> usize {
        let mut idx = self.lock();
        let stale: Vec<PackId> = idx
            .iter()
            .filter(|(_, p)| p.manifest.is_none() && now.saturating_sub(p.created_at) > DRAFT_TTL_MS)
            .map(|(id, _)| *id)
            .collect();
        for id in &stale {
            match std::fs::remove_dir_all(self.dir(id)) {
                Ok(()) => {
                    idx.remove(id);
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    idx.remove(id);
                }
                Err(e) => tracing::error!("не удалось удалить черновик набора {id}: {e}"),
            }
        }
        stale.len()
    }
}

// ---- handlers ----

fn parse_pack(s: &str) -> Result<PackId, ApiError> {
    PackId::parse(s).ok_or_else(|| ApiError::bad_request("bad packId"))
}

fn parse_hash(s: &str) -> Result<FileHash, ApiError> {
    FileHash::parse(s).ok_or_else(|| ApiError::bad_request("bad file hash"))
}

fn pack_json(id: &PackId, p: &Pack) -> Value {
    json!({
        "packId": id,
        "owner": p.owner,
        "manifest": p.manifest,
        "publishedAt": p.published_at,
        "bytes": p.total(),
    })
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> Result<R, ApiError> + Send + 'static) -> Result<R, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| ApiError::internal("storing the sticker pack failed"))?
}

/// `PUT /v1/packs/<packId>/files/<hash>`: one file of a draft.
pub async fn put_file(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath((id, hash)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let id = parse_pack(&id)?;
    let hash = parse_hash(&hash)?;
    // Read a little past the limit before refusing, so the client sees the
    // answer instead of a connection reset in the middle of its upload.
    let bytes = read_body(&headers, body, 2 * MAX_FILE_BYTES as usize).await?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large(
            format!("a sticker file must be at most {MAX_FILE_BYTES} bytes"),
            MAX_FILE_BYTES,
        ));
    }
    let st2 = st.clone();
    let (kind, size) = blocking(move || st2.packs.put_file(&c.user, &id, &hash, &bytes, now_ms())).await?;
    Ok(Json(json!({ "packId": id, "file": hash, "type": kind.ext(), "size": size })).into_response())
}

/// `PUT /v1/packs/<packId>`: publish the draft with its signed manifest.
pub async fn publish(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let id = parse_pack(&id)?;
    let raw = read_body(&headers, body, MAX_MANIFEST_BODY).await?;
    let env: Envelope =
        serde_json::from_slice(&raw).map_err(|e| ApiError::bad_request(format!("bad JSON body: {e}")))?;
    let (manifest, bytes) = envelope::parse_sticker_pack(&env, &st.server_id).map_err(pack_error)?;
    if manifest.pack_id != id {
        return Err(ApiError::bad_request("the manifest is for another pack"));
    }
    if manifest.author != c.user {
        return Err(ApiError::forbidden(
            "not_author",
            "the manifest must be signed by the uploader",
        ));
    }
    let key = st
        .store
        .read(|m| m.users.get(&c.user).map(|u| u.identity.key))
        .ok_or_else(|| ApiError::internal("caller vanished"))?;
    envelope::verify_sticker_pack(&env, &bytes, &key).map_err(pack_error)?;
    let st2 = st.clone();
    let p = blocking(move || st2.packs.publish(&c.user, &id, &manifest, now_ms())).await?;
    tracing::info!("опубликован набор стикеров {id}");
    Ok(Json(pack_json(&id, &p)).into_response())
}

fn pack_error(e: EnvError) -> ApiError {
    match e {
        EnvError::Malformed(m) => ApiError::bad_request(format!("manifest: {m}")).code("bad_manifest"),
        EnvError::BadSignature => ApiError::bad_request("manifest signature does not verify").code("bad_signature"),
    }
}

/// `GET /v1/packs`: published packs of the family.
pub async fn list(State(st): State<Arc<AppState>>, Auth(_): Auth) -> Response {
    let packs: Vec<Value> = st.packs.published().iter().map(|(id, p)| pack_json(id, p)).collect();
    Json(json!({ "packs": packs })).into_response()
}

/// `GET /v1/packs/<packId>`: one published pack.
pub async fn get(
    State(st): State<Arc<AppState>>,
    Auth(_): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let id = parse_pack(&id)?;
    let p = st
        .packs
        .get(&id)
        .filter(|p| p.manifest.is_some())
        .ok_or_else(not_found)?;
    Ok(Json(pack_json(&id, &p)).into_response())
}

/// `GET /v1/packs/<packId>/files/<hash>`: a file of a published pack.
pub async fn get_file(
    State(st): State<Arc<AppState>>,
    Auth(_): Auth,
    UrlPath((id, hash)): UrlPath<(String, String)>,
) -> Result<Response, ApiError> {
    let id = parse_pack(&id)?;
    let hash = parse_hash(&hash)?;
    let missing = || ApiError::not_found("file_not_found", "no such sticker file");
    let (path, _) = st.packs.file_path(&id, &hash).ok_or_else(missing)?;
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(missing()),
        Err(e) => return Err(io_error("чтение стикера", e)),
    };
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(res)
}

/// `DELETE /v1/packs/<packId>`: the uploader deletes the pack for everyone.
pub async fn delete(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let id = parse_pack(&id)?;
    let st2 = st.clone();
    blocking(move || st2.packs.delete(&c.user, &id)).await?;
    tracing::info!("удалён набор стикеров {id}");
    Ok(StatusCode::NO_CONTENT.into_response())
}
