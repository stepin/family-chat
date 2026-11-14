//! `fcd`: Family Chat server.

pub mod api;
pub mod app;
pub mod assets;
pub mod blobs;
pub mod config;
pub mod datadir;
pub mod envelope;
pub mod error;
pub mod eventlog;
pub mod groups;
pub mod headers;
pub mod healthcheck;
pub mod ids;
pub mod notice;
pub mod packs;
pub mod ratelimit;
pub mod store;
pub mod tls;
pub mod webpush;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio::sync::watch;

use crate::app::AppState;
use crate::assets::Assets;
use crate::config::Overrides;
use crate::datadir::DataDir;

/// Version of this build.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Git commit of this build (12 hex digits), empty when unknown.
pub const GIT_COMMIT: &str = env!("FCD_GIT_COMMIT");

/// `0.1.0 (commit 0123456789ab)`, or `0.1.0` when the commit is unknown.
pub const VERSION_LINE: &str = env!("FCD_VERSION_LINE");

const AFTER_HELP: &str = "\
Settings also live in <DIR>/config.toml (written at first start); flags win over the file.
Only in config.toml: push_subject (contact sent to push services) and min_free_mb
(below this much free disk space new messages are refused, default 100).

Examples:
  fcd --data /srv/family-chat                     first start prints the address and the admin code
  fcd --data /srv/family-chat --port 8080 --listen 127.0.0.1
  fcd --data /srv/family-chat --tls-cert fullchain.pem --tls-key privkey.pem
  fcd reset-admin-code --data /srv/family-chat    (server stopped)
  fcd admin list --data /srv/family-chat          (server stopped)
  fcd healthcheck --data /srv/family-chat         exit code 0 when the server answers

Logging: RUST_LOG=debug for more detail, NO_COLOR=1 for plain output.";

#[derive(Debug, Parser)]
#[command(
    name = "fcd",
    version = VERSION_LINE,
    about = "Family Chat server: end-to-end encrypted family chat with the web client built in",
    long_about = "Family Chat server: end-to-end encrypted family chat with the web client built in.\n\n\
                  Serves the web app and the API on one port, keeps only encrypted data in the data \
                  folder, at most --retention-days days, and sends Web Push notifications.",
    after_help = AFTER_HELP
)]
pub struct Cli {
    /// Data folder: created on first start, holds everything the server keeps.
    #[arg(long, global = true, value_name = "DIR")]
    pub data: Option<PathBuf>,
    /// TCP port for HTTP (or HTTPS with --tls-cert) [default: 8787].
    #[arg(long, global = true)]
    pub port: Option<u16>,
    /// IP address to listen on; 127.0.0.1 behind a reverse proxy on the same machine [default: 0.0.0.0].
    #[arg(long, global = true, value_name = "IP")]
    pub listen: Option<String>,
    /// Family name shown to members [default: Семья].
    #[arg(long)]
    pub family_name: Option<String>,
    /// How long the server keeps messages and files, days, 7-90 [default: 90].
    #[arg(long, value_name = "DAYS")]
    pub retention_days: Option<u32>,
    /// Size limit of one file (attachment), MB [default: 200].
    #[arg(long, value_name = "MB")]
    pub max_file_mb: Option<u64>,
    /// Web Push notifications; false: the server never contacts any outside address [default: true].
    #[arg(long, value_name = "BOOL")]
    pub push: Option<bool>,
    /// Take the client address for rate limiting from X-Forwarded-For; only behind a reverse proxy that sets it [default: false].
    #[arg(long, value_name = "BOOL")]
    pub trust_forwarded_for: Option<bool>,
    /// Enable the setup check endpoints used by the /server/ page (long request, test push; admin code required).
    #[arg(long)]
    pub m0: bool,
    /// Serve the web client from this folder instead of the built-in copy (development).
    #[arg(long, value_name = "DIR")]
    pub web_dir: Option<PathBuf>,
    /// Serve HTTPS with this certificate chain (PEM, server certificate first); needs --tls-key.
    #[arg(long, value_name = "PEM", requires = "tls_key")]
    pub tls_cert: Option<PathBuf>,
    /// Private key for --tls-cert (PEM: PKCS#8, PKCS#1 or SEC1).
    #[arg(long, value_name = "PEM", requires = "tls_cert")]
    pub tls_key: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Replace the administrator code and print the new one (stop the server first).
    ResetAdminCode,
    /// Manage administrators (stop the server first).
    #[command(subcommand)]
    Admin(AdminCommand),
    /// Check that the server on this machine answers; exit code 0 if it does, 1 if not.
    /// Reads the port from --port or <DIR>/config.toml; works while the server runs.
    Healthcheck,
}

