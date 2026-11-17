// Starts a real `fcd` on a temporary data folder and a port chosen by the
// system. Every spec file gets its own server (and so its own admin code).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
export const FCD_BIN = process.env['FCD_BIN'] ?? join(repo, 'server/target/debug/fcd');

export class Fcd {
  readonly data = mkdtempSync(join(tmpdir(), 'fcd-web-e2e-'));
  port = 0;
  adminCode = '';
  output = '';
  #proc: ChildProcess | undefined;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(familyName = 'Ивановы', extraArgs: readonly string[] = []): Promise<void> {
    const proc = spawn(
      FCD_BIN,
      ['--data', this.data, '--listen', '127.0.0.1', '--port', '0', '--push', 'false', '--lang', 'ru', '--family-name', familyName, ...extraArgs],
      { env: { ...process.env, NO_COLOR: '1', RUST_LOG: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.#proc = proc;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fcd did not start:\n${this.output}`)), 30_000);
      const onData = (chunk: Buffer) => {
        this.output += chunk.toString();
        const code = /код администратора сервера: ([0-9A-Z-]{19})/.exec(this.output);
        if (code) this.adminCode = code[1]!;
        const addr = /слушаю 127\.0\.0\.1:(\d+)/.exec(this.output);
        if (addr && this.adminCode) {
          this.port = Number(addr[1]);
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.once('exit', (c) => {
        clearTimeout(timer);
        reject(new Error(`fcd exited with ${c}:\n${this.output}`));
      });
    });
  }

  async dispose(): Promise<void> {
    const proc = this.#proc;
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    rmSync(this.data, { recursive: true, force: true });
  }
}
