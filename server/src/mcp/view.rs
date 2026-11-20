//! What a connection sees: the events of its identity's chats, decrypted and
//! checked with the client side of the protocol and folded into messages
//! (edits, reactions and deletions applied, as the app does in
//! `packages/core/src/apply.ts`). Kept in memory only, rebuilt from the
//! server's log after a restart, and never older than the log itself: what
//! retention removed from the disk leaves the view too.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::conn::Conn;
use super::tools::ToolError;
use crate::app::AppState;
use crate::client::dm::{ChatKeys, derive_dm_keys};
use crate::client::event::{EventContext, decode_event};
use crate::client::group::{
    GroupState, accept_group_key, derive_group_keys, open_group_key, open_group_state, parse_sealed_group_key,
    read_state_header, verify_group_key,
};
use crate::client::payload::{Attachment, Location, MsgRef, Payload, StickerRef};
use crate::client::seal::{self, PeerIdentity};
use crate::client::{Code, ProtoError};
use crate::envelope::Envelope;
use crate::ids::{ChatId, DevId, MsgId, UserId, b64_decode};
use crate::store::{Chat, ChatKind, Entry, NOTICE_SENDER};

/// Events read from the log in one step.
const PAGE_EVENTS: usize = 500;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
/// Sealed keys read from the store in one step.
const PAGE_KEYS: usize = 500;
/// Changes remembered for `events_wait`.
const JOURNAL: usize = 5000;
/// A view nobody asked for this long is dropped (and rebuilt on the next call).
const IDLE: Duration = Duration::from_secs(30 * 60);

/// A member of the family as a connection sees them.
#[derive(Clone)]
pub struct DirUser {
    pub id: UserId,
    pub name: String,
    pub gender: &'static str,
    pub admin: bool,
    pub removed: bool,
    /// `revokedAt` of the signed revocation: later events of this identity are not accepted.
    pub revoked_at: Option<u64>,
    pub identity: Option<PeerIdentity>,
}

impl DirUser {
    pub fn active(&self) -> bool {
        !self.removed && self.revoked_at.is_none()
    }
}

/// The family at one moment: members and the chats of one user.
pub struct Dir {
    pub me: UserId,
    pub users: HashMap<UserId, DirUser>,
    /// Chats `me` is or was a member of.
    pub chats: HashMap<ChatId, Chat>,
    pub oldest_gseq: u64,
}

impl Dir {
    pub fn name(&self, u: &UserId) -> String {
        self.users
            .get(u)
            .map(|x| x.name.clone())
            .unwrap_or_else(|| u.to_string())
    }

    /// The other member of a direct chat (`me` for the chat with oneself).
    pub fn peer(&self, chat: &Chat) -> UserId {
        chat.members.iter().copied().find(|u| *u != self.me).unwrap_or(self.me)
    }
}

fn revoked_at(env: &Envelope, fallback: u64) -> u64 {
    b64_decode(&env.payload)
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("revokedAt").and_then(Value::as_u64))
        .unwrap_or(fallback)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgKind {
    Msg,
    /// Deleted for everyone: a quiet line without content.
    Deleted,
    /// A kind this server does not know and must not skip.
    UpdateRequired,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub gseq: u64,
    pub time: u64,
    pub chat: ChatId,
    pub author: UserId,
    pub id: MsgId,
    pub dev: DevId,
    pub seq: Option<u64>,
    pub kind: MsgKind,
    /// The text in force (the last edit of the author, or the original).
    pub body: String,
    original: String,
    pub reply: Option<MsgRef>,
    pub fwd: bool,
    pub attachments: Vec<Attachment>,
    pub location: Option<Location>,
    pub sticker: Option<StickerRef>,
    /// Server time of the edit in force.
    pub edited: Option<u64>,
    /// Emoji in the order they first appeared, each with who reacted.
    pub reactions: Vec<(String, Vec<UserId>)>,
}

impl Message {
    pub fn msg_ref(&self) -> MsgRef {
        MsgRef {
            author: self.author,
            id: self.id,
        }
    }
}

