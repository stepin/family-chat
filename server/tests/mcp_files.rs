//! Over HTTP: files, the profile, stickers and the administrator's tools
//! through MCP.

mod common;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64STD;
use common::person::{Mcp, Person};
use common::*;
use fcd::client::payload::{AttachmentKind, Payload};
use fcd::client::seal;
use fcd::config::Overrides;
use fcd::envelope::{Envelope, Kind, testkit};
use fcd::ids::{FileHash, PackId};
use serde_json::{Value, json};

fn has(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn segment(marker: u8, content: &[u8]) -> Vec<u8> {
    let mut s = vec![0xff, marker];
    s.extend_from_slice(&u16::try_from(content.len() + 2).unwrap().to_be_bytes());
    s.extend_from_slice(content);
    s
}

/// A JPEG (640x480 by its header) that says where it was taken.
fn photo() -> Vec<u8> {
    let mut j = vec![0xff, 0xd8];
    j.extend(segment(0xe0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0"));
    j.extend(segment(
        0xe1,
        b"http://ns.adobe.com/xap/1.0/\0<gps>55.7558N 37.6173E</gps>",
    ));
    j.extend(segment(0xfe, b"shot at home"));
    j.extend(segment(0xdb, &[1; 65]));
    j.extend(segment(
        0xc0,
        &[8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ));
    j.extend(segment(0xda, &[3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));
    j.extend_from_slice(&[0xab; 600]);
    j.extend_from_slice(&[0xff, 0xd9]);
    j
}

/// The attachment of the newest message from `from` in the direct chat with `reader`.
async fn last_attachment(
    srv: &TestServer,
    reader: &Person,
    from: &Mcp,
    after: u64,
) -> fcd::client::payload::Attachment {
    let seen = reader.read(srv, &from.user, after).await;
    let Payload::Msg(m) = &seen.last().expect("a message").payload else {
        panic!("not a message")
    };
    m.attachments[0].clone()
}

#[tokio::test]
async fn files_inside_a_call() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    let chat = papa.user.to_string();

    // The files level is off until a person switches it on; the tools are not even listed.
    let send = json!({ "chat": chat, "name": "list.txt", "data": B64STD.encode("молоко\nхлеб\n") });
    assert_eq!(bot.err(&srv, "file_send", send.clone()).await, "level_off");
    let listed = bot.rpc(&srv, "tools/list", json!({})).await.json();
    assert!(!listed.to_string().contains("file_send"));
    bot.set_levels(&srv, &mama, &["read", "write", "files"]).await;

    // A text file: sent as a file, and the person's app decrypts exactly what was given.
    let sent = bot.ok(&srv, "file_send", send).await;
    assert_eq!(
        sent["file"],
        json!({ "name": "list.txt", "type": "text/plain", "kind": "file", "size": 22 })
    );
    let att = last_attachment(&srv, &papa, &bot, 0).await;
    assert_eq!(
        (att.kind, att.name.as_str(), att.mime.as_str()),
        (AttachmentKind::File, "list.txt", "text/plain")
    );
    assert_eq!(
        papa.download(&srv, &att.blob).await.unwrap(),
        "молоко\nхлеб\n".as_bytes()
    );

    // A photo: shown as a picture with its size, and without the place it was taken at.
    let jpeg = photo();
    assert!(has(&jpeg, b"55.7558N"));
    let sent = bot
        .ok(
            &srv,
            "file_send",
            json!({ "chat": chat, "name": "/Users/papa/Pictures/дача.jpg", "data": B64STD.encode(&jpeg), "text": "Вот", "type": "text/plain" }),
        )
        .await;
    assert_eq!(
        (sent["file"]["kind"].as_str(), sent["file"]["type"].as_str()),
        (Some("image"), Some("image/jpeg"))
    );
    let g_photo = sent["id"].as_u64().unwrap();
    let att = last_attachment(&srv, &papa, &bot, g_photo - 1).await;
    assert_eq!((att.kind, att.w, att.h), (AttachmentKind::Image, Some(640), Some(480)));
    assert_eq!(att.name, "дача.jpg", "only the file's own name, not where it lay");
    let photo_blob = att.blob.clone();
    let got = papa.download(&srv, &att.blob).await.unwrap();
    assert!(!has(&got, b"55.7558N") && !has(&got, b"shot at home"));
    assert!(has(&got, &[0xab; 600]), "the picture data is untouched");
    // With original = true it goes as it is.
    let sent = bot
        .ok(
            &srv,
            "file_send",
            json!({ "chat": chat, "name": "raw.jpg", "data": B64STD.encode(&jpeg), "original": true }),
        )
        .await;
    let att = last_attachment(&srv, &papa, &bot, sent["id"].as_u64().unwrap() - 1).await;
    assert_eq!(papa.download(&srv, &att.blob).await.unwrap(), jpeg);
    // A damaged picture is not passed off as cleaned.
    let cut = B64STD.encode(&jpeg[..30]);
    assert_eq!(
        bot.err(
            &srv,
            "file_send",
            json!({ "chat": chat, "name": "cut.jpg", "data": cut })
        )
        .await,
        "bad_image"
    );

    // What does not fit, and what is not a file at all.
    let big = B64STD.encode(vec![7u8; 1024 * 1024 + 1]);
    assert_eq!(
        bot.err(
            &srv,
            "file_send",
            json!({ "chat": chat, "name": "big.bin", "data": big })
        )
        .await,
        "too_large"
    );
    for bad in [
        json!({ "chat": chat, "name": "x.txt" }),
        json!({ "chat": chat, "name": "x.txt", "data": "!!!" }),
        json!({ "chat": chat, "name": "x.txt", "data": "" }),
        json!({ "chat": chat, "name": "dir/", "data": "aGk=" }),
        json!({ "chat": chat, "name": "x.txt", "data": "aGk=", "upload": "abc" }),
    ] {
        assert_eq!(
            bot.err(&srv, "file_send", bad.clone()).await,
            "invalid_argument",
            "{bad}"
        );
    }

    // Taking files: text as text, a picture as a picture, anything else as base64.
    let listing = bot.ok(&srv, "messages_list", json!({ "chat": chat })).await;
    let m = &listing["messages"][1];
    assert_eq!(
        m["attachments"][0],
        json!({ "index": 0, "kind": "image", "name": "дача.jpg", "type": "image/jpeg", "size": got.len(), "width": 640, "height": 480 })
    );
    let (g_pdf, _) = papa
        .say_file(
            &srv,
            &bot.user,
            "scan.pdf",
            "application/pdf",
            b"%PDF-1.7 \xff\xfe binary",
        )
        .await;
    let (g_txt, _) = papa
        .say_file(&srv, &bot.user, "note.txt", "text/plain", "Привет".as_bytes())
        .await;
    let txt = bot
        .ok(&srv, "file_get", json!({ "chat": chat, "message": g_txt }))
        .await;
    assert_eq!(
        (txt["text"].as_str(), txt["name"].as_str(), txt["size"].as_u64()),
        (Some("Привет"), Some("note.txt"), Some(12))
    );
    let pdf = bot
        .ok(&srv, "file_get", json!({ "chat": chat, "message": g_pdf }))
        .await;
    assert_eq!(
        B64STD.decode(pdf["data"].as_str().unwrap()).unwrap(),
        b"%PDF-1.7 \xff\xfe binary"
    );
    let res = bot
        .rpc(
            &srv,
            "tools/call",
            json!({ "name": "file_get", "arguments": { "chat": chat, "message": g_photo } }),
        )
        .await
        .json();
    let content = res["result"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
    assert!(!content[0]["text"].as_str().unwrap().contains("_content"));
    assert_eq!(
        (content[1]["type"].as_str(), content[1]["mimeType"].as_str()),
        (Some("image"), Some("image/jpeg"))
    );
    assert_eq!(B64STD.decode(content[1]["data"].as_str().unwrap()).unwrap(), got);
    assert_eq!(
        bot.err(&srv, "file_get", json!({ "chat": chat, "message": g_txt, "index": 3 }))
            .await,
        "file_not_found"
    );

    // Search finds a file by its name.
    let found = bot.ok(&srv, "messages_search", json!({ "query": "scan" })).await;
    assert_eq!(found["messages"][0]["id"], g_pdf);

    // Forwarding a file stores it again under a new key.
    let fwd = bot
        .ok(
            &srv,
            "message_forward",
            json!({ "chat": chat, "message": g_pdf, "to": mama.user.to_string() }),
        )
        .await;
    let seen = mama.read(&srv, &bot.user, 0).await;
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    assert_eq!(seen[0].gseq, fwd["id"].as_u64().unwrap());
    let papa_seen = papa.read(&srv, &bot.user, g_pdf - 1).await;
    let Payload::Msg(original) = &papa_seen[0].payload else {
        panic!()
    };
    assert!(msg.fwd && msg.attachments[0].name == "scan.pdf");
    assert_ne!(msg.attachments[0].blob.id, original.attachments[0].blob.id);
    assert_ne!(msg.attachments[0].blob.key, original.attachments[0].blob.key);
    assert_eq!(
        mama.download(&srv, &msg.attachments[0].blob).await.unwrap(),
        b"%PDF-1.7 \xff\xfe binary"
    );

    // Deleting a message with a file for everyone removes the file from the server too.
    bot.set_levels(&srv, &mama, &["read", "write", "files", "destructive"])
        .await;
    bot.ok(
        &srv,
        "message_delete",
        json!({ "chat": chat, "message": g_photo, "for_everyone": true }),
    )
    .await;
    assert!(papa.download(&srv, &photo_blob).await.is_none());
}

#[tokio::test]
async fn files_through_one_time_links() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    bot.set_levels(&srv, &mama, &["read", "write", "files"]).await;
    let chat = papa.user.to_string();

    // A file of two parts goes in through a link.
    let mut big = vec![0u8; 5 * 1024 * 1024 + 123];
    for (i, b) in big.iter_mut().enumerate() {
        *b = (i * 31 % 251) as u8;
    }
    let link = bot.ok(&srv, "file_upload_start", json!({})).await;
    let url = link["url"].as_str().unwrap().to_string();
    assert_eq!(
        url,
        format!("{}/mcp/files/{}", srv.url(""), link["upload"].as_str().unwrap())
    );
    assert_eq!(link["method"], "PUT");
    // Nothing was handed in yet.
    let send = json!({ "chat": chat, "name": "video.bin", "upload": link["upload"] });
    assert_eq!(bot.err(&srv, "file_send", send.clone()).await, "no_upload");
    // No token: the code in the url is the secret.
    let res = request_bytes("PUT", &url, &[], big.clone()).await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    assert_eq!(res.json()["size"], big.len());
    // The link worked once.
    assert_eq!(request_bytes("PUT", &url, &[], b"again".to_vec()).await.status, 404);
    assert_eq!(request("GET", &url, &[], None).await.status, 404);
    // Another connection cannot take somebody else's upload.
    let other = Mcp::helper(&srv, &mama, "Другой").await;
    other.set_levels(&srv, &mama, &["read", "write", "files"]).await;
    assert_eq!(other.err(&srv, "file_send", send.clone()).await, "no_upload");
    let sent = bot.ok(&srv, "file_send", send.clone()).await;
    assert_eq!(sent["file"]["size"], big.len());
    assert_eq!(bot.err(&srv, "file_send", send).await, "no_upload", "taken once");
    let att = last_attachment(&srv, &papa, &bot, 0).await;
    assert_eq!((att.blob.parts, att.blob.size), (2, big.len() as u64));
    assert_eq!(papa.download(&srv, &att.blob).await.unwrap(), big);
    // The plaintext did not stay in the server's temporary folder.
    assert_eq!(std::fs::read_dir(tmp.path().join("tmp")).unwrap().count(), 0);

    // A large file comes out through a link, decrypted, once.
    let g = sent["id"].as_u64().unwrap();
    let out = bot.ok(&srv, "file_get", json!({ "chat": chat, "message": g })).await;
    assert!(out.get("data").is_none() && out.get("text").is_none());
    let url = out["url"].as_str().unwrap().to_string();
    let res = request("GET", &url, &[], None).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, big);
    assert_eq!(res.header("content-type"), Some("application/octet-stream"));
    assert!(
        res.header("content-disposition")
            .unwrap()
            .starts_with("attachment; filename=\"video.bin\"")
    );
    assert_eq!(res.header("content-length"), Some(big.len().to_string().as_str()));
    assert_eq!(request("GET", &url, &[], None).await.status, 404, "once");
    // A small one too, when asked.
    let (g_small, _) = papa
        .say_file(&srv, &bot.user, "отчёт за май.txt", "text/plain", b"hello")
        .await;
    let out = bot
        .ok(
            &srv,
            "file_get",
            json!({ "chat": chat, "message": g_small, "as_link": true }),
        )
        .await;
    let res = request("GET", out["url"].as_str().unwrap(), &[], None).await;
    assert_eq!(res.body, b"hello");
    assert!(
        res.header("content-disposition")
            .unwrap()
            .contains("filename*=UTF-8''%D0%BE%D1%82")
    );

    // At most four unused upload links per connection.
    for _ in 0..4 {
        bot.ok(&srv, "file_upload_start", json!({})).await;
    }
    assert_eq!(bot.err(&srv, "file_upload_start", json!({})).await, "too_many_uploads");
    assert!(other.ok(&srv, "file_upload_start", json!({})).await["url"].is_string());

    // Guessing codes is limited like guessing tokens.
    for _ in 0..7 {
        request("GET", &srv.url("/mcp/files/guess"), &[], None).await;
    }
    assert_eq!(
        request("GET", &srv.url("/mcp/files/guess"), &[], None).await.status,
        429
    );
}

#[tokio::test]
async fn profile_avatar_and_stickers() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    bot.set_levels(&srv, &mama, &["read", "write", "files"]).await;

    // The profile is signed with the connection's key; other members' apps verify it.
    let p = bot
        .ok(&srv, "profile_update", json!({ "name": " Секретарь ", "gender": "f" }))
        .await;
    assert_eq!(p, json!({ "name": "Секретарь", "gender": "f", "avatar": false }));
    let profile_of = |users: &Value| -> Envelope {
        let u = users["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["userId"] == bot.user.to_string().as_str())
            .unwrap();
        serde_json::from_value(u["profile"].clone()).unwrap()
    };
    let identity = papa.identity_of(&srv, &bot.user).await;
    let env = profile_of(&papa.send(&srv, "GET", "/v1/users", None).await.json());
    assert_eq!(seal::verify_profile(&env, &identity).unwrap(), "Секретарь");
    assert_eq!(bot.ok(&srv, "whoami", json!({})).await["name"], "Секретарь");
    assert_eq!(
        bot.err(&srv, "profile_update", json!({ "name": "  " })).await,
        "invalid-argument"
    );
    assert_eq!(
        bot.err(&srv, "profile_update", json!({ "gender": "x" })).await,
        "invalid_argument"
    );

    // The avatar: a JPEG or WebP, cleaned, within the server's limit.
    let none = bot
        .ok(&srv, "member_avatar_get", json!({ "user": bot.user.to_string() }))
        .await;
    assert_eq!(none["avatar"], false);
    let jpeg = photo();
    let set = bot
        .ok(&srv, "profile_avatar_set", json!({ "data": B64STD.encode(&jpeg) }))
        .await;
    assert_eq!(
        (set["avatar"].as_bool(), set["type"].as_str()),
        (Some(true), Some("image/jpeg"))
    );
    let env = profile_of(&papa.send(&srv, "GET", "/v1/users", None).await.json());
    seal::verify_profile(&env, &identity).unwrap();
    let payload: Value = serde_json::from_slice(&b64d(&json!(env.payload))).unwrap();
    assert_eq!(payload["avatar"]["type"], "image/jpeg");
    assert_eq!(payload["rev"], 3);
    let res = papa
        .send(
            &srv,
            "GET",
            &format!(
                "/v1/users/{}/avatar/{}",
                bot.user,
                payload["avatar"]["sha256"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(res.status, 200);
    assert!(!has(&res.body, b"55.7558N") && has(&res.body, &[0xab; 600]));
    let res = bot
        .rpc(
            &srv,
            "tools/call",
            json!({ "name": "member_avatar_get", "arguments": { "user": bot.user.to_string() } }),
        )
        .await
        .json();
    assert_eq!(res["result"]["content"][1]["type"], "image");
    assert_eq!(
        bot.err(
            &srv,
            "profile_avatar_set",
            json!({ "data": B64STD.encode("not a picture") })
        )
        .await,
        "bad_image"
    );
    let png = B64STD.encode(b"\x89PNG\r\n\x1a\n\0\0\0\0IEND\xae\x42\x60\x82");
    assert_eq!(
        bot.err(&srv, "profile_avatar_set", json!({ "data": png })).await,
        "bad_image"
    );
    let huge = B64STD.encode([&photo()[..], &vec![0u8; 300 * 1024][..]].concat());
    assert_eq!(
        bot.err(&srv, "profile_avatar_set", json!({ "data": huge })).await,
        "too_large"
    );
    assert_eq!(
        bot.ok(&srv, "profile_update", json!({ "remove_avatar": true })).await["avatar"],
        false
    );

    // Stickers: a person makes a pack in the app, the helper sends from it.
    assert_eq!(bot.ok(&srv, "stickers_list", json!({})).await, json!({ "packs": [] }));
    let pack = PackId(fcd::webpush::random_bytes::<16>());
    let mut file = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    file.resize(300, 5);
    let hash = FileHash::of(&file);
    let auth = format!("Bearer {}", mama.token);
    let res = request_bytes(
        "PUT",
        &srv.url(&format!("/v1/packs/{pack}/files/{hash}")),
        &[("Authorization", &auth), ("Content-Type", "application/octet-stream")],
        file.clone(),
    )
    .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    let manifest = json!({
        "v": 1, "packId": pack.to_string(), "serverId": srv.server_id(), "author": mama.user.to_string(),
        "name": "Котики", "created": 1,
        "stickers": [{ "file": hash.to_string(), "type": "webp", "size": file.len(), "emoji": "😺", "w": 512, "h": 512 }],
    });
    let env = testkit::seal(&mama.signing_key(), Kind::StickerPack, &manifest.to_string());
    let res = mama
        .send(
            &srv,
            "PUT",
            &format!("/v1/packs/{pack}"),
            Some(&env_json(&env).to_string()),
        )
        .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    let packs = bot.ok(&srv, "stickers_list", json!({})).await;
    assert_eq!(
        packs["packs"],
        json!([{ "pack": pack.to_string(), "name": "Котики", "by": "Мама", "stickers": [{ "file": hash.to_string(), "emoji": "😺", "type": "webp" }] }])
    );
    let sent = bot
        .ok(
            &srv,
            "sticker_send",
            json!({ "chat": papa.user.to_string(), "pack": pack.to_string(), "file": hash.to_string() }),
        )
        .await;
    let seen = papa.read(&srv, &bot.user, sent["id"].as_u64().unwrap() - 1).await;
    let Payload::Msg(msg) = &seen[0].payload else { panic!() };
    let s = msg.sticker.as_ref().unwrap();
    assert_eq!(
        (s.pack, s.file, s.kind.as_str(), s.w, s.h),
        (pack, hash, "webp", 512, 512)
    );
    assert_eq!(msg.body.as_deref(), Some("😺"));
    let list = bot
        .ok(&srv, "messages_list", json!({ "chat": papa.user.to_string() }))
        .await;
    assert_eq!(list["messages"][0]["sticker"]["pack"], pack.to_string());
    let wrong = FileHash::of(b"another").to_string();
    assert_eq!(
        bot.err(
            &srv,
            "sticker_send",
            json!({ "chat": papa.user.to_string(), "pack": pack.to_string(), "file": wrong })
        )
        .await,
        "sticker_not_found"
    );
}

#[tokio::test]
async fn the_administrator_s_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = Person::family(&srv).await;

    // A helper is an ordinary member: the admin level does not make it an administrator.
    let bot = Mcp::helper(&srv, &mama, "Помощник").await;
    bot.set_levels(&srv, &mama, &["read", "write", "admin", "destructive"])
        .await;
    for (tool, args) in [
        ("invite_create", json!({})),
        ("invites_list", json!({})),
        ("server_stats", json!({})),
        ("member_remove", json!({ "user": papa.user.to_string() })),
    ] {
        assert_eq!(bot.err(&srv, tool, args).await, "not_admin", "{tool}");
    }
    assert!(
        bot.ok(&srv, "members_list", json!({})).await["members"][0]
            .get("devices")
            .is_none()
    );

    // The administrator's own identity, with the admin level switched on by her.
    let me = Mcp::me(&srv, &mama, "Claude").await;
    assert_eq!(me.err(&srv, "invite_create", json!({})).await, "level_off");
    me.set_levels(&srv, &mama, &["read", "write", "admin"]).await;
    let inv = me.ok(&srv, "invite_create", json!({})).await;
    let code = inv["code"].as_str().unwrap().to_string();
    assert_eq!(inv["link"], format!("{}/#invite={code}", srv.url("")));
    // The invitation works like one made in the app.
    let son = Person::join(&srv, "Сын", "invite", &code).await;
    let list = me.ok(&srv, "invites_list", json!({})).await;
    let states: Vec<(&str, &str)> = list["invites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["state"].as_str().unwrap(), i["usedBy"].as_str().unwrap_or("")))
        .collect();
    // The helper joined by an invitation of its own, made when it was created.
    assert_eq!(states, [("used", "Папа"), ("used", "Помощник"), ("used", "Сын")]);
    assert!(!list.to_string().contains(&code), "codes are not kept");
    let second = me.ok(&srv, "invite_create", json!({})).await;
    let del = me.ok(&srv, "invite_delete", json!({ "id": second["id"] })).await;
    assert_eq!(del["deleted"], true);
    let res = request(
        "POST",
        &srv.url("/v1/invites/check"),
        &[("Content-Type", "application/json")],
        Some(&json!({ "invite": second["code"] }).to_string()),
    )
    .await;
    assert_ne!(res.json()["status"], "valid", "{}", String::from_utf8_lossy(&res.body));
    assert_eq!(
        me.err(&srv, "invite_delete", json!({ "id": "nope" })).await,
        "invalid_argument"
    );

    let stats = me.ok(&srv, "server_stats", json!({})).await;
    assert_eq!(
        (stats["members"].as_u64(), stats["aiConnections"].as_u64()),
        (Some(4), Some(2))
    );
    let members = me.ok(&srv, "members_list", json!({})).await;
    assert_eq!(members["members"][0]["devices"], 1);

    // Removing a member cannot be undone: it needs the destructive level too.
    let gone = json!({ "user": son.user.to_string() });
    assert_eq!(me.err(&srv, "member_remove", gone.clone()).await, "level_off");
    me.set_levels(&srv, &mama, &["read", "write", "admin", "destructive"])
        .await;
    assert_eq!(
        me.err(&srv, "member_remove", json!({ "user": mama.user.to_string() }))
            .await,
        "cannot_remove_self"
    );
    let removed = me.ok(&srv, "member_remove", gone).await;
    assert_eq!(
        (removed["name"].as_str(), removed["removed"].as_bool()),
        (Some("Сын"), Some(true))
    );
    assert_eq!(son.send(&srv, "GET", "/v1/me", None).await.status, 403);
    let members = me.ok(&srv, "members_list", json!({})).await;
    let son_row = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "Сын")
        .unwrap();
    assert_eq!(son_row["left"], true);
}
