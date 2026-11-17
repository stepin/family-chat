//! Several families on one fcd: creation with the server code, setup codes,
//! recovery codes, routing under `/f/<id>`, broken families, crash safety
//! and the shared failure limiter.

mod common;

use common::*;
use ed25519_dalek::SigningKey;
use fcd::config::Overrides;
use fcd::datadir::{DataDir, FAMILIES_DIR, OpenError, SERVER_FILE};
use fcd::envelope::testkit;
use serde_json::{Value, json};

fn f(id: &str, path: &str) -> String {
    format!("/f/{id}{path}")
}

/// Creates a family; returns (id, setup code).
async fn new_family(srv: &TestServer, name: &str) -> (String, String) {
    let res = create_family(srv, &srv.admin_code, Some(name), None).await;
    assert_eq!(res.status, 201, "{}", String::from_utf8_lossy(&res.body));
    let j = res.json();
    let id = j["familyId"].as_str().unwrap().to_string();
    assert_eq!(j["path"], format!("/f/{id}"));
    assert_eq!(id.len(), 16);
    assert!(
        id.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)),
        "{id}"
    );
    (id, j["setupCode"].as_str().unwrap().to_string())
}

/// Joins at `base` (a family path prefix, "" for the root) with a key.
async fn join_at(srv: &TestServer, base: &str, key: &SigningKey, name: &str, field: &str, code: &str) -> Res {
    request(
        "POST",
        &srv.url(&format!("{base}/v1/join")),
        &[("Content-Type", "application/json")],
        Some(&join_body(key, name, field, code, &new_dev())),
    )
    .await
}

/// Logs a device in by signature at `base`.
async fn device_login(srv: &TestServer, base: &str, key: &SigningKey) -> Value {
    let hello = get(&srv.url(&format!("{base}/v1/hello"))).await.json();
    let server_id = hello["serverId"].as_str().unwrap().to_string();
    let nonce = request("POST", &srv.url(&format!("{base}/v1/auth/challenge")), &[], None)
        .await
        .json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let (user, identity) = testkit::identity(key);
    let m = Member {
        key: key.clone(),
        user,
        identity,
        dev: new_dev(),
        token: String::new(),
    };
    let dev = new_dev();
    let env = m.auth_envelope(&server_id, &nonce, &dev);
    let res = request(
        "POST",
        &srv.url(&format!("{base}/v1/auth/device")),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    res.json()
}

#[tokio::test]
async fn create_join_and_route_a_second_family() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            family_name: Some("Ивановы".into()),
            ..Default::default()
        },
    )
    .await;
    // The root family first (its setup code came from POST /v1/families on the fresh server).
    let (mama, _) = family(&srv).await;
    let hello = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(hello["rootSetUp"], true);
    assert_eq!(hello["adminCodeActive"], false);

    // The server code never lets anyone into a family.
    let r = join_at(&srv, "", &new_key(), "Чужой", "adminCode", &srv.admin_code).await;
    assert_eq!(r.status, 403, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["error"], "invalid_code");

    // The root setup did not burn the server code: it creates a family now.
    let (id, setup) = new_family(&srv, "Петровы").await;
    let h = get(&srv.url(&f(&id, "/v1/hello"))).await.json();
    assert_eq!(h["familyName"], "Петровы");
    assert_ne!(h["serverId"], hello["serverId"]);
    assert_eq!(h["adminCodeActive"], true);
    assert!(h.get("rootSetUp").is_none(), "{h}");
    assert_eq!(h["vapidPublicKey"], hello["vapidPublicKey"], "one VAPID key per fcd");

    // The setup code is the family's own: not for the root, once only.
    let key = new_key();
    assert_eq!(join_at(&srv, "", &key, "Петя", "adminCode", &setup).await.status, 403);
    let r = join_at(&srv, &f(&id, ""), &key, "Петя", "adminCode", &setup).await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["admin"], true);
    assert_eq!(
        get(&srv.url(&f(&id, "/v1/hello"))).await.json()["adminCodeActive"],
        false
    );
    let other = join_at(&srv, &f(&id, ""), &new_key(), "Вася", "adminCode", &setup).await;
    assert_eq!(other.status, 403);
    // A retry with the same identity after a lost answer: already_member, then a device login.
    let again = join_at(&srv, &f(&id, ""), &key, "Петя", "adminCode", &setup).await;
    assert_eq!(again.json()["error"], "already_member");
    assert_eq!(device_login(&srv, &f(&id, ""), &key).await["admin"], true);

    // Data stay apart: the root admin's token is unknown in the second family.
    let r = request(
        "GET",
        &srv.url(&f(&id, "/v1/users")),
        &[("Authorization", &mama.auth())],
        None,
    )
    .await;
    assert_eq!(r.status, 401);

    // Routing: bare /f/<id> → /f/<id>/ (query kept), relative directory redirect, 404s.
    let r = get(&srv.url(&format!("/f/{id}?x=1"))).await;
    assert_eq!(r.status, 308);
    assert_eq!(r.header("location"), Some(format!("{id}/?x=1").as_str()));
    let r = get(&srv.url(&f(&id, "/server"))).await;
    assert_eq!(r.status, 308);
    assert_eq!(r.header("location"), Some("server/"));
    assert_eq!(get(&srv.url(&f(&id, "/"))).await.status, 200);
    for bad in [
        "/f/aaaaaaaaaaaaaaaa/v1/hello".to_string(),
        format!("/f/{}/v1/hello", id.to_uppercase()),
        format!("/f/%{}/v1/hello", &id[1..]),
        "/f//v1/hello".to_string(),
        format!("/f/{id}/../v1/hello"),
        format!("/f/{id}/%2e%2e/v1/hello"),
    ] {
        let r = get(&srv.url(&bad)).await;
        assert_eq!(r.status, 404, "{bad}");
        assert_eq!(r.json()["error"], "not_found", "{bad}");
        assert_eq!(r.header("access-control-allow-origin"), Some("*"), "{bad}");
        assert_eq!(r.header("cache-control"), Some("no-store"), "{bad}");
    }
    // Creation exists only at the root.
    let r = request(
        "POST",
        &srv.url(&f(&id, "/v1/families")),
        &[("Content-Type", "application/json")],
        Some(&json!({"adminCode": srv.admin_code, "familyName": "X"}).to_string()),
    )
    .await;
    assert_eq!(r.status, 404);

    // The root admin's statistics leave families/ out.
    let stats = mama.get(&srv, "/v1/admin/stats").await.json();
    let root_bytes = stats["dataBytes"].as_u64().unwrap();
    let total = dir_size(tmp.path());
    let fam = dir_size(&tmp.path().join(FAMILIES_DIR));
    assert!(
        fam > 0 && root_bytes <= total - fam + 4096,
        "{root_bytes} {total} {fam}"
    );
    srv.stop().await;
}