#[derive(Debug, Clone)]
enum ControlKind {
    Edit(String),
    Delete,
    React { emoji: String, on: bool },
}

#[derive(Debug, Clone)]
struct Control {
    sender: UserId,
    id: MsgId,
    chat: ChatId,
    /// Epoch of the control event itself (a group owner's delete counts by it).
    epoch: u32,
    gseq: u64,
    time: u64,
    kind: ControlKind,
}

#[derive(Debug, Clone)]
pub enum ChangeKind {
    Message,
    Edit {
        target: MsgRef,
    },
    Reaction {
        target: MsgRef,
        emoji: String,
        on: bool,
    },
    Delete {
        target: MsgRef,
    },
    /// A server notice (group changes): its public fields.
    Notice(Value),
}

/// One thing that happened, for `events_wait`.
#[derive(Debug, Clone)]
pub struct Change {
    pub gseq: u64,
    pub time: u64,
    pub chat: ChatId,
    pub by: UserId,
    pub dev: DevId,
    pub kind: ChangeKind,
}

/// A sealed epoch key addressed to this identity, as the server stores it.
struct Sealed {
    n: u64,
    /// Version of the state it was sealed with.
    version: u64,
    text: String,
    done: bool,
}

/// A group as this identity knows it: the accepted states (each verified
/// against the one before, or against the sealed key that introduced it)
/// and the epoch secrets opened from the keys sealed to it.
#[derive(Default)]
pub struct GroupView {
    states: BTreeMap<u32, GroupState>,
    secrets: HashMap<u32, [u8; 32]>,
    sealed: Vec<Sealed>,
    /// A state or key did not verify: the group stops here for this identity.
    pub broken: Option<&'static str>,
    /// History the feed does not deliver was read with the keys known so far.
    backfilled: bool,
}

impl GroupView {
    /// The last accepted state.
    pub fn state(&self) -> Option<&GroupState> {
        self.states.values().next_back()
    }

    /// The last accepted state of an epoch: its members are the authors of that epoch's events.
    fn state_of(&self, epoch: u32) -> Option<&GroupState> {
        self.states.values().rev().find(|s| s.epoch == epoch)
    }

    /// Keys to read or write events of an epoch.
    pub fn keys(&self, epoch: u32) -> Option<ChatKeys> {
        self.secrets.get(&epoch).map(|s| derive_group_keys(s, epoch))
    }

    pub fn secret(&self, epoch: u32) -> Option<&[u8; 32]> {
        self.secrets.get(&epoch)
    }
}

fn read_state(st: &AppState, chat: &ChatId, version: u64) -> Option<Vec<u8>> {
    let path = st
        .store
        .path()
        .join("chats")
        .join(chat.to_string())
        .join("state")
        .join(format!("{version}.enc"));
    std::fs::read(path).ok()
}

#[derive(Default)]
pub struct View {
    /// `gseq` of the last log record folded in.
    pub cursor: u64,
    chats: HashMap<ChatId, BTreeMap<u64, Message>>,
    by_ref: HashMap<MsgRef, (ChatId, u64)>,
    controls: HashMap<MsgRef, Vec<Control>>,
    /// Messages deleted for everyone (also before the message itself arrived).
    tomb: HashSet<MsgRef>,
    journal: VecDeque<Change>,
    /// `gseq` before the oldest remembered change: a cursor below it missed something.
    journal_from: u64,
    identities: HashMap<UserId, (String, Option<PeerIdentity>)>,
    dm_keys: HashMap<ChatId, ChatKeys>,
    groups: HashMap<ChatId, GroupView>,
    /// `n` of the last sealed key taken from the store.
    key_cursor: u64,
    /// Set while history from before joining is read: nothing of it is news.
    quiet: bool,
    /// Events that did not decrypt or verify (never shown).
    pub rejected: u64,
}

