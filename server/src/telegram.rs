//! Telegram sticker sets by link (`t.me/addstickers/<name>`).
//!
//! Sets are only available through the Bot API with a bot token. The token
//! stays on the server: members ask `GET /v1/telegram/sets/{name}` for the
//! list and `GET /v1/telegram/sets/{name}/files/{id}` for each file, and the
//! server talks to Telegram. One client for the whole fcd (every family):
//! one budget of requests per token, one cache of sets.
//!
//! The token never reaches a log line: URLs with it are built and printed
//! only through [`TgUrl`], which shows `bot***`.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, broadcast};

use crate::api::Auth;
use crate::app::AppState;
use crate::config::{Secret, TelegramSettings};
use crate::error::ApiError;

/// One deadline for a whole request to either route.
pub const ROUTE_DEADLINE: Duration = Duration::from_secs(40);
/// Longest wait (the token budget or Telegram's `retry_after`) a request is held for.
pub const MAX_WAIT: Duration = Duration::from_secs(15);
/// Longest single call to Telegram.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Requests to Telegram per second, for the whole fcd.
pub const MAX_REQUESTS_PER_SECOND: usize = 20;
/// Sets loaded (`getStickerSet`) at the same time, for the whole fcd.
pub const MAX_SET_LOADS: usize = 2;
/// File requests of one device at the same time.
pub const DEVICE_MAX_FILES: u32 = 3;
/// Requests of one device per [`DEVICE_WINDOW`].
pub const DEVICE_MAX_REQUESTS: usize = 300;
pub const DEVICE_WINDOW: Duration = Duration::from_secs(600);
/// How long the list of a set is kept.
pub const SET_TTL: Duration = Duration::from_secs(600);
/// How long a `file_path` from `getFile` is kept (Telegram promises an hour).
pub const FILE_PATH_TTL: Duration = Duration::from_secs(3600);
/// Sets in the cache at most (least recently used go first).
pub const MAX_CACHED_SETS: usize = 256;
/// Largest JSON answer of Telegram read.
pub const MAX_JSON_BYTES: usize = 1024 * 1024;
/// A rejected token is reported in the log at most this often.
pub const TOKEN_WARNING_PERIOD: Duration = Duration::from_secs(3600);

/// A sticker kind the app shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Webp,
    Tgs,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Webp => "webp",
            Kind::Tgs => "tgs",
        }
    }

    fn limit(self) -> usize {
        match self {
            Kind::Webp => crate::envelope::MAX_WEBP_BYTES as usize,
            Kind::Tgs => crate::envelope::MAX_TGS_BYTES as usize,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SetSticker {
    /// `file_unique_id`: stable, how the client addresses the file.
    pub id: String,
    file_id: String,
    pub emoji: Option<String>,
    pub kind: Kind,
}

#[derive(Debug, Clone)]
pub struct StickerSet {
    pub name: String,
    pub title: String,
    pub stickers: Vec<SetSticker>,
    pub video: usize,
    pub other: usize,
    fetched: Instant,
}

/// What went wrong with Telegram, before it becomes an API error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TgError {
    /// `STICKERSET_INVALID`.
    NotFound,
    /// The sticker is no longer in the set.
    Stale,
    /// A set of custom emoji, not stickers.
    EmojiSet,
    /// `reason`: `token_rejected`, `upstream_error`, `timeout`, `network`, `bad_file`.
    Unavailable(&'static str),
    /// Wait this many seconds (the token budget or Telegram's flood control).
    Busy(u64),
    /// 404 on a file download: the `file_path` expired.
    Gone,
}

impl TgError {
    pub fn into_api(self) -> ApiError {
        match self {
            TgError::NotFound => ApiError::not_found("not_found", "sticker set not found"),
            TgError::Stale => ApiError::not_found("not_found", "the sticker is no longer in the set")
                .with("reason", json!("stale_set")),
            TgError::EmojiSet => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "telegram_emoji_set",
                "this is a set of custom emoji, not stickers",
            ),
            TgError::Unavailable(reason) => ApiError::new(
                StatusCode::BAD_GATEWAY,
                "telegram_unavailable",
                if reason == "token_rejected" {
                    "Telegram rejected the bot token, see ADMIN.md#telegram"
                } else {
                    "Telegram is not answering"
                },
            )
            .with("reason", json!(reason)),
            TgError::Gone => TgError::Unavailable("upstream_error").into_api(),
            TgError::Busy(secs) => {
                let mut e = ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "telegram_busy",
                    "Telegram asks to wait; try again later",
                );
                e.retry_after = Some(secs.max(1));
                e
            }
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            TgError::NotFound => "not_found",
            TgError::Stale => "stale_set",
            TgError::EmojiSet => "emoji_set",
            TgError::Unavailable(r) => r,
            TgError::Busy(_) => "busy",
            TgError::Gone => "upstream_error",
        }
    }
}

