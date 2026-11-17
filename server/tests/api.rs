//! The base API over HTTP on a temporary data folder.

mod common;

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use common::*;
use fcd::config::Overrides;
use fcd::envelope::{Kind, testkit};
use fcd::ids::ChatId;
use p256::SecretKey;
use serde_json::json;

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

#[cfg(unix)]
fn mode(p: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

fn all_files(p: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(p).unwrap().flatten() {
        out.push(e.path());
        if e.path().is_dir() {
            all_files(&e.path(), out);
        }
    }
}

#[tokio::test]
async fn admin_code_works_once_and_files_are_private() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let srv = start(&data, Overrides::default()).await;
    let hello = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(hello["adminCodeActive"], true);
    assert_eq!(hello["maxEventBytes"], 262144);
    let admin = join(&srv, "Мама", "adminCode", &srv.setup_code).await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["adminCodeActive"], false);

    let me = admin.get(&srv, "/v1/me").await;
    assert_eq!(me.status, 200);
    let j = me.json();
    assert_eq!(j["admin"], true);
    assert_eq!(j["userId"], admin.user.to_string());
    assert_eq!(j["devId"], admin.dev.to_string());
    assert_eq!(j["push"], false);
    assert_eq!(j["identity"], env_json(&admin.identity));

    // The code is spent.
    let key = new_key();
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&key, "Чужой", "adminCode", &srv.setup_code, &new_dev())),
    )
    .await;
    assert_eq!(res.status, 403, "{}", text(&res));
    assert_eq!(res.json()["error"], "invalid_code");
    let server: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("server.json")).unwrap()).unwrap();
    assert_eq!(server["adminCodeHash"], "");
    assert_eq!(server["admins"], json!([admin.user.to_string()]));

    // Tokens and codes are not on disk; everything is owner-only.
    let mut files = Vec::new();
    all_files(&data, &mut files);
    for f in &files {
        if f.is_file() {
            let content = std::fs::read(f).unwrap();
            let s = String::from_utf8_lossy(&content);
            assert!(!s.contains(&admin.token), "{}", f.display());
            assert!(!s.contains(&srv.admin_code), "{}", f.display());
            assert!(!s.contains(&srv.setup_code), "{}", f.display());
        }
        #[cfg(unix)]
        {
            let want = if f.is_dir() { 0o700 } else { 0o600 };
            assert_eq!(mode(f), want, "{}", f.display());
        }
    }
    #[cfg(unix)]
    assert_eq!(mode(&data), 0o700);
    assert!(
        data.join("users")
            .join(admin.user.to_string())
            .join("devices")
            .join(format!("{}.json", admin.dev))
            .is_file()
    );
}

#[tokio::test]
async fn invitation_is_one_time_and_expires() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let admin = join(&srv, "Мама", "adminCode", &srv.setup_code).await;
    let res = admin.send(&srv, "POST", "/v1/admin/invites", None).await;
    assert_eq!(res.status, 201);
    let inv = res.json();
    let code = inv["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 26);
    assert_eq!(
        inv["expiresAt"].as_u64().unwrap() - inv["createdAt"].as_u64().unwrap(),
        7 * 86_400_000
    );
    let id = inv["id"].as_str().unwrap().to_string();
    // Only the hash is stored.
    let stored = std::fs::read_to_string(tmp.path().join("invites").join(format!("{id}.json"))).unwrap();
    assert!(!stored.contains(&code));

    let papa = join(&srv, "Папа", "invite", &code).await;
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&new_key(), "Ещё", "invite", &code, &new_dev())),
    )
    .await;
    assert_eq!(res.status, 410);
    assert_eq!(res.json()["error"], "invite_used");

    let list = admin.get(&srv, "/v1/admin/invites").await.json();
    assert_eq!(list["invites"][0]["usedBy"], papa.user.to_string());
    assert!(list["invites"][0]["code"].is_null());

    // Unknown code.
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&new_key(), "X", "invite", &new_msg_id(), &new_dev())),
    )
    .await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "invalid_invite");

    // Revoked invitation.
    let code2 = invite(&srv, &admin).await;
    let id2 = fcd::store::invite_hash(&code2);
    let res = admin
        .send(&srv, "DELETE", &format!("/v1/admin/invites/{id2}"), None)
        .await;
    assert_eq!(res.status, 204);
    assert_eq!(
        admin
            .send(&srv, "DELETE", &format!("/v1/admin/invites/{id2}"), None)
            .await
            .status,
        404
    );
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&new_key(), "X", "invite", &code2, &new_dev())),
    )
    .await;
    assert_eq!(res.status, 403);

    // Non-admins cannot invite.
    let res = papa.send(&srv, "POST", "/v1/admin/invites", None).await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "not_admin");

    // An existing member cannot join again.
    let code3 = invite(&srv, &admin).await;
    let mut body: serde_json::Value =
        serde_json::from_str(&join_body(&papa.key, "Папа", "invite", &code3, &new_dev())).unwrap();
    body["invite"] = json!(code3);
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&body.to_string()),
    )
    .await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "already_member");

    // Expired: move the expiry into the past and restart.
    let id3 = fcd::store::invite_hash(&code3);
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let p = data.join("invites").join(format!("{id3}.json"));
    let mut f: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    f["expiresAt"] = json!(fcd::datadir::now_ms() - 1);
    std::fs::write(&p, f.to_string()).unwrap();
    let srv = open(&data, Overrides::default()).await;
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&new_key(), "X", "invite", &code3, &new_dev())),
    )
    .await;
    // The hourly cleanup ran at start and removed it, or it is reported expired.
    assert!(res.status == 410 || res.status == 403, "{}", text(&res));
}

