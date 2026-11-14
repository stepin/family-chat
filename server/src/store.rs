//! Server state: users, devices, invitations, chats and the event log.
//!
//! Everything is kept in memory (`Mem`) and mirrored to the data folder.
//! All changes go through one writer thread ([`Store::write`]); readers take
//! a short read lock ([`Store::read`]). The writer does the disk work first
//! and then updates memory, so a reader never sees something that is not on
//! disk yet.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, mpsc};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, watch};

use crate::blobs::BlobStore;
use crate::datadir::{self, ServerFile, check_admin_code, create_private_dir, hex, now_ms, write_atomic_io};
use crate::envelope::{self, AvatarRef, EnvError, Envelope, Identity, ImageKind, Profile};
use crate::error::{ApiError, io_error};
use crate::eventlog::{self, Header};
use crate::ids::{
    ChatId, DevId, MS_PER_DAY, MsgId, UserId, b32_encode, b64_encode, day_name, day_of_ms, parse_day_name,
};
use crate::notice::Notice;
use crate::webpush::{Subscription, random_bytes};

pub const INVITE_TTL_MS: u64 = 7 * MS_PER_DAY;
pub const NONCE_TTL_MS: u64 = 2 * 60 * 1000;
const MAX_NONCES: usize = 1000;
/// Retention never counts from further than this past the newest event.
pub const CLOCK_SLACK_MS: u64 = 7 * MS_PER_DAY;

/// Sender of server notices in the log. No real user can have it: a
/// `userId` is a SHA-256 prefix of a public key.
pub const NOTICE_SENDER: UserId = UserId([0; 16]);

#[derive(Debug, Clone)]
pub struct StoreConfig {
    pub retention_days: u32,
    pub min_free_mb: u64,
    /// Largest attachment (sum of its parts), bytes.
    pub max_blob_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct Device {
    pub token_hash: [u8; 32],
    pub created_at: u64,
    pub push: Option<Subscription>,
}

/// An avatar file `users/<id>/avatar.<sha256 hex>.<jpg|webp>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvatarFile {
    pub sha256: [u8; 32],
    pub kind: ImageKind,
}

impl AvatarFile {
    pub fn file_name(&self) -> String {
        format!("avatar.{}.{}", hex(&self.sha256), self.kind.ext())
    }
}

/// A stored `revoked` envelope.
#[derive(Debug, Clone)]
pub struct Revoked {
    pub envelope: Envelope,
    /// Server time when it was accepted.
    pub at: u64,
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: UserId,
    pub identity: Identity,
    pub profile: Option<Profile>,
    pub removed_at: Option<u64>,
    pub revoked: Option<Revoked>,
    pub devices: HashMap<DevId, Device>,
    /// Avatar files on disk, oldest first (at most the profile's one and
    /// the newest upload).
    pub avatars: Vec<AvatarFile>,
}

