//! Group tools. A group's signed state is the source of truth; its owner
//! builds every change (the next state, encrypted, and the epoch secret
//! sealed to the members who need it) and the server stores it through the
//! same door as `POST /v1/chats` and `PUT /v1/chats/<id>/state`.

use serde_json::{Value, json};

use super::{Args, ChatRef, Ctx, ToolError, ToolResult};
use crate::client::group::{
    GroupChange, GroupMember, GroupState, add_group_members, create_group, remove_group_members, rename_group,
    system_rng, transfer_group_ownership,
};
use crate::client::seal;
use crate::datadir::now_ms;
use crate::groups::{MAX_MEMBERS, NewGroup, StateChange};
use crate::ids::UserId;
use crate::mcp::view::{Dir, View};
use crate::store::ChatKind;

fn user_ids(a: &Args<'_>, key: &str) -> Result<Vec<UserId>, ToolError> {
    let list =
        a.0.get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::invalid(format!("{key} must be a list of userIds")))?;
    let mut out = Vec::with_capacity(list.len());
    for v in list {
        let id = v
            .as_str()
            .and_then(|s| UserId::parse(s.trim()))
            .ok_or_else(|| ToolError::invalid(format!("{key} must be a list of userIds from members_list")))?;
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// Members as a state lists them, from the family's verified identities.
fn member_inputs(dir: &Dir, ids: &[UserId]) -> Result<Vec<GroupMember>, ToolError> {
    ids.iter()
        .map(|id| {
            let u = dir
                .users
                .get(id)
                .ok_or_else(|| ToolError::new("bad_member", format!("{id} is not a member of the family")))?;
            if !u.active() {
                return Err(ToolError::new(
                    "bad_member",
                    format!("{} left the family or revoked their identity", u.name),
                ));
            }
            let i = u
                .identity
                .as_ref()
                .ok_or_else(|| ToolError::new("invalid_key", format!("the identity of {} does not verify", u.name)))?;
            Ok(GroupMember {
                user_id: i.user_id,
                sign_pub: i.sign_pub,
                box_pub: i.box_pub,
            })
        })
        .collect()
}

fn sorted(mut ids: Vec<UserId>) -> Vec<UserId> {
    ids.sort_by_key(|u| u.to_string());
    ids
}

fn sealed(change: &GroupChange) -> Vec<(UserId, String)> {
    change
        .sealed_keys
        .iter()
        .map(|(u, env)| (*u, seal::serialize(env)))
        .collect()
}

/// The group named in a call, as this identity can read it now.
struct Known<'a> {
    state: &'a GroupState,
    secret: &'a [u8; 32],
}

fn known<'a>(ctx: &Ctx, view: &'a View, chat: &ChatRef) -> Result<Known<'a>, ToolError> {
    if chat.kind != ChatKind::Group {
        return Err(ToolError::invalid("this chat is not a group"));
    }
    let server = chat
        .chat
        .as_ref()
        .ok_or_else(|| ToolError::new("chat_not_found", "no such group"))?;
    if !server.is_member(&ctx.me()) {
        return Err(ToolError::new("not_member", "this identity is no longer in the group"));
    }
    let g = view
        .group(&chat.id)
        .ok_or_else(|| ToolError::new("need_key", "this group is not readable by this identity yet"))?;
    if let Some(code) = g.broken {
        return Err(ToolError::new(
            "group_broken",
            format!("a state of this group did not verify ({code}); it is not used"),
        ));
    }
    let state = g
        .state()
        .filter(|s| u64::from(s.version) == server.version)
        .ok_or_else(|| {
            ToolError::new(
                "need_key",
                "this group's current state is not readable by this identity yet",
            )
        })?;
    let secret = g
        .secret(state.epoch)
        .ok_or_else(|| ToolError::new("need_key", "this identity has no key of the group's current epoch"))?;
    Ok(Known { state, secret })
}

fn owned<'a>(ctx: &Ctx, view: &'a View, chat: &ChatRef) -> Result<Known<'a>, ToolError> {
    let k = known(ctx, view, chat)?;
    if k.state.owner != ctx.me() {
        return Err(ToolError::new(
            "not_owner",
            "only the owner of a group changes it; group_info says who that is",
        ));
    }
    Ok(k)
}

