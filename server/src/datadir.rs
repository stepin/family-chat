//! The data folder: layout, format version,
//! single-process lock, first-start initialisation.

use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::config::{self, Overrides, Settings};
use crate::webpush::{VapidFile, VapidKey, random_bytes};

/// Version of the data folder format. Bumped on incompatible changes; a
/// server refuses to start on a folder with a newer version.
pub const FORMAT_VERSION: u32 = 2;

pub const LOCK_FILE: &str = "fcd.lock";
pub const SERVER_FILE: &str = "server.json";
pub const VAPID_FILE: &str = "vapid.json";
pub const CONFIG_FILE: &str = "config.toml";
/// Folder of the extra families: `families/<familyId>/`.
pub const FAMILIES_DIR: &str = "families";
/// How long a setup code of a new family works.
pub const SETUP_CODE_TTL_MS: u64 = 3600 * 1000;
/// Directories of the data folder layout.
pub const DIRS: [&str; 7] = ["users", "invites", "chats", "log", "blobs", "packs", "tmp"];

fn is_zero(v: &u64) -> bool {
    *v == 0
}

/// `server.json` of a family (the root one or one in `families/<id>/`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub format_version: u32,
    pub server_id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    /// The family's one-time join code (setup or recovery): SHA-256 (hex)
    /// of the normalised code; empty when there is none. The name on disk is
    /// unchanged from 0.1.0, so an older fcd still reads the folder.
    #[serde(rename = "adminCodeHash", default)]
    pub join_code_hash: String,
    /// When the join code stops working (ms); 0: no expiry.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub join_code_expires_at: u64,
    /// Root only: the reusable server code that creates families. Empty
    /// until `fcd reset-admin-code` on a folder made by 0.1.0.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server_code_hash: String,
    /// `userId`s of administrators.
    #[serde(default)]
    pub admins: Vec<String>,
    /// The first administrator is fully written. Missing in folders made
    /// by 0.1.0: then "has an administrator".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_done: Option<bool>,
    /// Name of an extra family (the root one's is `family_name` in config.toml).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_name: Option<String>,
    /// `Idempotency-Key` of the request that created this family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_key: Option<String>,
    /// What that request asked for (the name), to refuse a replay with another one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_fingerprint: Option<String>,
}

impl ServerFile {
    pub fn is_set_up(&self) -> bool {
        self.setup_done.unwrap_or(!self.admins.is_empty())
    }

    /// The join code works now.
    pub fn join_code_active(&self, now: u64) -> bool {
        !self.join_code_hash.is_empty() && (self.join_code_expires_at == 0 || now < self.join_code_expires_at)
    }

    /// Checks a join code (constant time), counting the expiry.
    pub fn check_join_code(&self, candidate: &str, now: u64) -> bool {
        self.join_code_active(now) && check_admin_code(&self.join_code_hash, candidate)
    }

    /// A new join code that works `ttl_ms` (0: until used).
    pub fn new_join_code(&mut self, now: u64, ttl_ms: u64) -> String {
        let code = generate_admin_code();
        self.join_code_hash = hash_admin_code(&code);
        self.join_code_expires_at = if ttl_ms == 0 { 0 } else { now + ttl_ms };
        code
    }
}

