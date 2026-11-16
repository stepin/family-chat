// Static site of Family Chat: plain HTML and CSS, no client-side JavaScript.
//
// Sources:
//   docs/*.md, docs/en/*.md   the documentation (single source of truth: the
//                             same Markdown is read in the repository and
//                             rendered here)
//   apps/site/src/            home pages (HTML fragments) and site.css
//   apps/site/screenshots/    screenshots of the app (scripts in screenshots/)
//   apps/web/src/styles/tokens.css, apps/web/public/icon.svg   the app's look
//
// The site does not carry the app (M8): the app always opens from the
// family's own server, and the site and the server are not connected.
//
//   node build.mjs [--out DIR]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import config, { PROJECT_IMAGE, PROJECT_REPOSITORY } from './site.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '../..');

/**
 * Content-Security-Policy of every site page (a <meta> tag, so it works on
 * any static host). No scripts at all, styles and images only from the site.
 * Hosts that can send headers should send the same policy plus
 * `frame-ancestors 'none'` (apps/site/README.md).
 */
export const SITE_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Every page: id (same in both languages), language, output path, source. */
export const PAGES = [
  { id: 'home', lang: 'ru', path: '', html: 'apps/site/src/home.ru.html' },
  { id: 'install', lang: 'ru', path: 'install/', md: 'docs/ADMIN.md' },
  { id: 'family', lang: 'ru', path: 'family/', md: 'docs/FAMILY.md' },
  { id: 'security', lang: 'ru', path: 'security/', md: 'docs/SECURITY-MODEL.md' },
  { id: 'faq', lang: 'ru', path: 'faq/', md: 'docs/FAQ.md' },
  { id: 'protocol', lang: 'ru', path: 'docs/protocol/', md: 'docs/PROTOCOL.md', nav: 'security' },
  { id: 'api', lang: 'ru', path: 'docs/api/', md: 'docs/API.md', nav: 'security' },
  { id: 'home', lang: 'en', path: 'en/', html: 'apps/site/src/home.en.html' },
  { id: 'install', lang: 'en', path: 'en/install/', md: 'docs/en/ADMIN.md' },
  { id: 'family', lang: 'en', path: 'en/family/', md: 'docs/en/FAMILY.md' },
  { id: 'security', lang: 'en', path: 'en/security/', md: 'docs/en/SECURITY-MODEL.md' },
  { id: 'faq', lang: 'en', path: 'en/faq/', md: 'docs/en/FAQ.md' },
];

const UI = {
  ru: {
    skip: 'Перейти к содержанию',
    navLabel: 'Разделы сайта',
    nav: [
      ['home', 'Главная'],
      ['install', 'Установка'],
      ['family', 'Для семьи'],
      ['security', 'Безопасность'],
      ['faq', 'Вопросы'],
    ],
    toc: 'Содержание',
    table: 'Таблица',
    code: 'Пример',
    switchTo: 'English',
    switchLang: 'en',
    source: 'Исходный код',
    licence: 'Лицензия MIT.',
    homeTitle: 'Family Chat: семейный чат на своём сервере',
    notFoundTitle: 'Страница не найдена',
    notFoundText: 'Такой страницы нет. Возможно, адрес набран с ошибкой.',
    toHome: 'На главную',
  },
  en: {
    skip: 'Skip to content',
    navLabel: 'Site sections',
    nav: [
      ['home', 'Home'],
      ['install', 'Install'],
      ['family', 'For the family'],
      ['security', 'Security'],
      ['faq', 'FAQ'],
    ],
    toc: 'Contents',
    table: 'Table',
    code: 'Example',
    switchTo: 'Русский',
    switchLang: 'ru',
    source: 'Source code',
    licence: 'MIT licence.',
    homeTitle: 'Family Chat: a family chat on your own server',
    notFoundTitle: 'Page not found',
    notFoundText: 'There is no such page. The address may be mistyped.',
    toHome: 'Home',
  },
};

// ---- small helpers ----

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of rendered inline HTML. */
function plain(html) {
  return decode(html.replace(/<[^>]*>/g, '')).trim();
}

/** Heading anchors as GitHub makes them, so links work in both places. */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

class Slugger {
  #seen = new Map();
  slug(text) {
    const base = slugify(text);
    const n = this.#seen.get(base) ?? 0;
    this.#seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }
}

/** Relative URL from one site path (`install/`) to another (`family/`). */
export function relUrl(from, to) {
  const ups = from.split('/').filter(Boolean).length;
  return '../'.repeat(ups) + to || './';
}

export function version() {
  const toml = readFileSync(join(repo, 'server/Cargo.toml'), 'utf8');
  return /^version = "([^"]+)"/m.exec(toml)?.[1] ?? '0.0.0';
}

