import { StorageError, kindForStatus, parseRetryAfter } from './errors.ts';
import { MultistatusParser, type DavProps, type DavResponse } from './multistatus.ts';
import { XmlError } from './xml.ts';
import { hrefPath, normalizeRoot, resolvePath, trimSlash, parsePath } from './paths.ts';
import type { GetOptions, RequestOptions, ServerTimeSample, Storage, StorageEntry } from './types.ts';

/**
 * One request/response pair as seen by the page. Used for diagnostics and the
 * probe report. Never contains the password: `Authorization` is redacted.
 * `responseBody` is filled in after the body has been read.
 */
export interface DavExchange {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyBytes?: number;
  startedAt: number;
  durationMs?: number;
  status?: number;
  statusText?: string;
  responseType?: string;
  /** Only the headers the browser lets the page read (CORS-safelisted or exposed). */
  responseHeaders?: [string, string][];
  responseBody?: string;
  responseBodyBytes?: number;
  responseBodyTruncated?: boolean;
  error?: string;
}

export type DavObserver = (exchange: DavExchange) => void;

export interface DavClientOptions {
  username: string;
  password: string;
  fetch?: typeof fetch;
  /** Wall clock used for server time samples. Defaults to `Date.now`. */
  now?: () => number;
  /** Time to wait for response headers. Default 60 s. */
  timeoutMs?: number;
  observer?: DavObserver;
  /** How much of a text body to keep in `DavExchange.responseBody`. Default 16 KiB. */
  maxRecordedBody?: number;
}

export interface SendInit extends RequestOptions {
  headers?: Record<string, string>;
  body?: BodyInit | Uint8Array;
  /** Send `Authorization`. Default true. */
  auth?: boolean;
  mode?: RequestMode;
}

const TEXTUAL = /^(text\/|application\/(xml|json|xhtml\+xml)|[^;]*\+xml)/i;

function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

/** Low-level WebDAV client: auth, timeouts, server clock, exchange recording. */
export class DavClient {
  private readonly auth: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly observer: DavObserver | undefined;
  private readonly maxRecordedBody: number;
  private time: ServerTimeSample | null = null;

  constructor(opts: DavClientOptions) {
    this.auth = basic(opts.username, opts.password);
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.observer = opts.observer;
    this.maxRecordedBody = opts.maxRecordedBody ?? 16 * 1024;
  }

  serverTime(): ServerTimeSample | null {
    return this.time;
  }

