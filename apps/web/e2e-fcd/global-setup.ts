import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FCD_PORT } from '../playwright.fcd.config.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Builds the web client and `fcd` (unless FCD_BIN points to a ready binary),
 * starts it with `--m0` on a fresh data folder and hands the administrator
 * code, printed once at first start, to the tests via the environment.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  let bin = process.env['FCD_BIN'];
  if (!bin) {
    execFileSync('pnpm', ['--filter', '@family-chat/web', 'run', 'build'], { cwd: repo, stdio: 'inherit' });
    execFileSync('cargo', ['build', '--manifest-path', join(repo, 'server/Cargo.toml')], { cwd: repo, stdio: 'inherit' });
    bin = join(repo, 'server/target/debug/fcd');
  }
  const data = mkdtempSync(join(tmpdir(), 'fcd-e2e-'));
  const proc = spawn(bin, ['--data', data, '--listen', '127.0.0.1', '--port', String(FCD_PORT), '--m0', '--family-name', 'E2E'], {
    env: { ...process.env, NO_COLOR: '1', RUST_LOG: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const code = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`fcd did not start:\n${out}`)), 30_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const m = /код администратора: ([0-9A-Z-]{19})/.exec(out);
      if (m && out.includes('слушаю')) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (c) => reject(new Error(`fcd exited with ${c}:\n${out}`)));
  });
  process.env['FCD_ADMIN_CODE'] = code;

  return async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    rmSync(data, { recursive: true, force: true });
  };
}
