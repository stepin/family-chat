mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::http::HeaderMap;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use common::{decrypt, family, get, request, start};
use fcd::config::Overrides;
use p256::SecretKey;

#[tokio::test]
async fn hello_reports_server_info() {
    let tmp = tempfile::tempdir().unwrap();
    let flags = Overrides {
        family_name: Some("Ивановы".into()),
        retention_days: Some(30),
        ..Default::default()
    };
    let srv = start(tmp.path(), flags).await;
    let res = get(&srv.url("/v1/hello")).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("access-control-allow-origin"), Some("*"));
    assert!(res.header("set-cookie").is_none());
    let j = res.json();
    assert_eq!(j["protocol"], 1);
    assert_eq!(j["version"], env!("CARGO_PKG_VERSION"));
    // The build commit (M6): what `fcd --version` shows, or null when unknown.
    if fcd::GIT_COMMIT.is_empty() {
        assert!(j["commit"].is_null());
    } else {
        assert_eq!(j["commit"], fcd::GIT_COMMIT);
        assert!(fcd::VERSION_LINE.contains(fcd::GIT_COMMIT));
    }
    assert_eq!(j["serverId"], srv.dir.server.server_id.as_str());
    assert_eq!(j["familyName"], "Ивановы");
    assert_eq!(j["retentionDays"], 30);
    assert_eq!(j["maxFileMb"], 200);
    assert_eq!(j["maxPartBytes"], 4 * 1024 * 1024 + 256);
    assert_eq!(j["maxBlobBytes"], 200 * 1024 * 1024 + 64 * 1024);
    assert_eq!(j["maxAvatarBytes"], 256 * 1024);
    assert_eq!(j["maxStateBytes"], 256 * 1024);
    assert_eq!(j["maxSealedKeyBytes"], 8192);
    assert_eq!(j["maxGroupMembers"], 100);
    assert_eq!(j["push"], true);
    assert!(j.get("m0").is_none(), "m0 was removed in M8");
    assert_eq!(j["offerSetup"], false);
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
    let srv = start(tmp.path(), Overrides::default()).await;
    for path in ["/v1/hello", "/v1/check/wait", "/v1/does-not-exist"] {
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
        &srv.url("/v1/check/wait?seconds=0"),
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
async fn hello_reports_offer_setup() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            offer_setup: Some(true),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["offerSetup"], true);
}

#[tokio::test]
async fn check_endpoints_need_admin_code() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    // Always on (M8): no value is 401, not 404.
    let res = get(&srv.url("/v1/check/wait?seconds=0")).await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "unauthorized");
    let res = request(
        "GET",
        &srv.url("/v1/check/wait?seconds=0"),
        &[("Authorization", "Bearer 0000-0000-0000-0000")],
        None,
    )
    .await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "unauthorized");
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &[("Content-Type", "application/json")],
        Some("{}"),
    )
    .await;
    assert_eq!(res.status, 401);
    // Code is accepted in any case and without dashes.
    let loose = format!("Bearer {}", srv.admin_code.to_lowercase().replace('-', ""));
    let res = request(
        "GET",
        &srv.url("/v1/check/wait?seconds=0"),
        &[("Authorization", &loose)],
        None,
    )
    .await;
    assert_eq!(res.status, 200);
}