/// The address of a Bot API call. The token is inside, but `Display` (the
/// only way it is printed) shows `bot***`.
struct TgUrl {
    full: String,
    shown: String,
}

impl TgUrl {
    fn method(base: &str, token: &Secret, method: &str, query: &[(&str, &str)]) -> TgUrl {
        let mut q = String::new();
        for (i, (k, v)) in query.iter().enumerate() {
            q.push(if i == 0 { '?' } else { '&' });
            q.push_str(k);
            q.push('=');
            q.push_str(&percent_encode(v));
        }
        TgUrl {
            full: format!("{base}/bot{}/{method}{q}", token.expose()),
            shown: format!("{base}/bot***/{method}{q}"),
        }
    }

    fn file(base: &str, token: &Secret, path: &str) -> TgUrl {
        TgUrl {
            full: format!("{base}/file/bot{}/{path}", token.expose()),
            shown: format!("{base}/file/bot***/{path}"),
        }
    }

    fn uri(&self) -> Result<hyper::Uri, TgError> {
        self.full.parse().map_err(|_| TgError::Unavailable("bad_file"))
    }
}

impl fmt::Display for TgUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.shown)
    }
}

impl fmt::Debug for TgUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.shown)
    }
}

fn percent_encode(v: &str) -> String {
    v.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Set name as Telegram allows it.
pub fn valid_set_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A `file_unique_id` as the client sends it.
pub fn valid_file_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A `file_path` from `getFile`: relative, no `..`, only safe characters.
pub fn safe_file_path(p: &str) -> bool {
    (1..=256).contains(&p.len())
        && !p.starts_with('/')
        && !p.contains("..")
        && !p.contains("//")
        && p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'/'))
}

/// What the last real call to Telegram showed (for the administrator).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Unknown,
    Ok,
    TokenRejected,
    Unavailable,
}

impl Health {
    pub fn as_str(self) -> &'static str {
        match self {
            Health::Unknown => "unknown",
            Health::Ok => "ok",
            Health::TokenRejected => "token_rejected",
            Health::Unavailable => "unavailable",
        }
    }
}

#[derive(Default)]
struct DeviceUse {
    files: u32,
    times: VecDeque<Instant>,
}

struct CachedSet {
    set: Arc<StickerSet>,
    used: u64,
}

#[derive(Default)]
struct SetCache {
    sets: HashMap<String, CachedSet>,
    clock: u64,
}

impl SetCache {
    fn get(&mut self, key: &str) -> Option<Arc<StickerSet>> {
        self.clock += 1;
        let c = self.sets.get_mut(key)?;
        if c.set.fetched.elapsed() >= SET_TTL {
            self.sets.remove(key);
            return None;
        }
        c.used = self.clock;
        Some(c.set.clone())
    }

    fn put(&mut self, key: String, set: Arc<StickerSet>) {
        self.clock += 1;
        self.sets.insert(key, CachedSet { set, used: self.clock });
        while self.sets.len() > MAX_CACHED_SETS {
            let oldest = self.sets.iter().min_by_key(|(_, c)| c.used).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.sets.remove(&k),
                None => break,
            };
        }
    }
}

type SetResult = Result<Arc<StickerSet>, TgError>;
type HttpClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

