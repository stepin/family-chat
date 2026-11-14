//! `fcd healthcheck`: asks the running server for `/v1/hello` on this
//! machine and exits 0 when a fcd answers, 1 otherwise. Made for container
//! health checks (`HEALTHCHECK` in the Dockerfile, `HealthCmd` in a Podman
//! Quadlet), where the image has no shell and no curl.
//!
//! The port comes from the flags, then from `config.toml` in `--data` (read
//! only: the running server holds the folder lock), then the default. Plain
//! HTTP is tried first; if the port speaks TLS (`--tls-cert`), HTTPS is
//! tried without checking the certificate: the request goes to this machine's
//! own loopback address, and the answer is only accepted if it is a fcd hello.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::config::{DEFAULT_LISTEN, DEFAULT_PORT, Overrides, read_config_file};
use crate::datadir::CONFIG_FILE;

pub const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE: usize = 64 * 1024;

/// Where to knock: flags win over `config.toml`. An unspecified listen
/// address (`0.0.0.0`, `::`) becomes the loopback address of the same family.
pub fn target(data: Option<&Path>, flags: &Overrides) -> Result<SocketAddr, String> {
    let file = match data {
        Some(d) => read_config_file(&d.join(CONFIG_FILE))?,
        None => Overrides::default(),
    };
    let o = flags.clone().or(file);
    let ip: IpAddr = o
        .listen
        .as_deref()
        .unwrap_or(DEFAULT_LISTEN)
        .parse()
        .map_err(|_| "адрес прослушивания (listen) должен быть IP-адресом".to_string())?;
    let ip = match ip {
        IpAddr::V4(v) if v.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(v) if v.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        other => other,
    };
    Ok(SocketAddr::new(ip, o.port.unwrap_or(DEFAULT_PORT)))
}

/// Runs the check; `Ok` carries the server version.
pub async fn check(addr: SocketAddr) -> Result<String, String> {
    match tokio::time::timeout(TIMEOUT, plain(addr)).await {
        Ok(Ok(v)) => return Ok(v),
        Ok(Err(Failure::Connect(e))) => return Err(format!("нет соединения с {addr}: {e}")),
        Ok(Err(Failure::Answer(_))) | Err(_) => {}
    }
    match tokio::time::timeout(TIMEOUT, tls(addr)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(Failure::Connect(e) | Failure::Answer(e))) => Err(format!("{addr} не отвечает как fcd: {e}")),
        Err(_) => Err(format!("{addr}: нет ответа за {} с", TIMEOUT.as_secs())),
    }
}

enum Failure {
    Connect(String),
    Answer(String),
}

async fn plain(addr: SocketAddr) -> Result<String, Failure> {
    let stream = TcpStream::connect(addr)
        .await
        .map_err(|e| Failure::Connect(e.to_string()))?;
    ask(stream, addr).await
}

async fn tls(addr: SocketAddr) -> Result<String, Failure> {
    let stream = TcpStream::connect(addr)
        .await
        .map_err(|e| Failure::Connect(e.to_string()))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Failure::Answer(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::IpAddress(addr.ip().into());
    let stream = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(name, stream)
        .await
        .map_err(|e| Failure::Answer(e.to_string()))?;
    ask(stream, addr).await
}

async fn ask<S: AsyncRead + AsyncWrite + Unpin>(mut s: S, addr: SocketAddr) -> Result<String, Failure> {
    let req =
        format!("GET /v1/hello HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: fcd-healthcheck\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| Failure::Answer(e.to_string()))?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_RESPONSE {
                    return Err(Failure::Answer("слишком длинный ответ".into()));
                }
            }
            // A TLS peer may close without close_notify after a complete answer.
            Err(_) if !buf.is_empty() => break,
            Err(e) => return Err(Failure::Answer(e.to_string())),
        }
    }
    parse_hello(&buf).map_err(Failure::Answer)
}

/// Accepts `200` with a JSON body `{"server": "fcd", "version": ...}`.
pub fn parse_hello(raw: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(raw).map_err(|_| "ответ не в UTF-8".to_string())?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or("неполный ответ HTTP")?;
    let status = head.lines().next().unwrap_or("");
    if status.split(' ').nth(1) != Some("200") {
        return Err(format!("ответ «{status}»"));
    }
    let v: serde_json::Value = serde_json::from_str(body.trim()).map_err(|_| "тело ответа не JSON".to_string())?;
    if v["server"] != "fcd" {
        return Err("ответил не fcd".into());
    }
    Ok(v["version"].as_str().unwrap_or("?").to_string())
}

/// Accepts any certificate, but still checks the handshake signatures.
/// Used only for the loopback health check of the server's own port.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_a_fcd_hello() {
        let ok = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"server\":\"fcd\",\"version\":\"1.2.3\"}";
        assert_eq!(parse_hello(ok).unwrap(), "1.2.3");
        assert!(parse_hello(b"HTTP/1.1 404 Not Found\r\n\r\n{}").is_err());
        assert!(parse_hello(b"HTTP/1.1 200 OK\r\n\r\n{\"server\":\"other\"}").is_err());
        assert!(parse_hello(b"HTTP/1.1 200 OK\r\n\r\n<html>").is_err());
        assert!(parse_hello(b"garbage").is_err());
    }

    #[test]
    fn target_prefers_flags_then_config_and_uses_loopback() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            target(Some(tmp.path()), &Overrides::default()).unwrap(),
            "127.0.0.1:8787".parse().unwrap()
        );
        std::fs::write(tmp.path().join(CONFIG_FILE), "port = 9000\nlisten = \"::\"\n").unwrap();
        assert_eq!(
            target(Some(tmp.path()), &Overrides::default()).unwrap(),
            "[::1]:9000".parse().unwrap()
        );
        let flags = Overrides {
            port: Some(9100),
            listen: Some("192.168.1.5".into()),
            ..Default::default()
        };
        assert_eq!(
            target(Some(tmp.path()), &flags).unwrap(),
            "192.168.1.5:9100".parse().unwrap()
        );
        assert_eq!(target(None, &Overrides::default()).unwrap().port(), DEFAULT_PORT);
    }
}
