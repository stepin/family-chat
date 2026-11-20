// A tiny static server for previewing the built site (and for its tests):
//   node serve.mjs [DIR] [PORT]     defaults: dist 4180, address 127.0.0.1
// Directories answer with their index.html, missing files with 404.html.
// It sends no Content-Security-Policy header on purpose: the pages must be
// safe with their own <meta> policy, as on a host that cannot set headers.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function serve(dir, port = 4180, host = '127.0.0.1') {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(400).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      file = join(file, 'index.html');
    }
    let status = 200;
    if (!existsSync(file)) {
      status = 404;
      file = join(root, '404.html');
      // No 404 page (the site is not built yet): a plain answer, not a crash.
      if (!existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
        return;
      }
    }
    const headers = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] ?? 'dist';
  const port = Number(process.argv[3] ?? 4180);
  await serve(dir, port);
  console.log(`site: http://127.0.0.1:${port}/ (${resolve(dir)})`);
}