/// The Bot API client of this fcd.
pub struct Telegram {
    token: Secret,
    base: String,
    client: HttpClient,
    /// Times of the requests in the last second.
    sent: Mutex<VecDeque<Instant>>,
    /// Telegram's flood control (429): nothing is sent before this.
    paused_until: Mutex<Option<Instant>>,
    set_loads: Semaphore,
    sets: Mutex<SetCache>,
    inflight: Mutex<HashMap<String, broadcast::Sender<SetResult>>>,
    file_paths: Mutex<HashMap<String, (String, Instant)>>,
    devices: Mutex<HashMap<(String, String), DeviceUse>>,
    health: Mutex<(Health, Option<String>)>,
    last_token_warning: Mutex<Option<Instant>>,
    /// `getStickerSet` calls actually sent (tests of the single flight).
    pub set_calls: std::sync::atomic::AtomicUsize,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn secs_ceil(d: Duration) -> u64 {
    d.as_secs() + u64::from(d.subsec_nanos() > 0)
}

impl Telegram {
    pub fn new(s: &TelegramSettings) -> Arc<Telegram> {
        Arc::new(Telegram {
            token: s.token.clone(),
            base: s.api_url.trim_end_matches('/').to_string(),
            client: Client::builder(TokioExecutor::new()).build(crate::webpush::https_connector()),
            sent: Mutex::new(VecDeque::new()),
            paused_until: Mutex::new(None),
            set_loads: Semaphore::new(MAX_SET_LOADS),
            sets: Mutex::new(SetCache::default()),
            inflight: Mutex::new(HashMap::new()),
            file_paths: Mutex::new(HashMap::new()),
            devices: Mutex::new(HashMap::new()),
            health: Mutex::new((Health::Unknown, None)),
            last_token_warning: Mutex::new(None),
            set_calls: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// The state of the last real call and the bot's name (for the administrator).
    pub fn health(&self) -> (Health, Option<String>) {
        lock(&self.health).clone()
    }

    fn set_health(&self, h: Health) {
        lock(&self.health).0 = h;
    }

    /// `getMe` at start, in its own task: one line in the log, never the token.
    pub fn spawn_check(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let r = me.call("getMe", &[], Instant::now() + CALL_TIMEOUT).await;
            match r {
                Ok(v) => {
                    let name = v.get("username").and_then(Value::as_str).unwrap_or("").to_string();
                    lock(&me.health).1 = Some(name.clone());
                    tracing::info!(
                        "{}",
                        tr!(
                            "Загрузка стикеров из Telegram: включена (бот @{name})",
                            "Loading stickers from Telegram: on (bot @{name})"
                        )
                    );
                }
                Err(TgError::Unavailable("token_rejected")) => tracing::warn!(
                    "{}",
                    crate::lang::l(
                        "Загрузка стикеров из Telegram: токен отклонён Telegram",
                        "Loading stickers from Telegram: Telegram rejected the token"
                    )
                ),
                Err(_) => tracing::warn!(
                    "{}",
                    crate::lang::l(
                        "Загрузка стикеров из Telegram: Telegram недоступен",
                        "Loading stickers from Telegram: Telegram is unreachable"
                    )
                ),
            }
        });
    }

    /// A wait that does not fit: the request is answered at once.
    fn check_wait(wait: Duration, deadline: Instant) -> Result<(), TgError> {
        if wait > MAX_WAIT || Instant::now() + wait > deadline {
            return Err(TgError::Busy(secs_ceil(wait).max(1)));
        }
        Ok(())
    }

    /// One slot of the token budget: Telegram's pause, then 20 per second.
    async fn acquire(&self, deadline: Instant) -> Result<(), TgError> {
        loop {
            let now = Instant::now();
            let paused = lock(&self.paused_until).filter(|t| *t > now).map(|t| t - now);
            let wait = match paused {
                Some(w) => w,
                None => {
                    let mut q = lock(&self.sent);
                    while q
                        .front()
                        .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(1))
                    {
                        q.pop_front();
                    }
                    if q.len() < MAX_REQUESTS_PER_SECOND {
                        q.push_back(now);
                        return Ok(());
                    }
                    (q[0] + Duration::from_secs(1)).saturating_duration_since(now)
                }
            };
            Self::check_wait(wait, deadline)?;
            tokio::time::sleep(wait).await;
        }
    }

