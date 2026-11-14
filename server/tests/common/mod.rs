#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ed25519_dalek::SigningKey;
use fcd::app::{self, AppState};
use fcd::assets::Assets;
use fcd::config::Overrides;
use fcd::datadir::DataDir;
use fcd::envelope::testkit;
use fcd::envelope::{Envelope, Kind};
use fcd::ids::{ChatId, DevId, MsgId, UserId, b32_encode};
use hkdf::Hkdf;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use p256::{PublicKey, SecretKey};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::watch;

pub struct TestServer {
    pub addr: SocketAddr,
    /// Empty when the folder already existed.
    pub admin_code: String,
    pub dir: DataDir,
    pub shutdown: watch::Sender<bool>,
    pub state: Arc<AppState>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    pub fn server_id(&self) -> String {
        self.dir.server.server_id.clone()
    }

    /// Graceful stop; releases the data folder.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
        drop(self.state);
        drop(self.dir);
    }
}

/// Starts the router in-process on 127.0.0.1 with a fresh data folder.
pub async fn start(data: &Path, m0: bool, flags: Overrides) -> TestServer {
    let srv = open(data, m0, flags).await;
    assert!(!srv.admin_code.is_empty(), "first start");
    srv
}

/// Starts on a folder that may already exist.
pub async fn open(data: &Path, m0: bool, flags: Overrides) -> TestServer {
    let (dir, settings) = DataDir::open(data, flags).expect("open data dir");
    let admin_code = dir.new_admin_code.clone().unwrap_or_default();
    let (tx, rx) = watch::channel(false);
    let state = AppState::new(&dir, settings, Assets::Embedded, m0, rx.clone()).expect("state");
    app::spawn_maintenance(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let svc = app::router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let mut stop = rx;
    let task = tokio::spawn(async move {
        axum::serve(listener, svc)
            .with_graceful_shutdown(async move {
                let _ = stop.wait_for(|v| *v).await;
            })
            .await
            .unwrap();
    });
    TestServer {
        addr,
        admin_code,
        dir,
        shutdown: tx,
        state,
        task,
    }
}

// ---- a client of the M1 API ----

pub struct Member {
    pub key: SigningKey,
    pub user: UserId,
    pub identity: Envelope,
    pub dev: DevId,
    pub token: String,
}

pub fn new_key() -> SigningKey {
    SigningKey::from_bytes(&fcd::webpush::random_bytes::<32>())
}

pub fn new_dev() -> DevId {
    DevId(fcd::webpush::random_bytes::<10>())
}

pub fn new_msg_id() -> String {
    b32_encode(&fcd::webpush::random_bytes::<16>())
}

pub fn env_json(e: &Envelope) -> Value {
    json!({ "payload": e.payload, "sig": e.sig })
}

/// Join body for a new identity; `code` is `("invite"|"adminCode", value)`.
pub fn join_body(key: &SigningKey, name: &str, field: &str, code: &str, dev: &DevId) -> String {
    let (uid, identity) = testkit::identity(key);
    let profile = testkit::profile(key, &uid, name, 1);
    let mut b = json!({
        "identity": env_json(&identity),
        "profile": env_json(&profile),
        "devId": dev.to_string(),
    });
    b[field] = json!(code);
    b.to_string()
}

impl Member {
    pub fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub fn chat_with(&self, server_id: &str, other: &Member) -> ChatId {
        ChatId::direct(server_id, &self.user, &other.user)
    }

    pub async fn get(&self, srv: &TestServer, path: &str) -> Res {
        request("GET", &srv.url(path), &[("Authorization", &self.auth())], None).await
    }

    pub async fn send(&self, srv: &TestServer, method: &str, path: &str, body: Option<&str>) -> Res {
        request(
            method,
            &srv.url(path),
            &[("Authorization", &self.auth()), ("Content-Type", "application/json")],
            body,
        )
        .await
    }

    /// Posts an event; returns the response.
    pub async fn post_event(&self, srv: &TestServer, chat: &ChatId, msg_id: &str, body: &[u8]) -> Res {
        request_bytes(
            "POST",
            &srv.url(&format!("/v1/chats/{chat}/events")),
            &[
                ("Authorization", &self.auth()),
                ("Content-Type", "application/octet-stream"),
                ("Idempotency-Key", msg_id),
                ("X-FC-Epoch", "0"),
            ],
            body.to_vec(),
        )
        .await
    }

    /// Posts an event with an explicit epoch.
    pub async fn post_event_epoch(
        &self,
        srv: &TestServer,
        chat: &ChatId,
        msg_id: &str,
        epoch: u32,
        body: &[u8],
    ) -> Res {
        let epoch = epoch.to_string();
        request_bytes(
            "POST",
            &srv.url(&format!("/v1/chats/{chat}/events")),
            &[
                ("Authorization", &self.auth()),
                ("Content-Type", "application/octet-stream"),
                ("Idempotency-Key", msg_id),
                ("X-FC-Epoch", &epoch),
            ],
            body.to_vec(),
        )
        .await
    }

    /// Sends raw bytes.
    pub async fn send_bytes(&self, srv: &TestServer, method: &str, path: &str, body: Vec<u8>) -> Res {
        request_bytes(
            method,
            &srv.url(path),
            &[
                ("Authorization", &self.auth()),
                ("Content-Type", "application/octet-stream"),
            ],
            body,
        )
        .await
    }

    /// Events after `after` (no waiting).
    pub async fn feed(&self, srv: &TestServer, after: u64) -> Vec<Value> {
        let res = self.get(srv, &format!("/v1/events?after={after}")).await;
        assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
        res.json()["events"].as_array().unwrap().clone()
    }

    /// Signs an auth payload for a challenge.
    pub fn auth_envelope(&self, server_id: &str, nonce: &str, dev: &DevId) -> Envelope {
        let p =
            json!({"v":1,"userId":self.user.to_string(),"serverId":server_id,"nonce":nonce,"devId":dev.to_string()});
        testkit::seal(&self.key, Kind::Auth, &p.to_string())
    }
}

/// Joins with a code; panics unless 200.
pub async fn join(srv: &TestServer, name: &str, field: &str, code: &str) -> Member {
    let key = new_key();
    let dev = new_dev();
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&key, name, field, code, &dev)),
    )
    .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    let j = res.json();
    let (user, identity) = testkit::identity(&key);
    assert_eq!(j["userId"], user.to_string());
    assert_eq!(j["devId"], dev.to_string());
    Member {
        key,
        user,
        identity,
        dev,
        token: j["token"].as_str().unwrap().to_string(),
    }
}