fn dir_size(p: &std::path::Path) -> u64 {
    std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| match e.metadata() {
                    Ok(m) if m.is_dir() => dir_size(&e.path()),
                    Ok(m) => m.len(),
                    Err(_) => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn creation_errors_names_and_replay() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            family_name: Some("Ивановы".into()),
            ..Default::default()
        },
    )
    .await;
    family(&srv).await;
    // Wrong code: 403, counted by the shared limiter.
    let r = create_family(&srv, "0000-0000-0000-0000", Some("A"), None).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["error"], "bad_admin_code");
    // Names: empty, too long, control characters; taken (case and NFC, the root's too).
    for bad in ["", "   ", &"я".repeat(101), "a\u{7}b"] {
        let r = create_family(&srv, &srv.admin_code, Some(bad), None).await;
        assert_eq!(r.status, 400, "{bad:?}");
        assert_eq!(r.json()["error"], "bad_request");
    }
    assert_eq!(create_family(&srv, &srv.admin_code, None, None).await.status, 400);
    let r = create_family(&srv, &srv.admin_code, Some("ИВАНОВЫ"), None).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["error"], "name_taken");
    new_family(&srv, "Йошкины").await;
    // "й" decomposed is the same name.
    let r = create_family(&srv, &srv.admin_code, Some("и\u{0306}ошкины"), None).await;
    assert_eq!(r.json()["error"], "name_taken");

    // Replay with the same key: the same family and a new setup code; another name 422; a wrong code 403.
    let r = create_family(&srv, &srv.admin_code, Some("Сидоровы"), Some("key-1")).await;
    assert_eq!(r.status, 201);
    let sid = r.json()["familyId"].as_str().unwrap().to_string();
    let code1 = r.json()["setupCode"].as_str().unwrap().to_string();
    let r = create_family(&srv, &srv.admin_code, Some("Сидоровы"), Some("key-1")).await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json()["familyId"], sid);
    let code2 = r.json()["setupCode"].as_str().unwrap().to_string();
    assert_ne!(code1, code2);
    // The old setup code was replaced.
    assert_eq!(
        join_at(&srv, &f(&sid, ""), &new_key(), "A", "adminCode", &code1)
            .await
            .status,
        403
    );
    let r = create_family(&srv, &srv.admin_code, Some("Другие"), Some("key-1")).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["error"], "idempotency_conflict");
    let r = create_family(&srv, "0000-0000-0000-0000", Some("Сидоровы"), Some("key-1")).await;
    assert_eq!(r.status, 403);
    // After setup the replay says so.
    assert_eq!(
        join_at(&srv, &f(&sid, ""), &new_key(), "A", "adminCode", &code2)
            .await
            .status,
        200
    );
    let r = create_family(&srv, &srv.admin_code, Some("Сидоровы"), Some("key-1")).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["error"], "already_set_up");
    assert_eq!(r.json()["path"], format!("/f/{sid}"));
    srv.stop().await;
}

