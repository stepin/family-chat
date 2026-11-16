//! M5 over HTTP: sticker packs (`/v1/packs`) and the no-push hint
//! (`X-FC-Push: none` on `POST /v1/chats/<id>/events`).

mod common;

use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use common::*;
use fcd::config::Overrides;
use fcd::envelope::testkit;
use fcd::envelope::{Envelope, Kind};
use fcd::ids::{FileHash, PackId};
use hyper::body::Bytes;
use p256::SecretKey;
use serde_json::{Value, json};

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

fn err(r: &Res) -> (u16, String) {
    (r.status, r.json()["error"].as_str().unwrap_or("").to_string())
}

fn new_pack() -> PackId {
    PackId(fcd::webpush::random_bytes::<16>())
}

/// A small valid-looking WebP file (the server only checks the signature bytes).
fn webp(n: u8, len: usize) -> Vec<u8> {
    let mut b = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    b.resize(len.max(b.len() + 1), n);
    b
}

/// A gzip-looking `.tgs` file.
fn tgs(n: u8, len: usize) -> Vec<u8> {
    let mut b = vec![0x1F, 0x8B, 0x08, 0x00];
    b.resize(len.max(5), n);
    b
}

fn sticker_json(bytes: &[u8], kind: &str) -> Value {
    json!({ "file": FileHash::of(bytes).to_string(), "type": kind, "size": bytes.len(), "emoji": "😺", "w": 512, "h": 512 })
}

fn manifest(m: &Member, server_id: &str, pack: &PackId, stickers: Vec<Value>) -> Envelope {
    let p = json!({
        "v": 1,
        "packId": pack.to_string(),
        "serverId": server_id,
        "author": m.user.to_string(),
        "name": "Котики",
        "created": 1,
        "stickers": stickers,
    });
    testkit::seal(&m.key, Kind::StickerPack, &p.to_string())
}

async fn put_file(srv: &TestServer, m: &Member, pack: &PackId, bytes: &[u8]) -> Res {
    m.send_bytes(
        srv,
        "PUT",
        &format!("/v1/packs/{pack}/files/{}", FileHash::of(bytes)),
        bytes.to_vec(),
    )
    .await
}

async fn publish(srv: &TestServer, m: &Member, pack: &PackId, env: &Envelope) -> Res {
    m.send(
        srv,
        "PUT",
        &format!("/v1/packs/{pack}"),
        Some(&env_json(env).to_string()),
    )
    .await
}

/// Uploads the files and publishes a pack; returns the files.
async fn full_pack(srv: &TestServer, m: &Member, pack: &PackId) -> Vec<Vec<u8>> {
    let files = vec![webp(1, 300), tgs(2, 200)];
    for f in &files {
        let r = put_file(srv, m, pack, f).await;
        assert_eq!(r.status, 200, "{}", text(&r));
    }
    let env = manifest(
        m,
        &srv.server_id(),
        pack,
        vec![sticker_json(&files[0], "webp"), sticker_json(&files[1], "tgs")],
    );
    let r = publish(srv, m, pack, &env).await;
    assert_eq!(r.status, 200, "{}", text(&r));
    files
}

