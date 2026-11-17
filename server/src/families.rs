//! Several families on one fcd. The root family lives in the data folder
//! itself and answers at the server's address; every extra family is a
//! "virtual server" at `/f/<familyId>` with its own folder
//! `families/<familyId>/` (same layout, no lock or config.toml of its own),
//! its own serverId, members, codes and data. Settings, the web client, the
//! failure limiter, the push key and the Telegram client are shared.
//!
//! A family is created only with the server code (`POST /v1/families` at the
//! root), which never lets anyone into a family: the answer carries a
//! one-time setup code of the new family, and its first administrator joins
//! with it at `/f/<id>/v1/join` as usual. On a fresh server the same request
//! gives the setup code of the root family instead.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use unicode_normalization::UnicodeNormalization;

use crate::api;
use crate::app::{self, AppState, Common};
use crate::datadir::{
    self, DataDir, FAMILIES_DIR, FORMAT_VERSION, SERVER_FILE, ServerFile, new_family_id, now_ms, valid_family_id,
};
use crate::error::ApiError;
use crate::headers;
use crate::webpush::{VapidKey, random_bytes};

/// How long a repeat of a creation with the same `Idempotency-Key` finds the family.
pub const CREATION_KEY_TTL_MS: u64 = 24 * 3600 * 1000;
/// Longest family name, characters.
pub const MAX_FAMILY_NAME_CHARS: usize = 100;

/// A family of the table: running, or broken (its address answers 503).
#[derive(Clone)]
pub enum Family {
    Ready { state: Arc<AppState>, router: Router },
    Broken { name: Option<String>, reason: String },
}

/// One line of `fcd families list` (read from disk).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyLine {
    /// `None` for the root family.
    pub id: Option<String>,
    pub name: Option<String>,
    pub set_up: bool,
    /// Why the family cannot be opened.
    pub broken: Option<String>,
}

/// The families of this fcd.
pub struct Families {
    root_path: PathBuf,
    common: Common,
    vapid: VapidKey,
    root: Arc<AppState>,
    root_router: Router,
    table: RwLock<HashMap<String, Family>>,
    /// One creation at a time, all the way from the name check to the table.
    create: tokio::sync::Mutex<()>,
}

/// A name as compared for uniqueness: NFC, trimmed, lower case.
pub fn name_key(name: &str) -> String {
    name.trim().nfc().collect::<String>().to_lowercase()
}

/// Starts what every running family needs: maintenance until the shared stop signal.
pub fn spawn_family(state: &Arc<AppState>) {
    app::spawn_maintenance(state.clone());
}

fn read_line(dir: &Path) -> (Option<String>, bool, Option<String>) {
    let p = dir.join(SERVER_FILE);
    match std::fs::read(&p) {
        Ok(bytes) => match serde_json::from_slice::<ServerFile>(&bytes) {
            Ok(s) if s.format_version > FORMAT_VERSION => (
                s.family_name.clone(),
                false,
                Some(tr!(
                    "формат {} новее этой версии fcd",
                    "format {} is newer than this fcd",
                    s.format_version
                )),
            ),
            Ok(s) => {
                let broken = s.family_name.as_deref().is_none_or(|n| n.trim().is_empty()).then(|| {
                    crate::lang::l("нет имени семьи в server.json", "no family name in server.json").to_string()
                });
                (s.family_name.clone(), s.is_set_up(), broken)
            }
            Err(e) => (
                None,
                false,
                Some(tr!("server.json повреждён: {e}", "server.json is damaged: {e}")),
            ),
        },
        Err(e) => (
            None,
            false,
            Some(tr!("не читается server.json: {e}", "server.json cannot be read: {e}")),
        ),
    }
}

/// The families of a data folder as they are on disk (read only, no lock:
/// works while the server runs). The root family first, `name` from
/// `root_name`.
pub fn scan(root: &Path, root_name: &str) -> Vec<FamilyLine> {
    let set_up = std::fs::read(root.join(SERVER_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<ServerFile>(&b).ok())
        .is_some_and(|s| s.is_set_up());
    let mut out = vec![FamilyLine {
        id: None,
        name: Some(root_name.to_string()),
        set_up,
        broken: None,
    }];
    let mut ids: Vec<String> = std::fs::read_dir(root.join(FAMILIES_DIR))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| valid_family_id(n))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    for id in ids {
        let (name, set_up, broken) = read_line(&root.join(FAMILIES_DIR).join(&id));
        out.push(FamilyLine {
            id: Some(id),
            name,
            set_up,
            broken,
        });
    }
    out
}