/** Width and height of a PNG file (the IHDR chunk). */
function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Markdown source (repository path) to site path. */
const MD_TO_PAGE = new Map(PAGES.filter((p) => p.md).map((p) => [p.md, p.path]));

/**
 * Where a link in a Markdown file points on the site: another rendered page,
 * the repository, or nowhere (null: the link text stays, without a link).
 */
export function rewriteLink(href, mdPath, pagePath, repositoryUrl = config.repositoryUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
  const [p = '', hash] = href.split('#');
  const resolved = posix.normalize(posix.join(posix.dirname(mdPath), p));
  const anchor = hash ? `#${hash}` : '';
  const page = MD_TO_PAGE.get(resolved);
  if (page !== undefined) return relUrl(pagePath, page) + anchor;
  if (resolved.startsWith('..')) return null;
  const kind = existsSync(join(repo, resolved)) && !resolved.includes('.') ? 'tree' : 'blob';
  return `${repositoryUrl.replace(/\/+$/, '')}/${kind}/main/${resolved}${anchor}`;
}

/** Renders one Markdown document for the page at `pagePath`. */
export function renderMarkdown(source, mdPath, pagePath, lang = 'ru') {
  const slugger = new Slugger();
  const toc = [];
  let title = '';
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = plain(inner);
        const id = slugger.slug(text);
        if (depth === 1 && !title) {
          title = text;
          return `<h1 id="${id}">${inner}</h1>\n`;
        }
        if (depth === 2) toc.push({ id, html: inner });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link({ href, title: t, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = rewriteLink(href, mdPath, pagePath);
        if (target === null) return inner;
        return `<a href="${esc(target)}"${t ? ` title="${esc(t)}"` : ''}>${inner}</a>`;
      },
      code({ text, lang: codeLang }) {
        const cls = codeLang ? ` class="language-${esc(codeLang)}"` : '';
        return `<pre tabindex="0" aria-label="${UI[lang].code}"><code${cls}>${esc(text)}</code></pre>\n`;
      },
    },
  });
  const tokens = marked.lexer(source);
  const firstParagraph = tokens.find((t) => t.type === 'paragraph');
  let html = marked.parser(tokens);
  html = html
    .replace(/<table>/g, `<div class="table-wrap" tabindex="0" role="region" aria-label="${UI[lang].table}"><table>`)
    .replace(/<\/table>/g, '</table></div>');
  let description = firstParagraph ? plain(marked.parseInline(firstParagraph.text)) : '';
  if (description.length > 200) description = `${description.slice(0, 197).replace(/\s+\S*$/, '')}…`;
  return { title, html, toc, description };
}

/** A fork's own repository and image in place of the project's (site.config.mjs). */
export function publicationValues(html, c = config) {
  let out = html;
  const repoUrl = c.repositoryUrl.replace(/\/+$/, '');
  if (repoUrl !== PROJECT_REPOSITORY) out = out.split(PROJECT_REPOSITORY).join(repoUrl);
  if (c.image !== PROJECT_IMAGE) out = out.split(PROJECT_IMAGE).join(c.image);
  return out;
}

function shot(root, name, alt, caption, siteDir) {
  const light = join(siteDir, 'screenshots', `${name}-light.png`);
  const dark = join(siteDir, 'screenshots', `${name}-dark.png`);
  if (!existsSync(light)) throw new Error(`missing screenshot ${light}: run pnpm --filter @family-chat/site run screenshots`);
  const { width, height } = pngSize(light);
  const darkSource = existsSync(dark)
    ? `<source srcset="${root}screenshots/${name}-dark.png" media="(prefers-color-scheme: dark)" width="${width}" height="${height}">`
    : '';
  const kind = width > height ? 'wide' : 'phone';
  return `<figure class="shot shot-${kind}"><picture>${darkSource}<img src="${root}screenshots/${name}-light.png" alt="${esc(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"></picture><figcaption>${caption}</figcaption></figure>`;
}

