use std::io::{BufRead, BufReader};
use std::path::Path;
#[cfg(unix)]
use std::process::ExitStatus;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant};

use fcd::config::{Overrides, Settings};
use fcd::datadir::{DIRS, DataDir, FORMAT_VERSION, OpenError};

// On Linux a starting child process holds a copy of every open fd of this
// process between fork and exec, the lock file of a data folder included
// (flock belongs to the open file, not to the fd). A folder closed in that
// moment stays locked until the exec, and the next open sees `Locked`. So in
// this file no data folder is opened or closed while a test starts a process.
static FORK: Mutex<()> = Mutex::new(());

fn fork_lock() -> MutexGuard<'static, ()> {
    FORK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `DataDir::open` under [`FORK`]. A short wait on `Locked` covers what the
/// lock cannot: Linux wakes the parent of a `spawn` a moment before the child
/// closes its close-on-exec fds. For a test that expects `Locked`, call
/// `DataDir::open` itself.
fn open(path: &Path, flags: Overrides) -> Result<(DataDir, Settings), OpenError> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let res = {
            let _g = fork_lock();
            DataDir::open(path, flags.clone())
        };
        match res {
            Err(OpenError::Locked(_)) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            res => return res,
        }
    }
}

fn close(dir: DataDir) {
    let _g = fork_lock();
    drop(dir);
}

/// `spawn`, `output` and `status` that start the process under [`FORK`].
/// `spawn` returns at the exec, when the copies of the fds are (almost) gone.
trait SpawnLocked {
    fn spawn_locked(&mut self) -> std::io::Result<Child>;
    fn output_locked(&mut self) -> std::io::Result<Output>;
    // Only the Unix-only signal checks wait for `kill`.
    #[cfg(unix)]
    fn status_locked(&mut self) -> std::io::Result<ExitStatus>;
}

impl SpawnLocked for Command {
    fn spawn_locked(&mut self) -> std::io::Result<Child> {
        let _g = fork_lock();
        self.spawn()
    }

    fn output_locked(&mut self) -> std::io::Result<Output> {
        self.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        self.spawn_locked()?.wait_with_output()
    }

    #[cfg(unix)]
    fn status_locked(&mut self) -> std::io::Result<ExitStatus> {
        self.spawn_locked()?.wait()
    }
}