impl Families {
    /// Opens the root family and every family in `families/`. A family that
    /// cannot be opened is broken (503 at its address, a line in the log);
    /// the server starts anyway.
    pub fn start(root: &DataDir, common: Common) -> Result<Arc<Families>, String> {
        let root_state = AppState::open(root, &common, None)?;
        spawn_family(&root_state);
        let mut table = HashMap::new();
        let mut ids: Vec<String> = std::fs::read_dir(root.path.join(FAMILIES_DIR))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| valid_family_id(n))
                    .collect()
            })
            .unwrap_or_default();
        ids.sort();
        for id in ids {
            let family = open_one(&root.path, &id, &root.vapid, &common);
            table.insert(id, family);
        }
        Ok(Arc::new(Families {
            root_path: root.path.clone(),
            vapid: root.vapid.clone(),
            root_router: app::router(root_state.clone()),
            root: root_state,
            common,
            table: RwLock::new(table),
            create: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn root(&self) -> &Arc<AppState> {
        &self.root
    }

    pub fn get(&self, id: &str) -> Option<Family> {
        self.table.read().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    /// Ids and states of the extra families (for the log at start).
    pub fn summary(&self) -> (usize, Vec<(String, String)>) {
        let t = self.table.read().unwrap_or_else(|e| e.into_inner());
        let broken = t
            .iter()
            .filter_map(|(id, f)| match f {
                Family::Broken { reason, .. } => Some((id.clone(), reason.clone())),
                Family::Ready { .. } => None,
            })
            .collect();
        (t.len(), broken)
    }

    /// Is the name used by another family of this fcd (case-insensitive, after NFC)?
    fn name_taken(&self, name: &str) -> bool {
        let key = name_key(name);
        if name_key(&self.common.settings.family_name) == key {
            return true;
        }
        let t = self.table.read().unwrap_or_else(|e| e.into_inner());
        t.values().any(|f| match f {
            Family::Ready { state, .. } => name_key(&state.family_name()) == key,
            Family::Broken { name, .. } => name.as_deref().is_some_and(|n| name_key(n) == key),
        })
    }

    /// The family created by `key` (root included), if any: its id (`None`
    /// for the root), the name it was asked for and when.
    fn find_key(&self, key: &str) -> Option<(Option<String>, String, u64)> {
        let by = |s: &ServerFile| {
            (s.creation_key.as_deref() == Some(key))
                .then(|| (s.creation_fingerprint.clone().unwrap_or_default(), s.created_at))
        };
        if let Some((fp, at)) = self.root.store.read(|m| by(&m.server)) {
            return Some((None, fp, at));
        }
        let t = self.table.read().unwrap_or_else(|e| e.into_inner());
        for (id, f) in t.iter() {
            match f {
                Family::Ready { state, .. } => {
                    if let Some((fp, at)) = state.store.read(|m| by(&m.server)) {
                        return Some((Some(id.clone()), fp, at));
                    }
                }
                Family::Broken { .. } => {
                    // A broken family may still have a readable server.json.
                    let p = self.root_path.join(FAMILIES_DIR).join(id).join(SERVER_FILE);
                    if let Some(s) = std::fs::read(p)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<ServerFile>(&b).ok())
                        && let Some((fp, at)) = by(&s)
                    {
                        return Some((Some(id.clone()), fp, at));
                    }
                }
            }
        }
        None
    }

    /// `POST /v1/families` after the server code was checked: the root's
    /// setup code on a fresh server, otherwise a new family. A repeat with
    /// the same key returns the same family (and a new setup code while it is
    /// not set up).
    pub async fn create(self: &Arc<Self>, name: Option<String>, key: Option<String>) -> Result<Created, ApiError> {
        let _one = self.create.lock().await;
        if *self.common.shutdown.borrow() {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "shutting_down",
                "the server is stopping",
            ));
        }
        let now = now_ms();
        let name = name.map(|n| n.trim().nfc().collect::<String>()).unwrap_or_default();
        if let Some(k) = &key
            && let Some((id, fingerprint, at)) = self.find_key(k)
            && now.saturating_sub(at) <= CREATION_KEY_TTL_MS
        {
            if fingerprint != name {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "idempotency_conflict",
                    "this Idempotency-Key was used with another family name",
                ));
            }
            let state = match &id {
                None => self.root.clone(),
                Some(id) => match self.get(id) {
                    Some(Family::Ready { state, .. }) => state,
                    _ => return Err(unavailable()),
                },
            };
            let code = state.store.write(move |w| w.new_setup_code(now)).await?;
            return match code {
                Some(code) => Ok(Created { id, code }),
                None => Err(ApiError::conflict("already_set_up", "this family is set up already")
                    .with("path", json!(path_of(id.as_deref())))),
            };
        }

        // A fresh server: the root family is set up first, the same way.
        if !self.root.store.read(|m| m.server.is_set_up()) {
            let fp = name.clone();
            let code = self
                .root
                .store
                .write(move |w| w.new_root_setup_code(now, key, fp))
                .await?
                .ok_or_else(|| ApiError::internal("root family state changed"))?;
            return Ok(Created { id: None, code });
        }

        let chars = name.chars().count();
        if chars == 0 || chars > MAX_FAMILY_NAME_CHARS || name.chars().any(char::is_control) {
            return Err(ApiError::bad_request("familyName must be 1 to 100 characters"));
        }
        if self.name_taken(&name) {
            return Err(ApiError::conflict(
                "name_taken",
                "another family of this server has this name",
            ));
        }
        let mut id = new_family_id();
        while self.root_path.join(FAMILIES_DIR).join(&id).exists() {
            id = new_family_id();
        }
        let mut server = ServerFile {
            format_version: FORMAT_VERSION,
            server_id: base64_id(),
            created_at: now,
            setup_done: Some(false),
            family_name: Some(name.clone()),
            creation_key: key,
            creation_fingerprint: Some(name),
            ..Default::default()
        };
        let code = server.new_join_code(now, datadir::SETUP_CODE_TTL_MS);
        let root = self.root_path.clone();
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || build_family(&root, &id2, &server))
            .await
            .map_err(|_| ApiError::internal("family creation failed"))?
            .map_err(|e| crate::error::io_error(crate::lang::l("создание семьи", "creating a family"), e))?;
        let family = open_one(&self.root_path, &id, &self.vapid, &self.common);
        let ok = matches!(family, Family::Ready { .. });
        self.table
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), family);
        if !ok {
            return Err(ApiError::internal("the new family could not be started"));
        }
        tracing::info!("{}", tr!("создана семья {id}", "family {id} created"));
        Ok(Created { id: Some(id), code })
    }

    /// The server code checks out: `Ok`; otherwise the API error to answer.
    fn check_server_code(&self, code: &str) -> Result<(), ApiError> {
        let hash = self.root.store.read(|m| m.server.server_code_hash.clone());
        if hash.is_empty() {
            return Err(ApiError::forbidden(
                "admin_code_not_set",
                "this server has no admin code yet; run `fcd reset-admin-code` on the server",
            ));
        }
        if !datadir::check_admin_code(&hash, code) {
            return Err(ApiError::forbidden("bad_admin_code", "wrong server admin code"));
        }
        Ok(())
    }
}

