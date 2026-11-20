//! Over HTTP: the MCP endpoint (`/mcp`) and its tools, against a member with
//! real keys who reads and writes through the ordinary API.

mod common;

use std::time::{Duration, Instant};

use common::person::{Mcp, Person};
use common::*;
use fcd::client::payload::Payload;
use fcd::config::Overrides;
use serde_json::{Value, json};

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

async fn post(srv: &TestServer, headers: &[(&str, &str)], body: &str) -> Res {
    let mut h = vec![("Content-Type", "application/json")];
    h.extend_from_slice(headers);
    request("POST", &srv.url("/mcp"), &h, Some(body)).await
}

fn texts(list: &Value) -> Vec<String> {
    list["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap_or("").to_string())
        .collect()
}

#[tokio::test]
async fn transport_both_revisions() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, _papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let auth = format!("Bearer {}", bot.token);
    let auth = ("Authorization", auth.as_str());

    // No streams, no sessions.
    for method in ["GET", "DELETE"] {
        let res = request(method, &srv.url("/mcp"), &[auth], None).await;
        assert_eq!(res.status, 405, "{method}");
        assert_eq!(res.header("allow"), Some("POST"));
    }
    // The answers are API answers: never cached, never a page, and not open to other sites.
    let res = bot.rpc(&srv, "tools/list", json!({})).await;
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert!(res.header("content-security-policy").unwrap().contains("sandbox"));
    assert!(res.header("access-control-allow-origin").is_none());
    let res = post(&srv, &[auth, ("Origin", "https://evil.example")], "{}").await;
    assert_eq!(res.status, 403, "{}", text(&res));
    assert_eq!(res.json()["error"], "bad_origin");

    // --- revisions that begin with initialize ---
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } },
    });
    let res = post(&srv, &[auth], &init.to_string()).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.header("content-type"), Some("application/json"));
    let j = res.json();
    assert_eq!(j["id"], 1);
    assert_eq!(j["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(j["result"]["capabilities"], json!({ "tools": {} }));
    assert_eq!(j["result"]["serverInfo"]["name"], "family-chat");
    assert!(j["result"]["instructions"].as_str().unwrap().contains("whoami"));
    assert!(j["result"].get("resultType").is_none());
    // A version this server does not speak: it answers with one it does.
    let mut old = init.clone();
    old["params"]["protocolVersion"] = json!("2024-11-05");
    let res = post(&srv, &[auth], &old.to_string()).await;
    assert_eq!(res.json()["result"]["protocolVersion"], "2025-11-25");
    // A notification is taken without an answer.
    let res = post(
        &srv,
        &[auth],
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    )
    .await;
    assert_eq!(res.status, 202, "{}", text(&res));
    assert!(res.body.is_empty());
    let legacy = [auth, ("MCP-Protocol-Version", "2025-06-18")];
    let res = post(&srv, &legacy, r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#).await;
    assert_eq!(res.json(), json!({ "jsonrpc": "2.0", "id": "a", "result": {} }));
    // Without a version header: a client older than 2025-06-18.
    let res = post(&srv, &[auth], r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let tools = res.json()["result"]["tools"].as_array().unwrap().clone();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(
        names.contains(&"whoami") && names.contains(&"message_send"),
        "{names:?}"
    );
    let send = tools.iter().find(|t| t["name"] == "message_send").unwrap();
    assert_eq!(send["inputSchema"]["type"], "object");
    assert_eq!(send["annotations"]["readOnlyHint"], false);
    assert_eq!(send["annotations"]["destructiveHint"], false);
    let list = tools.iter().find(|t| t["name"] == "messages_list").unwrap();
    assert_eq!(list["annotations"]["readOnlyHint"], true);
    let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "whoami" } });
    let res = post(&srv, &legacy, &call.to_string()).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let who: Value = serde_json::from_str(res.json()["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(who["userId"], bot.user.to_string());
    let res = post(&srv, &legacy, r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["error"]["code"], -32601);

    // --- 2026-07-28: every request names its version ---
    let res = bot.rpc(&srv, "server/discover", json!({})).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let r = res.json()["result"].clone();
    assert_eq!(r["resultType"], "complete");
    assert_eq!(r["supportedVersions"][0], "2026-07-28");
    assert_eq!(r["capabilities"], json!({ "tools": {} }));
    assert_eq!(r["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "family-chat");
    let res = bot.rpc(&srv, "tools/list", json!({})).await;
    let r = res.json()["result"].clone();
    assert_eq!(r["resultType"], "complete");
    assert_eq!(r["cacheScope"], "private");
    assert_eq!(r["tools"].as_array().unwrap().len(), tools.len());
    let res = bot.rpc(&srv, "resources/list", json!({})).await;
    assert_eq!(res.status, 404, "{}", text(&res));
    assert_eq!(res.json()["error"]["code"], -32601);

    let modern = |method: &'static str| vec![auth, ("MCP-Protocol-Version", "2026-07-28"), ("Mcp-Method", method)];
    let meta = json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} });
    let body = |method: &str, mut params: Value| {
        params["_meta"] = meta.clone();
        json!({ "jsonrpc": "2.0", "id": 9, "method": method, "params": params }).to_string()
    };
    // The headers must agree with the body.
    let res = post(&srv, &modern("tools/call"), &body("tools/list", json!({}))).await;
    assert_eq!(res.status, 400, "{}", text(&res));
    assert_eq!(res.json()["error"]["code"], -32020);
    let res = post(
        &srv,
        &modern("tools/call"),
        &body("tools/call", json!({ "name": "whoami" })),
    )
    .await;
    assert_eq!(res.json()["error"]["code"], -32020, "Mcp-Name is missing");
    let mut h = modern("tools/call");
    h.push(("Mcp-Name", "members_list"));
    let res = post(&srv, &h, &body("tools/call", json!({ "name": "whoami" }))).await;
    assert_eq!(res.json()["error"]["code"], -32020, "Mcp-Name names another tool");
    let mut h = modern("tools/call");
    h.push(("Mcp-Name", "=?base64?d2hvYW1p?="));
    let res = post(&srv, &h, &body("tools/call", json!({ "name": "whoami" }))).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let res = post(
        &srv,
        &modern("tools/list"),
        r#"{"jsonrpc":"2.0","id":9,"method":"tools/list"}"#,
    )
    .await;
    assert_eq!(res.status, 400, "{}", text(&res));
    assert_eq!(
        res.json()["error"]["code"],
        -32602,
        "the version is missing from the body"
    );
    let res = post(
        &srv,
        &[
            auth,
            ("MCP-Protocol-Version", "2031-01-01"),
            ("Mcp-Method", "tools/list"),
        ],
        &body("tools/list", json!({})),
    )
    .await;
    assert_eq!(res.status, 400, "{}", text(&res));
    let e = res.json()["error"].clone();
    assert_eq!(e["code"], -32022);
    assert_eq!(e["data"]["requested"], "2031-01-01");
    assert!(
        e["data"]["supported"]
            .as_array()
            .unwrap()
            .contains(&json!("2026-07-28"))
    );

    // --- malformed messages ---
    let res = post(&srv, &[auth], "{not json").await;
    assert_eq!((res.status, res.json()["error"]["code"].as_i64()), (400, Some(-32700)));
    let res = post(&srv, &[auth], r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#).await;
    assert_eq!((res.status, res.json()["error"]["code"].as_i64()), (400, Some(-32600)));
    let res = post(&srv, &[auth], r#"{"jsonrpc":"2.0","id":1,"result":{}}"#).await;
    assert_eq!((res.status, res.json()["error"]["code"].as_i64()), (400, Some(-32600)));
    let res = bot.rpc(&srv, "tools/call", json!({ "name": "launch_rocket" })).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json()["error"]["code"], -32602);
    assert!(
        res.json()["error"]["message"]
            .as_str()
            .unwrap()
            .contains("launch_rocket")
    );
    // Wrong arguments are told to the model inside the result.
    assert_eq!(bot.err(&srv, "messages_list", json!({})).await, "invalid_argument");
    assert_eq!(
        bot.err(&srv, "messages_list", json!({ "chat": "nope" })).await,
        "chat_not_found"
    );
    assert_eq!(bot.err(&srv, "whoami", json!({ "extra": 1 })).await, "invalid_argument");
}

#[tokio::test]
async fn tokens_are_checked_and_guesses_are_limited() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;

    let res = post(&srv, &[], ping).await;
    assert_eq!(res.status, 401, "{}", text(&res));
    assert_eq!(res.header("www-authenticate"), Some("Bearer"));
    // A device token of the app is not an MCP token.
    let device = format!("Bearer {}", papa.token);
    assert_eq!(post(&srv, &[("Authorization", &device)], ping).await.status, 401);

    // The helper is removed from the family: its token stops working.
    let good = format!("Bearer {}", bot.token);
    assert_eq!(post(&srv, &[("Authorization", &good)], ping).await.status, 200);
    let res = mama
        .send(&srv, "DELETE", &format!("/v1/admin/users/{}", bot.user), None)
        .await;
    assert!(res.status < 300, "{}", text(&res));
    let res = post(&srv, &[("Authorization", &good)], ping).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    assert_eq!(res.json()["error"], "identity_gone");

    // Ten wrong tokens from one address, then nothing more for a minute, also with a good one.
    let other = Mcp::helper(&srv, &mama, "Вторая").await;
    // (The device token above was the first wrong one.)
    for _ in 0..9 {
        assert_eq!(
            post(&srv, &[("Authorization", "Bearer fcm_wrong")], ping).await.status,
            401
        );
    }
    let res = post(&srv, &[("Authorization", "Bearer fcm_wrong")], ping).await;
    assert_eq!(res.status, 429, "{}", text(&res));
    assert!(res.header("retry-after").is_some());
    let good = format!("Bearer {}", other.token);
    assert_eq!(post(&srv, &[("Authorization", &good)], ping).await.status, 429);
}

#[tokio::test]
async fn switched_off_by_the_setting() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        Overrides {
            mcp: Some(false),
            ..Default::default()
        },
    )
    .await;
    let res = post(&srv, &[], r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
    assert_eq!(res.status, 404, "{}", text(&res));
    assert_eq!(res.json()["error"], "mcp_disabled");
}