#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    /// List members with their userId, name and role.
    List,
    /// Make a member an administrator (userId from `fcd admin list`).
    Add {
        /// The member's userId (26 characters).
        user_id: String,
    },
}

impl Cli {
    fn overrides(&self) -> Overrides {
        Overrides {
            port: self.port,
            listen: self.listen.clone(),
            family_name: self.family_name.clone(),
            retention_days: self.retention_days,
            max_file_mb: self.max_file_mb,
            push: self.push,
            push_subject: None,
            min_free_mb: None,
            trust_forwarded_for: self.trust_forwarded_for,
        }
    }
}

pub fn init_tracing() {
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::prelude::*;
    let filter: Targets = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| Targets::new().with_default(tracing::Level::INFO));
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_target(false).with_ansi(
                std::io::IsTerminal::is_terminal(&std::io::stdout()) && std::env::var_os("NO_COLOR").is_none(),
            ),
        )
        .with(filter)
        .init();
}

/// Entry point used by `main`. Returns the process exit code.
pub async fn main_with(cli: Cli) -> i32 {
    if let Some(Command::Healthcheck) = cli.command {
        let addr = match healthcheck::target(cli.data.as_deref(), &cli.overrides()) {
            Ok(a) => a,
            Err(e) => {
                eprintln!("ошибка: {e}");
                return 1;
            }
        };
        return match healthcheck::check(addr).await {
            Ok(version) => {
                println!("fcd {version} отвечает на {addr}");
                0
            }
            Err(e) => {
                eprintln!("ошибка: {e}");
                1
            }
        };
    }

    let Some(data) = cli.data.clone() else {
        eprintln!("ошибка: укажите папку данных: fcd --data <DIR>");
        return 2;
    };

    if let Some(Command::Admin(AdminCommand::List)) = &cli.command {
        return match DataDir::open(&data, Overrides::default()) {
            Ok((dir, _)) => {
                let members = dir.list_members();
                if members.is_empty() {
                    println!("участников пока нет");
                }
                for m in members {
                    let mut flags = Vec::new();
                    if m.admin {
                        flags.push("администратор");
                    }
                    if m.removed {
                        flags.push("отключён");
                    }
                    if m.revoked {
                        flags.push("ключ отозван");
                    }
                    let name = m.name.as_deref().unwrap_or("(без имени)");
                    if flags.is_empty() {
                        println!("{}  {name}", m.user_id);
                    } else {
                        println!("{}  {name}  [{}]", m.user_id, flags.join(", "));
                    }
                }
                0
            }
            Err(e) => {
                eprintln!("ошибка: {e}");
                1
            }
        };
    }

    if let Some(Command::Admin(AdminCommand::Add { user_id })) = &cli.command {
        return match DataDir::open(&data, Overrides::default()).and_then(|(mut dir, _)| dir.add_admin(user_id)) {
            Ok(true) => {
                println!("{user_id} теперь администратор");
                0
            }
            Ok(false) => {
                println!("{user_id} уже администратор");
                0
            }
            Err(e) => {
                eprintln!("ошибка: {e}");
                1
            }
        };
    }

    if let Some(Command::ResetAdminCode) = cli.command {
        return match DataDir::open(&data, Overrides::default()) {
            Ok((mut dir, _)) => match dir.reset_admin_code() {
                Ok(code) => {
                    println!("Новый код администратора: {code}");
                    0
                }
                Err(e) => {
                    eprintln!("ошибка: {e}");
                    1
                }
            },
            Err(e) => {
                eprintln!("ошибка: {e}");
                1
            }
        };
    }

    let (dir, settings) = match DataDir::open(&data, cli.overrides()) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("{e}");
            return 1;
        }
    };

    let assets = match &cli.web_dir {
        Some(p) if !p.join("index.html").is_file() => {
            tracing::error!("в --web-dir {} нет index.html", p.display());
            return 1;
        }
        Some(p) => Assets::Dir(p.clone()),
        None => Assets::Embedded,
    };

    let tls = match (&cli.tls_cert, &cli.tls_key) {
        (Some(c), Some(k)) => match tls::load_config(c, k) {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                tracing::error!("{e}");
                return 1;
            }
        },
        _ => None,
    };

    let listener = match tokio::net::TcpListener::bind(settings.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("не удалось занять адрес {}: {e}", settings.listen);
            return 1;
        }
    };
    let local = listener.local_addr().unwrap_or(settings.listen);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let state = match AppState::new(&dir, settings.clone(), assets, cli.m0, shutdown_rx) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("{e}");
            return 1;
        }
    };
    app::spawn_maintenance(state.clone());

    tracing::info!("fcd {}, папка данных {}", VERSION_LINE, dir.path.display());
    tracing::info!(
        "семья «{}», срок хранения {} дн., предел файла {} МБ, push {}",
        settings.family_name,
        settings.retention_days,
        settings.max_file_mb,
        if settings.push {
            "включён"
        } else {
            "выключен"
        }
    );
    if let Some(p) = &cli.web_dir {
        tracing::info!("клиент отдаётся из папки {}", p.display());
    }
    if cli.m0 {
        tracing::info!("включены проверочные точки M0 (--m0)");
    }
    let (members, events) = state
        .store
        .read(|m| (m.users.values().filter(|u| u.removed_at.is_none()).count(), m.log.len()));
    tracing::info!("участников {members}, событий в журнале {events}");
    let scheme = if tls.is_some() { "https" } else { "http" };
    tracing::info!("слушаю {local} ({})", scheme.to_uppercase());
    for url in browse_urls(scheme, local) {
        tracing::info!("откройте {url}");
    }
    if tls.is_none() {
        tracing::info!(
            "приложению нужен HTTPS (без него работает только http://localhost на этом компьютере): \
             обратный прокси (Caddy, nginx, роутер, NAS) или --tls-cert и --tls-key"
        );
    }
    if let Some(code) = &dir.new_admin_code {
        // The only time the code is logged (docs/PLAN-v2.md, section 5).
        tracing::info!("первый запуск: папка данных создана");
        tracing::info!("код администратора: {code}");
        tracing::info!("дальше: откройте приложение, нажмите «Настроить для своей семьи» и введите этот код");
        tracing::info!("код показывается один раз; новый: fcd reset-admin-code --data <DIR> при остановленном сервере");
    }

    let app = app::router(state);
    let result = match tls {
        Some(cfg) => match tls::TlsListener::new(listener, cfg) {
            // `tap_io` gives the listener axum's `ConnectInfo<SocketAddr>`.
            Ok(l) => run(axum::serve::ListenerExt::tap_io(l, |_| {}), app, shutdown_tx).await,
            Err(e) => Err(e),
        },
        None => run(listener, app, shutdown_tx).await,
    };
    drop(dir);
    match result {
        Ok(()) => {
            tracing::info!("остановлен");
            0
        }
        Err(e) => {
            tracing::error!("ошибка сервера: {e}");
            1
        }
    }
}

