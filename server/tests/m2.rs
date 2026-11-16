//! M2 API over HTTP: groups, notices, the chat with oneself, revocation,
//! invitation details, avatars, retention gap time.

mod common;

use std::time::Duration;

use common::*;
use fcd::config::Overrides;
use fcd::envelope::testkit;
use fcd::ids::ChatId;
use serde_json::{Value, json};

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

fn new_chat_id() -> ChatId {
    ChatId(fcd::webpush::random_bytes::<16>())
}

fn keys_for(members: &[&Member], tag: &str) -> Value {
    Value::Array(
        members
            .iter()
            .map(|m| json!({ "userId": m.user.to_string(), "key": b64e(format!("{tag}-{}", m.user).as_bytes()) }))
            .collect(),
    )
}

fn ids(members: &[&Member]) -> Value {
    Value::Array(members.iter().map(|m| json!(m.user.to_string())).collect())
}

async fn create_group(srv: &TestServer, owner: &Member, chat: &ChatId, members: &[&Member]) -> Res {
    let body = json!({
        "chatId": chat.to_string(),
        "state": b64e(b"state-1"),
        "members": ids(members),
        "epoch": 0,
        "keys": keys_for(members, "e0"),
    });
    owner.send(srv, "POST", "/v1/chats", Some(&body.to_string())).await
}

#[allow(clippy::too_many_arguments)]
async fn change_state(
    srv: &TestServer,
    by: &Member,
    chat: &ChatId,
    base: u64,
    members: &[&Member],
    owner: &Member,
    epoch: u32,
    keys: Value,
    state: &[u8],
) -> Res {
    let body = json!({
        "baseVersion": base,
        "state": b64e(state),
        "members": ids(members),
        "owner": owner.user.to_string(),
        "epoch": epoch,
        "keys": keys,
    });
    by.send(srv, "PUT", &format!("/v1/chats/{chat}/state"), Some(&body.to_string()))
        .await
}

fn notices(events: &[Value]) -> Vec<&Value> {
    events.iter().filter(|e| e["kind"] == "notice").collect()
}

fn last_gseq(events: &[Value]) -> u64 {
    events.last().map_or(0, |e| e["gseq"].as_u64().unwrap())
}

async fn four(srv: &TestServer) -> (Member, Member, Member, Member) {
    let (mama, papa) = family(srv).await;
    let son = join(srv, "Сын", "invite", &invite(srv, &mama).await).await;
    let daughter = join(srv, "Дочь", "invite", &invite(srv, &mama).await).await;
    (mama, papa, son, daughter)
}

