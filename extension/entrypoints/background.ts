import type { ScriptDefinition, UserScriptDefinition } from '@shared/script-schema';
import { MatchPattern } from '@webext-core/match-patterns';
import {
  DEFAULT_RUNTIME_PORT,
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  createRuntimeEnvelope,
  type BrowserCommandName,
  type ExecutionEvidence,
  type ExecutionEvidenceEvent,
  type ExecutionEvidenceOption,
  type RuntimeEnvelope,
  type RuntimeScreenshotArtifactPayload,
  type ScriptExecutionHistoryEntry,
  type RuntimeTabSnapshot,
} from '@shared/protocol';
import { DebuggerScriptExecutor } from '../runtime/debugger-executor';
import {
  scriptRequiresBrowserLevelClick,
  scriptRequiresBrowserLevelKeyboard,
  scriptRequiresBrowserLevelWindow,
} from '../runtime/click-routing';
import {
  isDebuggerFallbackEligibleError,
  isExecutionInterruptedByNavigationError,
  type ScriptScreenshotArtifact,
  type ScriptExecutionResponse,
} from '../runtime/execution-helpers';
import {
  createScriptGotoLoopDetector,
  createScriptGotoLoopError,
} from '../runtime/goto-loop-detection';
import { assertNoStaticGotoLoops } from '../runtime/goto-static-analysis';
import { BrowserCommandHandler } from '../runtime/browser-command-handler';
import { UserScriptExecutor } from '../runtime/user-script-executor';

const PROTOCOL_VERSION = '2026-05-05';
const AUTHENTICATED_SITES_KEY = 'authenticatedSites';
const SCRIPT_HISTORY_STORAGE_KEY = 'scriptExecutionHistory';
const SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY = 'scriptExecutionHistoryUpdatedAt';
const SCRIPT_REGISTRY_STORAGE_KEY = 'scriptRegistry';
const SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY = 'scriptRegistryUpdatedAt';
const USERSCRIPT_REGISTRY_STORAGE_KEY = 'userScriptRegistry';
const USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY = 'userScriptRegistryUpdatedAt';
const USERSCRIPT_AVAILABLE_STORAGE_KEY = 'userScriptsAvailable';
const EXECUTION_BADGE_TEXT = 'RUN';
const EXECUTION_BADGE_COLOR = '#2563eb';
const EXECUTION_TAB_GROUP_TITLE = 'RUN';
const EXECUTION_TAB_GROUP_COLOR = 'blue';
const EXECUTION_PAGE_INDICATOR_ID = '__web_cap_execution_indicator__';
const EXECUTION_TAB_INDICATOR_TIMEOUT_MS = 1_000;
const WEB_CAP_GOTO_CONTINUATION_TYPE = 'web_cap.goto';
const MAX_SCRIPT_GOTO_CONTINUATIONS = 20;
const SCRIPT_GOTO_NAVIGATION_TIMEOUT_MS = 30_000;

interface BrowserTabLike {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  openerTabId?: number;
  groupId?: number;
}

type ExecutableBrowserTab = BrowserTabLike & {
  id: number;
  url: string;
};

interface ScriptGotoContinuation {
  __webCapType: typeof WEB_CAP_GOTO_CONTINUATION_TYPE;
  url: string;
  input: Record<string, unknown>;
}

interface ExecutionTabUpdate {
  tabId: number;
  status?: string;
  url?: string;
  title?: string;
}

interface ExecutionObservation {
  requestId: string;
  tabId: number;
  startedUrl: string;
  startedTitle: string;
  createdTabs: Map<number, BrowserTabLike>;
  targetUpdates: ExecutionTabUpdate[];
}

interface ExecutionTabIndicatorState {
  requestIds: Set<string>;
  pageIndicatorRequestIds: Set<string>;
  pageIndicatorApplied: boolean;
  tabGroupIndicatorRequestIds: Set<string>;
  tabGroupSnapshot?: ExecutionTabGroupSnapshot;
}

interface ExecutionTabGroupSnapshot {
  groupId: number;
  title?: string;
  color?: string;
  createdGroup: boolean;
}

interface BrowserTabGroupLike {
  id: number;
  title?: string;
  color?: string;
}

interface NativeTabGroupsApi {
  tabs?: {
    group(options: { tabIds: number | number[] }): Promise<number>;
    ungroup(tabIds: number | number[]): Promise<void>;
  };
  tabGroups?: {
    get(groupId: number): Promise<BrowserTabGroupLike>;
    update(
      groupId: number,
      properties: { title?: string; color?: string },
    ): Promise<BrowserTabGroupLike>;
  };
}

interface VisibleElementsDebugTiming {
  scriptTimingMs: number;
  beforeSnapshotTimingMs: number;
  postActionDelayMs: number;
  afterSnapshotTimingMs: number;
  diffTimingMs: number;
}

interface ChromeUserScriptsLike {
  userScripts?: {
    execute?(injection: UserScriptInjection): Promise<unknown[]>;
    register?(scripts: UserScriptRegistration[]): Promise<void>;
    unregister?(filter?: { ids?: string[] }): Promise<void>;
  };
}

interface UserScriptInjection {
  injectImmediately?: boolean;
  js: Array<{ code: string }>;
  target: {
    tabId: number;
  };
  world?: 'USER_SCRIPT' | 'MAIN';
}

interface UserScriptRegistration {
  id: string;
  js: Array<{ code: string }>;
  matches: string[];
  runAt: ChromeUserScriptRunAt;
  world?: 'USER_SCRIPT' | 'MAIN';
}

type ChromeUserScriptRunAt = 'document_start' | 'document_end' | 'document_idle';

type ExecutionEvidenceWithDebugTiming = ExecutionEvidence & {
  visibleElementsDebugTiming?: VisibleElementsDebugTiming;
};

class RuntimeClient {
  private socket?: WebSocket;
  private heartbeatTimer?: number;
  private reconnectTimer?: number;
  private sessionId = 'extension-pending';
  private lastActiveTabId?: number;
  private readonly executionObservations: ExecutionObservation[] = [];
  private readonly executionTabIndicators = new Map<number, ExecutionTabIndicatorState>();
  private readonly userScriptExecutor = new UserScriptExecutor();
  private readonly debuggerExecutor = new DebuggerScriptExecutor();
  private currentUserScripts: UserScriptDefinition[] = [];
  private readonly registeredUserScriptIds = new Set<string>();
  private readonly browserCommandHandler = new BrowserCommandHandler({
    setLastActiveTabId: (tabId) => {
      this.lastActiveTabId = tabId;
    },
    sendTabSnapshot: () => this.sendTabSnapshot(),
    toTabSnapshot: (tab) => this.toTabSnapshot(tab),
  }, this.debuggerExecutor.getDebuggerClient());

