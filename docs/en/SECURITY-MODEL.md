# Security

This page explains in plain words what Family Chat protects and what it does not. The exact formats and
cryptography are in the [protocol](../PROTOCOL.md) and the [server API](../API.md) (both in Russian). How to report a
vulnerability: [SECURITY.md](../../SECURITY.md).

Most important: Family Chat uses its own cryptographic protocol, and it **has not been independently audited**.

## In short

- Message text, photos, files, voice messages, places, reactions and group names are encrypted on the sender's
  device. Neither the server nor its administrator has the keys.
- The server knows who is in the family, who talks to whom, when and how much. It could not deliver messages
  otherwise.
- The app comes from the server whose address you opened it from, and whoever runs that server is a trusted party:
  if they want to, they can technically replace the app and get the keys. Usually that is your family's server.

## Several families on one server

Families on one `fcd` are meant for families of one server owner that trust each other.

- **Separate:** each family's serverId, device tokens, data (messages, members, groups, files, stickers), join codes
  and administrators. The server gives a family's data only to its members, at its address.
- **Shared by every family of the server:** one process and one disk (one storage quota), the VAPID notification
  key, the Telegram token, the limit on wrong codes. In the browser all families of one server open from one origin:
  one IndexedDB database on the device (as for all families on a device today) and one service worker.
- **Identity keys are shared** when a person joins a second family with the same identity (the default in “Add
  family”): the same userId, fingerprint and recovery words, and both families can tell it is one person.
- Whoever has the server admin code can create families, and `fcd families list` on the server shows their names.
  The server's administrator, as with one family, sees the metadata of every family and could technically replace
  the app.

The word “isolated” does not apply to families of one server without these caveats. A fully separate family: a
second `fcd` with its own data folder at its own address.

## What the server sees

The server (and anyone with a copy of its data folder) sees:

- the family members: public keys, **profile names, photos and gender** (signed, but not encrypted; the gender, M or
  F, used for wording such as "created the group" in Russian);
- who is in which direct chat and group (the list is needed for delivery), who invited whom;
- when each message was sent, from which device, its approximate size (sizes are padded to 256 bytes);
- the size of files and when they were uploaded;
- devices' push subscription addresses and the IP addresses requests come from;
- sticker packs in full: they are stored **without encryption** and are visible to the whole family and the server.

The server does not see: message text and content, files, group names and signed membership, reactions, edits,
coordinates, file names. These are ciphertext, and the server has no keys for them.

## What the server administrator can do

- Issue invitations and disconnect members. A disconnected member stops receiving new messages at once; the group
  owner's app removes them from its groups and changes the group key as soon as it is online.
- See the metadata listed above, delete data or switch the server off. Family Chat does not protect availability.
- Set the retention (7 to 90 days) and switch notifications off.
- **Replace the app**: it opens from their server. The app is loaded from the server on every update; changed
  code could read the keys on the device. That is why the "Family and server" screen always shows a line saying
  that the app was loaded from the family server and whoever runs it can technically replace it. For a family the
  administrator is usually one of the parents, and that is acceptable: they are a trusted party.

What the administrator cannot do without replacing the app: read messages, write in someone else's name (messages
are signed with the author's key), quietly add themselves to someone's group (group membership is signed by its
owner, and the app shows when the server's delivery list does not match it).

## Other family members

The server gives everyone only their own chats. Other members do not see your direct chats, groups they are not in,
or whom you talk to. A new group member sees the group history still on the server (at most the retention period),
unless the owner added them "without the earlier history".

## Authenticity

Every message is signed with the author's key. A person's identifier is derived from their key, so a key cannot be
swapped unnoticed: the identifier and the fingerprint would change too. Fingerprints (30 digits) can be compared in
person or by phone and marked as checked. If the key of someone you know changes, the app warns you.

## On the device

- Keys and all history are stored in the browser on the device (IndexedDB) **without extra encryption**: only the
  screen lock and the system protect them. Whoever gets an unlocked phone or browser profile gets the history and
  can write in your name. There is no app lock with a code yet.
- The 24 recovery words are the whole identity key. Whoever knows them can write in your name and read what is on
  the server.
- The archive file is encrypted with a key derived from your identity: it cannot be read without your 24 words.
- A lost phone stays connected to the family until you revoke your key or the administrator disconnects you.

## What Family Chat does not promise

- **Forward secrecy.** Chat keys do not change with every message. Whoever got the keys from a device can read
  everything on the server (at most the retention period) and that person's archives.
- **Metadata protection** from the server administrator: who, to whom, when and how much.
- **Availability.** The server can be switched off and data deleted.
- **Protection from app replacement** by the server administrator if the app is loaded from their server.
- **Protection from malware** on the phone or computer.
- **Anonymity.** The Apple, Google and Mozilla push services learn when notifications happen and the server address
  (not content or names: the payload is encrypted for the browser). The internet provider sees that you connect to
  the server. The administrator can switch notifications off entirely; then the server contacts no push service (and no outside
  address at all unless a Telegram token is set).
- **Telegram**, when sticker sets are loaded by link, sees the server's address and the names of the sets members
  load. The server keeps the bot token; members never see it; without a token the server never contacts Telegram.

## What leaves the device besides messages

- "Open in maps" on a place hands the coordinates to the map service you open. The place card in the app loads
  nothing.
- "Send original" sends a photo as is, with the location and time of shooting inside the file (recipients will see
  them). A normal send makes the photo smaller and drops this data.
- The app uses no analytics and contacts no third-party sites. Diagnostics stay on the device until you copy the
  report yourself.

## Where the app comes from

The app opens only from your own server: the project site does not carry it, the site and the server are not
connected. When you open the app you trust whoever runs the server whose address you opened it from. Usually that is
your family's administrator. If the app of one server was used to add a family on another server, the app still
comes from the first server, and its owner stays a trusted party.

## More

- [Protocol](../PROTOCOL.md): identity, keys of direct chats and groups, event format, attachments, archive, test
  vectors (in Russian).
- [Server API](../API.md): what the server accepts and returns, limits, security headers (in Russian).