    fn remaining(deadline: Instant) -> Result<Duration, TgError> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(TgError::Unavailable("timeout"));
        }
        Ok(left.min(CALL_TIMEOUT))
    }

    fn token_rejected(&self) {
        self.set_health(Health::TokenRejected);
        let mut last = lock(&self.last_token_warning);
        if last.is_none_or(|t| t.elapsed() >= TOKEN_WARNING_PERIOD) {
            *last = Some(Instant::now());
            tracing::warn!(
                "{}",
                crate::lang::l(
                    "Telegram отклонил токен бота (см. ADMIN.md#telegram)",
                    "Telegram rejected the bot token (see ADMIN.md#telegram)"
                )
            );
        }
    }

    /// Sends a GET and reads at most `limit + 1` bytes of the body.
    async fn get(&self, url: &TgUrl, limit: usize, deadline: Instant) -> Result<(StatusCode, Vec<u8>, bool), TgError> {
        let timeout = Self::remaining(deadline)?;
        let req = hyper::Request::get(url.uri()?)
            .header("User-Agent", concat!("fcd/", env!("CARGO_PKG_VERSION")))
            .body(Full::new(Bytes::new()))
            .map_err(|_| TgError::Unavailable("network"))?;
        tracing::debug!("telegram: GET {url}");
        let work = async {
            let res = self
                .client
                .request(req)
                .await
                .map_err(|_| TgError::Unavailable("network"))?;
            let status = res.status();
            let mut body = res.into_body();
            let mut buf = Vec::new();
            let mut over = false;
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|_| TgError::Unavailable("network"))?;
                if let Some(chunk) = frame.data_ref() {
                    let room = (limit + 1).saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
                    if buf.len() > limit {
                        over = true;
                        break;
                    }
                }
            }
            Ok((status, buf, over))
        };
        match tokio::time::timeout(timeout, work).await {
            Ok(r) => r,
            Err(_) => Err(TgError::Unavailable("timeout")),
        }
    }

    /// A Bot API method: the `result` of the answer, or the mapped error.
    async fn call(&self, method: &str, query: &[(&str, &str)], deadline: Instant) -> Result<Value, TgError> {
        loop {
            self.acquire(deadline).await?;
            let url = TgUrl::method(&self.base, &self.token, method, query);
            let r = self.get(&url, MAX_JSON_BYTES, deadline).await;
            let (status, body, over) = match r {
                Ok(v) => v,
                Err(e) => {
                    self.set_health(Health::Unavailable);
                    return Err(e);
                }
            };
            let json: Option<Value> = if over { None } else { serde_json::from_slice(&body).ok() };
            let code = json
                .as_ref()
                .and_then(|j| j.get("error_code"))
                .and_then(Value::as_u64)
                .unwrap_or(u64::from(status.as_u16()));
            let ok = json.as_ref().and_then(|j| j.get("ok")).and_then(Value::as_bool) == Some(true);
            if status.is_success() && ok {
                self.set_health(Health::Ok);
                return json
                    .and_then(|mut j| j.get_mut("result").map(Value::take))
                    .ok_or(TgError::Unavailable("upstream_error"));
            }
            match code {
                429 => {
                    let after = json
                        .as_ref()
                        .and_then(|j| j.pointer("/parameters/retry_after"))
                        .and_then(Value::as_u64)
                        .unwrap_or(5)
                        .clamp(1, 24 * 3600);
                    *lock(&self.paused_until) = Some(Instant::now() + Duration::from_secs(after));
                    self.set_health(Health::Ok);
                    // The next turn waits if the pause fits, or answers 503 at once.
                    continue;
                }
                401 | 403 | 404 => {
                    self.token_rejected();
                    return Err(TgError::Unavailable("token_rejected"));
                }
                400 => {
                    self.set_health(Health::Ok);
                    let desc = json
                        .as_ref()
                        .and_then(|j| j.get("description"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if desc.contains("STICKERSET_INVALID") {
                        return Err(TgError::NotFound);
                    }
                    return Err(TgError::Unavailable("upstream_error"));
                }
                _ => {
                    self.set_health(Health::Unavailable);
                    return Err(TgError::Unavailable("upstream_error"));
                }
            }
        }
    }

    /// A file by its `file_path`, at most `limit` bytes.
    async fn download(&self, path: &str, limit: usize, deadline: Instant) -> Result<Vec<u8>, TgError> {
        if !safe_file_path(path) {
            return Err(TgError::Unavailable("bad_file"));
        }
        loop {
            self.acquire(deadline).await?;
            let url = TgUrl::file(&self.base, &self.token, path);
            let (status, body, over) = self.get(&url, limit, deadline).await?;
            match status.as_u16() {
                200 if over => return Err(TgError::Unavailable("bad_file")),
                200 => return Ok(body),
                404 => return Err(TgError::Gone),
                429 => {
                    let after = serde_json::from_slice::<Value>(&body)
                        .ok()
                        .and_then(|j| j.pointer("/parameters/retry_after").and_then(Value::as_u64))
                        .unwrap_or(5)
                        .clamp(1, 24 * 3600);
                    *lock(&self.paused_until) = Some(Instant::now() + Duration::from_secs(after));
                    continue;
                }
                401 | 403 => {
                    self.token_rejected();
                    return Err(TgError::Unavailable("token_rejected"));
                }
                _ => return Err(TgError::Unavailable("upstream_error")),
            }
        }
    }

    /// `getStickerSet` under the limit of simultaneous set loads.
    async fn fetch_set(&self, name: &str, deadline: Instant) -> SetResult {
        let wait = MAX_WAIT.min(deadline.saturating_duration_since(Instant::now()));
        let _permit = match tokio::time::timeout(wait, self.set_loads.acquire()).await {
            Ok(Ok(p)) => p,
            _ => return Err(TgError::Busy(5)),
        };
        self.set_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let v = self.call("getStickerSet", &[("name", name)], deadline).await?;
        parse_set(&v).map(Arc::new)
    }

    /// The set from the cache, or loaded once for everyone asking at the same
    /// time. The load runs in its own task: a client that goes away does not
    /// cancel it for the others.
    pub async fn set(self: &Arc<Self>, name: &str, deadline: Instant) -> SetResult {
        let key = name.to_ascii_lowercase();
        if let Some(s) = lock(&self.sets).get(&key) {
            return Ok(s);
        }
        let mut rx = {
            let mut inflight = lock(&self.inflight);
            match inflight.get(&key) {
                Some(tx) => tx.subscribe(),
                None => {
                    let (tx, rx) = broadcast::channel(1);
                    inflight.insert(key.clone(), tx.clone());
                    let me = self.clone();
                    let name = name.to_string();
                    tokio::spawn(async move {
                        let r = me.fetch_set(&name, Instant::now() + ROUTE_DEADLINE).await;
                        if let Ok(s) = &r {
                            let mut cache = lock(&me.sets);
                            let canonical = s.name.to_ascii_lowercase();
                            if canonical != key {
                                cache.put(canonical, s.clone());
                            }
                            cache.put(key.clone(), s.clone());
                        }
                        lock(&me.inflight).remove(&key);
                        let _ = tx.send(r);
                    });
                    rx
                }
            }
        };
        match tokio::time::timeout_at(deadline.into(), rx.recv()).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(TgError::Unavailable("upstream_error")),
            Err(_) => Err(TgError::Unavailable("timeout")),
        }
    }

    fn forget_set(&self, name: &str, set: &StickerSet) {
        let mut cache = lock(&self.sets);
        cache.sets.remove(&name.to_ascii_lowercase());
        cache.sets.remove(&set.name.to_ascii_lowercase());
    }

    async fn file_path(&self, file_id: &str, deadline: Instant) -> Result<String, TgError> {
        if let Some((p, at)) = lock(&self.file_paths).get(file_id)
            && at.elapsed() < FILE_PATH_TTL
        {
            return Ok(p.clone());
        }
        let v = self.call("getFile", &[("file_id", file_id)], deadline).await?;
        let path = v
            .get("file_path")
            .and_then(Value::as_str)
            .ok_or(TgError::Unavailable("bad_file"))?
            .to_string();
        if !safe_file_path(&path) {
            return Err(TgError::Unavailable("bad_file"));
        }
        let mut paths = lock(&self.file_paths);
        if paths.len() > 10_000 {
            paths.retain(|_, (_, at)| at.elapsed() < FILE_PATH_TTL);
        }
        paths.insert(file_id.to_string(), (path.clone(), Instant::now()));
        Ok(path)
    }

    /// The bytes of one sticker of a set, by its `file_unique_id`.
    pub async fn file(self: &Arc<Self>, name: &str, id: &str, deadline: Instant) -> Result<(Kind, Vec<u8>), TgError> {
        let mut set = self.set(name, deadline).await?;
        let sticker = match set.stickers.iter().find(|s| s.id == id) {
            Some(s) => s.clone(),
            None => {
                // The set may have changed since it was cached: once more, fresh.
                self.forget_set(name, &set);
                set = self.set(name, deadline).await?;
                set.stickers
                    .iter()
                    .find(|s| s.id == id)
                    .cloned()
                    .ok_or(TgError::Stale)?
            }
        };
        let limit = sticker.kind.limit();
        let path = self.file_path(&sticker.file_id, deadline).await?;
        match self.download(&path, limit, deadline).await {
            Err(TgError::Gone) => {
                // The `file_path` expired: one more getFile.
                lock(&self.file_paths).remove(&sticker.file_id);
                let path = self.file_path(&sticker.file_id, deadline).await?;
                match self.download(&path, limit, deadline).await {
                    Err(TgError::Gone) => Err(TgError::Unavailable("upstream_error")),
                    r => r.map(|b| (sticker.kind, b)),
                }
            }
            r => r.map(|b| (sticker.kind, b)),
        }
    }

    /// Counts a request of a device; `file` requests also take one of its
    /// [`DEVICE_MAX_FILES`] slots until the guard is dropped.
    pub fn device_begin(self: &Arc<Self>, key: (String, String), file: bool) -> Result<DeviceGuard, u64> {
        let now = Instant::now();
        let mut map = lock(&self.devices);
        if map.len() > 10_000 {
            map.retain(|_, d| d.files > 0 || d.times.back().is_some_and(|t| now.duration_since(*t) < DEVICE_WINDOW));
        }
        let d = map.entry(key.clone()).or_default();
        while d.times.front().is_some_and(|t| now.duration_since(*t) >= DEVICE_WINDOW) {
            d.times.pop_front();
        }
        if d.times.len() >= DEVICE_MAX_REQUESTS {
            return Err(secs_ceil((d.times[0] + DEVICE_WINDOW).saturating_duration_since(now)).max(1));
        }
        if file && d.files >= DEVICE_MAX_FILES {
            return Err(1);
        }
        d.times.push_back(now);
        if file {
            d.files += 1;
        }
        Ok(DeviceGuard {
            tg: self.clone(),
            key,
            file,
        })
    }
}

