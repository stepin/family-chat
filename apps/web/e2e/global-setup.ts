import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM helper without types
import { waitForServers } from '../../../tools/dav-dev/wait.mjs';

/** Starts tools/dav-dev in Docker unless its servers already answer. */
export default async function globalSetup(): Promise<void> {
  try {
    await waitForServers(2_000);
    return;
  } catch {
    // not running yet
  }
  const cwd = fileURLToPath(new URL('../../../tools/dav-dev/', import.meta.url));
  execFileSync('docker', ['compose', 'up', '-d', '--build', '--remove-orphans'], { cwd, stdio: 'inherit' });
  await waitForServers(120_000);
}
