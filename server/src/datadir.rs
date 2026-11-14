//! The data folder (docs/PLAN-v2.md, section 6): layout, format version,
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
pub const FORMAT_VERSION: u32 = 1;

pub const LOCK_FILE: &str = "fcd.lock";
pub const SERVER_FILE: &str = "server.json";
pub const VAPID_FILE: &str = "vapid.json";
pub const CONFIG_FILE: &str = "config.toml";
/// Directories created now for the layout of section 6; filled from M1 on.
pub const DIRS: [&str; 6] = ["users", "invites", "chats", "log", "blobs", "tmp"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFile {
    pub format_version: u32,
    pub server_id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    /// SHA-256 (hex) of the normalised one-time administrator code.
    pub admin_code_hash: String,
    /// `userId`s of administrators (empty until M1).
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
                "папка данных {} уже используется другим процессом fcd; остановите его или укажите другую папку",
                p.display()
            ),
            Self::TooNew { found, supported } => write!(
                f,
                "папка данных создана более новой версией fcd (формат {found}, эта версия понимает до {supported}); \
                 обновите fcd"
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
        fs::create_dir_all(path).map_err(|e| io_err("не удалось создать папку данных", path, e))?;
        let path = path
            .canonicalize()
            .map_err(|e| io_err("не удалось открыть папку данных", path, e))?;
        let lock = acquire_lock(&path)?;

        let server_path = path.join(SERVER_FILE);
        let existing = match fs::read(&server_path) {
            Ok(bytes) => Some(parse_server_file(&server_path, &bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err("не удалось прочитать", &server_path, e)),
        };

        for d in DIRS {
            let p = path.join(d);
            fs::create_dir_all(&p).map_err(|e| io_err("не удалось создать", &p, e))?;
        }

        let config_path = path.join(CONFIG_FILE);
        let file_cfg = config::read_config_file(&config_path).map_err(OpenError::Config)?;
        let config_exists = config_path.exists();
        let settings = Settings::resolve(flags.or(file_cfg)).map_err(OpenError::Config)?;
        if !config_exists {
            write_atomic(
                &path,
                &config_path,
                config::config_template(&settings).as_bytes(),
                false,
            )?;
        }

        let vapid_path = path.join(VAPID_FILE);
        let vapid = match fs::read(&vapid_path) {
            Ok(bytes) => {
                let f: VapidFile = serde_json::from_slice(&bytes)
                    .map_err(|e| OpenError::Io(format!("повреждён {}: {e}", vapid_path.display())))?;
                VapidKey::from_file(&f)
                    .map_err(|e| OpenError::Io(format!("повреждён {}: {e}", vapid_path.display())))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if existing.is_some() {
                    tracing::warn!("{VAPID_FILE} not found, generating new keys; old push subscriptions stop working");
                }
                let k = VapidKey::generate();
                let json = serde_json::to_vec_pretty(&k.to_file()).expect("serialisable");
                write_atomic(&path, &vapid_path, &json, true)?;
                k
            }
            Err(e) => return Err(io_err("не удалось прочитать", &vapid_path, e)),
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

    pub fn check_admin_code(&self, candidate: &str) -> bool {
        check_admin_code(&self.server.admin_code_hash, candidate)
    }
}

fn acquire_lock(dir: &Path) -> Result<File, OpenError> {
    let p = dir.join(LOCK_FILE);
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&p)
        .map_err(|e| io_err("не удалось открыть", &p, e))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(TryLockError::WouldBlock) => Err(OpenError::Locked(dir.to_path_buf())),
        Err(TryLockError::Error(e)) => Err(io_err("не удалось заблокировать", &p, e)),
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
    let v: VersionOnly =
        serde_json::from_slice(bytes).map_err(|e| OpenError::Io(format!("повреждён {}: {e}", path.display())))?;
    if v.format_version > FORMAT_VERSION {
        return Err(OpenError::TooNew {
            found: v.format_version,
            supported: FORMAT_VERSION,
        });
    }
    serde_json::from_slice(bytes).map_err(|e| OpenError::Io(format!("повреждён {}: {e}", path.display())))
}

fn write_server_file(dir: &Path, s: &ServerFile) -> Result<(), OpenError> {
    let json = serde_json::to_vec_pretty(s).expect("serialisable");
    write_atomic(dir, &dir.join(SERVER_FILE), &json, true)
}

/// Writes through `tmp/` and renames, so a crash never leaves half a file.
/// `private`: permissions 0600 on Unix.
pub fn write_atomic(dir: &Path, target: &Path, bytes: &[u8], private: bool) -> Result<(), OpenError> {
    let tmp_dir = dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| io_err("не удалось создать", &tmp_dir, e))?;
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = tmp_dir.join(format!("{name}.{}", hex(&random_bytes::<6>())));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err("не удалось записать", target, e));
    }
    Ok(())
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

pub fn check_admin_code(stored_hash: &str, candidate: &str) -> bool {
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
