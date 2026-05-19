import {
  type BrowserCommandResult,
  type RuntimeConnectionSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeTabSnapshot,
} from '@shared/protocol';
import type { RuntimeBridge } from '../runtime/runtime-bridge';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';
import {
  parseBrowserCommandRequest,
  timeoutForBrowserCommand,
  type CreateTabInput,
  type WaitEventsInput,
} from './command-contracts';

export interface ExecutionTarget {
  runtime?: RuntimeConnectionSnapshot;
  tab: RuntimeTabSnapshot;
}

export class BrowserSessionService {
  constructor(private readonly runtimeBridge: RuntimeBridge) {}

  status(): RuntimeSessionSnapshot {
    return this.runtimeBridge.getSessionStatus();
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
