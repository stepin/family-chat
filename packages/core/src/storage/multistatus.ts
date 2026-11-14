import { XmlError, XmlStreamParser, type XmlHandler } from './xml.ts';

const DAV = 'DAV:';

export interface DavProps {
  isCollection: boolean;
  contentLength?: number;
  lastModified?: string;
  quotaAvailableBytes?: number;
  quotaUsedBytes?: number;
}

export interface DavResponse {
  href: string;
  /** Status of the `<response>` itself (used in 207 answers to DELETE). */
  status?: number;
  /** Properties from `<propstat>` blocks with a 2xx status (or no status). */
  props: DavProps;
}

type PropName = 'getcontentlength' | 'getlastmodified' | 'resourcetype' | 'quota-available-bytes' | 'quota-used-bytes';
const PROPS = new Set<string>([
  'getcontentlength',
  'getlastmodified',
  'resourcetype',
  'quota-available-bytes',
  'quota-used-bytes',
]);

export function parseStatusLine(line: string): number | undefined {
  const m = /\b(\d{3})\b/.exec(line);
  return m ? Number(m[1]) : undefined;
}

function parseIntSafe(s: string): number | undefined {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Streaming parser of a `207 Multi-Status` body. Rejects documents whose root
 * is not `DAV:multistatus` or whose root element is never closed (7.8).
 */
export class MultistatusParser {
  readonly responses: DavResponse[] = [];
  private readonly xml: XmlStreamParser;
  private depth = 0;
  private path: string[] = [];
  private cur: { href: string; status?: number; propstats: { status?: number; props: DavProps }[] } | null = null;
  private propstat: { status?: number; props: DavProps } | null = null;
  private prop: PropName | null = null;
  private text = '';
  private capturing = false;

  constructor() {
    const handler: XmlHandler = {
      open: (ns, local) => this.open(ns, local),
      close: (ns, local) => this.close(ns, local),
      text: (t) => {
        if (this.capturing) this.text += t;
      },
    };
    this.xml = new XmlStreamParser(handler);
  }

  write(chunk: string): void {
    this.xml.write(chunk);
  }

  end(): DavResponse[] {
    this.xml.end();
    return this.responses;
  }

  private key(ns: string, local: string): string {
    return ns === DAV ? local : `{${ns}}${local}`;
  }

  private open(ns: string, local: string): void {
    const k = this.key(ns, local);
    const parent = this.path[this.path.length - 1];
    this.path.push(k);
    this.depth++;
    if (this.depth === 1) {
      if (k !== 'multistatus') throw new XmlError(`root element is ${k}, expected DAV:multistatus`);
      return;
    }
    if (k === 'response' && parent === 'multistatus') {
      this.cur = { href: '', propstats: [] };
    } else if (this.cur && parent === 'response' && (k === 'href' || k === 'status')) {
      this.startCapture();
    } else if (this.cur && k === 'propstat' && parent === 'response') {
      this.propstat = { props: { isCollection: false } };
    } else if (this.propstat && parent === 'propstat' && k === 'status') {
      this.startCapture();
    } else if (this.propstat && parent === 'prop' && PROPS.has(k)) {
      this.prop = k as PropName;
      if (k !== 'resourcetype') this.startCapture();
    } else if (this.propstat && this.prop === 'resourcetype' && parent === 'resourcetype' && k === 'collection') {
      this.propstat.props.isCollection = true;
    }
  }

  private close(ns: string, local: string): void {
    const k = this.key(ns, local);
    const parent = this.path[this.path.length - 2];
    this.path.pop();
    this.depth--;
    if (this.cur && parent === 'response' && k === 'href') {
      this.cur.href = this.endCapture().trim();
    } else if (this.cur && parent === 'response' && k === 'status') {
      this.cur.status = parseStatusLine(this.endCapture());
    } else if (this.propstat && parent === 'propstat' && k === 'status') {
      this.propstat.status = parseStatusLine(this.endCapture());
    } else if (this.propstat && parent === 'prop' && this.prop === k) {
      const props = this.propstat.props;
      if (k !== 'resourcetype') {
        const v = this.endCapture();
        if (k === 'getcontentlength') props.contentLength = parseIntSafe(v);
        else if (k === 'getlastmodified') props.lastModified = v.trim();
        else if (k === 'quota-available-bytes') props.quotaAvailableBytes = parseIntSafe(v);
        else if (k === 'quota-used-bytes') props.quotaUsedBytes = parseIntSafe(v);
      }
      this.prop = null;
    } else if (this.cur && k === 'propstat' && parent === 'response' && this.propstat) {
      this.cur.propstats.push(this.propstat);
      this.propstat = null;
    } else if (this.cur && k === 'response' && parent === 'multistatus') {
      const props: DavProps = { isCollection: false };
      for (const ps of this.cur.propstats) {
        if (ps.status !== undefined && (ps.status < 200 || ps.status > 299)) continue;
        if (ps.props.isCollection) props.isCollection = true;
        props.contentLength ??= ps.props.contentLength;
        props.lastModified ??= ps.props.lastModified;
        props.quotaAvailableBytes ??= ps.props.quotaAvailableBytes;
        props.quotaUsedBytes ??= ps.props.quotaUsedBytes;
      }
      const r: DavResponse = { href: this.cur.href, props };
      if (this.cur.status !== undefined) r.status = this.cur.status;
      this.responses.push(r);
      this.cur = null;
    }
  }

  private startCapture(): void {
    this.capturing = true;
    this.text = '';
  }

  private endCapture(): string {
    this.capturing = false;
    const t = this.text;
    this.text = '';
    return t;
  }
}

export function parseMultistatus(xml: string): DavResponse[] {
  const p = new MultistatusParser();
  p.write(xml);
  return p.end();
}
