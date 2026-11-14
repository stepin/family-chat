import { StorageError } from './errors.ts';

const SEGMENT = /^[a-z0-9.-]{1,64}$/;

/** Splits and validates a storage path. Returns segments and whether it denotes a collection. */
export function parsePath(path: string): { segments: string[]; isDir: boolean } {
  const isDir = path === '' || path.endsWith('/');
  const body = isDir ? path.slice(0, -1) : path;
  const segments = body === '' ? [] : body.split('/');
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') {
      throw new StorageError('Fatal', `invalid path segment ${JSON.stringify(s)}`, {
        reason: 'invalid-path',
      });
    }
  }
  return { segments, isDir };
}

/** Normalises a root URL so that it ends with `/` and carries no credentials, query or fragment. */
export function normalizeRoot(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new TypeError(`unsupported protocol ${u.protocol}`);
  }
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

/** Builds a request URL from validated segments only (never from listing hrefs, section 6.10). */
export function resolvePath(root: URL, path: string): URL {
  const { segments, isDir } = parsePath(path);
  const tail = segments.join('/') + (isDir && segments.length > 0 ? '/' : '');
  return new URL(root.pathname + tail, root);
}

/** Path part of an href (absolute URL or absolute path), percent-decoded per segment. */
export function hrefPath(href: string, base: URL): string {
  let pathname: string;
  try {
    pathname = new URL(href.trim(), base).pathname;
  } catch {
    pathname = href.trim();
  }
  return pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

export function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}