#[tokio::test]
async fn parallel_creates_with_one_name_give_one_family() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    let (a, b) = tokio::join!(
        create_family(&srv, &srv.admin_code, Some("Близнецы"), None),
        create_family(&srv, &srv.admin_code, Some("близнецы"), None)
    );
    let mut s = [a.status, b.status];
    s.sort();
    assert_eq!(s, [201, 409]);
    let n = std::fs::read_dir(tmp.path().join(FAMILIES_DIR)).unwrap().count();
    assert_eq!(n, 1);
    srv.stop().await;
}

#[tokio::test]
async fn wrong_server_codes_are_limited_together_with_family_codes() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    let (id, _) = new_family(&srv, "Петровы").await;
    // Five wrong invitations under /f/<id> and five wrong server codes: the limit is shared.
    for _ in 0..5 {
        let r = join_at(
            &srv,
            &f(&id, ""),
            &new_key(),
            "X",
            "invite",
            "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await;
        assert_eq!(r.status, 403);
        let r = create_family(&srv, "0000-0000-0000-0000", Some("A"), None).await;
        assert_eq!(r.status, 403);
    }
    let r = create_family(&srv, &srv.admin_code, Some("Новые"), None).await;
    assert_eq!(r.status, 429, "{}", String::from_utf8_lossy(&r.body));
    assert!(r.header("retry-after").is_some());
    let r = get(&srv.url(&f(&id, "/v1/hello"))).await;
    assert_eq!(r.status, 200);
    srv.stop().await;
}

#[tokio::test]
async fn setup_code_expires_after_an_hour() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    let (id, code) = new_family(&srv, "Петровы").await;
    srv.stop().await;
    // An hour later (the expiry moved into the past while the server was stopped).
    let p = tmp.path().join(FAMILIES_DIR).join(&id).join(SERVER_FILE);
    let mut j: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    let exp = j["joinCodeExpiresAt"].as_u64().unwrap();
    let now = fcd::datadir::now_ms();
    assert!(exp > now + 3500 * 1000 && exp <= now + 3600 * 1000, "{exp} {now}");
    j["joinCodeExpiresAt"] = json!(now - 1);
    std::fs::write(&p, serde_json::to_vec(&j).unwrap()).unwrap();
    let srv = open(tmp.path(), Overrides::default()).await;
    assert_eq!(
        get(&srv.url(&f(&id, "/v1/hello"))).await.json()["adminCodeActive"],
        false
    );
    let r = join_at(&srv, &f(&id, ""), &new_key(), "A", "adminCode", &code).await;
    assert_eq!(r.status, 403);
    srv.stop().await;
}

#[tokio::test]
async fn a_crash_between_the_member_and_server_json_leaves_a_retryable_code() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let key = new_key();
    srv.state.store.fail_next_admin_join();
    let r = join_at(&srv, "", &key, "Мама", "adminCode", &srv.setup_code).await;
    assert_eq!(r.status, 500);
    let code = srv.setup_code.clone();
    srv.stop().await;
    let srv = open(tmp.path(), Overrides::default()).await;
    // Not set up, the code still works; the member exists but is no administrator.
    let h = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(h["rootSetUp"], false);
    assert_eq!(h["adminCodeActive"], true);
    // The retry: already_member comes first, the code promotes, the device logs in as administrator.
    let r = join_at(&srv, "", &key, "Мама", "adminCode", &code).await;
    assert_eq!(r.json()["error"], "already_member");
    assert_eq!(device_login(&srv, "", &key).await["admin"], true);
    let h = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(h["rootSetUp"], true);
    assert_eq!(h["adminCodeActive"], false);
    srv.stop().await;
}