#[tokio::test]
async fn a_helper_reads_and_writes_direct_chats() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;

    let who = bot.ok(&srv, "whoami", json!({})).await;
    assert_eq!(who["userId"], bot.user.to_string());
    assert_eq!(who["name"], "Помощник");
    assert_eq!(who["administrator"], false);
    assert_eq!(who["levels"], json!(["read", "write"]));
    assert_eq!(who["levelsOff"], json!(["files", "admin", "destructive"]));
    let members = bot.ok(&srv, "members_list", json!({})).await;
    let names: Vec<&str> = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Мама", "Папа", "Помощник"]);
    assert_eq!(members["members"][2]["me"], true);
    assert_eq!(members["members"][0]["administrator"], true);
    assert_eq!(bot.ok(&srv, "chats_list", json!({})).await, json!({ "chats": [] }));

    // A person writes to the helper; the helper reads it.
    let (g1, r1) = papa.say(&srv, &bot.user, "Привет, помощник! Купи молоко").await;
    let chats = bot.ok(&srv, "chats_list", json!({})).await;
    let chat = &chats["chats"][0];
    assert_eq!(chat["kind"], "direct");
    assert_eq!(chat["name"], "Папа");
    assert_eq!(chat["with"], papa.user.to_string());
    assert_eq!(chat["last"]["text"], "Привет, помощник! Купи молоко");
    let chat_id = chat["chat"].as_str().unwrap().to_string();
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat_id })).await;
    assert_eq!(list["chat"]["name"], "Папа");
    assert_eq!(list["more"], false);
    let m = &list["messages"][0];
    assert_eq!(m["id"], g1);
    assert_eq!(m["from"], papa.user.to_string());
    assert_eq!(m["fromName"], "Папа");
    assert!(m.get("mine").is_none());
    assert!(m["time"].as_str().unwrap().ends_with('Z'));

    // A direct chat nobody wrote in yet is known by its id as well (the app computes it).
    let empty = mama_chat(&srv, &bot, &mama);
    assert_eq!(
        bot.ok(&srv, "messages_list", json!({ "chat": empty })).await["chat"]["name"],
        "Мама"
    );

    // The helper answers; the chat can be named by the member's userId too.
    let sent = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": papa.user.to_string(), "text": "Куплю", "reply_to": g1 }),
        )
        .await;
    let g2 = sent["id"].as_u64().unwrap();
    assert_eq!(sent["chat"], chat_id.as_str());
    // The person's app decrypts and verifies it as any other message.
    let seen = papa.read(&srv, &bot.user, g1).await;
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].gseq, seen[0].sender), (g2, bot.user));
    let Payload::Msg(msg) = &seen[0].payload else {
        panic!("not a message")
    };
    assert_eq!(msg.body.as_deref(), Some("Куплю"));
    assert_eq!(msg.reply, Some(r1));
    assert_eq!(msg.common.seq, 1);
    let r2 = fcd::client::payload::MsgRef {
        author: bot.user,
        id: seen[0].msg,
    };
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat_id })).await;
    let mine = &list["messages"][1];
    assert_eq!(mine["mine"], true);
    assert_eq!(
        mine["replyTo"],
        json!({ "id": g1, "from": "Папа", "text": "Привет, помощник! Купи молоко" })
    );

    // Edits: the helper's own, seen by the person; the person's, seen by the helper.
    let edited = bot
        .ok(
            &srv,
            "message_edit",
            json!({ "chat": chat_id, "message": g2, "text": "Куплю два" }),
        )
        .await;
    assert_eq!(edited["id"], g2);
    let seen = papa.read(&srv, &bot.user, g2).await;
    assert!(matches!(&seen[0].payload, Payload::Edit { target, body, .. } if *target == r2 && body == "Куплю два"));
    assert_eq!(
        bot.err(
            &srv,
            "message_edit",
            json!({ "chat": chat_id, "message": g1, "text": "x" })
        )
        .await,
        "not_yours"
    );
    papa.edit(&srv, &bot.user, &r1, "Привет! Купи молоко и хлеб").await;
    // An edit by someone who is not the author changes nothing.
    papa.edit(&srv, &bot.user, &r2, "подделка").await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat_id })).await;
    assert_eq!(texts(&list), ["Привет! Купи молоко и хлеб", "Куплю два"]);
    assert!(list["messages"][0]["edited"].is_string());
    assert!(list["messages"][1]["edited"].is_string());

    // Reactions both ways; the last word of each person per emoji counts.
    papa.react(&srv, &bot.user, &r2, "👍", true).await;
    papa.react(&srv, &bot.user, &r2, "❤️", true).await;
    papa.react(&srv, &bot.user, &r2, "❤️", false).await;
    bot.ok(
        &srv,
        "message_react",
        json!({ "chat": chat_id, "message": g2, "emoji": "👍" }),
    )
    .await;
    bot.ok(
        &srv,
        "message_react",
        json!({ "chat": chat_id, "message": g1, "emoji": "🔥" }),
    )
    .await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat_id })).await;
    assert_eq!(
        list["messages"][1]["reactions"],
        json!([{ "emoji": "👍", "by": ["Папа", "Помощник"], "mine": true }])
    );
    assert_eq!(
        list["messages"][0]["reactions"],
        json!([{ "emoji": "🔥", "by": ["Помощник"], "mine": true }])
    );
    bot.ok(
        &srv,
        "message_react",
        json!({ "chat": chat_id, "message": g1, "emoji": "🔥", "on": false }),
    )
    .await;
    assert_eq!(
        bot.err(
            &srv,
            "message_react",
            json!({ "chat": chat_id, "message": g1, "emoji": "this is far too long to be an emoji" })
        )
        .await,
        "invalid-argument"
    );
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat_id })).await;
    assert!(list["messages"][0].get("reactions").is_none());

    // A location, the notes chat, a forward.
    let loc = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": chat_id, "location": { "lat": 55.75, "lon": 37.62, "accuracy_m": 10 } }),
        )
        .await;
    let seen = papa.read(&srv, &bot.user, loc["id"].as_u64().unwrap() - 1).await;
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    assert_eq!(
        msg.location.map(|l| (l.lat, l.lon, l.accuracy)),
        Some((55.75, 37.62, 10.0))
    );
    assert_eq!(
        bot.err(&srv, "message_send", json!({ "chat": chat_id, "text": "  " }))
            .await,
        "invalid_argument"
    );
    let note = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": bot.user.to_string(), "text": "Список: молоко, хлеб" }),
        )
        .await;
    let fwd = bot
        .ok(
            &srv,
            "message_forward",
            json!({ "chat": chat_id, "message": g1, "to": mama.user.to_string() }),
        )
        .await;
    let seen = mama.read(&srv, &bot.user, 0).await;
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    assert_eq!(seen[0].gseq, fwd["id"].as_u64().unwrap());
    assert!(msg.fwd);
    assert_eq!(msg.body.as_deref(), Some("Привет! Купи молоко и хлеб"));
    let chats = bot.ok(&srv, "chats_list", json!({})).await;
    let kinds: Vec<(&str, &str)> = chats["chats"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["kind"].as_str().unwrap(), c["name"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        [("direct", "Мама"), ("self", "Saved Messages"), ("direct", "Папа")]
    );

    // Search: every word, any case, ё as е; in one chat or by one author.
    let found = bot.ok(&srv, "messages_search", json!({ "query": "МОЛОКО хлеб" })).await;
    assert_eq!(found["messages"].as_array().unwrap().len(), 3, "{found}");
    assert_eq!(found["messages"][0]["chat"], mama_chat(&srv, &bot, &mama));
    let found = bot
        .ok(
            &srv,
            "messages_search",
            json!({ "query": "молоко", "chat": chat_id, "from": papa.user.to_string() }),
        )
        .await;
    assert_eq!(texts(&found), ["Привет! Купи молоко и хлеб"]);
    assert_eq!(found["messages"][0]["chatName"], "Папа");
    assert_eq!(
        bot.ok(&srv, "messages_search", json!({ "query": "кефир" })).await["messages"],
        json!([])
    );
    assert_eq!(note["chat"], chats["chats"][1]["chat"]);

    // Paging: the newest by default, older ones with `before`, newer ones with `after`.
    for i in 0..5 {
        papa.say(&srv, &bot.user, &format!("n{i}")).await;
    }
    let page = bot
        .ok(&srv, "messages_list", json!({ "chat": chat_id, "limit": 2 }))
        .await;
    assert_eq!(texts(&page), ["n3", "n4"]);
    assert_eq!(page["more"], true);
    let first = page["messages"][0]["id"].as_u64().unwrap();
    let page = bot
        .ok(
            &srv,
            "messages_list",
            json!({ "chat": chat_id, "limit": 2, "before": first }),
        )
        .await;
    assert_eq!(texts(&page), ["n1", "n2"]);
    let page = bot
        .ok(
            &srv,
            "messages_list",
            json!({ "chat": chat_id, "limit": 3, "after": g1 }),
        )
        .await;
    assert_eq!(texts(&page)[0], "Куплю два");
    assert_eq!(page["more"], true);

    // What the view holds survives a restart: it is rebuilt from the log.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open_plain(&data, Overrides::default()).await;
    let list = bot
        .ok(
            &srv,
            "messages_list",
            json!({ "chat": chat_id, "limit": 3, "after": g1 - 1 }),
        )
        .await;
    assert_eq!(texts(&list)[..2], ["Привет! Купи молоко и хлеб", "Куплю два"]);
    assert_eq!(list["messages"][1]["reactions"][0]["by"], json!(["Папа", "Помощник"]));
    // The device counter goes on where it stopped.
    let sent = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": chat_id, "text": "после перезапуска" }),
        )
        .await;
    let seen = papa.read(&srv, &bot.user, sent["id"].as_u64().unwrap() - 1).await;
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    // A refused event (the emoji above) took no number.
    assert_eq!(
        msg.common.seq, 7,
        "1 message, 1 edit, 3 reactions, 1 location before it"
    );
}

