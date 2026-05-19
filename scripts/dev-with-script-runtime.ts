import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crossSpawn from 'cross-spawn';

type ChildProcess = ReturnType<typeof crossSpawn.spawn>;

interface RuntimeToolRunner {
  spawn: typeof crossSpawn.spawn;
  sync: typeof crossSpawn.sync;
}

export function runDevWithScriptRuntime(
  wxtArgs = process.argv.slice(2),
  runner: RuntimeToolRunner = crossSpawn,
): void {
  const initialGenerate = runner.sync('tsx', ['scripts/generate-script-runtime.ts'], {
    stdio: 'inherit',
  });

  if (initialGenerate.error) {
    throw initialGenerate.error;
  }

  if (initialGenerate.status !== 0) {
    process.exit(initialGenerate.status ?? 1);
  }

  const processes = [
    runner.spawn('tsx', ['scripts/generate-script-runtime.ts', '--watch'], {
      stdio: 'inherit',
    }),
    runner.spawn('wxt', wxtArgs, {
      stdio: 'inherit',
    }),
  ];

  installShutdownHandlers(processes);
}

export function installShutdownHandlers(processes: ChildProcess[]): void {
  let shuttingDown = false;
  const shutdown = (signal?: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopProcesses(processes, signal);
  };

  for (const child of processes) {
    child.on('exit', (code, signal) => {
      shutdown(signal ?? undefined);
      if (code && code !== 0) {
        process.exitCode = code;
      }
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function stopProcesses(processes: ChildProcess[], signal?: NodeJS.Signals): void {
  for (const child of processes) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

if (isDirectEntryPoint(import.meta.url, process.argv[1])) {
  runDevWithScriptRuntime();
}

function isDirectEntryPoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(moduleUrl) === argvPath;
  }
}