#[tokio::test]
async fn check_access_after_setup() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let code = format!("Bearer {}", srv.admin_code);
    let (admin, member) = family(&srv).await;
    let wait = |auth: String| {
        let url = srv.url("/v1/check/wait?seconds=0");
        async move { request("GET", &url, &[("Authorization", &auth)], None).await }
    };
    // The spent code names the device-token path.
    let res = wait(code.clone()).await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "admin_code_inactive");
    assert!(res.json()["message"].as_str().unwrap().contains("device token"));
    assert_eq!(wait(admin.auth()).await.status, 200);
    let res = wait(member.auth()).await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "not_admin");
    // Bad `from`.
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &[("Authorization", &admin.auth()), ("Content-Type", "application/json")],
        Some(r#"{"from":"elsewhere"}"#),
    )
    .await;
    assert_eq!(res.status, 400);
    // No stored subscription for this device.
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &[("Authorization", &admin.auth()), ("Content-Type", "application/json")],
        Some(r#"{"from":"app"}"#),
    )
    .await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "no_subscription");
    // A device token cannot name another address.
    let (_, _, sub) = browser_subscription("https://push.example.net/x");
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &[("Authorization", &admin.auth()), ("Content-Type", "application/json")],
        Some(&format!(r#"{{"subscription":{sub}}}"#)),
    )
    .await;
    assert_eq!(res.status, 400);
    // The last outcome starts empty.
    let res = request(
        "GET",
        &srv.url("/v1/check/push"),
        &[("Authorization", &admin.auth())],
        None,
    )
    .await;
    assert_eq!(res.status, 200);
    assert!(res.json()["last"].is_null());
}

#[tokio::test]
async fn check_removed_member_is_forbidden() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (admin, second) = family(&srv).await;
    // A removed member's token answers `removed` (checked before the role).
    let res = admin
        .send(&srv, "DELETE", &format!("/v1/admin/users/{}", second.user), None)
        .await;
    assert!(res.status == 200 || res.status == 204, "{}", res.status);
    let res = request(
        "GET",
        &srv.url("/v1/check/wait?seconds=0"),
        &[("Authorization", &second.auth())],
        None,
    )
    .await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "removed");
}

#[tokio::test]
async fn check_rate_limit_spares_device_tokens() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (admin, _) = family(&srv).await;
    let wait = |auth: String| {
        let url = srv.url("/v1/check/wait?seconds=0");
        async move { request("GET", &url, &[("Authorization", &auth)], None).await }
    };
    // Requests without a value are not counted as failures.
    for _ in 0..12 {
        assert_eq!(get(&srv.url("/v1/check/wait?seconds=0")).await.status, 401);
    }
    assert_eq!(wait("Bearer 0000-0000-0000-0000".into()).await.status, 401);
    for _ in 0..10 {
        wait("Bearer 1111-1111-1111-1111".into()).await;
    }
    let res = wait("Bearer 2222-2222-2222-2222".into()).await;
    assert_eq!(res.status, 429);
    assert!(res.header("retry-after").is_some());
    // The administrator's device is not locked out by others' wrong codes.
    assert_eq!(wait(admin.auth()).await.status, 200);
    // Joining shares the limit (same secret).
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some("{}"),
    )
    .await;
    assert_eq!(res.status, 429);
}