#[tokio::test]
async fn group_lifecycle_and_notices() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa, son, daughter) = four(&srv).await;
    let g = new_chat_id();

    let res = create_group(&srv, &mama, &g, &[&mama, &papa, &son]).await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let c = res.json();
    assert_eq!(c["kind"], "group");
    assert_eq!(c["owner"], mama.user.to_string());
    assert_eq!(c["version"], 1);
    assert_eq!(c["epoch"], 0);
    let mut sorted = vec![mama.user.to_string(), papa.user.to_string(), son.user.to_string()];
    sorted.sort();
    assert_eq!(c["members"], json!(sorted));
    assert!(c["lastGseq"].is_null());

    // Everybody in the group gets the notice; others do not.
    for m in [&mama, &papa, &son] {
        let ev = m.feed(&srv, 0).await;
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0]["kind"], "notice");
        assert_eq!(ev[0]["chatId"], g.to_string());
        let n = &ev[0]["notice"];
        assert_eq!(n["type"], "group_created");
        assert_eq!(n["by"], mama.user.to_string());
        assert_eq!(n["version"], 1);
        assert!(ev[0].get("body").is_none() && ev[0].get("senderId").is_none());
        assert!(n.get("to").is_none(), "recipients stay on the server");
    }
    assert!(daughter.feed(&srv, 0).await.is_empty());
    let chats = papa.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"][0]["chatId"], g.to_string());
    assert_eq!(chats["chats"][0]["version"], 1);
    assert_eq!(daughter.get(&srv, "/v1/chats").await.json()["chats"], json!([]));

    // State and keys.
    let res = papa.get(&srv, &format!("/v1/chats/{g}/state/1")).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, b"state-1");
    assert_eq!(res.header("content-type"), Some("application/octet-stream"));
    assert_eq!(papa.get(&srv, &format!("/v1/chats/{g}/state/2")).await.status, 404);
    assert_eq!(papa.get(&srv, &format!("/v1/chats/{g}/state/01")).await.status, 400);
    let res = daughter.get(&srv, &format!("/v1/chats/{g}/state/1")).await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_member")));
    let k = papa.get(&srv, "/v1/keys").await.json();
    assert_eq!(k["keys"].as_array().unwrap().len(), 1);
    assert_eq!(k["keys"][0]["chatId"], g.to_string());
    assert_eq!(k["keys"][0]["epoch"], 0);
    assert_eq!(k["keys"][0]["version"], 1);
    assert_eq!(b64d(&k["keys"][0]["key"]), format!("e0-{}", papa.user).into_bytes());
    let n1 = k["keys"][0]["n"].as_u64().unwrap();
    assert_eq!(k["cursor"], n1);
    assert_eq!(
        papa.get(&srv, &format!("/v1/keys?after={n1}")).await.json()["keys"],
        json!([])
    );
    assert_eq!(daughter.get(&srv, "/v1/keys").await.json()["keys"], json!([]));

    // Events: epoch check, members only.
    assert_eq!(
        papa.post_event_epoch(&srv, &g, &new_msg_id(), 0, b"p1").await.status,
        200
    );
    let res = papa.post_event_epoch(&srv, &g, &new_msg_id(), 1, b"x").await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "epoch_mismatch");
    assert_eq!(res.json()["epoch"], 0);
    let res = daughter.post_event_epoch(&srv, &g, &new_msg_id(), 0, b"x").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_member")));
    let son_seen = son.feed(&srv, 0).await;
    assert_eq!(son_seen.len(), 2);
    assert_eq!(son_seen[1]["kind"], "event");
    assert_eq!(b64d(&son_seen[1]["body"]), b"p1");
    let son_cursor = last_gseq(&son_seen);

    // Replace son with daughter, new epoch.
    let res = change_state(
        &srv,
        &mama,
        &g,
        1,
        &[&mama, &papa, &daughter],
        &mama,
        1,
        keys_for(&[&mama, &papa, &daughter], "e1"),
        b"state-2",
    )
    .await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["version"], 2);
    assert_eq!(res.json()["epoch"], 1);
    assert_eq!(
        papa.post_event_epoch(&srv, &g, &new_msg_id(), 1, b"p2").await.status,
        200
    );

    // The removed member gets the notice of the removal and nothing after it.
    let ev = son.feed(&srv, son_cursor).await;
    assert_eq!(ev.len(), 1, "{ev:?}");
    let n = &ev[0]["notice"];
    assert_eq!(n["type"], "group_state");
    assert_eq!(n["removed"], json!([son.user.to_string()]));
    assert_eq!(n["added"], json!([daughter.user.to_string()]));
    assert_eq!(n["version"], 2);
    assert_eq!(n["epoch"], 1);
    assert!(son.feed(&srv, last_gseq(&ev)).await.is_empty());
    let res = son.post_event_epoch(&srv, &g, &new_msg_id(), 1, b"x").await;
    assert_eq!(res.status, 403);
    assert_eq!(son.get(&srv, &format!("/v1/chats/{g}/events")).await.status, 403);
    assert_eq!(son.get(&srv, &format!("/v1/chats/{g}/state/2")).await.status, 403);
    assert_eq!(son.get(&srv, "/v1/chats").await.json()["chats"], json!([]));
    // Son keeps his old key.
    assert_eq!(
        son.get(&srv, "/v1/keys").await.json()["keys"].as_array().unwrap().len(),
        1
    );

    // The new member: the notice and events from then on in the feed; older
    // events through the history (notices only those addressed to her).
    let ev = daughter.feed(&srv, 0).await;
    assert_eq!(ev.len(), 2, "{ev:?}");
    assert_eq!(ev[0]["notice"]["type"], "group_state");
    assert_eq!(b64d(&ev[1]["body"]), b"p2");
    assert_eq!(ev[1]["epoch"], 1);
    let h = daughter.get(&srv, &format!("/v1/chats/{g}/events")).await.json();
    let kinds: Vec<String> = h["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| match e["kind"].as_str().unwrap() {
            "notice" => e["notice"]["type"].as_str().unwrap().to_string(),
            _ => String::from_utf8(b64d(&e["body"])).unwrap(),
        })
        .collect();
    assert_eq!(kinds, vec!["p1", "group_state", "p2"]);
    let k = daughter.get(&srv, "/v1/keys").await.json();
    assert_eq!(k["keys"][0]["epoch"], 1);
    assert_eq!(k["keys"][0]["version"], 2);
    assert_eq!(
        papa.get(&srv, "/v1/keys").await.json()["keys"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // Papa leaves: removed from delivery at once; members learn it.
    let mama_cursor = last_gseq(&mama.feed(&srv, 0).await);
    let papa_cursor = last_gseq(&papa.feed(&srv, 0).await);
    assert_eq!(
        papa.send(&srv, "POST", &format!("/v1/chats/{g}/leave"), None)
            .await
            .status,
        204
    );
    let ev = mama.feed(&srv, mama_cursor).await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["notice"]["type"], "member_left");
    assert_eq!(ev[0]["notice"]["userId"], papa.user.to_string());
    assert_eq!(ev[0]["notice"]["version"], 2);
    let ev = papa.feed(&srv, papa_cursor).await;
    assert_eq!(ev.len(), 1, "the one who left sees the notice too");
    assert_eq!(
        papa.post_event_epoch(&srv, &g, &new_msg_id(), 1, b"x").await.status,
        403
    );
    assert_eq!(
        papa.send(&srv, "POST", &format!("/v1/chats/{g}/leave"), None)
            .await
            .status,
        403
    );
    assert_eq!(
        mama.post_event_epoch(&srv, &g, &new_msg_id(), 1, b"m1").await.status,
        200
    );
    assert!(papa.feed(&srv, last_gseq(&ev)).await.is_empty());
    let chats = mama.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"][0]["members"].as_array().unwrap().len(), 2);
    assert_eq!(
        chats["chats"][0]["version"], 2,
        "leaving does not change the state version"
    );

    // The owner cannot leave; ownership goes to daughter first.
    let res = mama.send(&srv, "POST", &format!("/v1/chats/{g}/leave"), None).await;
    assert_eq!(
        (res.status, res.json()["error"].clone()),
        (409, json!("owner_cannot_leave"))
    );
    let res = change_state(
        &srv,
        &mama,
        &g,
        2,
        &[&mama, &daughter],
        &daughter,
        1,
        json!([]),
        b"state-3",
    )
    .await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["owner"], daughter.user.to_string());
    let res = change_state(&srv, &mama, &g, 3, &[&mama, &daughter], &mama, 1, json!([]), b"x").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_owner")));
    assert_eq!(
        mama.send(&srv, "POST", &format!("/v1/chats/{g}/leave"), None)
            .await
            .status,
        204
    );
    let res = change_state(&srv, &daughter, &g, 2, &[&daughter], &daughter, 1, json!([]), b"x").await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "stale_version");
    assert_eq!(res.json()["version"], 3);

    // Everything survives a restart.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open(&data, Overrides::default()).await;
    let chats = daughter.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"][0]["owner"], daughter.user.to_string());
    assert_eq!(chats["chats"][0]["members"], json!([daughter.user.to_string()]));
    assert_eq!(chats["chats"][0]["version"], 3);
    assert_eq!(son.feed(&srv, son_cursor).await.len(), 1, "membership history is kept");
    assert_eq!(
        daughter.get(&srv, "/v1/keys").await.json()["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        daughter.get(&srv, &format!("/v1/chats/{g}/state/3")).await.body,
        b"state-3"
    );
}

