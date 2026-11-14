//! M4 API over HTTP: delete for everyone (`DELETE /v1/chats/<id>/events/<gseq>`).

mod common;

use std::time::{Duration, Instant};

use common::*;
use fcd::config::Overrides;
use fcd::ids::ChatId;
use serde_json::{Value, json};

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

fn ids(members: &[&Member]) -> Value {
    Value::Array(members.iter().map(|m| json!(m.user.to_string())).collect())
}

async fn create_group(srv: &TestServer, owner: &Member, members: &[&Member]) -> ChatId {
    let chat = ChatId(fcd::webpush::random_bytes::<16>());
    let keys: Vec<Value> = members
        .iter()
        .map(|m| json!({ "userId": m.user.to_string(), "key": b64e(b"k") }))
        .collect();
    let body = json!({
        "chatId": chat.to_string(),
        "state": b64e(b"state-1"),
        "members": ids(members),
        "epoch": 0,
        "keys": keys,
    });
    let res = owner.send(srv, "POST", "/v1/chats", Some(&body.to_string())).await;
    assert_eq!(res.status, 201, "{}", text(&res));
    chat
}

async fn post(srv: &TestServer, m: &Member, chat: &ChatId, body: &[u8]) -> u64 {
    let res = m.post_event(srv, chat, &new_msg_id(), body).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    res.json()["gseq"].as_u64().unwrap()
}

async fn delete(srv: &TestServer, m: &Member, chat: &ChatId, gseq: u64) -> Res {
    m.send(srv, "DELETE", &format!("/v1/chats/{chat}/events/{gseq}"), None)
        .await
}

fn err(r: &Res) -> (u16, String) {
    (r.status, r.json()["error"].as_str().unwrap_or("").to_string())
}

fn by_gseq(events: &[Value], gseq: u64) -> Option<&Value> {
    events.iter().find(|e| e["gseq"] == gseq && e["kind"] == "event")
}

fn deletion_notices(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["kind"] == "notice" && e["notice"]["type"] == "event_deleted")
        .collect()
}

async fn four(srv: &TestServer) -> (Member, Member, Member, Member) {
    let (mama, papa) = family(srv).await;
    let son = join(srv, "Сын", "invite", &invite(srv, &mama).await).await;
    let daughter = join(srv, "Дочь", "invite", &invite(srv, &mama).await).await;
    (mama, papa, son, daughter)
}

#[tokio::test]
async fn delete_permissions_in_direct_chats_and_groups() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let (mama, papa, son, daughter) = four(&srv).await;
    let sid = srv.server_id();

    // Direct chat: only the sender.
    let dm = mama.chat_with(&sid, &papa);
    let g1 = post(&srv, &mama, &dm, b"FC1 mama").await;
    let g2 = post(&srv, &papa, &dm, b"FC1 papa").await;
    assert_eq!(err(&delete(&srv, &papa, &dm, g1).await), (403, "not_author".into()));
    assert_eq!(err(&delete(&srv, &son, &dm, g1).await), (403, "not_member".into()));
    assert_eq!(delete(&srv, &mama, &dm, g1).await.status, 204);
    assert_eq!(delete(&srv, &papa, &dm, g2).await.status, 204);

    // Group: the sender and the owner; another member and a non-member cannot.
    let g = create_group(&srv, &mama, &[&mama, &papa, &son]).await;
    let a = post(&srv, &papa, &g, b"FC1 papa 1").await;
    let b = post(&srv, &papa, &g, b"FC1 papa 2").await;
    let c = post(&srv, &son, &g, b"FC1 son").await;
    assert_eq!(err(&delete(&srv, &son, &g, a).await), (403, "not_author".into()));
    assert_eq!(err(&delete(&srv, &daughter, &g, a).await), (403, "not_member".into()));
    assert_eq!(delete(&srv, &papa, &g, a).await.status, 204, "sender");
    assert_eq!(delete(&srv, &mama, &g, b).await.status, 204, "group owner");
    // The owner's own message can be deleted by the owner, not by others.
    let d = post(&srv, &mama, &g, b"FC1 mama").await;
    assert_eq!(err(&delete(&srv, &papa, &g, d).await), (403, "not_author".into()));
    assert_eq!(delete(&srv, &mama, &g, d).await.status, 204);
    assert_eq!(delete(&srv, &son, &g, c).await.status, 204);

    // Wrong addresses.
    assert_eq!(
        err(&delete(&srv, &mama, &g, 9999).await),
        (404, "event_not_found".into())
    );
    assert_eq!(
        err(&delete(&srv, &mama, &dm, a).await),
        (404, "event_not_found".into()),
        "event of another chat"
    );
    let notice = mama
        .feed(&srv, 0)
        .await
        .into_iter()
        .find(|e| e["kind"] == "notice")
        .unwrap();
    let ng = notice["gseq"].as_u64().unwrap();
    let nchat = ChatId::parse(notice["chatId"].as_str().unwrap()).unwrap();
    assert_eq!(
        err(&delete(&srv, &mama, &nchat, ng).await),
        (404, "event_not_found".into()),
        "a notice"
    );
    let none = ChatId([7; 16]);
    assert_eq!(
        err(&delete(&srv, &mama, &none, a).await),
        (404, "chat_not_found".into())
    );
    for bad in ["0", "01", "x", "-1"] {
        let res = mama
            .send(&srv, "DELETE", &format!("/v1/chats/{g}/events/{bad}"), None)
            .await;
        assert_eq!(res.status, 400, "{bad}");
    }
    let res = mama
        .send(&srv, "DELETE", &format!("/v1/chats/bad/events/{a}"), None)
        .await;
    assert_eq!(res.status, 400);
    let res = request("DELETE", &srv.url(&format!("/v1/chats/{g}/events/{a}")), &[], None).await;
    assert_eq!(res.status, 401);
    srv.stop().await;
}