#[derive(Debug)]
pub enum OpenError {
    Locked(PathBuf),
    /// `--data` points inside `families/` of another data folder.
    InsideFamilies {
        root: PathBuf,
        id: String,
    },
    TooNew {
        found: u32,
        supported: u32,
    },
    Config(String),
    Io(String),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Locked(p) => write!(
                f,
                "{}",
                tr!(
                    "папка данных {} уже используется другим процессом fcd; остановите его или укажите другую папку",
                    "the data folder {} is already in use by another fcd process; stop it or use another folder",
                    p.display()
                )
            ),
            Self::InsideFamilies { root, id } => write!(
                f,
                "{}",
                tr!(
                    "это папка семьи внутри папки данных {}; её открывает только fcd этой папки: \
                     используйте --data {} --family {id}",
                    "this is a family folder inside the data folder {}; only that folder's fcd opens it: \
                     use --data {} --family {id}",
                    root.display(),
                    root.display()
                )
            ),
            Self::TooNew { found, supported } => write!(
                f,
                "{}",
                tr!(
                    "папка данных создана более новой версией fcd (формат {found}, эта версия понимает до {supported}); \
                     обновите fcd",
                    "the data folder was created by a newer fcd (format {found}, this version understands up to {supported}); \
                     update fcd"
                )
            ),
            Self::Config(m) => f.write_str(m),
            Self::Io(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for OpenError {}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> OpenError {
    OpenError::Io(format!("{what} {}: {e}", path.display()))
}

/// An opened data folder (the root one holds the lock until dropped) or
/// the folder of an extra family inside it (no lock of its own).
pub struct DataDir {
    pub path: PathBuf,
    pub server: ServerFile,
    pub vapid: VapidKey,
    /// Set only when this start created the folder: the server code to print once.
    pub new_admin_code: Option<String>,
    _lock: Option<File>,
}

/// Is `path` a family folder inside another data folder (`<root>/families/<id>`)?
fn inside_families(path: &Path) -> Option<(PathBuf, String)> {
    let parent = path.parent()?;
    if parent.file_name()? != FAMILIES_DIR {
        return None;
    }
    let root = parent.parent()?;
    let id = path.file_name()?.to_string_lossy().into_owned();
    root.join(SERVER_FILE).is_file().then(|| (root.to_path_buf(), id))
}

/// A family id: 16 characters of lowercase RFC 4648 base32 (80 bits).
pub fn valid_family_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// A new family id.
pub fn new_family_id() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let bytes = random_bytes::<10>();
    let mut acc: u128 = 0;
    for b in bytes {
        acc = (acc << 8) | b as u128;
    }
    (0..16)
        .map(|i| ALPHABET[((acc >> (75 - 5 * i)) & 31) as usize] as char)
        .collect()
}

impl DataDir {
    /// Opens (creating on first start) the data folder and resolves the
    /// settings: `flags` override `config.toml`, which overrides defaults.
    pub fn open(path: &Path, flags: Overrides) -> Result<(DataDir, Settings), OpenError> {
        let created = !path.exists();
        create_private_dir(path).map_err(|e| {
            io_err(
                crate::lang::l("не удалось создать папку данных", "could not create the data folder"),
                path,
                e,
            )
        })?;
        let path = path.canonicalize().map_err(|e| {
            io_err(
                crate::lang::l("не удалось открыть папку данных", "could not open the data folder"),
                path,
                e,
            )
        })?;
        if created {
            restrict(&path, true);
        }
        if let Some((root, id)) = inside_families(&path) {
            return Err(OpenError::InsideFamilies { root, id });
        }
        let lock = acquire_lock(&path)?;

        let server_path = path.join(SERVER_FILE);
        let existing = match fs::read(&server_path) {
            Ok(bytes) => Some(parse_server_file(&server_path, &bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(io_err(
                    crate::lang::l("не удалось прочитать", "could not read"),
                    &server_path,
                    e,
                ));
            }
        };

        for d in DIRS {
            let p = path.join(d);
            create_private_dir(&p)
                .map_err(|e| io_err(crate::lang::l("не удалось создать", "could not create"), &p, e))?;
            // An existing folder may have looser permissions.
            restrict(&p, true);
        }
        let leftovers = fs::read_dir(path.join("tmp"))
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("family-"))
                    .count()
            })
            .unwrap_or(0);
        if leftovers > 0 {
            tracing::warn!(
                "{}",
                tr!(
                    "удалены остатки незавершённого создания семьи в tmp/: {leftovers}",
                    "removed leftovers of an unfinished family creation in tmp/: {leftovers}"
                )
            );
        }
        clean_tmp(&path.join("tmp"));
        create_private_dir(&path.join(FAMILIES_DIR)).map_err(|e| {
            io_err(
                crate::lang::l("не удалось создать", "could not create"),
                &path.join(FAMILIES_DIR),
                e,
            )
        })?;
        for f in [LOCK_FILE, CONFIG_FILE, SERVER_FILE, VAPID_FILE] {
            let p = path.join(f);
            if p.exists() {
                restrict(&p, false);
            }
        }