#[tokio::test]
async fn concurrent_state_changes_exactly_one_wins() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let g = new_chat_id();
    assert_eq!(create_group(&srv, &mama, &g, &[&mama, &papa]).await.status, 201);
    let url = srv.url(&format!("/v1/chats/{g}/state"));
    let mut tasks = Vec::new();
    for i in 0..10 {
        let body = json!({
            "baseVersion": 1,
            "state": b64e(format!("v2-{i}").as_bytes()),
            "members": ids(&[&mama, &papa]),
            "owner": mama.user.to_string(),
            "epoch": 1,
            "keys": keys_for(&[&mama, &papa], &format!("e1-{i}")),
        })
        .to_string();
        let url = url.clone();
        let auth = mama.auth();
        tasks.push(tokio::spawn(async move {
            let r = request(
                "PUT",
                &url,
                &[("Authorization", &auth), ("Content-Type", "application/json")],
                Some(&body),
            )
            .await;
            (i, r)
        }));
    }
    let mut winners = Vec::new();
    for t in tasks {
        let (i, r) = t.await.unwrap();
        match r.status {
            200 => winners.push(i),
            409 => {
                assert_eq!(r.json()["error"], "stale_version");
                assert_eq!(r.json()["version"], 2);
            }
            s => panic!("unexpected {s}: {}", text(&r)),
        }
    }
    assert_eq!(winners.len(), 1, "exactly one change wins");
    let w = winners[0];
    let res = papa.get(&srv, &format!("/v1/chats/{g}/state/2")).await;
    assert_eq!(res.body, format!("v2-{w}").into_bytes());
    let state_dir = tmp.path().join("chats").join(g.to_string()).join("state");
    let mut files: Vec<String> = std::fs::read_dir(&state_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, vec!["1.enc", "2.enc"]);
    // Only the winner's keys were stored.
    let k = papa.get(&srv, "/v1/keys").await.json();
    assert_eq!(k["keys"].as_array().unwrap().len(), 2);
    assert_eq!(b64d(&k["keys"][1]["key"]), format!("e1-{w}-{}", papa.user).into_bytes());
    let ev = papa.feed(&srv, 0).await;
    assert_eq!(
        notices(&ev).len(),
        2,
        "one notice for the creation, one for the winning change"
    );
}

