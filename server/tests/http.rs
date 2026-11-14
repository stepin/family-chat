mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::body::Bytes;
use axum::http::HeaderMap;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use common::{get, request, start};
use fcd::config::Overrides;
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

#[tokio::test]
async fn hello_reports_server_info() {
    let tmp = tempfile::tempdir().unwrap();
    let flags = Overrides {
        family_name: Some("Ивановы".into()),
        retention_days: Some(30),
        ..Default::default()
    };
    let srv = start(tmp.path(), false, flags).await;
    let res = get(&srv.url("/v1/hello")).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("access-control-allow-origin"), Some("*"));
    assert!(res.header("set-cookie").is_none());
    let j = res.json();
    assert_eq!(j["protocol"], 1);
    assert_eq!(j["serverId"], srv.dir.server.server_id.as_str());
    assert_eq!(j["familyName"], "Ивановы");
    assert_eq!(j["retentionDays"], 30);
    assert_eq!(j["maxFileMb"], 200);
    assert_eq!(j["push"], true);
    assert_eq!(j["m0"], false);
    let key = B64.decode(j["vapidPublicKey"].as_str().unwrap()).unwrap();
    assert_eq!(key.len(), 65);
    assert_eq!(key[0], 4);
    let now = fcd::datadir::now_ms() as i64;
    assert!((j["time"].as_i64().unwrap() - now).abs() < 5_000);
    // No secrets in the public answer.
    let text = String::from_utf8(res.body.clone()).unwrap();
    assert!(!text.contains(&srv.admin_code));
    assert!(!text.contains(&srv.dir.vapid.to_file().private_key));
}

#[tokio::test]
async fn hello_without_push_has_no_key() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        false,
        Overrides {
            push: Some(false),
            ..Default::default()
        },
    )
    .await;
    let j = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(j["push"], false);
    assert!(j["vapidPublicKey"].is_null());
}

#[tokio::test]
async fn cors_preflight_and_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    for path in ["/v1/hello", "/v1/m0/wait", "/v1/does-not-exist"] {
        let res = request(
            "OPTIONS",
            &srv.url(path),
            &[
                ("Origin", "https://client.example"),
                ("Access-Control-Request-Method", "GET"),
                ("Access-Control-Request-Headers", "authorization"),
            ],
            None,
        )
        .await;
        assert_eq!(res.status, 204, "{path}");
        assert_eq!(res.header("access-control-allow-origin"), Some("*"));
        assert!(
            res.header("access-control-allow-headers")
                .unwrap()
                .contains("Authorization")
        );
        assert!(res.header("access-control-allow-methods").unwrap().contains("POST"));
        assert!(res.header("access-control-allow-credentials").is_none());
    }
    // Errors carry CORS too, so a page on another origin can read them.
    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=0"),
        &[("Origin", "https://client.example")],
        None,
    )
    .await;
    assert_eq!(res.status, 401);
    assert_eq!(res.header("access-control-allow-origin"), Some("*"));
    let res = get(&srv.url("/v1/nothing")).await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["error"], "not_found");
    assert_eq!(res.header("access-control-allow-origin"), Some("*"));
}

#[tokio::test]
async fn m0_endpoints_closed_without_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let auth = format!("Bearer {}", srv.admin_code);
    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=0"),
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(res.status, 404);
    let res = request(
        "POST",
        &srv.url("/v1/m0/push"),
        &[("Authorization", &auth), ("Content-Type", "application/json")],
        Some("{}"),
    )
    .await;
    assert_eq!(res.status, 404);
}

