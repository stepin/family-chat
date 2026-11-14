//! Server notices: unencrypted records written by the server into the event
//! log (with their own `gseq`) and delivered through `GET /v1/events` to the
//! users listed in `to`. In a segment a notice is a record whose sender is
//! [`crate::store::NOTICE_SENDER`]; its body is JSON: the public fields plus
//! `"to": [userId…]`, which is never sent to clients.

use serde_json::{Map, Value, json};

use crate::eventlog::Header;
use crate::ids::UserId;
use crate::store::Chat;

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    /// Recipients.
    pub to: Vec<UserId>,
    /// What clients receive as `notice` (always has `type`).
    pub public: Map<String, Value>,
}

fn sorted(mut v: Vec<UserId>) -> Vec<UserId> {
    v.sort_by_key(|u| u.to_string());
    v.dedup();
    v
}

impl Notice {
    fn new(public: Value, to: Vec<UserId>) -> Notice {
        let Value::Object(public) = public else {
            unreachable!("notice bodies are objects")
        };
        Notice { to: sorted(to), public }
    }

    /// Body as stored in the log.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut m = self.public.clone();
        m.insert("to".into(), json!(self.to));
        serde_json::to_vec(&Value::Object(m)).expect("serialisable")
    }

    /// Reads a stored body; `None` if damaged.
    pub fn parse(bytes: &[u8]) -> Option<Notice> {
        let Value::Object(mut m) = serde_json::from_slice(bytes).ok()? else {
            return None;
        };
        let to: Vec<UserId> = serde_json::from_value(m.remove("to")?).ok()?;
        m.get("type")?.as_str()?;
        Some(Notice { to, public: m })
    }

    pub fn kind(&self) -> &str {
        self.public.get("type").and_then(Value::as_str).unwrap_or("")
    }

    /// A group was created; sent to all its members.
    pub fn group_created(by: &UserId, c: &Chat) -> Notice {
        Notice::new(
            json!({
                "type": "group_created",
                "by": by,
                "owner": c.owner,
                "members": c.members,
                "version": c.version,
                "epoch": c.epoch,
            }),
            c.members.clone(),
        )
    }

    /// The group state changed; sent to the old and the new members. A user
    /// listed in `removed` gets nothing more from this group.
    pub fn group_state(by: &UserId, c: &Chat, added: &[UserId], removed: &[UserId]) -> Notice {
        let mut to = c.members.clone();
        to.extend_from_slice(removed);
        Notice::new(
            json!({
                "type": "group_state",
                "by": by,
                "owner": c.owner,
                "members": c.members,
                "version": c.version,
                "epoch": c.epoch,
                "added": sorted(added.to_vec()),
                "removed": sorted(removed.to_vec()),
            }),
            to,
        )
    }

    /// A member left; sent to the remaining members and the one who left.
    pub fn member_left(user: &UserId, c: &Chat) -> Notice {
        let mut to = c.members.clone();
        to.push(*user);
        Notice::new(
            json!({
                "type": "member_left",
                "userId": user,
                "members": c.members,
                "version": c.version,
                "epoch": c.epoch,
            }),
            to,
        )
    }

    /// `member_removed` (removed from the family) or `member_revoked`
    /// (identity revoked); sent to the group owner.
    pub fn member_event(kind: &str, user: &UserId, to: Vec<UserId>) -> Notice {
        Notice::new(json!({ "type": kind, "userId": user }), to)
    }

    /// An event was deleted for everyone; sent to the chat's members (the
    /// one who deleted it included, for their other devices).
    pub fn event_deleted(h: &Header, by: &UserId, to: Vec<UserId>) -> Notice {
        Notice::new(
            json!({
                "type": "event_deleted",
                "gseq": h.gseq,
                "senderId": h.sender,
                "msgId": h.msg,
                "by": by,
            }),
            to,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_hides_recipients() {
        let a = UserId([1; 16]);
        let b = UserId([2; 16]);
        let n = Notice::member_event("member_removed", &a, vec![b, b]);
        assert_eq!(n.to, vec![b]);
        let back = Notice::parse(&n.to_bytes()).unwrap();
        assert_eq!(back, n);
        assert!(!back.public.contains_key("to"));
        assert_eq!(back.kind(), "member_removed");
        assert!(Notice::parse(b"{}").is_none());
        assert!(Notice::parse(b"not json").is_none());
    }
}
