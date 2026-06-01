import {
  type BrowserCommandResult,
  type BrowserScreenshotResult,
  type RuntimeConnectionSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeTabSnapshot,
} from '@shared/protocol';
import type { RuntimeBridge } from '../runtime/runtime-bridge';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';
import {
  parseBrowserCommandRequest,
  timeoutForBrowserCommand,
  type BrowserScreenshotInput,
  type CreateTabInput,
  type WaitEventsInput,
} from './command-contracts';
import { storeBrowserScreenshot } from './screenshot-store';

export interface ExecutionTarget {
  runtime?: RuntimeConnectionSnapshot;
  tab: RuntimeTabSnapshot;
}

export class BrowserSessionService {
  constructor(private readonly runtimeBridge: RuntimeBridge) {}

  status(): RuntimeSessionSnapshot {
    return this.runtimeBridge.getSessionStatus();
  }

  async screenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult> {
    this.assertConnected();
    const parsed = parseBrowserCommandRequest('browser_screenshot', input);
    const commandResult = await this.runtimeBridge.executeBrowserCommand(
      'browser_screenshot',
      {
        type: parsed.type,
        quality: parsed.quality,
        fullPage: parsed.fullPage,
        omitBackground: parsed.omitBackground,
      },
      { tabId: parsed.tabId },
    );
    if (commandResult.result.encoding === 'file') {
      return summarizeScreenshotResult(commandResult);
    }

    const stored = await storeBrowserScreenshot(commandResult.result);
    return summarizeScreenshotResult({
      ...commandResult,
      result: { ...stored },
    });
  }

  async newTab(input: CreateTabInput): Promise<BrowserCommandResult> {
    this.assertConnected();
    const parsed = parseBrowserCommandRequest('create_tab', input);
    return await this.runtimeBridge.executeBrowserCommand('create_tab', parsed);
  }

  async waitEvents(
    input: WaitEventsInput,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResult> {
    this.assertConnected();
    const parsed = parseBrowserCommandRequest('wait_events', input);
    return await this.runtimeBridge.executeBrowserCommand(
      'wait_events',
      { durationMs: parsed.durationMs },
      {
        tabId: parsed.tabId,
        timeoutMs: timeoutForBrowserCommand('wait_events', parsed),
        onEvent,
      },
    );
  }

  resolveExecutionTarget(tabId?: number): ExecutionTarget {
    const session = this.status();
    if (!session.connected) {
      throw new RuntimeBridgeError('Browser runtime is not connected.', 'RUNTIME_DISCONNECTED');
    }

    const runtime = selectRuntimeForTab(session.runtimes, tabId);
    const tab = selectTabForRuntime(runtime, session.activeTab, session.tabs, tabId);
    if (!tab) {
      throw new RuntimeBridgeError('No active browser tab is available.', 'TAB_NOT_FOUND');
    }

    return { runtime, tab };
  }

  private assertConnected(): void {
    const session = this.status();
    if (!session.connected) {
      throw new RuntimeBridgeError('Browser runtime is not connected.', 'RUNTIME_DISCONNECTED');
    }
  }
}

function summarizeScreenshotResult(commandResult: BrowserCommandResult): BrowserScreenshotResult {
  if (typeof commandResult.result.path !== 'string' || commandResult.result.path.length === 0) {
    throw new RuntimeBridgeError(
      'Browser screenshot did not return a file path.',
      'EXECUTION_FAILED',
    );
  }

  return {
    result: {
      path: commandResult.result.path,
      ...(typeof commandResult.result.sizeBytes === 'number'
        ? { sizeBytes: commandResult.result.sizeBytes }
        : {}),
    },
    timingMs: commandResult.timingMs,
    tab: {
      tabId: commandResult.tab.tabId,
      url: commandResult.tab.url,
      title: commandResult.tab.title,
    },
  };
}

function selectRuntimeForTab(
  runtimes: RuntimeConnectionSnapshot[] | undefined,
  tabId?: number,
): RuntimeConnectionSnapshot | undefined {
  if (!runtimes?.length) {
    return undefined;
  }

  if (tabId !== undefined) {
    return runtimes.find((runtime) => runtime.tabs.some((tab) => tab.tabId === tabId));
  }

  return runtimes.find((runtime) => runtime.activeTab) ?? runtimes[0];
}

function selectTabForRuntime(
  runtime: RuntimeConnectionSnapshot | undefined,
  activeTab: RuntimeTabSnapshot | undefined,
  tabs: RuntimeTabSnapshot[],
  tabId?: number,
): RuntimeTabSnapshot | undefined {
  if (tabId !== undefined) {
    return runtime?.tabs.find((tab) => tab.tabId === tabId) ?? tabs.find((tab) => tab.tabId === tabId);
  }

  return runtime?.activeTab ?? runtime?.tabs[0] ?? activeTab ?? tabs[0];
}
