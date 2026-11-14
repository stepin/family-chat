import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MultistatusParser, parseMultistatus, parseStatusLine } from '../src/storage/multistatus.ts';
import { XmlError } from '../src/storage/xml.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

describe('parseMultistatus', () => {
  it('reads Apache style live-property prefixes', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">
<D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">
<D:href>/family-chat/a%20b.txt</D:href>
<D:propstat><D:prop>
<lp1:resourcetype/><lp1:getcontentlength>12</lp1:getcontentlength>
<lp1:getlastmodified>Fri, 13 Nov 2026 21:02:17 GMT</lp1:getlastmodified>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>
<D:response><D:href>/family-chat/sub/</D:href>
<D:propstat><D:prop><lp1:resourcetype xmlns:lp1="DAV:"><D:collection/></lp1:resourcetype></D:prop>
<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([
      {
        href: '/family-chat/a%20b.txt',
        props: { isCollection: false, contentLength: 12, lastModified: 'Fri, 13 Nov 2026 21:02:17 GMT' },
      },
      { href: '/family-chat/sub/', props: { isCollection: true } },
    ]);
  });

  it('reads a default DAV namespace and ignores non-2xx propstats', () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>https://h/x/f</href>
<propstat><prop><getcontentlength>5</getcontentlength><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat>
<propstat><prop><quota-available-bytes>99</quota-available-bytes></prop><status>HTTP/1.1 404 Not Found</status></propstat>
</response></multistatus>`;
    expect(parseMultistatus(xml)).toEqual([{ href: 'https://h/x/f', props: { isCollection: false, contentLength: 5 } }]);
  });

  it('reads quota properties', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/></d:resourcetype><d:quota-available-bytes>1000</d:quota-available-bytes><d:quota-used-bytes>24</d:quota-used-bytes>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parseMultistatus(xml)[0]?.props).toEqual({ isCollection: true, quotaAvailableBytes: 1000, quotaUsedBytes: 24 });
  });

  it('reads response-level status (DELETE 207)', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/b</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response></d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([{ href: '/a/b', status: 423, props: { isCollection: false } }]);
  });

  it('ignores elements from other namespaces with the same local name', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:x="urn:x"><d:response><d:href>/f</d:href><d:propstat><d:prop>
<x:getcontentlength>777</x:getcontentlength><d:resourcetype><x:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([{ href: '/f', props: { isCollection: false } }]);
  });

  it('rejects a non-multistatus root (HTML login page)', () => {
    expect(() => parseMultistatus('<html><body>Login</body></html>')).toThrow(/multistatus/);
  });

  it('rejects a truncated listing', () => {
    const p = new MultistatusParser();
    p.write('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/f</d:href></d:response>');
    expect(() => p.end()).toThrow(XmlError);
  });

  it('parses status lines', () => {
    expect(parseStatusLine('HTTP/1.1 200 OK')).toBe(200);
    expect(parseStatusLine('garbage')).toBeUndefined();
  });

  for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.xml'))) {
    it(`parses captured sample ${file}`, () => {
      const xml = readFileSync(join(fixtures, file), 'utf8');
      const rs = parseMultistatus(xml);
      expect(rs.length).toBeGreaterThan(0);
      for (const r of rs) expect(r.href).not.toBe('');
    });
  }
});