#[tokio::test]
async fn group_requests_are_validated() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa, son, daughter) = four(&srv).await;
    let g = new_chat_id();
    assert_eq!(create_group(&srv, &mama, &g, &[&mama, &papa]).await.status, 201);

    // Taken ids: an existing group, a direct chat id (even unused).
    let res = create_group(&srv, &papa, &g, &[&papa]).await;
    assert_eq!((res.status, res.json()["error"].clone()), (409, json!("chat_exists")));
    let dm = son.chat_with(&srv.server_id(), &daughter);
    let res = create_group(&srv, &son, &dm, &[&son]).await;
    assert_eq!((res.status, res.json()["error"].clone()), (409, json!("chat_exists")));
    let selfchat = son.chat_with(&srv.server_id(), &son);
    assert_eq!(create_group(&srv, &son, &selfchat, &[&son]).await.status, 409);

    // Keys must match the members; the creator must be a member.
    let body = json!({
        "chatId": new_chat_id().to_string(), "state": b64e(b"s"), "members": ids(&[&son, &daughter]),
        "epoch": 0, "keys": keys_for(&[&son], "k"),
    });
    assert_eq!(
        son.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        400
    );
    let body = json!({
        "chatId": new_chat_id().to_string(), "state": b64e(b"s"), "members": ids(&[&daughter]),
        "epoch": 0, "keys": keys_for(&[&daughter], "k"),
    });
    assert_eq!(
        son.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        400
    );
    // Repeated member, empty state, bad base64, unknown field.
    let body = json!({
        "chatId": new_chat_id().to_string(), "state": b64e(b"s"), "members": ids(&[&son, &son]),
        "epoch": 0, "keys": keys_for(&[&son], "k"),
    });
    assert_eq!(
        son.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        400
    );
    let body = json!({
        "chatId": new_chat_id().to_string(), "state": "", "members": ids(&[&son]),
        "epoch": 0, "keys": keys_for(&[&son], "k"),
    });
    assert_eq!(
        son.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        400
    );
    let body = json!({
        "chatId": new_chat_id().to_string(), "state": "a=", "members": ids(&[&son]),
        "epoch": 0, "keys": keys_for(&[&son], "k"),
    });
    assert_eq!(
        son.send(&srv, "POST", "/v1/chats", Some(&body.to_string()))
            .await
            .status,
        400
    );

    // A removed member cannot be added; one already in the group may stay.
    assert_eq!(
        mama.send(&srv, "DELETE", &format!("/v1/admin/users/{}", daughter.user), None)
            .await
            .status,
        204
    );
    let res = create_group(&srv, &son, &new_chat_id(), &[&son, &daughter]).await;
    assert_eq!((res.status, res.json()["error"].clone()), (400, json!("bad_member")));
    let res = change_state(
        &srv,
        &mama,
        &g,
        1,
        &[&mama, &papa, &daughter],
        &mama,
        0,
        keys_for(&[&daughter], "k"),
        b"s2",
    )
    .await;
    assert_eq!((res.status, res.json()["error"].clone()), (400, json!("bad_member")));

    // Epoch only the same or the next; a new epoch needs a key per member;
    // an added member needs a key.
    let res = change_state(&srv, &mama, &g, 1, &[&mama, &papa], &mama, 2, json!([]), b"s2").await;
    assert_eq!(res.status, 400);
    let res = change_state(
        &srv,
        &mama,
        &g,
        1,
        &[&mama, &papa],
        &mama,
        1,
        keys_for(&[&mama], "k"),
        b"s2",
    )
    .await;
    assert_eq!(res.status, 400);
    let res = change_state(&srv, &mama, &g, 1, &[&mama, &papa, &son], &mama, 0, json!([]), b"s2").await;
    assert_eq!(res.status, 400);
    let res = change_state(&srv, &mama, &g, 1, &[&papa], &mama, 0, json!([]), b"s2").await;
    assert_eq!(res.status, 400, "the owner must be a member");
    let res = change_state(&srv, &mama, &g, 1, &[&mama], &mama, 0, json!([]), b"s2").await;
    assert_eq!(res.status, 400, "removing a member needs a new epoch");
    assert_eq!(res.json()["epoch"], 0);
    // Sealed keys are opaque strings, stored and returned as sent.
    let res = change_state(
        &srv,
        &mama,
        &g,
        1,
        &[&mama, &papa],
        &mama,
        0,
        json!([{"userId": papa.user.to_string(), "key": "{\"payload\":\"x\",\"sig\":\"y\"}"}]),
        b"s2",
    )
    .await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let k = papa.get(&srv, "/v1/keys?after=1").await.json();
    assert_eq!(k["keys"][0]["key"], "{\"payload\":\"x\",\"sig\":\"y\"}");
    let long = "k".repeat(8193);
    let res = change_state(
        &srv,
        &mama,
        &g,
        2,
        &[&mama, &papa],
        &mama,
        0,
        json!([{"userId": papa.user.to_string(), "key": long}]),
        b"s3",
    )
    .await;
    assert_eq!(res.status, 400);
    // Non-member, non-owner, direct chat, unknown chat.
    let res = change_state(&srv, &son, &g, 1, &[&mama, &papa], &mama, 0, json!([]), b"s2").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_member")));
    let res = change_state(&srv, &papa, &g, 1, &[&mama, &papa], &mama, 0, json!([]), b"s2").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_owner")));
    let dm = mama.chat_with(&srv.server_id(), &papa);
    assert_eq!(mama.post_event(&srv, &dm, &new_msg_id(), b"x").await.status, 200);
    let res = change_state(&srv, &mama, &dm, 0, &[&mama, &papa], &mama, 0, json!([]), b"s2").await;
    assert_eq!(res.status, 400);
    let res = change_state(&srv, &mama, &new_chat_id(), 1, &[&mama], &mama, 0, json!([]), b"s2").await;
    assert_eq!(res.status, 404);
    // Only the one valid change above went through.
    let chats = mama.get(&srv, "/v1/chats").await.json();
    let gj = chats["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["chatId"] == g.to_string())
        .unwrap()
        .clone();
    assert_eq!(gj["version"], 2);
    let dj = chats["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["chatId"] == dm.to_string())
        .unwrap()
        .clone();
    assert_eq!(dj["kind"], "dm");
    assert!(dj["owner"].is_null() && dj["version"].is_null());
}

#[tokio::test]
async fn family_removal_and_revocation_notify_group_owners() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa, son, daughter) = four(&srv).await;
    let g1 = new_chat_id();
    assert_eq!(create_group(&srv, &mama, &g1, &[&mama, &papa, &son]).await.status, 201);
    let g2 = new_chat_id();
    assert_eq!(
        create_group(&srv, &papa, &g2, &[&papa, &mama, &daughter]).await.status,
        201
    );
    let cm = last_gseq(&mama.feed(&srv, 0).await);
    let cd = last_gseq(&daughter.feed(&srv, 0).await);

    // Papa removed from the family: the owner of g1 is told; in g2 papa is
    // the owner, so the other members are told.
    assert_eq!(
        mama.send(&srv, "DELETE", &format!("/v1/admin/users/{}", papa.user), None)
            .await
            .status,
        204
    );
    let ev = mama.feed(&srv, cm).await;
    let mut got: Vec<(String, String)> = ev
        .iter()
        .map(|e| {
            (
                e["chatId"].as_str().unwrap().to_string(),
                e["notice"]["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    got.sort();
    let mut want = vec![
        (g1.to_string(), "member_removed".to_string()),
        (g2.to_string(), "member_removed".to_string()),
    ];
    want.sort();
    assert_eq!(got, want);
    assert!(ev.iter().all(|e| e["notice"]["userId"] == papa.user.to_string()));
    let ev = daughter.feed(&srv, cd).await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["chatId"], g2.to_string());
    assert!(
        son.feed(&srv, 0)
            .await
            .iter()
            .all(|e| e["notice"]["type"] != "member_removed")
    );
    // Group events still go through although a member was removed.
    assert_eq!(
        son.post_event_epoch(&srv, &g1, &new_msg_id(), 0, b"s").await.status,
        200
    );

    // Son revokes his identity: the owner of g1 is told.
    let cm = last_gseq(&mama.feed(&srv, 0).await);
    let env = testkit::revocation(&son.key, &son.user, 123);
    let res = request(
        "POST",
        &srv.url("/v1/revoke"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&env).to_string()),
    )
    .await;
    assert_eq!(res.status, 204, "{}", text(&res));
    let ev = mama.feed(&srv, cm).await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["notice"]["type"], "member_revoked");
    assert_eq!(ev[0]["notice"]["userId"], son.user.to_string());
}

