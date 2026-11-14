import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Builds the web client and then `fcd` (which embeds apps/web/dist). With
 * FCD_BIN set, the ready binary is used as is (CI builds it beforehand).
 */
export default function globalSetup(): void {
  const bin = process.env['FCD_BIN'];
  if (bin) {
    if (!existsSync(bin)) throw new Error(`FCD_BIN=${bin} does not exist`);
    return;
  }
  execFileSync('pnpm', ['--filter', '@family-chat/web', 'run', 'build'], { cwd: repo, stdio: 'inherit' });
  execFileSync('cargo', ['build', '--manifest-path', join(repo, 'server/Cargo.toml')], { cwd: repo, stdio: 'inherit' });
}
