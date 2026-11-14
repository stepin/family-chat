//! `fcd`: Family Chat server.

pub mod app;
pub mod assets;
pub mod config;
pub mod datadir;
pub mod webpush;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio::sync::watch;

use crate::app::AppState;
use crate::assets::Assets;
use crate::config::Overrides;
use crate::datadir::DataDir;
use crate::webpush::PushClient;

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
    /// Enable the M0 check endpoints (long request, test push).
    #[arg(long)]
    pub m0: bool,
    /// Serve the web client from this folder instead of the embedded copy.
    #[arg(long, value_name = "DIR")]
    pub web_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Replace the administrator code and print the new one (server must be stopped).
    ResetAdminCode,
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

    let listener = match tokio::net::TcpListener::bind(settings.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("не удалось занять адрес {}: {e}", settings.listen);
            return 1;
        }
    };
    let local = listener.local_addr().unwrap_or(settings.listen);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let state = Arc::new(AppState {
        push: settings.push.then(|| PushClient::new(settings.push_subject.clone())),
        settings: settings.clone(),
        server_id: dir.server.server_id.clone(),
        admin_code_hash: dir.server.admin_code_hash.clone(),
        vapid: dir.vapid.clone(),
        m0: cli.m0,
        assets,
        shutdown: shutdown_rx,
    });

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
    tracing::info!("слушаю {local}");
    for url in browse_urls(local) {
        tracing::info!("откройте {url}");
    }
    if let Some(code) = &dir.new_admin_code {
        // The only time the code is logged (docs/PLAN-v2.md, section 5).
        tracing::info!("первый запуск: папка данных создана");
        tracing::info!("код администратора: {code}");
        tracing::info!("код показывается один раз; новый: fcd reset-admin-code --data <DIR> при остановленном сервере");
    }

    let app = app::router(state);
    let mut stopping = shutdown_tx.subscribe();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown_signal().await;
        tracing::info!("получен сигнал завершения, останавливаюсь");
        let _ = shutdown_tx.send(true);
    });
    let result = tokio::select! {
        r = std::future::IntoFuture::into_future(server) => r,
        _ = async {
            let _ = stopping.wait_for(|v| *v).await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => {
            tracing::warn!("соединения не закрылись за {} с, завершаюсь", SHUTDOWN_GRACE.as_secs());
            Ok(())
        }
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
fn browse_urls(local: SocketAddr) -> Vec<String> {
    let port = local.port();
    let mut out = Vec::new();
    if local.ip().is_unspecified() {
        out.push(format!("http://localhost:{port}/server/"));
        if let Some(ip) = lan_ip() {
            out.push(format!("http://{ip}:{port}/server/"));
        }
    } else {
        out.push(format!("http://{local}/server/"));
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
