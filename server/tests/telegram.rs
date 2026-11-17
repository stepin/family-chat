//! Telegram sticker sets by link against a fake Bot API (`--telegram-api-url`):
//! the error contract, waits, caps, the single flight and the device limit.

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get as route_get;
use common::*;
use fcd::config::{Overrides, Secret};
use serde_json::{Value, json};

const TOKEN: &str = "123456:AAFakeTokenForTestsOnly_abcdefghij";

/// What the fake answers. `set` is the `result` of getStickerSet.
#[derive(Clone, Default)]
struct Fake {
    /// A raw answer for every method call: (status, body).
    method_answer: Option<(u16, Value)>,
    set: Option<Value>,
    /// file_path -> bytes; missing paths answer 404.
    files: HashMap<String, Vec<u8>>,
    /// Files answered in small chunks without Content-Length.
    chunked: bool,
    set_delay: Duration,
    file_delay: Duration,
    /// getFile answers this path for every file (to test unsafe paths).
    file_path_override: Option<String>,
    /// The first download of each path answers 404 (an expired path).
    expire_once: bool,
}

#[derive(Clone)]
struct FakeState {
    fake: Arc<Mutex<Fake>>,
    set_calls: Arc<AtomicUsize>,
    get_file_calls: Arc<AtomicUsize>,
    expired: Arc<Mutex<Vec<String>>>,
}

