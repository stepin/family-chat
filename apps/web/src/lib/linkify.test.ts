import { describe, expect, it } from 'vitest';
import { linkify, safeHref, type Segment } from './linkify.ts';

const links = (s: Segment[]) => s.filter((x) => x.kind === 'link').map((x) => (x.kind === 'link' ? x.href : ''));
const joined = (s: Segment[]) => s.map((x) => x.text).join('');

describe('linkify', () => {
  it('keeps the text exactly and finds http(s) links', () => {
    const text = 'Смотри https://example.org/a?b=1, и http://ya.ru.';
    const s = linkify(text);
    expect(joined(s)).toBe(text);
    expect(links(s)).toEqual(['https://example.org/a?b=1', 'http://ya.ru/']);
  });

  it('makes www., e-mail, mailto: and tel: clickable', () => {
    expect(links(linkify('www.example.com'))).toEqual(['https://www.example.com/']);
    expect(links(linkify('пиши на mama@example.ru!'))).toEqual(['mailto:mama@example.ru']);
    expect(links(linkify('mailto:a@b.cd'))).toEqual(['mailto:a@b.cd']);
    expect(links(linkify('звони tel:+7 (999) 123-45-67 вечером'))).toEqual(['tel:+79991234567']);
  });

  it('never links other schemes', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'JaVaScRiPt:alert(1)']) {
      const s = linkify(`a ${bad} b`);
      expect(links(s), bad).toEqual([]);
      expect(joined(s)).toBe(`a ${bad} b`);
    }
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://')).toBeNull();
  });

  it('keeps HTML as text', () => {
    const text = '<img src=x onerror=alert(1)> <script>alert(1)</script>';
    const s = linkify(text);
    expect(s).toEqual([{ kind: 'text', text }]);
  });

  it('trims trailing punctuation but keeps balanced parentheses', () => {
    expect(links(linkify('(см. https://ru.wikipedia.org/wiki/Чай_(напиток))'))).toEqual([
      'https://ru.wikipedia.org/wiki/%D0%A7%D0%B0%D0%B9_(%D0%BD%D0%B0%D0%BF%D0%B8%D1%82%D0%BE%D0%BA)',
    ]);
    expect(links(linkify('«https://example.org/x»'))).toEqual(['https://example.org/x']);
  });

  it('text without links is one segment', () => {
    expect(linkify('Привет!')).toEqual([{ kind: 'text', text: 'Привет!' }]);
    expect(linkify('')).toEqual([]);
  });
});