impl User {
    /// Still in the family and not revoked: can be added to groups.
    pub fn active(&self) -> bool {
        self.removed_at.is_none() && self.revoked.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct Invite {
    /// SHA-256 (hex) of the code; also the invitation id in the API.
    pub id: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub created_by: UserId,
    pub used_at: Option<u64>,
    pub used_by: Option<UserId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatKind {
    Dm,
    Group,
}

/// A stretch of group membership: events with `from <= gseq <= to` are
/// delivered to the user (`to` is the notice that removed them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub user_id: UserId,
    pub from: u64,
    pub to: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Chat {
    pub id: ChatId,
    pub kind: ChatKind,
    /// Sorted. A direct chat has two entries (the same user twice for the
    /// chat with oneself); a group has its current members.
    pub members: Vec<UserId>,
    pub created_at: u64,
    pub epoch: u32,
    /// Groups only.
    pub owner: Option<UserId>,
    /// Current state version (groups); 0 for direct chats.
    pub version: u64,
    /// Membership history (groups).
    pub periods: Vec<Period>,
}

impl Chat {
    pub fn is_member(&self, u: &UserId) -> bool {
        self.members.contains(u)
    }

    /// Whether the event `gseq` of this chat is delivered to `u`.
    pub fn delivers(&self, u: &UserId, gseq: u64) -> bool {
        match self.kind {
            ChatKind::Dm => self.members.contains(u),
            ChatKind::Group => self
                .periods
                .iter()
                .any(|p| p.user_id == *u && p.from <= gseq && p.to.is_none_or(|t| gseq <= t)),
        }
    }

    /// Members without repeats (the chat with oneself lists one user twice).
    pub fn unique_members(&self) -> Vec<UserId> {
        let mut v = self.members.clone();
        v.dedup();
        v
    }
}

/// A sealed group key for one user: `users/<id>/keys/<n>.key`.
#[derive(Debug, Clone)]
pub struct SealedKey {
    pub n: u64,
    pub chat: ChatId,
    pub epoch: u32,
    pub version: u64,
    pub created_at: u64,
    /// Opaque string from the owner's request.
    pub key: String,
}

/// Index entry: where an event lives on disk.
#[derive(Debug, Clone, Copy)]
pub struct Entry {
    pub h: Header,
    pub day: i64,
    pub offset: u64,
    pub size: u32,
    /// Deleted for everyone: the body on disk is zeros (eventlog.rs).
    pub deleted: bool,
}

impl Entry {
    /// Bytes of the body a response carries (none for a deleted record).
    pub fn body_len(&self) -> usize {
        if self.deleted {
            0
        } else {
            self.size as usize - 4 - eventlog::FIXED
        }
    }
}

/// The authenticated caller of a request.
#[derive(Debug, Clone, Copy)]
pub struct Caller {
    pub user: UserId,
    pub dev: DevId,
    pub admin: bool,
    pub removed: bool,
    pub revoked: bool,
}

pub struct Mem {
    pub server: ServerFile,
    pub users: HashMap<UserId, User>,
    pub tokens: HashMap<[u8; 32], (UserId, DevId)>,
    pub invites: HashMap<String, Invite>,
    pub chats: HashMap<ChatId, Chat>,
    /// Sorted by `gseq`.
    pub log: Vec<Entry>,
    /// Server notices in the log, by `gseq`.
    pub notices: HashMap<u64, Arc<Notice>>,
    pub idem: HashMap<(UserId, MsgId), u64>,
    pub last_gseq: u64,
    /// Sealed group keys per user, by `n`.
    pub keys: HashMap<UserId, Vec<SealedKey>>,
}

/// One page of events. `notices` holds the notice records among `events`.
pub struct Page {
    pub events: Vec<Entry>,
    pub notices: HashMap<u64, Arc<Notice>>,
    pub cursor: u64,
    pub more: bool,
}

impl Mem {
    pub fn is_admin(&self, u: &UserId) -> bool {
        let s = u.to_string();
        self.server.admins.contains(&s)
    }

    pub fn caller(&self, token_hash: &[u8; 32]) -> Option<Caller> {
        let (user, dev) = *self.tokens.get(token_hash)?;
        let u = self.users.get(&user)?;
        Some(Caller {
            user,
            dev,
            admin: self.is_admin(&user),
            removed: u.removed_at.is_some(),
            revoked: u.revoked.is_some(),
        })
    }

    /// Smallest `gseq` still stored, or the next one when the log is empty.
    pub fn oldest_gseq(&self) -> u64 {
        self.log.first().map_or(self.last_gseq + 1, |e| e.h.gseq)
    }

    /// Server time of the oldest stored event or notice.
    pub fn oldest_time(&self) -> Option<u64> {
        self.log.first().map(|e| e.h.time)
    }

    /// The direct chat between `u` and some user (`u` itself for the chat
    /// with oneself) with this id, if any.
    pub fn derive_direct(&self, server_id: &str, u: &UserId, chat: &ChatId) -> Option<UserId> {
        self.users
            .keys()
            .find(|p| ChatId::direct(server_id, u, p) == *chat)
            .copied()
    }

    /// Whether `chat` is the direct chat id of any two users (or of a user
    /// with themselves).
    pub fn is_direct_id(&self, server_id: &str, chat: &ChatId) -> bool {
        self.users
            .keys()
            .any(|u| self.derive_direct(server_id, u, chat).is_some())
    }

    fn visible(&self, user: &UserId, e: &Entry) -> bool {
        if e.h.sender == NOTICE_SENDER {
            return self.notices.get(&e.h.gseq).is_some_and(|n| n.to.contains(user));
        }
        self.chats.get(&e.h.chat).is_some_and(|c| c.delivers(user, e.h.gseq))
    }

    fn page_notices(&self, events: &[Entry]) -> HashMap<u64, Arc<Notice>> {
        events
            .iter()
            .filter(|e| e.h.sender == NOTICE_SENDER)
            .filter_map(|e| Some((e.h.gseq, self.notices.get(&e.h.gseq)?.clone())))
            .collect()
    }

    pub fn entry(&self, gseq: u64) -> Option<&Entry> {
        self.log
            .binary_search_by_key(&gseq, |e| e.h.gseq)
            .ok()
            .map(|i| &self.log[i])
    }

    /// Events of `user`'s chats after `after`, oldest first.
    pub fn events_after(&self, user: &UserId, after: u64, limit: usize, max_bytes: usize) -> Page {
        let start = self.log.partition_point(|e| e.h.gseq <= after);
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for e in &self.log[start..] {
            if !self.visible(user, e) {
                continue;
            }
            if events.len() >= limit || (!events.is_empty() && bytes + e.body_len() > max_bytes) {
                more = true;
                break;
            }
            bytes += e.body_len();
            events.push(*e);
        }
        let cursor = match (more, events.last()) {
            (true, Some(l)) => l.h.gseq,
            _ => self.last_gseq,
        };
        let notices = self.page_notices(&events);
        Page {
            events,
            notices,
            cursor,
            more,
        }
    }

    /// Events of one chat before `before`, returned oldest first; `more`
    /// says whether older ones are still stored. All member events of the
    /// chat are included; notices only when addressed to `user`.
    pub fn chat_history(&self, user: &UserId, chat: &ChatId, before: u64, limit: usize, max_bytes: usize) -> Page {
        let end = self.log.partition_point(|e| e.h.gseq < before);
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for e in self.log[..end].iter().rev() {
            if e.h.chat != *chat {
                continue;
            }
            if e.h.sender == NOTICE_SENDER && !self.visible(user, e) {
                continue;
            }
            if events.len() >= limit || (!events.is_empty() && bytes + e.body_len() > max_bytes) {
                more = true;
                break;
            }
            bytes += e.body_len();
            events.push(*e);
        }
        events.reverse();
        let cursor = events.first().map_or(before.min(self.last_gseq + 1), |e| e.h.gseq);
        let notices = self.page_notices(&events);
        Page {
            events,
            notices,
            cursor,
            more,
        }
    }

    /// Last member event (notices left out) of every chat.
    pub fn last_events(&self) -> HashMap<ChatId, Entry> {
        let mut out = HashMap::new();
        for e in self.log.iter().filter(|e| e.h.sender != NOTICE_SENDER) {
            out.insert(e.h.chat, *e);
        }
        out
    }

    /// Sealed keys of `user` with `n > after`, at most `limit`.
    pub fn keys_after(&self, user: &UserId, after: u64, limit: usize) -> (Vec<SealedKey>, bool) {
        let all = self.keys.get(user).map(Vec::as_slice).unwrap_or(&[]);
        let start = all.partition_point(|k| k.n <= after);
        let rest = &all[start..];
        (rest.iter().take(limit).cloned().collect(), rest.len() > limit)
    }
}

struct Shared {
    path: PathBuf,
    server_id: String,
    mem: RwLock<Mem>,
    changes: watch::Sender<u64>,
    nonces: Mutex<HashMap<String, u64>>,
    blobs: BlobStore,
    /// Body reads take it shared; an in-place overwrite of a record (delete
    /// for everyone) takes it exclusively, so no reader sees a half-zeroed
    /// record.
    io: RwLock<()>,
}

type Job = Box<dyn FnOnce(&mut Writer) + Send>;

/// Handle to the state; cheap to clone.
#[derive(Clone)]
pub struct Store {
    shared: Arc<Shared>,
    jobs: mpsc::Sender<Job>,
}

struct OpenSegment {
    day: i64,
    file: File,
    len: u64,
}

/// The only place that changes the state. Runs on its own thread.
pub struct Writer {
    shared: Arc<Shared>,
    pub(crate) config: StoreConfig,
    segment: Option<OpenSegment>,
}

// ---- files ----

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFile {
    token_hash: String,
    created_at: u64,
    push: Option<Subscription>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteFile {
    created_at: u64,
    expires_at: u64,
    created_by: UserId,
    used_at: Option<u64>,
    used_by: Option<UserId>,
}

fn is_zero(v: &u64) -> bool {
    *v == 0
}

/// `chats/<id>/meta.json`. Direct chats keep the M1 fields only.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMeta {
    kind: String,
    members: Vec<UserId>,
    created_at: u64,
    epoch: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<UserId>,
    #[serde(default, skip_serializing_if = "is_zero")]
    version: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    periods: Vec<Period>,
}

impl ChatMeta {
    pub(crate) fn of(c: &Chat) -> ChatMeta {
        ChatMeta {
            kind: match c.kind {
                ChatKind::Dm => "dm".into(),
                ChatKind::Group => "group".into(),
            },
            members: c.members.clone(),
            created_at: c.created_at,
            epoch: c.epoch,
            owner: c.owner,
            version: c.version,
            periods: c.periods.clone(),
        }
    }
}

/// `users/<id>/revoked.json`: the envelope as posted plus the server time.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevokedFile {
    payload: String,
    sig: String,
    received_at: u64,
}

/// `users/<id>/keys/<n>.key`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyFile {
    chat_id: ChatId,
    epoch: u32,
    version: u64,
    created_at: u64,
    key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovedFile {
    removed_at: u64,
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T, String> {
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub(crate) fn to_json<T: Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec_pretty(v).expect("serialisable")
}

pub(crate) fn dir_entries(p: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(p) else { return Vec::new() };
    let mut v: Vec<_> = rd
        .flatten()
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
        .collect();
    v.sort();
    v
}

pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn parse_hash(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

pub fn invite_hash(code: &str) -> String {
    hex(&Sha256::digest(code.trim().to_ascii_lowercase().as_bytes()))
}

/// `log/<day>.del`: the deleted records of that day (eventlog.rs).
pub fn del_path(root: &Path, day: i64) -> PathBuf {
    root.join("log").join(format!("{}.del", day_name(day)))
}

pub fn segment_path(root: &Path, day: i64) -> PathBuf {
    root.join("log").join(format!("{}.seg", day_name(day)))
}

/// Retention reference time: the smaller of "now" and "newest event + 7
/// days" (docs/PLAN-v2.md, section 6), so a clock that jumped forward does
/// not wipe everything and a clock set back only delays the cleanup.
pub fn reference_time(now: u64, newest_event: Option<u64>) -> u64 {
    match newest_event {
        Some(t) => now.min(t.saturating_add(CLOCK_SLACK_MS)),
        None => now,
    }
}

/// A day folder or segment is deleted when the whole day lies more than
/// `retention_days` before the reference time.
pub fn day_expired(day: i64, reference: u64, retention_days: u32) -> bool {
    let day_end = (day as i128 + 1) * MS_PER_DAY as i128;
    day_end <= reference as i128 - retention_days as i128 * MS_PER_DAY as i128
}

/// Free and total bytes of the file system holding `p`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, clippy::useless_conversion)]
pub fn disk_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` a valid out-pointer.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = u64::from(st.f_frsize as u64);
    Some((
        u64::from(st.f_bavail as u64) * frsize,
        u64::from(st.f_blocks as u64) * frsize,
    ))
}

#[cfg(not(unix))]
pub fn disk_space(_p: &Path) -> Option<(u64, u64)> {
    None
}

/// What a successful join or device login returns.
#[derive(Debug, Clone)]
pub struct Issued {
    pub token: String,
    pub user: UserId,
    pub dev: DevId,
    pub admin: bool,
}

pub enum JoinCode {
    Invite(String),
    Admin(String),
}

/// Result of a stored event.
#[derive(Debug, Clone)]
pub struct Appended {
    pub gseq: u64,
    pub time: u64,
    pub duplicate: bool,
    pub chat: Chat,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RetentionReport {
    pub segments: Vec<String>,
    pub blob_days: Vec<String>,
    pub events: usize,
    pub invites: usize,
}

/// Result of a group creation or state change.
#[derive(Debug, Clone)]
pub struct GroupChange {
    pub chat: Chat,
    /// `gseq` of the notice, if it was written.
    pub notice: Option<u64>,
}

pub fn env_error(e: EnvError, what: &str) -> ApiError {
    match e {
        EnvError::Malformed(m) => ApiError::bad_request(format!("{what}: {m}")),
        EnvError::BadSignature => ApiError::unauthorized(format!("{what}: bad signature")).code("bad_signature"),
    }
}

impl ApiError {
    pub(crate) fn code(mut self, code: &'static str) -> Self {
        self.code = code;
        self
    }
}

impl Store {
    /// Loads the data folder and starts the writer thread.
    pub fn open(path: &Path, server: ServerFile, config: StoreConfig) -> Result<Store, String> {
        let server_id = server.server_id.clone();
        let mut mem = Mem {
            server,
            users: HashMap::new(),
            tokens: HashMap::new(),
            invites: HashMap::new(),
            chats: HashMap::new(),
            log: Vec::new(),
            notices: HashMap::new(),
            idem: HashMap::new(),
            last_gseq: 0,
            keys: HashMap::new(),
        };
        load_users(path, &mut mem);
        load_invites(path, &mut mem);
        load_chats(path, &mut mem);
        load_keys(path, &mut mem);
        let segment = load_log(path, &mut mem)?;
        let blobs = BlobStore::open(path, config.max_blob_bytes, config.min_free_mb);
        let (changes, _) = watch::channel(0u64);
        let shared = Arc::new(Shared {
            path: path.to_path_buf(),
            server_id,
            mem: RwLock::new(mem),
            changes,
            nonces: Mutex::new(HashMap::new()),
            blobs,
            io: RwLock::new(()),
        });
        let (tx, rx) = mpsc::channel::<Job>();
        let mut writer = Writer {
            shared: shared.clone(),
            config,
            segment,
        };
        std::thread::Builder::new()
            .name("fcd-writer".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    // A bug in one request must not stop all writing.
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut writer)));
                    if r.is_err() {
                        tracing::error!("ошибка в потоке записи, запрос отклонён");
                    }
                }
            })
            .map_err(|e| format!("не удалось запустить поток записи: {e}"))?;
        Ok(Store { shared, jobs: tx })
    }

    pub fn path(&self) -> &Path {
        &self.shared.path
    }

    pub fn server_id(&self) -> &str {
        &self.shared.server_id
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.shared.blobs
    }

    pub fn read<R>(&self, f: impl FnOnce(&Mem) -> R) -> R {
        f(&self.shared.mem.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Runs `f` on the writer thread and waits for its result.
    pub async fn write<R: Send + 'static>(&self, f: impl FnOnce(&mut Writer) -> R + Send + 'static) -> R {
        let (tx, rx) = oneshot::channel();
        self.jobs
            .send(Box::new(move |w| {
                let _ = tx.send(f(w));
            }))
            .expect("writer thread is running");
        rx.await.expect("writer thread answered")
    }

    /// Changes whenever an event is stored or a user is removed.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.shared.changes.subscribe()
    }

    pub fn caller(&self, token: &str) -> Option<Caller> {
        self.read(|m| m.caller(&token_hash(token)))
    }

    /// New single-use challenge for `/v1/auth/device`.
    pub fn new_nonce(&self) -> (String, u64) {
        let now = now_ms();
        let nonce = b64_encode(&random_bytes::<32>());
        let expires = now + NONCE_TTL_MS;
        let mut n = self.shared.nonces.lock().expect("nonce lock");
        n.retain(|_, exp| *exp > now);
        if n.len() >= MAX_NONCES
            && let Some(oldest) = n.iter().min_by_key(|(_, e)| **e).map(|(k, _)| k.clone())
        {
            n.remove(&oldest);
        }
        n.insert(nonce.clone(), expires);
        (nonce, expires)
    }

    /// Consumes a nonce; `true` if it existed and had not expired.
    pub fn take_nonce(&self, nonce: &str) -> bool {
        let mut n = self.shared.nonces.lock().expect("nonce lock");
        matches!(n.remove(nonce), Some(exp) if exp > now_ms())
    }

    /// Reads event bodies from the segments (blocking; call off the runtime).
    /// An event whose segment was deleted meanwhile is left out. A deleted
    /// record comes back with `deleted` set and an empty body, also when it
    /// was deleted after the caller copied its entry.
    pub fn read_bodies(&self, entries: &[Entry]) -> Vec<(Entry, Vec<u8>)> {
        let path = &self.shared.path;
        let _io = self.shared.io.read().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            if e.deleted {
                out.push((*e, Vec::new()));
                continue;
            }
            match eventlog::read_body(&segment_path(path, e.day), e.offset, e.size, e.h.gseq) {
                Ok(b) if eventlog::is_erased(&b) => out.push((Entry { deleted: true, ..*e }, Vec::new())),
                Ok(b) => out.push((*e, b)),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => tracing::error!("не удалось прочитать событие {}: {err}", e.h.gseq),
            }
        }
        out
    }
}

// ---- loading ----

fn load_users(root: &Path, mem: &mut Mem) {
    for (name, dir) in dir_entries(&root.join("users")) {
        let Some(id) = UserId::parse(&name) else {
            tracing::warn!("users/{name}: не userId, пропускаю");
            continue;
        };
        let identity = match read_json::<Envelope>(&dir.join("identity.json"))
            .and_then(|e| envelope::verify_identity(&e).map_err(|e| format!("{e:?}")))
        {
            Ok(i) if i.user_id == id => i,
            Ok(_) => {
                tracing::warn!("users/{name}/identity.json: чужой userId, пропускаю");
                continue;
            }
            Err(e) => {
                tracing::warn!("users/{name}/identity.json: {e}, пропускаю");
                continue;
            }
        };
        let profile = match read_json::<Envelope>(&dir.join("profile.json")) {
            Ok(env) => match envelope::verify_profile(&env, &id, &identity.key) {
                Ok(p) => Some(p),
                Err(e) => {
                    tracing::warn!("users/{name}/profile.json: {e:?}");
                    None
                }
            },
            Err(_) => None,
        };
        let removed_at = read_json::<RemovedFile>(&dir.join("removed"))
            .map(|r| r.removed_at)
            .ok()
            .or_else(|| dir.join("removed").exists().then_some(0));
        let revoked = match read_json::<RevokedFile>(&dir.join("revoked.json")) {
            Ok(f) => {
                let env = Envelope {
                    payload: f.payload,
                    sig: f.sig,
                };
                match envelope::parse_revocation(&env)
                    .and_then(|r| envelope::verify_revocation(&env, &r, &identity.key).map(|_| r))
                {
                    Ok(r) if r.user_id == id => Some(Revoked {
                        envelope: env,
                        at: f.received_at,
                    }),
                    _ => {
                        tracing::warn!("users/{name}/revoked.json: подпись или userId не сходятся, пропускаю");
                        None
                    }
                }
            }
            Err(_) => None,
        };
        let mut avatars: Vec<(std::time::SystemTime, AvatarFile)> = Vec::new();
        for (fname, p) in dir_entries(&dir) {
            if let Some(a) = parse_avatar_name(&fname) {
                let t = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                avatars.push((t, a));
            }
        }
        avatars.sort_by_key(|(t, _)| *t);
        let mut devices = HashMap::new();
        for (fname, p) in dir_entries(&dir.join("devices")) {
            let Some(dev) = fname.strip_suffix(".json").and_then(DevId::parse) else {
                continue;
            };
            match read_json::<DeviceFile>(&p) {
                Ok(f) => match parse_hash(&f.token_hash) {
                    Some(h) => {
                        mem.tokens.insert(h, (id, dev));
                        devices.insert(
                            dev,
                            Device {
                                token_hash: h,
                                created_at: f.created_at,
                                push: f.push,
                            },
                        );
                    }
                    None => tracing::warn!("users/{name}/devices/{fname}: повреждён хэш токена"),
                },
                Err(e) => tracing::warn!("users/{name}/devices/{fname}: {e}"),
            }
        }
        mem.users.insert(
            id,
            User {
                id,
                identity,
                profile,
                removed_at,
                revoked,
                devices,
                avatars: avatars.into_iter().map(|(_, a)| a).collect(),
            },
        );
    }
}

/// `avatar.<64 hex>.<jpg|webp>`.
fn parse_avatar_name(name: &str) -> Option<AvatarFile> {
    let rest = name.strip_prefix("avatar.")?;
    let (h, ext) = rest.split_once('.')?;
    if h.bytes().any(|b| b.is_ascii_uppercase()) {
        return None;
    }
    Some(AvatarFile {
        sha256: parse_hash(h)?,
        kind: ImageKind::from_ext(ext)?,
    })
}

fn load_invites(root: &Path, mem: &mut Mem) {
    for (name, p) in dir_entries(&root.join("invites")) {
        let Some(id) = name.strip_suffix(".json").filter(|h| parse_hash(h).is_some()) else {
            continue;
        };
        match read_json::<InviteFile>(&p) {
            Ok(f) => {
                mem.invites.insert(
                    id.to_string(),
                    Invite {
                        id: id.to_string(),
                        created_at: f.created_at,
                        expires_at: f.expires_at,
                        created_by: f.created_by,
                        used_at: f.used_at,
                        used_by: f.used_by,
                    },
                );
            }
            Err(e) => tracing::warn!("invites/{name}: {e}"),
        }
    }
}

fn load_chats(root: &Path, mem: &mut Mem) {
    for (name, dir) in dir_entries(&root.join("chats")) {
        let Some(id) = ChatId::parse(&name) else { continue };
        match read_json::<ChatMeta>(&dir.join("meta.json")) {
            Ok(m) if m.kind == "dm" && m.members.len() == 2 => {
                mem.chats.insert(
                    id,
                    Chat {
                        id,
                        kind: ChatKind::Dm,
                        members: m.members,
                        created_at: m.created_at,
                        epoch: m.epoch,
                        owner: None,
                        version: 0,
                        periods: Vec::new(),
                    },
                );
            }
            Ok(m) if m.kind == "group" && m.owner.is_some() && m.version >= 1 => {
                mem.chats.insert(
                    id,
                    Chat {
                        id,
                        kind: ChatKind::Group,
                        members: m.members,
                        created_at: m.created_at,
                        epoch: m.epoch,
                        owner: m.owner,
                        version: m.version,
                        periods: m.periods,
                    },
                );
            }
            Ok(m) => tracing::warn!("chats/{name}: вид чата {} не поддерживается этой версией", m.kind),
            Err(e) => tracing::warn!("chats/{name}/meta.json: {e}"),
        }
    }
}

/// Reads the sealed keys. Keys of a change that never committed (a crash
/// between writing the keys and `meta.json`) are deleted.
fn load_keys(root: &Path, mem: &mut Mem) {
    for (uid, dir) in dir_entries(&root.join("users")) {
        let Some(user) = UserId::parse(&uid) else { continue };
        let mut list = Vec::new();
        for (fname, p) in dir_entries(&dir.join("keys")) {
            let Some(n) = fname.strip_suffix(".key").and_then(|n| n.parse::<u64>().ok()) else {
                continue;
            };
            let f = match read_json::<KeyFile>(&p) {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!("users/{uid}/keys/{fname}: {e}");
                    continue;
                }
            };
            let committed = mem
                .chats
                .get(&f.chat_id)
                .is_some_and(|c| c.kind == ChatKind::Group && f.version <= c.version);
            let key = (!f.key.is_empty()).then_some(f.key);
            match (committed, key) {
                (true, Some(key)) => list.push(SealedKey {
                    n,
                    chat: f.chat_id,
                    epoch: f.epoch,
                    version: f.version,
                    created_at: f.created_at,
                    key,
                }),
                (false, _) => {
                    tracing::warn!("users/{uid}/keys/{fname}: изменение группы не завершено, удаляю ключ");
                    let _ = fs::remove_file(&p);
                }
                (true, None) => tracing::warn!("users/{uid}/keys/{fname}: повреждён ключ"),
            }
        }
        list.sort_by_key(|k| k.n);
        if !list.is_empty() {
            mem.keys.insert(user, list);
        }
    }
}

/// Reads all segments into the index. A damaged tail of the newest segment
/// (a write cut short by a crash) is cut off.
fn load_log(root: &Path, mem: &mut Mem) -> Result<Option<OpenSegment>, String> {
    let mut days: Vec<i64> = Vec::new();
    for (name, _) in dir_entries(&root.join("log")) {
        if let Some(stem) = name.strip_suffix(".seg") {
            match parse_day_name(stem) {
                Some(d) => days.push(d),
                None => tracing::warn!("log/{name}: имя не по формату ГГГГ-ММ-ДД, пропускаю"),
            }
        }
    }
    days.sort_unstable();
    let mut entries = Vec::new();
    let mut open = None;
    for (i, &day) in days.iter().enumerate() {
        let path = segment_path(root, day);
        let mut bytes = fs::read(&path).map_err(|e| format!("не удалось прочитать {}: {e}", path.display()))?;
        let dels = apply_deletions(root, day, &mut bytes)?;
        let (found, valid) = eventlog::scan(&bytes);
        let newest = i + 1 == days.len();
        if valid < bytes.len() {
            if newest {
                tracing::warn!(
                    "{}: оборванная запись в конце ({} байт) отброшена",
                    path.display(),
                    bytes.len() - valid
                );
                let f = fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .map_err(|e| format!("не удалось открыть {}: {e}", path.display()))?;
                f.set_len(valid as u64)
                    .and_then(|_| f.sync_all())
                    .map_err(|e| format!("не удалось обрезать {}: {e}", path.display()))?;
            } else {
                tracing::warn!(
                    "{}: повреждённые данные после {} записей ({} байт) пропущены",
                    path.display(),
                    found.len(),
                    bytes.len() - valid
                );
            }
        }
        for f in found {
            let rec = &bytes[f.offset as usize..(f.offset + f.size as u64) as usize];
            let mut deleted = false;
            if f.header.sender == NOTICE_SENDER {
                match eventlog::decode(rec).and_then(|(_, body)| Notice::parse(body)) {
                    Some(n) => {
                        mem.notices.insert(f.header.gseq, Arc::new(n));
                    }
                    None => tracing::warn!("{}: повреждено служебное событие {}", path.display(), f.header.gseq),
                }
            } else {
                deleted = dels.contains(&f.header.gseq)
                    || eventlog::decode(rec).is_some_and(|(_, body)| eventlog::is_erased(body));
            }
            entries.push(Entry {
                h: f.header,
                day,
                offset: f.offset,
                size: f.size,
                deleted,
            });
        }
        if newest {
            let file = fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(|e| format!("не удалось открыть {}: {e}", path.display()))?;
            open = Some(OpenSegment {
                day,
                file,
                len: valid as u64,
            });
        }
    }
    entries.sort_by_key(|e| e.h.gseq);
    let before = entries.len();
    entries.dedup_by_key(|e| e.h.gseq);
    if entries.len() != before {
        tracing::warn!(
            "в журнале повторяются номера событий: {} повторов пропущено",
            before - entries.len()
        );
    }
    for e in entries.iter().filter(|e| e.h.sender != NOTICE_SENDER) {
        mem.idem.insert((e.h.sender, e.h.msg), e.h.gseq);
    }
    mem.last_gseq = entries.last().map_or(0, |e| e.h.gseq);
    mem.log = entries;
    Ok(open)
}

/// Reads `log/<day>.del` and applies it to the segment bytes (and to the
/// file when a record still had to be zeroed: an overwrite interrupted by a
/// crash). A torn last entry is cut off. Returns the deleted `gseq`s.
fn apply_deletions(root: &Path, day: i64, seg: &mut [u8]) -> Result<HashSet<u64>, String> {
    let path = del_path(root, day);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(format!("не удалось прочитать {}: {e}", path.display())),
    };
    let (dels, valid) = eventlog::scan_del(&bytes);
    if valid < bytes.len() {
        tracing::warn!("{}: оборванная запись в конце отброшена", path.display());
        let f = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|e| format!("не удалось открыть {}: {e}", path.display()))?;
        f.set_len(valid as u64)
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("не удалось обрезать {}: {e}", path.display()))?;
    }
    let changed = eventlog::repair(seg, &dels);
    if !changed.is_empty() {
        let seg_path = segment_path(root, day);
        tracing::warn!(
            "{}: доделываю удаление {} записей, прерванное остановкой",
            seg_path.display(),
            changed.len()
        );
        let mut f = fs::OpenOptions::new()
            .write(true)
            .open(&seg_path)
            .map_err(|e| format!("не удалось открыть {}: {e}", seg_path.display()))?;
        for d in &changed {
            let rec = &seg[d.offset as usize..(d.offset + d.size as u64) as usize];
            write_at(&mut f, d.offset, rec).map_err(|e| format!("не удалось записать {}: {e}", seg_path.display()))?;
        }
        f.sync_data()
            .map_err(|e| format!("не удалось записать {}: {e}", seg_path.display()))?;
    }
    Ok(dels.into_iter().map(|d| d.gseq).collect())
}

fn write_at(f: &mut File, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::Start(offset))?;
    f.write_all(bytes)
}

// ---- writing ----

impl Writer {
    pub(crate) fn root(&self) -> &Path {
        &self.shared.path
    }

    pub(crate) fn server_id(&self) -> &str {
        &self.shared.server_id
    }

    pub(crate) fn mem(&self) -> std::sync::RwLockReadGuard<'_, Mem> {
        self.shared.mem.read().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn mem_mut(&self) -> std::sync::RwLockWriteGuard<'_, Mem> {
        self.shared.mem.write().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        self.shared.changes.send_modify(|v| *v += 1);
    }

    pub(crate) fn write_file(&self, target: &Path, bytes: &[u8]) -> Result<(), ApiError> {
        write_atomic_io(self.root(), target, bytes).map_err(|e| io_error("запись файла", e))
    }

    pub(crate) fn chat_dir(&self, c: &ChatId) -> PathBuf {
        self.root().join("chats").join(c.to_string())
    }

    pub(crate) fn write_meta(&self, c: &Chat) -> Result<(), ApiError> {
        let dir = self.chat_dir(&c.id);
        create_private_dir(&dir).map_err(|e| io_error("создание папки чата", e))?;
        self.write_file(&dir.join("meta.json"), &to_json(&ChatMeta::of(c)))
    }

    /// Writes sealed keys to the users' `keys/` folders (not yet in memory;
    /// see [`Writer::commit_keys`]).
    pub(crate) fn write_keys(
        &self,
        chat: &ChatId,
        epoch: u32,
        version: u64,
        keys: &[(UserId, String)],
        now: u64,
    ) -> Result<Vec<(UserId, SealedKey)>, ApiError> {
        let mut out = Vec::with_capacity(keys.len());
        for (u, key) in keys {
            let n = self.mem().keys.get(u).and_then(|v| v.last()).map_or(0, |k| k.n) + 1;
            let dir = self.user_dir(u).join("keys");
            create_private_dir(&dir).map_err(|e| io_error("создание папки ключей", e))?;
            let f = KeyFile {
                chat_id: *chat,
                epoch,
                version,
                created_at: now,
                key: key.clone(),
            };
            self.write_file(&dir.join(format!("{n}.key")), &to_json(&f))?;
            out.push((
                *u,
                SealedKey {
                    n,
                    chat: *chat,
                    epoch,
                    version,
                    created_at: now,
                    key: key.clone(),
                },
            ));
        }
        Ok(out)
    }

    pub(crate) fn commit_keys(m: &mut Mem, keys: Vec<(UserId, SealedKey)>) {
        for (u, k) in keys {
            m.keys.entry(u).or_default().push(k);
        }
    }

    pub(crate) fn check_space_pub(&self) -> Result<(), ApiError> {
        self.check_space()
    }

    pub(crate) fn user_dir(&self, u: &UserId) -> PathBuf {
        self.root().join("users").join(u.to_string())
    }

    fn write_device(&self, u: &UserId, dev: &DevId, d: &Device) -> Result<(), ApiError> {
        let dir = self.user_dir(u).join("devices");
        create_private_dir(&dir).map_err(|e| io_error("создание папки", e))?;
        let f = DeviceFile {
            token_hash: hex(&d.token_hash),
            created_at: d.created_at,
            push: d.push.clone(),
        };
        self.write_file(&dir.join(format!("{dev}.json")), &to_json(&f))
    }

    fn write_invite(&self, i: &Invite) -> Result<(), ApiError> {
        let f = InviteFile {
            created_at: i.created_at,
            expires_at: i.expires_at,
            created_by: i.created_by,
            used_at: i.used_at,
            used_by: i.used_by,
        };
        self.write_file(
            &self.root().join("invites").join(format!("{}.json", i.id)),
            &to_json(&f),
        )
    }

    fn write_server(&self, s: &ServerFile) -> Result<(), ApiError> {
        datadir::write_server_file(self.root(), s).map_err(|e| {
            tracing::error!("{e}");
            ApiError::internal("server storage error")
        })
    }

    fn check_space(&self) -> Result<(), ApiError> {
        if let Some((free, _)) = disk_space(self.root())
            && free < self.config.min_free_mb.saturating_mul(1024 * 1024)
        {
            tracing::warn!("мало места на диске: свободно {} МБ", free / (1024 * 1024));
            return Err(ApiError::storage_full());
        }
        Ok(())
    }

    /// Creates a device with a fresh token (replacing a device with the same id).
    fn issue_device(&self, user: &UserId, dev: DevId, now: u64) -> Result<String, ApiError> {
        let token = b64_encode(&random_bytes::<32>());
        let d = Device {
            token_hash: token_hash(&token),
            created_at: now,
            push: None,
        };
        self.write_device(user, &dev, &d)?;
        let mut m = self.mem_mut();
        let u = m.users.get_mut(user).expect("user exists");
        let old = u.devices.insert(dev, d.clone());
        if let Some(old) = old {
            m.tokens.remove(&old.token_hash);
        }
        m.tokens.insert(d.token_hash, (*user, dev));
        Ok(token)
    }

    /// `POST /v1/join`: a new member with an invitation or the administrator code.
    pub fn join(
        &mut self,
        code: JoinCode,
        identity: Identity,
        profile: Profile,
        dev: DevId,
        now: u64,
    ) -> Result<Issued, ApiError> {
        let uid = identity.user_id;
        // Check the code first, consume it only when everything else is fine.
        let invite = match &code {
            JoinCode::Invite(c) => {
                let id = invite_hash(c);
                let m = self.mem();
                let inv = m
                    .invites
                    .get(&id)
                    .ok_or_else(|| ApiError::forbidden("invalid_invite", "unknown invitation"))?;
                if inv.used_at.is_some() {
                    return Err(ApiError::new(
                        axum::http::StatusCode::GONE,
                        "invite_used",
                        "invitation already used",
                    ));
                }
                if now >= inv.expires_at {
                    return Err(ApiError::new(
                        axum::http::StatusCode::GONE,
                        "invite_expired",
                        "invitation expired",
                    ));
                }
                Some(inv.clone())
            }
            JoinCode::Admin(c) => {
                if !check_admin_code(&self.mem().server.admin_code_hash, c) {
                    return Err(ApiError::forbidden(
                        "invalid_code",
                        "wrong or already used administrator code",
                    ));
                }
                None
            }
        };
        if profile.avatar != AvatarRef::None {
            return Err(ApiError::bad_request("avatar must be null when joining"));
        }
        let rejoin = match self.mem().users.get(&uid) {
            Some(u) if u.revoked.is_some() => {
                return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
            }
            Some(u) if u.removed_at.is_none() => {
                return Err(ApiError::conflict(
                    "already_member",
                    "already a member; add a device with /v1/auth/device",
                ));
            }
            Some(_) => true,
            None => false,
        };
        self.check_space()?;

        if let Some(mut inv) = invite {
            inv.used_at = Some(now);
            inv.used_by = Some(uid);
            self.write_invite(&inv)?;
            self.mem_mut().invites.insert(inv.id.clone(), inv);
        } else {
            let mut s = self.mem().server.clone();
            s.admin_code_hash.clear();
            s.admins.push(uid.to_string());
            self.write_server(&s)?;
            self.mem_mut().server = s;
            tracing::info!("первый администратор вошёл, код администратора больше не действует");
        }

        let dir = self.user_dir(&uid);
        if rejoin {
            // A removed member invited again: old devices stay dead.
            let _ = fs::remove_dir_all(dir.join("devices"));
            let _ = fs::remove_file(dir.join("removed"));
        }
        create_private_dir(&dir.join("devices")).map_err(|e| io_error("создание папки", e))?;
        self.write_file(&dir.join("identity.json"), &to_json(&identity.envelope))?;
        self.write_file(&dir.join("profile.json"), &to_json(&profile.envelope))?;
        {
            let mut m = self.mem_mut();
            let mut avatars = Vec::new();
            if let Some(old) = m.users.remove(&uid) {
                for d in old.devices.values() {
                    m.tokens.remove(&d.token_hash);
                }
                avatars = old.avatars;
            }
            m.users.insert(
                uid,
                User {
                    id: uid,
                    identity,
                    profile: Some(profile),
                    removed_at: None,
                    revoked: None,
                    devices: HashMap::new(),
                    avatars,
                },
            );
        }
        let token = self.issue_device(&uid, dev, now)?;
        let admin = self.mem().is_admin(&uid);
        tracing::info!("новый участник {uid} (устройство {dev})");
        Ok(Issued {
            token,
            user: uid,
            dev,
            admin,
        })
    }

    /// `POST /v1/auth/device`: a device of an existing member, by signature.
    /// The nonce has already been consumed by the caller.
    pub fn auth_device(
        &mut self,
        env: &Envelope,
        req: &envelope::AuthRequest,
        nonce_ok: bool,
        now: u64,
    ) -> Result<Issued, ApiError> {
        let key = {
            let m = self.mem();
            let u = m
                .users
                .get(&req.user_id)
                .ok_or_else(|| ApiError::not_found("unknown_user", "no such member on this server"))?;
            if u.revoked.is_some() {
                return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
            }
            if u.removed_at.is_some() {
                return Err(ApiError::forbidden("removed", "removed from the family"));
            }
            u.identity.key
        };
        if req.server_id != self.shared.server_id {
            return Err(ApiError::bad_request("serverId is not this server's"));
        }
        if !nonce_ok {
            return Err(ApiError::unauthorized("unknown, used or expired nonce").code("bad_nonce"));
        }
        envelope::verify_auth(env, req, &key).map_err(|e| env_error(e, "auth"))?;
        let token = self.issue_device(&req.user_id, req.dev_id, now)?;
        tracing::info!("участник {} вошёл с устройства {}", req.user_id, req.dev_id);
        Ok(Issued {
            token,
            user: req.user_id,
            dev: req.dev_id,
            admin: self.mem().is_admin(&req.user_id),
        })
    }

    /// `PUT /v1/me/profile`.
    pub fn set_profile(&mut self, user: &UserId, env: &Envelope) -> Result<Profile, ApiError> {
        let (key, stored_rev, avatars) = {
            let m = self.mem();
            let u = m.users.get(user).ok_or_else(|| ApiError::internal("caller vanished"))?;
            (u.identity.key, u.profile.as_ref().map(|p| p.rev), u.avatars.clone())
        };
        let p = envelope::verify_profile(env, user, &key).map_err(|e| env_error(e, "profile"))?;
        match p.avatar {
            AvatarRef::None => {}
            AvatarRef::Image { sha256, kind } => {
                if !avatars.contains(&AvatarFile { sha256, kind }) {
                    return Err(
                        ApiError::bad_request("the avatar named in the profile was not uploaded")
                            .code("unknown_avatar"),
                    );
                }
            }
            AvatarRef::Legacy => return Err(ApiError::bad_request("avatar must be null or {sha256, type}")),
        }
        if let Some(r) = stored_rev
            && p.rev <= r
        {
            return Err(ApiError::conflict("stale_rev", format!("rev must be greater than {r}")).with("rev", r.into()));
        }
        self.write_file(&self.user_dir(user).join("profile.json"), &to_json(&p.envelope))?;
        if let Some(u) = self.mem_mut().users.get_mut(user) {
            u.profile = Some(p.clone());
        }
        self.prune_avatars(user, None);
        Ok(p)
    }

    /// `PUT /v1/me/avatar`: stores the image (already checked) and returns
    /// its file record.
    pub fn set_avatar(&mut self, user: &UserId, bytes: &[u8], kind: ImageKind) -> Result<AvatarFile, ApiError> {
        self.check_space()?;
        let a = AvatarFile {
            sha256: Sha256::digest(bytes).into(),
            kind,
        };
        self.write_file(&self.user_dir(user).join(a.file_name()), bytes)?;
        if let Some(u) = self.mem_mut().users.get_mut(user) {
            u.avatars.retain(|x| *x != a);
            u.avatars.push(a);
        }
        self.prune_avatars(user, Some(a));
        Ok(a)
    }

    /// Keeps the avatar named by the profile and the newest upload (`keep`,
    /// or the last one known); deletes the other avatar files.
    fn prune_avatars(&self, user: &UserId, keep: Option<AvatarFile>) {
        let (gone, dir) = {
            let mut m = self.mem_mut();
            let Some(u) = m.users.get_mut(user) else { return };
            let current = match u.profile.as_ref().map(|p| &p.avatar) {
                Some(AvatarRef::Image { sha256, kind }) => Some(AvatarFile {
                    sha256: *sha256,
                    kind: *kind,
                }),
                _ => None,
            };
            let newest = keep.or_else(|| u.avatars.last().copied());
            let (kept, gone): (Vec<_>, Vec<_>) = u
                .avatars
                .iter()
                .partition(|a| Some(**a) == current || Some(**a) == newest);
            u.avatars = kept;
            (gone, self.user_dir(user))
        };
        for a in gone {
            let _ = fs::remove_file(dir.join(a.file_name()));
        }
    }

    /// `POST /v1/revoke`: the owner of an identity revokes it.
    pub fn revoke(&mut self, env: &Envelope, now: u64) -> Result<(), ApiError> {
        let r = envelope::parse_revocation(env).map_err(|e| env_error(e, "revoked"))?;
        let (key, already) = {
            let m = self.mem();
            let u = m
                .users
                .get(&r.user_id)
                .ok_or_else(|| ApiError::not_found("unknown_user", "no such member on this server"))?;
            (u.identity.key, u.revoked.is_some())
        };
        envelope::verify_revocation(env, &r, &key).map_err(|e| env_error(e, "revoked"))?;
        if already {
            return Ok(());
        }
        let user = r.user_id;
        let f = RevokedFile {
            payload: env.payload.clone(),
            sig: env.sig.clone(),
            received_at: now,
        };
        self.write_file(&self.user_dir(&user).join("revoked.json"), &to_json(&f))?;
        self.drop_admin(&user)?;
        if let Some(u) = self.mem_mut().users.get_mut(&user) {
            u.revoked = Some(Revoked {
                envelope: env.clone(),
                at: now,
            });
        }
        tracing::info!("участник {user} отозвал свою идентичность");
        self.notify_group_owners(&user, "member_revoked", now);
        self.notify();
        Ok(())
    }

    fn drop_admin(&self, user: &UserId) -> Result<(), ApiError> {
        let mut server = self.mem().server.clone();
        let s = user.to_string();
        if server.admins.contains(&s) {
            server.admins.retain(|a| *a != s);
            self.write_server(&server)?;
            self.mem_mut().server = server;
        }
        Ok(())
    }

    /// `PUT/DELETE /v1/me/push`; also used to drop a subscription the push
    /// service reported as gone (`only_if` = its endpoint).
    pub fn set_push(
        &mut self,
        user: &UserId,
        dev: &DevId,
        sub: Option<Subscription>,
        only_if: Option<&str>,
    ) -> Result<bool, ApiError> {
        let mut d = match self.mem().users.get(user).and_then(|u| u.devices.get(dev)) {
            Some(d) => d.clone(),
            None => return Ok(false),
        };
        if let Some(ep) = only_if
            && d.push.as_ref().map(|s| s.endpoint.as_str()) != Some(ep)
        {
            return Ok(false);
        }
        d.push = sub;
        self.write_device(user, dev, &d)?;
        if let Some(x) = self.mem_mut().users.get_mut(user).and_then(|u| u.devices.get_mut(dev)) {
            x.push = d.push;
        }
        Ok(true)
    }

    fn open_segment(&mut self, day: i64) -> std::io::Result<&mut OpenSegment> {
        let current = self.segment.as_ref().map(|s| s.day);
        if current != Some(day) {
            let path = segment_path(self.root(), day);
            let file = datadir::private_file_options().create(true).append(true).open(&path)?;
            let len = file.metadata()?.len();
            datadir::sync_dir(&self.root().join("log"));
            self.segment = Some(OpenSegment { day, file, len });
        }
        Ok(self.segment.as_mut().expect("just opened"))
    }

    /// Appends one record to today's segment (fsync before returning) and
    /// adds it to the index. `gseq` is the next number.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn write_record(
        &mut self,
        chat: ChatId,
        sender: UserId,
        dev: DevId,
        epoch: u32,
        msg: MsgId,
        body: &[u8],
        now: u64,
        notice: Option<Arc<Notice>>,
    ) -> Result<u64, ApiError> {
        let gseq = self.mem().last_gseq + 1;
        let day = day_of_ms(now).max(self.segment.as_ref().map_or(i64::MIN, |s| s.day));
        let header = Header {
            gseq,
            time: now,
            chat,
            sender,
            dev,
            epoch,
            msg,
        };
        let rec = eventlog::encode(&header, body);
        let seg = self.open_segment(day).map_err(|e| io_error("открытие журнала", e))?;
        let offset = seg.len;
        let written = seg.file.write_all(&rec).and_then(|_| seg.file.sync_data());
        if let Err(e) = written {
            // Leave no partial record behind.
            let _ = seg.file.set_len(offset);
            return Err(io_error("запись в журнал", e));
        }
        seg.len += rec.len() as u64;
        {
            let mut m = self.mem_mut();
            m.log.push(Entry {
                h: header,
                day,
                offset,
                size: rec.len() as u32,
                deleted: false,
            });
            match notice {
                Some(n) => {
                    m.notices.insert(gseq, n);
                }
                None => {
                    m.idem.insert((sender, msg), gseq);
                }
            }
            m.last_gseq = gseq;
        }
        self.notify();
        Ok(gseq)
    }

    /// Writes a server notice into the log. Its `gseq` is the next number
    /// (callers that need it in advance use `last_gseq + 1`).
    pub(crate) fn write_notice(&mut self, chat: ChatId, epoch: u32, n: Notice, now: u64) -> Result<u64, ApiError> {
        let body = n.to_bytes();
        self.write_record(
            chat,
            NOTICE_SENDER,
            DevId([0; 10]),
            epoch,
            MsgId([0; 16]),
            &body,
            now,
            Some(Arc::new(n)),
        )
    }

    /// Tells the owners of `user`'s groups that `user` was removed from the
    /// family or revoked their identity. When `user` owns the group, all
    /// other members are told. Failures are only logged.
    fn notify_group_owners(&mut self, user: &UserId, kind: &str, now: u64) {
        let groups: Vec<(ChatId, u32, Vec<UserId>)> = {
            let m = self.mem();
            let mut v: Vec<_> = m
                .chats
                .values()
                .filter(|c| c.kind == ChatKind::Group && c.is_member(user))
                .map(|c| {
                    let owner = c.owner.expect("group has an owner");
                    let to = if owner != *user {
                        vec![owner]
                    } else {
                        c.members.iter().filter(|u| *u != user).copied().collect()
                    };
                    (c.id, c.epoch, to)
                })
                .collect();
            v.sort_by_key(|(id, _, _)| id.to_string());
            v
        };
        for (chat, epoch, to) in groups {
            if to.is_empty() {
                continue;
            }
            let n = Notice::member_event(kind, user, to);
            if let Err(e) = self.write_notice(chat, epoch, n, now) {
                tracing::error!("не удалось записать служебное событие для группы {chat}: {}", e.message);
            }
        }
    }

    /// `POST /v1/chats/<id>/events`.
    #[allow(clippy::too_many_arguments)]
    pub fn append(
        &mut self,
        chat_id: ChatId,
        sender: UserId,
        dev: DevId,
        epoch: u32,
        msg: MsgId,
        body: &[u8],
        now: u64,
    ) -> Result<Appended, ApiError> {
        let server_id = self.shared.server_id.clone();
        let (chat, new_chat, repeat) = {
            let m = self.mem();
            let u = m
                .users
                .get(&sender)
                .ok_or_else(|| ApiError::unauthorized("unknown device"))?;
            if u.revoked.is_some() {
                return Err(ApiError::forbidden("revoked", "this identity was revoked by its owner"));
            }
            if u.removed_at.is_some() {
                return Err(ApiError::forbidden("removed", "removed from the family"));
            }
            let (chat, new_chat) = match m.chats.get(&chat_id) {
                Some(c) if c.is_member(&sender) => (c.clone(), false),
                Some(_) => return Err(ApiError::forbidden("not_member", "not a member of this chat")),
                None => match m.derive_direct(&server_id, &sender, &chat_id) {
                    Some(peer) => {
                        let mut members = [sender, peer];
                        members.sort_by_key(|u| u.to_string());
                        (
                            Chat {
                                id: chat_id,
                                kind: ChatKind::Dm,
                                members: members.to_vec(),
                                created_at: now,
                                epoch: 0,
                                owner: None,
                                version: 0,
                                periods: Vec::new(),
                            },
                            true,
                        )
                    }
                    None => return Err(ApiError::not_found("chat_not_found", "no such chat")),
                },
            };
            let repeat = m.idem.get(&(sender, msg)).and_then(|g| m.entry(*g)).copied();
            (chat, new_chat, repeat)
        };
        if let Some(e) = repeat {
            if e.h.chat != chat_id {
                return Err(ApiError::conflict(
                    "idempotency_conflict",
                    "this Idempotency-Key was used in another chat",
                ));
            }
            return Ok(Appended {
                gseq: e.h.gseq,
                time: e.h.time,
                duplicate: true,
                chat,
            });
        }
        if epoch != chat.epoch {
            return Err(
                ApiError::conflict("epoch_mismatch", "epoch is not the chat's current epoch")
                    .with("epoch", chat.epoch.into()),
            );
        }
        if chat.kind == ChatKind::Dm {
            let peer_removed = {
                let m = self.mem();
                chat.members
                    .iter()
                    .any(|p| *p != sender && m.users.get(p).is_none_or(|u| !u.active()))
            };
            if peer_removed {
                return Err(ApiError::forbidden(
                    "peer_removed",
                    "the other member was removed from the family or revoked their identity",
                ));
            }
        }
        self.check_space()?;

        if new_chat {
            self.write_meta(&chat)?;
            self.mem_mut().chats.insert(chat_id, chat.clone());
        }

        let gseq = self.write_record(chat_id, sender, dev, epoch, msg, body, now, None)?;
        Ok(Appended {
            gseq,
            time: now,
            duplicate: false,
            chat,
        })
    }

    /// `DELETE /v1/chats/<id>/events/<gseq>` ("delete for everyone"):
    /// allowed for the event's sender and for the group owner. The intent
    /// goes to `log/<day>.del` first (fsync), then the body is zeroed in
    /// place (fsync), then the index and a notice for the chat's members.
    /// Deleting a deleted record succeeds again without a second notice.
    /// Returns whether the record was already deleted.
    pub fn delete_event(&mut self, chat_id: ChatId, gseq: u64, by: UserId, now: u64) -> Result<bool, ApiError> {
        let server_id = self.shared.server_id.clone();
        let (chat, entry) = {
            let m = self.mem();
            let chat = match m.chats.get(&chat_id) {
                Some(c) if c.is_member(&by) => c.clone(),
                Some(_) => return Err(ApiError::forbidden("not_member", "not a member of this chat")),
                None if m.derive_direct(&server_id, &by, &chat_id).is_some() => {
                    return Err(ApiError::not_found("event_not_found", "no such event in this chat"));
                }
                None => return Err(ApiError::not_found("chat_not_found", "no such chat")),
            };
            let entry = match m.entry(gseq) {
                Some(e) if e.h.chat == chat_id && e.h.sender != NOTICE_SENDER => *e,
                None if gseq >= 1 && gseq < m.oldest_gseq() => {
                    return Err(ApiError::new(
                        axum::http::StatusCode::GONE,
                        "expired",
                        "the event was already removed by the retention period",
                    ));
                }
                _ => return Err(ApiError::not_found("event_not_found", "no such event in this chat")),
            };
            (chat, entry)
        };
        let owner = chat.kind == ChatKind::Group && chat.owner == Some(by);
        if entry.h.sender != by && !owner {
            return Err(ApiError::forbidden(
                "not_author",
                "only the sender or the group owner can delete this event",
            ));
        }
        if entry.deleted {
            return Ok(true);
        }
        // 1. The intent, durable before the segment changes.
        let del = eventlog::DelEntry {
            gseq,
            offset: entry.offset,
            size: entry.size,
        };
        let del_file = del_path(self.root(), entry.day);
        let fresh = !del_file.exists();
        let written = datadir::private_file_options()
            .create(true)
            .append(true)
            .open(&del_file)
            .and_then(|mut f| f.write_all(&del.encode()).and_then(|_| f.sync_data()));
        written.map_err(|e| io_error("запись списка удалённых", e))?;
        if fresh {
            datadir::sync_dir(&self.root().join("log"));
        }
        // 2. Zero the body in place.
        {
            let _io = self.shared.io.write().unwrap_or_else(|e| e.into_inner());
            let seg = segment_path(self.root(), entry.day);
            let erased = (|| -> std::io::Result<()> {
                let mut f = fs::OpenOptions::new().read(true).write(true).open(&seg)?;
                let mut rec = vec![0u8; entry.size as usize];
                {
                    use std::io::{Read, Seek, SeekFrom};
                    f.seek(SeekFrom::Start(entry.offset))?;
                    f.read_exact(&mut rec)?;
                }
                if !eventlog::frame_matches(&rec, gseq) {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "log record does not match the index",
                    ));
                }
                eventlog::erase(&mut rec);
                write_at(
                    &mut f,
                    entry.offset + eventlog::BODY_AT as u64,
                    &rec[eventlog::BODY_AT..],
                )?;
                f.sync_data()
            })();
            // On failure the intent stays in `.del` and the next start
            // finishes the overwrite; the record counts as deleted already.
            if let Err(e) = erased {
                tracing::error!("не удалось затереть событие {gseq}: {e}; будет доделано при запуске");
            }
            let mut m = self.mem_mut();
            if let Ok(i) = m.log.binary_search_by_key(&gseq, |e| e.h.gseq) {
                m.log[i].deleted = true;
            }
        }
        tracing::info!("событие {gseq} удалено у всех");
        // 3. Tell the members.
        let n = Notice::event_deleted(&entry.h, &by, chat.unique_members());
        if let Err(e) = self.write_notice(chat_id, chat.epoch, n, now) {
            tracing::error!(
                "не удалось записать служебное событие об удалении {gseq}: {}",
                e.message
            );
            self.notify();
        }
        Ok(false)
    }

    /// `DELETE /v1/admin/users/<id>`: tokens stop working at once.
    pub fn remove_user(&mut self, user: &UserId, now: u64) -> Result<(), ApiError> {
        let (exists, already) = {
            let m = self.mem();
            match m.users.get(user) {
                Some(u) => (true, u.removed_at.is_some()),
                None => (false, false),
            }
        };
        if !exists {
            return Err(ApiError::not_found("unknown_user", "no such member"));
        }
        if already {
            return Ok(());
        }
        self.write_file(
            &self.user_dir(user).join("removed"),
            &to_json(&RemovedFile { removed_at: now }),
        )?;
        self.drop_admin(user)?;
        if let Some(u) = self.mem_mut().users.get_mut(user) {
            u.removed_at = Some(now);
        }
        tracing::info!("участник {user} исключён");
        self.notify_group_owners(user, "member_removed", now);
        self.notify();
        Ok(())
    }

    /// `POST /v1/admin/invites`: returns the invitation and its code (shown once).
    pub fn create_invite(&mut self, by: &UserId, now: u64) -> Result<(Invite, String), ApiError> {
        let code = b32_encode(&random_bytes::<16>());
        let inv = Invite {
            id: invite_hash(&code),
            created_at: now,
            expires_at: now + INVITE_TTL_MS,
            created_by: *by,
            used_at: None,
            used_by: None,
        };
        self.write_invite(&inv)?;
        self.mem_mut().invites.insert(inv.id.clone(), inv.clone());
        Ok((inv, code))
    }

    pub fn delete_invite(&mut self, id: &str) -> Result<(), ApiError> {
        if !self.mem().invites.contains_key(id) {
            return Err(ApiError::not_found("not_found", "no such invitation"));
        }
        let p = self.root().join("invites").join(format!("{id}.json"));
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("удаление приглашения", e)),
        }
        self.mem_mut().invites.remove(id);
        Ok(())
    }

    /// Hourly cleanup: log segments and blob day folders older than the
    /// retention, expired invitations.
    pub fn retention(&mut self, now: u64) -> RetentionReport {
        let mut report = RetentionReport::default();
        let newest = self.mem().log.last().map(|e| e.h.time);
        let reference = reference_time(now, newest);
        let days = self.config.retention_days;
        let mut gone_days = HashSet::new();
        for (name, path) in dir_entries(&self.root().join("log")) {
            let Some((stem, _)) = name.split_once('.') else {
                continue;
            };
            let Some(day) = parse_day_name(stem) else { continue };
            if !day_expired(day, reference, days) {
                continue;
            }
            if self.segment.as_ref().is_some_and(|s| s.day == day) {
                self.segment = None;
            }
            match fs::remove_file(&path) {
                Ok(()) => {
                    gone_days.insert(day);
                    report.segments.push(name);
                }
                Err(e) => tracing::error!("не удалось удалить {}: {e}", path.display()),
            }
        }
        if !gone_days.is_empty() {
            let mut m = self.mem_mut();
            let before = m.log.len();
            m.log.retain(|e| !gone_days.contains(&e.day));
            report.events = before - m.log.len();
            let kept: HashSet<u64> = m.log.iter().map(|e| e.h.gseq).collect();
            m.idem.retain(|_, g| kept.contains(g));
            m.notices.retain(|g, _| kept.contains(g));
        }
        report.blob_days = self.shared.blobs.remove_days(|day| day_expired(day, reference, days));
        let expired: Vec<String> = self
            .mem()
            .invites
            .values()
            .filter(|i| i.expires_at <= now)
            .map(|i| i.id.clone())
            .collect();
        for id in expired {
            if self.delete_invite(&id).is_ok() {
                report.invites += 1;
            }
        }
        if !report.segments.is_empty() || !report.blob_days.is_empty() {
            tracing::info!(
                "очистка: удалено дней журнала {}, событий {}, папок вложений {}",
                report.segments.len(),
                report.events,
                report.blob_days.len()
            );
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = MS_PER_DAY;

    #[test]
    fn reference_time_rule() {
        let t = 1_000 * DAY;
        assert_eq!(reference_time(t, None), t);
        assert_eq!(reference_time(t, Some(t - DAY)), t);
        // Clock jumped far forward: counts from newest event + 7 days.
        assert_eq!(reference_time(t + 365 * DAY, Some(t)), t + 7 * DAY);
        // Clock set back: "now" is earlier, cleanup is just delayed.
        assert_eq!(reference_time(t - 30 * DAY, Some(t)), t - 30 * DAY);
    }

    #[test]
    fn expiry_boundary() {
        let day = 1000i64;
        let end = (day as u64 + 1) * DAY;
        assert!(!day_expired(day, end + 7 * DAY - 1, 7));
        assert!(day_expired(day, end + 7 * DAY, 7));
    }

    fn test_store(root: &Path, retention_days: u32) -> Store {
        for d in datadir::DIRS {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let server = ServerFile {
            format_version: 1,
            server_id: "srv".into(),
            created_at: 0,
            admin_code_hash: String::new(),
            admins: vec![],
        };
        Store::open(
            root,
            server,
            StoreConfig {
                retention_days,
                min_free_mb: 0,
                max_blob_bytes: 1 << 30,
            },
        )
        .unwrap()
    }

    fn write_segment(root: &Path, day: i64, gseqs: &[(u64, u64)]) {
        let mut bytes = Vec::new();
        for &(gseq, time) in gseqs {
            let h = Header {
                gseq,
                time,
                chat: ChatId([1; 16]),
                sender: UserId([2; 16]),
                dev: DevId([3; 10]),
                epoch: 0,
                msg: MsgId([gseq as u8; 16]),
            };
            bytes.extend(eventlog::encode(&h, b"body"));
        }
        fs::create_dir_all(root.join("log")).unwrap();
        fs::write(segment_path(root, day), bytes).unwrap();
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().build().unwrap()
    }

    /// Segments for days 100..=110, one event at noon of each day.
    fn fill(root: &Path) {
        for (i, day) in (100..=110i64).enumerate() {
            let t = day as u64 * DAY + DAY / 2;
            write_segment(root, day, &[(i as u64 + 1, t)]);
        }
        fs::create_dir_all(root.join("blobs").join(day_name(100)).join("b")).unwrap();
        fs::create_dir_all(root.join("blobs").join(day_name(110)).join("b")).unwrap();
    }

    #[test]
    fn retention_normal_and_clock_jumps() {
        let rt = rt();
        // Normal clock: now = day 115 noon, retention 7 → threshold day 108
        // noon → days 100..=107 deleted, 108..=110 kept.
        let tmp = tempfile::tempdir().unwrap();
        fill(tmp.path());
        let store = test_store(tmp.path(), 7);
        let now = 115 * DAY + DAY / 2;
        let r = rt.block_on(store.write(move |w| w.retention(now)));
        assert_eq!(r.segments.len(), 8, "{r:?}");
        assert_eq!(r.events, 8);
        assert_eq!(r.blob_days, vec![day_name(100)]);
        store.read(|m| {
            assert_eq!(m.log.len(), 3);
            assert_eq!(m.oldest_gseq(), 9);
            assert_eq!(m.last_gseq, 11);
        });

        // Clock jumped a year forward: reference is newest event + 7 days
        // (day 117 noon) → threshold day 110 noon: day 110 is kept.
        let tmp = tempfile::tempdir().unwrap();
        fill(tmp.path());
        let store = test_store(tmp.path(), 7);
        let now = 475 * DAY;
        let r = rt.block_on(store.write(move |w| w.retention(now)));
        assert_eq!(r.segments.len(), 10, "{r:?}");
        store.read(|m| assert_eq!(m.log.len(), 1, "the newest day survives"));
        assert!(segment_path(tmp.path(), 110).exists());
        assert!(tmp.path().join("blobs").join(day_name(110)).exists());

        // Clock set back before all events: nothing is deleted.
        let tmp = tempfile::tempdir().unwrap();
        fill(tmp.path());
        let store = test_store(tmp.path(), 7);
        let now = 50 * DAY;
        let r = rt.block_on(store.write(move |w| w.retention(now)));
        assert_eq!(r, RetentionReport::default());
        store.read(|m| assert_eq!(m.log.len(), 11));
    }

    #[test]
    fn invitation_one_time_and_expiry() {
        use crate::envelope::testkit;
        use ed25519_dalek::SigningKey;
        let rt = rt();
        let tmp = tempfile::tempdir().unwrap();
        let store = test_store(tmp.path(), 90);
        let member = |seed: u8| {
            let k = SigningKey::from_bytes(&[seed; 32]);
            let (uid, env) = testkit::identity(&k);
            let id = envelope::verify_identity(&env).unwrap();
            let p = envelope::verify_profile(&testkit::profile(&k, &uid, "x", 1), &uid, &id.key).unwrap();
            (id, p)
        };
        let by = UserId([0; 16]);
        let (_, code) = rt.block_on(store.write(move |w| w.create_invite(&by, 0))).unwrap();
        let (id, p) = member(1);
        let c = code.clone();
        let e = rt
            .block_on(store.write(move |w| w.join(JoinCode::Invite(c), id, p, DevId([1; 10]), INVITE_TTL_MS)))
            .unwrap_err();
        assert_eq!((e.status.as_u16(), e.code), (410, "invite_expired"));
        let (id, p) = member(2);
        let c = code.clone();
        let ok = rt
            .block_on(store.write(move |w| w.join(JoinCode::Invite(c), id, p, DevId([1; 10]), INVITE_TTL_MS - 1)))
            .unwrap();
        assert!(!ok.admin);
        let (id, p) = member(3);
        let e = rt
            .block_on(store.write(move |w| w.join(JoinCode::Invite(code), id, p, DevId([1; 10]), 10)))
            .unwrap_err();
        assert_eq!((e.status.as_u16(), e.code), (410, "invite_used"));
        // Upper-case or padded input is the same code.
        let (_, code) = rt.block_on(store.write(move |w| w.create_invite(&by, 0))).unwrap();
        let (id, p) = member(4);
        let c = format!(" {} ", code.to_uppercase());
        assert!(
            rt.block_on(store.write(move |w| w.join(JoinCode::Invite(c), id, p, DevId([1; 10]), 10)))
                .is_ok()
        );
    }

    /// A direct chat between two users with id `[1; 16]` would need real
    /// users; tests of `delete_event` use a hand-made group chat instead.
    fn add_group(store: &Store, rt: &tokio::runtime::Runtime, owner: UserId, members: Vec<UserId>) {
        let periods = members
            .iter()
            .map(|u| Period {
                user_id: *u,
                from: 0,
                to: None,
            })
            .collect();
        let chat = Chat {
            id: ChatId([1; 16]),
            kind: ChatKind::Group,
            members,
            created_at: 0,
            epoch: 0,
            owner: Some(owner),
            version: 1,
            periods,
        };
        rt.block_on(store.write(move |w| w.mem_mut().chats.insert(chat.id, chat)));
    }

    #[test]
    fn retention_removes_segments_with_deleted_records() {
        let rt = rt();
        let tmp = tempfile::tempdir().unwrap();
        fill(tmp.path());
        let store = test_store(tmp.path(), 7);
        let sender = UserId([2; 16]);
        add_group(&store, &rt, sender, vec![sender]);
        // gseq 1 is day 100 (expires), gseq 10 is day 109 (stays).
        for g in [1u64, 10] {
            let r = rt.block_on(store.write(move |w| w.delete_event(ChatId([1; 16]), g, sender, 115 * DAY)));
            assert!(!r.unwrap(), "first deletion");
        }
        assert!(del_path(tmp.path(), 100).exists());
        assert!(del_path(tmp.path(), 109).exists());
        let now = 115 * DAY + DAY / 2;
        let r = rt.block_on(store.write(move |w| w.retention(now)));
        assert_eq!(r.events, 8);
        assert!(!segment_path(tmp.path(), 100).exists());
        assert!(!del_path(tmp.path(), 100).exists(), "the .del file goes with its day");
        assert!(del_path(tmp.path(), 109).exists());
        store.read(|m| {
            assert!(m.entry(10).unwrap().deleted);
            assert!(!m.entry(11).unwrap().deleted);
        });
        drop(store);
        // After a restart the kept day still has its deletion.
        let store = test_store(tmp.path(), 7);
        store.read(|m| {
            assert_eq!(m.oldest_gseq(), 9);
            assert!(m.entry(10).unwrap().deleted);
            // The notices of the deletions (day 115) are in the log too.
            assert!(m.log.iter().any(|e| e.h.sender == NOTICE_SENDER));
        });
        let bodies = store.read_bodies(&store.read(|m| m.log.clone()));
        let ten = bodies.iter().find(|(e, _)| e.h.gseq == 10).unwrap();
        assert!(ten.0.deleted && ten.1.is_empty());
        drop(rt);
    }

    /// The `.del` entry reached the disk but the overwrite of the segment was
    /// cut short (half the body zeroed, the old CRC): the next start finishes
    /// it instead of taking the record for a torn tail and losing what follows.
    #[test]
    fn restart_finishes_an_interrupted_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        let day = 300i64;
        write_segment(
            tmp.path(),
            day,
            &[(1, 300 * DAY), (2, 300 * DAY + 1), (3, 300 * DAY + 2)],
        );
        let p = segment_path(tmp.path(), day);
        let mut bytes = fs::read(&p).unwrap();
        let found = eventlog::scan(&bytes).0;
        let r = found[1];
        // Torn overwrite: the first two body bytes are zeroed, nothing else.
        let at = r.offset as usize + eventlog::BODY_AT;
        bytes[at] = 0;
        bytes[at + 1] = 0;
        fs::write(&p, &bytes).unwrap();
        assert_eq!(eventlog::scan(&bytes).0.len(), 1, "unrepaired, the scan would stop");
        let del = eventlog::DelEntry {
            gseq: 2,
            offset: r.offset,
            size: r.size,
        };
        // A torn second entry at the end of the .del file is dropped.
        let mut dels = del.encode().to_vec();
        dels.extend_from_slice(&[1, 2, 3]);
        fs::write(del_path(tmp.path(), day), &dels).unwrap();

        let store = test_store(tmp.path(), 90);
        store.read(|m| {
            assert_eq!(m.log.len(), 3);
            assert_eq!(m.last_gseq, 3);
            assert!(!m.entry(1).unwrap().deleted);
            assert!(m.entry(2).unwrap().deleted);
            assert!(!m.entry(3).unwrap().deleted);
        });
        let repaired = fs::read(&p).unwrap();
        let (again, valid) = eventlog::scan(&repaired);
        assert_eq!((again.len(), valid), (3, repaired.len()));
        let rec = &repaired[r.offset as usize..(r.offset + r.size as u64) as usize];
        assert!(eventlog::is_erased(eventlog::decode(rec).unwrap().1));
        assert_eq!(fs::read(del_path(tmp.path(), day)).unwrap().len(), eventlog::DEL_ENTRY);
        let bodies = store.read_bodies(&store.read(|m| m.log.clone()));
        assert_eq!(bodies.len(), 3);
        assert_eq!(bodies[0].1, b"body");
        assert!(bodies[1].0.deleted && bodies[1].1.is_empty());
    }

    /// A segment copied without its `.del` file still shows zeroed records
    /// as deleted.
    #[test]
    fn zeroed_body_without_del_file_counts_as_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        write_segment(tmp.path(), 310, &[(1, 310 * DAY), (2, 310 * DAY + 1)]);
        let p = segment_path(tmp.path(), 310);
        let mut bytes = fs::read(&p).unwrap();
        let r = eventlog::scan(&bytes).0[0];
        eventlog::erase(&mut bytes[r.offset as usize..(r.offset + r.size as u64) as usize]);
        fs::write(&p, &bytes).unwrap();
        let store = test_store(tmp.path(), 90);
        store.read(|m| {
            assert!(m.entry(1).unwrap().deleted);
            assert!(!m.entry(2).unwrap().deleted);
        });
    }

    #[test]
    fn restart_drops_torn_tail_and_keeps_numbering() {
        let rt = rt();
        let tmp = tempfile::tempdir().unwrap();
        write_segment(tmp.path(), 200, &[(1, 200 * DAY), (2, 200 * DAY + 1)]);
        write_segment(tmp.path(), 201, &[(3, 201 * DAY), (4, 201 * DAY + 1)]);
        let p = segment_path(tmp.path(), 201);
        let full = fs::read(&p).unwrap();
        fs::write(&p, &full[..full.len() - 3]).unwrap();
        let store = test_store(tmp.path(), 90);
        store.read(|m| {
            assert_eq!(m.log.len(), 3);
            assert_eq!(m.last_gseq, 3);
            assert!(m.idem.contains_key(&(UserId([2; 16]), MsgId([3; 16]))));
        });
        // The torn bytes were cut off, so the file ends at a record boundary.
        let cut = fs::read(&p).unwrap();
        assert_eq!(eventlog::scan(&cut).1, cut.len());
        let bodies = store.read_bodies(&store.read(|m| m.log.clone()));
        assert_eq!(bodies.len(), 3);
        assert!(bodies.iter().all(|(_, b)| b == b"body"));
        drop(rt);
    }
}
