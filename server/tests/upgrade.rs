//! A data folder written by the M1 build (tests/fixtures/m1, produced by
//! the server at commit c3c8ec4: three members, one removed, two direct
//! chats, a profile update, a push subscription, an unused invitation)
//! starts under this build without losing anything.

mod common;

use std::path::Path;

use common::*;
use ed25519_dalek::SigningKey;
use fcd::config::Overrides;
use fcd::envelope::testkit;
use fcd::ids::{ChatId, DevId, UserId, day_name, day_of_ms};
use serde_json::{Value, json};

fn copy(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            copy(&p, &to.join(e.file_name()));
        } else {
            std::fs::copy(&p, to.join(e.file_name())).unwrap();
        }
    }
}

fn member(f: &Value) -> Member {
    let seed: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&f["seed"].as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap())
        .collect();
    let key = SigningKey::from_bytes(&seed.try_into().unwrap());
    let (user, identity) = testkit::identity(&key);
    assert_eq!(user, UserId::parse(f["userId"].as_str().unwrap()).unwrap());
    Member {
        key,
        user,
        identity,
        dev: DevId::parse(f["devId"].as_str().unwrap()).unwrap(),
        token: f["token"].as_str().unwrap().to_string(),
    }
}

#[tokio::test]
async fn starts_on_an_m1_folder() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/m1");
    let info: Value = serde_json::from_slice(&std::fs::read(fixture.join("fixture.json")).unwrap()).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    copy(&fixture.join("data"), &data);

    // Keep the fixture independent of the day the test runs: the log day
    // gets today's name (retention looks at file names) and the unused
    // invitation a fresh expiry. Nothing else is touched.
    let log: Vec<_> = std::fs::read_dir(data.join("log")).unwrap().flatten().collect();
    assert_eq!(log.len(), 1);
    let today = day_name(day_of_ms(fcd::datadir::now_ms()));
    std::fs::rename(log[0].path(), data.join("log").join(format!("{today}.seg"))).unwrap();
    let unused = info["unusedInvite"].as_str().unwrap();
    let inv = data
        .join("invites")
        .join(format!("{}.json", fcd::store::invite_hash(unused)));
    let mut f: Value = serde_json::from_slice(&std::fs::read(&inv).unwrap()).unwrap();
    f["expiresAt"] = json!(fcd::datadir::now_ms() + 86_400_000);
    std::fs::write(&inv, f.to_string()).unwrap();

    let srv = open(&data, Overrides::default()).await;
    assert!(srv.admin_code.is_empty(), "not a first start");
    assert_eq!(srv.server_id(), info["serverId"]);
    let server: Value = serde_json::from_slice(&std::fs::read(data.join("server.json")).unwrap()).unwrap();
    assert_eq!(server["formatVersion"], fcd::datadir::FORMAT_VERSION);
    assert_eq!(server["admins"], json!([info["mama"]["userId"]]));

    let mama = member(&info["mama"]);
    let papa = member(&info["papa"]);
    let son = member(&info["son"]);

    // Tokens, admin rights, push subscription, removal.
    let me = mama.get(&srv, "/v1/me").await;
    assert_eq!(me.status, 200);
    assert_eq!(me.json()["admin"], true);
    assert_eq!(papa.get(&srv, "/v1/me").await.json()["push"], true);
    assert_eq!(son.get(&srv, "/v1/me").await.status, 403);
    let users = mama.get(&srv, "/v1/users").await.json();
    let users = users["users"].as_array().unwrap();
    assert_eq!(users.len(), 3);
    let p = users.iter().find(|u| u["userId"] == papa.user.to_string()).unwrap();
    let payload: Value = serde_json::from_slice(&b64d(&p["profile"]["payload"])).unwrap();
    assert_eq!(payload["name"], "Папа 2");
    assert_eq!(payload["rev"], 2);
    assert!(p["revoked"].is_null());
    assert!(
        users
            .iter()
            .any(|u| u["userId"] == son.user.to_string() && u["removed"] == true)
    );

    // Chats and events with their bodies.
    let dm = ChatId::parse(info["dmChat"].as_str().unwrap()).unwrap();
    let chats = mama.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"].as_array().unwrap().len(), 2);
    for c in chats["chats"].as_array().unwrap() {
        assert_eq!(c["kind"], "dm");
        assert!(c["owner"].is_null() && c["version"].is_null());
    }
    let ev = mama.feed(&srv, 0).await;
    let bodies: Vec<Vec<u8>> = ev.iter().map(|e| b64d(&e["body"])).collect();
    assert_eq!(
        bodies,
        vec![b"hello papa".to_vec(), b"hello mama".to_vec(), b"from son".to_vec()]
    );
    assert!(ev.iter().all(|e| e["kind"] == "event"));
    assert_eq!(papa.feed(&srv, 0).await.len(), 2);
    // The idempotency record survived: a repeat is a duplicate of gseq 1.
    let res = mama
        .post_event(&srv, &dm, info["firstMsgId"].as_str().unwrap(), b"hello papa")
        .await;
    assert_eq!(res.json()["duplicate"], true);
    assert_eq!(res.json()["gseq"], 1);
    let res = papa.post_event(&srv, &dm, &new_msg_id(), b"after upgrade").await;
    assert_eq!(res.json()["gseq"], 4);
    // Son is still cut off.
    let son_chat = ChatId::parse(info["sonChat"].as_str().unwrap()).unwrap();
    assert_eq!(mama.post_event(&srv, &son_chat, &new_msg_id(), b"x").await.status, 403);

    // The unused invitation still works; M2 features work on the old folder.
    let daughter = join(&srv, "Дочь", "invite", unused).await;
    let g = ChatId(fcd::webpush::random_bytes::<16>());
    let body = json!({
        "chatId": g.to_string(),
        "state": b64e(b"s"),
        "members": [mama.user.to_string(), papa.user.to_string(), daughter.user.to_string()],
        "epoch": 0,
        "keys": [
            {"userId": mama.user.to_string(), "key": b64e(b"k")},
            {"userId": papa.user.to_string(), "key": b64e(b"k")},
            {"userId": daughter.user.to_string(), "key": b64e(b"k")},
        ],
    });
    assert_eq!(
        mama.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        201
    );

    // And everything is there after another restart; the direct chat files
    // keep the M1 format.
    srv.stop().await;
    let srv = open(&data, Overrides::default()).await;
    assert_eq!(
        mama.get(&srv, "/v1/chats").await.json()["chats"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(papa.feed(&srv, 0).await.len(), 4);
    let meta: Value =
        serde_json::from_slice(&std::fs::read(data.join("chats").join(dm.to_string()).join("meta.json")).unwrap())
            .unwrap();
    assert_eq!(meta.as_object().unwrap().len(), 4, "{meta}");
}

#[test]
fn an_m1_build_refuses_the_upgraded_folder() {
    // The M1 build checks `formatVersion <= 1`; after the upgrade it is 2.
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    copy(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/m1/data"),
        &data,
    );
    let (dir, _) = fcd::datadir::DataDir::open(&data, Overrides::default()).unwrap();
    assert_eq!(dir.server.format_version, 2);
    drop(dir);
    let server: Value = serde_json::from_slice(&std::fs::read(data.join("server.json")).unwrap()).unwrap();
    assert!(server["formatVersion"].as_u64().unwrap() > 1);
}