#[tokio::test]
async fn publish_list_fetch_and_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let pack = new_pack();

    // A draft is invisible to everyone, its files too.
    let a = webp(1, 300);
    let r = put_file(&srv, &mama, &pack, &a).await;
    assert_eq!(r.status, 200, "{}", text(&r));
    assert_eq!(r.json()["type"], "webp");
    assert_eq!(r.json()["size"], 300);
    // Repeating an upload is fine.
    assert_eq!(put_file(&srv, &mama, &pack, &a).await.status, 200);
    assert_eq!(papa.get(&srv, "/v1/packs").await.json()["packs"], json!([]));
    assert_eq!(papa.get(&srv, &format!("/v1/packs/{pack}")).await.status, 404);
    assert_eq!(
        papa.get(&srv, &format!("/v1/packs/{pack}/files/{}", FileHash::of(&a)))
            .await
            .status,
        404
    );
    // Somebody else cannot add files to it.
    assert_eq!(
        err(&put_file(&srv, &papa, &pack, &tgs(9, 50)).await),
        (403, "not_owner".into())
    );

    // An extra uploaded file that the manifest does not list is dropped on publishing.
    let extra = webp(7, 100);
    assert_eq!(put_file(&srv, &mama, &pack, &extra).await.status, 200);
    let b = tgs(2, 200);
    assert_eq!(put_file(&srv, &mama, &pack, &b).await.status, 200);
    let env = manifest(
        &mama,
        &srv.server_id(),
        &pack,
        vec![sticker_json(&a, "webp"), sticker_json(&b, "tgs")],
    );
    let r = publish(&srv, &mama, &pack, &env).await;
    assert_eq!(r.status, 200, "{}", text(&r));
    assert_eq!(r.json()["bytes"], 500);
    assert!(
        !tmp.path()
            .join("packs")
            .join(pack.to_string())
            .join(format!("{}.webp", FileHash::of(&extra)))
            .exists()
    );

    // Every member sees it, with the manifest exactly as signed.
    let list = papa.get(&srv, "/v1/packs").await.json()["packs"].clone();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["packId"], pack.to_string());
    assert_eq!(list[0]["owner"], mama.user.to_string());
    assert_eq!(list[0]["manifest"], env_json(&env));
    let f = papa
        .get(&srv, &format!("/v1/packs/{pack}/files/{}", FileHash::of(&a)))
        .await;
    assert_eq!(f.status, 200);
    assert_eq!(f.body, a);
    assert_eq!(f.header("content-type"), Some("application/octet-stream"));
    assert_eq!(f.header("content-disposition"), Some("attachment"));
    assert!(f.header("content-security-policy").unwrap().contains("sandbox"));
    assert_eq!(
        papa.get(&srv, &format!("/v1/packs/{pack}/files/{}", FileHash::of(&extra)))
            .await
            .status,
        404
    );

    // Published means immutable; publishing the same manifest again is fine.
    assert_eq!(publish(&srv, &mama, &pack, &env).await.status, 200);
    assert_eq!(
        err(&put_file(&srv, &mama, &pack, &webp(3, 64)).await),
        (409, "pack_published".into())
    );
    let other = manifest(&mama, &srv.server_id(), &pack, vec![sticker_json(&a, "webp")]);
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &other).await),
        (409, "pack_published".into())
    );

    // Only the uploader deletes it, for everyone.
    let path = format!("/v1/packs/{pack}");
    assert_eq!(
        err(&papa.send(&srv, "DELETE", &path, None).await),
        (403, "not_owner".into())
    );
    assert_eq!(mama.send(&srv, "DELETE", &path, None).await.status, 204);
    assert_eq!(
        err(&mama.send(&srv, "DELETE", &path, None).await),
        (404, "pack_not_found".into())
    );
    assert_eq!(papa.get(&srv, "/v1/packs").await.json()["packs"], json!([]));
    assert_eq!(
        papa.get(&srv, &format!("/v1/packs/{pack}/files/{}", FileHash::of(&a)))
            .await
            .status,
        404
    );
    assert!(!tmp.path().join("packs").join(pack.to_string()).exists());

    // Without a token: nothing.
    let anon = get(&srv.url("/v1/packs")).await;
    assert_eq!(anon.status, 401);
}

#[tokio::test]
async fn files_are_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, _) = family(&srv).await;
    let pack = new_pack();

    // The name must be the hash of the bytes.
    let a = webp(1, 300);
    let wrong = FileHash::of(b"something else");
    let r = mama
        .send_bytes(&srv, "PUT", &format!("/v1/packs/{pack}/files/{wrong}"), a.clone())
        .await;
    assert_eq!(err(&r), (400, "hash_mismatch".into()));
    // Only WebP and gzip (.tgs); never SVG, HTML or PNG.
    for bad in [
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".to_vec(),
        b"<!doctype html><script>alert(1)</script>".to_vec(),
        b"\x89PNG\r\n\x1a\n0000".to_vec(),
        Vec::new(),
    ] {
        assert_eq!(
            err(&put_file(&srv, &mama, &pack, &bad).await),
            (400, "bad_sticker".into())
        );
    }
    // Size limits per type.
    let big_tgs = tgs(1, fcd::envelope::MAX_TGS_BYTES as usize + 1);
    assert_eq!(
        err(&put_file(&srv, &mama, &pack, &big_tgs).await),
        (413, "too_large".into())
    );
    let big_webp = webp(1, fcd::envelope::MAX_WEBP_BYTES as usize + 1);
    assert_eq!(
        err(&put_file(&srv, &mama, &pack, &big_webp).await),
        (413, "too_large".into())
    );
    let ok_webp = webp(2, fcd::envelope::MAX_WEBP_BYTES as usize);
    assert_eq!(put_file(&srv, &mama, &pack, &ok_webp).await.status, 200);
    // Bad identifiers.
    assert_eq!(
        mama.send_bytes(&srv, "PUT", "/v1/packs/XYZ/files/abc", a.clone())
            .await
            .status,
        400
    );
    assert_eq!(
        mama.send_bytes(&srv, "PUT", &format!("/v1/packs/{pack}/files/..%2Fx"), a.clone())
            .await
            .status,
        400
    );
    // Nothing was stored for the rejected uploads.
    let files: Vec<_> = std::fs::read_dir(tmp.path().join("packs").join(pack.to_string()))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    let mut files = files;
    files.sort();
    assert_eq!(
        files,
        vec![format!("{}.webp", FileHash::of(&ok_webp)), "meta.json".into()]
    );
}