#[tokio::test]
async fn direct_messages_long_poll_and_history() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let sid = srv.server_id();
    let chat = mama.chat_with(&sid, &papa);
    assert_eq!(chat, papa.chat_with(&sid, &mama));

    // The chat does not exist yet, but its history is readable (empty).
    let res = papa.get(&srv, &format!("/v1/chats/{chat}/events")).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["events"], json!([]));
    assert_eq!(res.json()["cursor"], 1, "no huge numbers for JavaScript");

    let res = mama.post_event(&srv, &chat, &new_msg_id(), b"cipher-1").await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let j = res.json();
    assert_eq!(j["gseq"], 1);
    assert_eq!(j["duplicate"], false);
    let now = fcd::datadir::now_ms();
    assert!(now - j["time"].as_u64().unwrap() < 5000);

    let chats = papa.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"][0]["chatId"], chat.to_string());
    assert_eq!(chats["chats"][0]["kind"], "dm");
    assert_eq!(chats["chats"][0]["epoch"], 0);
    assert_eq!(chats["chats"][0]["lastGseq"], 1);
    let mut members: Vec<String> = vec![mama.user.to_string(), papa.user.to_string()];
    members.sort();
    assert_eq!(chats["chats"][0]["members"], json!(members));

    let feed = papa.get(&srv, "/v1/events?after=0").await.json();
    assert_eq!(feed["events"].as_array().unwrap().len(), 1);
    let ev = &feed["events"][0];
    assert_eq!(ev["chatId"], chat.to_string());
    assert_eq!(ev["senderId"], mama.user.to_string());
    assert_eq!(ev["devId"], mama.dev.to_string());
    assert_eq!(ev["epoch"], 0);
    assert_eq!(b64d(&ev["body"]), b"cipher-1");
    assert_eq!(feed["cursor"], 1);
    assert_eq!(feed["more"], false);
    assert_eq!(feed["oldestGseq"], 1);

    // Long poll wakes up on a new event.
    let url = srv.url("/v1/events?after=1&wait=20");
    let auth = papa.auth();
    let t = Instant::now();
    let pending = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!pending.is_finished());
    let res = papa.post_event(&srv, &chat, &new_msg_id(), b"cipher-2").await;
    assert_eq!(res.json()["gseq"], 2);
    let res = pending.await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    let feed = res.json();
    assert_eq!(feed["events"][0]["gseq"], 2);
    assert_eq!(b64d(&feed["events"][0]["body"]), b"cipher-2");
    assert_eq!(feed["cursor"], 2);

    // An empty long poll ends at its wait.
    let t = Instant::now();
    let feed = mama.get(&srv, "/v1/events?after=2&wait=1").await.json();
    assert!(t.elapsed() >= Duration::from_millis(900));
    assert_eq!(feed["events"], json!([]));
    assert_eq!(feed["cursor"], 2);

    // Paging: limit and cursor.
    for i in 3..=6 {
        let r = mama
            .post_event(&srv, &chat, &new_msg_id(), format!("c{i}").as_bytes())
            .await;
        assert_eq!(r.json()["gseq"], i);
    }
    let p1 = papa.get(&srv, "/v1/events?after=0&limit=4").await.json();
    assert_eq!(p1["events"].as_array().unwrap().len(), 4);
    assert_eq!(p1["more"], true);
    assert_eq!(p1["cursor"], 4);
    let p2 = papa.get(&srv, "/v1/events?after=4&limit=4").await.json();
    assert_eq!(p2["events"].as_array().unwrap().len(), 2);
    assert_eq!(p2["more"], false);
    assert_eq!(p2["cursor"], 6);

    // History backwards.
    let h = papa.get(&srv, &format!("/v1/chats/{chat}/events?limit=2")).await.json();
    let gs: Vec<u64> = h["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["gseq"].as_u64().unwrap())
        .collect();
    assert_eq!(gs, vec![5, 6]);
    assert_eq!(h["more"], true);
    assert_eq!(h["cursor"], 5);
    let h = papa
        .get(&srv, &format!("/v1/chats/{chat}/events?before=5&limit=10"))
        .await
        .json();
    assert_eq!(h["events"].as_array().unwrap().len(), 4);
    assert_eq!(h["more"], false);
    assert_eq!(h["events"][0]["gseq"], 1);

    // Wait is capped at 30 s, limit at 500: both accepted.
    assert_eq!(papa.get(&srv, "/v1/events?after=6&wait=0&limit=9999").await.status, 200);
    assert_eq!(papa.get(&srv, "/v1/events?after=x").await.status, 400);

    // Users list.
    let users = papa.get(&srv, "/v1/users").await.json();
    assert_eq!(users["users"].as_array().unwrap().len(), 2);
    for u in users["users"].as_array().unwrap() {
        assert!(u["identity"]["payload"].is_string());
        assert!(u["profile"]["sig"].is_string());
        assert_eq!(u["removed"], false);
        assert_eq!(u["admin"], u["userId"] == mama.user.to_string());
    }
}

