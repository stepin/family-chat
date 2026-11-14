import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

/**
 * Content-Security-Policy (docs/PLAN.md 7.6), delivered in a <meta> tag in
 * M1 (fcd does not send it as a header yet). Only for the build: the dev
 * server injects inline styles. `connect-src https:` because the server
 * address can be typed by the administrator; 'self' covers plain-HTTP use on
 * the same origin. `frame-ancestors` cannot be set in <meta>. `media-src blob:`:
 * voice messages play from blob: URLs of app storage (M3). Keep in sync with
 * server/src/headers.rs (a test there compares the two).
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src blob:",
  "font-src 'self'",
  "connect-src 'self' https:",
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
        description: 'Семейный чат',
        lang: 'ru',
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
            { name: 'core', test: /packages[\\/](core|protocol)[\\/]/, priority: 1 },
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