#[tokio::test]
async fn manifests_are_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let sid = srv.server_id();
    let pack = new_pack();
    let a = webp(1, 300);
    assert_eq!(put_file(&srv, &mama, &pack, &a).await.status, 200);
    let ok = vec![sticker_json(&a, "webp")];

    // A file that was not uploaded, or with another size or type.
    let missing = webp(5, 100);
    let env = manifest(
        &mama,
        &sid,
        &pack,
        vec![sticker_json(&a, "webp"), sticker_json(&missing, "webp")],
    );
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &env).await),
        (409, "missing_file".into())
    );
    let mut s = sticker_json(&a, "webp");
    s["size"] = json!(299);
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, vec![s])).await),
        (409, "file_mismatch".into())
    );
    let mut s = sticker_json(&a, "webp");
    s["type"] = json!("tgs");
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, vec![s])).await),
        (409, "file_mismatch".into())
    );

    // Another server, another pack id, another author, a forged signature.
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, "other-server", &pack, ok.clone())).await),
        (400, "bad_manifest".into())
    );
    let r = publish(&srv, &mama, &pack, &manifest(&mama, &sid, &new_pack(), ok.clone())).await;
    assert_eq!(r.status, 400);
    assert_eq!(
        err(&publish(&srv, &papa, &pack, &manifest(&mama, &sid, &pack, ok.clone())).await),
        (403, "not_author".into())
    );
    let good = manifest(&mama, &sid, &pack, ok.clone());
    let forged = Envelope {
        payload: good.payload.clone(),
        sig: manifest(&papa, &sid, &pack, ok.clone()).sig,
    };
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &forged).await),
        (400, "bad_signature".into())
    );
    // Signed as another kind of envelope.
    let raw = String::from_utf8(B64.decode(&good.payload).unwrap()).unwrap();
    let as_profile = testkit::seal(&mama.key, Kind::Profile, &raw);
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &as_profile).await),
        (400, "bad_signature".into())
    );
    // Papa cannot publish mama's draft even with his own manifest.
    assert_eq!(
        err(&publish(&srv, &papa, &pack, &manifest(&papa, &sid, &pack, ok.clone())).await),
        (403, "not_owner".into())
    );
    // A pack nobody uploaded.
    let empty = new_pack();
    assert_eq!(
        err(&publish(&srv, &mama, &empty, &manifest(&mama, &sid, &empty, ok.clone())).await),
        (404, "pack_not_found".into())
    );

    // Field rules.
    let bad_fields = [
        json!({ "file": "x", "type": "webp", "size": 300, "emoji": "😺", "w": 512, "h": 512 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "svg", "size": 300, "emoji": "😺", "w": 512, "h": 512 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "webp", "size": 300, "emoji": "", "w": 512, "h": 512 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "webp", "size": 300, "emoji": "😺\u{202e}", "w": 512, "h": 512 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "webp", "size": 300, "emoji": "😺", "w": 0, "h": 512 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "webp", "size": 300, "emoji": "😺", "w": 512, "h": 5000 }),
        json!({ "file": FileHash::of(&a).to_string(), "type": "webp", "size": 0, "emoji": "😺", "w": 512, "h": 512 }),
    ];
    for s in bad_fields {
        let r = publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, vec![s.clone()])).await;
        assert_eq!(err(&r), (400, "bad_manifest".into()), "{s}");
    }
    // Twice the same file, no stickers, too many stickers.
    let twice = vec![sticker_json(&a, "webp"), sticker_json(&a, "webp")];
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, twice)).await).1,
        "bad_manifest"
    );
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, vec![])).await).1,
        "bad_manifest"
    );
    let many: Vec<Value> = (0..=fcd::envelope::MAX_PACK_STICKERS)
        .map(|i| {
            let f = webp((i % 250) as u8, 20 + i);
            sticker_json(&f, "webp")
        })
        .collect();
    assert_eq!(
        err(&publish(&srv, &mama, &pack, &manifest(&mama, &sid, &pack, many)).await).1,
        "bad_manifest"
    );
    // A long name.
    let p = json!({"v":1,"packId":pack.to_string(),"serverId":sid,"author":mama.user.to_string(),"name":"я".repeat(65),"created":1,"stickers":ok});
    let env = testkit::seal(&mama.key, Kind::StickerPack, &p.to_string());
    assert_eq!(err(&publish(&srv, &mama, &pack, &env).await).1, "bad_manifest");

    // After all that, the right manifest still works.
    assert_eq!(publish(&srv, &mama, &pack, &good).await.status, 200);
}

