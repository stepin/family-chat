//! Is MCP first class? Every door of the app's API is listed here with the
//! tools that open it for an assistant, or with the reason an assistant does
//! not get it. A test reads the router and fails when a route is missing
//! from this list, so a new feature of the app cannot quietly stay out of
//! MCP: someone has to give it a tool or write down why not.

/// What an assistant gets for one route of the API.
pub enum Via {
    /// These tools do it.
    Tools(&'static [&'static str]),
    /// Not offered, and why.
    No(&'static str),
}

const PERSON: &str = "an identity is created, moved to a device or revoked by its person, in the app: \
                      the 24 words never pass through a model";
const DEVICE: &str = "notifications are for a device with a screen; an assistant waits with events_wait";
const PACKS: &str = "sticker packs are made in the app, where pictures are converted; an assistant sends stickers";
const CONNECTIONS: &str = "connections and their access levels are managed by a person in the app, never through MCP";

pub const COVERAGE: &[(&str, Via)] = &[
    ("GET /v1/hello", Via::Tools(&["whoami"])),
    ("POST /v1/join", Via::No(PERSON)),
    ("POST /v1/auth/challenge", Via::No(PERSON)),
    ("POST /v1/auth/device", Via::No(PERSON)),
    ("POST /v1/revoke", Via::No(PERSON)),
    (
        "POST /v1/invites/check",
        Via::No("for someone who is not in the family yet"),
    ),
    ("GET /v1/users", Via::Tools(&["members_list"])),
    ("GET /v1/me", Via::Tools(&["whoami"])),
    ("PUT /v1/me/profile", Via::Tools(&["profile_update"])),
    ("PUT /v1/me/avatar", Via::Tools(&["profile_avatar_set"])),
    ("GET /v1/users/{id}/avatar/{sha}", Via::Tools(&["member_avatar_get"])),
    ("PUT /v1/me/push", Via::No(DEVICE)),
    ("DELETE /v1/me/push", Via::No(DEVICE)),
    ("GET /v1/chats", Via::Tools(&["chats_list"])),
    ("POST /v1/chats", Via::Tools(&["group_create"])),
    (
        "POST /v1/chats/{id}/events",
        Via::Tools(&[
            "message_send",
            "message_edit",
            "message_react",
            "message_delete",
            "message_forward",
            "file_send",
            "sticker_send",
        ]),
    ),
    (
        "GET /v1/chats/{id}/events",
        Via::Tools(&["messages_list", "messages_search"]),
    ),
    ("DELETE /v1/chats/{id}/events/{gseq}", Via::Tools(&["message_delete"])),
    (
        "PUT /v1/chats/{id}/state",
        Via::Tools(&[
            "group_rename",
            "group_members_add",
            "group_members_remove",
            "group_transfer",
        ]),
    ),
    ("GET /v1/chats/{id}/state/{version}", Via::Tools(&["group_info"])),
    ("POST /v1/chats/{id}/leave", Via::Tools(&["group_leave"])),
    // The server opens the keys sealed to the connection's identity itself.
    ("GET /v1/keys", Via::Tools(&["group_info", "messages_list"])),
    ("GET /v1/blobs/{id}", Via::Tools(&["file_get"])),
    ("DELETE /v1/blobs/{id}", Via::Tools(&["message_delete"])),
    (
        "PUT /v1/blobs/{id}/{part}",
        Via::Tools(&["file_send", "file_upload_start"]),
    ),
    ("GET /v1/blobs/{id}/{part}", Via::Tools(&["file_get"])),
    ("GET /v1/events", Via::Tools(&["events_wait"])),
    ("GET /v1/packs", Via::Tools(&["stickers_list"])),
    ("GET /v1/packs/{id}", Via::Tools(&["stickers_list"])),
    ("PUT /v1/packs/{id}", Via::No(PACKS)),
    ("DELETE /v1/packs/{id}", Via::No(PACKS)),
    (
        "GET /v1/packs/{id}/files/{hash}",
        Via::No("a sticker is named by its emoji; the picture itself is for people"),
    ),
    ("PUT /v1/packs/{id}/files/{hash}", Via::No(PACKS)),
    ("GET /v1/telegram/sets/{name}", Via::No(PACKS)),
    ("GET /v1/telegram/sets/{name}/files/{id}", Via::No(PACKS)),
    ("POST /v1/admin/invites", Via::Tools(&["invite_create"])),
    ("GET /v1/admin/invites", Via::Tools(&["invites_list"])),
    ("DELETE /v1/admin/invites/{id}", Via::Tools(&["invite_delete"])),
    ("GET /v1/admin/users", Via::Tools(&["members_list"])),
    ("DELETE /v1/admin/users/{id}", Via::Tools(&["member_remove"])),
    ("GET /v1/admin/stats", Via::Tools(&["server_stats"])),
    ("GET /v1/mcp", Via::No(CONNECTIONS)),
    ("POST /v1/mcp", Via::No(CONNECTIONS)),
    ("PUT /v1/mcp/{id}", Via::No(CONNECTIONS)),
    ("DELETE /v1/mcp/{id}", Via::No(CONNECTIONS)),
    ("POST /v1/mcp/{id}/token", Via::No(CONNECTIONS)),
    ("GET /v1/check/wait", Via::No(DEVICE)),
    ("GET /v1/check/push", Via::No(DEVICE)),
    ("POST /v1/check/push", Via::No(DEVICE)),
];