#[tokio::test]
async fn idempotent_repeat() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let code = invite(&srv, &mama).await;
    let son = join(&srv, "Сын", "invite", &code).await;
    let sid = srv.server_id();
    let chat = mama.chat_with(&sid, &papa);
    let key = new_msg_id();
    let a = mama.post_event(&srv, &chat, &key, b"one").await.json();
    let b = mama.post_event(&srv, &chat, &key, b"one again").await.json();
    assert_eq!(a["gseq"], b["gseq"]);
    assert_eq!(a["time"], b["time"]);
    assert_eq!(b["duplicate"], true);
    let feed = papa.get(&srv, "/v1/events").await.json();
    assert_eq!(feed["events"].as_array().unwrap().len(), 1);
    assert_eq!(b64d(&feed["events"][0]["body"]), b"one");
    assert_eq!(feed["events"][0]["msgId"], key);

    // The same key in another chat is a conflict; another sender may use it.
    let other = mama.chat_with(&sid, &son);
    let res = mama.post_event(&srv, &other, &key, b"x").await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "idempotency_conflict");
    let res = papa.post_event(&srv, &chat, &key, b"papa").await;
    assert_eq!(res.json()["duplicate"], false);
}

#[tokio::test]
async fn foreign_chat_is_forbidden() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let code = invite(&srv, &mama).await;
    let son = join(&srv, "Сын", "invite", &code).await;
    let sid = srv.server_id();
    let chat = mama.chat_with(&sid, &papa);
    assert_eq!(mama.post_event(&srv, &chat, &new_msg_id(), b"secret").await.status, 200);

    let res = son.get(&srv, &format!("/v1/chats/{chat}/events")).await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "not_member");
    let res = son.post_event(&srv, &chat, &new_msg_id(), b"intrude").await;
    assert_eq!(res.status, 403);
    let feed = son.get(&srv, "/v1/events?after=0").await.json();
    assert_eq!(feed["events"], json!([]));
    assert_eq!(son.get(&srv, "/v1/chats").await.json()["chats"], json!([]));

    // A chat id nobody can derive.
    let random = ChatId(fcd::webpush::random_bytes::<16>());
    let res = son.post_event(&srv, &random, &new_msg_id(), b"x").await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["error"], "chat_not_found");
    assert_eq!(son.get(&srv, &format!("/v1/chats/{random}/events")).await.status, 404);
    // (The chat with oneself: tests/groups.rs.)
    let _ = sid;
    assert_eq!(son.get(&srv, "/v1/chats/NOT-AN-ID/events").await.status, 400);

    // Without or with a wrong token.
    assert_eq!(get(&srv.url("/v1/events")).await.status, 401);
    let res = request("GET", &srv.url("/v1/events"), &[("Authorization", "Bearer AAAA")], None).await;
    assert_eq!(res.status, 401);
    assert_eq!(res.header("www-authenticate"), Some("Bearer"));
    assert_eq!(res.json()["error"], "unauthorized");
}

