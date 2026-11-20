//! Tools that write: sending, editing, reacting, deleting, forwarding.
//! The server builds the event the way a client does (signed and encrypted
//! with the connection's keys) and stores it through the same door as
//! `POST /v1/chats/<id>/events`.

use serde_json::json;

use super::{Args, ChatRef, Ctx, ToolError, ToolResult, iso};
use crate::api::push_new_event;
use crate::client::dm::ChatKeys;
use crate::client::event::{EventContext, encode_event};
use crate::client::payload::{
    Attachment, Common, Location, Msg, MsgRef, encode_delete, encode_edit, encode_msg, encode_react,
};
use crate::client::{ProtoError, bytes};
use crate::datadir::now_ms;
use crate::error::io_error;
use crate::ids::MsgId;
use crate::mcp::conn::Level;
use crate::mcp::files::{read_blob, store_blob};
use crate::mcp::view::{Dir, Message, MsgKind, View};
use crate::store::{Appended, ChatKind};

/// Most bytes of files one forward copies in memory.
const MAX_FORWARD_BYTES: u64 = 64 * 1024 * 1024;

/// The keys to write into a chat with, after checking that writing makes sense.
fn chat_keys(ctx: &Ctx, view: &mut View, dir: &Dir, chat: &ChatRef) -> Result<ChatKeys, ToolError> {
    match (chat.kind, chat.peer) {
        (ChatKind::Dm, Some(peer)) => {
            let u = dir
                .users
                .get(&peer)
                .ok_or_else(|| ToolError::new("chat_not_found", "no such member"))?;
            if !u.active() {
                return Err(ToolError::new(
                    "peer_gone",
                    format!("{} left the family or revoked their identity", u.name),
                ));
            }
            view.dm_keys(&ctx.st, &ctx.conn, dir, &chat.id, &peer)
                .ok_or_else(|| ToolError::new("invalid_key", "this member's identity does not verify"))
        }
        _ => {
            let server = chat
                .chat
                .as_ref()
                .ok_or_else(|| ToolError::new("chat_not_found", "no such chat"))?;
            if !server.is_member(&ctx.me()) {
                return Err(ToolError::new("not_member", "this identity is no longer in the group"));
            }
            let need_key = || ToolError::new("need_key", "this group is not readable by this identity yet");
            let g = view.group(&chat.id).ok_or_else(need_key)?;
            if let Some(code) = g.broken {
                return Err(ToolError::new(
                    "group_broken",
                    format!("a state of this group did not verify ({code}); it is not used"),
                ));
            }
            // Only into the group's current epoch, as its current signed state defines it.
            let state = g
                .state()
                .filter(|s| u64::from(s.version) == server.version && s.member(&ctx.me()).is_some())
                .ok_or_else(need_key)?;
            g.keys(state.epoch).ok_or_else(need_key)
        }
    }
}

/// Builds, stores and announces one event of this connection.
pub(super) async fn post(
    ctx: &Ctx,
    view: &mut View,
    dir: &Dir,
    chat: &ChatRef,
    silent: bool,
    build: impl FnOnce(&Common) -> Result<Vec<u8>, ProtoError>,
) -> Result<Appended, ToolError> {
    let keys = chat_keys(ctx, view, dir, chat)?;
    let f = &ctx.conn.file;
    let seq = ctx
        .st
        .mcp
        .peek_seq(&f.id, &chat.id)
        .ok_or_else(|| ToolError::new("unauthorized", "this connection was deleted"))?;
    let common = Common {
        id: MsgId(bytes::random::<16>()),
        dev: f.dev_id,
        seq,
    };
    let payload = build(&common)?;
    let body = encode_event(
        &EventContext {
            server_id: &ctx.st.server_id,
            chat_id: &chat.id.to_string(),
            chat: &keys,
        },
        &ctx.conn.keys,
        &payload,
    )?;
    let (chat_id, user, dev, epoch, msg) = (chat.id, f.user_id, f.dev_id, keys.epoch, common.id);
    let appended = ctx
        .st
        .store
        .write(move |w| w.append(chat_id, user, dev, epoch, msg, &body, now_ms()))
        .await?;
    ctx.st
        .mcp
        .commit_seq(&f.id, &chat_id, seq)
        .map_err(|e| io_error("write the MCP connection", e))?;
    if !silent {
        push_new_event(&ctx.st, &appended, user, dev);
    }
    Ok(appended)
}