/// The administrator (first join with the admin code) and one invited member.
pub async fn family(srv: &TestServer) -> (Member, Member) {
    let admin = join(srv, "Мама", "adminCode", &srv.admin_code).await;
    let code = invite(srv, &admin).await;
    let other = join(srv, "Папа", "invite", &code).await;
    (admin, other)
}

/// A second device of `m` (by signature); returns the member with that device's token.
pub async fn second_device(srv: &TestServer, m: &Member) -> Member {
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let dev = new_dev();
    let env = m.auth_envelope(&srv.server_id(), &nonce, &dev);
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    Member {
        key: m.key.clone(),
        user: m.user,
        identity: m.identity.clone(),
        dev,
        token: res.json()["token"].as_str().unwrap().to_string(),
    }
}

pub fn b64e(b: &[u8]) -> String {
    B64.encode(b)
}

pub async fn invite(srv: &TestServer, admin: &Member) -> String {
    let res = admin.send(srv, "POST", "/v1/admin/invites", None).await;
    assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
    res.json()["code"].as_str().unwrap().to_string()
}

pub fn b64d(s: &Value) -> Vec<u8> {
    B64.decode(s.as_str().unwrap()).unwrap()
}

pub fn msg_id_str(m: &MsgId) -> String {
    m.to_string()
}

pub struct Res {
    pub status: u16,
    pub headers: hyper::HeaderMap,
    pub body: Vec<u8>,
}

impl Res {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("json body")
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

pub async fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Res {
    request_bytes(method, url, headers, body.unwrap_or("").as_bytes().to_vec()).await
}

pub async fn request_bytes(method: &str, url: &str, headers: &[(&str, &str)], body: Vec<u8>) -> Res {
    let client: Client<HttpConnector, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let mut b = hyper::Request::builder().method(method).uri(url);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = b.body(Full::new(Bytes::from(body))).unwrap();
    let res = client.request(req).await.expect("request");
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Res { status, headers, body }
}

pub async fn get(url: &str) -> Res {
    request("GET", url, &[], None).await
}

/// Browser side of RFC 8291: decrypts an `aes128gcm` body.
pub fn decrypt(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
    let salt = &body[..16];
    let rs = u32::from_be_bytes(body[16..20].try_into().unwrap());
    assert_eq!(rs, 4096);
    let idlen = body[20] as usize;
    assert_eq!(idlen, 65);
    let as_public = PublicKey::from_sec1_bytes(&body[21..21 + idlen]).unwrap();
    let ciphertext = &body[21 + idlen..];
    let ua_public = ua_secret.public_key().to_sec1_bytes();
    let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(&ua_public);
    info.extend_from_slice(&as_public.to_sec1_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
        .expand(&info, &mut ikm)
        .unwrap();
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
    let mut plain = Aes128Gcm::new_from_slice(&cek)
        .unwrap()
        .decrypt(&Nonce::try_from(&nonce[..]).unwrap(), ciphertext)
        .unwrap();
    assert_eq!(plain.pop(), Some(2), "last-record delimiter");
    plain
}
