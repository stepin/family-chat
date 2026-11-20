//! Tools that only read: who I am, members, chats, messages, search, waiting.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::{Args, ChatRef, Ctx, ToolError, ToolResult, iso};
use crate::client::payload::MsgRef;
use crate::datadir::now_ms;
use crate::ids::{ChatId, UserId};
use crate::mcp::conn::{Level, Mode};
use crate::mcp::view::{Change, ChangeKind, Dir, Message, MsgKind, View};
use crate::store::{Chat, ChatKind};

const DEFAULT_LIST: usize = 30;
const DEFAULT_SEARCH: usize = 20;
const MAX_LIST: usize = 100;
const DEFAULT_WAIT_S: u64 = 25;
const MAX_WAIT_S: u64 = 50;
/// Events one `events_wait` answer carries.
const MAX_EVENTS: usize = 100;
/// Characters of a quoted or previewed text.
const PREVIEW_CHARS: usize = 120;

fn preview(s: &str) -> String {
    let mut out: String = s.chars().take(PREVIEW_CHARS).collect();
    if s.chars().nth(PREVIEW_CHARS).is_some() {
        out.push('…');
    }
    out
}

pub(crate) fn chat_kind(dir: &Dir, kind: ChatKind, peer: Option<&UserId>) -> &'static str {
    match (kind, peer) {
        (ChatKind::Group, _) => "group",
        (ChatKind::Dm, Some(p)) if *p == dir.me => "self",
        (ChatKind::Dm, _) => "direct",
    }
}

/// A chat's name for a model: the other member, the notes chat, or the group's signed name.
pub(crate) fn chat_name(dir: &Dir, view: &View, id: &ChatId, kind: ChatKind, peer: Option<&UserId>) -> Value {
    match (kind, peer) {
        (ChatKind::Dm, Some(p)) if *p == dir.me => json!("Saved Messages"),
        (ChatKind::Dm, Some(p)) => json!(dir.name(p)),
        _ => json!(view.group(id).and_then(|g| g.state()).map(|s| s.name.clone())),
    }
}

fn chat_json(dir: &Dir, view: &View, c: &Chat, ctx: &Ctx) -> Value {
    let peer = (c.kind == ChatKind::Dm).then(|| dir.peer(c));
    let mut v = json!({
        "chat": c.id,
        "kind": chat_kind(dir, c.kind, peer.as_ref()),
        "name": chat_name(dir, view, &c.id, c.kind, peer.as_ref()),
    });
    match c.kind {
        ChatKind::Dm => v["with"] = json!(peer),
        ChatKind::Group => {
            let state = view.group(&c.id).and_then(|g| g.state());
            v["members"] = json!(c.members.len());
            if c.owner == Some(dir.me) {
                v["owner"] = json!(true);
            }
            if !c.is_member(&dir.me) {
                v["left"] = json!(true);
            }
            if state.is_none() {
                v["unreadable"] = json!(true);
            }
        }
    }
    let last = view
        .chat(&c.id)
        .and_then(|m| m.values().rev().find(|m| !ctx.hidden(&m.author, &m.id)));
    if let Some(m) = last {
        v["lastTime"] = json!(iso(m.time));
        v["last"] = message_json(dir, view, m);
    }
    v
}

fn ref_json(dir: &Dir, view: &View, r: &MsgRef) -> Value {
    match view.by_ref(r) {
        Some(m) => json!({
            "id": m.gseq,
            "from": dir.name(&m.author),
            "text": preview(&m.body),
        }),
        // The message is older than what the server keeps.
        None => json!({ "id": null, "from": dir.name(&r.author) }),
    }
}