#[tokio::test]
async fn revocation_stops_the_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let dm = mama.chat_with(&srv.server_id(), &papa);
    assert_eq!(mama.post_event(&srv, &dm, &new_msg_id(), b"hi").await.status, 200);
    let url = srv.url("/v1/events?after=1&wait=20");
    let auth = papa.auth();
    let pending = tokio::spawn(async move { request("GET", &url, &[("Authorization", &auth)], None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;

    let post = |env: fcd::envelope::Envelope| {
        let url = srv.url("/v1/revoke");
        async move {
            request(
                "POST",
                &url,
                &[("Content-Type", "application/json")],
                Some(&env_json(&env).to_string()),
            )
            .await
        }
    };
    // Signed by someone else: 401, counted by the rate limiter.
    let res = post(testkit::revocation(&mama.key, &papa.user, 1)).await;
    assert_eq!((res.status, res.json()["error"].clone()), (401, json!("bad_signature")));
    // Unknown user, malformed payload.
    let other = new_key();
    let (ouid, _) = testkit::identity(&other);
    assert_eq!(post(testkit::revocation(&other, &ouid, 1)).await.status, 404);
    let bad = testkit::seal(&papa.key, fcd::envelope::Kind::Revoked, r#"{"v":1,"userId":"x"}"#);
    assert_eq!(post(bad).await.status, 400);
    // A profile signature does not count as a revocation.
    let wrong_kind = testkit::seal(
        &papa.key,
        fcd::envelope::Kind::Profile,
        &format!(r#"{{"v":1,"userId":"{}","revokedAt":1}}"#, papa.user),
    );
    assert_eq!(post(wrong_kind).await.status, 401);

    let env = testkit::revocation(&papa.key, &papa.user, 777);
    assert_eq!(post(env.clone()).await.status, 204);
    assert_eq!(post(env.clone()).await.status, 204, "repeat is fine");

    let res = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("revoked")));
    let res = papa.get(&srv, "/v1/me").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("revoked")));
    let users = mama.get(&srv, "/v1/users").await.json();
    let p = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == papa.user.to_string())
        .unwrap()
        .clone();
    assert_eq!(p["revoked"], env_json(&env));
    assert_eq!(p["removed"], false);
    let m = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == mama.user.to_string())
        .unwrap()
        .clone();
    assert!(m["revoked"].is_null());
    let admin = mama.get(&srv, "/v1/admin/users").await.json();
    assert!(admin["users"].as_array().unwrap().iter().any(|u| u["revoked"] == true));
    let res = mama.post_event(&srv, &dm, &new_msg_id(), b"x").await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("peer_removed")));

    // No new device, no rejoin with the same identity.
    let nonce = request("POST", &srv.url("/v1/auth/challenge"), &[], None).await.json()["nonce"]
        .as_str()
        .unwrap()
        .to_string();
    let a = papa.auth_envelope(&srv.server_id(), &nonce, &new_dev());
    let res = request(
        "POST",
        &srv.url("/v1/auth/device"),
        &[("Content-Type", "application/json")],
        Some(&env_json(&a).to_string()),
    )
    .await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("revoked")));
    let code = invite(&srv, &mama).await;
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&join_body(&papa.key, "Папа", "invite", &code, &new_dev())),
    )
    .await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("revoked")));

    // Kept across a restart; the file holds the envelope as posted.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let f: Value = serde_json::from_slice(
        &std::fs::read(data.join("users").join(papa.user.to_string()).join("revoked.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(f["payload"], env.payload);
    let srv = open(&data, Overrides::default()).await;
    assert_eq!(papa.get(&srv, "/v1/me").await.status, 403);
}

#[tokio::test]
async fn invitation_details_before_joining() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            family_name: Some("Ивановы".into()),
            ..Default::default()
        },
    )
    .await;
    let (mama, _papa) = family(&srv).await;
    let check = |code: String| {
        let url = srv.url("/v1/invites/check");
        async move {
            request(
                "POST",
                &url,
                &[("Content-Type", "application/json")],
                Some(&json!({ "invite": code }).to_string()),
            )
            .await
        }
    };
    let code = invite(&srv, &mama).await;
    let res = check(format!(" {} ", code.to_uppercase())).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let j = res.json();
    assert_eq!(j["status"], "valid");
    assert_eq!(j["familyName"], "Ивановы");
    assert_eq!(j["createdBy"]["userId"], mama.user.to_string());
    assert_eq!(j["createdBy"]["name"], "Мама");
    // M7: the profile has no gender field, so male.
    assert_eq!(j["createdBy"]["gender"], "m");
    assert!(j["expiresAt"].as_u64().unwrap() > j["createdAt"].as_u64().unwrap());
    // The check does not use the invitation up.
    join(&srv, "Сын", "invite", &code).await;
    assert_eq!(check(code.clone()).await.json()["status"], "used");

    // Expired.
    let code2 = invite(&srv, &mama).await;
    let p = tmp
        .path()
        .join("invites")
        .join(format!("{}.json", fcd::store::invite_hash(&code2)));
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    // The hourly cleanup deletes invitations past their expiry; one that
    // expires between two cleanups is reported as expired.
    let mut f: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    let expires = fcd::datadir::now_ms() + 1500;
    f["expiresAt"] = json!(expires);
    std::fs::write(&p, f.to_string()).unwrap();
    let srv = open(&data, Overrides::default()).await;
    let check = |code: String| {
        let url = srv.url("/v1/invites/check");
        async move {
            request(
                "POST",
                &url,
                &[("Content-Type", "application/json")],
                Some(&json!({ "invite": code }).to_string()),
            )
            .await
        }
    };
    while fcd::datadir::now_ms() <= expires {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let j = check(code2.clone()).await.json();
    assert_eq!(j["status"], "expired");
    assert_eq!(j["expiresAt"], expires);

    // Unknown codes: 403, counted; after 10 the address is limited.
    for _ in 0..10 {
        let res = check(new_msg_id()).await;
        assert_eq!(
            (res.status, res.json()["error"].clone()),
            (403, json!("invalid_invite"))
        );
    }
    let res = check(code2).await;
    assert_eq!(res.status, 429);
    assert!(res.header("retry-after").is_some());
    let res = request("POST", &srv.url("/v1/invites/check"), &[], Some("{}")).await;
    assert_eq!(res.status, 429);
}