#[tokio::test]
async fn check_push_cap_and_device_subscription() {
    let (service, captured) = fake_push_service().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (admin, _) = family(&srv).await;
    let (ua, auth, sub) = browser_subscription(&format!("{service}/push/dev"));
    let res = admin.send(&srv, "PUT", "/v1/me/push", Some(&sub)).await;
    assert_eq!(res.status, 204);
    let headers = [
        ("Authorization", admin.auth()),
        ("Content-Type", "application/json".to_string()),
    ];
    let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let res = request("POST", &srv.url("/v1/check/push"), &h, Some(r#"{"from":"app"}"#)).await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    {
        let got = captured.0.lock().unwrap();
        assert_eq!(got.len(), 1);
        let payload: serde_json::Value = serde_json::from_slice(&decrypt(&ua, &auth, &got[0].1)).unwrap();
        assert_eq!(payload["kind"], "m0-test");
        assert_eq!(payload["from"], "app");
    }
    let res = request("GET", &srv.url("/v1/check/push"), &h, None).await;
    assert_eq!(res.json()["last"]["result"], "sent");
    // At most three delayed test pushes wait at once.
    for _ in 0..3 {
        let res = request("POST", &srv.url("/v1/check/push"), &h, Some(r#"{"delaySeconds":300}"#)).await;
        assert_eq!(res.status, 202);
    }
    let res = request("POST", &srv.url("/v1/check/push"), &h, Some(r#"{"delaySeconds":300}"#)).await;
    assert_eq!(res.status, 429);
    assert_eq!(res.json()["error"], "too_many_pending");
}

#[tokio::test]
async fn check_push_failure_is_classified() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let auth_header = format!("Bearer {}", srv.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    // Nothing listens on this port: a network failure, no raw error text.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (_, _, sub) = browser_subscription(&format!("http://127.0.0.1:{port}/push/x"));
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &headers,
        Some(&format!(r#"{{"subscription":{sub}}}"#)),
    )
    .await;
    assert_eq!(res.status, 502);
    let j = res.json();
    assert_eq!(j["error"], "push_failed");
    assert_eq!(j["reason"], "network");
    assert!(!j["message"].as_str().unwrap().contains("127.0.0.1"), "{j}");
    let res = request("GET", &srv.url("/v1/check/push"), &headers, None).await;
    assert_eq!(res.json()["last"]["result"], "network");
}

#[tokio::test]
async fn long_request_answers_after_given_time() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let auth = format!("Bearer {}", srv.admin_code);
    let t = Instant::now();
    let res = request(
        "GET",
        &srv.url("/v1/check/wait?seconds=2"),
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
        &srv.url("/v1/check/wait?seconds=61"),
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(res.status, 400);
}

#[tokio::test]
async fn long_request_ends_on_shutdown() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let auth = format!("Bearer {}", srv.admin_code);
    let url = srv.url("/v1/check/wait?seconds=60");
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
    let srv = start(tmp.path(), Overrides::default()).await;
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

    assert_eq!(get(&srv.url("/sw.js")).await.header("cache-control"), Some("no-store"));
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

pub fn browser_subscription(endpoint: &str) -> (SecretKey, [u8; 16], String) {
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
    // M7: no human text in the payload; the service worker words it in the app's language.
    assert!(
        payload.get("body").is_none() && payload.get("title").is_none(),
        "{payload}"
    );
    assert!(payload["delay"].is_u64() && payload["sentAt"].is_u64(), "{payload}");
}

#[tokio::test]
async fn test_push_now_and_delayed() {
    let (service, captured) = fake_push_service().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let auth_header = format!("Bearer {}", srv.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    let vapid_pub = srv.dir.vapid.public_key_b64();

    let (ua, auth, sub) = browser_subscription(&format!("{service}/push/abc"));
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
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
        &srv.url("/v1/check/push"),
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
    let srv = start(tmp.path(), Overrides::default()).await;
    let auth_header = format!("Bearer {}", srv.admin_code);
    let headers = [
        ("Authorization", auth_header.as_str()),
        ("Content-Type", "application/json"),
    ];
    let (_, _, sub) = browser_subscription("http://192.168.1.1/push/x");
    let res = request(
        "POST",
        &srv.url("/v1/check/push"),
        &headers,
        Some(&format!(r#"{{"subscription":{sub}}}"#)),
    )
    .await;
    assert_eq!(res.status, 400);
    let (_, _, sub) = browser_subscription("https://push.example.net/x");
    let body = format!(r#"{{"subscription":{sub},"delaySeconds":301}}"#);
    assert_eq!(
        request("POST", &srv.url("/v1/check/push"), &headers, Some(&body))
            .await
            .status,
        400
    );
    assert_eq!(
        request("POST", &srv.url("/v1/check/push"), &headers, Some("not json"))
            .await
            .status,
        400
    );

    let tmp2 = tempfile::tempdir().unwrap();
    let off = start(
        tmp2.path(),
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
    let res = request("POST", &off.url("/v1/check/push"), &headers, Some(&body)).await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "push_disabled");
}
