//! `--tls-cert`/`--tls-key`: the real binary serves HTTPS with a
//! self-signed test certificate (tests/fixtures/tls, CN=localhost,
//! 127.0.0.1, valid until 2126).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;

struct Proc {
    child: Child,
    lines: mpsc::Receiver<String>,
}

impl Proc {
    fn spawn(args: &[&str]) -> Proc {
        let mut child = Command::new(env!("CARGO_BIN_EXE_fcd"))
            .args(args)
            .env("NO_COLOR", "1")
            .env_remove("RUST_LOG")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
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

    fn all_output(&self) -> String {
        self.lines.try_iter().collect::<Vec<_>>().join("\n")
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tls")
        .join(name)
}

#[tokio::test]
async fn serves_https_with_own_certificate() {
    let tmp = tempfile::tempdir().unwrap();
    let cert = fixture("cert.pem");
    let key = fixture("key.pem");
    let p = Proc::spawn(&[
        "--data",
        tmp.path().to_str().unwrap(),
        "--listen",
        "127.0.0.1",
        "--port",
        "0",
        "--tls-cert",
        cert.to_str().unwrap(),
        "--tls-key",
        key.to_str().unwrap(),
    ]);
    let line = p.wait_line("слушаю", Duration::from_secs(20));
    assert!(line.contains("HTTPS"), "{line}");
    let addr = line
        .split_whitespace()
        .find(|w| w.starts_with("127.0.0.1:"))
        .unwrap()
        .to_string();
    let port = addr.rsplit(':').next().unwrap();
    let opened = p.wait_line("откройте", Duration::from_secs(5));
    assert!(opened.contains("https://"), "{opened}");

    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from_pem_file(&cert).unwrap()).unwrap();
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(cfg)
        .https_only()
        .enable_http1()
        .build();
    let client: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build(https);
    for host in ["localhost", "127.0.0.1"] {
        let req = hyper::Request::get(format!("https://{host}:{port}/v1/hello"))
            .body(Full::new(Bytes::new()))
            .unwrap();
        let res = client.request(req).await.expect("HTTPS request");
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["x-content-type-options"], "nosniff");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(j["server"], "fcd");
    }
    let req = hyper::Request::get(format!("https://localhost:{port}/"))
        .body(Full::new(Bytes::new()))
        .unwrap();
    let res = client.request(req).await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(
        res.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );

    // Plain HTTP on the TLS port gets no HTTP answer.
    let plain: Client<_, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let req = hyper::Request::get(format!("http://127.0.0.1:{port}/v1/hello"))
        .body(Full::new(Bytes::new()))
        .unwrap();
    let r = tokio::time::timeout(Duration::from_secs(15), plain.request(req)).await;
    assert!(
        !matches!(r, Ok(Ok(ref res)) if res.status() == 200),
        "plain HTTP must not work"
    );

    // `fcd healthcheck` finds out that the port speaks TLS and still gets the hello.
    let out = tokio::task::spawn_blocking({
        let port = port.to_string();
        move || {
            Command::new(env!("CARGO_BIN_EXE_fcd"))
                .args(["healthcheck", "--listen", "127.0.0.1", "--port", &port])
                .output()
                .unwrap()
        }
    })
    .await
    .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{text}");
    assert!(text.contains("отвечает"), "{text}");
}

#[test]
fn bad_tls_files_stop_the_start() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let cert = fixture("cert.pem");
    // The certificate given as the key.
    let mut p = Proc::spawn(&[
        "--data",
        data.to_str().unwrap(),
        "--listen",
        "127.0.0.1",
        "--port",
        "0",
        "--tls-cert",
        cert.to_str().unwrap(),
        "--tls-key",
        cert.to_str().unwrap(),
    ]);
    assert_eq!(p.wait_exit(Duration::from_secs(20)), 1);
    let out = p.all_output();
    assert!(out.contains("закрытый ключ"), "{out}");

    // One flag without the other is a usage error.
    let mut p = Proc::spawn(&["--data", data.to_str().unwrap(), "--tls-cert", cert.to_str().unwrap()]);
    assert_eq!(p.wait_exit(Duration::from_secs(20)), 2);
}
