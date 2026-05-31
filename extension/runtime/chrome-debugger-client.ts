import type { ChromeLike, DebuggeeTarget } from './debugger-types';

interface AttachedSession {
  ready: Promise<void>;
  refCount: number;
  idleDetachTimer?: ReturnType<typeof setTimeout>;
}

const DEBUGGER_VERSION = '1.3';
const DEFAULT_IDLE_DETACH_DELAY_MS = 60_000;
const DEFAULT_DEBUGGER_OPERATION_TIMEOUT_MS = 10_000;

export class ChromeDebuggerClient {
  private readonly sessions = new Map<number, AttachedSession>();

  constructor(
    private readonly idleDetachDelayMs = DEFAULT_IDLE_DETACH_DELAY_MS,
    private readonly onIdleDetach?: (tabId: number) => void,
    private readonly operationTimeoutMs = DEFAULT_DEBUGGER_OPERATION_TIMEOUT_MS,
  ) {}

  isAvailable(): boolean {
    return !!this.getChromeApi()?.debugger;
  }

  async withAttachedDebugger<T>(
    tabId: number,
    callback: (target: DebuggeeTarget) => Promise<T>,
  ): Promise<T> {
    await this.acquire(tabId);
    try {
      return await callback({ tabId });
    } finally {
      await this.release(tabId);
    }
  }

  async sendCommand<T>(
    target: DebuggeeTarget,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<T> {
    const chromeApi = this.getChromeApi();
    if (!chromeApi?.debugger || !chromeApi.runtime) {
      throw new Error('chrome.debugger is not available in this browser runtime.');
    }

    return await this.withTimeout<T>(`chrome.debugger.sendCommand(${method})`, (resolve, reject) => {
      chromeApi.debugger?.sendCommand(
        target,
        method,
        commandParams ?? {},
        (result?: unknown) => {
          const error = chromeApi.runtime?.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(result as T);
        },
      );
    });
  }

  getChromeApi(): ChromeLike | undefined {
    return (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome;
  }

  private async acquire(tabId: number): Promise<void> {
    const existing = this.sessions.get(tabId);
    if (existing) {
      if (existing.idleDetachTimer) {
        clearTimeout(existing.idleDetachTimer);
        existing.idleDetachTimer = undefined;
      }
      existing.refCount += 1;
      await existing.ready;
      return;
    }

    const session: AttachedSession = {
      refCount: 1,
      ready: this.attach({ tabId }),
    };
    this.sessions.set(tabId, session);

    try {
      await session.ready;
    } catch (error) {
      this.sessions.delete(tabId);
      throw error;
    }
  }

  private async release(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) {
      return;
    }

    session.refCount -= 1;
    if (session.refCount > 0) {
      return;
    }

    if (session.idleDetachTimer) {
      clearTimeout(session.idleDetachTimer);
    }

    session.idleDetachTimer = setTimeout(() => {
      void this.detachIdleSession(tabId, session);
    }, this.idleDetachDelayMs);
  }

  private async detachIdleSession(tabId: number, session: AttachedSession): Promise<void> {
    const current = this.sessions.get(tabId);
    if (!current || current !== session || current.refCount > 0) {
      return;
    }

    current.idleDetachTimer = undefined;
    this.sessions.delete(tabId);
    await current.ready.catch(() => undefined);
    this.onIdleDetach?.(tabId);
    await this.detach({ tabId });
  }

  private async attach(target: DebuggeeTarget): Promise<void> {
    const chromeApi = this.getChromeApi();
    if (!chromeApi?.debugger || !chromeApi.runtime) {
      throw new Error('chrome.debugger is not available in this browser runtime.');
    }

    await this.withTimeout<void>('chrome.debugger.attach', (resolve, reject) => {
      chromeApi.debugger?.attach(target, DEBUGGER_VERSION, () => {
        const error = chromeApi.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  private async detach(target: DebuggeeTarget): Promise<void> {
    const chromeApi = this.getChromeApi();
    if (!chromeApi?.debugger || !chromeApi.runtime) {
      return;
    }

    await this.withTimeout<void>('chrome.debugger.detach', (resolve, reject) => {
      chromeApi.debugger?.detach(target, () => {
        const error = chromeApi.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    }).catch(() => undefined);
  }

  private async withTimeout<T>(
    label: string,
    start: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`${label} timed out after ${this.operationTimeoutMs}ms.`));
      }, this.operationTimeoutMs);

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      try {
        start(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
}