#[tokio::test]
async fn pack_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, _) = family(&srv).await;

    // At most 200 files in one pack.
    let pack = new_pack();
    for i in 0..fcd::envelope::MAX_PACK_STICKERS {
        let f = tgs((i % 250) as u8, 6 + i);
        let r = put_file(&srv, &mama, &pack, &f).await;
        assert_eq!(r.status, 200, "{}", text(&r));
    }
    let over = tgs(1, 5000);
    assert_eq!(
        err(&put_file(&srv, &mama, &pack, &over).await),
        (413, "too_large".into())
    );

    // At most MAX_PACKS packs on a server (drafts count).
    for _ in 1..fcd::packs::MAX_PACKS {
        assert_eq!(put_file(&srv, &mama, &new_pack(), &webp(1, 40)).await.status, 200);
    }
    assert_eq!(
        err(&put_file(&srv, &mama, &new_pack(), &webp(1, 40)).await),
        (507, "too_many_packs".into())
    );
}

#[tokio::test]
async fn packs_survive_a_restart_and_drafts_expire() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let srv = start(&data, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let pack = new_pack();
    let files = full_pack(&srv, &mama, &pack).await;
    let draft = new_pack();
    assert_eq!(put_file(&srv, &mama, &draft, &webp(4, 100)).await.status, 200);
    let before = papa.get(&srv, "/v1/packs").await.json();
    srv.stop().await;

    let srv = open(&data, Overrides::default()).await;
    let after = papa.get(&srv, "/v1/packs").await.json();
    assert_eq!(after, before);
    let f = papa
        .get(&srv, &format!("/v1/packs/{pack}/files/{}", FileHash::of(&files[1])))
        .await;
    assert_eq!(f.body, files[1]);
    // The draft is still mama's after the restart.
    assert_eq!(
        err(&put_file(&srv, &papa, &draft, &webp(5, 100)).await),
        (403, "not_owner".into())
    );

    // Retention of messages does not touch packs; unpublished drafts go after a day.
    let now = fcd::datadir::now_ms();
    srv.state
        .store
        .write(move |w| w.retention(now + 400 * 86_400_000))
        .await;
    assert_eq!(srv.state.packs.remove_stale_drafts(now), 0);
    assert_eq!(
        srv.state
            .packs
            .remove_stale_drafts(now + fcd::packs::DRAFT_TTL_MS + 60_000),
        1
    );
    assert!(!data.join("packs").join(draft.to_string()).exists());
    assert!(data.join("packs").join(pack.to_string()).join("pack.json").exists());
    assert_eq!(papa.get(&srv, "/v1/packs").await.json(), before);
}

#[tokio::test]
async fn hello_and_cors_mention_m5() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let h = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(h["maxPackStickers"], fcd::envelope::MAX_PACK_STICKERS);
    assert_eq!(h["maxPackBytes"], fcd::envelope::MAX_PACK_BYTES);
    let pre = request(
        "OPTIONS",
        &srv.url("/v1/chats/x/events"),
        &[
            ("Origin", "https://other.example"),
            ("Access-Control-Request-Headers", "x-fc-push"),
        ],
        None,
    )
    .await;
    assert!(
        pre.header("access-control-allow-headers")
            .unwrap()
            .contains("X-FC-Push")
    );
    // The share target without a service worker: back to the app with an explanation.
    let r = request(
        "POST",
        &srv.url("/share-target"),
        &[("Content-Type", "multipart/form-data; boundary=x")],
        Some("--x--"),
    )
    .await;
    assert_eq!(r.status, 303);
    assert_eq!(r.header("location"), Some("./?share=unavailable"));
}