function layout({ page, title, description, main }) {
  const ui = UI[page.lang];
  const root = relUrl(page.path, '');
  const navId = page.nav ?? page.id;
  const other = PAGES.find((p) => p.id === page.id && p.lang === ui.switchLang) ??
    PAGES.find((p) => p.id === 'home' && p.lang === ui.switchLang);
  const pathOf = (id) => PAGES.find((p) => p.id === id && p.lang === page.lang)?.path ?? '';
  const nav = ui.nav
    .map(([id, label]) => {
      const current = id === navId ? ' aria-current="page"' : '';
      return `<li><a href="${relUrl(page.path, pathOf(id))}"${current}>${label}</a></li>`;
    })
    .join('');
  const repoLine = `<a href="${esc(config.repositoryUrl)}">${ui.source}</a>.`;
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${SITE_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${root}icon.svg" type="image/svg+xml">
<link rel="icon" href="${root}favicon-32.png" sizes="32x32" type="image/png">
<link rel="stylesheet" href="${root}site.css">
<link rel="alternate" hreflang="${other.lang}" href="${relUrl(page.path, other.path)}">
</head>
<body>
<a class="skip" href="#main">${ui.skip}</a>
<header class="site-header">
<div class="bar">
<a class="brand" href="${root}${page.lang === 'en' ? 'en/' : ''}"><img src="${root}icon.svg" alt="" width="28" height="28"><span>Family Chat</span></a>
<a class="lang" href="${relUrl(page.path, other.path)}" hreflang="${other.lang}" lang="${other.lang}">${ui.switchTo}</a>
</div>
<nav aria-label="${ui.navLabel}"><ul>${nav}</ul></nav>
</header>
<main id="main" tabindex="-1">
${main}
</main>
<footer class="site-footer">
<p>Family Chat ${esc(version())}. ${ui.licence} ${repoLine}</p>
</footer>
</body>
</html>
`;
}

function renderPage(page, ctx) {
  const ui = UI[page.lang];
  const root = relUrl(page.path, '');
  if (page.html) {
    let body = readFileSync(join(repo, page.html), 'utf8');
    body = body
      .replace(/\{\{root\}\}/g, root)
      .replace(/\{\{version\}\}/g, esc(version()))
      .replace(/\{\{releases\}\}/g, esc(`${config.repositoryUrl.replace(/\/+$/, '')}/releases`))
      .replace(/<!--shot:([\w-]+)\|([^|]*)\|([^>]*)-->/g, (_, name, alt, caption) => shot(root, name, alt, caption, ctx.siteDir));
    const description = plain(/<p class="lead">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '');
    return layout({ page, title: ui.homeTitle, description, main: `<div class="home">${body}</div>` });
  }
  const source = readFileSync(join(repo, page.md), 'utf8');
  const { title, html, toc, description } = renderMarkdown(source, page.md, page.path, page.lang);
  const tocHtml =
    toc.length >= 3
      ? `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">${ui.toc}</h2><ol>${toc
          .map((t) => `<li><a href="#${t.id}">${t.html.replace(/<a [^>]*>|<\/a>/g, '')}</a></li>`)
          .join('')}</ol></nav>`
      : '';
  const withToc = html.replace(/(<\/h1>\n)/, `$1${tocHtml}`);
  return layout({ page, title: `${title}: Family Chat`, description, main: `<article class="doc">${withToc}</article>` });
}

function notFound(lang) {
  const ui = UI[lang];
  const page = { id: '404', lang, path: lang === 'en' ? 'en/404/' : '404/' };
  // 404.html is served for any missing path, so its links must not depend on
  // where it is shown: they start from the site root.
  return layout({
    page,
    title: `${ui.notFoundTitle}: Family Chat`,
    description: ui.notFoundText,
    main: `<article class="doc"><h1>${ui.notFoundTitle}</h1><p>${ui.notFoundText}</p><p><a href="${relUrl(page.path, lang === 'en' ? 'en/' : '')}">${ui.toHome}</a></p></article>`,
  });
}

/** Builds the whole site into `outDir`. */
export function build({ outDir = join(here, 'dist') } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tokens = readFileSync(join(repo, 'apps/web/src/styles/tokens.css'), 'utf8');
  const siteCss = readFileSync(join(here, 'src/site.css'), 'utf8');
  writeFileSync(join(outDir, 'site.css'), `/* From apps/web/src/styles/tokens.css: the app's design tokens. */\n${tokens}\n${siteCss}`);
  cpSync(join(repo, 'apps/web/public/icon.svg'), join(outDir, 'icon.svg'));
  cpSync(join(repo, 'apps/web/public/favicon-32.png'), join(outDir, 'favicon-32.png'));
  cpSync(join(here, 'screenshots'), join(outDir, 'screenshots'), {
    recursive: true,
    filter: (src) => !src.endsWith('.ts') && !src.endsWith('.md'),
  });
  // GitHub Pages: serve files as they are.
  writeFileSync(join(outDir, '.nojekyll'), '');

  const ctx = { siteDir: outDir };
  for (const page of PAGES) {
    const file = join(outDir, page.path, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, publicationValues(renderPage(page, ctx)));
  }
  // The Russian page answers at /404.html (static hosts look for it there).
  const base = config.basePath.replace(/\/*$/, '/');
  const missing = notFound('ru').replace(/(href|src)="\.\.\//g, `$1="${base}`);
  writeFileSync(join(outDir, '404.html'), missing);

  return { outDir, pages: PAGES.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : undefined;
  const r = build({ outDir });
  console.log(`site: ${r.pages} pages in ${r.outDir}`);
}
