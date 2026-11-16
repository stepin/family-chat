import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** Builds the site (it carries no app: M8). */
export default function globalSetup(): void {
  execFileSync('node', ['build.mjs'], { cwd: `${repo}apps/site`, stdio: 'inherit' });
}