        let config_path = path.join(CONFIG_FILE);
        let file_cfg = config::read_config_file(&config_path).map_err(OpenError::Config)?;
        let config_exists = config_path.exists();
        let settings = Settings::resolve(flags.or(file_cfg)).map_err(OpenError::Config)?;
        if !config_exists {
            write_atomic(&path, &config_path, config::config_template(&settings).as_bytes())?;
        }

        let vapid_path = path.join(VAPID_FILE);
        let vapid = match fs::read(&vapid_path) {
            Ok(bytes) => {
                let f: VapidFile = serde_json::from_slice(&bytes)
                    .map_err(|e| OpenError::Io(tr!("повреждён {}: {e}", "{} is damaged: {e}", vapid_path.display())))?;
                VapidKey::from_file(&f)
                    .map_err(|e| OpenError::Io(tr!("повреждён {}: {e}", "{} is damaged: {e}", vapid_path.display())))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if existing.is_some() {
                    tracing::warn!("{VAPID_FILE} not found, generating new keys; old push subscriptions stop working");
                }
                let k = VapidKey::generate();
                let json = serde_json::to_vec_pretty(&k.to_file()).expect("serialisable");
                write_atomic(&path, &vapid_path, &json)?;
                k
            }
            Err(e) => {
                return Err(io_err(
                    crate::lang::l("не удалось прочитать", "could not read"),
                    &vapid_path,
                    e,
                ));
            }
        };

        let (server, new_admin_code) = match existing {
            Some(s) => (s, None),
            None => {
                // The server code (reusable, creates families); the root family
                // gets its setup code through `POST /v1/families` like any other.
                let code = generate_admin_code();
                let s = ServerFile {
                    format_version: FORMAT_VERSION,
                    server_id: B64.encode(random_bytes::<16>()),
                    created_at: now_ms(),
                    server_code_hash: hash_admin_code(&code),
                    setup_done: Some(false),
                    ..Default::default()
                };
                // Written last: a start interrupted before this point is
                // simply a first start again.
                write_server_file(&path, &s)?;
                (s, Some(code))
            }
        };