fn mama_chat(srv: &TestServer, bot: &Mcp, mama: &Person) -> String {
    fcd::ids::ChatId::direct(&srv.server_id(), &bot.user, &mama.user).to_string()
}

#[tokio::test]
async fn deleting_for_me_and_for_everyone() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let chat = papa.user.to_string();
    let (g1, _) = papa.say(&srv, &bot.user, "секрет").await;
    let g2 = bot
        .ok(&srv, "message_send", json!({ "chat": chat, "text": "ошибка" }))
        .await["id"]
        .as_u64()
        .unwrap();
    let g3 = bot
        .ok(&srv, "message_send", json!({ "chat": chat, "text": "остаётся" }))
        .await["id"]
        .as_u64()
        .unwrap();

    // For me: only this connection stops seeing it.
    let res = bot
        .ok(&srv, "message_delete", json!({ "chat": chat, "message": g1 }))
        .await;
    assert_eq!(res["hidden"], true);
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(texts(&list), ["ошибка", "остаётся"]);
    assert_eq!(
        bot.ok(&srv, "messages_search", json!({ "query": "секрет" })).await["messages"],
        json!([])
    );
    assert_eq!(
        bot.err(
            &srv,
            "message_react",
            json!({ "chat": chat, "message": g1, "emoji": "👍" })
        )
        .await,
        "message_not_found"
    );
    assert_eq!(
        papa.read(&srv, &bot.user, 0).await.len(),
        3,
        "the person still has all three"
    );

    // For everyone: needs the destructive level, which only a person switches on.
    let args = json!({ "chat": chat, "message": g2, "for_everyone": true });
    assert_eq!(bot.err(&srv, "message_delete", args.clone()).await, "level_off");
    bot.set_levels(&srv, &mama, &["read", "write", "destructive"]).await;
    // Somebody else's message in a direct chat is not ours to delete.
    bot.set_levels(&srv, &mama, &["read", "write", "destructive"]).await;
    let (g4, _) = papa.say(&srv, &bot.user, "чужое").await;
    assert_eq!(
        bot.err(
            &srv,
            "message_delete",
            json!({ "chat": chat, "message": g4, "for_everyone": true })
        )
        .await,
        "not_yours"
    );
    let res = bot.ok(&srv, "message_delete", args.clone()).await;
    assert_eq!(res["deleted"], true);
    // Again: nothing more happens.
    assert_eq!(bot.ok(&srv, "message_delete", args).await["deleted"], true);
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(
        list["messages"][0],
        json!({
            "id": g2, "time": list["messages"][0]["time"], "from": bot.user.to_string(), "fromName": "Помощник",
            "mine": true, "deleted": true,
        })
    );
    assert_eq!(texts(&list)[1..], ["остаётся", "чужое"]);
    assert_eq!(
        bot.err(
            &srv,
            "message_edit",
            json!({ "chat": chat, "message": g2, "text": "x" })
        )
        .await,
        "message_deleted"
    );
    // The person's app gets the signed delete, and the server's copy of the text is gone.
    let seen = papa.read(&srv, &bot.user, g3).await;
    assert!(
        seen.iter()
            .any(|s| matches!(&s.payload, Payload::Delete { target, .. } if target.author == bot.user))
    );
    let raw = papa.feed(&srv, 0).await;
    let zeroed = raw.iter().find(|e| e["gseq"] == g2).unwrap();
    assert_eq!(
        (zeroed["deleted"].as_bool(), zeroed["body"].as_str()),
        (Some(true), Some(""))
    );

    // After a restart the text is not in the log, and the view shows the same quiet line.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open_plain(&data, Overrides::default()).await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(list["messages"][0]["deleted"], true);
    assert_eq!(texts(&list)[1..], ["остаётся", "чужое"]);
}