impl View {
    /// The family now, as `conn`'s identity sees it.
    pub fn dir(&mut self, st: &AppState, me: &UserId) -> Dir {
        struct Raw {
            id: UserId,
            name: String,
            gender: &'static str,
            admin: bool,
            removed: bool,
            revoked_at: Option<u64>,
            envelope: Envelope,
        }
        let (raw, chats, oldest_gseq) = st.store.read(|m| {
            let raw: Vec<Raw> = m
                .users
                .values()
                .map(|u| Raw {
                    id: u.id,
                    name: u.profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
                    gender: u.profile.as_ref().map(|p| p.gender.as_str()).unwrap_or("m"),
                    admin: m.is_admin(&u.id),
                    removed: u.removed_at.is_some(),
                    revoked_at: u.revoked.as_ref().map(|r| revoked_at(&r.envelope, r.at)),
                    envelope: u.identity.envelope.clone(),
                })
                .collect();
            let chats: HashMap<ChatId, Chat> = m
                .chats
                .values()
                .filter(|c| c.is_member(me) || c.periods.iter().any(|p| p.user_id == *me))
                .map(|c| (c.id, c.clone()))
                .collect();
            (raw, chats, m.oldest_gseq())
        });
        let mut users = HashMap::with_capacity(raw.len());
        for r in raw {
            // An identity envelope is checked once (the client-side check), then remembered by its signature.
            let known = self.identities.get(&r.id).filter(|(sig, _)| *sig == r.envelope.sig);
            let identity = match known {
                Some((_, i)) => i.clone(),
                None => {
                    let i = seal::verify_identity(&r.envelope).ok().filter(|i| i.user_id == r.id);
                    self.identities.insert(r.id, (r.envelope.sig.clone(), i.clone()));
                    i
                }
            };
            users.insert(
                r.id,
                DirUser {
                    id: r.id,
                    name: r.name,
                    gender: r.gender,
                    admin: r.admin,
                    removed: r.removed,
                    revoked_at: r.revoked_at,
                    identity,
                },
            );
        }
        Dir {
            me: *me,
            users,
            chats,
            oldest_gseq,
        }
    }

    /// Keys of the direct chat with `peer`.
    pub fn dm_keys(&mut self, st: &AppState, conn: &Conn, dir: &Dir, chat: &ChatId, peer: &UserId) -> Option<ChatKeys> {
        if let Some(k) = self.dm_keys.get(chat) {
            return Some(k.clone());
        }
        let box_pub = dir.users.get(peer)?.identity.as_ref()?.box_pub;
        let keys = derive_dm_keys(&conn.keys, peer, &box_pub, &st.server_id).ok()?;
        self.dm_keys.insert(*chat, keys.clone());
        Some(keys)
    }

    /// Folds in everything the log has after the cursor; returns the family as of now.
    pub async fn sync(&mut self, st: &AppState, conn: &Conn) -> Result<Dir, ToolError> {
        let me = conn.file.user_id;
        loop {
            let dir = self.dir(st, &me);
            self.reconcile(st, conn, &dir);
            let page = st
                .store
                .read(|m| m.events_after(&me, self.cursor, PAGE_EVENTS, PAGE_BYTES));
            let to_read: Vec<Entry> = page
                .events
                .iter()
                .filter(|e| e.h.sender != NOTICE_SENDER)
                .copied()
                .collect();
            let reader = st.store.clone();
            let bodies = tokio::task::spawn_blocking(move || reader.read_bodies(&to_read))
                .await
                .map_err(|_| ToolError::new("internal", "reading events failed"))?;
            let mut bodies: HashMap<u64, (Entry, Vec<u8>)> =
                bodies.into_iter().map(|(e, b)| (e.h.gseq, (e, b))).collect();
            for e in &page.events {
                if e.h.sender == NOTICE_SENDER {
                    if let Some(n) = page.notices.get(&e.h.gseq)
                        && n.kind() != "event_deleted"
                    {
                        self.note(Change {
                            gseq: e.h.gseq,
                            time: e.h.time,
                            chat: e.h.chat,
                            by: NOTICE_SENDER,
                            dev: e.h.dev,
                            kind: ChangeKind::Notice(Value::Object(n.public.clone())),
                        });
                    }
                    continue;
                }
                // An event whose segment vanished meanwhile (retention) is skipped.
                let Some((entry, body)) = bodies.remove(&e.h.gseq) else {
                    continue;
                };
                self.take(st, conn, &dir, &entry, &body);
            }
            self.cursor = self.cursor.max(page.cursor);
            if !page.more {
                self.backfill(st, conn, &dir).await?;
                self.prune(dir.oldest_gseq);
                return Ok(dir);
            }
        }
    }