#[tokio::test]
async fn m0_endpoints_need_admin_code() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    let res = get(&srv.url("/v1/m0/wait?seconds=0")).await;
    assert_eq!(res.status, 401);
    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=0"),
        &[("Authorization", "Bearer 0000-0000-0000-0000")],
        None,
    )
    .await;
    assert_eq!(res.status, 401);
    let res = request(
        "POST",
        &srv.url("/v1/m0/push"),
        &[("Content-Type", "application/json")],
        Some("{}"),
    )
    .await;
    assert_eq!(res.status, 401);
    // Code is accepted in any case and without dashes.
    let loose = format!("Bearer {}", srv.admin_code.to_lowercase().replace('-', ""));
    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=0"),
        &[("Authorization", &loose)],
        None,
    )
    .await;
    assert_eq!(res.status, 200);
}

#[tokio::test]
async fn long_request_answers_after_given_time() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    let auth = format!("Bearer {}", srv.admin_code);
    let t = Instant::now();
    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=2"),
        &[("Authorization", &auth)],
        None,
    )
    .await;
    let elapsed = t.elapsed();
    assert_eq!(res.status, 200);
    assert!(elapsed >= Duration::from_secs(2), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(4), "{elapsed:?}");
    let j = res.json();
    assert_eq!(j["seconds"], 2);
    assert!(j["finishedAt"].as_u64().unwrap() - j["startedAt"].as_u64().unwrap() >= 2000);
    assert_eq!(res.header("cache-control"), Some("no-store"));

    let res = request(
        "GET",
        &srv.url("/v1/m0/wait?seconds=61"),
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(res.status, 400);
}

#[tokio::test]
async fn long_request_ends_on_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    let auth = format!("Bearer {}", srv.admin_code);
    let url = srv.url("/v1/m0/wait?seconds=60");
    let t = Instant::now();
    let pending = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    srv.shutdown.send(true).unwrap();
    let res = pending.await.unwrap();
    assert_eq!(res.status, 503);
    assert!(t.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn serves_embedded_client() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let res = get(&srv.url("/")).await;
    assert_eq!(res.status, 200);
    assert!(res.header("content-type").unwrap().starts_with("text/html"));
    assert!(res.header("access-control-allow-origin").is_none());
    let etag = res.header("etag").unwrap().to_string();
    let res = request("GET", &srv.url("/"), &[("If-None-Match", &etag)], None).await;
    assert_eq!(res.status, 304);

    let res = get(&srv.url("/server?x=1")).await;
    assert_eq!(res.status, 308);
    assert_eq!(res.header("location"), Some("/server/?x=1"));
    let res = get(&srv.url("/server/")).await;
    assert_eq!(res.status, 200);
    assert!(String::from_utf8_lossy(&res.body).contains("Проверка сервера"));

    let res = get(&srv.url("/manifest.webmanifest")).await;
    assert_eq!(res.status, 200);
    let m = res.json();
    assert_eq!(m["display"], "standalone");

    assert_eq!(get(&srv.url("/sw.js")).await.header("cache-control"), Some("no-cache"));
    assert_eq!(get(&srv.url("/nope.txt")).await.status, 404);
    assert_eq!(get(&srv.url("/../server.json")).await.status, 404);
}

// ---- Web Push against a local fake push service ----

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<(HeaderMap, Bytes)>>>);

async fn fake_push_service() -> (String, Captured) {
    let captured = Captured::default();
    let c2 = captured.clone();
    let app = axum::Router::new().route(
        "/push/{id}",
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let c = c2.clone();
            async move {
                c.0.lock().unwrap().push((headers, body));
                axum::http::StatusCode::CREATED
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), captured)
}