  /**
   * Sends one request. Resolves with any HTTP status; rejects with a
   * `StorageError` (`Transient`) on network failure or timeout, and rethrows
   * the caller's own abort.
   */
  async send(method: string, url: URL, init: SendInit = {}): Promise<{ res: Response; ex: DavExchange }> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.auth !== false) headers['Authorization'] = this.auth;
    const ex: DavExchange = {
      method,
      url: url.href,
      requestHeaders: redact(headers),
      startedAt: Date.now(),
    };
    if (typeof init.body === 'string') {
      ex.requestBody = init.body;
      ex.requestBodyBytes = new TextEncoder().encode(init.body).byteLength;
    } else if (init.body instanceof Uint8Array) {
      ex.requestBodyBytes = init.body.byteLength;
    } else if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
      ex.requestBodyBytes = init.body.size;
    }
    this.observer?.(ex);

    const ctl = new AbortController();
    const user = init.signal;
    if (user?.aborted) throw user.reason ?? new DOMException('Aborted', 'AbortError');
    const onAbort = (): void => ctl.abort(user?.reason);
    user?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await this.fetchFn(url, {
        method,
        headers,
        body: init.body as BodyInit | undefined,
        credentials: 'omit',
        cache: 'no-store',
        // Redirects are never followed for WebDAV (6.12); a no-cors request
        // only accepts 'follow', and it carries no credentials anyway.
        redirect: init.mode === 'no-cors' ? 'follow' : 'manual',
        mode: init.mode ?? 'cors',
        signal: ctl.signal,
      });
      ex.durationMs = Math.round(performance.now() - t0);
      ex.status = res.status;
      ex.statusText = res.statusText;
      ex.responseType = res.type;
      const visible: [string, string][] = [];
      res.headers.forEach((v, k) => visible.push([k, v]));
      ex.responseHeaders = visible;
      const date = res.headers.get('date');
      const serverMs = date ? Date.parse(date) : NaN;
      if (Number.isFinite(serverMs)) this.time = { serverMs, localMs: this.now() };
      return { res, ex };
    } catch (e) {
      ex.durationMs = Math.round(performance.now() - t0);
      if (timedOut) {
        ex.error = 'timeout';
        throw new StorageError('Transient', `${method} ${url.pathname}: timeout`, { reason: 'timeout', cause: e });
      }
      if (isAbort(e) || user?.aborted) {
        ex.error = 'aborted';
        throw e;
      }
      ex.error = `network: ${e instanceof Error ? e.message : String(e)}`;
      throw new StorageError('Transient', `${method} ${url.pathname}: network error (offline, CORS or certificate)`, {
        reason: 'network',
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      user?.removeEventListener('abort', onAbort);
    }
  }

  /** Throws the typed error for a non-success response; reads a short body for the record. */
  async fail(res: Response, ex: DavExchange, what: string): Promise<never> {
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new StorageError('Fatal', `${what}: server answered with a redirect`, { status: res.status, reason: 'redirect' });
    }
    await this.readText(res, ex, 64 * 1024).catch(() => undefined);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), Date.now());
    throw new StorageError(kindForStatus(res.status), `${what}: HTTP ${res.status}`, {
      status: res.status,
      reason: 'http',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  /** Reads the whole body as text (up to `limit` bytes), recording a snippet. */
  async readText(res: Response, ex: DavExchange, limit = 1024 * 1024): Promise<string> {
    const bytes = await this.readBytes(res, ex, limit);
    const text = new TextDecoder().decode(bytes);
    this.record(ex, res, text, bytes.byteLength);
    return text;
  }

  /** Reads the whole body as bytes; fails with `response-too-large` past `limit`. */
  async readBytes(res: Response, ex: DavExchange, limit = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > limit) {
      await res.body?.cancel().catch(() => undefined);
      throw new StorageError('Fatal', `response of ${declared} bytes exceeds ${limit}`, { reason: 'response-too-large' });
    }
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      ex.responseBodyBytes = buf.byteLength;
      if (buf.byteLength > limit) throw new StorageError('Fatal', 'response too large', { reason: 'response-too-large' });
      return buf;
    }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new StorageError('Fatal', `response exceeds ${limit} bytes`, { reason: 'response-too-large' });
      }
      parts.push(value);
    }
    ex.responseBodyBytes = total;
    if (parts.length === 1 && parts[0]) return parts[0];
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  /** Streams a 207 body into the multistatus parser with a size limit. */
  async readMultistatus(res: Response, ex: DavExchange, limit: number): Promise<DavResponse[]> {
    const parser = new MultistatusParser();
    const decoder = new TextDecoder();
    let total = 0;
    let recorded = '';
    const feed = (s: string): void => {
      if (recorded.length < this.maxRecordedBody) recorded += s.slice(0, this.maxRecordedBody - recorded.length);
      parser.write(s);
    };
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw new StorageError('Fatal', `listing exceeds ${limit} bytes`, { reason: 'listing-too-large' });
          }
          feed(decoder.decode(value, { stream: true }));
        }
        feed(decoder.decode());
      } else {
        const text = await res.text();
        total = text.length;
        if (total > limit) throw new StorageError('Fatal', `listing exceeds ${limit} bytes`, { reason: 'listing-too-large' });
        feed(text);
      }
      return parser.end();
    } catch (e) {
      if (e instanceof XmlError) {
        throw new StorageError('Transient', `unreadable listing: ${e.message}`, { status: res.status, reason: 'bad-xml', cause: e });
      }
      throw e;
    } finally {
      ex.responseBody = recorded;
      ex.responseBodyBytes = total;
      ex.responseBodyTruncated = total > recorded.length;
    }
  }

  private record(ex: DavExchange, res: Response, text: string, bytes: number): void {
    ex.responseBodyBytes = bytes;
    const type = res.headers.get('content-type') ?? '';
    if (type === '' || TEXTUAL.test(type)) {
      ex.responseBody = text.slice(0, this.maxRecordedBody);
      ex.responseBodyTruncated = text.length > this.maxRecordedBody;
    }
  }
}

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? `${v.split(' ')[0] ?? ''} <redacted>` : v;
  }
  return out;
}