    fn note(&mut self, c: Change) {
        if self.quiet {
            return;
        }
        if self.journal.len() >= JOURNAL
            && let Some(old) = self.journal.pop_front()
        {
            self.journal_from = old.gseq;
        }
        self.journal.push_back(c);
    }

    /// Changes after `cursor`; `None` when the journal no longer reaches back that far.
    pub fn changes_after(&self, cursor: u64) -> Option<Vec<Change>> {
        if cursor < self.journal_from {
            return None;
        }
        Some(self.journal.iter().filter(|c| c.gseq > cursor).cloned().collect())
    }

    /// Decrypts, verifies and applies one stored event.
    fn take(&mut self, st: &AppState, conn: &Conn, dir: &Dir, e: &Entry, body: &[u8]) {
        let Some(chat) = dir.chats.get(&e.h.chat) else { return };
        if e.deleted {
            self.server_deleted(e);
            return;
        }
        let me = conn.file.user_id;
        if let Some(u) = dir.users.get(&e.h.sender)
            && u.revoked_at.is_some_and(|t| e.h.time > t)
        {
            self.rejected += 1;
            return;
        }
        let decoded = match chat.kind {
            ChatKind::Dm => {
                let peer = dir.peer(chat);
                let Some(keys) = self.dm_keys(st, conn, dir, &chat.id, &peer) else {
                    self.rejected += 1;
                    return;
                };
                let peer_key = dir
                    .users
                    .get(&peer)
                    .and_then(|u| u.identity.as_ref())
                    .map(|i| i.sign_pub);
                let my_key = conn.keys.sign_pub;
                let lookup = move |id: &UserId| {
                    if *id == me {
                        Some(my_key)
                    } else if *id == peer {
                        peer_key
                    } else {
                        None
                    }
                };
                decode_event(
                    body,
                    &EventContext {
                        server_id: &st.server_id,
                        chat_id: &chat.id.to_string(),
                        chat: &keys,
                    },
                    &lookup,
                    Some(&e.h.sender),
                )
            }
            ChatKind::Group => {
                let Some(g) = self.groups.get(&chat.id) else { return };
                // No key of that epoch (it is from before this identity joined, or
                // from while it was out of the group): not readable, by design.
                let (Some(keys), Some(state)) = (g.keys(e.h.epoch), g.state_of(e.h.epoch)) else {
                    return;
                };
                let lookup = |id: &UserId| state.member(id).map(|m| m.sign_pub);
                decode_event(
                    body,
                    &EventContext {
                        server_id: &st.server_id,
                        chat_id: &chat.id.to_string(),
                        chat: &keys,
                    },
                    &lookup,
                    Some(&e.h.sender),
                )
            }
        };
        match decoded {
            Ok(d) if d.msg_id == e.h.msg => self.apply(e, d.payload),
            _ => self.rejected += 1,
        }
    }

    /// The server's zeroed record: a placeholder where nothing is known. It
    /// never hides a readable message; only a signed delete does.
    fn server_deleted(&mut self, e: &Entry) {
        let r = MsgRef {
            author: e.h.sender,
            id: e.h.msg,
        };
        if self.by_ref.contains_key(&r)
            || self
                .controls
                .values()
                .flatten()
                .any(|c| c.sender == r.author && c.id == r.id)
        {
            return;
        }
        self.insert(Message {
            gseq: e.h.gseq,
            time: e.h.time,
            chat: e.h.chat,
            author: e.h.sender,
            id: e.h.msg,
            dev: e.h.dev,
            seq: None,
            kind: MsgKind::Deleted,
            body: String::new(),
            original: String::new(),
            reply: None,
            fwd: false,
            attachments: Vec::new(),
            location: None,
            sticker: None,
            edited: None,
            reactions: Vec::new(),
        });
    }