async fn fake_method(
    State(s): State<FakeState>,
    Path((bot, method)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    assert_eq!(bot, format!("bot{TOKEN}"));
    let f = s.fake.lock().unwrap().clone();
    if let Some((status, body)) = f.method_answer {
        return (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response();
    }
    match method.as_str() {
        "getMe" => axum::Json(json!({"ok": true, "result": {"username": "fake_bot"}})).into_response(),
        "getStickerSet" => {
            s.set_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(f.set_delay).await;
            match f.set {
                Some(set) => axum::Json(json!({"ok": true, "result": set})).into_response(),
                None => (
                    StatusCode::BAD_REQUEST,
                    axum::Json(
                        json!({"ok": false, "error_code": 400, "description": "Bad Request: STICKERSET_INVALID"}),
                    ),
                )
                    .into_response(),
            }
        }
        "getFile" => {
            s.get_file_calls.fetch_add(1, Ordering::SeqCst);
            let id = q.get("file_id").cloned().unwrap_or_default();
            let path = f.file_path_override.unwrap_or(format!("stickers/{id}.bin"));
            axum::Json(json!({"ok": true, "result": {"file_id": id, "file_path": path}})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn fake_file(State(s): State<FakeState>, Path((bot, path)): Path<(String, String)>) -> Response {
    assert_eq!(bot, format!("bot{TOKEN}"));
    let f = s.fake.lock().unwrap().clone();
    tokio::time::sleep(f.file_delay).await;
    if f.expire_once {
        let mut e = s.expired.lock().unwrap();
        if !e.contains(&path) {
            e.push(path);
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    let Some(bytes) = f.files.get(&path).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if f.chunked {
        return Response::new(Body::new(Chunks(bytes.chunks(4096).map(|c| c.to_vec()).collect())));
    }
    bytes.into_response()
}

/// A body sent in chunks with no length known up front (no Content-Length).
struct Chunks(std::collections::VecDeque<Vec<u8>>);

impl axum::body::HttpBody for Chunks {
    type Data = axum::body::Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        std::task::Poll::Ready(self.0.pop_front().map(|c| Ok(hyper::body::Frame::data(c.into()))))
    }
}

struct FakeTelegram {
    addr: SocketAddr,
    state: FakeState,
}

impl FakeTelegram {
    async fn start(fake: Fake) -> FakeTelegram {
        let state = FakeState {
            fake: Arc::new(Mutex::new(fake)),
            set_calls: Arc::new(AtomicUsize::new(0)),
            get_file_calls: Arc::new(AtomicUsize::new(0)),
            expired: Arc::new(Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route("/{bot}/{method}", route_get(fake_method))
            .route("/file/{bot}/{*path}", route_get(fake_file))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        FakeTelegram { addr, state }
    }

    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn set(&self, f: impl FnOnce(&mut Fake)) {
        f(&mut self.state.fake.lock().unwrap());
    }
}

fn flags(fake: &FakeTelegram) -> Overrides {
    Overrides {
        telegram_bot_token: Some(Secret::new(TOKEN)),
        telegram_api_url: Some(fake.url()),
        ..Default::default()
    }
}

/// A minimal valid WebP header (VP8X with a canvas of 512×512).
fn webp(fill: usize) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(b"WEBPVP8X");
    v.extend_from_slice(&10u32.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0, 0]);
    v.extend_from_slice(&[255, 1, 0, 255, 1, 0]);
    v.resize(v.len() + fill, 0);
    v
}

fn cats() -> Value {
    json!({
        "name": "Cats_by_fake_bot",
        "title": "Коты",
        "sticker_type": "regular",
        "stickers": [
            {"file_id": "F1", "file_unique_id": "U1", "emoji": "😺", "is_animated": false, "is_video": false},
            {"file_id": "F2", "file_unique_id": "U2", "emoji": "😹", "is_animated": true, "is_video": false},
            {"file_id": "F3", "file_unique_id": "U3", "emoji": "🙀", "is_animated": false, "is_video": true},
        ]
    })
}

fn cats_files() -> HashMap<String, Vec<u8>> {
    HashMap::from([
        ("stickers/F1.bin".to_string(), webp(100)),
        ("stickers/F2.bin".to_string(), vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0]),
    ])
}

async fn setup(fake: Fake) -> (tempfile::TempDir, FakeTelegram, TestServer, Member) {
    let dir = tempfile::tempdir().unwrap();
    let tg = FakeTelegram::start(fake).await;
    let srv = start(&dir.path().join("data"), flags(&tg)).await;
    let (admin, _) = family(&srv).await;
    (dir, tg, srv, admin)
}

fn assert_error(r: &Res, status: u16, code: &str, reason: Option<&str>) {
    assert_eq!(r.status, status, "{}", String::from_utf8_lossy(&r.body));
    let j = r.json();
    assert_eq!(j["error"], code, "{j}");
    assert!(j["message"].is_string(), "{j}");
    match reason {
        Some(reason) => assert_eq!(j["reason"], reason, "{j}"),
        None => assert!(j.get("reason").is_none(), "{j}"),
    }
    assert!(r.header("x-request-id").is_some_and(|v| v.len() == 16));
}

#[tokio::test]
async fn list_and_files() {
    let (_d, tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        files: cats_files(),
        ..Default::default()
    })
    .await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["telegramStickers"], true);

    let r = admin.get(&srv, "/v1/telegram/sets/cats_BY_fake_bot").await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert!(r.header("x-request-id").is_some());
    let j = r.json();
    assert_eq!(j["title"], "Коты");
    assert_eq!(
        j["stickers"],
        json!([{"id": "U1", "emoji": "😺", "type": "webp"}, {"id": "U2", "emoji": "😹", "type": "tgs"}])
    );
    assert_eq!(j["skipped"], json!({"video": 1, "other": 0}));

    let f = admin.get(&srv, "/v1/telegram/sets/Cats_by_fake_bot/files/U1").await;
    assert_eq!(f.status, 200);
    assert_eq!(f.body, webp(100));
    assert_eq!(f.header("content-type"), Some("application/octet-stream"));
    assert_eq!(f.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(f.header("cache-control"), Some("private, no-store"));
    // The list was cached: one getStickerSet for all of the above (names are case-insensitive).
    assert_eq!(tg.state.set_calls.load(Ordering::SeqCst), 1);
    // file_path is cached too.
    let _ = admin.get(&srv, "/v1/telegram/sets/Cats_by_fake_bot/files/U1").await;
    assert_eq!(tg.state.get_file_calls.load(Ordering::SeqCst), 1);

    // The admin sees the bot and the state of the last real call.
    let stats = admin.get(&srv, "/v1/admin/stats").await.json();
    assert_eq!(stats["telegram"]["status"], "ok");

    // Without a device token: 401; a bad name or id: 400.
    assert_eq!(get(&srv.url("/v1/telegram/sets/Cats")).await.status, 401);
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/bad-name").await,
        400,
        "bad_request",
        None,
    );
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/Cats/files/a.b").await,
        400,
        "bad_request",
        None,
    );
    srv.stop().await;
}

#[tokio::test]
async fn disabled_without_token() {
    let dir = tempfile::tempdir().unwrap();
    let srv = start(&dir.path().join("data"), Overrides::default()).await;
    let (admin, _) = family(&srv).await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["telegramStickers"], false);
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/Cats").await,
        404,
        "telegram_disabled",
        None,
    );
    assert!(admin.get(&srv, "/v1/admin/stats").await.json()["telegram"].is_null());
    srv.stop().await;
}

#[tokio::test]
async fn error_mapping() {
    let (_d, tg, srv, admin) = setup(Fake::default()).await;
    // STICKERSET_INVALID: the set does not exist.
    assert_error(&admin.get(&srv, "/v1/telegram/sets/Nope").await, 404, "not_found", None);

    // 404 on a method is how Telegram answers a broken token.
    tg.set(|f| f.method_answer = Some((404, json!({"ok": false, "error_code": 404, "description": "Not Found"}))));
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/A1").await,
        502,
        "telegram_unavailable",
        Some("token_rejected"),
    );
    assert_eq!(
        admin.get(&srv, "/v1/admin/stats").await.json()["telegram"]["status"],
        "token_rejected"
    );
    tg.set(|f| {
        f.method_answer = Some((
            401,
            json!({"ok": false, "error_code": 401, "description": "Unauthorized"}),
        ))
    });
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/A2").await,
        502,
        "telegram_unavailable",
        Some("token_rejected"),
    );
    tg.set(|f| {
        f.method_answer = Some((
            502,
            json!({"ok": false, "error_code": 502, "description": "Bad Gateway"}),
        ))
    });
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/A3").await,
        502,
        "telegram_unavailable",
        Some("upstream_error"),
    );
    // A set of custom emoji.
    tg.set(|f| {
        f.method_answer = None;
        f.set = Some(json!({"name": "Emo", "title": "Emo", "sticker_type": "custom_emoji", "stickers": []}));
    });
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/Emo").await,
        422,
        "telegram_emoji_set",
        None,
    );
    srv.stop().await;
}

