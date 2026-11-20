//! Over HTTP: groups through MCP. A connection as a member of a person's
//! group (sealed keys, the chain of signed states, history) and as the owner
//! of its own (create, rename, add, remove, hand over, leave).

mod common;

use common::person::{Mcp, Person};
use common::*;
use fcd::client::group::{add_group_members, remove_group_members, rename_group, system_rng, transfer_group_ownership};
use fcd::client::payload::Payload;
use fcd::config::Overrides;
use fcd::ids::ChatId;
use serde_json::{Value, json};

fn texts(list: &Value) -> Vec<String> {
    list["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap_or("").to_string())
        .collect()
}

fn names(info: &Value) -> Vec<String> {
    info["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_member_of_a_person_s_group() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let son = mama.invite(&srv, "Сын").await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let bot_member = mama.member_of(&srv, &bot.user).await;

    // A group without the helper: it sees nothing of it.
    let mut g = mama.create_group(&srv, "Семья", &[papa.member()]).await;
    mama.say_group(&srv, &g, "до помощника").await;
    assert_eq!(bot.ok(&srv, "chats_list", json!({})).await["chats"], json!([]));
    assert_eq!(
        bot.err(&srv, "messages_list", json!({ "chat": g.chat.to_string() }))
            .await,
        "chat_not_found"
    );

    // Added with history: the key of the current epoch, so what was written before is readable.
    let change = add_group_members(
        &g.state,
        &mama.keys,
        &g.secret,
        std::slice::from_ref(&bot_member),
        true,
        &mut system_rng,
    )
    .unwrap();
    g = mama.change_group(&srv, &g, change).await;
    let (g2, r2) = papa_say(&srv, &papa, &g.chat, "привет, помощник").await;
    let chats = bot.ok(&srv, "chats_list", json!({})).await;
    let c = &chats["chats"][0];
    assert_eq!(
        (c["kind"].as_str(), c["name"].as_str(), c["members"].as_u64()),
        (Some("group"), Some("Семья"), Some(3))
    );
    assert!(c.get("owner").is_none() && c.get("left").is_none() && c.get("unreadable").is_none());
    let chat = g.chat.to_string();
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(texts(&list), ["до помощника", "привет, помощник"]);
    assert_eq!(list["chat"]["name"], "Семья");
    let info = bot.ok(&srv, "group_info", json!({ "chat": chat })).await;
    assert_eq!(names(&info), ["Мама", "Папа", "Помощник"]);
    assert_eq!(
        (info["ownerName"].as_str(), info["iAmOwner"].as_bool()),
        (Some("Мама"), Some(false))
    );

    // It writes into the group; the people's apps verify it against the signed member list.
    let sent = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": chat, "text": "Всем привет", "reply_to": g2 }),
        )
        .await;
    let papa_side = papa.open_group(&srv, &g.chat).await;
    let seen = papa.read_group(&srv, &papa_side, g2).await;
    assert_eq!((seen[0].gseq, seen[0].sender), (sent["id"].as_u64().unwrap(), bot.user));
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    assert_eq!((msg.body.as_deref(), msg.reply), (Some("Всем привет"), Some(r2)));
    bot.ok(
        &srv,
        "message_react",
        json!({ "chat": chat, "message": g2, "emoji": "👋" }),
    )
    .await;

    // A rename (same epoch) and a new member without history (a new epoch): the chain goes on.
    let change = rename_group(&g.state, &mama.keys, &g.secret, "Семья и помощник", &mut system_rng).unwrap();
    g = mama.change_group(&srv, &g, change).await;
    let change = add_group_members(&g.state, &mama.keys, &g.secret, &[son.member()], false, &mut system_rng).unwrap();
    g = mama.change_group(&srv, &g, change).await;
    assert_eq!(g.state.epoch, 1);
    son.say_group(&srv, &son.open_group(&srv, &g.chat).await, "я тут").await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(texts(&list)[2..], ["Всем привет", "я тут"]);
    assert_eq!(list["chat"]["name"], "Семья и помощник");
    let after_epoch = bot
        .ok(&srv, "message_send", json!({ "chat": chat, "text": "в новой эпохе" }))
        .await;
    let seen = mama.read_group(&srv, &g, after_epoch["id"].as_u64().unwrap() - 1).await;
    assert_eq!(seen[0].sender, bot.user);

    // Only the owner changes a group or deletes other people's messages.
    assert_eq!(
        bot.err(&srv, "group_rename", json!({ "chat": chat, "name": "Моё" }))
            .await,
        "not_owner"
    );
    assert_eq!(
        bot.err(
            &srv,
            "group_members_remove",
            json!({ "chat": chat, "members": [papa.user.to_string()] })
        )
        .await,
        "not_owner"
    );
    bot.set_levels(&srv, &mama, &["read", "write", "destructive"]).await;
    assert_eq!(
        bot.err(
            &srv,
            "message_delete",
            json!({ "chat": chat, "message": g2, "for_everyone": true })
        )
        .await,
        "not_yours"
    );

    // News of a group: messages and what happened to the group itself.
    let cursor = bot.ok(&srv, "events_wait", json!({ "timeout_s": 0 })).await["cursor"]
        .as_u64()
        .unwrap();
    let change = rename_group(&g.state, &mama.keys, &g.secret, "Дом", &mut system_rng).unwrap();
    g = mama.change_group(&srv, &g, change).await;
    mama.say_group(&srv, &g, "новость").await;
    let got = bot
        .ok(&srv, "events_wait", json!({ "cursor": cursor, "timeout_s": 0 }))
        .await;
    let kinds: Vec<(&str, &str)> = got["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["type"].as_str().unwrap(), e["chatName"].as_str().unwrap()))
        .collect();
    assert_eq!(kinds, [("notice", "Дом"), ("message", "Дом")]);
    assert_eq!(got["events"][0]["notice"]["type"], "group_state");

    // After a restart the view is rebuilt from the keys and states on disk.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open_plain(&data, Overrides::default()).await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(
        texts(&list),
        [
            "до помощника",
            "привет, помощник",
            "Всем привет",
            "я тут",
            "в новой эпохе",
            "новость"
        ]
    );
    assert_eq!(list["messages"][1]["reactions"][0]["emoji"], "👋");

    // Removed: a new epoch it has no key of. What it had stays readable; nothing new arrives.
    let change = remove_group_members(&g.state, &mama.keys, &[bot.user], &mut system_rng).unwrap();
    g = mama.change_group(&srv, &g, change).await;
    mama.say_group(&srv, &g, "без помощника").await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(texts(&list).last().unwrap(), "новость");
    assert_eq!(bot.ok(&srv, "chats_list", json!({})).await["chats"][0]["left"], true);
    assert_eq!(
        bot.err(&srv, "message_send", json!({ "chat": chat, "text": "я ещё тут?" }))
            .await,
        "not_member"
    );

    // Added again: it reads on from the state its new key names.
    let change = add_group_members(&g.state, &mama.keys, &g.secret, &[bot_member], true, &mut system_rng).unwrap();
    g = mama.change_group(&srv, &g, change).await;
    mama.say_group(&srv, &g, "с возвращением").await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat, "limit": 2 })).await;
    assert_eq!(texts(&list), ["без помощника", "с возвращением"]);
    bot.ok(&srv, "message_send", json!({ "chat": chat, "text": "спасибо" }))
        .await;

    // Leaving is its own decision.
    assert_eq!(bot.ok(&srv, "group_leave", json!({ "chat": chat })).await["left"], true);
    assert_eq!(bot.ok(&srv, "group_leave", json!({ "chat": chat })).await["left"], true);
    assert_eq!(
        bot.err(&srv, "message_send", json!({ "chat": chat, "text": "?" }))
            .await,
        "not_member"
    );
}