  start(): void {
    void this.restoreCachedUserScripts();
    this.connect();
    this.installTabListeners();
  }

  private connect(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.socket = new WebSocket(`ws://127.0.0.1:${DEFAULT_RUNTIME_PORT}`);

    this.socket.addEventListener('open', async () => {
      const authenticatedSites = await this.getAuthenticatedSites();
      this.send(
        createRuntimeEnvelope(
          'hello',
          {
            browserName: 'webextension',
            extensionVersion: browser.runtime.getManifest().version,
            protocolVersion: PROTOCOL_VERSION,
            authenticatedSites,
            userScriptsAvailable: this.isUserScriptsAvailable(),
          },
          {
            sessionId: this.sessionId,
          },
        ),
      );

      await this.sendTabSnapshot();
      this.heartbeatTimer = setInterval(() => {
        this.send(createRuntimeEnvelope('heartbeat', {}, { sessionId: this.sessionId }));
      }, RUNTIME_HEARTBEAT_INTERVAL_MS) as unknown as number;
    });

    this.socket.addEventListener('message', async (event) => {
      const envelope = JSON.parse(String(event.data)) as RuntimeEnvelope;
      await this.handleEnvelope(envelope);
    });

    this.socket.addEventListener('close', () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
      this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 3000) as unknown as number;
  }