export const PROPFIND_LIST_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

export const PROPFIND_QUOTA_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>';

export interface WebDavStorageOptions extends DavClientOptions {
  /** Root folder URL, e.g. `https://home.example.net/webdav/family-chat/`. */
  url: string;
  /** Upper bound for one listing body. Default 8 MiB (7.8). */
  maxListingBytes?: number;
}

export interface SpaceInfo {
  availableBytes?: number;
  usedBytes?: number;
}

function toEntry(r: DavResponse, name: string): StorageEntry {
  const e: StorageEntry = { name, isDir: r.props.isCollection, size: r.props.contentLength ?? 0 };
  const t = r.props.lastModified ? Date.parse(r.props.lastModified) : NaN;
  if (Number.isFinite(t)) e.mtime = t;
  return e;
}

/** `Storage` over WebDAV: PROPFIND (Depth 0/1), GET, PUT, DELETE, MKCOL only. */
export class WebDavStorage implements Storage {
  readonly root: URL;
  readonly client: DavClient;
  private readonly maxListingBytes: number;

  constructor(opts: WebDavStorageOptions) {
    this.root = normalizeRoot(opts.url);
    this.client = new DavClient(opts);
    this.maxListingBytes = opts.maxListingBytes ?? 8 * 1024 * 1024;
  }

  url(path: string): URL {
    return resolvePath(this.root, path);
  }

  serverTime(): ServerTimeSample | null {
    return this.client.serverTime();
  }

  async list(dir: string, opts: RequestOptions = {}): Promise<StorageEntry[]> {
    const path = dir === '' || dir.endsWith('/') ? dir : `${dir}/`;
    const url = this.url(path);
    const rs = await this.propfind(url, '1', PROPFIND_LIST_BODY, opts);
    const self = trimSlash(hrefPath(url.href, url));
    const parsed = rs.map((r) => ({ r, path: trimSlash(hrefPath(r.href, url)) }));
    let selfIndex = parsed.findIndex((p) => p.path === self);
    if (selfIndex === -1) {
      // A proxy may rewrite the prefix: the collection itself is then the entry
      // whose path is the parent of every other entry.
      selfIndex = parsed.findIndex((p) =>
        parsed.every((q) => q === p || q.path.startsWith(p.path === '/' ? '/' : `${p.path}/`)),
      );
    }
    const out: StorageEntry[] = [];
    parsed.forEach((p, i) => {
      if (i === selfIndex) return;
      const name = p.path.split('/').pop() ?? '';
      if (name === '' || name === '.' || name === '..') return;
      out.push(toEntry(p.r, name));
    });
    return out;
  }

  /** Depth 0 PROPFIND of one resource. Not part of `Storage`; used by `mkdir` and the probe. */
  async stat(path: string, opts: RequestOptions = {}): Promise<StorageEntry & { props: DavProps }> {
    const url = this.url(path);
    const rs = await this.propfind(url, '0', PROPFIND_LIST_BODY, opts);
    const r = rs[0];
    if (!r) throw new StorageError('Transient', `PROPFIND ${url.pathname}: empty multistatus`, { status: 207, reason: 'bad-xml' });
    const name = trimSlash(hrefPath(r.href, url)).split('/').pop() ?? '';
    return { ...toEntry(r, name), props: r.props };
  }