/// A message as a model reads it.
pub(crate) fn message_json(dir: &Dir, view: &View, m: &Message) -> Value {
    let mut v = Map::new();
    v.insert("id".into(), json!(m.gseq));
    v.insert("time".into(), json!(iso(m.time)));
    v.insert("from".into(), json!(m.author));
    v.insert("fromName".into(), json!(dir.name(&m.author)));
    if m.author == dir.me {
        v.insert("mine".into(), json!(true));
    }
    match m.kind {
        MsgKind::Deleted => {
            v.insert("deleted".into(), json!(true));
            return Value::Object(v);
        }
        MsgKind::UpdateRequired => {
            v.insert("unsupported".into(), json!(true));
            return Value::Object(v);
        }
        MsgKind::Msg => {}
    }
    if !m.body.is_empty() {
        v.insert("text".into(), json!(m.body));
    }
    if let Some(r) = &m.reply {
        v.insert("replyTo".into(), ref_json(dir, view, r));
    }
    if m.fwd {
        v.insert("forwarded".into(), json!(true));
    }
    if let Some(t) = m.edited {
        v.insert("edited".into(), json!(iso(t)));
    }
    if !m.attachments.is_empty() {
        let list: Vec<Value> = m
            .attachments
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let mut o = json!({
                    "index": i,
                    "kind": a.kind.as_str(),
                    "name": a.name,
                    "type": a.mime,
                    "size": a.blob.size,
                });
                if let (Some(w), Some(h)) = (a.w, a.h) {
                    o["width"] = json!(w);
                    o["height"] = json!(h);
                }
                if let Some(d) = a.dur {
                    o["durationMs"] = json!(d);
                }
                o
            })
            .collect();
        v.insert("attachments".into(), json!(list));
    }
    if let Some(l) = &m.location {
        v.insert(
            "location".into(),
            json!({ "lat": l.lat, "lon": l.lon, "accuracyM": l.accuracy }),
        );
    }
    if let Some(s) = &m.sticker {
        v.insert(
            "sticker".into(),
            json!({ "pack": s.pack, "file": s.file, "type": s.kind }),
        );
    }
    if !m.reactions.is_empty() {
        let list: Vec<Value> = m
            .reactions
            .iter()
            .map(|(emoji, users)| {
                let mut by: Vec<String> = users.iter().map(|u| dir.name(u)).collect();
                by.sort();
                json!({ "emoji": emoji, "by": by, "mine": users.contains(&dir.me) })
            })
            .collect();
        v.insert("reactions".into(), json!(list));
    }
    Value::Object(v)
}

pub async fn whoami(ctx: &Ctx) -> ToolResult {
    let (_view, dir) = ctx.synced().await?;
    let f = &ctx.conn.file;
    let me = dir.users.get(&f.user_id);
    let all = [
        Level::Read,
        Level::Write,
        Level::Files,
        Level::Admin,
        Level::Destructive,
    ];
    let off: Vec<&str> = all
        .iter()
        .filter(|l| !ctx.conn.allows(**l))
        .map(|l| l.as_str())
        .collect();
    let s = &ctx.st.settings;
    Ok(json!({
        "userId": f.user_id,
        "name": me.map(|u| u.name.clone()),
        "administrator": me.is_some_and(|u| u.admin),
        "actingAs": match f.mode {
            Mode::Helper => "a helper: a member of the family with an identity of its own",
            Mode::Me => "a member's own identity: what you write is written as that person",
        },
        "connection": f.name,
        "levels": f.levels,
        "levelsOff": off,
        "levelsNote": "A person switches access levels on in the app (Settings, AI assistants).",
        "family": ctx.st.family_name(),
        "retentionDays": s.retention_days,
        "maxFileMb": s.max_file_mb,
        "serverTime": iso(now_ms()),
    }))
}

pub async fn members_list(ctx: &Ctx) -> ToolResult {
    let (_view, dir) = ctx.synced().await?;
    // An administrator with the admin level also sees each member's devices.
    let admin = ctx.conn.allows(Level::Admin) && dir.users.get(&dir.me).is_some_and(|u| u.admin);
    let devices: std::collections::HashMap<UserId, usize> = if admin {
        ctx.st
            .store
            .read(|m| m.users.values().map(|u| (u.id, u.devices.len())).collect())
    } else {
        Default::default()
    };
    let mut users: Vec<_> = dir.users.values().collect();
    users.sort_by_key(|u| (u.name.to_lowercase(), u.id.to_string()));
    let list: Vec<Value> = users
        .into_iter()
        .map(|u| {
            let mut v = json!({ "userId": u.id, "name": u.name });
            if u.id == dir.me {
                v["me"] = json!(true);
            }
            if u.admin {
                v["administrator"] = json!(true);
            }
            if u.removed {
                v["left"] = json!(true);
            }
            if u.revoked_at.is_some() {
                v["revoked"] = json!(true);
            }
            if let Some(n) = devices.get(&u.id) {
                v["devices"] = json!(n);
            }
            v
        })
        .collect();
    Ok(json!({ "members": list }))
}