#[tokio::test]
async fn size_and_header_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let chat = mama.chat_with(&srv.server_id(), &papa);

    let max = vec![7u8; 256 * 1024];
    let res = mama.post_event(&srv, &chat, &new_msg_id(), &max).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let feed = papa.get(&srv, "/v1/events").await.json();
    assert_eq!(b64d(&feed["events"][0]["body"]), max);

    let res = mama
        .post_event(&srv, &chat, &new_msg_id(), &vec![7u8; 256 * 1024 + 1])
        .await;
    assert_eq!(res.status, 413);
    assert_eq!(res.json()["error"], "too_large");
    assert_eq!(res.json()["limit"], 262144);
    assert_eq!(mama.post_event(&srv, &chat, &new_msg_id(), b"").await.status, 400);

    let url = srv.url(&format!("/v1/chats/{chat}/events"));
    let auth = mama.auth();
    let no_key = request(
        "POST",
        &url,
        &[("Authorization", &auth), ("X-FC-Epoch", "0")],
        Some("x"),
    )
    .await;
    assert_eq!(no_key.status, 400);
    let bad_key = request(
        "POST",
        &url,
        &[
            ("Authorization", &auth),
            ("X-FC-Epoch", "0"),
            ("Idempotency-Key", "abc"),
        ],
        Some("x"),
    )
    .await;
    assert_eq!(bad_key.status, 400);
    let id = new_msg_id();
    let no_epoch = request(
        "POST",
        &url,
        &[("Authorization", &auth), ("Idempotency-Key", &id)],
        Some("x"),
    )
    .await;
    assert_eq!(no_epoch.status, 400);
    let wrong_epoch = request(
        "POST",
        &url,
        &[("Authorization", &auth), ("Idempotency-Key", &id), ("X-FC-Epoch", "3")],
        Some("x"),
    )
    .await;
    assert_eq!(wrong_epoch.status, 409);
    assert_eq!(wrong_epoch.json()["error"], "epoch_mismatch");
    assert_eq!(wrong_epoch.json()["epoch"], 0);

    // JSON bodies are limited to 64 KiB.
    let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(70 * 1024));
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&big),
    )
    .await;
    assert_eq!(res.status, 413);

    // Profile name limit.
    let p = testkit::profile(&mama.key, &mama.user, &"й".repeat(65), 5);
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
        .await;
    assert_eq!(res.status, 400);
}

#[tokio::test]
async fn profile_update_rules() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let p = testkit::profile(&mama.key, &mama.user, "Мама Оля", 2);
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
        .await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["profile"], env_json(&p));
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
        .await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "stale_rev");
    // Signed by somebody else.
    let forged = testkit::profile(&papa.key, &mama.user, "Чужое", 3);
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&forged).to_string()))
        .await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "bad_signature");
    // Control and bidirectional characters are rejected, as in packages/protocol.
    for bad in ["Ма\u{202e}ма", "Мама\u{7}", "\u{2066}Мама\u{2069}", "\u{feff}"] {
        let p = testkit::profile(&mama.key, &mama.user, bad, 3);
        let res = mama
            .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
            .await;
        assert_eq!(res.status, 400, "{bad:?}");
        assert_eq!(res.json()["error"], "bad_request");
    }
    // Another user's profile.
    let other = testkit::profile(&mama.key, &papa.user, "x", 3);
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&other).to_string()))
        .await;
    assert_eq!(res.status, 400);
    let users = papa.get(&srv, "/v1/users").await.json();
    let m = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == mama.user.to_string())
        .unwrap()
        .clone();
    assert_eq!(m["profile"], env_json(&p));
}