/// Stores the next state of a group this identity owns.
async fn store_change(ctx: &Ctx, base: &GroupState, change: GroupChange) -> Result<(), ToolError> {
    let ch = StateChange {
        base_version: u64::from(base.version),
        state: change.blob.clone(),
        members: sorted(change.state.members.iter().map(|m| m.user_id).collect()),
        owner: change.state.owner,
        epoch: change.state.epoch,
        keys: sealed(&change),
    };
    let (me, chat) = (ctx.me(), change.state.chat_id);
    ctx.st
        .store
        .write(move |w| w.change_state(me, chat, ch, now_ms()))
        .await
        .map_err(|e| match e.code {
            "stale_version" => ToolError::new(
                "changed_meanwhile",
                "the group changed meanwhile; look at it again and repeat",
            ),
            _ => e.into(),
        })?;
    Ok(())
}

fn info(dir: &Dir, chat: &ChatRef, state: &GroupState) -> Value {
    let server = chat.chat.as_ref();
    let mut members: Vec<Value> = state
        .members
        .iter()
        .map(|m| {
            let mut v = json!({ "userId": m.user_id, "name": dir.name(&m.user_id) });
            if m.user_id == state.owner {
                v["owner"] = json!(true);
            }
            if m.user_id == dir.me {
                v["me"] = json!(true);
            }
            // The server no longer delivers to them: they left, and the owner has not removed them yet.
            if server.is_some_and(|c| !c.is_member(&m.user_id)) {
                v["left"] = json!(true);
            }
            v
        })
        .collect();
    members.sort_by_key(|m| m["name"].as_str().unwrap_or("").to_lowercase());
    json!({
        "chat": chat.id,
        "kind": "group",
        "name": state.name,
        "owner": state.owner,
        "ownerName": dir.name(&state.owner),
        "iAmOwner": state.owner == dir.me,
        "members": members,
    })
}

pub async fn group_info(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    if chat.kind != ChatKind::Group {
        return Err(ToolError::invalid("this chat is not a group"));
    }
    // A group this identity left is still readable up to the state it last saw.
    let state = view
        .group(&chat.id)
        .and_then(|g| g.state())
        .ok_or_else(|| ToolError::new("need_key", "this group is not readable by this identity"))?;
    let mut v = info(&dir, &chat, state);
    v["member"] = json!(chat.chat.as_ref().is_some_and(|c| c.is_member(&dir.me)));
    Ok(v)
}

pub async fn group_create(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (_view, dir) = ctx.synced().await?;
    let me = ctx.me();
    let others: Vec<UserId> = user_ids(a, "members")?.into_iter().filter(|u| *u != me).collect();
    if others.len() + 1 > MAX_MEMBERS {
        return Err(ToolError::invalid(format!("a group has at most {MAX_MEMBERS} members")));
    }
    let change = create_group(
        &ctx.st.server_id,
        &ctx.conn.keys,
        a.str("name"),
        &member_inputs(&dir, &others)?,
        &mut system_rng,
    )?;
    let new = NewGroup {
        chat: change.state.chat_id,
        state: change.blob.clone(),
        members: sorted(change.state.members.iter().map(|m| m.user_id).collect()),
        epoch: change.state.epoch,
        keys: sealed(&change),
    };
    ctx.st.store.write(move |w| w.create_group(me, new, now_ms())).await?;
    Ok(json!({ "chat": change.state.chat_id, "name": change.state.name, "members": change.state.members.len() }))
}

pub async fn group_rename(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let k = owned(ctx, &view, &chat)?;
    let change = rename_group(k.state, &ctx.conn.keys, k.secret, a.str("name"), &mut system_rng)?;
    let name = change.state.name.clone();
    store_change(ctx, k.state, change).await?;
    Ok(json!({ "chat": chat.id, "name": name }))
}

pub async fn group_members_add(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let k = owned(ctx, &view, &chat)?;
    let new: Vec<UserId> = user_ids(a, "members")?
        .into_iter()
        .filter(|u| k.state.member(u).is_none())
        .collect();
    if new.is_empty() {
        return Ok(json!({ "chat": chat.id, "added": 0, "members": k.state.members.len() }));
    }
    if k.state.members.len() + new.len() > MAX_MEMBERS {
        return Err(ToolError::invalid(format!("a group has at most {MAX_MEMBERS} members")));
    }
    let change = add_group_members(
        k.state,
        &ctx.conn.keys,
        k.secret,
        &member_inputs(&dir, &new)?,
        a.bool_or("share_history", true),
        &mut system_rng,
    )?;
    let members = change.state.members.len();
    store_change(ctx, k.state, change).await?;
    Ok(json!({ "chat": chat.id, "added": new.len(), "members": members }))
}