pub async fn chats_list(ctx: &Ctx) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let mut chats: Vec<(u64, Value)> = dir
        .chats
        .values()
        .map(|c| {
            let last = view.last(&c.id).map_or(0, |m| m.gseq);
            (last, chat_json(&dir, &view, c, ctx))
        })
        .collect();
    chats.sort_by_key(|c| std::cmp::Reverse(c.0));
    Ok(json!({ "chats": chats.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }))
}

fn chat_ref_json(dir: &Dir, view: &View, c: &ChatRef) -> Value {
    let mut v = json!({
        "chat": c.id,
        "kind": chat_kind(dir, c.kind, c.peer.as_ref()),
        "name": chat_name(dir, view, &c.id, c.kind, c.peer.as_ref()),
    });
    if let Some(p) = c.peer {
        v["with"] = json!(p);
    }
    v
}

pub async fn messages_list(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let limit = (a.opt_u64("limit")?.map_or(DEFAULT_LIST, |n| n as usize)).clamp(1, MAX_LIST);
    let before = a.opt_u64("before")?.unwrap_or(u64::MAX);
    let after = a.opt_u64("after")?;
    let empty = Default::default();
    let all = view.chat(&chat.id).unwrap_or(&empty);
    let shown = |m: &&Message| !ctx.hidden(&m.author, &m.id);
    let (page, more): (Vec<&Message>, bool) = match after {
        // Forward from a message: the oldest ones after it.
        Some(after) => {
            let mut it = all
                .range(after.saturating_add(1)..)
                .map(|(_, m)| m)
                .filter(|m| m.gseq < before)
                .filter(shown);
            let page: Vec<&Message> = it.by_ref().take(limit).collect();
            (page, it.next().is_some())
        }
        // Otherwise the newest ones before `before`.
        None => {
            let mut it = all.range(..before).rev().map(|(_, m)| m).filter(shown);
            let mut page: Vec<&Message> = it.by_ref().take(limit).collect();
            page.reverse();
            (page, it.next().is_some())
        }
    };
    Ok(json!({
        "chat": chat_ref_json(&dir, &view, &chat),
        "messages": page.iter().map(|m| message_json(&dir, &view, m)).collect::<Vec<_>>(),
        "more": more,
    }))
}

/// Lower case, `ё` as `е`: what search compares.
fn fold(s: &str) -> String {
    s.to_lowercase().replace('ё', "е")
}

pub async fn messages_search(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let words: Vec<String> = fold(a.str("query")).split_whitespace().map(str::to_string).collect();
    if words.is_empty() {
        return Err(ToolError::invalid("query must have at least one word"));
    }
    let chat = a.opt_str("chat").map(|c| ctx.resolve_chat(&dir, c)).transpose()?;
    let from = match a.opt_str("from") {
        None => None,
        Some(s) => Some(UserId::parse(s.trim()).ok_or_else(|| ToolError::invalid("from must be a userId"))?),
    };
    let limit = (a.opt_u64("limit")?.map_or(DEFAULT_SEARCH, |n| n as usize)).clamp(1, MAX_LIST);
    let mut hits: Vec<&Message> = view
        .all()
        .filter(|m| m.kind == MsgKind::Msg)
        .filter(|m| chat.as_ref().is_none_or(|c| c.id == m.chat))
        .filter(|m| from.is_none_or(|f| f == m.author))
        .filter(|m| !ctx.hidden(&m.author, &m.id))
        .filter(|m| {
            let mut text = fold(&m.body);
            for att in &m.attachments {
                text.push(' ');
                text.push_str(&fold(&att.name));
            }
            words.iter().all(|w| text.contains(w.as_str()))
        })
        .collect();
    hits.sort_by_key(|m| std::cmp::Reverse(m.gseq));
    let more = hits.len() > limit;
    hits.truncate(limit);
    let list: Vec<Value> = hits
        .into_iter()
        .map(|m| {
            let mut v = message_json(&dir, &view, m);
            v["chat"] = json!(m.chat);
            if let Some(c) = dir.chats.get(&m.chat) {
                let peer = (c.kind == ChatKind::Dm).then(|| dir.peer(c));
                v["chatName"] = chat_name(&dir, &view, &m.chat, c.kind, peer.as_ref());
            }
            v
        })
        .collect();
    Ok(json!({ "messages": list, "more": more }))
}

