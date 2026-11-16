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
/// Directories of the data folder layout.
pub const DIRS: [&str; 7] = ["users", "invites", "chats", "log", "blobs", "packs", "tmp"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub format_version: u32,
    pub server_id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    /// SHA-256 (hex) of the normalised one-time administrator code; empty
    /// once the first administrator joined with it.
    pub admin_code_hash: String,
    /// `userId`s of administrators.
    #[serde(default)]
    pub admins: Vec<String>,
}

#[derive(Debug)]
pub enum OpenError {
    Locked(PathBuf),
    TooNew { found: u32, supported: u32 },
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

/// An opened data folder. Holds the lock until dropped.
pub struct DataDir {
    pub path: PathBuf,
    pub server: ServerFile,
    pub vapid: VapidKey,
    /// Set only when this start created the folder: the code to print once.
    pub new_admin_code: Option<String>,
    _lock: File,
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
        clean_tmp(&path.join("tmp"));
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
                let code = generate_admin_code();
                let s = ServerFile {
                    format_version: FORMAT_VERSION,
                    server_id: B64.encode(random_bytes::<16>()),
                    created_at: now_ms(),
                    admin_code_hash: hash_admin_code(&code),
                    admins: Vec::new(),
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
                _lock: lock,
            },
            settings,
        ))
    }

    /// Replaces the administrator code and returns the new one.
    pub fn reset_admin_code(&mut self) -> Result<String, OpenError> {
        let code = generate_admin_code();
        self.server.admin_code_hash = hash_admin_code(&code);
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

    pub fn check_admin_code(&self, candidate: &str) -> bool {
        check_admin_code(&self.server.admin_code_hash, candidate)
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