pub(super) fn sent(a: &Appended) -> serde_json::Value {
    json!({ "id": a.gseq, "time": iso(a.time), "chat": a.chat.id })
}

/// A message of a chat by its number, unless this connection hid it.
fn message<'a>(ctx: &Ctx, view: &'a View, chat: &ChatRef, gseq: u64) -> Result<&'a Message, ToolError> {
    view.message(&chat.id, gseq)
        .filter(|m| !ctx.hidden(&m.author, &m.id))
        .ok_or_else(|| ToolError::new("message_not_found", format!("no message {gseq} in this chat")))
}

pub(super) fn live<'a>(ctx: &Ctx, view: &'a View, chat: &ChatRef, gseq: u64) -> Result<&'a Message, ToolError> {
    let m = message(ctx, view, chat, gseq)?;
    match m.kind {
        MsgKind::Msg => Ok(m),
        MsgKind::Deleted => Err(ToolError::new("message_deleted", "this message was deleted")),
        MsgKind::UpdateRequired => Err(ToolError::new(
            "not_supported",
            "this message is of a kind this server does not know",
        )),
    }
}

pub async fn message_send(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let text = a.opt_str("text").filter(|t| !t.trim().is_empty());
    let location = a.object("location").map(|l| Location {
        lat: l.f64("lat").unwrap_or(0.0),
        lon: l.f64("lon").unwrap_or(0.0),
        accuracy: l.f64("accuracy_m").unwrap_or(0.0),
    });
    if text.is_none() && location.is_none() {
        return Err(ToolError::invalid("a message needs text or a location"));
    }
    let reply = match a.opt_u64("reply_to")? {
        None => None,
        Some(g) => Some(live(ctx, &view, &chat, g)?.msg_ref()),
    };
    let appended = post(ctx, &mut view, &dir, &chat, false, |common| {
        encode_msg(&Msg {
            common: *common,
            body: text.map(str::to_string),
            reply,
            fwd: false,
            attachments: Vec::new(),
            location,
            sticker: None,
        })
    })
    .await?;
    Ok(sent(&appended))
}

pub async fn message_edit(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let m = live(ctx, &view, &chat, a.u64("message")?)?;
    if m.author != ctx.me() {
        return Err(ToolError::new("not_yours", "only the author edits a message"));
    }
    let text = a.str("text");
    if text.trim().is_empty() && m.attachments.is_empty() && m.location.is_none() {
        return Err(ToolError::invalid("text must not be empty; delete the message instead"));
    }
    let (target, gseq) = (m.msg_ref(), m.gseq);
    let appended = post(ctx, &mut view, &dir, &chat, true, |common| {
        encode_edit(common, &target, text)
    })
    .await?;
    Ok(json!({ "id": gseq, "edited": iso(appended.time), "chat": chat.id }))
}

pub async fn message_react(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let m = live(ctx, &view, &chat, a.u64("message")?)?;
    let (target, gseq) = (m.msg_ref(), m.gseq);
    let (emoji, on) = (a.str("emoji"), a.bool_or("on", true));
    post(ctx, &mut view, &dir, &chat, true, |common| {
        encode_react(common, &target, emoji, on)
    })
    .await?;
    Ok(json!({ "id": gseq, "emoji": emoji, "on": on, "chat": chat.id }))
}