#[tokio::test]
async fn flood_wait_longer_than_15_s_answers_503_at_once() {
    let (_d, tg, srv, admin) = setup(Fake::default()).await;
    tg.set(|f| {
        f.method_answer = Some((
            429,
            json!({"ok": false, "error_code": 429, "description": "Too Many Requests: retry after 120", "parameters": {"retry_after": 120}}),
        ))
    });
    let t = Instant::now();
    let r = admin.get(&srv, "/v1/telegram/sets/Cats").await;
    assert_error(&r, 503, "telegram_busy", None);
    assert_eq!(r.header("retry-after"), Some("120"));
    // Every later request waits for the same pause and is answered at once too.
    let r = admin.get(&srv, "/v1/telegram/sets/Dogs").await;
    assert_error(&r, 503, "telegram_busy", None);
    let ra: u64 = r.header("retry-after").unwrap().parse().unwrap();
    assert!((118..=120).contains(&ra), "{ra}");
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    srv.stop().await;
}

#[tokio::test]
async fn short_flood_wait_is_waited_out() {
    let (_d, tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        ..Default::default()
    })
    .await;
    tg.set(|f| {
        f.method_answer = Some((
            429,
            json!({"ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 1}}),
        ))
    });
    let state = tg.state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        state.fake.lock().unwrap().method_answer = None;
    });
    let t = Instant::now();
    let r = admin.get(&srv, "/v1/telegram/sets/Cats").await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert!(t.elapsed() >= Duration::from_millis(900), "{:?}", t.elapsed());
    srv.stop().await;
}

#[tokio::test]
async fn files_are_capped_while_streaming_and_paths_are_checked() {
    let mut files = cats_files();
    // 600 KiB, sent in chunks without Content-Length.
    files.insert("stickers/F1.bin".into(), webp(600 * 1024));
    let (_d, tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        files,
        chunked: true,
        ..Default::default()
    })
    .await;
    assert_error(
        &admin.get(&srv, "/v1/telegram/sets/Cats/files/U1").await,
        502,
        "telegram_unavailable",
        Some("bad_file"),
    );
    // A tgs within 128 KiB passes.
    let ok = admin.get(&srv, "/v1/telegram/sets/Cats/files/U2").await;
    assert_eq!(ok.status, 200);
    // An absolute path (telegram-bot-api --local) or one with `..` is refused.
    tg.set(|f| f.file_path_override = Some("/var/lib/telegram-bot-api/x.webp".into()));
    let dir2 = tempfile::tempdir().unwrap();
    let srv2 = start(&dir2.path().join("data"), flags(&tg)).await;
    let (admin2, _) = family(&srv2).await;
    assert_error(
        &admin2.get(&srv2, "/v1/telegram/sets/Cats/files/U2").await,
        502,
        "telegram_unavailable",
        Some("bad_file"),
    );
    srv2.stop().await;
    srv.stop().await;
}

