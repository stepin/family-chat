// Invitations in the UI: the `#invite=<code>` fragment of the page, and what a
// person pastes inside the installed app (the whole link, or just the code).

import { parseInviteFragment } from '@family-chat/core';

export interface ParsedInvite {
  /** Invitation code, 26 lowercase base32 characters. A secret until used. */
  readonly code: string;
  /** Server address (origin plus path) the link points to. */
  readonly serverUrl: string;
}

const CODE = /^[a-z2-7]{26}$/;

/** The server address a link belongs to: everything before the fragment, without a trailing slash and query. */
function serverOf(url: URL): string {
  const path = url.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Reads an invitation from pasted text: a full link (`https://…/#invite=…`),
 * a bare fragment (`#invite=…`) or the code alone. `fallbackServer` is used
 * when the text carries no address. Returns undefined for anything else.
 */
export function parseInviteInput(text: string, fallbackServer: string): ParsedInvite | undefined {
  const s = text.trim();
  if (s.length === 0 || s.length > 2048) return undefined;
  // The link may be surrounded by other words ("Вот приглашение: https://…").
  const link = /https?:\/\/[^\s<>"']+#[^\s<>"']*invite=[^\s<>"']+/i.exec(s);
  if (link) {
    let url: URL;
    try {
      url = new URL(link[0]);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const code = parseInviteFragment(url.hash);
    return code ? { code, serverUrl: serverOf(url) } : undefined;
  }
  const frag = /#?invite=([A-Za-z2-7]+)/i.exec(s);
  if (frag) {
    const code = parseInviteFragment(`invite=${frag[1]}`);
    return code ? { code, serverUrl: fallbackServer.replace(/\/+$/, '') } : undefined;
  }
  const bare = s.replace(/[\s-]/g, '').toLowerCase();
  return CODE.test(bare) ? { code: bare, serverUrl: fallbackServer.replace(/\/+$/, '') } : undefined;
}

/**
 * Reads the invitation from the current address and removes the fragment
 * from the address bar at once (the code is a secret until used).
 */
export function takeInviteFromLocation(loc: Location, hist: History): ParsedInvite | undefined {
  if (!loc.hash) return undefined;
  const code = parseInviteFragment(loc.hash);
  if (/invite=/i.test(loc.hash)) {
    hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`);
  }
  if (!code) return undefined;
  return { code, serverUrl: serverOf(new URL(loc.href.split('#')[0] ?? loc.href)) };
}

/** The address the page was opened from, as a server address. */
export function pageServerUrl(loc: Location): string {
  return serverOf(new URL(loc.href.split('#')[0] ?? loc.href));
}

/** The link to copy for the installed app: same server, same code. */
export function inviteLinkFor(invite: ParsedInvite): string {
  return `${invite.serverUrl}/#invite=${invite.code}`;
}

/** The same server address, ignoring case of the host and a trailing slash. */
export function sameServer(a: string, b: string): boolean {
  const norm = (s: string): string => {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return s.replace(/\/+$/, '').toLowerCase();
    }
  };
  return norm(a) === norm(b);
}
