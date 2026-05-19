import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWebCapStateDir } from './server/state-dir';

export function startDetachedDaemon(): void {
  const daemonPath = resolveRuntimeDaemonPath();
  const logDir = join(resolveWebCapStateDir(process.env), 'logs');
  mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, 'runtime-daemon.log'), 'a');
  const err = openSync(join(logDir, 'runtime-daemon.error.log'), 'a');
  const child = spawn(process.execPath, [...process.execArgv, daemonPath], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
}

function resolveRuntimeDaemonPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath) || '.js';
  return join(dirname(currentPath), `runtime-daemon${extension}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