    fn insert(&mut self, m: Message) {
        self.by_ref.insert(m.msg_ref(), (m.chat, m.gseq));
        self.chats.entry(m.chat).or_default().insert(m.gseq, m);
    }

    fn apply(&mut self, e: &Entry, payload: Payload) {
        let h = &e.h;
        let own = MsgRef {
            author: h.sender,
            id: h.msg,
        };
        let change = |kind| Change {
            gseq: h.gseq,
            time: h.time,
            chat: h.chat,
            by: h.sender,
            dev: h.dev,
            kind,
        };
        let (target, control) = match payload {
            Payload::Msg(m) => {
                if self.by_ref.contains_key(&own) {
                    return;
                }
                let body = m.body.unwrap_or_default();
                self.insert(Message {
                    gseq: h.gseq,
                    time: h.time,
                    chat: h.chat,
                    author: h.sender,
                    id: h.msg,
                    dev: m.common.dev,
                    seq: Some(m.common.seq),
                    kind: MsgKind::Msg,
                    original: body.clone(),
                    body,
                    reply: m.reply,
                    fwd: m.fwd,
                    attachments: m.attachments,
                    location: m.location,
                    sticker: m.sticker,
                    edited: None,
                    reactions: Vec::new(),
                });
                self.note(change(ChangeKind::Message));
                // Edits, reactions or a delete that came before the message.
                self.recompute(&own);
                return;
            }
            Payload::Unknown {
                critical: true,
                dev,
                seq,
                ..
            } => {
                if self.by_ref.contains_key(&own) {
                    return;
                }
                self.insert(Message {
                    gseq: h.gseq,
                    time: h.time,
                    chat: h.chat,
                    author: h.sender,
                    id: h.msg,
                    dev: dev.unwrap_or(h.dev),
                    seq,
                    kind: MsgKind::UpdateRequired,
                    body: String::new(),
                    original: String::new(),
                    reply: None,
                    fwd: false,
                    attachments: Vec::new(),
                    location: None,
                    sticker: None,
                    edited: None,
                    reactions: Vec::new(),
                });
                self.note(change(ChangeKind::Message));
                return;
            }
            Payload::Unknown { .. } => return,
            Payload::Edit { target, body, .. } => (target, ControlKind::Edit(body)),
            Payload::Delete { target, .. } => (target, ControlKind::Delete),
            Payload::React { target, emoji, on, .. } => (target, ControlKind::React { emoji, on }),
        };
        let list = self.controls.entry(target).or_default();
        if list.iter().any(|c| c.sender == h.sender && c.id == h.msg) {
            return;
        }
        let kind = match &control {
            ControlKind::Edit(_) => ChangeKind::Edit { target },
            ControlKind::Delete => ChangeKind::Delete { target },
            ControlKind::React { emoji, on } => ChangeKind::Reaction {
                target,
                emoji: emoji.clone(),
                on: *on,
            },
        };
        list.push(Control {
            sender: h.sender,
            id: h.msg,
            chat: h.chat,
            epoch: h.epoch,
            gseq: h.gseq,
            time: h.time,
            kind: control,
        });
        self.note(change(kind));
        self.recompute(&target);
    }

    /// A delete counts from the author of the message, or from an owner of the
    /// group in an accepted state of the delete event's epoch.
    fn may_delete(&self, target: &MsgRef, c: &Control) -> bool {
        c.sender == target.author
            || self
                .groups
                .get(&c.chat)
                .is_some_and(|g| g.states.values().any(|s| s.epoch == c.epoch && s.owner == c.sender))
    }