fn event_json(ctx: &Ctx, dir: &Dir, view: &View, c: &Change) -> Option<Value> {
    let target = |r: &MsgRef| view.by_ref(r).filter(|m| !ctx.hidden(&m.author, &m.id));
    let mut v = match &c.kind {
        ChangeKind::Message => {
            let m = view
                .message(&c.chat, c.gseq)
                .filter(|m| !ctx.hidden(&m.author, &m.id))?;
            json!({ "type": "message", "message": message_json(dir, view, m) })
        }
        ChangeKind::Edit { target: r } => {
            json!({ "type": "edited", "message": message_json(dir, view, target(r)?) })
        }
        ChangeKind::Reaction { target: r, emoji, on } => {
            let m = target(r)?;
            json!({
                "type": "reaction",
                "by": c.by,
                "byName": dir.name(&c.by),
                "emoji": emoji,
                "on": on,
                "messageId": m.gseq,
                "messageText": preview(&m.body),
            })
        }
        ChangeKind::Delete { target: r } => {
            let m = target(r)?;
            json!({ "type": "deleted", "by": c.by, "byName": dir.name(&c.by), "messageId": m.gseq })
        }
        ChangeKind::Notice(n) => json!({ "type": "notice", "notice": n }),
    };
    v["chat"] = json!(c.chat);
    v["time"] = json!(iso(c.time));
    if let Some(chat) = dir.chats.get(&c.chat) {
        let peer = (chat.kind == ChatKind::Dm).then(|| dir.peer(chat));
        v["chatName"] = chat_name(dir, view, &c.chat, chat.kind, peer.as_ref());
    }
    Some(v)
}

pub async fn events_wait(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let wait = Duration::from_secs(a.opt_u64("timeout_s")?.unwrap_or(DEFAULT_WAIT_S).min(MAX_WAIT_S));
    let deadline = tokio::time::Instant::now() + wait;
    let mut cursor = a.opt_u64("cursor")?;
    let only: Option<ChatId> = {
        match a.opt_str("chat") {
            None => None,
            Some(s) => {
                let (_view, dir) = ctx.synced().await?;
                Some(ctx.resolve_chat(&dir, s)?.id)
            }
        }
    };
    let mut changes = ctx.st.store.subscribe();
    let mut shutdown = ctx.st.shutdown.clone();
    let me = ctx.me();
    let own_dev = ctx.conn.file.dev_id;
    loop {
        changes.borrow_and_update();
        let (view, dir) = ctx.synced().await?;
        // Without a cursor: what happens from now on.
        let from = cursor.unwrap_or(view.cursor);
        let Some(list) = view.changes_after(from) else {
            return Ok(json!({
                "cursor": view.cursor,
                "events": [],
                "missed": true,
                "note": "The cursor is too old: some events were not kept. Read the chats with messages_list, then wait again with this cursor.",
            }));
        };
        let mut events = Vec::new();
        let mut next = view.cursor;
        for c in &list {
            if events.len() >= MAX_EVENTS {
                // The rest comes with the next call.
                next = c.gseq.saturating_sub(1);
                break;
            }
            if (c.by == me && c.dev == own_dev) || only.is_some_and(|o| o != c.chat) {
                continue;
            }
            if let Some(v) = event_json(ctx, &dir, &view, c) {
                events.push(v);
            }
        }
        cursor = Some(next);
        let over = tokio::time::Instant::now() >= deadline || *shutdown.borrow();
        if !events.is_empty() || over {
            return Ok(json!({ "cursor": next, "events": events }));
        }
        drop(view);
        tokio::select! {
            r = changes.changed() => if r.is_err() { return Ok(json!({ "cursor": next, "events": [] })) },
            _ = tokio::time::sleep_until(deadline) => {}
            _ = shutdown.wait_for(|v| *v) => {}
        }
    }
}