#[tokio::test]
async fn chat_with_oneself() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let tablet = second_device(&srv, &mama).await;
    let me = mama.chat_with(&srv.server_id(), &mama);
    // History of a not yet created chat with oneself is empty, not 404.
    assert_eq!(
        mama.get(&srv, &format!("/v1/chats/{me}/events")).await.json()["events"],
        json!([])
    );
    let res = mama.post_event(&srv, &me, &new_msg_id(), b"note").await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let chats = tablet.get(&srv, "/v1/chats").await.json();
    assert_eq!(chats["chats"][0]["chatId"], me.to_string());
    assert_eq!(chats["chats"][0]["kind"], "dm");
    assert_eq!(
        chats["chats"][0]["members"],
        json!([mama.user.to_string(), mama.user.to_string()])
    );
    let ev = tablet.feed(&srv, 0).await;
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["devId"], mama.dev.to_string());
    assert_eq!(b64d(&ev[0]["body"]), b"note");
    assert_eq!(
        tablet.post_event(&srv, &me, &new_msg_id(), b"from tablet").await.status,
        200
    );
    assert_eq!(mama.feed(&srv, 0).await.len(), 2);
    // Nobody else sees it or can write there.
    assert!(papa.feed(&srv, 0).await.is_empty());
    assert_eq!(papa.post_event(&srv, &me, &new_msg_id(), b"x").await.status, 403);
    assert_eq!(papa.get(&srv, &format!("/v1/chats/{me}/events")).await.status, 403);
}

