//! HTTPS with the owner's own certificate files (`--tls-cert`, `--tls-key`,
//! PEM), on rustls with the ring provider. Handshakes run in their own
//! tasks with a timeout, so a slow client cannot hold up other connections.

use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Reads the certificate chain and the private key (PEM).
pub fn load_config(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>, String> {
    let cert_pem = std::fs::read(cert)
        .map_err(|e| tr!("не удалось прочитать {}: {e}", "could not read {}: {e}", cert.display()))?;
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&cert_pem)
        .collect::<Result<_, _>>()
        .map_err(|e| {
            tr!(
                "{}: не PEM-сертификат: {e:?}",
                "{}: not a PEM certificate: {e:?}",
                cert.display()
            )
        })?;
    if certs.is_empty() {
        return Err(tr!(
            "в {} нет сертификатов (PEM)",
            "{} has no certificates (PEM)",
            cert.display()
        ));
    }
    let key_pem =
        std::fs::read(key).map_err(|e| tr!("не удалось прочитать {}: {e}", "could not read {}: {e}", key.display()))?;
    let key_der = PrivateKeyDer::from_pem_slice(&key_pem).map_err(|e| {
        tr!(
            "{}: не закрытый ключ в PEM: {e:?}",
            "{}: not a PEM private key: {e:?}",
            key.display()
        )
    })?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS: {e}"))?
        .with_no_client_auth()
        .with_single_cert(certs, key_der)
        .map_err(|e| {
            tr!(
                "сертификат и ключ не подходят друг к другу: {e}",
                "the certificate and the key do not match: {e}"
            )
        })?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

/// A listener that yields connections after a completed TLS handshake.
pub struct TlsListener {
    rx: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    local: SocketAddr,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, cfg: Arc<ServerConfig>) -> io::Result<TlsListener> {
        let local = tcp.local_addr()?;
        let (tx, rx) = mpsc::channel(64);
        let acceptor = TlsAcceptor::from(cfg);
        tokio::spawn(async move {
            loop {
                let (stream, addr) = match tcp.accept().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            "{}",
                            tr!(
                                "не удалось принять соединение: {e}",
                                "could not accept a connection: {e}"
                            )
                        );
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                if tx.is_closed() {
                    return;
                }
                let acceptor = acceptor.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        Ok(Ok(tls)) => {
                            let _ = tx.send((tls, addr)).await;
                        }
                        Ok(Err(e)) => tracing::debug!(
                            "{}",
                            tr!(
                                "TLS с {addr} не установлен: {e}",
                                "TLS with {addr} not established: {e}"
                            )
                        ),
                        Err(_) => tracing::debug!(
                            "{}",
                            tr!(
                                "TLS с {addr}: истекло время рукопожатия",
                                "TLS with {addr}: handshake timed out"
                            )
                        ),
                    }
                });
            }
        });
        Ok(TlsListener { rx, local })
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.rx.recv().await {
            Some(v) => v,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.local)
    }
}