#[tokio::test]
async fn recovery_code_promotes_a_member_and_server_code_rotates() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (_, papa) = family(&srv).await;
    let (id, setup) = new_family(&srv, "Петровы").await;
    join_at(&srv, &f(&id, ""), &new_key(), "Петя", "adminCode", &setup).await;
    let old_server_code = srv.admin_code.clone();
    srv.stop().await;

    // fcd reset-admin-code --family root: a recovery code of the root family.
    let (root, _) = DataDir::open(tmp.path(), Overrides::default()).unwrap();
    let mut root_dir = DataDir::open(tmp.path(), Overrides::default()).err();
    assert!(
        matches!(root_dir.take(), Some(OpenError::Locked(_))),
        "the root lock is held"
    );
    drop(root);
    let (mut root, _) = DataDir::open(tmp.path(), Overrides::default()).unwrap();
    let recovery = root.reset_join_code().unwrap();
    // Without --family: a new server code, the old one stops working.
    let new_server_code = root.reset_admin_code().unwrap();
    assert!(root.check_admin_code(&new_server_code));
    assert!(!root.check_admin_code(&old_server_code));
    // A family recovery code goes to the family's server.json.
    let mut fam = DataDir::open_family(&root.path, &id, root.vapid.clone()).unwrap();
    let fam_recovery = fam.reset_join_code().unwrap();
    drop(fam);
    drop(root);

    let srv = open(tmp.path(), Overrides::default()).await;
    // An existing member is promoted with the recovery code (and answered already_member).
    let r = join_at(&srv, "", &papa.key, "Папа", "adminCode", &recovery).await;
    assert_eq!(r.json()["error"], "already_member");
    assert_eq!(device_login(&srv, "", &papa.key).await["admin"], true);
    let r = join_at(&srv, &f(&id, ""), &new_key(), "Новый", "adminCode", &fam_recovery).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["admin"], true);
    assert_eq!(
        create_family(&srv, &old_server_code, Some("Z"), None).await.json()["error"],
        "bad_admin_code"
    );
    assert_eq!(create_family(&srv, &new_server_code, Some("Z"), None).await.status, 201);
    srv.stop().await;
}

#[tokio::test]
async fn a_broken_family_answers_503_and_the_rest_work() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    let (bad, _) = new_family(&srv, "Сломанные").await;
    let (good, _) = new_family(&srv, "Целые").await;
    srv.stop().await;
    std::fs::remove_file(tmp.path().join(FAMILIES_DIR).join(&bad).join(SERVER_FILE)).unwrap();
    let srv = open(tmp.path(), Overrides::default()).await;
    let r = get(&srv.url(&f(&bad, "/v1/hello"))).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.json()["error"], "family_unavailable");
    assert_eq!(r.header("access-control-allow-origin"), Some("*"));
    assert_eq!(get(&srv.url(&f(&good, "/v1/hello"))).await.status, 200);
    assert_eq!(get(&srv.url("/v1/hello")).await.status, 200);
    // Never re-created: still no server.json.
    assert!(!tmp.path().join(FAMILIES_DIR).join(&bad).join(SERVER_FILE).exists());
    let lines = fcd::families::scan(tmp.path(), "Семья");
    assert!(
        lines
            .iter()
            .any(|l| l.id.as_deref() == Some(bad.as_str()) && l.broken.is_some())
    );
    srv.stop().await;
}

#[tokio::test]
async fn a_family_folder_cannot_be_opened_as_a_data_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    let (id, _) = new_family(&srv, "Петровы").await;
    srv.stop().await;
    let e = DataDir::open(&tmp.path().join(FAMILIES_DIR).join(&id), Overrides::default())
        .err()
        .unwrap();
    assert!(matches!(e, OpenError::InsideFamilies { .. }), "{e}");
    assert!(e.to_string().contains("--family"), "{e}");
}

#[tokio::test]
async fn an_old_data_folder_starts_and_needs_a_new_server_code() {
    // A folder of a running 0.1.0 server: no families/, the one-time code used up, no server code.
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    family(&srv).await;
    srv.stop().await;
    let p = tmp.path().join(SERVER_FILE);
    let mut j: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    let o = j.as_object_mut().unwrap();
    o.remove("serverCodeHash");
    o.remove("setupDone");
    o.insert("adminCodeHash".into(), json!(""));
    std::fs::write(&p, serde_json::to_vec(&j).unwrap()).unwrap();
    std::fs::remove_dir_all(tmp.path().join(FAMILIES_DIR)).unwrap();

    let srv = open_plain(tmp.path(), Overrides::default()).await;
    let h = get(&srv.url("/v1/hello")).await.json();
    assert_eq!(h["rootSetUp"], true, "has an administrator");
    let r = create_family(&srv, "0000-0000-0000-0000", Some("Петровы"), None).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["error"], "admin_code_not_set");
    srv.stop().await;
    let (mut dir, _) = DataDir::open(tmp.path(), Overrides::default()).unwrap();
    let code = dir.reset_admin_code().unwrap();
    drop(dir);
    let srv = open_plain(tmp.path(), Overrides::default()).await;
    assert_eq!(create_family(&srv, &code, Some("Петровы"), None).await.status, 201);
    srv.stop().await;
}
