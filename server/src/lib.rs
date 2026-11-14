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
pub mod ids;
pub mod notice;
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

#[derive(Debug, Parser)]
#[command(name = "fcd", version, about = "Family Chat server")]
pub struct Cli {
    /// Data folder (created on first start).
    #[arg(long, global = true, value_name = "DIR")]
    pub data: Option<PathBuf>,
    /// HTTP port [default: 8787].
    #[arg(long)]
    pub port: Option<u16>,
    /// Listen address [default: 0.0.0.0].
    #[arg(long, value_name = "IP")]
    pub listen: Option<String>,
    /// Family name shown to members.
    #[arg(long)]
    pub family_name: Option<String>,
    /// Retention on the server, days, 7-90 [default: 90].
    #[arg(long, value_name = "DAYS")]
    pub retention_days: Option<u32>,
    /// File size limit, MB [default: 200].
    #[arg(long, value_name = "MB")]
    pub max_file_mb: Option<u64>,
    /// Web Push on or off [default: true].
    #[arg(long, value_name = "BOOL")]
    pub push: Option<bool>,
    /// Trust `X-Forwarded-For` from a reverse proxy [default: false].
    #[arg(long, value_name = "BOOL")]
    pub trust_forwarded_for: Option<bool>,
    /// Enable the M0 check endpoints (long request, test push).
    #[arg(long)]
    pub m0: bool,
    /// Serve the web client from this folder instead of the embedded copy.
    #[arg(long, value_name = "DIR")]
    pub web_dir: Option<PathBuf>,
    /// Serve HTTPS with this certificate chain (PEM); needs --tls-key.
    #[arg(long, value_name = "PEM", requires = "tls_key")]
    pub tls_cert: Option<PathBuf>,
    /// Private key for --tls-cert (PEM).
    #[arg(long, value_name = "PEM", requires = "tls_cert")]
    pub tls_key: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Replace the administrator code and print the new one (server must be stopped).
    ResetAdminCode,
    /// Administrators (server must be stopped).
    #[command(subcommand)]
    Admin(AdminCommand),
}

#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    /// Make a member an administrator.
    Add {
        /// The member's userId.
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
    let Some(data) = cli.data.clone() else {
        eprintln!("ошибка: укажите папку данных: fcd --data <DIR>");
        return 2;
    };

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

    tracing::info!("fcd {}, папка данных {}", env!("CARGO_PKG_VERSION"), dir.path.display());
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
    if let Some(code) = &dir.new_admin_code {
        // The only time the code is logged (docs/PLAN-v2.md, section 5).
        tracing::info!("первый запуск: папка данных создана");
        tracing::info!("код администратора: {code}");
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
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

/// Addresses to print for the owner. For `0.0.0.0` the LAN address is found
/// with a connected UDP socket (no packet is sent).
fn browse_urls(scheme: &str, local: SocketAddr) -> Vec<String> {
    let port = local.port();
    let mut out = Vec::new();
    if local.ip().is_unspecified() {
        out.push(format!("{scheme}://localhost:{port}/server/"));
        if let Some(ip) = lan_ip() {
            out.push(format!("{scheme}://{ip}:{port}/server/"));
        }
    } else {
        out.push(format!("{scheme}://{local}/server/"));
    }
    out
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