/// Releases a device's file slot.
pub struct DeviceGuard {
    tg: Arc<Telegram>,
    key: (String, String),
    file: bool,
}

impl Drop for DeviceGuard {
    fn drop(&mut self) {
        if self.file
            && let Some(d) = lock(&self.tg.devices).get_mut(&self.key)
        {
            d.files = d.files.saturating_sub(1);
        }
    }
}

/// The `result` of `getStickerSet`.
fn parse_set(v: &Value) -> Result<StickerSet, TgError> {
    let bad = TgError::Unavailable("upstream_error");
    let name = v.get("name").and_then(Value::as_str).ok_or(bad.clone())?.to_string();
    let title = v.get("title").and_then(Value::as_str).unwrap_or(&name).to_string();
    if v.get("sticker_type").and_then(Value::as_str) == Some("custom_emoji") {
        return Err(TgError::EmojiSet);
    }
    let list = v.get("stickers").and_then(Value::as_array).ok_or(bad)?;
    let mut stickers = Vec::new();
    let (mut video, mut other) = (0, 0);
    for s in list {
        let flag = |k: &str| s.get(k).and_then(Value::as_bool).unwrap_or(false);
        if flag("is_video") {
            video += 1;
            continue;
        }
        let id = s.get("file_unique_id").and_then(Value::as_str).unwrap_or("");
        let file_id = s.get("file_id").and_then(Value::as_str).unwrap_or("");
        let file_id_ok = (1..=256).contains(&file_id.len())
            && file_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !valid_file_id(id) || !file_id_ok || stickers.iter().any(|x: &SetSticker| x.id == id) {
            other += 1;
            continue;
        }
        let emoji = s
            .get("emoji")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty() && e.len() <= crate::envelope::MAX_EMOJI_BYTES)
            .map(str::to_string);
        stickers.push(SetSticker {
            id: id.to_string(),
            file_id: file_id.to_string(),
            emoji,
            kind: if flag("is_animated") { Kind::Tgs } else { Kind::Webp },
        });
    }
    Ok(StickerSet {
        name,
        title,
        stickers,
        video,
        other,
        fetched: Instant::now(),
    })
}

