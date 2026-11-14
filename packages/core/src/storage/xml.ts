/**
 * Minimal streaming XML tokenizer for WebDAV responses. No DOM: `DOMParser`
 * is unavailable in workers and service workers (docs/PLAN.md section 4).
 *
 * Supports elements, attributes, namespaces, character and predefined
 * entities, CDATA, comments and processing instructions. DOCTYPE is rejected,
 * so no entity expansion can happen.
 */
export interface XmlHandler {
  open(ns: string, local: string): void;
  close(ns: string, local: string): void;
  text(value: string): void;
}

export class XmlError extends Error {
  override readonly name = 'XmlError';
}

interface Frame {
  qname: string;
  ns: string;
  local: string;
  scope: Map<string, string> | null;
}

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g;
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decodes character and predefined entities. Lenient on purpose: a bare `&` or
 * an unknown named entity (seen in hrefs of some embedded servers) stays as is.
 */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    return PREDEFINED[body] ?? m;
  });
}

const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export class XmlStreamParser {
  private buf = '';
  private readonly stack: Frame[] = [];
  private rootSeen = false;
  private rootClosed = false;

  constructor(private readonly handler: XmlHandler) {}

  /** True once the root element has been closed. */
  get complete(): boolean {
    return this.rootClosed;
  }

  write(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    if (this.buf.trim() !== '') throw new XmlError('trailing data after root element');
    if (!this.rootClosed) throw new XmlError(this.rootSeen ? 'root element not closed' : 'no root element');
  }

  private drain(final: boolean): void {
    const buf = this.buf;
    let i = 0;
    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt === -1) {
        if (final) {
          this.emitText(buf.slice(i));
          i = buf.length;
        }
        break;
      }
      if (lt > i) this.emitText(buf.slice(i, lt));
      i = lt;
      const next = this.construct(buf, lt, final);
      if (next === -1) break; // need more data
      i = next;
    }
    this.buf = buf.slice(i);
  }

  /** Handles the markup at `lt`; returns the index after it, or -1 if incomplete. */
  private construct(buf: string, lt: number, final: boolean): number {
    const incomplete = (): number => {
      if (final) throw new XmlError('unexpected end of document');
      return -1;
    };
    if (buf.startsWith('<!--', lt)) {
      const end = buf.indexOf('-->', lt + 4);
      return end === -1 ? incomplete() : end + 3;
    }
    if (buf.startsWith('<![CDATA[', lt)) {
      const end = buf.indexOf(']]>', lt + 9);
      if (end === -1) return incomplete();
      this.emitRawText(buf.slice(lt + 9, end));
      return end + 3;
    }
    if (buf.startsWith('<?', lt)) {
      const end = buf.indexOf('?>', lt + 2);
      return end === -1 ? incomplete() : end + 2;
    }
    if (buf.startsWith('<!', lt)) {
      const rest = buf.slice(lt, lt + 9);
      if (rest.length < 9 && ('<![CDATA['.startsWith(rest) || '<!--'.startsWith(rest))) return incomplete();
      throw new XmlError('DOCTYPE and other declarations are not allowed');
    }
    // Element tag: find '>' outside quotes.
    let quote = '';
    for (let j = lt + 1; j < buf.length; j++) {
      const c = buf[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        this.tag(buf.slice(lt + 1, j));
        return j + 1;
      } else if (c === '<') {
        throw new XmlError('"<" inside a tag');
      }
    }
    return incomplete();
  }

  private tag(content: string): void {
    if (content.startsWith('/')) {
      const qname = content.slice(1).trim();
      const top = this.stack.pop();
      if (!top || top.qname !== qname) throw new XmlError(`mismatched closing tag </${qname}>`);
      this.handler.close(top.ns, top.local);
      if (this.stack.length === 0) this.rootClosed = true;
      return;
    }
    const selfClosing = content.endsWith('/');
    const body = selfClosing ? content.slice(0, -1) : content;
    const m = /^[^\s/>]+/.exec(body);
    if (!m) throw new XmlError('empty tag name');
    const qname = m[0];
    if (this.rootClosed) throw new XmlError('more than one root element');
    let scope: Map<string, string> | null = null;
    ATTR.lastIndex = 0;
    const attrs = body.slice(qname.length);
    for (let a = ATTR.exec(attrs); a; a = ATTR.exec(attrs)) {
      const name = a[1] ?? '';
      const value = decodeEntities(a[2] ?? a[3] ?? '');
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        scope ??= new Map();
        scope.set(name === 'xmlns' ? '' : name.slice(6), value);
      }
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const ns = this.resolve(prefix, scope);
    if (ns === undefined) throw new XmlError(`unbound namespace prefix ${prefix}`);
    this.rootSeen = true;
    this.stack.push({ qname, ns, local, scope });
    this.handler.open(ns, local);
    if (selfClosing) {
      this.stack.pop();
      this.handler.close(ns, local);
      if (this.stack.length === 0) this.rootClosed = true;
    }
  }

  private resolve(prefix: string, own: Map<string, string> | null): string | undefined {
    if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace';
    const v = own?.get(prefix);
    if (v !== undefined) return v;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const s = this.stack[k]?.scope?.get(prefix);
      if (s !== undefined) return s;
    }
    return prefix === '' ? '' : undefined;
  }

  private emitText(raw: string): void {
    if (raw === '') return;
    if (this.stack.length === 0) {
      if (raw.trim() !== '') throw new XmlError('text outside the root element');
      return;
    }
    this.handler.text(decodeEntities(raw));
  }

  private emitRawText(raw: string): void {
    if (this.stack.length === 0) throw new XmlError('CDATA outside the root element');
    this.handler.text(raw);
  }
}