#[tokio::test]
async fn deleted_record_shape_notice_and_idempotency() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let (mama, papa, son, _) = four(&srv).await;
    let g = create_group(&srv, &mama, &[&mama, &papa]).await;
    let msg = new_msg_id();
    let res = papa.post_event(&srv, &g, &msg, b"FC1 secret").await;
    let gseq = res.json()["gseq"].as_u64().unwrap();
    let keep = post(&srv, &papa, &g, b"FC1 keep").await;
    let cursor = mama.feed(&srv, 0).await.last().unwrap()["gseq"].as_u64().unwrap();

    // A waiting long poll of the other member wakes up with the notice.
    let url = srv.url(&format!("/v1/events?after={cursor}&wait=20"));
    let auth = mama.auth();
    let t = Instant::now();
    let pending = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!pending.is_finished());
    assert_eq!(delete(&srv, &papa, &g, gseq).await.status, 204);
    let res = pending.await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(5));
    let events = res.json()["events"].as_array().unwrap().clone();
    let n = deletion_notices(&events);
    assert_eq!(n.len(), 1, "{events:?}");
    assert_eq!(n[0]["chatId"], g.to_string());
    let body = &n[0]["notice"];
    assert_eq!(body["gseq"], gseq);
    assert_eq!(body["senderId"], papa.user.to_string());
    assert_eq!(body["msgId"], msg);
    assert_eq!(body["by"], papa.user.to_string());
    assert!(body.get("to").is_none());

    // Idempotent: again 204 and no second notice.
    assert_eq!(delete(&srv, &papa, &g, gseq).await.status, 204);
    assert_eq!(delete(&srv, &mama, &g, gseq).await.status, 204, "owner too");

    for m in [&mama, &papa] {
        let feed = m.feed(&srv, 0).await;
        assert_eq!(deletion_notices(&feed).len(), 1);
        let e = by_gseq(&feed, gseq).unwrap();
        assert_eq!(e["deleted"], true);
        assert_eq!(e["body"], "");
        assert_eq!(e["msgId"], msg);
        assert_eq!(e["senderId"], papa.user.to_string());
        let k = by_gseq(&feed, keep).unwrap();
        assert!(k.get("deleted").is_none());
        assert_eq!(b64d(&k["body"]), b"FC1 keep");
        // History shows the same.
        let h = m.get(&srv, &format!("/v1/chats/{g}/events")).await.json();
        let h = h["events"].as_array().unwrap();
        assert_eq!(by_gseq(h, gseq).unwrap()["deleted"], true);
        assert_eq!(by_gseq(h, gseq).unwrap()["body"], "");
    }
    // Not a member: nothing.
    assert!(son.feed(&srv, 0).await.iter().all(|e| e["chatId"] != g.to_string()));

    // A repeat of the original send still answers with the same gseq.
    let res = papa.post_event(&srv, &g, &msg, b"FC1 secret").await;
    assert_eq!(res.json()["gseq"], gseq);
    assert_eq!(res.json()["duplicate"], true);

    // The plaintext-free body is gone from the disk.
    let seg = std::fs::read_dir(tmp.path().join("log"))
        .unwrap()
        .flatten()
        .find(|e| e.file_name().to_string_lossy().ends_with(".seg"))
        .unwrap()
        .path();
    let bytes = std::fs::read(&seg).unwrap();
    assert!(!bytes.windows(10).any(|w| w == b"FC1 secret"));
    assert!(bytes.windows(8).any(|w| w == b"FC1 keep"));
    assert!(seg.with_extension("del").exists());
    srv.stop().await;
}

#[tokio::test]
async fn deletion_survives_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_path_buf();
    let srv = start(&data, false, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let dm = mama.chat_with(&srv.server_id(), &papa);
    let a = post(&srv, &mama, &dm, b"FC1 one").await;
    let b = post(&srv, &mama, &dm, b"FC1 two").await;
    let c = post(&srv, &papa, &dm, b"FC1 three").await;
    assert_eq!(delete(&srv, &mama, &dm, b).await.status, 204);
    srv.stop().await;

    let srv = open(&data, false, Overrides::default()).await;
    let feed = papa.feed(&srv, 0).await;
    assert_eq!(b64d(&by_gseq(&feed, a).unwrap()["body"]), b"FC1 one");
    assert_eq!(by_gseq(&feed, b).unwrap()["deleted"], true);
    assert_eq!(b64d(&by_gseq(&feed, c).unwrap()["body"]), b"FC1 three");
    assert_eq!(deletion_notices(&feed).len(), 1);
    assert_eq!(delete(&srv, &mama, &dm, b).await.status, 204, "still idempotent");
    assert_eq!(deletion_notices(&papa.feed(&srv, 0).await).len(), 1);
    // New events continue the numbering after the notice.
    let d = post(&srv, &papa, &dm, b"FC1 four").await;
    assert_eq!(d, c + 2);
    assert_eq!(delete(&srv, &papa, &dm, d).await.status, 204);
    srv.stop().await;

    let srv = open(&data, false, Overrides::default()).await;
    let feed = mama.feed(&srv, 0).await;
    assert_eq!(by_gseq(&feed, d).unwrap()["deleted"], true);
    assert_eq!(by_gseq(&feed, b).unwrap()["deleted"], true);
    assert_eq!(deletion_notices(&feed).len(), 2);
    srv.stop().await;
}
