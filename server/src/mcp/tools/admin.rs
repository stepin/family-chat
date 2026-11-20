//! Tools of a family's administrator: invitations, removing a member, the
//! server's numbers. They need the `admin` access level and an identity that
//! is an administrator of the family; removing a member also needs
//! `destructive`.

use serde_json::{Value, json};

use super::{Args, Ctx, ToolError, ToolResult, iso};
use crate::datadir::now_ms;
use crate::ids::UserId;
use crate::mcp::conn::Level;
use crate::store::ChatKind;

fn require_admin(ctx: &Ctx) -> Result<(), ToolError> {
    let me = ctx.me();
    if ctx.st.store.read(|m| m.is_admin(&me)) {
        Ok(())
    } else {
        Err(ToolError::new(
            "not_admin",
            "this identity is not an administrator of the family",
        ))
    }
}

pub async fn invite_create(ctx: &Ctx) -> ToolResult {
    require_admin(ctx)?;
    let me = ctx.me();
    let (inv, code) = ctx.st.store.write(move |w| w.create_invite(&me, now_ms())).await?;
    tracing::info!(
        "{}",
        tr!(
            "MCP: подключение {} выпустило приглашение",
            "MCP: connection {} created an invitation",
            ctx.conn.file.id
        )
    );
    let mut v = json!({
        "id": inv.id,
        "code": code,
        "expires": iso(inv.expires_at),
        "note": "Whoever has the code or the link joins the family, once. Give it only to the person it is for.",
    });
    if let Some(base) = &ctx.base {
        v["link"] = json!(format!("{base}/#invite={code}"));
    }
    Ok(v)
}

pub async fn invites_list(ctx: &Ctx) -> ToolResult {
    require_admin(ctx)?;
    let now = now_ms();
    let list: Vec<Value> = ctx.st.store.read(|m| {
        let name = |u: &UserId| m.users.get(u).and_then(|x| x.profile.as_ref()).map(|p| p.name.clone());
        let mut v: Vec<_> = m.invites.values().collect();
        v.sort_by_key(|i| (i.created_at, i.id.clone()));
        v.into_iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "created": iso(i.created_at),
                    "expires": iso(i.expires_at),
                    "by": name(&i.created_by),
                    "state": match (i.used_at, i.expires_at <= now) {
                        (Some(_), _) => "used",
                        (None, true) => "expired",
                        (None, false) => "open",
                    },
                    "usedBy": i.used_by.as_ref().and_then(name),
                })
            })
            .collect()
    });
    Ok(json!({ "invites": list }))
}

pub async fn invite_delete(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    require_admin(ctx)?;
    let id = a.str("id").trim().to_string();
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(ToolError::invalid("id must be an invitation id from invites_list"));
    }
    let gone = id.clone();
    ctx.st.store.write(move |w| w.delete_invite(&gone)).await?;
    Ok(json!({ "id": id, "deleted": true }))
}

pub async fn member_remove(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    require_admin(ctx)?;
    if !ctx.conn.allows(Level::Destructive) {
        return Err(ToolError::new(
            "level_off",
            "removing a member cannot be undone and needs the access level \"destructive\" too; a person switches it \
             on in the app (Settings, AI assistants)",
        ));
    }
    let user = UserId::parse(a.str("user").trim())
        .ok_or_else(|| ToolError::invalid("user must be a userId from members_list"))?;
    if user == ctx.me() {
        return Err(ToolError::new(
            "cannot_remove_self",
            "an administrator does not remove themselves",
        ));
    }
    let name = ctx.st.store.read(|m| {
        m.users
            .get(&user)
            .map(|u| u.profile.as_ref().map(|p| p.name.clone()).unwrap_or_default())
    });
    let name = name.ok_or_else(|| ToolError::new("bad_member", "no such member"))?;
    ctx.st.store.write(move |w| w.remove_user(&user, now_ms())).await?;
    tracing::info!(
        "{}",
        tr!(
            "MCP: подключение {} исключило участника {user}",
            "MCP: connection {} removed member {user}",
            ctx.conn.file.id
        )
    );
    Ok(json!({ "user": user, "name": name, "removed": true }))
}

pub async fn server_stats(ctx: &Ctx) -> ToolResult {
    require_admin(ctx)?;
    let path = ctx.st.store.path().to_path_buf();
    let space = tokio::task::spawn_blocking(move || crate::store::disk_space(&path))
        .await
        .ok()
        .flatten();
    let s = &ctx.st.settings;
    Ok(ctx.st.store.read(|m| {
        json!({
            "version": crate::VERSION,
            "family": ctx.st.family_name(),
            "members": m.users.values().filter(|u| u.removed_at.is_none()).count(),
            "membersWhoLeft": m.users.values().filter(|u| u.removed_at.is_some()).count(),
            "chats": m.chats.len(),
            "groups": m.chats.values().filter(|c| c.kind == ChatKind::Group).count(),
            "storedEvents": m.log.len(),
            "oldestStored": m.oldest_time().map(iso),
            "retentionDays": s.retention_days,
            "maxFileMb": s.max_file_mb,
            "freeDiskBytes": space.map(|x| x.0),
            "totalDiskBytes": space.map(|x| x.1),
            "pushNotifications": s.push,
            "aiConnections": ctx.st.mcp.len(),
        })
    }))
}