// ---- routes ----

fn request_id() -> String {
    crate::datadir::hex(&crate::webpush::random_bytes::<8>())
}

fn with_request_id(mut res: Response, id: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(id) {
        res.headers_mut().insert("x-request-id", v);
    }
    res
}

fn disabled() -> ApiError {
    ApiError::not_found(
        "telegram_disabled",
        "loading sticker sets by link is off on this server (no bot token)",
    )
}

fn rate_limited(secs: u64) -> ApiError {
    let mut e = ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "too many Telegram sticker requests from this device; try again later",
    );
    e.retry_after = Some(secs);
    e
}

/// One log line per Telegram error: request id, code, reason, set name; never the token.
fn log_error(id: &str, name: &str, e: &TgError) {
    let api = e.clone().into_api();
    tracing::warn!(
        "telegram: request_id={id} status={} error={} reason={} set={name}",
        api.status.as_u16(),
        api.code,
        e.reason()
    );
}

async fn run<T>(id: &str, name: &str, work: impl Future<Output = Result<T, TgError>>) -> Result<T, ApiError> {
    let r = match tokio::time::timeout(ROUTE_DEADLINE, work).await {
        Ok(r) => r,
        Err(_) => Err(TgError::Unavailable("timeout")),
    };
    r.map_err(|e| {
        log_error(id, name, &e);
        e.into_api()
    })
}