#[tokio::test]
async fn events_carry_the_oldest_time() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let j = mama.get(&srv, "/v1/events").await.json();
    assert!(j["oldestTime"].is_null(), "empty log");
    let dm = mama.chat_with(&srv.server_id(), &papa);
    let t = mama.post_event(&srv, &dm, &new_msg_id(), b"x").await.json()["time"].clone();
    mama.post_event(&srv, &dm, &new_msg_id(), b"y").await;
    assert_eq!(papa.get(&srv, "/v1/events?after=5").await.json()["oldestTime"], t);
    assert_eq!(
        papa.get(&srv, &format!("/v1/chats/{dm}/events")).await.json()["oldestTime"],
        t
    );
}

/// Smallest JPEG and WebP signatures with some payload.
fn jpeg(n: usize) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
    v.resize(n, 7);
    v
}

fn webp(n: usize) -> Vec<u8> {
    let mut v = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    v.resize(n, 9);
    v
}

#[tokio::test]
async fn avatars() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;

    let res = mama
        .send_bytes(&srv, "PUT", "/v1/me/avatar", b"GIF89a....".to_vec())
        .await;
    assert_eq!((res.status, res.json()["error"].clone()), (400, json!("bad_image")));
    let res = mama
        .send_bytes(&srv, "PUT", "/v1/me/avatar", jpeg(256 * 1024 + 1))
        .await;
    assert_eq!(res.status, 413);
    let img = jpeg(256 * 1024);
    let res = mama.send_bytes(&srv, "PUT", "/v1/me/avatar", img.clone()).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let a = res.json();
    assert_eq!(a["type"], "image/jpeg");
    use sha2::Digest;
    assert_eq!(a["sha256"], b64e(&sha2::Sha256::digest(&img)));

    // Served to family members by hash, cacheable, never as a document.
    let path = format!("/v1/users/{}/avatar/{}", mama.user, a["sha256"].as_str().unwrap());
    let res = papa.get(&srv, &path).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, img);
    assert_eq!(res.header("content-type"), Some("image/jpeg"));
    assert_eq!(
        res.header("cache-control"),
        Some("private, max-age=31536000, immutable")
    );
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert!(res.header("content-security-policy").unwrap().contains("sandbox"));
    assert_eq!(get(&srv.url(&path)).await.status, 401);
    let other = format!("/v1/users/{}/avatar/{}", mama.user, b64e(&[0u8; 32]));
    assert_eq!(papa.get(&srv, &other).await.status, 404);

    // A profile may name only an uploaded avatar.
    let fake = json!({"sha256": b64e(&[1u8; 32]), "type": "image/jpeg"});
    let p = testkit::profile_with_avatar(&mama.key, &mama.user, "Мама", 2, fake);
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
        .await;
    assert_eq!(
        (res.status, res.json()["error"].clone()),
        (400, json!("unknown_avatar"))
    );
    let wrong_type = json!({"sha256": a["sha256"], "type": "image/webp"});
    let p = testkit::profile_with_avatar(&mama.key, &mama.user, "Мама", 2, wrong_type);
    assert_eq!(
        mama.send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
            .await
            .status,
        400
    );
    let p = testkit::profile_with_avatar(&mama.key, &mama.user, "Мама", 2, json!("legacy"));
    assert_eq!(
        mama.send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
            .await
            .status,
        400
    );
    let p = testkit::profile_with_avatar(&mama.key, &mama.user, "Мама", 2, a.clone());
    let res = mama
        .send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
        .await;
    assert_eq!(res.status, 200, "{}", text(&res));

    // A new upload keeps the profile's image; setting the new one in the
    // profile deletes the old file.
    let img2 = webp(1000);
    let a2 = mama.send_bytes(&srv, "PUT", "/v1/me/avatar", img2.clone()).await.json();
    assert_eq!(a2["type"], "image/webp");
    let user_dir = tmp.path().join("users").join(mama.user.to_string());
    let avatar_files = || {
        let mut v: Vec<String> = std::fs::read_dir(&user_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("avatar."))
            .collect();
        v.sort();
        v
    };
    assert_eq!(avatar_files().len(), 2);
    assert_eq!(papa.get(&srv, &path).await.status, 200);
    let p = testkit::profile_with_avatar(&mama.key, &mama.user, "Мама", 3, a2.clone());
    assert_eq!(
        mama.send(&srv, "PUT", "/v1/me/profile", Some(&env_json(&p).to_string()))
            .await
            .status,
        200
    );
    let files = avatar_files();
    assert_eq!(files.len(), 1);
    assert!(files[0].ends_with(".webp"));
    assert_eq!(papa.get(&srv, &path).await.status, 404);

    // Joining with an avatar is refused (nothing uploaded yet).
    let key = new_key();
    let (uid, identity) = testkit::identity(&key);
    let profile = testkit::profile_with_avatar(&key, &uid, "Сын", 1, a2.clone());
    let code = invite(&srv, &mama).await;
    let body = json!({"invite": code, "identity": env_json(&identity), "profile": env_json(&profile), "devId": new_dev().to_string()});
    let res = request(
        "POST",
        &srv.url("/v1/join"),
        &[("Content-Type", "application/json")],
        Some(&body.to_string()),
    )
    .await;
    assert_eq!(res.status, 400);

    // After a restart the avatar is still served.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open(&data, Overrides::default()).await;
    let path2 = format!("/v1/users/{}/avatar/{}", mama.user, a2["sha256"].as_str().unwrap());
    let res = papa.get(&srv, &path2).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, img2);
    assert_eq!(res.header("content-type"), Some("image/webp"));
}

