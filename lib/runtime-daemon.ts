#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebCapAgentApp } from './server/app';
import { WebCapRpcServer } from './server/app-rpc';
import { resolveWebCapBuildId } from './server/build-id';
import { WebSocketRuntimeBridge } from './server/runtime/websocket-runtime-bridge';

export const DEFAULT_DAEMON_IDLE_TIMEOUT_MS = 60_000;

interface EnvironmentLike {
  WEB_CAP_DAEMON_IDLE_TIMEOUT_MS?: string;
}

export function getDaemonIdleTimeoutMs(env: EnvironmentLike = process.env): number {
  const rawValue = env.WEB_CAP_DAEMON_IDLE_TIMEOUT_MS;
  if (!rawValue) {
    return DEFAULT_DAEMON_IDLE_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawValue);
  if (!Number.isFinite(timeoutMs)) {
    throw new Error(`Invalid WEB_CAP_DAEMON_IDLE_TIMEOUT_MS: ${rawValue}`);
  }

  return Math.max(0, Math.trunc(timeoutMs));
}

export class DaemonIdleShutdown {
  private timer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly shutdown: () => Promise<void> | void,
    private readonly onError: (error: unknown) => void = (error) => {
      console.error('WEB_CAP runtime daemon idle shutdown failed:', error);
    },
  ) {}

  handleClientCountChanged(clientCount: number): void {
    if (this.shuttingDown) {
      return;
    }

    if (clientCount > 0) {
      this.cancel();
      return;
    }

    this.schedule();
  }

  cancel(): void {
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.cancel();
    if (this.timeoutMs <= 0) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runShutdown();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  private async runShutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.timer = undefined;

    try {
      await this.shutdown();
    } catch (error) {
      this.onError(error);
    }
  }
}

async function main(): Promise<void> {
  const buildId = await resolveWebCapBuildId();
  let rpcClientCount = 0;
  let runtimeCount = 0;
  let idleShutdown: DaemonIdleShutdown | undefined;
  const handleActiveConnectionCountChanged = () => {
    idleShutdown?.handleClientCountChanged(rpcClientCount + runtimeCount);
  };
  const runtimeBridge = new WebSocketRuntimeBridge({
    onRuntimeCountChanged: (count) => {
      runtimeCount = count;
      handleActiveConnectionCountChanged();
    },
  });
  const app = new WebCapAgentApp({ runtimeBridge });
  runtimeBridge.setScriptHistoryLoader(() => app.scriptHistoryList());
  runtimeBridge.setScriptRegistryLoader(() => app.scriptRegistryList());
  const rpcServer = new WebCapRpcServer(app, undefined, {
    buildId,
    onClientCountChanged: (clientCount) => {
      rpcClientCount = clientCount;
      handleActiveConnectionCountChanged();
    },
  });

  await app.start();
  await rpcServer.start();

  const close = async () => {
    idleShutdown?.cancel();
    await rpcServer.close();
    await app.close();
  };

  idleShutdown = new DaemonIdleShutdown(
    getDaemonIdleTimeoutMs(),
    async () => {
      await close();
      process.exit(0);
    },
    (error) => {
      console.error('WEB_CAP runtime daemon idle shutdown failed:', error);
      process.exit(1);
    },
  );
  rpcClientCount = rpcServer.getClientCount();
  runtimeCount = runtimeBridge.getRuntimeCount();
  handleActiveConnectionCountChanged();

  process.on('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
}

if (isDirectEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('WEB_CAP runtime daemon failed to start:', error);
    process.exit(1);
  });
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