  private async handleEnvelope(envelope: RuntimeEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'hello_ack':
        this.sessionId = envelope.payload.sessionId;
        break;
      case 'execute_script':
        await this.handleExecuteScript(
          envelope.requestId,
          envelope.payload.scriptDefinition,
          envelope.payload.input,
          envelope.payload.scriptRegistry,
          envelope.payload.tabId,
          envelope.payload.activateTab,
          envelope.payload.evidence ?? [],
          envelope.payload.screenshotArtifactBasePath,
          envelope.payload.mouseTrajectorySimulation === true,
          envelope.payload.executionPageIndicator === true,
          envelope.payload.executionTabGroupIndicator === true,
        );
        break;
      case 'browser_command':
        await this.handleBrowserCommand(
          envelope.requestId,
          envelope.payload.command,
          envelope.payload.input,
          envelope.payload.tabId,
        );
        break;
      case 'script_history_sync':
        await this.storeScriptHistory(envelope.payload.entries, envelope.timestamp);
        break;
      case 'script_registry_sync':
        await this.storeScriptRegistry(envelope.payload.scripts, envelope.timestamp);
        break;
      case 'userscript_registry_sync':
        await this.storeUserScriptRegistry(
          envelope.payload.userscripts,
          envelope.timestamp,
          envelope.payload.applyNowUserScriptIds,
        );
        break;
      default:
        break;
    }
  }

  private async handleExecuteScript(
    requestId: string,
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    scriptRegistry: ScriptDefinition[],
    tabId?: number,
    activateTab?: boolean,
    evidenceOptions: ExecutionEvidenceOption[] = ['common'],
    screenshotArtifactBasePath?: string,
    mouseTrajectorySimulation = false,
    executionPageIndicator = false,
    executionTabGroupIndicator = false,
  ): Promise<void> {
    let selectedTab: BrowserTabLike | undefined;
    try {
      selectedTab = tabId ? await browser.tabs.get(tabId) : await this.getActiveTab();
    } catch (error) {
      this.sendError(
        requestId,
        tabId === undefined ? 'EXECUTION_FAILED' : 'TAB_NOT_FOUND',
        tabId === undefined
          ? error instanceof Error ? error.message : String(error)
          : `Browser tab ${tabId} was not found.`,
        { scriptId: scriptDefinition.id, tabId },
      );
      return;
    }
    if (!selectedTab?.id || !selectedTab.url) {
      this.sendError(
        requestId,
        'TAB_NOT_FOUND',
        tabId === undefined
          ? 'No active browser tab is available.'
          : `Browser tab ${tabId} was not found.`,
        { scriptId: scriptDefinition.id, tabId },
      );
      return;
    }
    let activeTab: ExecutableBrowserTab = {
      ...selectedTab,
      id: selectedTab.id,
      url: selectedTab.url,
    };
    if (activateTab === true) {
      activeTab = await this.activateExecutionTab(activeTab);
    }

    const collectEvents = shouldCollectExecutionEvidence(evidenceOptions, 'events');
    const observation = collectEvents
      ? this.startExecutionObservation(
          requestId,
          activeTab.id,
          activeTab.url,
          activeTab.title ?? '',
        )
      : undefined;

    try {
      console.info('[WEB_CAP] executing script', {
        id: scriptDefinition.id,
        name: scriptDefinition.name,
        version: scriptDefinition.version,
        type: scriptDefinition.type,
      });

      await this.startExecutionTabIndicator(
        activeTab.id,
        requestId,
        executionPageIndicator,
        executionTabGroupIndicator,
      );
      assertNoStaticGotoLoops(scriptDefinition.script.code);

      let response: ScriptExecutionResponse | undefined;
      let currentInput = input;
      let continuationCount = 0;
      const gotoLoopDetector = createScriptGotoLoopDetector();
      const accumulatedEvents: ExecutionEvidenceEvent[] = [];
      const accumulatedScreenshotArtifacts: ScriptScreenshotArtifact[] = [];

      while (true) {
        try {
          response = await this.executeScriptWithFallback(
            requestId,
            activeTab.id,
            scriptDefinition,
            currentInput,
            scriptRegistry,
            evidenceOptions,
            screenshotArtifactBasePath,
            mouseTrajectorySimulation,
          );
        } catch (error) {
          if (!isExecutionInterruptedByNavigationError(error)) {
            throw error;
          }

          const resultEvidence = collectEvents
            ? this.createNavigationInterruptedEvidence(activeTab.url)
            : this.createEmptyExecutionEvidence();
          resultEvidence.events.unshift(...accumulatedEvents);
          await this.wait(300);
          if (observation) {
            resultEvidence.events.push(
              ...(await this.finishExecutionObservation(observation, resultEvidence.events)),
            );
          }
          this.send(
            createRuntimeEnvelope(
              'execution_result',
              {
                result: { navigated: true },
                evidence: resultEvidence,
                status: 'interrupted',
                screenshotArtifacts: this.sendBinaryScreenshotArtifacts(
                  accumulatedScreenshotArtifacts,
                  requestId,
                ),
              },
              { sessionId: this.sessionId, requestId },
            ),
          );
          return;
        }

        accumulatedEvents.push(...(response.evidence?.events ?? []));
        accumulatedScreenshotArtifacts.push(...(response.screenshotArtifacts ?? []));

        if (!response.ok || !response.result) {
          throw new Error(response?.error ?? 'Script execution failed.');
        }

        const continuation = parseScriptGotoContinuation(response.result);
        if (!continuation) {
          break;
        }

        if (continuationCount >= MAX_SCRIPT_GOTO_CONTINUATIONS) {
          throw new Error(
            `Script exceeded ${MAX_SCRIPT_GOTO_CONTINUATIONS} cap.goto continuations.`,
          );
        }

        const nextUrl = this.resolveScriptGotoUrl(continuation.url, activeTab.url);
        const loopDetection = gotoLoopDetector.record({
          url: nextUrl,
          input: continuation.input,
        });
        if (loopDetection) {
          throw createScriptGotoLoopError(loopDetection);
        }
        accumulatedEvents.push({
          type: 'controlled_navigation',
          value: {
            from: activeTab.url,
            to: nextUrl,
            continuation: continuationCount + 1,
          },
        });
        activeTab = await this.navigateExecutionTab(activeTab.id, nextUrl);
        currentInput = continuation.input;
        continuationCount += 1;
      }

      if (!response?.result) {
        throw new Error('Script execution failed.');
      }
      const evidence: ExecutionEvidence = {
        ...(response.evidence ?? { events: [] }),
        events: accumulatedEvents,
      };
      const result = response.result;

      if (observation) {
        await this.wait(300);
        evidence.events.push(
          ...(await this.finishExecutionObservation(observation, evidence.events)),
        );
      }

      if (evidence.visibleElements) {
        const visibleElementsDebugTiming = (evidence as ExecutionEvidenceWithDebugTiming)
          .visibleElementsDebugTiming;
        console.info('[WEB_CAP] visible elements diff', evidence.visibleElements);
        console.info(
          '[WEB_CAP] visible elements diff json',
          JSON.stringify(evidence.visibleElements, null, 2),
        );
        if (visibleElementsDebugTiming) {
          console.info(
            '[WEB_CAP] visible elements diff timing breakdown ms',
            visibleElementsDebugTiming,
          );
        }
      }

      this.send(
        createRuntimeEnvelope(
          'execution_result',
          {
            result,
            evidence,
            status: response.status ?? 'succeeded',
            screenshotArtifacts: this.sendBinaryScreenshotArtifacts(
              accumulatedScreenshotArtifacts,
              requestId,
            ),
          },
          { sessionId: this.sessionId, requestId },
        ),
      );
    } catch (error) {
      if (observation) {
        this.cancelExecutionObservation(observation);
      }
      this.sendError(
        requestId,
        'EXECUTION_FAILED',
        error instanceof Error ? error.message : String(error),
        { scriptId: scriptDefinition.id, tabId: activeTab.id },
      );
    } finally {
      await this.stopExecutionTabIndicator(activeTab.id, requestId);
    }
  }

  private async activateExecutionTab(tab: ExecutableBrowserTab): Promise<ExecutableBrowserTab> {
    if (tab.active) {
      return tab;
    }

    const activated = await browser.tabs.update(tab.id, { active: true });
    this.lastActiveTabId = activated?.id ?? tab.id;
    await this.sendTabSnapshot();
    return {
      ...tab,
      ...activated,
      id: activated?.id ?? tab.id,
      url: activated?.url ?? tab.url,
    };
  }

  private resolveScriptGotoUrl(rawUrl: string, baseUrl: string): string {
    try {
      return new URL(rawUrl, baseUrl).href;
    } catch {
      throw new Error(`cap.goto received an invalid URL: ${rawUrl}`);
    }
  }

  private async navigateExecutionTab(tabId: number, url: string): Promise<ExecutableBrowserTab> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const tabUpdateListener = (
        updatedTabId: number,
        changeInfo: { status?: string; url?: string },
      ) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          settle(resolve);
        }
      };
      const settle = (done: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        browser.tabs.onUpdated.removeListener(tabUpdateListener);
        done();
      };

      timeout = setTimeout(() => {
        settle(() => reject(
          new Error(`Timed out after ${SCRIPT_GOTO_NAVIGATION_TIMEOUT_MS}ms waiting for cap.goto navigation to complete.`),
        ));
      }, SCRIPT_GOTO_NAVIGATION_TIMEOUT_MS);
      browser.tabs.onUpdated.addListener(tabUpdateListener);
      browser.tabs.update(tabId, { url }).catch((error) => {
        settle(() => reject(error));
      });
    });

    await this.wait(150);
    const updated = await browser.tabs.get(tabId);
    if (!updated?.id || !updated.url) {
      throw new Error(`Browser tab ${tabId} was not found after cap.goto navigation.`);
    }
    return {
      ...updated,
      id: updated.id,
      url: updated.url,
    };
  }

  private async executeScriptWithFallback(
    requestId: string,
    tabId: number,
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    scriptRegistry: ScriptDefinition[],
    evidence: ExecutionEvidenceOption[],
    screenshotArtifactBasePath?: string,
    mouseTrajectorySimulation = false,
  ): Promise<ScriptExecutionResponse> {
    const requiresBrowserLevelClick = scriptRequiresBrowserLevelClick(
      scriptDefinition,
      scriptRegistry,
    );
    const requiresBrowserLevelKeyboard = scriptRequiresBrowserLevelKeyboard(
      scriptDefinition,
      scriptRegistry,
    );
    const requiresBrowserLevelWindow = scriptRequiresBrowserLevelWindow(
      scriptDefinition,
      scriptRegistry,
    );

    if (requiresBrowserLevelClick || requiresBrowserLevelKeyboard || requiresBrowserLevelWindow) {
      if (!this.debuggerExecutor.isAvailable()) {
        throw new Error(
          `Script ${scriptDefinition.id} requires browser-level automation, but chrome.debugger is not available in this browser runtime.`,
        );
      }

      return await this.debuggerExecutor.executeScript(
        tabId,
        scriptDefinition,
        input,
        scriptRegistry,
        evidence,
        screenshotArtifactBasePath,
        mouseTrajectorySimulation,
      );
    }

    try {
      if (!this.userScriptExecutor.isAvailable()) {
        throw new Error('chrome.userScripts.execute is not available in this browser runtime.');
      }

      return await this.userScriptExecutor.executeScript(
        tabId,
        scriptDefinition,
        input,
        scriptRegistry,
        evidence,
        screenshotArtifactBasePath,
      );
    } catch (error) {
      if (
        !this.debuggerExecutor.isAvailable() ||
        !isDebuggerFallbackEligibleError(error)
      ) {
        throw error;
      }

      return await this.debuggerExecutor.executeScript(
        tabId,
        scriptDefinition,
        input,
        scriptRegistry,
        evidence,
        screenshotArtifactBasePath,
        mouseTrajectorySimulation,
      );
    }
  }

  private async handleBrowserCommand(
    requestId: string,
    command: BrowserCommandName,
    input: Record<string, unknown>,
    tabId?: number,
  ): Promise<void> {
    let activeTab: BrowserTabLike | undefined;
    try {
      activeTab = tabId ? await browser.tabs.get(tabId) : await this.getActiveTab();
    } catch (error) {
      this.sendError(
        requestId,
        tabId === undefined ? 'EXECUTION_FAILED' : 'TAB_NOT_FOUND',
        tabId === undefined
          ? error instanceof Error ? error.message : String(error)
          : `Browser tab ${tabId} was not found.`,
        { command, tabId },
      );
      return;
    }
    if (!activeTab?.id || !activeTab.url) {
      this.sendError(
        requestId,
        'TAB_NOT_FOUND',
        tabId === undefined
          ? 'No active browser tab is available.'
          : `Browser tab ${tabId} was not found.`,
        { command, tabId },
      );
      return;
    }

    try {
      const response = await this.browserCommandHandler.execute(
        activeTab.id,
        command,
        input,
        (event) => {
          this.send(
            createRuntimeEnvelope(
              'browser_command_event',
              {
                event,
              },
              { sessionId: this.sessionId, requestId },
            ),
          );
        },
      );
      if (!response.ok || !response.result) {
        throw new Error(response.error ?? `Browser command ${command} failed.`);
      }

      this.send(
        createRuntimeEnvelope(
          'browser_command_result',
          {
            result: this.extractBinaryScreenshotArtifacts(
              response.result,
              requestId,
              'metadata',
            ) as Record<string, unknown>,
          },
          { sessionId: this.sessionId, requestId },
        ),
      );
    } catch (error) {
      this.sendError(
        requestId,
        'EXECUTION_FAILED',
        error instanceof Error ? error.message : String(error),
        { command, tabId: activeTab.id },
      );
    }
  }

  private installTabListeners(): void {
    browser.tabs.onActivated.addListener(async (activeInfo: { tabId: number }) => {
      this.lastActiveTabId = activeInfo.tabId;
      await this.sendTabSnapshot();
    });

    browser.tabs.onUpdated.addListener(
      async (_tabId: number, changeInfo: { status?: string; title?: string; url?: string }) => {
        this.recordExecutionTabUpdate(_tabId, changeInfo);
        if (changeInfo.status === 'complete') {
          await this.refreshExecutionTabIndicator(_tabId);
          await this.sendTabSnapshot();
        }
      },
    );

    browser.tabs.onCreated.addListener(async (tab: BrowserTabLike) => {
      this.recordExecutionTabCreated(tab);
      if (tab.id) {
        this.lastActiveTabId = tab.id;
      }
      await this.sendTabSnapshot();
    });

    browser.tabs.onRemoved.addListener(async (tabId: number) => {
      if (this.lastActiveTabId === tabId) {
        this.lastActiveTabId = undefined;
      }
      this.executionTabIndicators.delete(tabId);
      await this.sendTabSnapshot();
    });

    browser.runtime.onInstalled.addListener(async () => {
      const stored = await browser.storage.local.get([
        AUTHENTICATED_SITES_KEY,
        SCRIPT_HISTORY_STORAGE_KEY,
        SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY,
        USERSCRIPT_REGISTRY_STORAGE_KEY,
        USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY,
        USERSCRIPT_AVAILABLE_STORAGE_KEY,
      ]);
      const update: Record<string, unknown> = {};

      if (!Array.isArray(stored[AUTHENTICATED_SITES_KEY])) {
        update[AUTHENTICATED_SITES_KEY] = [];
      }

      if (!Array.isArray(stored[SCRIPT_HISTORY_STORAGE_KEY])) {
        update[SCRIPT_HISTORY_STORAGE_KEY] = [];
      }

      if (typeof stored[SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY] !== 'string') {
        update[SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY] = '';
      }

      if (!Array.isArray(stored[USERSCRIPT_REGISTRY_STORAGE_KEY])) {
        update[USERSCRIPT_REGISTRY_STORAGE_KEY] = [];
      }

      if (typeof stored[USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY] !== 'string') {
        update[USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY] = '';
      }

      if (typeof stored[USERSCRIPT_AVAILABLE_STORAGE_KEY] !== 'boolean') {
        update[USERSCRIPT_AVAILABLE_STORAGE_KEY] = this.isUserScriptsAvailable();
      }

      if (Object.keys(update).length > 0) {
        await browser.storage.local.set(update);
      }
    });
  }

  private async startExecutionTabIndicator(
    tabId: number,
    requestId: string,
    pageIndicatorEnabled: boolean,
    tabGroupIndicatorEnabled: boolean,
  ): Promise<void> {
    const existing = this.executionTabIndicators.get(tabId);
    if (existing) {
      existing.requestIds.add(requestId);
      if (pageIndicatorEnabled) {
        existing.pageIndicatorRequestIds.add(requestId);
      }
      if (tabGroupIndicatorEnabled) {
        existing.tabGroupIndicatorRequestIds.add(requestId);
      }
      await this.applyExecutionTabIndicator(tabId);
      return;
    }

    this.executionTabIndicators.set(tabId, {
      requestIds: new Set([requestId]),
      pageIndicatorRequestIds: new Set(pageIndicatorEnabled ? [requestId] : []),
      pageIndicatorApplied: false,
      tabGroupIndicatorRequestIds: new Set(tabGroupIndicatorEnabled ? [requestId] : []),
    });
    await this.applyExecutionTabIndicator(tabId);
  }

  private async stopExecutionTabIndicator(tabId: number, requestId: string): Promise<void> {
    const existing = this.executionTabIndicators.get(tabId);
    if (!existing) {
      return;
    }

    existing.requestIds.delete(requestId);
    existing.pageIndicatorRequestIds.delete(requestId);
    existing.tabGroupIndicatorRequestIds.delete(requestId);
    if (existing.requestIds.size > 0) {
      await this.applyExecutionTabIndicator(tabId);
      return;
    }

    const clearPageIndicator = existing.pageIndicatorApplied;
    const groupSnapshot = existing.tabGroupSnapshot;
    this.executionTabIndicators.delete(tabId);
    await this.restoreExecutionTabGroupIndicator(tabId, groupSnapshot);
    await this.clearExecutionTabIndicator(tabId, clearPageIndicator);
  }

  private async refreshExecutionTabIndicator(tabId: number): Promise<void> {
    if (!this.executionTabIndicators.has(tabId)) {
      return;
    }

    await this.applyExecutionTabIndicator(tabId);
  }

  private async applyExecutionTabIndicator(tabId: number): Promise<void> {
    const indicatorState = this.executionTabIndicators.get(tabId);
    const showPageIndicator = (indicatorState?.pageIndicatorRequestIds.size ?? 0) > 0;
    const showTabGroupIndicator =
      (indicatorState?.tabGroupIndicatorRequestIds.size ?? 0) > 0;
    const tasks: Array<Promise<unknown>> = [
      browser.action.setBadgeText({ tabId, text: EXECUTION_BADGE_TEXT }),
      browser.action.setBadgeBackgroundColor({ tabId, color: EXECUTION_BADGE_COLOR }),
    ];
    if (showPageIndicator) {
      tasks.push(
        browser.scripting.executeScript({
          target: { tabId },
          func: applyExecutionPageIndicatorScript,
          args: [EXECUTION_PAGE_INDICATOR_ID],
        }),
      );
      if (indicatorState) {
        indicatorState.pageIndicatorApplied = true;
      }
    } else if (indicatorState?.pageIndicatorApplied === true) {
      tasks.push(
        browser.scripting.executeScript({
          target: { tabId },
          func: clearExecutionPageIndicatorScript,
          args: [EXECUTION_PAGE_INDICATOR_ID],
        }),
      );
      indicatorState.pageIndicatorApplied = false;
    }
    if (indicatorState && showTabGroupIndicator) {
      tasks.push(this.applyExecutionTabGroupIndicator(tabId, indicatorState));
    } else if (indicatorState?.tabGroupSnapshot) {
      const snapshot = indicatorState.tabGroupSnapshot;
      indicatorState.tabGroupSnapshot = undefined;
      tasks.push(this.restoreExecutionTabGroupIndicator(tabId, snapshot));
    }

    const applyIndicator = Promise.all(tasks)
      .catch((error) => {
        console.info('[WEB_CAP] unable to apply execution tab indicator', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    const timedOut = await Promise.race([
      applyIndicator.then(() => false),
      this.wait(EXECUTION_TAB_INDICATOR_TIMEOUT_MS).then(() => true),
    ]);

    if (timedOut) {
      console.info('[WEB_CAP] execution tab indicator apply timed out', {
        tabId,
        timeoutMs: EXECUTION_TAB_INDICATOR_TIMEOUT_MS,
      });
    }
  }

  private async applyExecutionTabGroupIndicator(
    tabId: number,
    indicatorState: ExecutionTabIndicatorState,
  ): Promise<void> {
    const tabGroupsApi = this.getTabGroupsApi();
    if (!tabGroupsApi?.tabGroups || !tabGroupsApi.tabs?.group) {
      console.info('[WEB_CAP] unable to apply execution tab group indicator', {
        tabId,
        reason: 'tab group APIs are unavailable',
      });
      return;
    }
    if (indicatorState.tabGroupSnapshot) {
      await tabGroupsApi.tabGroups.update(indicatorState.tabGroupSnapshot.groupId, {
        title: EXECUTION_TAB_GROUP_TITLE,
        color: EXECUTION_TAB_GROUP_COLOR,
      });
      return;
    }

    const tab = await browser.tabs.get(tabId) as BrowserTabLike;
    let groupId: number;
    let createdGroup = false;
    if (typeof tab.groupId !== 'number' || tab.groupId < 0) {
      groupId = await tabGroupsApi.tabs.group({ tabIds: tabId });
      createdGroup = true;
    } else {
      groupId = tab.groupId;
    }

    const group = await tabGroupsApi.tabGroups.get(groupId);
    indicatorState.tabGroupSnapshot = {
      groupId,
      title: group.title,
      color: group.color,
      createdGroup,
    };
    await tabGroupsApi.tabGroups.update(groupId, {
      title: EXECUTION_TAB_GROUP_TITLE,
      color: EXECUTION_TAB_GROUP_COLOR,
    });
    console.info('[WEB_CAP] applied execution tab group indicator', {
      tabId,
      groupId,
      createdGroup,
      originalTitle: group.title ?? '',
    });
  }

  private async restoreExecutionTabGroupIndicator(
    tabId: number,
    snapshot: ExecutionTabGroupSnapshot | undefined,
  ): Promise<void> {
    if (!snapshot) {
      return;
    }
    const tabGroupsApi = this.getTabGroupsApi();
    if (!tabGroupsApi?.tabGroups) {
      return;
    }
    if (snapshot.createdGroup) {
      await tabGroupsApi.tabs?.ungroup(tabId).catch((error) => {
        console.info('[WEB_CAP] unable to ungroup execution tab group indicator', {
          tabId,
          groupId: snapshot.groupId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    await tabGroupsApi.tabGroups.update(snapshot.groupId, {
      title: snapshot.title ?? '',
      ...(snapshot.color ? { color: snapshot.color } : {}),
    }).catch((error) => {
      console.info('[WEB_CAP] unable to restore execution tab group indicator', {
        tabId,
        groupId: snapshot.groupId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private getTabGroupsApi(): NativeTabGroupsApi {
    return (globalThis as typeof globalThis & { chrome?: NativeTabGroupsApi }).chrome ?? {};
  }

  private async clearExecutionTabIndicator(
    tabId: number,
    clearPageIndicator: boolean,
  ): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      browser.action.setBadgeText({ tabId, text: '' }),
    ];
    if (clearPageIndicator) {
      tasks.push(
        browser.scripting.executeScript({
          target: { tabId },
          func: clearExecutionPageIndicatorScript,
          args: [EXECUTION_PAGE_INDICATOR_ID],
        }),
      );
    }

    const clearIndicator = Promise.all(tasks)
      .catch((error) => {
        console.info('[WEB_CAP] unable to clear execution tab indicator', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    const timedOut = await Promise.race([
      clearIndicator.then(() => false),
      this.wait(EXECUTION_TAB_INDICATOR_TIMEOUT_MS).then(() => true),
    ]);

    if (timedOut) {
      console.info('[WEB_CAP] execution tab indicator clear timed out', {
        tabId,
        timeoutMs: EXECUTION_TAB_INDICATOR_TIMEOUT_MS,
      });
    }
  }

  private async sendTabSnapshot(): Promise<void> {
    const tabs = await this.getTrackableTabs();
    if (tabs.length === 0) {
      return;
    }

    const authenticatedSites = await this.getAuthenticatedSites();
    const snapshots = tabs.map((tab) => this.toTabSnapshot(tab));
    const activeTabId =
      snapshots.find((tab) => tab.tabId === this.lastActiveTabId)?.tabId ??
      snapshots.find((tab) => tab.tabId === tabs.find((tab) => tab.active)?.id)?.tabId ??
      snapshots[0]?.tabId;

    this.send(
      createRuntimeEnvelope(
        'tab_snapshot',
        {
          activeTabId,
          tabs: snapshots,
          authenticatedSites,
        },
        { sessionId: this.sessionId },
      ),
    );
  }

  private async getTrackableTabs(): Promise<BrowserTabLike[]> {
    const tabs = await browser.tabs.query({});
    return tabs.filter((tab) => typeof tab.id === 'number' && Boolean(tab.url));
  }

  private async getActiveTab(): Promise<BrowserTabLike | undefined> {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    return tabs[0];
  }

  private async getAuthenticatedSites(): Promise<string[]> {
    const stored = await browser.storage.local.get(AUTHENTICATED_SITES_KEY);
    return Array.isArray(stored[AUTHENTICATED_SITES_KEY])
      ? stored[AUTHENTICATED_SITES_KEY]
      : [];
  }

  private async storeScriptHistory(
    entries: ScriptExecutionHistoryEntry[],
    updatedAt: string,
  ): Promise<void> {
    await browser.storage.local.set({
      [SCRIPT_HISTORY_STORAGE_KEY]: entries,
      [SCRIPT_HISTORY_UPDATED_AT_STORAGE_KEY]: updatedAt,
    });
  }

  private async storeScriptRegistry(
    scripts: ScriptDefinition[],
    updatedAt: string,
  ): Promise<void> {
    await browser.storage.local.set({
      [SCRIPT_REGISTRY_STORAGE_KEY]: scripts,
      [SCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY]: updatedAt,
    });
  }

  private async storeUserScriptRegistry(
    userscripts: UserScriptDefinition[],
    updatedAt: string,
    applyNowUserScriptIds?: string[],
  ): Promise<void> {
    this.currentUserScripts = userscripts;
    await browser.storage.local.set({
      [USERSCRIPT_REGISTRY_STORAGE_KEY]: userscripts,
      [USERSCRIPT_REGISTRY_UPDATED_AT_STORAGE_KEY]: updatedAt,
    });
    await this.applyUserScriptRegistry(userscripts);
    await this.applyUserScriptsNow(userscripts, applyNowUserScriptIds);
    await this.sendTabSnapshot();
  }

  private async restoreCachedUserScripts(): Promise<void> {
    const stored = await browser.storage.local.get(USERSCRIPT_REGISTRY_STORAGE_KEY);
    const userscripts = Array.isArray(stored[USERSCRIPT_REGISTRY_STORAGE_KEY])
      ? (stored[USERSCRIPT_REGISTRY_STORAGE_KEY] as UserScriptDefinition[])
      : [];
    this.currentUserScripts = userscripts;
    await this.applyUserScriptRegistry(userscripts);
    await this.sendTabSnapshot();
  }

  private async applyUserScriptRegistry(userscripts: UserScriptDefinition[]): Promise<void> {
    const userScriptsApi = this.getChromeUserScriptsApi();
    this.registeredUserScriptIds.clear();
    if (!userScriptsApi?.register || !userScriptsApi.unregister) {
      console.warn('[WEB_CAP] chrome.userScripts.register is not available.');
      await this.storeUserScriptsAvailability(false);
      return;
    }

    try {
      await userScriptsApi.unregister();
      const activeScripts = userscripts
        .filter((script) => script.status === 'active')
        .map((script) => ({
          id: script.id,
          matches: script.matches,
          runAt: toChromeUserScriptRunAt(script.runAt),
          world: 'USER_SCRIPT' as const,
          js: [{ code: script.code }],
        }));
      for (const script of activeScripts) {
        try {
          await userScriptsApi.register([script]);
          this.registeredUserScriptIds.add(script.id);
        } catch (error) {
          console.warn('[WEB_CAP] failed to register userscript:', script.id, error);
        }
      }
      await this.storeUserScriptsAvailability(true);
    } catch (error) {
      console.warn('[WEB_CAP] chrome.userScripts.register failed:', error);
      await this.storeUserScriptsAvailability(false);
    }
  }

  private async applyUserScriptsNow(
    userscripts: UserScriptDefinition[],
    applyNowUserScriptIds: string[] | undefined,
  ): Promise<void> {
    if (!applyNowUserScriptIds?.length) {
      return;
    }

    const userScriptsApi = this.getChromeUserScriptsApi();
    if (!userScriptsApi?.execute) {
      console.warn('[WEB_CAP] chrome.userScripts.execute is not available.');
      return;
    }

    const scripts = userscripts.filter(
      (script) => script.status === 'active' && applyNowUserScriptIds.includes(script.id),
    );
    if (scripts.length === 0) {
      return;
    }

    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) {
        continue;
      }
      for (const script of scripts) {
        if (!userScriptMatchesUrl(script, tab.url)) {
          continue;
        }
        try {
          await userScriptsApi.execute({
            target: { tabId: tab.id },
            world: 'USER_SCRIPT',
            injectImmediately: true,
            js: [{ code: script.code }],
          });
        } catch (error) {
          console.warn('[WEB_CAP] failed to apply userscript now:', script.id, tab.id, error);
        }
      }
    }
  }

  private getChromeUserScriptsApi(): ChromeUserScriptsLike['userScripts'] | undefined {
    return (globalThis as typeof globalThis & { chrome?: ChromeUserScriptsLike }).chrome
      ?.userScripts;
  }

  private isUserScriptsAvailable(): boolean {
    const userScriptsApi = this.getChromeUserScriptsApi();
    return typeof userScriptsApi?.register === 'function' &&
      typeof userScriptsApi.unregister === 'function';
  }

  private async storeUserScriptsAvailability(available: boolean): Promise<void> {
    await browser.storage.local.set({
      [USERSCRIPT_AVAILABLE_STORAGE_KEY]: available,
    });
  }

  private startExecutionObservation(
    requestId: string,
    tabId: number,
    startedUrl: string,
    startedTitle: string,
  ): ExecutionObservation {
    const observation: ExecutionObservation = {
      requestId,
      tabId,
      startedUrl,
      startedTitle,
      createdTabs: new Map(),
      targetUpdates: [],
    };
    this.executionObservations.push(observation);
    return observation;
  }

  private cancelExecutionObservation(observation: ExecutionObservation): void {
    const index = this.executionObservations.indexOf(observation);
    if (index >= 0) {
      this.executionObservations.splice(index, 1);
    }
  }

  private async finishExecutionObservation(
    observation: ExecutionObservation,
    existingEvents: ExecutionEvidenceEvent[],
  ): Promise<ExecutionEvidenceEvent[]> {
    this.cancelExecutionObservation(observation);
    const events: ExecutionEvidenceEvent[] = [];

    for (const tab of observation.createdTabs.values()) {
      events.push({
        type: 'page_opened',
        value: {
          tab: this.toTabSnapshot(tab),
          openerTabId: tab.openerTabId ?? observation.tabId,
          active: Boolean(tab.active),
        },
      });
    }

    const finalTab = await browser.tabs.get(observation.tabId).catch(() => undefined);
    const finalUrl = finalTab?.url ?? observation.startedUrl;
    const finalTitle = finalTab?.title ?? observation.startedTitle;
    const observedUrl =
      [...observation.targetUpdates]
        .reverse()
        .find((update) => typeof update.url === 'string' && update.url.length > 0)?.url ??
      finalUrl;
    const observedTitle =
      [...observation.targetUpdates]
        .reverse()
        .find((update) => typeof update.title === 'string')?.title ??
      finalTitle;

    const hasLoadingUpdate = observation.targetUpdates.some(
      (update) => update.status === 'loading',
    );
    const pageChangedEvent = buildPageChangedEvent({
      startedUrl: observation.startedUrl,
      observedUrl,
      startedTitle: observation.startedTitle,
      observedTitle,
      tabId: observation.tabId,
      mode: 'navigation',
    });
    if (pageChangedEvent) {
      const pageChangedToUrl = (pageChangedEvent.value as { to: { url?: string } }).to.url;
      const existingPageChanged = [...existingEvents, ...events].find(
        (event) =>
          event.type === 'page_changed' &&
          typeof event.value === 'object' &&
          event.value !== null &&
          typeof (event.value as { to?: { url?: unknown } }).to?.url === 'string' &&
          (event.value as { to?: { url?: unknown } }).to?.url === pageChangedToUrl,
      );
      if (existingPageChanged) {
        mergePageChangedEvent(existingPageChanged, pageChangedEvent);
      } else {
        events.push(pageChangedEvent);
      }
    } else if (hasLoadingUpdate) {
      events.push({
        type: 'page_reloaded',
        value: {
          url: observation.startedUrl,
          tabId: observation.tabId,
        },
      });
    }

    return events;
  }

  private recordExecutionTabCreated(tab: BrowserTabLike): void {
    if (typeof tab.id !== 'number') {
      return;
    }

    for (const observation of this.executionObservations) {
      observation.createdTabs.set(tab.id, tab);
    }
  }

  private recordExecutionTabUpdate(
    tabId: number,
    changeInfo: { status?: string; title?: string; url?: string },
  ): void {
    for (const observation of this.executionObservations) {
      if (observation.createdTabs.has(tabId)) {
        const existing = observation.createdTabs.get(tabId) ?? { id: tabId };
        observation.createdTabs.set(tabId, {
          ...existing,
          title: changeInfo.title ?? existing.title,
          url: changeInfo.url ?? existing.url,
        });
      }

      if (tabId !== observation.tabId) {
        continue;
      }

      observation.targetUpdates.push({
        tabId,
        status: changeInfo.status,
        title: changeInfo.title,
        url: changeInfo.url,
      });
    }
  }

  private createNavigationInterruptedEvidence(startedUrl: string): ExecutionEvidence {
    return {
      events: [{ type: 'execution_interrupted_by_navigation', value: { url: startedUrl } }],
    };
  }

  private createEmptyExecutionEvidence(): ExecutionEvidence {
    return {
      events: [],
    };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }

  private toTabSnapshot(tab: BrowserTabLike): RuntimeTabSnapshot {
    const rawUrl = typeof tab.url === 'string' ? tab.url : '';
    const loadedUserScriptIds = this.loadedUserScriptIds(rawUrl);
    let site = '';

    // Newly created tabs can briefly report an empty or otherwise non-absolute URL
    // before the browser finishes initializing the navigation target.
    if (rawUrl.length > 0) {
      try {
        site = new URL(rawUrl).hostname.replace(/^www\./, '');
      } catch {
        site = '';
      }
    }

    return {
      tabId: tab.id ?? -1,
      url: rawUrl,
      title: tab.title ?? '',
      site,
      ...(loadedUserScriptIds.length > 0
        ? {
            loadedUserScriptCount: loadedUserScriptIds.length,
            loadedUserScriptIds,
          }
        : {}),
      readyState: 'complete',
      updatedAt: new Date().toISOString(),
    };
  }

  private loadedUserScriptIds(url: string): string[] {
    if (!this.isUserScriptsAvailable()) {
      return [];
    }
    return this.currentUserScripts
      .filter((script) =>
        this.registeredUserScriptIds.has(script.id) && userScriptMatchesUrl(script, url),
      )
      .map((script) => script.id);
  }

  private sendError(
    requestId: string,
    code: 'TAB_NOT_FOUND' | 'EXECUTION_FAILED' | 'TIMEOUT',
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.send(
      createRuntimeEnvelope(
        'error',
        {
          code,
          message,
          retryable: true,
          details,
        },
        { sessionId: this.sessionId, requestId },
      ),
    );
  }

  private extractBinaryScreenshotArtifacts(
    value: unknown,
    requestId: string,
    resultShape: 'path' | 'metadata',
  ): unknown {
    if (isScreenshotArtifact(value)) {
      const transferId = crypto.randomUUID();
      const bytes = decodeBase64(value.data);
      const type = value.type === 'jpeg' ? 'jpeg' : 'png';
      const mimeType = typeof value.mimeType === 'string'
        ? value.mimeType
        : type === 'jpeg'
          ? 'image/jpeg'
          : 'image/png';

      this.send(
        createRuntimeEnvelope(
          'binary_payload_start',
          {
            transferId,
            kind: 'screenshot',
            mimeType,
            type,
            byteLength: bytes.byteLength,
            resultShape,
          },
          { sessionId: this.sessionId, requestId },
        ),
      );
      this.sendBinary(bytes);

      return {
        __webCapType: 'screenshot_transfer',
        transferId,
        resultShape,
      };
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.extractBinaryScreenshotArtifacts(item, requestId, resultShape));
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.extractBinaryScreenshotArtifacts(item, requestId, resultShape),
        ]),
      );
    }

    return value;
  }

  private sendBinaryScreenshotArtifacts(
    artifacts: ScriptScreenshotArtifact[],
    requestId: string,
  ): RuntimeScreenshotArtifactPayload[] {
    return artifacts.map((artifact) => {
      const transferId = crypto.randomUUID();
      const bytes = decodeBase64(artifact.data);
      const type = artifact.type === 'jpeg' ? 'jpeg' : 'png';
      const mimeType = typeof artifact.mimeType === 'string'
        ? artifact.mimeType
        : type === 'jpeg'
          ? 'image/jpeg'
          : 'image/png';

      this.send(
        createRuntimeEnvelope(
          'binary_payload_start',
          {
            transferId,
            kind: 'screenshot',
            mimeType,
            type,
            byteLength: bytes.byteLength,
            resultShape: 'metadata',
            path: artifact.path,
          },
          { sessionId: this.sessionId, requestId },
        ),
      );
      this.sendBinary(bytes);

      return {
        kind: 'screenshot',
        path: artifact.path,
        transferId,
        mimeType,
        type,
      };
    });
  }

  private send(envelope: RuntimeEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(envelope));
    }
  }

  private sendBinary(bytes: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    }
  }
}

function isScreenshotArtifact(value: unknown): value is {
  data: string;
  mimeType?: string;
  type?: string;
} {
  return (
    isRecord(value) &&
    value.__webCapType === 'screenshot' &&
    typeof value.data === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function applyExecutionPageIndicatorScript(indicatorId: string): void {
  if (document.getElementById(indicatorId)) {
    return;
  }

  const host = document.createElement('div');
  host.id = indicatorId;
  host.setAttribute('aria-hidden', 'true');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.top = '10px';
  host.style.right = '10px';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  const shadow = host.attachShadow({ mode: 'closed' });
  const badge = document.createElement('div');
  badge.textContent = 'WEB_CAP RUN';
  badge.style.padding = '6px 8px';
  badge.style.borderRadius = '6px';
  badge.style.background = 'rgba(37, 99, 235, 0.72)';
  badge.style.border = '1px solid rgba(255, 255, 255, 0.38)';
  badge.style.color = '#ffffff';
  badge.style.font = '600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  badge.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.16)';
  badge.style.letterSpacing = '0';
  badge.style.opacity = '0.86';
  badge.style.backdropFilter = 'blur(6px)';
  shadow.append(badge);
  (document.documentElement ?? document.body).append(host);
}

function clearExecutionPageIndicatorScript(indicatorId: string): void {
  document.getElementById(indicatorId)?.remove();
}

function buildPageChangedEvent(input: {
  startedUrl: string;
  observedUrl?: string;
  startedTitle: string;
  observedTitle?: string;
  tabId: number;
  mode: 'history' | 'navigation';
  method?: string;
}): ExecutionEvidenceEvent | undefined {
  const from: { title?: string; url?: string } = {};
  const to: { title?: string; url?: string } = {};

  if (input.observedUrl && input.observedUrl !== input.startedUrl) {
    from.url = input.startedUrl;
    to.url = input.observedUrl;
  }

  if (input.observedTitle !== undefined && input.observedTitle !== input.startedTitle) {
    from.title = input.startedTitle;
    to.title = input.observedTitle;
  }

  if (Object.keys(to).length === 0) {
    return undefined;
  }

  return {
    type: 'page_changed',
    value: {
      from,
      to,
      tabId: input.tabId,
      mode: input.mode,
      ...(input.method ? { method: input.method } : {}),
    },
  };
}

function mergePageChangedEvent(
  existingEvent: ExecutionEvidenceEvent,
  nextEvent: ExecutionEvidenceEvent,
): void {
  if (
    typeof existingEvent.value !== 'object' ||
    existingEvent.value === null ||
    typeof nextEvent.value !== 'object' ||
    nextEvent.value === null
  ) {
    return;
  }

  const existing = existingEvent.value as {
    from?: { title?: string; url?: string };
    to?: { title?: string; url?: string };
  };
  const next = nextEvent.value as {
    from?: { title?: string; url?: string };
    to?: { title?: string; url?: string };
  };

  existing.from = {
    ...(existing.from ?? {}),
    ...(next.from ?? {}),
  };
  existing.to = {
    ...(existing.to ?? {}),
    ...(next.to ?? {}),
  };
}

function shouldCollectExecutionEvidence(
  evidence: ExecutionEvidenceOption[] | undefined,
  option: Exclude<ExecutionEvidenceOption, 'common' | 'all'>,
): boolean {
  return Boolean(
    evidence?.includes('all') ||
      evidence?.includes('common') ||
      evidence?.includes(option),
  );
}

function parseScriptGotoContinuation(
  result: Record<string, unknown>,
): ScriptGotoContinuation | undefined {
  if (
    result.__webCapType !== WEB_CAP_GOTO_CONTINUATION_TYPE ||
    typeof result.url !== 'string' ||
    !isRecord(result.input)
  ) {
    return undefined;
  }
  return {
    __webCapType: WEB_CAP_GOTO_CONTINUATION_TYPE,
    url: result.url,
    input: result.input,
  };
}

function userScriptMatchesUrl(script: UserScriptDefinition, url: string): boolean {
  return script.matches.some((pattern) => {
    try {
      return new MatchPattern(pattern).includes(url);
    } catch {
      return false;
    }
  });
}

function toChromeUserScriptRunAt(runAt: UserScriptDefinition['runAt']): ChromeUserScriptRunAt {
  switch (runAt) {
    case 'document-start':
      return 'document_start';
    case 'document-end':
      return 'document_end';
    case 'document-idle':
      return 'document_idle';
  }
}

export default defineBackground(() => {
  const runtimeClient = new RuntimeClient();
  runtimeClient.start();
});