/// Browser side of RFC 8291: decrypts an `aes128gcm` body.
fn decrypt(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
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

fn browser_subscription(endpoint: &str) -> (SecretKey, [u8; 16], String) {
    let ua_secret = loop {
        if let Ok(k) = SecretKey::from_slice(&fcd::webpush::random_bytes::<32>()) {
            break k;
        }
    };
    let auth = fcd::webpush::random_bytes::<16>();
    let body = serde_json::json!({
        "endpoint": endpoint,
        "keys": {
            "p256dh": B64.encode(ua_secret.public_key().to_sec1_bytes()),
            "auth": B64.encode(auth),
        }
    });
    (ua_secret, auth, body.to_string())
}

fn check_push_request(headers: &HeaderMap, body: &[u8], service: &str, vapid_pub: &str, ua: &SecretKey, auth: &[u8]) {
    let h = |n: &str| headers.get(n).unwrap().to_str().unwrap().to_string();
    assert_eq!(h("content-encoding"), "aes128gcm");
    assert_eq!(h("ttl"), "300");
    assert_eq!(h("urgency"), "high");
    let authz = h("authorization");
    let (jwt, k) = authz.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(k, vapid_pub);
    let claims: serde_json::Value =
        serde_json::from_slice(&B64.decode(jwt.split('.').nth(1).unwrap()).unwrap()).unwrap();
    assert_eq!(claims["aud"], service);
    assert_eq!(claims["sub"], fcd::config::DEFAULT_PUSH_SUBJECT);
    let payload: serde_json::Value = serde_json::from_slice(&decrypt(ua, auth, body)).unwrap();
    assert_eq!(payload["kind"], "m0-test");
    assert_eq!(payload["title"], "Family Chat");
}

#[tokio::test]
async fn test_push_now_and_delayed() {
    let (service, captured) = fake_push_service().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    let auth_header = format!("Bearer {}", srv.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    let vapid_pub = srv.dir.vapid.public_key_b64();

    let (ua, auth, sub) = browser_subscription(&format!("{service}/push/abc"));
    let res = request(
        "POST",
        &srv.url("/v1/m0/push"),
        &headers,
        Some(&format!(r#"{{"subscription":{sub}}}"#)),
    )
    .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    let j = res.json();
    assert_eq!(j["outcome"]["status"], 201);
    assert_eq!(j["outcome"]["service"], "127.0.0.1");
    {
        let got = captured.0.lock().unwrap();
        assert_eq!(got.len(), 1);
        check_push_request(&got[0].0, &got[0].1, &service, &vapid_pub, &ua, &auth);
    }

    let res = request(
        "POST",
        &srv.url("/v1/m0/push"),
        &headers,
        Some(&format!(r#"{{"subscription":{sub},"delaySeconds":1}}"#)),
    )
    .await;
    assert_eq!(res.status, 202);
    assert_eq!(captured.0.lock().unwrap().len(), 1, "not sent before the delay");
    let deadline = Instant::now() + Duration::from_secs(5);
    while captured.0.lock().unwrap().len() < 2 {
        assert!(Instant::now() < deadline, "delayed push did not arrive");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let got = captured.0.lock().unwrap();
    check_push_request(&got[1].0, &got[1].1, &service, &vapid_pub, &ua, &auth);
}

#[tokio::test]
async fn test_push_rejects_bad_input() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), true, Overrides::default()).await;
    let auth_header = format!("Bearer {}", srv.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    let (_, _, sub) = browser_subscription("http://192.168.1.1/push/x");
    let res = request(
        "POST",
        &srv.url("/v1/m0/push"),
        &headers,
        Some(&format!(r#"{{"subscription":{sub}}}"#)),
    )
    .await;
    assert_eq!(res.status, 400);
    let (_, _, sub) = browser_subscription("https://push.example.net/x");
    let body = format!(r#"{{"subscription":{sub},"delaySeconds":301}}"#);
    assert_eq!(
        request("POST", &srv.url("/v1/m0/push"), &headers, Some(&body))
            .await
            .status,
        400
    );
    assert_eq!(
        request("POST", &srv.url("/v1/m0/push"), &headers, Some("not json"))
            .await
            .status,
        400
    );

    let tmp2 = tempfile::tempdir().unwrap();
    let off = start(
        tmp2.path(),
        true,
        Overrides {
            push: Some(false),
            ..Default::default()
        },
    )
    .await;
    let auth_header = format!("Bearer {}", off.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    let body = format!(r#"{{"subscription":{sub}}}"#);
    let res = request("POST", &off.url("/v1/m0/push"), &headers, Some(&body)).await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "push_disabled");
}
