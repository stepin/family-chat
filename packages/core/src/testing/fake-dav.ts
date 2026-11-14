/**
 * In-memory WebDAV server exposed as a `fetch` function, for unit tests of
 * WebDavStorage. Quirk switches emulate behaviours seen on real servers.
 */
export interface FakeDavQuirks {
  /** Prefix prepended to hrefs in listings (proxy rewriting paths). */
  hrefPrefix?: string;
  /** Emit absolute URLs instead of absolute paths in hrefs. */
  absoluteHrefs?: boolean;
  /** Answer PROPFIND with 200 and an HTML page (captive portal). */
  htmlInsteadOfListing?: boolean;
  /** Cut the listing body in the middle. */
  truncateListing?: boolean;
  /** Answer DELETE of collections with 207 and a 423 member. */
  multiStatusDelete?: boolean;
  /** Redirect requests to collections without trailing slash. */
  redirectNoSlash?: boolean;
  /** Fixed Date header value; omitted when null. */
  date?: string | null;
}

interface Node {
  dir: boolean;
  data?: Uint8Array;
  mtime: Date;
}

export class FakeDav {
  readonly files = new Map<string, Node>();
  readonly log: { method: string; path: string; auth: string | null }[] = [];
  quirks: FakeDavQuirks = {};
  /** Expected `Authorization` header; requests without it get 401. */
  auth = 'Basic ' + btoa('fc:secret');

  constructor(readonly origin = 'https://dav.test') {
    this.files.set('/', { dir: true, mtime: new Date() });
  }

  mkdirp(path: string): void {
    let cur = '';
    for (const seg of path.split('/').filter(Boolean)) {
      cur += `/${seg}`;
      if (!this.files.has(`${cur}/`)) this.files.set(`${cur}/`, { dir: true, mtime: new Date() });
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    this.log.push({ method, path: url.pathname, auth: headers.get('authorization') });
    const h = new Headers();
    const date = this.quirks.date === undefined ? new Date().toUTCString() : this.quirks.date;
    if (date !== null) h.set('Date', date);
    const reply = (status: number, body?: string | Uint8Array, type?: string): Response => {
      if (type) h.set('Content-Type', type);
      return new Response(status === 204 || status === 201 ? null : (body ?? null) as BodyInit | null, { status, headers: h });
    };
    if (headers.get('authorization') !== this.auth) return reply(401, 'Unauthorized', 'text/plain');
    let path = decodeURIComponent(url.pathname);
    if (this.quirks.redirectNoSlash && !path.endsWith('/') && this.files.get(`${path}/`)?.dir) {
      h.set('Location', `${url.pathname}/`);
      return reply(301);
    }
    const parentOf = (p: string): string => {
      const t = p.endsWith('/') ? p.slice(0, -1) : p;
      return t.slice(0, t.lastIndexOf('/') + 1);
    };
    const lookup = (p: string): [string, Node] | undefined => {
      const n = this.files.get(p) ?? (p.endsWith('/') ? undefined : this.files.get(`${p}/`));
      if (n) return [this.files.has(p) ? p : `${p}/`, n];
      if (p.endsWith('/') && this.files.get(p.slice(0, -1))) return [p.slice(0, -1), this.files.get(p.slice(0, -1))!];
      return undefined;
    };
    switch (method) {
      case 'PROPFIND': {
        if (this.quirks.htmlInsteadOfListing) return reply(200, '<!DOCTYPE html><html><body>Login</body></html>', 'text/html');
        const found = lookup(path);
        if (!found) return reply(404, 'Not Found', 'text/plain');
        const [key, node] = found;
        const depth = headers.get('depth') ?? 'infinity';
        const items: [string, Node][] = [[key, node]];
        if (node.dir && depth === '1') {
          for (const [k, n] of this.files) {
            if (k !== key && parentOf(k) === key) items.push([k, n]);
          }
        }
        const href = (k: string): string => {
          const p = (this.quirks.hrefPrefix ?? '') + k.split('/').map(encodeURIComponent).join('/');
          return this.quirks.absoluteHrefs ? `${this.origin}${p}` : p;
        };
        let xml =
          '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
          items
            .map(
              ([k, n]) =>
                `<D:response><D:href>${href(k)}</D:href><D:propstat><D:prop>` +
                `<D:resourcetype>${n.dir ? '<D:collection/>' : ''}</D:resourcetype>` +
                (n.dir ? '' : `<D:getcontentlength>${n.data?.byteLength ?? 0}</D:getcontentlength>`) +
                `<D:getlastmodified>${n.mtime.toUTCString()}</D:getlastmodified>` +
                `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
                `<D:propstat><D:prop><D:quota-available-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>` +
                `</D:response>`,
            )
            .join('') +
          '</D:multistatus>';
        if (this.quirks.truncateListing) xml = xml.slice(0, Math.floor(xml.length / 2));
        return reply(207, xml, 'application/xml; charset=utf-8');
      }
      case 'GET': {
        const n = this.files.get(path);
        if (!n || n.dir) return reply(404, 'Not Found', 'text/plain');
        return reply(200, n.data ?? new Uint8Array(), 'application/octet-stream');
      }
      case 'PUT': {
        if (!this.files.get(parentOf(path))?.dir) return reply(409, 'Conflict', 'text/plain');
        const body = init?.body;
        const data =
          body instanceof Uint8Array ? body : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new TextEncoder().encode(String(body ?? ''));
        const existed = this.files.has(path);
        this.files.set(path, { dir: false, data, mtime: new Date() });
        return reply(existed ? 204 : 201);
      }
      case 'MKCOL': {
        if (this.files.has(path) || this.files.has(path.replace(/\/$/, ''))) return reply(405, 'Method Not Allowed', 'text/plain');
        if (!this.files.get(parentOf(path))?.dir) return reply(409, 'Conflict', 'text/plain');
        this.files.set(path.endsWith('/') ? path : `${path}/`, { dir: true, mtime: new Date() });
        return reply(201);
      }
      case 'DELETE': {
        const found = lookup(path);
        if (!found) return reply(404, 'Not Found', 'text/plain');
        const [key, node] = found;
        if (node.dir && this.quirks.multiStatusDelete) {
          return reply(
            207,
            `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${key}locked</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response></d:multistatus>`,
            'application/xml',
          );
        }
        for (const k of [...this.files.keys()]) if (k === key || (node.dir && k.startsWith(key))) this.files.delete(k);
        return reply(204);
      }
      default:
        return reply(405, 'Method Not Allowed', 'text/plain');
    }
  };
}