        Ok((
            DataDir {
                path,
                server,
                vapid,
                new_admin_code,
                _lock: Some(lock),
            },
            settings,
        ))
    }

    /// Opens an existing extra family `families/<id>/` of the root folder
    /// `root` (already opened and locked). Never creates `server.json`: a
    /// family without one is broken, not new. `vapid` is the root's key.
    pub fn open_family(root: &Path, id: &str, vapid: VapidKey) -> Result<DataDir, OpenError> {
        let path = root.join(FAMILIES_DIR).join(id);
        if !path.is_dir() {
            return Err(OpenError::Io(tr!(
                "нет папки семьи {}",
                "no family folder {}",
                path.display()
            )));
        }
        let server_path = path.join(SERVER_FILE);
        let bytes = fs::read(&server_path).map_err(|e| {
            io_err(
                crate::lang::l("не удалось прочитать", "could not read"),
                &server_path,
                e,
            )
        })?;
        let server = parse_server_file(&server_path, &bytes)?;
        if server.family_name.as_deref().is_none_or(|n| n.trim().is_empty()) {
            return Err(OpenError::Io(tr!(
                "в {} нет имени семьи (familyName)",
                "{} has no family name (familyName)",
                server_path.display()
            )));
        }
        for d in DIRS {
            let p = path.join(d);
            create_private_dir(&p)
                .map_err(|e| io_err(crate::lang::l("не удалось создать", "could not create"), &p, e))?;
        }
        clean_tmp(&path.join("tmp"));
        Ok(DataDir {
            path,
            server,
            vapid,
            new_admin_code: None,
            _lock: None,
        })
    }

    /// Replaces the server code (creates families) and returns the new one.
    pub fn reset_admin_code(&mut self) -> Result<String, OpenError> {
        let code = generate_admin_code();
        self.server.server_code_hash = hash_admin_code(&code);
        write_server_file(&self.path, &self.server)?;
        Ok(code)
    }

    /// A recovery code of this family: one-time, makes whoever joins with
    /// it an administrator (an existing member is promoted).
    pub fn reset_join_code(&mut self) -> Result<String, OpenError> {
        let code = self.server.new_join_code(now_ms(), 0);
        write_server_file(&self.path, &self.server)?;
        Ok(code)
    }

    /// Adds an administrator (`fcd admin add`, server stopped).
    pub fn add_admin(&mut self, user: &str) -> Result<bool, OpenError> {
        if crate::ids::UserId::parse(user).is_none() {
            return Err(OpenError::Config(tr!(
                "{user} не похож на userId (26 символов base32)",
                "{user} does not look like a userId (26 base32 characters)"
            )));
        }
        if !self.path.join("users").join(user).join("identity.json").is_file() {
            return Err(OpenError::Config(tr!(
                "участник {user} не найден",
                "member {user} not found"
            )));
        }
        if self.server.admins.iter().any(|a| a == user) {
            return Ok(false);
        }
        self.server.admins.push(user.to_string());
        write_server_file(&self.path, &self.server)?;
        Ok(true)
    }

    /// Checks the server code.
    pub fn check_admin_code(&self, candidate: &str) -> bool {
        check_admin_code(&self.server.server_code_hash, candidate)
    }

    /// Members as stored in `users/` (for `fcd admin list`): userId, the
    /// name from the signed profile, and the flags. Sorted by name.
    pub fn list_members(&self) -> Vec<MemberLine> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(self.path.join("users")) else {
            return out;
        };
        for e in rd.flatten() {
            let dir = e.path();
            let Some(id) = e.file_name().to_str().and_then(crate::ids::UserId::parse) else {
                continue;
            };
            let read = |f: &str| -> Option<crate::envelope::Envelope> {
                serde_json::from_slice(&fs::read(dir.join(f)).ok()?).ok()
            };
            let Some(identity) = read("identity.json").and_then(|env| crate::envelope::verify_identity(&env).ok())
            else {
                continue;
            };
            if identity.user_id != id {
                continue;
            }
            let name = read("profile.json")
                .and_then(|env| crate::envelope::verify_profile(&env, &id, &identity.key).ok())
                .map(|p| p.name);
            let user_id = id.to_string();
            out.push(MemberLine {
                admin: self.server.admins.contains(&user_id),
                removed: dir.join("removed").exists(),
                revoked: dir.join("revoked.json").exists(),
                user_id,
                name,
            });
        }
        out.sort_by(|a, b| (&a.name, &a.user_id).cmp(&(&b.name, &b.user_id)));
        out
    }
}

/// One line of `fcd admin list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberLine {
    pub user_id: String,
    pub name: Option<String>,
    pub admin: bool,
    pub removed: bool,
    pub revoked: bool,
}

fn acquire_lock(dir: &Path) -> Result<File, OpenError> {
    let p = dir.join(LOCK_FILE);
    let f = private_file_options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&p)
        .map_err(|e| io_err(crate::lang::l("не удалось открыть", "could not open"), &p, e))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(TryLockError::WouldBlock) => Err(OpenError::Locked(dir.to_path_buf())),
        Err(TryLockError::Error(e)) => Err(io_err(
            crate::lang::l("не удалось заблокировать", "could not lock"),
            &p,
            e,
        )),
    }
}

fn parse_server_file(path: &Path, bytes: &[u8]) -> Result<ServerFile, OpenError> {
    // Check the version before the rest, so a newer format with other fields
    // still gets the "too new" message.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VersionOnly {
        format_version: u32,
    }
    let v: VersionOnly = serde_json::from_slice(bytes)
        .map_err(|e| OpenError::Io(tr!("повреждён {}: {e}", "{} is damaged: {e}", path.display())))?;
    if v.format_version > FORMAT_VERSION {
        return Err(OpenError::TooNew {
            found: v.format_version,
            supported: FORMAT_VERSION,
        });
    }
    serde_json::from_slice(bytes)
        .map_err(|e| OpenError::Io(tr!("повреждён {}: {e}", "{} is damaged: {e}", path.display())))
}

