//! Tools about the identity itself and the family's shared things: the
//! profile, the avatar, sticker packs.

use serde_json::{Value, json};

use super::write::{live, post, sent};
use super::{Args, Ctx, ToolError, ToolResult};
use crate::client::payload::{Msg, StickerRef};
use crate::client::seal::{self, AvatarRef, ProfileInput};
use crate::datadir::now_ms;
use crate::envelope;
use crate::ids::{FileHash, PackId, b64_decode, b64_encode};

/// What the identity's profile says now: name, gender, avatar, revision.
struct Current {
    name: String,
    gender: &'static str,
    avatar: Option<(String, &'static str)>,
    rev: u64,
}

fn current(ctx: &Ctx) -> Result<Current, ToolError> {
    let me = ctx.me();
    ctx.st
        .store
        .read(|m| {
            let p = m.users.get(&me)?.profile.as_ref()?;
            Some(Current {
                name: p.name.clone(),
                gender: p.gender.as_str(),
                avatar: match &p.avatar {
                    envelope::AvatarRef::Image { sha256, kind } => Some((b64_encode(sha256), kind.mime())),
                    envelope::AvatarRef::None => None,
                },
                rev: u64::try_from(p.rev).unwrap_or(0),
            })
        })
        .ok_or_else(|| ToolError::new("internal", "this identity has no profile"))
}

/// Signs and stores the next revision of the profile.
async fn put_profile(ctx: &Ctx, c: &Current) -> Result<(), ToolError> {
    let env = seal::profile_envelope(
        &ctx.conn.keys,
        &ProfileInput {
            name: &c.name,
            avatar: c.avatar.as_ref().map(|(sha256, mime)| AvatarRef { sha256, mime }),
            gender: Some(c.gender),
            rev: c.rev + 1,
            updated: now_ms(),
        },
    )?;
    let me = ctx.me();
    ctx.st.store.write(move |w| w.set_profile(&me, &env)).await?;
    Ok(())
}

pub async fn profile_update(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let mut c = current(ctx)?;
    if let Some(name) = a.opt_str("name") {
        c.name = name.to_string();
    }
    match a.opt_str("gender") {
        None => {}
        Some("m") => c.gender = "m",
        Some("f") => c.gender = "f",
        Some(_) => return Err(ToolError::invalid("gender must be \"m\" or \"f\"")),
    }
    if a.bool_or("remove_avatar", false) {
        c.avatar = None;
    }
    put_profile(ctx, &c).await?;
    let c = current(ctx)?;
    Ok(json!({ "name": c.name, "gender": c.gender, "avatar": c.avatar.is_some() }))
}

pub async fn profile_avatar_set(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (bytes, kind) = super::files::avatar_bytes(ctx, a).await?;
    let size = bytes.len();
    let me = ctx.me();
    let stored = ctx.st.store.write(move |w| w.set_avatar(&me, &bytes, kind)).await?;
    let mut c = current(ctx)?;
    c.avatar = Some((b64_encode(&stored.sha256), stored.kind.mime()));
    put_profile(ctx, &c).await?;
    Ok(json!({ "avatar": true, "type": stored.kind.mime(), "size": size }))
}

pub async fn member_avatar_get(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let user = crate::ids::UserId::parse(a.str("user").trim())
        .ok_or_else(|| ToolError::invalid("user must be a userId from members_list"))?;
    let found = ctx.st.store.read(|m| {
        let u = m.users.get(&user)?;
        let name = u.profile.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        let file = match u.profile.as_ref().map(|p| &p.avatar) {
            Some(envelope::AvatarRef::Image { sha256, kind }) => u
                .avatars
                .iter()
                .find(|f| f.sha256 == *sha256 && f.kind == *kind)
                .copied(),
            _ => None,
        };
        Some((name, file))
    });
    let (name, file) = found.ok_or_else(|| ToolError::new("bad_member", "no such member"))?;
    let Some(file) = file else {
        return Ok(json!({ "user": user, "name": name, "avatar": false }));
    };
    let path = ctx
        .st
        .store
        .path()
        .join("users")
        .join(user.to_string())
        .join(file.file_name());
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| crate::error::io_error("reading an avatar", e))?;
    use base64::Engine;
    Ok(json!({
        "user": user,
        "name": name,
        "avatar": true,
        "_content": [{
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "mimeType": file.kind.mime(),
        }],
    }))
}

/// A published pack as its signed manifest describes it.
fn pack_json(
    dir_name: impl Fn(&crate::ids::UserId) -> String,
    id: &PackId,
    pack: &crate::packs::Pack,
) -> Option<Value> {
    let env = pack.manifest.as_ref()?;
    let m: Value = serde_json::from_slice(&b64_decode(&env.payload)?).ok()?;
    let stickers: Vec<Value> = m
        .get("stickers")?
        .as_array()?
        .iter()
        .map(|s| json!({ "file": s["file"], "emoji": s["emoji"], "type": s["type"] }))
        .collect();
    Some(json!({
        "pack": id,
        "name": m.get("name"),
        "by": dir_name(&pack.owner),
        "stickers": stickers,
    }))
}

pub async fn stickers_list(ctx: &Ctx) -> ToolResult {
    let (_view, dir) = ctx.synced().await?;
    let packs: Vec<Value> = ctx
        .st
        .packs
        .published()
        .iter()
        .filter_map(|(id, p)| pack_json(|u| dir.name(u), id, p))
        .collect();
    Ok(json!({ "packs": packs }))
}

pub async fn sticker_send(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let pack_id = PackId::parse(a.str("pack").trim())
        .ok_or_else(|| ToolError::invalid("pack must be a pack id from stickers_list"))?;
    let file = FileHash::parse(a.str("file").trim())
        .ok_or_else(|| ToolError::invalid("file must be a sticker's file from stickers_list"))?;
    let not_found = || {
        ToolError::new(
            "sticker_not_found",
            "no such sticker; stickers_list shows what there is",
        )
    };
    let pack = ctx.st.packs.get(&pack_id).ok_or_else(not_found)?;
    let env = pack.manifest.as_ref().ok_or_else(not_found)?;
    let manifest: Value = b64_decode(&env.payload)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(not_found)?;
    let entry = manifest["stickers"]
        .as_array()
        .and_then(|l| l.iter().find(|s| s["file"] == file.to_string().as_str()))
        .ok_or_else(not_found)?;
    let side = |k: &str| {
        entry[k]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(not_found)
    };
    let sticker = StickerRef {
        pack: pack_id,
        file,
        kind: entry["type"].as_str().ok_or_else(not_found)?.to_string(),
        w: side("w")?,
        h: side("h")?,
    };
    let emoji = entry["emoji"].as_str().ok_or_else(not_found)?.to_string();
    let (mut view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let reply = match a.opt_u64("reply_to")? {
        None => None,
        Some(g) => Some(live(ctx, &view, &chat, g)?.msg_ref()),
    };
    let appended = post(ctx, &mut view, &dir, &chat, false, |common| {
        crate::client::payload::encode_msg(&Msg {
            common: *common,
            // A sticker carries its emoji as the text (shown where the sticker cannot be).
            body: Some(emoji.clone()),
            reply,
            fwd: false,
            attachments: Vec::new(),
            location: None,
            sticker: Some(sticker.clone()),
        })
    })
    .await?;
    Ok(sent(&appended))
}