/// Serves until a shutdown signal, then waits for open requests at most
/// [`SHUTDOWN_GRACE`].
async fn run<L>(listener: L, app: axum::Router, shutdown_tx: watch::Sender<bool>) -> std::io::Result<()>
where
    L: axum::serve::Listener<Addr = SocketAddr>,
    SocketAddr: for<'a> axum::extract::connect_info::Connected<axum::serve::IncomingStream<'a, L>>,
{
    let mut stopping = shutdown_tx.subscribe();
    let server = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(
        async move {
            shutdown_signal().await;
            tracing::info!("получен сигнал завершения, останавливаюсь");
            let _ = shutdown_tx.send(true);
        },
    );
    tokio::select! {
        r = std::future::IntoFuture::into_future(server) => r,
        _ = async {
            let _ = stopping.wait_for(|v| *v).await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => {
            tracing::warn!("соединения не закрылись за {} с, завершаюсь", SHUTDOWN_GRACE.as_secs());
            Ok(())
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    // Windows: closing the console window, logging off or shutting down.
    #[cfg(windows)]
    let term = async {
        use tokio::signal::windows;
        match (windows::ctrl_close(), windows::ctrl_shutdown(), windows::ctrl_logoff()) {
            (Ok(mut close), Ok(mut shutdown), Ok(mut logoff)) => {
                tokio::select! {
                    _ = close.recv() => {}
                    _ = shutdown.recv() => {}
                    _ = logoff.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(any(unix, windows)))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

/// Addresses to print for the owner: the app and the check page `/server/`.
/// For `0.0.0.0` the LAN address is found with a connected UDP socket (no
/// packet is sent).
fn browse_urls(scheme: &str, local: SocketAddr) -> Vec<String> {
    let port = local.port();
    let base = if local.ip().is_unspecified() {
        lan_ip().map_or_else(
            || format!("localhost:{port}"),
            |ip| SocketAddr::new(ip, port).to_string(),
        )
    } else {
        local.to_string()
    };
    vec![
        format!("{scheme}://{base}/ (приложение)"),
        format!("{scheme}://{base}/server/ (проверка сервера)"),
    ]
}

fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Graceful shutdown waits for open requests; long requests end on the
/// shutdown signal, and nothing is allowed to keep the process longer than this.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