#[tokio::test]
async fn waiting_for_new_messages() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    papa.say(&srv, &bot.user, "до начала").await;

    // Without a cursor: from now on. Nothing yet.
    let first = bot.ok(&srv, "events_wait", json!({ "timeout_s": 0 })).await;
    assert_eq!(first["events"], json!([]));
    let cursor = first["cursor"].as_u64().unwrap();

    // What the connection itself sends is not news to it.
    let own = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": papa.user.to_string(), "text": "мой ответ" }),
        )
        .await;
    let (g, r) = papa.say(&srv, &bot.user, "новое").await;
    papa.react(&srv, &bot.user, &r, "👍", true).await;
    papa.edit(&srv, &bot.user, &r, "новое, исправлено").await;
    mama.say(&srv, &bot.user, "и от мамы").await;
    let got = bot
        .ok(&srv, "events_wait", json!({ "cursor": cursor, "timeout_s": 0 }))
        .await;
    let events = got["events"].as_array().unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["message", "reaction", "edited", "message"], "{got}");
    assert_eq!(events[0]["message"]["id"], g);
    assert_eq!(
        events[0]["message"]["text"], "новое, исправлено",
        "the message as it is now"
    );
    assert_eq!(events[0]["chatName"], "Папа");
    assert_eq!(
        (
            events[1]["emoji"].as_str(),
            events[1]["on"].as_bool(),
            events[1]["byName"].as_str()
        ),
        (Some("👍"), Some(true), Some("Папа"))
    );
    assert_eq!(events[1]["messageId"], g);
    assert_eq!(events[3]["message"]["fromName"], "Мама");
    assert!(got["cursor"].as_u64().unwrap() > own["id"].as_u64().unwrap());
    // Only one chat.
    let only = bot
        .ok(
            &srv,
            "events_wait",
            json!({ "cursor": cursor, "timeout_s": 0, "chat": mama.user.to_string() }),
        )
        .await;
    assert_eq!(only["events"].as_array().unwrap().len(), 1);

    // It really waits: the answer comes when the message does, not at the timeout.
    let cursor = got["cursor"].as_u64().unwrap();
    let started = Instant::now();
    let (waited, _) = tokio::join!(
        bot.ok(&srv, "events_wait", json!({ "cursor": cursor, "timeout_s": 20 })),
        async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            papa.say(&srv, &bot.user, "дождался").await
        }
    );
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    assert_eq!(waited["events"][0]["message"]["text"], "дождался");
    // And gives up quietly at the timeout.
    let started = Instant::now();
    let none = bot
        .ok(
            &srv,
            "events_wait",
            json!({ "cursor": waited["cursor"], "timeout_s": 1 }),
        )
        .await;
    assert_eq!(none["events"], json!([]));
    assert!(started.elapsed() >= Duration::from_millis(900));
}

