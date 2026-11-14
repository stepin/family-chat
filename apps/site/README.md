# apps/site

Static site of Family Chat: plain HTML and CSS built by `build.mjs`, no client-side JavaScript, nothing loaded
from other sites. The documentation pages are rendered from `docs/*.md` and `docs/en/*.md`, which stay the single
source of truth (they read fine on their own in the repository).

```sh
pnpm --filter @family-chat/site run build        # dist/, with the web client under dist/app/ if apps/web/dist exists
pnpm --filter @family-chat/site run preview      # http://127.0.0.1:4180/
pnpm --filter @family-chat/site test             # build, internal links and anchors, deploy/ examples in the docs
pnpm test:e2e:site                               # Chromium: axe in light and dark, 360 px, keyboard, app/ subpath
pnpm site:screenshots                            # regenerate screenshots/ from a real fcd (FCD_BIN=...)
```

- `src/home.*.html`: home pages; `src/site.css` on top of the app's `tokens.css`.
- `site.config.mjs`: values known only at publication (repository URL, image name, base path), also from the
  environment (`SITE_REPOSITORY_URL`, `SITE_IMAGE`, `SITE_BASE_PATH`). They replace the obvious placeholders of
  the docs (`https://code.example.org/family-chat`, `registry.example.org/family-chat/fcd`).
- `screenshots/`: committed PNG files made by `e2e-shots/screenshots.spec.ts` against a real `fcd` with an invented
  family. They are committed so that the site build needs neither a browser nor Rust.
- `app/`: the same web client as inside `fcd`, for people who do not want to trust the server admin with the
  client code. The client build is path independent (relative base, manifest scope and service worker scope).

Security headers. Every page carries its policy in a `<meta>` tag (works on any static host):
`default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`. A host that can set
headers should also send `Content-Security-Policy` with the same value plus `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` for the site pages, and for `/app/` the
policy of `server/src/headers.rs` (`client_csp_header()`).
