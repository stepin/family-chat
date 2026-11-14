import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** The site with the web client under app/: builds the client first if needed. */
export default function globalSetup(): void {
  if (!existsSync(`${repo}apps/web/dist/index.html`)) {
    execFileSync('pnpm', ['--filter', '@family-chat/web...', 'run', 'build'], { cwd: repo, stdio: 'inherit' });
  }
  execFileSync('node', ['build.mjs'], { cwd: `${repo}apps/site`, stdio: 'inherit' });
}
