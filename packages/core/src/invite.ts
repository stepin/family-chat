// Invitation links: `https://<server>/#invite=<code>` (docs/API.md 3, POST /v1/join).
// The server never sees the fragment; the client reads it and then removes it
// from the address bar (that part is the UI's job).

/** Builds the link a new member opens. */
export function inviteLink(serverUrl: string, code: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/#invite=${encodeURIComponent(code)}`;
}

/** Reads the invitation code from a URL fragment (`#invite=…`), or undefined. */
export function parseInviteFragment(hash: string): string | undefined {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    const [k, v] = part.split('=', 2);
    if (k === 'invite' && v) {
      const code = decodeURIComponent(v).trim().toLowerCase();
      return /^[a-z2-7]{26}$/.test(code) ? code : undefined;
    }
  }
  return undefined;
}
