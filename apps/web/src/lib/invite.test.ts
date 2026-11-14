import { describe, expect, it } from 'vitest';
import { inviteLinkFor, pageServerUrl, parseInviteInput, takeInviteFromLocation } from './invite.ts';

const CODE = 'abcdefghijklmnopqrstuvwxyz';
const HOME = 'https://chat.example.ru';

describe('parseInviteInput', () => {
  it('reads a full link and takes the server from it', () => {
    expect(parseInviteInput(`https://fam.example.org/#invite=${CODE}`, HOME)).toEqual({
      code: CODE,
      serverUrl: 'https://fam.example.org',
    });
  });

  it('keeps a path prefix of the server and drops index.html', () => {
    expect(parseInviteInput(`https://x.example/chat/index.html#invite=${CODE}`, HOME)?.serverUrl).toBe(
      'https://x.example/chat',
    );
  });

  it('finds the link inside a sentence from a messenger', () => {
    expect(parseInviteInput(`Вот приглашение: https://fam.example.org/#invite=${CODE} , заходи!`, HOME)?.code).toBe(CODE);
  });

  it('accepts a fragment or the bare code with the fallback server', () => {
    expect(parseInviteInput(`#invite=${CODE}`, `${HOME}/`)).toEqual({ code: CODE, serverUrl: HOME });
    expect(parseInviteInput(`  ${CODE.toUpperCase()}  `, HOME)).toEqual({ code: CODE, serverUrl: HOME });
    expect(parseInviteInput('abcde-fghij-klmno-pqrst-uvwxyz', HOME)?.code).toBe(CODE);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'привет', `https://x/#invite=${CODE}1`, 'abc', `#invite=${CODE.slice(1)}`]) {
      expect(parseInviteInput(bad, HOME), bad).toBeUndefined();
    }
    // A foreign scheme never becomes the server address; only the code is taken.
    expect(parseInviteInput(`ftp://x.example/#invite=${CODE}`, HOME)?.serverUrl).toBe(HOME);
    expect(parseInviteInput(`javascript:alert(1)#invite=${CODE}`, HOME)?.serverUrl).toBe(HOME);
  });
});

describe('takeInviteFromLocation', () => {
  function fakeLocation(href: string): { loc: Location; hist: History; replaced: string[] } {
    const url = new URL(href);
    const replaced: string[] = [];
    const loc = { href, hash: url.hash, pathname: url.pathname, search: url.search } as Location;
    const hist = { state: null, replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) } as unknown as History;
    return { loc, hist, replaced };
  }

  it('reads the code and removes the fragment from the address', () => {
    const { loc, hist, replaced } = fakeLocation(`https://fam.example.org/?x=1#invite=${CODE}`);
    expect(takeInviteFromLocation(loc, hist)).toEqual({ code: CODE, serverUrl: 'https://fam.example.org' });
    expect(replaced).toEqual(['/?x=1']);
  });

  it('removes even a malformed invitation fragment', () => {
    const { loc, hist, replaced } = fakeLocation('https://fam.example.org/#invite=short');
    expect(takeInviteFromLocation(loc, hist)).toBeUndefined();
    expect(replaced).toEqual(['/']);
  });

  it('leaves other fragments alone', () => {
    const { loc, hist, replaced } = fakeLocation('https://fam.example.org/#top');
    expect(takeInviteFromLocation(loc, hist)).toBeUndefined();
    expect(replaced).toEqual([]);
  });
});

describe('links', () => {
  it('builds the link to copy and the page server address', () => {
    expect(inviteLinkFor({ code: CODE, serverUrl: HOME })).toBe(`${HOME}/#invite=${CODE}`);
    expect(pageServerUrl({ href: `${HOME}/#invite=${CODE}` } as Location)).toBe(HOME);
  });
});
