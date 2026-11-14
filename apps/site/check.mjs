// Checks a built site: every internal link and image points to an existing
// file (and anchor), no page loads anything from another site, no page has
// a script, and every page carries the strict Content-Security-Policy.
//
//   node check.mjs [DIR]      (default: dist)
//
// The web client under app/ is Vite output with its own checks (apps/web);
// links into it are checked, its own files are not.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function htmlFiles(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (relative(root, p) === 'app') continue;
      out.push(...htmlFiles(p, root));
    } else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function ids(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** Returns a list of problems (empty when the site is fine). */
export function checkSite(dir, { basePath = '/' } = {}) {
  const root = resolve(dir);
  const problems = [];
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8'));
    return cache.get(f);
  };
  for (const file of htmlFiles(root)) {
    const page = relative(root, file).split(sep).join('/');
    const html = read(file);
    if (!html.includes('http-equiv="Content-Security-Policy"')) problems.push(`${page}: no Content-Security-Policy`);
    if (/<script\b/i.test(html)) problems.push(`${page}: has a <script>`);
    if (/<(iframe|object|embed)\b/i.test(html)) problems.push(`${page}: embeds other content`);
    if (!/<html lang="(ru|en)">/.test(html)) problems.push(`${page}: no lang on <html>`);
    if (!/<h1[\s>]/.test(html)) problems.push(`${page}: no <h1>`);
    for (const m of html.matchAll(/<img\b[^>]*>/g)) {
      if (!/\salt="/.test(m[0])) problems.push(`${page}: <img> without alt: ${m[0]}`);
    }
    for (const m of html.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
      const [, attr, value] = m;
      const tag = html.slice(html.lastIndexOf('<', m.index), m.index);
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        // External: links are fine, loading resources is not.
        if (attr !== 'href' || /<link\b/.test(tag)) problems.push(`${page}: loads ${value} from another site`);
        if (!/^(https|mailto):/.test(value)) problems.push(`${page}: link with a non-https scheme: ${value}`);
        continue;
      }
      if (value === '') {
        problems.push(`${page}: empty ${attr}`);
        continue;
      }
      const [pathPart = '', hash] = value.split('#');
      let target;
      if (pathPart === '') target = file;
      else if (pathPart.startsWith('/')) {
        if (!pathPart.startsWith(basePath)) {
          problems.push(`${page}: absolute link outside ${basePath}: ${value}`);
          continue;
        }
        target = join(root, pathPart.slice(basePath.length));
      } else target = resolve(dirname(file), pathPart);
      if (!target.startsWith(root)) {
        problems.push(`${page}: link leaves the site: ${value}`);
        continue;
      }
      if (pathPart.endsWith('/') || (existsSync(target) && statSync(target).isDirectory())) target = join(target, 'index.html');
      if (!existsSync(target)) {
        problems.push(`${page}: broken ${attr}: ${value}`);
        continue;
      }
      if (hash && target.endsWith('.html') && !ids(read(target)).has(decodeURIComponent(hash))) {
        problems.push(`${page}: missing anchor: ${value}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? join(here, 'dist'));
  const problems = checkSite(dir, { basePath: (process.env.SITE_BASE_PATH ?? '/').replace(/\/*$/, '/') });
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `site check: ${dir} is fine` : `site check: ${problems.length} problems`);
  process.exit(problems.length === 0 ? 0 : 1);
}