#[tokio::test]
async fn security_headers_on_static_and_api() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let csp = fcd::headers::client_csp_header();
    assert!(csp.ends_with("; frame-ancestors 'none'"));
    let index = get(&srv.url("/")).await;
    let asset = String::from_utf8_lossy(&index.body)
        .split('"')
        .find(|s| s.contains("assets/") && s.ends_with(".js"))
        .map(|s| s.trim_start_matches("./").trim_start_matches('/').to_string())
        .expect("index.html links a script under assets/");
    for (path, cache) in [
        ("/".to_string(), "no-cache"),
        ("/server/".to_string(), "no-cache"),
        ("/sw.js".to_string(), "no-store"),
        (format!("/{asset}"), "public, max-age=31536000, immutable"),
    ] {
        let res = get(&srv.url(&path)).await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.header("content-security-policy"), Some(csp.as_str()), "{path}");
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"), "{path}");
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"), "{path}");
        assert_eq!(res.header("cache-control"), Some(cache), "{path}");
    }
    let res = get(&srv.url("/nope.txt")).await;
    assert_eq!(res.status, 404);
    assert_eq!(res.header("content-security-policy"), Some(csp.as_str()));

    for res in [
        get(&srv.url("/v1/hello")).await,
        get(&srv.url("/v1/events")).await,
        get(&srv.url("/v1/nope")).await,
        request("OPTIONS", &srv.url("/v1/events"), &[], None).await,
    ] {
        assert_eq!(res.header("cache-control"), Some("no-store"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(res.header("content-security-policy"), Some(fcd::headers::API_CSP));
    }
}

#[tokio::test]
async fn group_keys_of_an_unfinished_change_are_dropped_at_start() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let g = new_chat_id();
    assert_eq!(create_group(&srv, &mama, &g, &[&mama, &papa]).await.status, 201);
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    // As if the server crashed after writing keys and state for version 2
    // but before `meta.json`.
    let kdir = data.join("users").join(papa.user.to_string()).join("keys");
    let orphan = kdir.join("2.key");
    std::fs::write(
        &orphan,
        json!({"chatId": g.to_string(), "epoch": 1, "version": 2, "createdAt": 1, "key": b64e(b"orphan")}).to_string(),
    )
    .unwrap();
    let sdir = data.join("chats").join(g.to_string()).join("state");
    std::fs::write(sdir.join("2.enc"), b"orphan state").unwrap();
    let srv = open(&data, Overrides::default()).await;
    assert!(!orphan.exists());
    assert_eq!(
        papa.get(&srv, "/v1/keys").await.json()["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(papa.get(&srv, &format!("/v1/chats/{g}/state/2")).await.status, 404);
    // The next change takes version 2 and overwrites the orphan.
    let res = change_state(&srv, &mama, &g, 1, &[&mama, &papa], &mama, 0, json!([]), b"real").await;
    assert_eq!(res.status, 200);
    assert_eq!(papa.get(&srv, &format!("/v1/chats/{g}/state/2")).await.body, b"real");
    assert_eq!(
        papa.get(&srv, "/v1/keys").await.json()["keys"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
