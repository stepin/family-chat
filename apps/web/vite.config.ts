import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

/**
 * Git commit shown next to the version (Settings, the diagnostics report):
 * FCD_GIT_COMMIT (release builds, Docker), else `git rev-parse`, else empty.
 * The same rule as server/build.rs, so client and server name the same commit.
 */
function gitCommit(): string {
  const fromEnv = process.env['FCD_GIT_COMMIT'];
  let c = fromEnv ?? '';
  if (fromEnv === undefined) {
    try {
      c = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      c = '';
    }
  }
  c = c.trim().slice(0, 12);
  return /^[0-9a-f]+$/i.test(c) ? c : '';
}

/**
 * Content-Security-Policy (docs/PLAN.md 7.6), delivered in a <meta> tag (and
 * by fcd as a header, which adds `frame-ancestors`). Only for the build: the
 * dev server injects inline styles. `connect-src https:` because the server
 * address can be typed by the administrator; 'self' covers plain-HTTP use on
 * the same origin. `frame-ancestors` cannot be set in <meta>. `media-src blob:`:
 * voice messages play from blob: URLs of app storage (M3). Keep in sync with
 * server/src/headers.rs (a test there compares the two).
 *
 * M5, several family servers: the app opened from one server talks to the
 * others directly (CORS `*`, bearer tokens). `https:` already covers every
 * other family server on the internet; a list of the family's servers cannot
 * be put into a static policy (the person adds them later, and a <meta> tag or
 * a header cannot change at run time). The only addition is plain HTTP on
 * this computer's loopback addresses (`http://localhost:*`,
 * `http://127.0.0.1:*`): browsers treat them as secure
 * contexts, so a second server on the same machine works without TLS (and the
 * end-to-end tests run two servers that way). Any other plain-HTTP address is
 * still refused (and an HTTPS page could not reach it anyway: mixed content).
 * Stickers need nothing new: images are blob: URLs, the light Lottie build
 * draws SVG through the DOM and needs no `unsafe-eval`.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'family-chat:csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          '<meta charset="utf-8" />',
          `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        );
      },
    },
  };
}

/**
 * vite-plugin-pwa writes `./manifest.webmanifest` into every page; pages in
 * subfolders (device/, server/) need `../`.
 */
function subpageManifestLink(): Plugin {
  return {
    name: 'family-chat:subpage-manifest-link',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const depth = ctx.path.split('/').length - 2;
        if (depth <= 0) return html;
        return html.replace('href="./manifest.webmanifest"', `href="${'../'.repeat(depth)}manifest.webmanifest"`);
      },
    },
  };
}

// Path-independent build (docs/PLAN.md 6.11): relative base, relative
// start_url and scope, manifest fetched with credentials.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [
    svelte(),
    VitePWA({
      // A new version waits for the person's confirmation (update banner).
      registerType: 'prompt',
      // Registered from src/pwa.ts relative to the bundle, so that pages in
      // subfolders register the same root-scoped worker.
      injectRegister: false,
      useCredentials: true,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Family Chat',
        short_name: 'Family Chat',
        // Language neutral (M7): the app speaks Russian or English, the manifest is one for both.
        description: 'Family Chat',
        // "und" (undetermined, BCP 47): otherwise vite-plugin-pwa writes "en".
        lang: 'und',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f6f3ee',
        theme_color: '#2f5d50',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Web Share Target (M5): "Поделиться" from other apps into a chat. The
        // service worker (public/push-sw.js) answers this POST, keeps the
        // content on the device and opens the app.
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'files', accept: ['image/*', 'video/*', 'audio/*', 'application/pdf', 'text/*', '*/*'] }],
          },
        },
      },
      workbox: {
        // App shell only; requests to /v1 are never cached.
        globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
        navigateFallback: null,
        // Push and notification-click handlers (public/push-sw.js).
        importScripts: ['push-sw.js'],
      },
    }),
    subpageManifestLink(),
    cspMeta(),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        device: resolve(import.meta.dirname, 'device/index.html'),
        server: resolve(import.meta.dirname, 'server/index.html'),
      },
      output: {
        // Named shared chunks (they change at different speeds, so the
        // service worker re-downloads less after an update). Screens used
        // once or rarely (onboarding, settings, the image viewer, the place
        // sheet, the recorder) are dynamic imports in the code.
        codeSplitting: {
          groups: [
            { name: 'crypto', test: /node_modules[\\/].*@(noble|scure)[\\/]/, priority: 3 },
            // Only what the first screen needs; other libraries (the QR code) stay with their screen.
            { name: 'vendor', test: /node_modules[\\/].*(svelte|dexie|esm-env|clsx)[\\/]/, priority: 2 },
            // M5: the sticker import pipeline and the .tgs reader stay out of it (loaded on first use).
            { name: 'core', test: /packages[\\/](core|protocol)[\\/](?!src[\\/]stickers[\\/](import|tgs|zip)\.ts$)/, priority: 1 },
          ],
        },
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
