//! MCP connections of one family: `mcp/<id>.json` in the family's data
//! folder (private files, they hold identity seeds), and their index in memory.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::client::IdentityKeys;
use crate::datadir::{create_private_dir, hex, write_atomic_io};
use crate::ids::{ChatId, DevId, UserId, b32_encode, b64_decode, b64_encode};
use crate::store::token_hash;
use crate::webpush::random_bytes;

pub const DIR: &str = "mcp";
/// Tokens of MCP connections start with this, so they are told from device tokens at a glance.
pub const TOKEN_PREFIX: &str = "fcm_";
/// Connections of one family.
pub const MAX_CONNECTIONS: usize = 50;

/// What a connection may do. `read` and `write` are on by default; the rest
/// is switched on by a person in the app, never by a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Chats, messages, members, search, waiting for new messages.
    Read,
    /// Messages, reactions, groups, the profile.
    Write,
    /// Sending and receiving files.
    Files,
    /// Invitations, the member list, statistics.
    Admin,
    /// What cannot be undone: deleting for everyone, removing a member, revoking the identity.
    Destructive,
}

impl Level {
    pub const DEFAULT: [Level; 2] = [Level::Read, Level::Write];

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Read => "read",
            Level::Write => "write",
            Level::Files => "files",
            Level::Admin => "admin",
            Level::Destructive => "destructive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// An identity of its own, created by an administrator: an ordinary member of the family.
    Helper,
    /// A member's own identity, connected by that member.
    Me,
}

/// A connection as it is stored. Holds the identity seed.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnFile {
    pub id: String,
    /// Label shown in the app (for a helper, also its profile name at creation).
    pub name: String,
    pub mode: Mode,
    pub user_id: UserId,
    pub dev_id: DevId,
    /// base64url of the 32-byte identity seed.
    pub seed: String,
    /// SHA-256 (hex) of the bearer token; the token itself is shown once.
    pub token_hash: String,
    pub levels: Vec<Level>,
    pub created_by: UserId,
    pub created_at: u64,
    /// Next `seq` of this device per chat (events number themselves per device and chat).
    #[serde(default)]
    pub seq: BTreeMap<String, u64>,
    /// Messages this connection hid from itself ("delete for me"): `<author>/<message id>`.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub hidden: BTreeSet<String>,
}

/// A loaded connection: the record and the keys derived from its seed.
pub struct Conn {
    pub file: ConnFile,
    pub keys: IdentityKeys,
}

impl Conn {
    fn load(file: ConnFile) -> Option<Conn> {
        let seed: [u8; 32] = b64_decode(&file.seed)?.try_into().ok()?;
        let keys = IdentityKeys::from_seed(&seed);
        (keys.user_id == file.user_id).then_some(Conn { file, keys })
    }

    pub fn allows(&self, level: Level) -> bool {
        self.file.levels.contains(&level)
    }
}

struct Inner {
    conns: HashMap<String, Arc<Conn>>,
    by_token: HashMap<[u8; 32], String>,
}

pub struct McpStore {
    /// The family's data folder.
    data: PathBuf,
    inner: RwLock<Inner>,
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

/// A new connection id: base32 of 10 random bytes.
pub fn new_id() -> String {
    b32_encode(&random_bytes::<10>())
}

/// A new bearer token and the hash stored for it.
pub fn new_token() -> (String, String) {
    let token = format!("{TOKEN_PREFIX}{}", b64_encode(&random_bytes::<32>()));
    let hash = hex(&token_hash(&token));
    (token, hash)
}

impl McpStore {
    /// Loads `mcp/*.json`. A file that does not parse or whose seed does not
    /// give its userId is skipped with a warning and left on disk.
    pub fn open(data: &Path) -> McpStore {
        let mut inner = Inner {
            conns: HashMap::new(),
            by_token: HashMap::new(),
        };
        if let Ok(rd) = std::fs::read_dir(data.join(DIR)) {
            for e in rd.flatten() {
                let path = e.path();
                if path.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let loaded = std::fs::read(&path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<ConnFile>(&b).ok())
                    .and_then(Conn::load);
                match loaded {
                    Some(c) => inner.add(Arc::new(c)),
                    None => tracing::warn!(
                        "{}",
                        tr!(
                            "{}: не подключение MCP, пропускаю",
                            "{}: not an MCP connection, skipping",
                            path.display()
                        )
                    ),
                }
            }
        }
        McpStore {
            data: data.to_path_buf(),
            inner: RwLock::new(inner),
        }
    }