pub async fn message_delete(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let m = message(ctx, &view, &chat, a.u64("message")?)?;
    let (target, gseq) = (m.msg_ref(), m.gseq);
    if !a.bool_or("for_everyone", false) {
        // "Delete for me": this connection stops seeing it; nothing leaves the server.
        let key = format!("{}/{}", target.author, target.id);
        ctx.st
            .mcp
            .update(&ctx.conn.file.id, |f| {
                f.hidden.insert(key);
            })
            .map_err(|e| io_error("write the MCP connection", e))?;
        return Ok(json!({ "id": gseq, "hidden": true, "chat": chat.id }));
    }
    if !ctx.conn.allows(Level::Destructive) {
        return Err(ToolError::new(
            "level_off",
            "deleting for everyone cannot be undone and needs the access level \"destructive\"; a person switches it \
             on in the app (Settings, AI assistants)",
        ));
    }
    if m.kind == MsgKind::Deleted {
        return Ok(json!({ "id": gseq, "deleted": true, "chat": chat.id }));
    }
    let owner = view
        .group(&chat.id)
        .and_then(|g| g.state())
        .is_some_and(|s| s.owner == ctx.me());
    if m.author != ctx.me() && !owner {
        return Err(ToolError::new(
            "not_yours",
            "only the author, or the owner of the group, deletes a message for everyone",
        ));
    }
    let blobs: Vec<_> = m.attachments.iter().map(|a| a.blob.id).collect();
    let (Some(seq), dev) = (m.seq, m.dev) else {
        return Err(ToolError::new(
            "not_supported",
            "this message cannot be deleted for everyone",
        ));
    };
    post(ctx, &mut view, &dir, &chat, true, |common| {
        encode_delete(common, &target, &dev, seq)
    })
    .await?;
    // The signed delete tells every device; the server also zeroes its own copy.
    let (chat_id, me) = (chat.id, ctx.me());
    ctx.st
        .store
        .write(move |w| w.delete_event(chat_id, gseq, me, now_ms()))
        .await?;
    // Files this identity uploaded for the message go from the server too (as the app does).
    let st = ctx.st.clone();
    let _ = tokio::task::spawn_blocking(move || {
        for id in blobs {
            let _ = st.store.blobs().delete(&me, &id);
        }
    })
    .await;
    Ok(json!({ "id": gseq, "deleted": true, "chat": chat.id }))
}

pub async fn message_forward(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (mut view, dir) = ctx.synced().await?;
    let from = ctx.resolve_chat(&dir, a.str("chat"))?;
    let to = ctx.resolve_chat(&dir, a.str("to"))?;
    let m = live(ctx, &view, &from, a.u64("message")?)?;
    // Files are stored again under a new key, as the app does: the first
    // chat's members get no way to follow the file into the second.
    let mut attachments = Vec::with_capacity(m.attachments.len());
    if !m.attachments.is_empty() {
        if !ctx.conn.allows(Level::Files) {
            return Err(ToolError::new(
                "level_off",
                "forwarding a message with files needs the access level \"files\"; a person switches it on in the \
                 app (Settings, AI assistants)",
            ));
        }
        if m.attachments.iter().map(|a| a.blob.size).sum::<u64>() > MAX_FORWARD_BYTES {
            return Err(ToolError::new(
                "too_large",
                "these files are too large to forward here; take them with file_get and send them again",
            ));
        }
        for a in &m.attachments {
            let bytes = read_blob(&ctx.st, a.blob.clone()).await?;
            let blob = store_blob(&ctx.st, ctx.me(), bytes).await?;
            attachments.push(Attachment { blob, ..a.clone() });
        }
    }
    let copy = Msg {
        common: Common {
            id: MsgId([0; 16]),
            dev: ctx.conn.file.dev_id,
            seq: 0,
        },
        body: (!m.body.is_empty()).then(|| m.body.clone()),
        reply: None::<MsgRef>,
        fwd: true,
        attachments,
        location: m.location,
        sticker: m.sticker.clone(),
    };
    let appended = post(ctx, &mut view, &dir, &to, false, |common| {
        encode_msg(&Msg {
            common: *common,
            ..copy
        })
    })
    .await?;
    Ok(sent(&appended))
}