#[tokio::test]
async fn second_device_by_signature() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let sid = srv.server_id();

    let ch = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json();
    let nonce = ch["nonce"].as_str().unwrap().to_string();
    assert_eq!(B64.decode(&nonce).unwrap().len(), 32);
    let dev2 = new_dev();
    let env = papa.auth_envelope(&sid, &nonce, &dev2);
    let body = env_json(&env).to_string();
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&body),
    )
    .await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let j = res.json();
    assert_eq!(j["userId"], papa.user.to_string());
    assert_eq!(j["devId"], dev2.to_string());
    assert_eq!(j["admin"], false);
    let token2 = j["token"].as_str().unwrap().to_string();
    let me = request(
        "GET",
        &srv.url("/v1/me"),
        &[("Authorization", &format!("Bearer {token2}"))],
        None,
    )
    .await
    .json();
    assert_eq!(me["devId"], dev2.to_string());
    // Old device still works.
    assert_eq!(papa.get(&srv, "/v1/me").await.status, 200);

    // The nonce is single use.
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&body),
    )
    .await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "bad_nonce");

    // Signed by another key.
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let p = json!({"v":1,"userId":papa.user.to_string(),"serverId":sid,"nonce":nonce,"devId":new_dev().to_string()});
    let forged = testkit::seal(&mama.key, Kind::Auth, &p.to_string());
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&forged).to_string()),
    )
    .await;
    assert_eq!(res.status, 401);
    assert_eq!(res.json()["error"], "bad_signature");

    // Unknown user.
    let key = new_key();
    let (uid, _) = testkit::identity(&key);
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let p = json!({"v":1,"userId":uid.to_string(),"serverId":sid,"nonce":nonce,"devId":new_dev().to_string()});
    let env = testkit::seal(&key, Kind::Auth, &p.to_string());
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["error"], "unknown_user");

    // Re-login of the same device id replaces its token.
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let env = papa.auth_envelope(&sid, &nonce, &papa.dev);
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(papa.get(&srv, "/v1/me").await.status, 401, "old token replaced");
}

#[tokio::test]
async fn removed_member_is_cut_off() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let chat = mama.chat_with(&srv.server_id(), &papa);
    assert_eq!(mama.post_event(&srv, &chat, &new_msg_id(), b"hi").await.status, 200);

    // Papa waits for events; removal ends the wait with 403.
    let url = srv.url("/v1/events?after=1&wait=20");
    let auth = papa.auth();
    let pending = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        papa.send(&srv, "DELETE", &format!("/v1/admin/users/{}", mama.user), None)
            .await
            .status,
        403
    );
    let res = mama
        .send(&srv, "DELETE", &format!("/v1/admin/users/{}", mama.user), None)
        .await;
    assert_eq!(res.status, 409);
    let res = mama
        .send(&srv, "DELETE", &format!("/v1/admin/users/{}", papa.user), None)
        .await;
    assert_eq!(res.status, 204);

    let res = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "removed");
    let res = papa.get(&srv, "/v1/me").await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "removed");
    assert_eq!(papa.post_event(&srv, &chat, &new_msg_id(), b"x").await.status, 403);
    let res = mama.post_event(&srv, &chat, &new_msg_id(), b"x").await;
    assert_eq!(res.status, 403);
    assert_eq!(res.json()["error"], "peer_removed");

    // No new device by signature either.
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let env = papa.auth_envelope(&srv.server_id(), &nonce, &new_dev());
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 403);

    let users = mama.get(&srv, "/v1/admin/users").await.json();
    let p = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == papa.user.to_string())
        .unwrap()
        .clone();
    assert_eq!(p["removed"], true);
    assert_eq!(p["name"], "Папа");
    assert!(p["removedAt"].as_u64().is_some());
    assert_eq!(p["devices"].as_array().unwrap().len(), 1);
    let pub_users = mama.get(&srv, "/v1/users").await.json();
    assert!(
        pub_users["users"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["removed"] == true)
    );

    // Stays removed after a restart.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open(&data, Overrides::default()).await;
    assert_eq!(papa.get(&srv, "/v1/me").await.status, 403);
    assert_eq!(mama.get(&srv, "/v1/me").await.status, 200);
}