/// What the app does on the device, without a route of its own.
pub const ON_DEVICE: &[(&str, Via)] = &[
    ("search in messages", Via::Tools(&["messages_search"])),
    ("delete for me", Via::Tools(&["message_delete"])),
    ("send a location", Via::Tools(&["message_send"])),
    ("reply and forward", Via::Tools(&["message_send", "message_forward"])),
    (
        "voice messages",
        Via::No(
            "recording needs a microphone and drawing the waveform needs an audio decoder; an audio file is sent with file_send",
        ),
    ),
    (
        "picture previews and resizing",
        Via::No("the server does not decode pictures; they are sent whole, without a thumbnail (TODOS.md)"),
    ),
    (
        "export and import of the archive",
        Via::No("an archive is the history kept on a person's device; a connection reads what the server keeps"),
    ),
    ("showing the 24 words", Via::No(PERSON)),
    (
        "several families in one app",
        Via::No("a connection belongs to one family; another family gets its own"),
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools;

    /// `METHOD path` of every route the family router serves, read from its source.
    fn routes() -> Vec<String> {
        let src = include_str!("../app.rs");
        let body = &src[src.find("pub fn router(").expect("router")..];
        let body = &body[..body.find(".method_not_allowed_fallback").expect("end of routes")];
        let mut out = Vec::new();
        for part in body.split(".route(").skip(1) {
            let path = part.split('"').nth(1).expect("a path literal");
            // The handlers of this route: everything up to the next `.route(`.
            for method in ["get", "post", "put", "delete"] {
                let direct = part.contains(&format!(" {method}(")) || part.contains(&format!("\n{method}("));
                let chained = part.contains(&format!(".{method}("));
                if direct
                    || chained
                    || part
                        .split(',')
                        .nth(1)
                        .is_some_and(|h| h.trim_start().starts_with(&format!("{method}(")))
                {
                    out.push(format!("{} {path}", method.to_uppercase()));
                }
            }
        }
        out
    }

    #[test]
    fn every_route_of_the_api_has_a_tool_or_a_reason() {
        let routes = routes();
        assert!(routes.len() > 40, "the router was not read: {routes:?}");
        let listed: Vec<&str> = COVERAGE.iter().map(|(r, _)| *r).collect();
        let endpoint = |r: &str| r.ends_with(" /mcp") || r.contains(" /mcp/files/");
        let missing: Vec<&String> = routes
            .iter()
            .filter(|r| !endpoint(r) && !listed.contains(&r.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "routes without a decision for MCP (give each a tool, or a reason in mcp/coverage.rs): {missing:?}"
        );
        let stale: Vec<&&str> = listed.iter().filter(|r| !routes.iter().any(|x| x == **r)).collect();
        assert!(stale.is_empty(), "listed in mcp/coverage.rs but not served: {stale:?}");
    }

    #[test]
    fn every_tool_named_exists_and_every_tool_is_named() {
        let mut named = std::collections::HashSet::new();
        for (what, via) in COVERAGE.iter().chain(ON_DEVICE) {
            match via {
                Via::Tools(list) => {
                    assert!(!list.is_empty(), "{what}");
                    for t in *list {
                        assert!(tools::find(t).is_some(), "{what}: no tool {t}");
                        named.insert(*t);
                    }
                }
                Via::No(reason) => assert!(reason.len() > 20, "{what}: say why"),
            }
        }
        // A tool nobody lists would be a capability the app does not have: fine, but say so here.
        let extra: Vec<&str> = tools::tools()
            .iter()
            .map(|t| t.name)
            .filter(|n| !named.contains(n))
            .collect();
        assert!(extra.is_empty(), "tools not tied to anything the app does: {extra:?}");
    }
}