#[tokio::test]
async fn levels_decide_what_a_connection_may_do() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let names = |res: Res| -> Vec<String> {
        res.json()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    };

    bot.set_levels(&srv, &mama, &["read"]).await;
    let listed = names(bot.rpc(&srv, "tools/list", json!({})).await);
    assert!(
        listed.contains(&"messages_list".to_string()) && !listed.contains(&"message_send".to_string()),
        "{listed:?}"
    );
    // Not listed and not callable either.
    let args = json!({ "chat": papa.user.to_string(), "text": "тсс" });
    assert_eq!(bot.err(&srv, "message_send", args.clone()).await, "level_off");
    assert!(papa.read(&srv, &bot.user, 0).await.is_empty());
    assert_eq!(
        bot.ok(&srv, "whoami", json!({})).await["levelsOff"],
        json!(["write", "files", "admin", "destructive"])
    );

    bot.set_levels(&srv, &mama, &[]).await;
    assert!(names(bot.rpc(&srv, "tools/list", json!({})).await).is_empty());
    assert_eq!(bot.err(&srv, "whoami", json!({})).await, "level_off");

    bot.set_levels(&srv, &mama, &["read", "write"]).await;
    bot.ok(&srv, "message_send", args).await;
    assert_eq!(papa.read(&srv, &bot.user, 0).await.len(), 1);
}