    fn path(&self, id: &str) -> PathBuf {
        self.data.join(DIR).join(format!("{id}.json"))
    }

    fn write(&self, file: &ConnFile) -> std::io::Result<()> {
        create_private_dir(&self.data.join(DIR))?;
        let json = serde_json::to_vec_pretty(file).expect("serialisable");
        write_atomic_io(&self.data, &self.path(&file.id), &json)
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn lock(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    /// The connection a bearer token belongs to.
    pub fn by_token(&self, token: &str) -> Option<Arc<Conn>> {
        if !token.starts_with(TOKEN_PREFIX) {
            return None;
        }
        let inner = self.read();
        let id = inner.by_token.get(&token_hash(token))?;
        inner.conns.get(id).cloned()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Conn>> {
        self.read().conns.get(id).cloned()
    }

    /// All connections, oldest first.
    pub fn list(&self) -> Vec<Arc<Conn>> {
        let mut v: Vec<Arc<Conn>> = self.read().conns.values().cloned().collect();
        v.sort_by(|a, b| (a.file.created_at, &a.file.id).cmp(&(b.file.created_at, &b.file.id)));
        v
    }

    pub fn len(&self) -> usize {
        self.read().conns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Stores a new connection (on disk first, then in memory).
    pub fn insert(&self, file: ConnFile) -> std::io::Result<Arc<Conn>> {
        let conn = Conn::load(file).ok_or_else(|| std::io::Error::other("seed does not match the userId"))?;
        let mut inner = self.lock();
        self.write(&conn.file)?;
        let conn = Arc::new(conn);
        inner.add(conn.clone());
        Ok(conn)
    }

    /// Changes a stored connection; `None` when there is no such connection.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut ConnFile)) -> std::io::Result<Option<Arc<Conn>>> {
        let mut inner = self.lock();
        let Some(old) = inner.conns.get(id).cloned() else {
            return Ok(None);
        };
        let mut file = old.file.clone();
        change(&mut file);
        // The identity of a connection never changes.
        file.id = old.file.id.clone();
        file.user_id = old.file.user_id;
        file.seed = old.file.seed.clone();
        self.write(&file)?;
        let conn = Arc::new(Conn {
            file,
            keys: old.keys.clone(),
        });
        inner.forget(id);
        inner.add(conn.clone());
        Ok(Some(conn))
    }

    /// Removes a connection: its token stops working at once.
    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        let mut inner = self.lock();
        if !inner.conns.contains_key(id) {
            return Ok(false);
        }
        match std::fs::remove_file(self.path(id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        inner.forget(id);
        Ok(true)
    }

    /// The `seq` the next event of this connection's device takes in a chat.
    pub fn peek_seq(&self, id: &str, chat: &ChatId) -> Option<u64> {
        let conn = self.get(id)?;
        Some(conn.file.seq.get(&chat.to_string()).copied().unwrap_or(1))
    }

    /// Records that `used` was taken by a stored event. Written after the
    /// event: a refused event leaves no hole in the numbering (clients report
    /// holes as lost events), and a crash in between repeats a number, which
    /// they ignore.
    pub fn commit_seq(&self, id: &str, chat: &ChatId, used: u64) -> std::io::Result<()> {
        let key = chat.to_string();
        self.update(id, |f| {
            let next = f.seq.entry(key).or_insert(1);
            *next = (*next).max(used + 1);
        })?;
        Ok(())
    }
}

impl Inner {
    fn add(&mut self, conn: Arc<Conn>) {
        if let Some(h) = parse_hash(&conn.file.token_hash) {
            self.by_token.insert(h, conn.file.id.clone());
        }
        self.conns.insert(conn.file.id.clone(), conn);
    }

    fn forget(&mut self, id: &str) {
        if let Some(old) = self.conns.remove(id)
            && let Some(h) = parse_hash(&old.file.token_hash)
        {
            self.by_token.remove(&h);
        }
    }
}