async fn papa_say(srv: &TestServer, papa: &Person, chat: &ChatId, text: &str) -> (u64, fcd::client::payload::MsgRef) {
    let side = papa.open_group(srv, chat).await;
    papa.say_group(srv, &side, text).await
}

#[tokio::test]
async fn the_owner_of_its_own_group() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let son = mama.invite(&srv, "Сын").await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;

    assert_eq!(
        bot.err(&srv, "group_create", json!({ "name": " ", "members": [] }))
            .await,
        "invalid-argument"
    );
    assert_eq!(
        bot.err(&srv, "group_create", json!({ "name": "x", "members": ["nobody"] }))
            .await,
        "invalid_argument"
    );
    let made = bot
        .ok(
            &srv,
            "group_create",
            json!({ "name": "Покупки", "members": [mama.user.to_string(), papa.user.to_string(), bot.user.to_string()] }),
        )
        .await;
    assert_eq!(
        (made["name"].as_str(), made["members"].as_u64()),
        (Some("Покупки"), Some(3))
    );
    let chat = made["chat"].as_str().unwrap().to_string();
    let chat_id = ChatId::parse(&chat).unwrap();
    let hello = bot
        .ok(
            &srv,
            "message_send",
            json!({ "chat": chat, "text": "Список покупок тут" }),
        )
        .await;

    // The people's apps accept the state (its chain starts at the helper) and the keys sealed to them.
    let m = mama.open_group(&srv, &chat_id).await;
    assert_eq!(
        (m.state.name.as_str(), m.state.owner, m.state.version),
        ("Покупки", bot.user, 1)
    );
    let seen = mama.read_group(&srv, &m, 0).await;
    assert_eq!(seen[0].gseq, hello["id"].as_u64().unwrap());
    let (g_papa, _) = papa
        .say_group(&srv, &papa.open_group(&srv, &chat_id).await, "молоко")
        .await;
    let info = bot.ok(&srv, "group_info", json!({ "chat": chat })).await;
    assert_eq!(info["iAmOwner"], true);
    assert_eq!(names(&info), ["Мама", "Папа", "Помощник"]);
    assert_eq!(bot.ok(&srv, "chats_list", json!({})).await["chats"][0]["owner"], true);

    // Rename; add with history and without.
    bot.ok(
        &srv,
        "group_rename",
        json!({ "chat": chat, "name": "Покупки на неделю" }),
    )
    .await;
    assert_eq!(mama.open_group(&srv, &chat_id).await.state.name, "Покупки на неделю");
    let added = bot
        .ok(
            &srv,
            "group_members_add",
            json!({ "chat": chat, "members": [son.user.to_string(), papa.user.to_string()] }),
        )
        .await;
    assert_eq!((added["added"].as_u64(), added["members"].as_u64()), (Some(1), Some(4)));
    let s = son.open_group(&srv, &chat_id).await;
    assert_eq!(
        (s.state.version, s.state.epoch),
        (3, 0),
        "the same epoch: history is shared"
    );
    // Adding someone who is already in changes nothing.
    assert_eq!(
        bot.ok(
            &srv,
            "group_members_add",
            json!({ "chat": chat, "members": [son.user.to_string()] })
        )
        .await["added"],
        0
    );

    // The owner deletes somebody else's message for everyone.
    bot.set_levels(&srv, &mama, &["read", "write", "destructive"]).await;
    bot.ok(
        &srv,
        "message_delete",
        json!({ "chat": chat, "message": g_papa, "for_everyone": true }),
    )
    .await;
    let list = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    assert_eq!(list["messages"][1]["deleted"], true);
    let seen = mama
        .read_group(&srv, &mama.open_group(&srv, &chat_id).await, g_papa)
        .await;
    assert!(
        seen.iter()
            .any(|x| matches!(&x.payload, Payload::Delete { target, .. } if target.author == papa.user))
    );

    // Remove: a new epoch, sealed to those who stay.
    let removed = bot
        .ok(
            &srv,
            "group_members_remove",
            json!({ "chat": chat, "members": [son.user.to_string()] }),
        )
        .await;
    assert_eq!(
        (removed["removed"].as_u64(), removed["members"].as_u64()),
        (Some(1), Some(3))
    );
    let m = mama.open_group(&srv, &chat_id).await;
    assert_eq!((m.state.version, m.state.epoch), (4, 1));
    assert!(m.state.member(&son.user).is_none());
    bot.ok(&srv, "message_send", json!({ "chat": chat, "text": "без сына" }))
        .await;
    assert_eq!(
        mama.read_group(&srv, &m, 0).await.len(),
        1,
        "one event in the new epoch"
    );
    assert_eq!(
        bot.err(
            &srv,
            "group_members_remove",
            json!({ "chat": chat, "members": [bot.user.to_string()] })
        )
        .await,
        "invalid_argument"
    );

    // A member leaves on their own: the owner's side removes them from the signed state.
    let res = papa.send(&srv, "POST", &format!("/v1/chats/{chat}/leave"), None).await;
    assert_eq!(res.status, 204);
    let info = bot.ok(&srv, "group_info", json!({ "chat": chat })).await;
    assert_eq!(names(&info), ["Мама", "Помощник"]);
    let m = mama.open_group(&srv, &chat_id).await;
    assert_eq!((m.state.version, m.state.epoch), (5, 2));

    // The owner cannot just leave; it hands the group over, then goes.
    assert_eq!(
        bot.err(&srv, "group_leave", json!({ "chat": chat })).await,
        "owner_cannot_leave"
    );
    assert_eq!(
        bot.err(
            &srv,
            "group_transfer",
            json!({ "chat": chat, "to": papa.user.to_string() })
        )
        .await,
        "invalid-argument"
    );
    let handed = bot
        .ok(
            &srv,
            "group_transfer",
            json!({ "chat": chat, "to": mama.user.to_string() }),
        )
        .await;
    assert_eq!(handed["ownerName"], "Мама");
    let m = mama.open_group(&srv, &chat_id).await;
    assert_eq!(m.state.owner, mama.user);
    assert_eq!(
        bot.err(&srv, "group_rename", json!({ "chat": chat, "name": "Назад" }))
            .await,
        "not_owner"
    );
    // The new owner (a person's app) hands it back, and the helper leaves with transfer_to.
    let change = transfer_group_ownership(&m.state, &mama.keys, &m.secret, &bot.user, &mut system_rng).unwrap();
    mama.change_group(&srv, &m, change).await;
    assert_eq!(
        bot.ok(&srv, "group_info", json!({ "chat": chat })).await["iAmOwner"],
        true
    );
    let left = bot
        .ok(
            &srv,
            "group_leave",
            json!({ "chat": chat, "transfer_to": mama.user.to_string() }),
        )
        .await;
    assert_eq!(left["left"], true);
    let m = mama.open_group(&srv, &chat_id).await;
    assert_eq!(m.state.owner, mama.user);
    let chats = mama.send(&srv, "GET", "/v1/chats", None).await.json();
    let c = chats["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["chatId"] == chat.as_str())
        .unwrap();
    assert_eq!(c["members"], json!([mama.user.to_string()]));
    assert_eq!(c["owner"], mama.user.to_string());
}

#[tokio::test]
async fn a_read_only_connection_changes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let made = bot
        .ok(
            &srv,
            "group_create",
            json!({ "name": "Двое", "members": [papa.user.to_string()] }),
        )
        .await;
    let chat = made["chat"].as_str().unwrap().to_string();
    bot.set_levels(&srv, &mama, &["read"]).await;
    let res = papa.send(&srv, "POST", &format!("/v1/chats/{chat}/leave"), None).await;
    assert_eq!(res.status, 204);
    // Reading does not rewrite the group: the state still lists the member who left, marked so.
    let info = bot.ok(&srv, "group_info", json!({ "chat": chat })).await;
    assert_eq!(names(&info), ["Папа", "Помощник"]);
    assert_eq!(info["members"][0]["left"], true);
    assert_eq!(
        bot.err(&srv, "group_rename", json!({ "chat": chat, "name": "x" }))
            .await,
        "level_off"
    );
    // With the write level back, the owner's duty is done on the next look.
    bot.set_levels(&srv, &mama, &["read", "write"]).await;
    assert_eq!(
        names(&bot.ok(&srv, "group_info", json!({ "chat": chat })).await),
        ["Помощник"]
    );
}
