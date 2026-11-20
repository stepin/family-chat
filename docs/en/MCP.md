# AI assistants (MCP)

You can connect an AI assistant, Claude for example, to the family chat. It connects over the
[MCP](https://modelcontextprotocol.io/) protocol and does what a person does in the app: reads and writes messages,
runs groups, sends files. All of it is built into `fcd`: there is no separate program, plug-in or second process.

## Trust first

Normally the family's server cannot read the chats: only the devices hold the keys. Connecting an AI assistant is a
deliberate exception.

- To act for an identity, **the server keeps its key**. It can read that identity's chats and write in its name. So
  can whoever runs the server or gets a copy of the data folder.
- This is true for connected identities only. Chats between the other members stay closed to the server, as before.
- The people it talks to can see it: the app shows a note in the profile of a member whose identity an assistant is
  connected to.
- Message texts reach the AI assistant and whoever provides it. What happens to them there is decided by its terms,
  not by Family Chat.

More: [security](SECURITY-MODEL.md#ai-assistants-mcp).

## Two kinds of connection

| | A helper with its own identity | My identity |
|---|---|---|
| Who creates it | a family administrator | any member, for themselves |
| Whose name it writes in | its own: it has a name and a profile | yours: relatives cannot tell its messages from yours |
| What it sees | its own chats: what people write to it and in groups it was added to | all your chats in this family, while the server keeps them |
| The key | made on the server and existing nowhere else | the app sends the key of your identity to the server (the same as the 24 words) |
| Deleting it | the helper is removed from the family | the server erases the key, you stay in the family |

A helper with its own identity is an ordinary family member. You can write to it, add it to a group, and it can
create a group of its own. It is the safe default: it sees only what it was shown.

There can be several connections, each with its own token and its own permissions. The limit is 50 per family.

## Connecting

1. In the app: **Settings → AI assistants**.
2. An administrator: type a name and press "Create a helper". Any member: "Connect my identity…", read the warning
   and confirm.
3. The app shows the **address** and the **token**. The token is shown once: the app does not keep it. Lost it? Press
   "New token"; the old one stops working at once.
4. Put the address and the token into the AI assistant's settings.

The address is `https://<server>/mcp`; for a family at `/f/<id>` it is `https://<server>/f/<id>/mcp`.

Claude Code:

```sh
claude mcp add --transport http family-chat https://chat.example.org/mcp \
  --header "Authorization: Bearer fcm_…"
```

Clients with a settings file (the field may be named differently; see the client's documentation):

```json
{
  "mcpServers": {
    "family-chat": {
      "type": "http",
      "url": "https://chat.example.org/mcp",
      "headers": { "Authorization": "Bearer fcm_…" }
    }
  }
}
```

You need a client that speaks MCP over HTTP ("Streamable HTTP") and lets you set the `Authorization` header. Signing
in with OAuth is not supported ([TODOS.md](../../TODOS.md)). There is no local program for stdio: the assistant talks
to the family's server over the network, as the app does.

A token works without a password. Keep it like a password: do not paste it into the chat with the assistant or into
shared files. If it ends up in the wrong place, delete the connection or issue a new token.

## What is allowed

A person sets the permissions in the app, for each connection separately. They cannot be changed through MCP: there
is no tool for it.

| Level | What it gives | By default |
|---|---|---|
| Read (`read`) | chats, messages, the family list, search, waiting for new messages | on |
| Write (`write`) | messages, edits, reactions, stickers, groups, the profile, "delete for me" | on |
| Files (`files`) | sending and receiving files and photos, the avatar | off |
| Administration (`admin`) | invitations and the server's numbers; works only if the identity is a family administrator | off |
| Irreversible (`destructive`) | "delete for everyone"; together with administration, removing members | off |

The assistant's tool list holds only the tools of the levels that are on. Calling one that is off returns the error
`level_off` with a note on where to switch it on.

## Tools

A chat is named by its id from `chats_list`, or by a member's id from `members_list` (the direct chat with them; your
own id is Saved Messages). A message is named by its number from `messages_list`.

| Tool | Level | What it does |
|---|---|---|
| `whoami` | read | who the connection acts as, its permissions, the family's name, the server's limits |
| `members_list` | read | the family's members |
| `member_avatar_get` | read | a member's avatar |
| `chats_list` | read | chats, each with its last message |
| `messages_list` | read | messages of a chat with edits, reactions and deletions applied |
| `messages_search` | read | search in texts and file names |
| `events_wait` | read | waits for something new: a message, an edit, a reaction, a deletion, a group change |
| `group_info` | read | a group's name, owner and members |
| `stickers_list` | read | the family's sticker packs |
| `message_send` | write | text, a reply, a location |
| `message_edit` | write | editing its own message |
| `message_react` | write | a reaction, or taking one back |
| `message_delete` | write | "delete for me"; `for_everyone` needs the irreversible level |
| `message_forward` | write | forwarding to another chat (with files it needs the files level) |
| `sticker_send` | write | a sticker from a family pack |
| `profile_update` | write | name and gender, removing the avatar |
| `group_create` | write | a new group |
| `group_rename`, `group_members_add`, `group_members_remove`, `group_transfer` | write | for the owner of a group |
| `group_leave` | write | leaving a group; its owner hands it over first |
| `file_send` | files | sending a file or a photo |
| `file_get` | files | taking a file |
| `file_upload_start` | files | a one-time link for a large file |
| `profile_avatar_set` | files | the avatar |
| `invite_create`, `invites_list`, `invite_delete` | administration | invitations |
| `server_stats` | administration | members, chats, disk space |
| `member_remove` | administration and irreversible | removing a member |

Every tool has a description and a schema of its arguments: the assistant gets them itself with `tools/list`.

### New messages

The server never writes to the assistant first. To learn what is new, the assistant calls `events_wait`: the request
waits up to 50 seconds (25 by default) and returns events and a cursor; the cursor goes into the next call. Without a
cursor the call waits for what happens from that moment on. What the connection itself sent is not returned.

The assistant answers only while its session is open and it calls `events_wait` itself. Answering on its own, with
no session open, is not there yet ([TODOS.md](../../TODOS.md)).

### Files

- Up to 1 MB a file travels inside the call: `file_send` takes it in base64, `file_get` returns a picture as a
  picture, text as text and anything else in base64.
- Larger ones: `file_upload_start` gives a one-time link, the file is sent to it with `PUT`, then `file_send` with the
  `upload` value it returned. `file_get` hands a large file out as a link too.
- A link `…/mcp/files/<code>` works once, for 10 minutes, without a token: the code is the secret. One connection
  holds at most four unused upload links at a time. The size limit is the server's `max_file_mb`.
- Photos (JPEG, PNG, WebP, GIF) are recognised by their content. Before sending, their metadata is removed: where and
  when the picture was taken, the camera model, comments. The rotation of the shot is kept. `original: true` sends
  the file as it is.
- Pictures are not made smaller and get no thumbnail: the server does not decode images. People see a photo once it
  has downloaded.

## What the assistant cannot do

The list is deliberate. Every "no" is written down in `server/src/mcp/coverage.rs` next to its reason, and a test
makes sure a new feature of the app gets either a tool or a reason.

- **Create, move or revoke an identity, or see the 24 words.** A person does that in the app: the words never pass
  through a model.
- **Manage connections and permissions.** Only in the app.
- **Read what the server does not have.** The assistant sees the chats within the retention period
  (`retention_days`); it has no archive on a device.
- **Read other people's chats.** Only the chats of its own identity. In a group it was added to "without earlier
  messages", the earlier ones are not visible.
- **Voice messages.** An audio file is sent as an ordinary file.
- **Make sticker packs.** They are made in the app; the assistant sends stickers from the ready ones.
- **Notifications.** They are for devices with a screen.

## Server settings

MCP is on by default. To switch it off: `--mcp false`, `FCD_MCP=false` or `mcp = false` in `config.toml`, then
restart. `/mcp` and the screen in the app then say that connecting is switched off; existing connections stay on
disk and work again when it is switched back on. While there is no connection, the server keeps nobody's keys.

Behind a reverse proxy:

- `events_wait` requests last up to 50 seconds: the proxy's response timeout must be longer (as for the app).
- The proxy must pass `Host` and `X-Forwarded-Proto` (or `X-Forwarded-Host`): the server builds the one-time file
  links from them.
- A request body at `/mcp` is up to 2 MB; a file sent to a link is up to `max_file_mb`.

The keys of connections are in the data folder, in `mcp/`. A backup of the data folder now holds the keys of the
connected identities: keep it as carefully as the server itself.

## For developers

- Transport: MCP over HTTP, one `POST` per message, one JSON answer. No streams (SSE), no sessions; `GET` and
  `DELETE` answer 405.
- Revisions: `2026-07-28` (no handshake; the version is in every request and in the headers `MCP-Protocol-Version`,
  `Mcp-Method`, `Mcp-Name`) and the earlier `2025-11-25`, `2025-06-18`, `2025-03-26` (with `initialize`).
- Signing in: `Authorization: Bearer <token>`. The server keeps only the SHA-256 of a token. A wrong token: 401; ten
  wrong ones a minute from one address: 429 (the counter is shared with wrong codes, see the
  [API](../API.md#15-ограничение-частоты)). The identity was removed or revoked: 403 `identity_gone`. MCP switched
  off: 404 `mcp_disabled`.
- A request with the `Origin` header of another site is refused (403 `bad_origin`); `/mcp` sends no CORS headers.
- A tool's error comes back inside the result (`isError: true`) as `{"error": "<code>", "message": "…"}`: the model
  reads the reason and corrects itself. An unknown tool is the JSON-RPC error `-32602`.
- The server acts for an identity with a second implementation of the protocol, in Rust (`server/src/client/`),
  checked against `docs/vectors/`. A protocol change changes both implementations and the vectors
  ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
- The app's requests for managing connections: [API, section 10b](../API.md#10b-подключения-mcp) (in Russian).

## If it does not work

| What you see | What it means |
|---|---|
| 401 | the token is wrong or was replaced. Issue a new one in the app |
| 403 `identity_gone` | the connection's identity was removed from the family or revoked its key |
| 404 `mcp_disabled` | MCP is switched off in the server's settings |
| 404 at a file link | the link was used, expired (10 minutes) or the server was restarted |
| 429 | too many wrong tokens or codes from this address; wait a minute |
| `level_off` | the level is off: switch it on in the app, "Settings → AI assistants" |
| `need_key` for a group | the identity has no key of the group's current epoch: the group's owner has to add it again |
| a file link with `http://` instead of `https://` | the proxy does not pass `X-Forwarded-Proto` |
