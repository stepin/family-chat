// Message text is plain text in M1. It is rendered as text nodes; only links
// with the schemes below become clickable. Nothing is ever inserted as HTML.

export type Segment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'link'; readonly text: string; readonly href: string };

export const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

// Candidates: explicit http(s) URLs, `www.` hosts, mailto: and tel: URIs, bare e-mail addresses.
const CANDIDATE =
  /\b(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|mailto:[^\s<>"]+|tel:\+?[\d\-().\s]{3,}\d|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;

// Punctuation that usually ends a sentence rather than the link.
const TRAILING = '.,;:!?…»"\']}';

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function trimTrailing(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const c = s.charAt(s.length - 1);
    // Keep a closing parenthesis paired inside the link (Wikipedia-style URLs).
    if (c === ')' && count(s, '(') >= count(s, ')')) break;
    if (c !== ')' && !TRAILING.includes(c)) break;
    s = s.slice(0, -1);
  }
  return s;
}

/** Returns a safe href for a link candidate, or null. */
export function safeHref(candidate: string): string | null {
  let href = candidate;
  if (/^www\./i.test(href)) href = `https://${href}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && href.includes('@')) href = `mailto:${href}`;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return null;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null;
  if (url.protocol === 'tel:') return `tel:${href.slice(4).replace(/[^\d+]/g, '')}`;
  return url.href;
}

/** Splits text into plain parts and links. Joining all `text` fields gives the input back. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    const raw = trimTrailing(m[0]);
    if (raw.length === 0) continue;
    const href = safeHref(raw);
    if (!href) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
