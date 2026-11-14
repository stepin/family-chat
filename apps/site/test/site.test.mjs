// Unit checks of the site build (node --test). The browser checks (axe,
// keyboard, 360 px, the app under app/) are in e2e/.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAGES, SITE_CSP, build, publicationValues, relUrl, renderMarkdown, repo, rewriteLink, slugify } from '../build.mjs';
import { checkSite } from '../check.mjs';

test('the whole site builds and every internal link, image and anchor resolves', () => {
  const out = mkdtempSync(join(tmpdir(), 'fc-site-'));
  try {
    const r = build({ outDir: out, withApp: false });
    assert.equal(r.pages, PAGES.length);
    assert.deepEqual(checkSite(out, { basePath: (process.env.SITE_BASE_PATH ?? '/').replace(/\/*$/, '/') }), []);
    for (const p of PAGES) {
      const html = readFileSync(join(out, p.path, 'index.html'), 'utf8');
      assert.match(html, new RegExp(`<html lang="${p.lang}">`));
      assert.ok(html.includes(`content="${SITE_CSP}"`), `${p.path}: CSP`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the link checker finds broken links, anchors, scripts and outside resources', () => {
  const out = mkdtempSync(join(tmpdir(), 'fc-site-bad-'));
  try {
    mkdirSync(join(out, 'a'));
    writeFileSync(join(out, 'a', 'index.html'), '<html lang="ru"><h1 id="x">A</h1></html>');
    writeFileSync(
      join(out, 'index.html'),
      `<html lang="ru"><meta http-equiv="Content-Security-Policy" content="x"><h1>T</h1>
       <a href="a/">ok</a><a href="a/#x">ok</a><a href="missing/">bad</a><a href="a/#nope">bad anchor</a>
       <img src="pic.png"><link rel="stylesheet" href="https://cdn.example.org/x.css"><script src="x.js"></script></html>`,
    );
    const problems = checkSite(out).join('\n');
    assert.match(problems, /broken href: missing\//);
    assert.match(problems, /missing anchor: a\/#nope/);
    assert.match(problems, /<img> without alt/);
    assert.match(problems, /loads https:\/\/cdn\.example\.org/);
    assert.match(problems, /has a <script>/);
    assert.match(problems, /a\/index\.html: no Content-Security-Policy/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('heading anchors follow GitHub, so links work in the repository and on the site', () => {
  assert.equal(slugify('Страница проверки `/server/`'), 'страница-проверки-server');
  assert.equal(slugify('iPhone: установка на экран «Домой»'), 'iphone-установка-на-экран-домой');
  assert.equal(slugify('Backup and restore'), 'backup-and-restore');
  const { html, toc, title } = renderMarkdown('# T\n\n## Раз\n\n## Раз\n\ntext', 'docs/X.md', 'x/');
  assert.equal(title, 'T');
  assert.deepEqual(
    toc.map((t) => t.id),
    ['раз', 'раз-1'],
  );
  assert.match(html, /<h2 id="раз-1">/);
});

test('Markdown links become site links, repository links or plain text', () => {
  assert.equal(relUrl('install/', 'family/'), '../family/');
  assert.equal(relUrl('', 'install/'), 'install/');
  assert.equal(relUrl('en/install/', ''), '../../');
  assert.equal(rewriteLink('FAMILY.md#архив', 'docs/ADMIN.md', 'install/', ''), '../family/#архив');
  assert.equal(rewriteLink('../PROTOCOL.md', 'docs/en/SECURITY-MODEL.md', 'en/security/', ''), '../../docs/protocol/');
  assert.equal(rewriteLink('#https', 'docs/ADMIN.md', 'install/', ''), '#https');
  assert.equal(rewriteLink('https://example.org/', 'docs/ADMIN.md', 'install/', ''), 'https://example.org/');
  // Not on the site: the repository when known, otherwise no link.
  assert.equal(rewriteLink('../compose.yaml', 'docs/ADMIN.md', 'install/', ''), null);
  assert.equal(
    rewriteLink('../compose.yaml', 'docs/ADMIN.md', 'install/', 'https://git.example.net/fc'),
    'https://git.example.net/fc/blob/main/compose.yaml',
  );
  assert.equal(rewriteLink('https://code.example.org/family-chat/releases', 'docs/ADMIN.md', 'install/', ''), null);
});

test('publication values replace the placeholders', () => {
  const html = 'see https://code.example.org/family-chat/releases and registry.example.org/family-chat/fcd:latest';
  assert.equal(publicationValues(html, { repositoryUrl: '', image: '' }), html);
  assert.equal(
    publicationValues(html, { repositoryUrl: 'https://git.example.net/fc/', image: 'img.example.net/fcd' }),
    'see https://git.example.net/fc/releases and img.example.net/fcd:latest',
  );
});

test('the example files in deploy/ are quoted word for word in both installation guides', () => {
  const files = ['compose.yaml', 'deploy/caddy/Caddyfile', 'deploy/nginx/family-chat.conf', 'deploy/podman/fcd.container', 'deploy/systemd/fcd.service'];
  for (const lang of ['docs/ADMIN.md', 'docs/en/ADMIN.md']) {
    const doc = readFileSync(join(repo, lang), 'utf8');
    for (const f of files) {
      const body = readFileSync(join(repo, f), 'utf8');
      assert.ok(doc.includes(body), `${lang} must contain ${f} as is`);
    }
  }
});

test('site texts use no em dash and no spaced en dash', () => {
  const sources = [
    ...PAGES.map((p) => p.md ?? p.html).filter((f) => !/PROTOCOL|API/.test(f)),
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'docs/RELEASING.md',
  ];
  for (const f of sources) {
    const text = readFileSync(join(repo, f), 'utf8');
    assert.ok(!text.includes('—'), `${f}: em dash`);
    assert.ok(!/\s–\s/.test(text), `${f}: spaced en dash`);
  }
});

test('screenshots exist in both themes', () => {
  const names = readdirSync(join(repo, 'apps/site/screenshots')).filter((n) => n.endsWith('.png'));
  for (const shot of ['chat-list', 'chat', 'desktop']) {
    assert.ok(names.includes(`${shot}-light.png`) && names.includes(`${shot}-dark.png`), shot);
  }
});
