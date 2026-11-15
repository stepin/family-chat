# FAQ and troubleshooting

Common questions of family members and of the administrator. If the answer is not here, the app has “Settings”,
“Diagnostics”: a log and a button to copy a report (it contains no message text, words or
keys).

## For everyone

### Notifications do not arrive

In order:

1. **iPhone:** notifications work only for the app on the home screen and only on iOS 16.4 or newer. A Safari tab
   gets none. How to install: [family guide](FAMILY.md#iphone-add-to-home-screen).
2. Notifications are enabled in the app itself: “Settings”, “Notifications”. It also shows whether they are blocked
   in the phone or browser settings, and how to fix that.
3. Do Not Disturb or a Focus mode on the phone hides notifications: check that it is off or allows Family Chat.
4. One device gets notifications from one family only. With several families, “Settings”, “Notifications” shows
   which one; you can pick another there.
5. The administrator has not switched notifications off on the server (`push = false`). Then the app says that
   notifications are off on the family server.
6. The server needs internet access to the Apple, Google and Mozilla push services. If an iPhone gets nothing at
   all, the administrator should put their own contact into `config.toml`: `push_subject = "mailto:address"` (Apple
   wants a contact that looks real), then restart the server.

You can test delivery on your server's `/server/` page: "send a test" (the server must run with `--m0`, and the
administrator code is needed). More: [installation](ADMIN.md#the-server-check-page-server).

### I lost my 24 words

If the app still opens on at least one device, nothing is lost: “Settings”, “Recovery words” shows them
again. Write them down and check.

With no device and no words, the old identity cannot come back: the key exists only in those words. Ask the
administrator for a new invitation and join as a new person. Relatives will see a new identity and can link it to
the old one in your contact. The old history stays with your relatives, but you will not have it: an archive opens
only with the identity that created it. So keep both the words and the archive.

### My phone was lost or stolen

Revoke your key: from another device in “Settings”, “Security”, or on the sign-in screen with “Restore with my words” and then “Lost your phone? Revoke your key with your words”. Details: [family guide](FAMILY.md#if-the-phone-is-lost-or-someone-saw-the-words).

### Messages older than 90 days are missing on the new phone

That is expected: the server keeps history only for the retention period, older history lives only on your
devices. Move an archive from the old device: [message archive](FAMILY.md#message-archive).

### Nothing is sent, "no connection since …"

Messages are not lost: they wait in a queue and go out when the connection is back. If "no connection" stays while
the internet works, the server is unreachable or its proxy cuts long requests (see below, for the administrator).

### "Login invalid"

Press “Sign in again”: the app signs in again with your key, no words needed. If the app says you
were disconnected from the family, the administrator disconnected you; ask for a new invitation.

### Message times look odd or the phone clock is wrong

The server sets the order and time of messages; the phone clock does not affect them. But if the phone clock is off
by years, the browser may refuse HTTPS (the certificate "is not yet valid" or "has expired"). Turn on automatic time
on the phone. The `/server/` page shows how many seconds the device and server clocks differ.

### "This invitation has already been used"

An invitation works once. If someone else joined with it (for example, you forwarded the link), tell the
administrator: they see who joined and can disconnect that person. Ask for a new invitation.

## For the administrator

### The server is running out of space

The app says the family server is running out of space, and the server refuses new messages and files. This is the
`min_free_mb` threshold (100 MB of free disk space by default). What to do:

- free some disk space;
- shorten the retention (`retention_days` in `config.toml`, 7 to 90) and restart the server: the extra days are
  deleted at start;
- lower the file size limit (`max_file_mb`).

Used and free space are shown in the app: “Settings”, “Family and server”.

### The connection keeps dropping behind a proxy or tunnel

The app waits for new messages in one request for up to 30 seconds. If the proxy cuts requests earlier, the status
flips between connecting and connected, and messages arrive late. Check on the `/server/` page ("check the long
request", server with `--m0`) and raise the proxy's response timeout:

- nginx: `proxy_read_timeout 90s;`
- Caddy: no limit by default;
- cloud tunnels and NAS proxies: look for a timeout setting.

### The proxy holds answers back or refuses files

- Sending photos or files fails: the proxy limits the request body size. It must allow at least 5 MB (nginx:
  `client_max_body_size 8m;`).
- If the proxy buffers answers and requests, turn that off for Family Chat (nginx: `proxy_buffering off;` and
  `proxy_request_buffering off;`). Example: [installation](ADMIN.md#reverse-proxy).

### The server does not start

The server writes the reason to its log (in English or Russian, see the language rule in the [installation guide](ADMIN.md)). Common ones:

- “is already in use by another fcd process”: a server already runs on this folder;
- “could not bind to”: another program uses the port, choose another `--port`;
- “was created by a newer fcd”: a newer server opened the folder; run the newer version or restore a backup;
- an error in `config.toml`: the server names the line.

### Moving the server to another computer

Stop the server, copy the whole data folder, start `fcd` in the new place with this folder. If the server address
(domain) stays the same, relatives need to do nothing.

### Can it work without HTTPS

Only on the same computer, at `http://localhost:8787/`. Phones and other computers need HTTPS: without it the
browser does not let the app encrypt or install.

### Why are the recovery words English

It is the standard BIP-39 list of 2048 words: they are easy to write down without mistakes, and no two words share
their first four letters.