/// `GET /v1/telegram/sets/{name}`.
pub async fn get_set(State(st): State<Arc<AppState>>, Auth(c): Auth, UrlPath(name): UrlPath<String>) -> Response {
    let id = request_id();
    let r = async {
        let tg = st.telegram.clone().ok_or_else(disabled)?;
        if !valid_set_name(&name) {
            return Err(ApiError::bad_request("bad sticker set name"));
        }
        let _guard = tg
            .device_begin((st.server_id.clone(), c.dev.to_string()), false)
            .map_err(rate_limited)?;
        let deadline = Instant::now() + ROUTE_DEADLINE;
        let set = run(&id, &name, tg.set(&name, deadline)).await?;
        Ok(Json(json!({
            "name": set.name,
            "title": set.title,
            "stickers": set.stickers.iter().map(|s| json!({
                "id": s.id,
                "emoji": s.emoji,
                "type": s.kind.as_str(),
            })).collect::<Vec<_>>(),
            "skipped": { "video": set.video, "other": set.other },
        }))
        .into_response())
    }
    .await;
    with_request_id(r.unwrap_or_else(IntoResponse::into_response), &id)
}

/// `GET /v1/telegram/sets/{name}/files/{id}`.
pub async fn get_file(
    State(st): State<Arc<AppState>>,
    Auth(c): Auth,
    UrlPath((name, file)): UrlPath<(String, String)>,
) -> Response {
    let id = request_id();
    let r = async {
        let tg = st.telegram.clone().ok_or_else(disabled)?;
        if !valid_set_name(&name) || !valid_file_id(&file) {
            return Err(ApiError::bad_request("bad sticker set name or file id"));
        }
        let _guard = tg
            .device_begin((st.server_id.clone(), c.dev.to_string()), true)
            .map_err(rate_limited)?;
        let deadline = Instant::now() + ROUTE_DEADLINE;
        let (_, bytes) = run(&id, &name, tg.file(&name, &file, deadline)).await?;
        Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            bytes,
        )
            .into_response())
    }
    .await;
    with_request_id(r.unwrap_or_else(IntoResponse::into_response), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_never_prints_the_token() {
        let t = Secret::new("123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345");
        let u = TgUrl::method(
            "https://api.telegram.org",
            &t,
            "getStickerSet",
            &[("name", "Cats_by_x")],
        );
        assert!(u.full.contains(t.expose()));
        let shown = format!("{u} {u:?}");
        assert!(!shown.contains("ABCdef"), "{shown}");
        assert!(shown.contains("bot***/getStickerSet?name=Cats_by_x"), "{shown}");
        let f = TgUrl::file("https://api.telegram.org", &t, "stickers/file_1.webp");
        assert_eq!(
            f.to_string(),
            "https://api.telegram.org/file/bot***/stickers/file_1.webp"
        );
    }

    #[test]
    fn names_ids_and_paths() {
        assert!(valid_set_name("Cats_by_bot1"));
        assert!(!valid_set_name(""));
        assert!(!valid_set_name("a-b"));
        assert!(!valid_set_name(&"a".repeat(65)));
        assert!(valid_file_id("AgADyQEAAladvQo"));
        assert!(!valid_file_id("a/b"));
        assert!(safe_file_path("stickers/file_10.webp"));
        assert!(!safe_file_path("/var/lib/telegram-bot-api/x.webp"));
        assert!(!safe_file_path("stickers/../x"));
        assert!(!safe_file_path("stickers/a?b"));
        assert!(!safe_file_path("https://evil/x"));
    }

    #[test]
    fn set_parsing_skips_video_and_marks_kinds() {
        let v = json!({
            "name": "Cats", "title": "Cats", "sticker_type": "regular",
            "stickers": [
                {"file_id": "f1", "file_unique_id": "u1", "emoji": "😺", "is_animated": false, "is_video": false},
                {"file_id": "f2", "file_unique_id": "u2", "emoji": "😹", "is_animated": true, "is_video": false},
                {"file_id": "f3", "file_unique_id": "u3", "is_animated": false, "is_video": true},
                {"file_id": "f4", "file_unique_id": "bad/id", "is_animated": false, "is_video": false},
            ]
        });
        let s = parse_set(&v).unwrap();
        assert_eq!(s.stickers.len(), 2);
        assert_eq!(s.stickers[1].kind, Kind::Tgs);
        assert_eq!((s.video, s.other), (1, 1));
        let emoji = json!({"name": "E", "title": "E", "sticker_type": "custom_emoji", "stickers": []});
        assert_eq!(parse_set(&emoji).unwrap_err(), TgError::EmojiSet);
        // Masks are ordinary stickers.
        let mask = json!({"name": "M", "title": "M", "sticker_type": "mask", "stickers": [
            {"file_id": "f1", "file_unique_id": "u1", "is_animated": false, "is_video": false}]});
        assert_eq!(parse_set(&mask).unwrap().stickers.len(), 1);
    }

    #[test]
    fn lru_keeps_at_most_256() {
        let mut c = SetCache::default();
        let set = |n: &str| {
            Arc::new(StickerSet {
                name: n.into(),
                title: n.into(),
                stickers: vec![],
                video: 0,
                other: 0,
                fetched: Instant::now(),
            })
        };
        c.put("first".into(), set("first"));
        for i in 0..MAX_CACHED_SETS {
            c.put(format!("s{i}"), set("x"));
            // "first" stays recently used.
            if i % 10 == 0 {
                assert!(c.get("first").is_some());
            }
        }
        assert_eq!(c.sets.len(), MAX_CACHED_SETS);
        assert!(c.get("first").is_some());
        assert!(c.get("s0").is_none());
    }
}