#[tokio::test]
async fn a_member_s_own_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let (g1, _) = mama.say(&srv, &papa.user, "Ты где?").await;
    let me = Mcp::me(&srv, &papa, "Claude").await;
    assert_eq!(me.user, papa.user);

    let who = me.ok(&srv, "whoami", json!({})).await;
    assert_eq!(who["name"], "Папа");
    assert!(who["actingAs"].as_str().unwrap().contains("own identity"));
    // It sees what the member sees, including what was written before it was connected.
    let list = me
        .ok(&srv, "messages_list", json!({ "chat": mama.user.to_string() }))
        .await;
    assert_eq!(texts(&list), ["Ты где?"]);
    let first = me.ok(&srv, "events_wait", json!({ "timeout_s": 0 })).await;

    // What it writes is written as the member: other devices and people verify it as such.
    let sent = me
        .ok(
            &srv,
            "message_send",
            json!({ "chat": mama.user.to_string(), "text": "Еду", "reply_to": g1 }),
        )
        .await;
    let seen = mama.read(&srv, &papa.user, g1).await;
    assert_eq!(seen[0].sender, papa.user);
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    assert_eq!(msg.body.as_deref(), Some("Еду"));
    assert_ne!(msg.common.dev, papa.dev, "its own device, with its own counter");

    // The member's phone writes too: for the connection that is news, marked as mine.
    papa.say(&srv, &mama.user, "с телефона").await;
    let got = me
        .ok(
            &srv,
            "events_wait",
            json!({ "cursor": first["cursor"], "timeout_s": 0 }),
        )
        .await;
    let events = got["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "{got}");
    assert_eq!(events[0]["message"]["text"], "с телефона");
    assert_eq!(events[0]["message"]["mine"], true);
    // It may edit what the member wrote from the phone: the author is the same person.
    let phone = events[0]["message"]["id"].as_u64().unwrap();
    me.ok(
        &srv,
        "message_edit",
        json!({ "chat": mama.user.to_string(), "message": phone, "text": "с телефона, да" }),
    )
    .await;
    let seen = mama.read(&srv, &papa.user, sent["id"].as_u64().unwrap()).await;
    assert!(
        seen.iter()
            .any(|s| matches!(&s.payload, Payload::Edit { body, .. } if body == "с телефона, да"))
    );

    // The member revokes the identity: the connection stops at once.
    let revoke = fcd::client::seal::revocation_envelope(&papa.keys, 5);
    let res = papa
        .send(&srv, "POST", "/v1/revoke", Some(&env_json(&revoke).to_string()))
        .await;
    assert!(res.status < 300, "{}", String::from_utf8_lossy(&res.body));
    let res = me.rpc(&srv, "tools/list", json!({})).await;
    assert_eq!(res.status, 403);
}
