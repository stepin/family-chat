// Placeholder until M6 (Astro site with docs, RU and EN): copies public/ to dist/.
import { cpSync, rmSync } from 'node:fs';

rmSync(new URL('./dist/', import.meta.url), { recursive: true, force: true });
cpSync(new URL('./public/', import.meta.url), new URL('./dist/', import.meta.url), { recursive: true });
console.log('site: placeholder copied to dist/');