  /** Free and used space (RFC 4331) if the server reports it. */
  async space(opts: RequestOptions = {}): Promise<SpaceInfo> {
    const rs = await this.propfind(this.root, '0', PROPFIND_QUOTA_BODY, opts);
    const p = rs[0]?.props;
    const out: SpaceInfo = {};
    if (p?.quotaAvailableBytes !== undefined) out.availableBytes = p.quotaAvailableBytes;
    if (p?.quotaUsedBytes !== undefined) out.usedBytes = p.quotaUsedBytes;
    return out;
  }

  async get(path: string, opts: GetOptions = {}): Promise<Uint8Array> {
    if (parsePath(path).isDir) throw new StorageError('Fatal', 'get() needs a file path', { reason: 'invalid-path' });
    const url = this.url(path);
    const { res, ex } = await this.client.send('GET', url, opts);
    if (res.status !== 200) return this.client.fail(res, ex, `GET ${url.pathname}`);
    return this.client.readBytes(res, ex, opts.maxBytes);
  }

  async put(path: string, data: Uint8Array | Blob, opts: RequestOptions = {}): Promise<void> {
    if (parsePath(path).isDir) throw new StorageError('Fatal', 'put() needs a file path', { reason: 'invalid-path' });
    const url = this.url(path);
    const { res, ex } = await this.client.send('PUT', url, {
      ...opts,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    });
    if (res.status < 200 || res.status > 299) return this.client.fail(res, ex, `PUT ${url.pathname}`);
    await res.body?.cancel().catch(() => undefined);
  }

  async delete(path: string, opts: RequestOptions = {}): Promise<void> {
    const url = this.url(path);
    const { res, ex } = await this.client.send('DELETE', url, opts);
    if (res.status === 207) {
      // Partial failure: some members could not be deleted.
      const rs = await this.client.readMultistatus(res, ex, this.maxListingBytes);
      const bad = rs.find((r) => r.status !== undefined && (r.status < 200 || r.status > 299));
      if (bad?.status !== undefined) {
        throw new StorageError(kindForStatus(bad.status), `DELETE ${url.pathname}: member ${bad.href} HTTP ${bad.status}`, {
          status: bad.status,
        });
      }
      return;
    }
    if (res.status < 200 || res.status > 299) return this.client.fail(res, ex, `DELETE ${url.pathname}`);
    await res.body?.cancel().catch(() => undefined);
  }

  async mkdir(dir: string, opts: RequestOptions = {}): Promise<void> {
    const path = dir.endsWith('/') ? dir : `${dir}/`;
    const url = this.url(path);
    const { res, ex } = await this.client.send('MKCOL', url, opts);
    // 405: already exists. Either way the result is verified by re-reading (7.7).
    if (res.status !== 201 && res.status !== 405 && !(res.status >= 200 && res.status < 300)) {
      return this.client.fail(res, ex, `MKCOL ${url.pathname}`);
    }
    await res.body?.cancel().catch(() => undefined);
    let entry;
    try {
      entry = await this.stat(path, opts);
    } catch (e) {
      if (res.status === 405 && e instanceof StorageError && e.kind === 'NotFound') {
        throw new StorageError('Fatal', `MKCOL ${url.pathname}: not allowed by the server`, { status: 405 });
      }
      throw e;
    }
    if (!entry.isDir) {
      throw new StorageError('Conflict', `MKCOL ${url.pathname}: a file with this name exists`, { reason: 'not-a-collection' });
    }
  }

  private async propfind(url: URL, depth: '0' | '1', body: string, opts: RequestOptions): Promise<DavResponse[]> {
    const { res, ex } = await this.client.send('PROPFIND', url, {
      ...opts,
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    });
    if (res.status === 207) return this.client.readMultistatus(res, ex, this.maxListingBytes);
    if (res.status >= 200 && res.status < 300) {
      // E.g. a captive portal answering 200 with HTML: not an empty folder (7.8).
      await this.client.readText(res, ex, 64 * 1024).catch(() => undefined);
      throw new StorageError('Transient', `PROPFIND ${url.pathname}: expected 207, got ${res.status}`, {
        status: res.status,
        reason: 'not-multistatus',
      });
    }
    return this.client.fail(res, ex, `PROPFIND ${url.pathname}`);
  }
}
