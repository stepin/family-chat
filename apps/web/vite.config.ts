import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

/**
 * vite-plugin-pwa writes `./manifest.webmanifest` into every page; pages in
 * subfolders (probe/, device/) need `../`.
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
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
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
        // App shell only; requests to WebDAV servers and to /v1 are never cached.
        globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
        navigateFallback: null,
        // Push and notification-click handlers (public/push-sw.js).
        importScripts: ['push-sw.js'],
      },
    }),
    subpageManifestLink(),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        probe: resolve(import.meta.dirname, 'probe/index.html'),
        device: resolve(import.meta.dirname, 'device/index.html'),
        server: resolve(import.meta.dirname, 'server/index.html'),
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
