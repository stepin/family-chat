// Starts a real `fcd` on a temporary data folder for integration tests.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
export const FCD_BIN = process.env['FCD_BIN'] ?? join(repo, 'server/target/debug/fcd');

export class Fcd {
  readonly data: string;
  port = 0;
  adminCode = '';
  #proc: ChildProcess | undefined;
  #started = false;
  /** Everything the server printed (for debugging failed tests and for the secrets check). */
  output = '';

  constructor() {
    this.data = mkdtempSync(join(tmpdir(), 'fcd-core-it-'));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts the server (first start creates the folder and prints the admin code). */
  async start(): Promise<void> {
    const proc = spawn(
      FCD_BIN,
      ['--data', this.data, '--listen', '127.0.0.1', '--port', String(this.port), '--push', 'false', '--lang', 'ru', '--family-name', 'Тест'],
      { env: { ...process.env, NO_COLOR: '1', RUST_LOG: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.#proc = proc;
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`fcd did not start:\n${out}`)), 30_000);
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        this.output += chunk.toString();
        const code = /код администратора сервера: ([0-9A-Z-]{19})/.exec(out);
        if (code) this.adminCode = code[1]!;
        const addr = /слушаю 127\.0\.0\.1:(\d+)/.exec(out);
        // On the first start the admin code is printed after the address.
        const ready = addr && (this.adminCode || /участников [1-9]/.test(out) || this.#started);
        if (addr && ready) {
          this.#started = true;
          this.port = Number(addr[1]);
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.once('exit', (c) => {
        clearTimeout(timer);
        reject(new Error(`fcd exited with ${c}:\n${out}`));
      });
    });
  }

  /** Graceful stop (SIGTERM); the data folder stays. */
  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 12_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    this.#proc = undefined;
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.data, { recursive: true, force: true });
  }
}