/// What a creation gives: the family (`None`: the root) and its setup code.
pub struct Created {
    pub id: Option<String>,
    pub code: String,
}

fn path_of(id: Option<&str>) -> String {
    id.map(|i| format!("/f/{i}")).unwrap_or_default()
}

fn base64_id() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<16>())
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "family_unavailable",
        "this family is temporarily unavailable on the server; tell the server owner",
    )
}

/// Builds `tmp/family-<id>` and renames it into `families/<id>`: a family
/// either exists whole or not at all.
fn build_family(root: &Path, id: &str, server: &ServerFile) -> std::io::Result<()> {
    let tmp = root.join("tmp").join(format!("family-{id}"));
    let result = (|| {
        datadir::create_private_dir(&tmp)?;
        for d in datadir::DIRS {
            datadir::create_private_dir(&tmp.join(d))?;
        }
        let json = serde_json::to_vec_pretty(server).expect("serialisable");
        datadir::write_atomic_io(&tmp, &tmp.join(SERVER_FILE), &json)?;
        let families = root.join(FAMILIES_DIR);
        datadir::create_private_dir(&families)?;
        std::fs::rename(&tmp, families.join(id))?;
        datadir::sync_dir(&families);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    result
}

/// Opens and starts one extra family, or marks it broken.
fn open_one(root: &Path, id: &str, vapid: &VapidKey, common: &Common) -> Family {
    let opened = DataDir::open_family(root, id, vapid.clone())
        .map_err(|e| e.to_string())
        .and_then(|dir| AppState::open(&dir, common, Some(id.to_string())));
    match opened {
        Ok(state) => {
            spawn_family(&state);
            Family::Ready {
                router: app::router(state.clone()),
                state,
            }
        }
        Err(reason) => {
            tracing::error!(
                "{}",
                tr!(
                    "семья {id} не открылась и недоступна (503): {reason}",
                    "family {id} could not be opened and is unavailable (503): {reason}"
                )
            );
            let (name, _, _) = read_line(&root.join(FAMILIES_DIR).join(id));
            Family::Broken { name, reason }
        }
    }
}

// ---- HTTP ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    family_name: Option<String>,
    admin_code: String,
}

/// `POST /v1/families` at the root address.
async fn create_family(State(f): State<Arc<Families>>, req: Request) -> Result<Response, ApiError> {
    let (parts, body) = req.into_parts();
    let ip = api::client_ip(&parts.headers, &parts.extensions, f.common.settings.trust_forwarded_for);
    f.common.limiter.check(ip)?;
    let b: CreateBody = api::read_json(&parts.headers, body).await?;
    if let Err(e) = f.check_server_code(&b.admin_code) {
        if e.is_auth_failure() {
            f.common.limiter.fail(ip);
            tracing::info!(
                "{}",
                tr!(
                    "неверный код администратора сервера с адреса {ip}",
                    "wrong server admin code from {ip}"
                )
            );
        }
        return Err(e);
    }
    let key = idempotency_key(&parts.headers)?;
    let created = f.create(b.family_name, key).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "familyId": created.id,
            "path": path_of(created.id.as_deref()),
            "setupCode": created.code,
        })),
    )
        .into_response())
}

fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(v) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let v = v
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|v| (1..=128).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or_else(|| ApiError::bad_request("bad Idempotency-Key"))?;
    Ok(Some(v.to_string()))
}

/// An answer of the outer router itself: the API's JSON with CORS and no caching.
fn outer(status: StatusCode, code: &'static str, message: &str) -> Response {
    let mut res = ApiError::new(status, code, message).into_response();
    let h = res.headers_mut();
    app::add_cors(h);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res
}

fn not_found() -> Response {
    outer(StatusCode::NOT_FOUND, "not_found", "no such family on this server")
}

/// A path segment that is `.` or `..`, also written with `%2e`.
fn dot_segment(seg: &str) -> bool {
    let s = seg.to_ascii_lowercase().replace("%2e", ".");
    s == "." || s == ".."
}

/// The router of the whole server: `/f/<id>/…` goes to that family with the
/// prefix taken off, `POST /v1/families` to the creation, the rest to the
/// root family. Paths are matched as they came (not decoded).
pub fn router(f: Arc<Families>) -> Router {
    let create = Router::new()
        .route("/v1/families", post(create_family))
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "method not allowed for this endpoint",
            )
        })
        .layer(middleware::from_fn(app::cors))
        .layer(middleware::from_fn(headers::security_headers))
        .with_state(f.clone());
    Router::new()
        .fallback(dispatch)
        .with_state(Arc::new(Outer { f, create }))
}

struct Outer {
    f: Arc<Families>,
    create: Router,
}

async fn dispatch(State(o): State<Arc<Outer>>, mut req: Request<Body>) -> Response {
    let f = &o.f;
    let path = req.uri().path().to_string();
    if path == "/v1/families" {
        return o.create.clone().oneshot(req).await.into_response();
    }
    let Some(rest) = path.strip_prefix("/f/") else {
        return f.root_router.clone().oneshot(req).await.into_response();
    };
    let id = rest.split('/').next().unwrap_or("");
    if !valid_family_id(id) {
        return not_found();
    }
    let after = &rest[id.len()..];
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let family = match f.get(id) {
        Some(fam) => fam,
        None => return not_found(),
    };
    if after.is_empty() {
        // `/f/<id>` → `/f/<id>/`, or relative assets would be looked up in /f/.
        let mut res = (
            StatusCode::PERMANENT_REDIRECT,
            [
                (header::LOCATION, format!("{id}/{query}")),
                (header::CACHE_CONTROL, "no-store".into()),
            ],
        )
            .into_response();
        res.headers_mut()
            .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        return res;
    }
    if after.split('/').any(dot_segment) {
        return not_found();
    }
    match family {
        Family::Broken { .. } => {
            let mut res = unavailable().into_response();
            let h = res.headers_mut();
            app::add_cors(h);
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            res
        }
        Family::Ready { router, .. } => {
            let Ok(uri) = format!("{after}{query}").parse::<Uri>() else {
                return not_found();
            };
            *req.uri_mut() = uri;
            router.oneshot(req).await.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_compare_after_nfc_and_case() {
        // "й" composed and decomposed.
        assert_eq!(name_key(" Иванов\u{0439} "), name_key("ИВАНОВИ\u{0306}"));
        assert_ne!(name_key("Ивановы"), name_key("Петровы"));
    }

    #[test]
    fn dot_segments() {
        assert!(dot_segment(".."));
        assert!(dot_segment("%2E%2e"));
        assert!(dot_segment("."));
        assert!(!dot_segment("a.b"));
    }
}