pub async fn group_members_remove(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let k = owned(ctx, &view, &chat)?;
    let gone: Vec<UserId> = user_ids(a, "members")?
        .into_iter()
        .filter(|u| k.state.member(u).is_some())
        .collect();
    if gone.contains(&ctx.me()) {
        return Err(ToolError::invalid(
            "the owner does not remove itself: use group_leave with transfer_to",
        ));
    }
    if gone.is_empty() {
        return Ok(json!({ "chat": chat.id, "removed": 0, "members": k.state.members.len() }));
    }
    let change = remove_group_members(k.state, &ctx.conn.keys, &gone, &mut system_rng)?;
    let members = change.state.members.len();
    store_change(ctx, k.state, change).await?;
    Ok(json!({ "chat": chat.id, "removed": gone.len(), "members": members }))
}

fn other_member(a: &Args<'_>, key: &str) -> Result<UserId, ToolError> {
    UserId::parse(a.str(key).trim())
        .ok_or_else(|| ToolError::invalid(format!("{key} must be a userId from group_info")))
}

pub async fn group_transfer(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    let k = owned(ctx, &view, &chat)?;
    let to = other_member(a, "to")?;
    member_inputs(&dir, &[to])?;
    let change = transfer_group_ownership(k.state, &ctx.conn.keys, k.secret, &to, &mut system_rng)?;
    store_change(ctx, k.state, change).await?;
    Ok(json!({ "chat": chat.id, "owner": to, "ownerName": dir.name(&to) }))
}

pub async fn group_leave(ctx: &Ctx, a: &Args<'_>) -> ToolResult {
    let (view, dir) = ctx.synced().await?;
    let chat = ctx.resolve_chat(&dir, a.str("chat"))?;
    if chat.kind != ChatKind::Group {
        return Err(ToolError::invalid("this chat is not a group"));
    }
    let me = ctx.me();
    if chat.chat.as_ref().is_none_or(|c| !c.is_member(&me)) {
        return Ok(json!({ "chat": chat.id, "left": true }));
    }
    // The owner hands the group over first: a group is never left without one.
    if chat.chat.as_ref().and_then(|c| c.owner) == Some(me) {
        let Some(_) = a.opt_str("transfer_to") else {
            return Err(ToolError::new(
                "owner_cannot_leave",
                "the owner passes the group on first: give transfer_to, a member's userId from group_info",
            ));
        };
        let to = other_member(a, "transfer_to")?;
        let k = owned(ctx, &view, &chat)?;
        member_inputs(&dir, &[to])?;
        let change = transfer_group_ownership(k.state, &ctx.conn.keys, k.secret, &to, &mut system_rng)?;
        store_change(ctx, k.state, change).await?;
    }
    let chat_id = chat.id;
    ctx.st
        .store
        .write(move |w| w.leave_group(me, chat_id, now_ms()))
        .await?;
    Ok(json!({ "chat": chat.id, "left": true }))
}

/// What the owner's app does on its own: members who left the group, left
/// the family or revoked their identity are removed from the signed state,
/// with a new epoch, so they get no further keys. Runs when a connection
/// that may write looks at its chats; a lost race with the owner's own app
/// is fine (it did the same).
pub async fn owner_duties(ctx: &Ctx, view: &View, dir: &Dir) -> bool {
    let me = ctx.me();
    let mut changed = false;
    for chat in dir
        .chats
        .values()
        .filter(|c| c.kind == ChatKind::Group && c.owner == Some(me))
    {
        let Some(g) = view.group(&chat.id) else { continue };
        let Some(state) = g
            .state()
            .filter(|s| u64::from(s.version) == chat.version && s.owner == me)
        else {
            continue;
        };
        if g.broken.is_some() {
            continue;
        }
        let gone: Vec<UserId> = state
            .members
            .iter()
            .map(|m| m.user_id)
            .filter(|u| *u != me)
            .filter(|u| !chat.is_member(u) || dir.users.get(u).is_none_or(|x| !x.active()))
            .collect();
        if gone.is_empty() {
            continue;
        }
        let built: Result<GroupChange, _> = remove_group_members(state, &ctx.conn.keys, &gone, &mut system_rng);
        match built {
            Ok(change) => match store_change(ctx, state, change).await {
                Ok(()) => changed = true,
                Err(e) => tracing::warn!(
                    "{}",
                    tr!(
                        "MCP: автоматическое удаление из группы {} не удалось: {}",
                        "MCP: automatic removal from group {} failed: {}",
                        chat.id,
                        e.message
                    )
                ),
            },
            Err(e) => tracing::warn!("MCP: group {}: {}", chat.id, e.message),
        }
    }
    changed
}
