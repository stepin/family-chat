import { describe, expect, it } from 'vitest';
import { XmlError, XmlStreamParser } from '../src/storage/xml.ts';

function events(chunks: string[]): string[] {
  const out: string[] = [];
  const p = new XmlStreamParser({
    open: (ns, l) => out.push(`<{${ns}}${l}>`),
    close: (ns, l) => out.push(`</{${ns}}${l}>`),
    text: (t) => {
      if (t.trim()) out.push(JSON.stringify(t));
    },
  });
  for (const c of chunks) p.write(c);
  p.end();
  return out;
}

describe('XmlStreamParser', () => {
  const doc =
    '<?xml version="1.0"?>\n<!-- c --><a:root xmlns:a="DAV:" xmlns="urn:x"><a:x attr=\'v>\'>1 &amp; 2 &#x41;&#66;</a:x><y/><![CDATA[<raw>]]></a:root>\n';
  const expected = [
    '<{DAV:}root>',
    '<{DAV:}x>',
    '"1 & 2 AB"',
    '</{DAV:}x>',
    '<{urn:x}y>',
    '</{urn:x}y>',
    '"<raw>"',
    '</{DAV:}root>',
  ];

  it('parses namespaces, entities, CDATA, comments', () => {
    expect(events([doc])).toEqual(expected);
  });

  it('gives the same result for every split point', () => {
    for (let i = 1; i < doc.length; i++) {
      expect(events([doc.slice(0, i), doc.slice(i)])).toEqual(expected);
    }
  });

  it('gives the same result byte by byte', () => {
    expect(events([...doc])).toEqual(expected);
  });

  it('rejects an unclosed root', () => {
    expect(() => events(['<a><b></b>'])).toThrow(XmlError);
  });

  it('rejects mismatched tags', () => {
    expect(() => events(['<a><b></a></b>'])).toThrow(/mismatched/);
  });

  it('rejects DOCTYPE (no entity expansion)', () => {
    expect(() => events(['<!DOCTYPE html><html></html>'])).toThrow(/DOCTYPE/);
  });

  it('rejects unbound prefixes and second roots', () => {
    expect(() => events(['<p:a></p:a>'])).toThrow(/unbound/);
    expect(() => events(['<a/><b/>'])).toThrow(/root/);
  });

  it('rejects an empty document', () => {
    expect(() => events(['  '])).toThrow(/no root/);
  });

  it('keeps bare ampersands and unknown entities', () => {
    expect(events(['<a>x & y &nbsp;</a>'])).toEqual(['<{}a>', '"x & y &nbsp;"', '</{}a>']);
  });
});