#[tokio::test]
async fn rate_limit_for_wrong_codes() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let wrong = |xff: &'static str| {
        let url = srv.url("/v1/join");
        async move {
            let body = join_body(&new_key(), "X", "invite", &new_msg_id(), &new_dev());
            request(
                "POST",
                &url,
                &[("Content-Type", "application/json"), ("X-Forwarded-For", xff)],
                Some(&body),
            )
            .await
        }
    };
    for _ in 0..10 {
        assert_eq!(wrong("198.51.100.1").await.status, 403);
    }
    // X-Forwarded-For is ignored by default: all from 127.0.0.1.
    let res = wrong("198.51.100.2").await;
    assert_eq!(res.status, 429);
    assert_eq!(res.json()["error"], "rate_limited");
    assert!(res.header("retry-after").unwrap().parse::<u64>().unwrap() >= 1);
    // The right code is refused too while limited.
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&new_key(), "A", "adminCode", &srv.setup_code, &new_dev())),
    )
    .await;
    assert_eq!(res.status, 429);

    // Behind a trusted proxy, addresses are told apart.
    let tmp2 = tempfile::tempdir().unwrap();
    let srv2 = start(
        tmp2.path(),
        Overrides {
            trust_forwarded_for: Some(true),
            ..Default::default()
        },
    )
    .await;
    let wrong2 = |xff: &'static str| {
        let url = srv2.url("/v1/join");
        async move {
            let body = join_body(&new_key(), "X", "invite", &new_msg_id(), &new_dev());
            request(
                "POST",
                &url,
                &[("Content-Type", "application/json"), ("X-Forwarded-For", xff)],
                Some(&body),
            )
            .await
        }
    };
    for _ in 0..10 {
        assert_eq!(wrong2("203.0.113.9, 198.51.100.1").await.status, 403);
    }
    assert_eq!(wrong2("198.51.100.1").await.status, 429, "rightmost entry counts");
    assert_eq!(wrong2("198.51.100.2").await.status, 403);
}