/// A folder of an earlier build (no `packs/`) opens without a format change.
#[tokio::test]
async fn older_folder_gets_packs() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/m1/data");
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    copy_dir(&fixture, &data);
    assert!(!data.join("packs").exists());
    let srv = open(&data, Overrides::default()).await;
    assert!(data.join("packs").is_dir());
    let server: Value = serde_json::from_slice(&std::fs::read(data.join("server.json")).unwrap()).unwrap();
    assert_eq!(
        server["formatVersion"], 2,
        "packs/ is an addition: the format number stays"
    );
    assert!(srv.state.packs.published().is_empty());
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()));
        } else {
            std::fs::copy(&p, to.join(e.file_name())).unwrap();
        }
    }
}

// ---- the no-push hint ----

#[derive(Clone, Default)]
struct FakePush {
    got: Arc<Mutex<Vec<String>>>,
    status: Arc<AtomicU16>,
}

async fn fake_push() -> (String, FakePush) {
    let fake = FakePush::default();
    fake.status.store(201, Ordering::SeqCst);
    let f2 = fake.clone();
    let app = axum::Router::new().route(
        "/push/{id}",
        axum::routing::post(
            move |axum::extract::Path(id): axum::extract::Path<String>, _body: Bytes| {
                let f = f2.clone();
                async move {
                    f.got.lock().unwrap().push(id);
                    axum::http::StatusCode::from_u16(f.status.load(Ordering::SeqCst)).unwrap()
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), fake)
}

fn subscription(endpoint: &str) -> String {
    let ua = loop {
        if let Ok(k) = SecretKey::from_slice(&fcd::webpush::random_bytes::<32>()) {
            break k;
        }
    };
    json!({
        "endpoint": endpoint,
        "keys": { "p256dh": B64.encode(ua.public_key().to_sec1_bytes()), "auth": B64.encode(fcd::webpush::random_bytes::<16>()) }
    })
    .to_string()
}

async fn post_with(srv: &TestServer, m: &Member, chat: &fcd::ids::ChatId, hint: Option<&str>) -> Res {
    let mut headers = vec![
        ("Authorization".to_string(), m.auth()),
        ("Content-Type".to_string(), "application/octet-stream".to_string()),
        ("Idempotency-Key".to_string(), new_msg_id()),
        ("X-FC-Epoch".to_string(), "0".to_string()),
    ];
    if let Some(h) = hint {
        headers.push(("X-FC-Push".to_string(), h.to_string()));
    }
    let refs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    request_bytes(
        "POST",
        &srv.url(&format!("/v1/chats/{chat}/events")),
        &refs,
        b"FC1 body".to_vec(),
    )
    .await
}

#[tokio::test]
async fn no_push_hint_skips_the_notification() {
    let (service, fake) = fake_push().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    assert_eq!(
        papa.send(
            &srv,
            "PUT",
            "/v1/me/push",
            Some(&subscription(&format!("{service}/push/papa")))
        )
        .await
        .status,
        204
    );
    let chat = mama.chat_with(&srv.server_id(), &papa);

    // A reaction, an edit or a deletion: delivered, but no push.
    let r = post_with(&srv, &mama, &chat, Some("none")).await;
    assert_eq!(r.status, 200, "{}", text(&r));
    let silent_gseq = r.json()["gseq"].as_u64().unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(fake.got.lock().unwrap().is_empty(), "no push for a hinted event");
    assert!(
        papa.feed(&srv, 0).await.iter().any(|e| e["gseq"] == silent_gseq),
        "still delivered"
    );

    // An unknown value is an error (nothing stored).
    let r = post_with(&srv, &mama, &chat, Some("later")).await;
    assert_eq!(err(&r), (400, "bad_request".into()));

    // An ordinary message notifies as before.
    assert_eq!(post_with(&srv, &mama, &chat, None).await.status, 200);
    let deadline = Instant::now() + Duration::from_secs(5);
    while fake.got.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "push expected");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*fake.got.lock().unwrap(), vec!["papa".to_string()]);
}
