// Builds what the integration tests need: the web client (fcd embeds
// apps/web/dist) when it is missing, then the fcd debug binary.
// Skipped entirely when FCD_BIN points to a ready binary.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

if (process.env.FCD_BIN) {
  if (!existsSync(process.env.FCD_BIN)) {
    console.error(`FCD_BIN=${process.env.FCD_BIN} does not exist`);
    process.exit(1);
  }
  process.exit(0);
}
if (!existsSync(join(repo, 'apps/web/dist/index.html'))) {
  execFileSync('pnpm', ['--filter', '@family-chat/web', 'run', 'build'], { cwd: repo, stdio: 'inherit' });
}
execFileSync('cargo', ['build', '--manifest-path', join(repo, 'server/Cargo.toml')], { cwd: repo, stdio: 'inherit' });