#[tokio::test]
async fn restart_keeps_events_and_cursors() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_path_buf();
    let srv = start(&data, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let sid = srv.server_id();
    let chat = mama.chat_with(&sid, &papa);
    let first_key = new_msg_id();
    mama.post_event(&srv, &chat, &first_key, b"e1").await;
    mama.post_event(&srv, &chat, &new_msg_id(), b"e2").await;
    papa.post_event(&srv, &chat, &new_msg_id(), b"e3").await;
    let feed = papa.get(&srv, "/v1/events?after=0").await.json();
    let cursor = feed["cursor"].as_u64().unwrap();
    assert_eq!(cursor, 3);
    srv.stop().await;

    let srv = open(&data, Overrides::default()).await;
    assert!(srv.admin_code.is_empty(), "no new admin code");
    let feed = papa.get(&srv, &format!("/v1/events?after={cursor}")).await.json();
    assert_eq!(feed["events"], json!([]));
    assert_eq!(feed["cursor"], 3);
    let res = mama.post_event(&srv, &chat, &new_msg_id(), b"e4").await;
    assert_eq!(res.json()["gseq"], 4);
    // Repeat of an event from before the restart.
    let res = mama.post_event(&srv, &chat, &first_key, b"e1").await.json();
    assert_eq!(res["gseq"], 1);
    assert_eq!(res["duplicate"], true);
    let h = papa.get(&srv, &format!("/v1/chats/{chat}/events")).await.json();
    let bodies: Vec<Vec<u8>> = h["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| b64d(&e["body"]))
        .collect();
    assert_eq!(
        bodies,
        vec![b"e1".to_vec(), b"e2".to_vec(), b"e3".to_vec(), b"e4".to_vec()]
    );
    assert_eq!(papa.get(&srv, "/v1/chats").await.json()["chats"][0]["lastGseq"], 4);
    let today = fcd::ids::day_name(fcd::ids::day_of_ms(fcd::datadir::now_ms()));
    assert!(data.join("log").join(format!("{today}.seg")).is_file());
    assert!(data.join("chats").join(chat.to_string()).join("meta.json").is_file());
}

#[tokio::test]
async fn storage_full_answers_507() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_path_buf();
    let srv = start(&data, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    srv.stop().await;
    let srv = open(
        &data,
        Overrides {
            min_free_mb: Some(u64::MAX / (1024 * 1024)),
            ..Default::default()
        },
    )
    .await;
    let chat = mama.chat_with(&srv.server_id(), &papa);
    let res = mama.post_event(&srv, &chat, &new_msg_id(), b"x").await;
    assert_eq!(res.status, 507, "{}", text(&res));
    assert_eq!(res.json()["error"], "storage_full");
}

#[tokio::test]
async fn admin_stats() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let chat = mama.chat_with(&srv.server_id(), &papa);
    mama.post_event(&srv, &chat, &new_msg_id(), b"x").await;
    let s = mama.get(&srv, "/v1/admin/stats").await;
    assert_eq!(s.status, 200);
    let s = s.json();
    assert_eq!(s["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(s["events"], 1);
    assert_eq!(s["users"], 2);
    assert_eq!(s["chats"], 1);
    assert!(s["dataBytes"].as_u64().unwrap() > 0);
    assert!(s["freeBytes"].as_u64().unwrap() > 0);
    assert_eq!(papa.get(&srv, "/v1/admin/stats").await.status, 403);
    let res = mama.send(&srv, "PATCH", "/v1/admin/stats", None).await;
    assert_eq!(res.status, 405);
    assert_eq!(res.json()["error"], "method_not_allowed");
}

// ---- push on new events ----

#[derive(Clone, Default)]
struct FakePush {
    got: Arc<Mutex<Vec<(String, Bytes)>>>,
    status: Arc<AtomicU16>,
}

async fn fake_push() -> (String, FakePush) {
    let fake = FakePush::default();
    fake.status.store(201, Ordering::SeqCst);
    let f2 = fake.clone();
    let app = axum::Router::new().route(
        "/push/{id}",
        axum::routing::post(
            move |axum::extract::Path(id): axum::extract::Path<String>, body: Bytes| {
                let f = f2.clone();
                async move {
                    f.got.lock().unwrap().push((id, body));
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

fn subscription(endpoint: &str) -> (SecretKey, [u8; 16], String) {
    let ua = loop {
        if let Ok(k) = SecretKey::from_slice(&fcd::webpush::random_bytes::<32>()) {
            break k;
        }
    };
    let auth = fcd::webpush::random_bytes::<16>();
    let body = json!({
        "endpoint": endpoint,
        "keys": { "p256dh": B64.encode(ua.public_key().to_sec1_bytes()), "auth": B64.encode(auth) }
    });
    (ua, auth, body.to_string())
}

async fn wait_for(cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn push_on_new_event() {
    let (service, fake) = fake_push().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let chat = mama.chat_with(&srv.server_id(), &papa);

    let (ua_p, auth_p, sub_p) = subscription(&format!("{service}/push/papa"));
    let (_, _, sub_m) = subscription(&format!("{service}/push/mama"));
    assert_eq!(papa.send(&srv, "PUT", "/v1/me/push", Some(&sub_p)).await.status, 204);
    assert_eq!(mama.send(&srv, "PUT", "/v1/me/push", Some(&sub_m)).await.status, 204);
    assert_eq!(papa.get(&srv, "/v1/me").await.json()["push"], true);
    let (_, _, bad) = subscription("http://192.168.1.10/push/x");
    assert_eq!(papa.send(&srv, "PUT", "/v1/me/push", Some(&bad)).await.status, 400);

    let gseq = mama.post_event(&srv, &chat, &new_msg_id(), b"hello").await.json()["gseq"]
        .as_u64()
        .unwrap();
    wait_for(|| !fake.got.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let got = fake.got.lock().unwrap();
        assert_eq!(got.len(), 1, "only the other member's device");
        assert_eq!(got[0].0, "papa");
        let payload: serde_json::Value = serde_json::from_slice(&decrypt(&ua_p, &auth_p, &got[0].1)).unwrap();
        assert_eq!(payload, json!({ "chatId": chat.to_string(), "gseq": gseq }));
    }

    // The push service says the subscription is gone: it is deleted.
    fake.status.store(410, Ordering::SeqCst);
    mama.post_event(&srv, &chat, &new_msg_id(), b"again").await;
    wait_for(|| fake.got.lock().unwrap().len() == 2).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while papa.get(&srv, "/v1/me").await.json()["push"] != false {
        assert!(Instant::now() < deadline, "subscription not deleted");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let dev_file = tmp
        .path()
        .join("users")
        .join(papa.user.to_string())
        .join("devices")
        .join(format!("{}.json", papa.dev));
    let f: serde_json::Value = serde_json::from_slice(&std::fs::read(dev_file).unwrap()).unwrap();
    assert!(f["push"].is_null());

    // DELETE /v1/me/push.
    assert_eq!(mama.send(&srv, "DELETE", "/v1/me/push", None).await.status, 204);
    assert_eq!(mama.get(&srv, "/v1/me").await.json()["push"], false);
}

/// The sender's other devices are notified too, the sending device is not.
#[tokio::test]
async fn push_reaches_senders_other_devices() {
    let (service, fake) = fake_push().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let tablet = second_device(&srv, &mama).await;
    for (m, name) in [(&mama, "mama-phone"), (&tablet, "mama-tablet"), (&papa, "papa")] {
        let (_, _, sub) = subscription(&format!("{service}/push/{name}"));
        assert_eq!(m.send(&srv, "PUT", "/v1/me/push", Some(&sub)).await.status, 204);
    }
    let names = || {
        let mut v: Vec<String> = fake.got.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
        v.sort();
        v
    };
    let chat = mama.chat_with(&srv.server_id(), &papa);
    mama.post_event(&srv, &chat, &new_msg_id(), b"hi").await;
    wait_for(|| fake.got.lock().unwrap().len() == 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(names(), vec!["mama-tablet", "papa"]);

    // The chat with oneself: only the other device.
    fake.got.lock().unwrap().clear();
    let me = mama.chat_with(&srv.server_id(), &mama);
    tablet.post_event(&srv, &me, &new_msg_id(), b"note").await;
    wait_for(|| !fake.got.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(names(), vec!["mama-phone"]);

    // A duplicate sends nothing.
    fake.got.lock().unwrap().clear();
    let key = new_msg_id();
    mama.post_event(&srv, &chat, &key, b"x").await;
    wait_for(|| fake.got.lock().unwrap().len() == 2).await;
    mama.post_event(&srv, &chat, &key, b"x").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.got.lock().unwrap().len(), 2);
}

/// Two people on one browser share its push subscription: a message from one
/// to the other does not notify the browser it was written in, and an
/// endpoint gets one push however many of its accounts are in the chat.
#[tokio::test]
async fn push_skips_the_senders_endpoint() {
    let (service, fake) = fake_push().await;
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let tablet = second_device(&srv, &mama).await;
    let (_, _, shared) = subscription(&format!("{service}/push/shared"));
    let (_, _, own) = subscription(&format!("{service}/push/mama-tablet"));
    for (m, sub) in [(&mama, &shared), (&papa, &shared), (&tablet, &own)] {
        assert_eq!(m.send(&srv, "PUT", "/v1/me/push", Some(sub)).await.status, 204);
    }
    let names = || {
        let mut v: Vec<String> = fake.got.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
        v.sort();
        v
    };
    let chat = mama.chat_with(&srv.server_id(), &papa);
    mama.post_event(&srv, &chat, &new_msg_id(), b"hi").await;
    wait_for(|| !fake.got.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(names(), vec!["mama-tablet"]);

    // From the tablet: the shared browser once, for mama and papa together.
    fake.got.lock().unwrap().clear();
    tablet.post_event(&srv, &chat, &new_msg_id(), b"hi").await;
    wait_for(|| !fake.got.lock().unwrap().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(names(), vec!["shared"]);
}

#[tokio::test]
async fn push_disabled_refuses_subscriptions() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            push: Some(false),
            ..Default::default()
        },
    )
    .await;
    let (mama, _) = family(&srv).await;
    let (_, _, sub) = subscription("https://push.example.net/x");
    let res = mama.send(&srv, "PUT", "/v1/me/push", Some(&sub)).await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "push_disabled");
}

/// `fcd admin list` shows userId, name and role; `fcd admin add` makes a
/// member an administrator (both with the server stopped).
#[tokio::test]
async fn admin_list_and_add_from_the_command_line() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_path_buf();
    let srv = start(&data, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    srv.stop().await;

    let run = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_fcd"))
            .env_remove("LANG")
            .env_remove("LC_ALL")
            .env_remove("LC_MESSAGES")
            .env_remove("FCD_LANG")
            .args(args)
            .args(["--data", data.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    };
    let list = run(&["admin", "list"]);
    let line = |who: &str| list.lines().find(|l| l.contains(who)).unwrap_or_default().to_string();
    assert!(line("Мама").starts_with(&mama.user.to_string()), "{list}");
    assert!(line("Мама").contains("[администратор]"), "{list}");
    assert!(line("Папа").starts_with(&papa.user.to_string()), "{list}");
    assert!(!line("Папа").contains("администратор"), "{list}");

    assert!(run(&["admin", "add", &papa.user.to_string()]).contains("теперь администратор"));
    let list = run(&["admin", "list"]);
    assert!(
        list.lines()
            .any(|l| l.contains("Папа") && l.contains("[администратор]")),
        "{list}"
    );
}
