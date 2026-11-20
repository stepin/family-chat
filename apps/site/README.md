# apps/site

Static site of Family Chat: plain HTML and CSS built by `build.mjs`, no client-side JavaScript, nothing loaded
from other sites. The documentation pages are rendered from `docs/*.md` and `docs/en/*.md`, which stay the single
source of truth (they read fine on their own in the repository).

```sh
pnpm --filter @family-chat/site run build        # dist/
pnpm --filter @family-chat/site run preview      # http://127.0.0.1:4180/
pnpm --filter @family-chat/site test             # build, links and anchors, placeholders, deploy/ examples in the docs
pnpm test:e2e:site                               # Chromium: axe in light and dark, 360 px, keyboard, the menu
pnpm site:screenshots                            # regenerate screenshots/ from a real fcd (FCD_BIN=...)
```

- `src/home.*.html`: home pages; `src/site.css` on top of the app's `tokens.css` (same token names, a warmer palette).
- `images/`: illustrations of the home page, generated with an image model; how they were made is in
  `images/README.md`.
- `site.config.mjs`: the repository URL, image name and base path. The docs name the project's own
  repository (`https://github.com/stepin/family-chat`) and image (`ghcr.io/stepin/fcd`). A fork that publishes
  its own site sets `SITE_REPOSITORY_URL` and `SITE_IMAGE` (environment or repository variables of its
  workflow); the build writes them in place of the project's ones. `SITE_BASE_PATH`: `/` for its own domain,
  `/family-chat/` for a GitHub Pages project site (`site.yml` sets it).
- `check.mjs`: internal links, anchors, CSP, no scripts, no placeholders of the time before publication
  (`file:line: found "..."`), no `app/`.
- `screenshots/`: committed PNG files made by `e2e-shots/screenshots.spec.ts` against a real `fcd` with an invented
  family. They are committed so that the site build needs neither a browser nor Rust.
- No app on the site: the app always opens from the family's own server (the site and the server are not
  connected). The home page says where to open it.

Security headers. Every page carries its policy in a `<meta>` tag (works on any static host):
`default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`. A host that can set
headers should also send `Content-Security-Policy` with the same value plus `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