pub fn write_server_file(dir: &Path, s: &ServerFile) -> Result<(), OpenError> {
    let json = serde_json::to_vec_pretty(s).expect("serialisable");
    write_atomic(dir, &dir.join(SERVER_FILE), &json)
}

/// Writes through `tmp/` and renames, so a crash never leaves half a file.
/// Files are private (0600 on Unix).
pub fn write_atomic(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), OpenError> {
    write_atomic_io(dir, target, bytes)
        .map_err(|e| io_err(crate::lang::l("не удалось записать", "could not write"), target, e))
}

/// [`write_atomic`] with a plain I/O error. `dir` is the data folder.
pub fn write_atomic_io(dir: &Path, target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp_dir = dir.join("tmp");
    create_private_dir(&tmp_dir)?;
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = tmp_dir.join(format!("{name}.{}", hex(&random_bytes::<6>())));
    let result = (|| {
        let mut f = private_file_options().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, target)?;
        sync_dir(target.parent().unwrap_or(dir));
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Options for creating a file readable only by the owner.
pub fn private_file_options() -> OpenOptions {
    #[allow(unused_mut)]
    let mut opts = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts
}

/// Creates a folder (and missing parents) accessible only by the owner.
pub fn create_private_dir(p: &Path) -> std::io::Result<()> {
    #[allow(unused_mut)]
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(p)
}

/// Makes the rename of a file in `dir` durable (Unix; no-op elsewhere).
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Sets 0700 (folders) or 0600 (files); a failure is only a warning
/// (for example a mounted volume owned by someone else).
fn restrict(p: &Path, is_dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if is_dir { 0o700 } else { 0o600 };
        match fs::metadata(p) {
            Ok(m) if m.permissions().mode() & 0o777 == mode => {}
            Ok(_) => {
                if let Err(e) = fs::set_permissions(p, fs::Permissions::from_mode(mode)) {
                    tracing::warn!(
                        "{}",
                        tr!(
                            "не удалось ограничить права на {}: {e}",
                            "could not restrict the permissions of {}: {e}",
                            p.display()
                        )
                    );
                }
            }
            Err(_) => {}
        }
    }
    #[cfg(not(unix))]
    let _ = (p, is_dir);
}

/// Removes leftovers of interrupted writes.
fn clean_tmp(tmp: &Path) {
    if let Ok(rd) = fs::read_dir(tmp) {
        for e in rd.flatten() {
            let p = e.path();
            let _ = if p.is_dir() {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Crockford base32 without I, L, O, U.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 80 random bits as `XXXX-XXXX-XXXX-XXXX`.
pub fn generate_admin_code() -> String {
    let bytes = random_bytes::<10>();
    let mut acc: u128 = 0;
    for b in bytes {
        acc = (acc << 8) | b as u128;
    }
    let mut chars = Vec::with_capacity(19);
    for i in 0..16 {
        if i > 0 && i % 4 == 0 {
            chars.push(b'-');
        }
        let idx = ((acc >> (75 - 5 * i)) & 31) as usize;
        chars.push(CODE_ALPHABET[idx]);
    }
    String::from_utf8(chars).expect("ascii")
}

/// Upper case, separators and spaces removed, look-alike letters mapped.
pub fn normalize_admin_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

pub fn hash_admin_code(code: &str) -> String {
    hex(&Sha256::digest(normalize_admin_code(code).as_bytes()))
}

/// An empty stored hash means the code was used and no longer works.
pub fn check_admin_code(stored_hash: &str, candidate: &str) -> bool {
    if stored_hash.is_empty() {
        return false;
    }
    let h = hash_admin_code(candidate);
    h.as_bytes().ct_eq(stored_hash.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_code_format_and_normalisation() {
        let c = generate_admin_code();
        assert_eq!(c.len(), 19);
        assert!(c.split('-').all(|g| g.len() == 4));
        let h = hash_admin_code(&c);
        assert!(check_admin_code(&h, &c.to_lowercase().replace('-', " ")));
        assert!(!check_admin_code(&h, "0000-0000-0000-0000"));
        assert_ne!(generate_admin_code(), c);
    }
}