    /// Recomputes one message from its original and every control event
    /// about it, so the result does not depend on the order of arrival.
    fn recompute(&mut self, target: &MsgRef) {
        let at = self.by_ref.get(target).copied();
        let controls: Vec<Control> = self
            .controls
            .get(target)
            .map(|v| {
                v.iter()
                    // A control event counts only in the chat of its message.
                    .filter(|c| at.is_none_or(|(chat, _)| chat == c.chat))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let deleted = self.tomb.contains(target)
            || controls
                .iter()
                .any(|c| matches!(c.kind, ControlKind::Delete) && self.may_delete(target, c));
        if deleted {
            self.tomb.insert(*target);
            // The text of the message and of its edits leaves the view; reactions go too.
            if let Some(v) = self.controls.get_mut(target) {
                v.retain(|c| matches!(c.kind, ControlKind::Delete));
            }
        }
        let Some((chat, gseq)) = at else { return };
        let Some(m) = self.chats.get_mut(&chat).and_then(|c| c.get_mut(&gseq)) else {
            return;
        };
        if deleted {
            m.kind = MsgKind::Deleted;
            m.body.clear();
            m.original.clear();
            m.reply = None;
            m.fwd = false;
            m.attachments.clear();
            m.location = None;
            m.sticker = None;
            m.edited = None;
            m.reactions.clear();
            return;
        }
        if m.kind != MsgKind::Msg {
            return;
        }
        let edit = controls
            .iter()
            .filter(|c| c.sender == target.author)
            .filter_map(|c| match &c.kind {
                ControlKind::Edit(body) => Some((c.gseq, c.time, body)),
                _ => None,
            })
            .max_by_key(|(g, _, _)| *g);
        match edit {
            Some((_, time, body)) => {
                m.body = body.clone();
                m.edited = Some(time);
            }
            None => {
                m.body = m.original.clone();
                m.edited = None;
            }
        }
        // One value per (sender, emoji), the highest gseq wins; emoji are
        // listed by the gseq of their oldest reaction still on.
        let mut latest: HashMap<(UserId, &str), (u64, bool)> = HashMap::new();
        for c in &controls {
            if let ControlKind::React { emoji, on } = &c.kind {
                let slot = latest.entry((c.sender, emoji.as_str())).or_insert((0, false));
                if c.gseq > slot.0 {
                    *slot = (c.gseq, *on);
                }
            }
        }
        let mut by_emoji: BTreeMap<&str, (u64, Vec<UserId>)> = BTreeMap::new();
        for ((user, emoji), (gseq, on)) in latest {
            if on {
                let slot = by_emoji.entry(emoji).or_insert((u64::MAX, Vec::new()));
                slot.0 = slot.0.min(gseq);
                slot.1.push(user);
            }
        }
        let mut reactions: Vec<(u64, String, Vec<UserId>)> = by_emoji
            .into_iter()
            .map(|(emoji, (first, mut users))| {
                users.sort_by_key(|u| u.to_string());
                (first, emoji.to_string(), users)
            })
            .collect();
        reactions.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        m.reactions = reactions.into_iter().map(|(_, e, u)| (e, u)).collect();
    }

    /// Drops what the server no longer stores.
    fn prune(&mut self, oldest: u64) {
        if self
            .chats
            .values()
            .all(|c| c.keys().next().is_none_or(|g| *g >= oldest))
        {
            return;
        }
        for c in self.chats.values_mut() {
            *c = c.split_off(&oldest);
        }
        self.by_ref.retain(|_, (_, g)| *g >= oldest);
        for v in self.controls.values_mut() {
            v.retain(|c| c.gseq >= oldest);
        }
        self.controls.retain(|_, v| !v.is_empty());
        let (by_ref, controls) = (&self.by_ref, &self.controls);
        self.tomb.retain(|r| by_ref.contains_key(r) || controls.contains_key(r));
    }

    // ---- groups ----

    pub fn group(&self, chat: &ChatId) -> Option<&GroupView> {
        self.groups.get(chat)
    }

    /// Takes new sealed keys and brings every group to the server's current
    /// state version, as far as this identity's keys reach.
    fn reconcile(&mut self, st: &AppState, conn: &Conn, dir: &Dir) {
        loop {
            let (keys, more) = st.store.read(|m| m.keys_after(&dir.me, self.key_cursor, PAGE_KEYS));
            for k in keys {
                self.key_cursor = self.key_cursor.max(k.n);
                self.groups.entry(k.chat).or_default().sealed.push(Sealed {
                    n: k.n,
                    version: k.version,
                    text: k.key,
                    done: false,
                });
            }
            if !more {
                break;
            }
        }
        for chat in dir.chats.values().filter(|c| c.kind == ChatKind::Group) {
            let g = self.groups.entry(chat.id).or_default();
            if g.broken.is_none()
                && g.state().is_none_or(|s| u64::from(s.version) < chat.version)
                && let Err(e) = advance(g, st, conn, chat)
            {
                tracing::warn!(
                    "{}",
                    tr!(
                        "MCP: состояние группы {} не принято для {}: {}",
                        "MCP: a state of group {} was not accepted for {}: {}",
                        chat.id,
                        dir.me,
                        e.message
                    )
                );
                g.broken = Some(e.code.as_str());
            }
            // Keys that came for a state already accepted (an earlier epoch shared later).
            for i in 0..g.sealed.len() {
                if g.sealed[i].done {
                    continue;
                }
                let Some(state) = u32::try_from(g.sealed[i].version).ok().and_then(|v| g.states.get(&v)) else {
                    continue;
                };
                let opened = parse_sealed_group_key(&g.sealed[i].text)
                    .and_then(|env| open_group_key(&env, &conn.keys, &st.server_id))
                    .and_then(|k| verify_group_key(&k, state).map(|()| k));
                if let Ok(k) = opened
                    && !g.secrets.contains_key(&k.header.epoch)
                {
                    g.secrets.insert(k.header.epoch, k.secret);
                    g.backfilled = false;
                }
                g.sealed[i].done = true;
            }
        }
    }

    /// Reads the part of a group's history the feed does not deliver (from
    /// before this identity joined, or from while it was out), where it has
    /// the key: members added "with history". None of it is news. Runs again
    /// when a new key arrives.
    async fn backfill(&mut self, st: &AppState, conn: &Conn, dir: &Dir) -> Result<(), ToolError> {
        let todo: Vec<ChatId> = self
            .groups
            .iter()
            .filter(|(id, g)| !g.backfilled && g.state().is_some() && dir.chats.contains_key(id))
            .map(|(id, _)| *id)
            .collect();
        for id in todo {
            let chat = &dir.chats[&id];
            let mut before = self.cursor.saturating_add(1);
            self.quiet = true;
            while before > 1 {
                let page = st
                    .store
                    .read(|m| m.chat_history(&dir.me, &id, before, PAGE_EVENTS, PAGE_BYTES));
                let to_read: Vec<Entry> = page
                    .events
                    .iter()
                    .filter(|e| e.h.sender != NOTICE_SENDER)
                    .copied()
                    .collect();
                let reader = st.store.clone();
                let bodies = match tokio::task::spawn_blocking(move || reader.read_bodies(&to_read)).await {
                    Ok(b) => b,
                    Err(_) => {
                        self.quiet = false;
                        return Err(ToolError::new("internal", "reading events failed"));
                    }
                };
                for (entry, body) in &bodies {
                    // What the feed delivers is taken there (and is news there).
                    if !chat.delivers(&dir.me, entry.h.gseq) {
                        self.take(st, conn, dir, entry, body);
                    }
                }
                if !page.more || page.events.is_empty() {
                    break;
                }
                before = page.cursor;
            }
            self.quiet = false;
            if let Some(g) = self.groups.get_mut(&id) {
                g.backfilled = true;
            }
        }
        Ok(())
    }

    // ---- reading ----

    pub fn chat(&self, chat: &ChatId) -> Option<&BTreeMap<u64, Message>> {
        self.chats.get(chat)
    }

    pub fn message(&self, chat: &ChatId, gseq: u64) -> Option<&Message> {
        self.chats.get(chat)?.get(&gseq)
    }

    pub fn by_ref(&self, r: &MsgRef) -> Option<&Message> {
        let (chat, gseq) = self.by_ref.get(r)?;
        self.message(chat, *gseq)
    }

    pub fn last(&self, chat: &ChatId) -> Option<&Message> {
        self.chats.get(chat)?.values().next_back()
    }

    pub fn all(&self) -> impl Iterator<Item = &Message> {
        self.chats.values().flat_map(|c| c.values())
    }
}

/// Walks a group's states up to the server's version (the app's
/// `Groups.#advance`): the next version with the epoch secret already known,
/// or with the key sealed for it; when this identity has no key for the next
/// version (it was out of the group), from the next state it has a key for.
fn advance(g: &mut GroupView, st: &AppState, conn: &Conn, chat: &Chat) -> Result<(), ProtoError> {
    let server_id = st.server_id.as_str();
    for _ in 0..10_000 {
        let prev = g.state().cloned();
        if prev.as_ref().is_some_and(|p| u64::from(p.version) >= chat.version) {
            break;
        }
        let v = match &prev {
            Some(p) => u64::from(p.version) + 1,
            None => match g.sealed.iter().map(|k| k.version).min() {
                Some(v) => v,
                // No key yet: nothing of this group is readable.
                None => return Ok(()),
            },
        };
        let Some(blob) = read_state(st, &chat.id, v) else {
            return Ok(());
        };
        let (epoch, _) = read_state_header(&blob)?;
        let (state, secret, used) = if let Some(keys) = g.keys(epoch) {
            let state = open_group_state(&blob, server_id, &chat.id, &keys, prev.as_ref(), None)?;
            (state, None, None)
        } else if let Some(k) = g.sealed.iter().find(|k| k.version == v) {
            let env = parse_sealed_group_key(&k.text)?;
            let (state, key, _) = accept_group_key(&env, &blob, &conn.keys, server_id, prev.as_ref())?;
            (state, Some(key.secret), Some(k.n))
        } else {
            // A later key (added again after a removal): start over from that state.
            let later = g
                .sealed
                .iter()
                .filter(|k| k.version > v && !k.done)
                .min_by_key(|k| k.version);
            let Some(k) = later else { return Ok(()) };
            let Some(blob) = read_state(st, &chat.id, k.version) else {
                return Ok(());
            };
            let env = parse_sealed_group_key(&k.text)?;
            let (state, key, _) = accept_group_key(&env, &blob, &conn.keys, server_id, None)?;
            (state, Some(key.secret), Some(k.n))
        };
        if state.chat_id != chat.id {
            return Err(ProtoError {
                code: Code::WrongChat,
                message: "the state belongs to another chat".into(),
                positions: Vec::new(),
            });
        }
        if let Some(secret) = secret
            && !g.secrets.contains_key(&state.epoch)
        {
            g.secrets.insert(state.epoch, secret);
            g.backfilled = false;
        }
        if let Some(n) = used
            && let Some(k) = g.sealed.iter_mut().find(|k| k.n == n)
        {
            k.done = true;
        }
        g.states.insert(state.version, state);
    }
    Ok(())
}

type SharedView = Arc<tokio::sync::Mutex<View>>;

/// The views of a family's connections, each with the time it was last asked for.
#[derive(Default)]
pub struct Views {
    map: Mutex<HashMap<String, (Instant, SharedView)>>,
}

impl Views {
    /// The view of a connection (created empty; `sync` fills it).
    pub fn of(&self, conn_id: &str) -> SharedView {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|id, (used, v)| id == conn_id || now.duration_since(*used) < IDLE || Arc::strong_count(v) > 1);
        let slot = map
            .entry(conn_id.to_string())
            .or_insert_with(|| (now, Arc::new(tokio::sync::Mutex::new(View::default()))));
        slot.0 = now;
        slot.1.clone()
    }

    /// Forgets the view of a deleted connection.
    pub fn forget(&self, conn_id: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(conn_id);
    }
}