#[tokio::test]
async fn stale_sticker_and_expired_path() {
    let (_d, tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        files: cats_files(),
        expire_once: true,
        ..Default::default()
    })
    .await;
    // The first download answers 404 (an expired file_path): one more getFile, then the file.
    let r = admin.get(&srv, "/v1/telegram/sets/Cats/files/U1").await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(tg.state.get_file_calls.load(Ordering::SeqCst), 2);
    // An id that is not in the set even after a fresh load.
    let r = admin.get(&srv, "/v1/telegram/sets/Cats/files/Gone1").await;
    assert_error(&r, 404, "not_found", Some("stale_set"));
    assert_eq!(tg.state.set_calls.load(Ordering::SeqCst), 2);
    srv.stop().await;
}

#[tokio::test]
async fn one_load_for_simultaneous_requests_even_if_the_first_client_leaves() {
    let (_d, tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        set_delay: Duration::from_millis(500),
        ..Default::default()
    })
    .await;
    // The first client goes away before the answer.
    let url = srv.url("/v1/telegram/sets/Cats");
    let auth = admin.auth();
    let first = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    first.abort();
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let url = srv.url("/v1/telegram/sets/CATS");
        let auth = admin.auth();
        tasks.push(tokio::spawn(async move {
            request("GET", &url, &[("Authorization", &auth)], None).await
        }));
    }
    for t in tasks {
        let r = t.await.unwrap();
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    }
    assert_eq!(tg.state.set_calls.load(Ordering::SeqCst), 1);
    srv.stop().await;
}

#[tokio::test]
async fn device_limit_three_files_at_once() {
    let (_d, _tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        files: cats_files(),
        file_delay: Duration::from_millis(800),
        ..Default::default()
    })
    .await;
    // Load the list first so the files only wait for the download.
    assert_eq!(admin.get(&srv, "/v1/telegram/sets/Cats").await.status, 200);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let url = srv.url("/v1/telegram/sets/Cats/files/U1");
        let auth = admin.auth();
        tasks.push(tokio::spawn(async move {
            request("GET", &url, &[("Authorization", &auth)], None).await
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut statuses = Vec::new();
    for t in tasks {
        let r = t.await.unwrap();
        if r.status == 429 {
            assert_eq!(r.json()["error"], "rate_limited");
            assert!(r.header("retry-after").is_some());
        }
        statuses.push(r.status);
    }
    statuses.sort();
    assert_eq!(statuses, vec![200, 200, 200, 429]);
    srv.stop().await;
}

#[tokio::test]
async fn slow_telegram_times_out_within_the_deadline() {
    let (_d, _tg, srv, admin) = setup(Fake {
        set: Some(cats()),
        set_delay: Duration::from_secs(30),
        ..Default::default()
    })
    .await;
    let t = Instant::now();
    let r = admin.get(&srv, "/v1/telegram/sets/Cats").await;
    assert_error(&r, 502, "telegram_unavailable", Some("timeout"));
    let took = t.elapsed();
    assert!(
        took >= Duration::from_secs(14) && took < Duration::from_secs(40),
        "{took:?}"
    );
    srv.stop().await;
}

#[tokio::test]
async fn token_is_not_written_to_a_new_config() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let tg = FakeTelegram::start(Fake::default()).await;
    let srv = start(&data, flags(&tg)).await;
    let config = std::fs::read_to_string(data.join("config.toml")).unwrap();
    assert!(!config.contains(TOKEN), "{config}");
    assert!(config.contains("# telegram_bot_token = \"\""), "{config}");
    // Settings print the token as ***.
    let shown = format!("{:?}", srv.state.settings);
    assert!(!shown.contains("AAFake") && shown.contains("***"), "{shown}");
    srv.stop().await;
}
