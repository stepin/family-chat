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
- Whoever runs the server also serves the app. If they want to, they can technically replace the app and get the
  keys. Only an app loaded from another address protects against that.

## What the server sees

The server (and anyone with a copy of its data folder) sees:

- the family members: public keys, **profile names and photos** (signed, but not encrypted);
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
- **Replace the app** if it is opened from their server. The app is loaded from the server on every update; changed
  code could read the keys on the device. That is why the "Family and server" screen always shows a line saying
  that the app was loaded from the family server and whoever runs it can technically replace it. For a family the
  administrator is usually one of the parents, and that is acceptable. Those who want more open the app from the
  project's address: then the server administrator sees only ciphertext, and the trust moves to whoever publishes
  the project site.

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
  the server. The administrator can switch notifications off entirely; then the server contacts no outside address.

## What leaves the device besides messages

- "Open in maps" on a place hands the coordinates to the map service you open. The place card in the app loads
  nothing.
- "Send original" sends a photo as is, with the location and time of shooting inside the file (recipients will see
  them). A normal send makes the photo smaller and drops this data.
- The app uses no analytics and contacts no third-party sites. Diagnostics stay on the device until you copy the
  report yourself.

## The app from the project address

The same web client is published on the project site (see "The app from the project address" on the home page). It
is built from the same source and connects to your server directly. Then your server's administrator cannot
replace the app, but you trust whoever publishes the site instead: a replaced app there would affect everyone who
uses it. That app has its own browser storage, separate from the app opened from your server's address.

## More

- [Protocol](../PROTOCOL.md): identity, keys of direct chats and groups, event format, attachments, archive, test
  vectors (in Russian).
- [Server API](../API.md): what the server accepts and returns, limits, security headers (in Russian).