#[test]
fn first_start_creates_layout_and_restart_reuses_it() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let (dir, settings) = open(&data, Overrides::default()).unwrap();
    let code = dir.new_admin_code.clone().expect("code on first start");
    let server_id = dir.server.server_id.clone();
    let vapid_pub = dir.vapid.public_key_b64();
    assert_eq!(settings.listen.port(), 8787);
    assert_eq!(settings.retention_days, 90);
    assert_eq!(settings.max_file_mb, 200);
    assert!(settings.push);

    for d in DIRS {
        assert!(data.join(d).is_dir(), "{d}");
    }
    let server: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("server.json")).unwrap()).unwrap();
    assert_eq!(server["formatVersion"], FORMAT_VERSION);
    assert_eq!(server["serverId"], server_id.as_str());
    assert_eq!(server_id.len(), 22, "128 random bits in base64url");
    let server_text = std::fs::read_to_string(data.join("server.json")).unwrap();
    assert!(!server_text.contains(&code), "only the hash is stored");
    assert!(dir.check_admin_code(&code));

    let config = std::fs::read_to_string(data.join("config.toml")).unwrap();
    assert!(config.contains("retention_days = 90"));
    let vapid: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("vapid.json")).unwrap()).unwrap();
    assert_eq!(vapid["publicKey"], vapid_pub.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(data.join("vapid.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert_eq!(
        std::fs::read_dir(data.join("tmp")).unwrap().count(),
        0,
        "no leftovers in tmp/"
    );
    close(dir);

    // Second start: same identity and keys, no new code; config.toml is read.
    std::fs::write(
        data.join("config.toml"),
        config.replace("retention_days = 90", "retention_days = 14"),
    )
    .unwrap();
    let (dir, settings) = open(
        &data,
        Overrides {
            port: Some(9999),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(dir.new_admin_code.is_none());
    assert_eq!(dir.server.server_id, server_id);
    assert_eq!(dir.vapid.public_key_b64(), vapid_pub);
    assert!(dir.check_admin_code(&code));
    assert_eq!(settings.retention_days, 14);
    assert_eq!(settings.listen.port(), 9999, "flags override config.toml");
}

#[test]
fn bad_config_is_reported() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("config.toml"), "retention_days = 120\n").unwrap();
    let err = open(tmp.path(), Overrides::default()).err().unwrap();
    assert!(err.to_string().contains("от 7 до 90"), "{err}");
    std::fs::write(tmp.path().join("config.toml"), "colour = 1\n").unwrap();
    let res = open(tmp.path(), Overrides::default());
    assert!(matches!(res, Err(OpenError::Config(_))), "{:?}", res.err());
}

#[test]
fn refuses_newer_format() {
    let tmp = tempfile::tempdir().unwrap();
    let (dir, _) = open(tmp.path(), Overrides::default()).unwrap();
    close(dir);
    let p = tmp.path().join("server.json");
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["formatVersion"] = (FORMAT_VERSION + 1).into();
    v["somethingNew"] = true.into();
    std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
    match open(tmp.path(), Overrides::default()) {
        Err(OpenError::TooNew { found, supported }) => {
            assert_eq!(found, FORMAT_VERSION + 1);
            assert_eq!(supported, FORMAT_VERSION);
        }
        Err(e) => panic!("unexpected error: {e}"),
        Ok(_) => panic!("must refuse a newer format"),
    }
}

#[test]
fn second_open_is_locked() {
    let tmp = tempfile::tempdir().unwrap();
    let (_dir, _) = open(tmp.path(), Overrides::default()).unwrap();
    assert!(matches!(
        DataDir::open(tmp.path(), Overrides::default()),
        Err(OpenError::Locked(_))
    ));
}

// ---- The real binary ----

struct Proc {
    child: Child,
    lines: mpsc::Receiver<String>,
}

impl Proc {
    fn spawn(args: &[&str]) -> Proc {
        let mut child = Command::new(env!("CARGO_BIN_EXE_fcd"))
            .env_remove("LANG")
            .env_remove("LC_ALL")
            .env_remove("LC_MESSAGES")
            .env_remove("FCD_LANG")
            .args(args)
            .env("NO_COLOR", "1")
            .env_remove("RUST_LOG")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn_locked()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        for stream in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        Proc { child, lines: rx }
    }

    /// Waits for a line containing `needle`; returns it.
    fn wait_line(&self, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(l) if l.contains(needle) => return l,
                Ok(_) => {}
                Err(_) => panic!("no line containing {needle:?}"),
            }
        }
    }

    fn wait_exit(&mut self, timeout: Duration) -> i32 {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code().unwrap_or(-1);
            }
            assert!(Instant::now() < deadline, "process did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Everything the exited process printed: waits until both reader threads
    /// reach the end of their pipe, as the last lines may still be on the way.
    fn all_output(&self) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut lines = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(l) => lines.push(l),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("output did not end: {}", lines.join("\n")),
            }
        }
        lines.join("\n")
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[test]
fn binary_prints_code_once_locks_folder_and_stops_on_sigterm() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    let args = ["--data", data, "--listen", "127.0.0.1", "--port", "0"];

    // Stopping by signal (below) is Unix-only; elsewhere `first` is never mutated.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut first = Proc::spawn(&args);
    let listen_line = first.wait_line("слушаю", Duration::from_secs(20));
    let code_line = first.wait_line("код администратора сервера:", Duration::from_secs(20));
    let code = code_line.rsplit(' ').next().unwrap().to_string();
    assert_eq!(code.len(), 19, "{code_line}");

    let mut second = Proc::spawn(&args);
    assert_eq!(second.wait_exit(Duration::from_secs(10)), 1);
    let out = second.all_output();
    assert!(out.contains("уже используется другим процессом fcd"), "{out}");

    // `fcd healthcheck` against the running server (port from the line it printed).
    let port = listen_line
        .rsplit(':')
        .next()
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    let check = |port: &str| {
        Command::new(env!("CARGO_BIN_EXE_fcd"))
            .env_remove("LANG")
            .env_remove("LC_ALL")
            .env_remove("LC_MESSAGES")
            .env_remove("FCD_LANG")
            .args(["healthcheck", "--data", data, "--listen", "127.0.0.1", "--port", port])
            .output_locked()
            .unwrap()
    };
    let ok = check(&port);
    assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
    assert!(String::from_utf8_lossy(&ok.stdout).contains("отвечает"));

    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-TERM", &first.child.id().to_string()])
            .status_locked()
            .unwrap();
        assert!(status.success());
        assert_eq!(first.wait_exit(Duration::from_secs(10)), 0);
        let out = first.all_output();
        assert!(out.contains("остановлен"), "{out}");
        let down = check(&port);
        assert_eq!(down.status.code(), Some(1), "healthcheck of a stopped server fails");

        // Restart: no code is printed again.
        let mut again = Proc::spawn(&args);
        again.wait_line("слушаю", Duration::from_secs(20));
        let status = Command::new("kill")
            .args(["-INT", &again.child.id().to_string()])
            .status_locked()
            .unwrap();
        assert!(status.success());
        assert_eq!(again.wait_exit(Duration::from_secs(10)), 0);
        let out = again.all_output();
        assert!(!out.contains(&code), "admin code must not be logged again");
        assert!(!out.contains("код администратора:"));
    }
}

#[test]
fn binary_refuses_newer_format() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("server.json"),
        format!(r#"{{"formatVersion": {}, "serverId": "x"}}"#, FORMAT_VERSION + 1),
    )
    .unwrap();
    let mut p = Proc::spawn(&[
        "--data",
        tmp.path().to_str().unwrap(),
        "--listen",
        "127.0.0.1",
        "--port",
        "0",
    ]);
    assert_eq!(p.wait_exit(Duration::from_secs(10)), 1);
    let out = p.all_output();
    assert!(out.contains("более новой версией fcd"), "{out}");
    assert!(
        !tmp.path().join("vapid.json").exists(),
        "nothing written to a newer folder"
    );
}

#[test]
fn reset_admin_code_replaces_the_code() {
    let tmp = tempfile::tempdir().unwrap();
    let (dir, _) = open(tmp.path(), Overrides::default()).unwrap();
    let old = dir.new_admin_code.clone().unwrap();
    close(dir);
    let out = Command::new(env!("CARGO_BIN_EXE_fcd"))
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .env_remove("LC_MESSAGES")
        .env_remove("FCD_LANG")
        .args(["reset-admin-code", "--data", tmp.path().to_str().unwrap()])
        .output_locked()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    let new = text.lines().next().unwrap().trim().rsplit(' ').next().unwrap();
    let (dir, _) = open(tmp.path(), Overrides::default()).unwrap();
    assert!(dir.check_admin_code(new));
    assert!(!dir.check_admin_code(&old));
}
