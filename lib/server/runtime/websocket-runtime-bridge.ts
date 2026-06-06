import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ScriptDefinition, UserScriptDefinition } from '@shared/script-schema';
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_RUNTIME_PORT,
  createRuntimeEnvelope,
  type BrowserCommandName,
  type BrowserCommandResult,
  type ScriptExecutionResult,
  type ExecutionEvidence,
  type ExecutionEvidenceOption,
  type ExecuteScriptOptions,
  type ScriptExecutionHistoryEntry,
  type RuntimeConnectionSnapshot,
  type RuntimeEnvelope,
  type RuntimeHelloPayload,
  type RuntimeSessionSnapshot,
  type RuntimeTabSummary,
  type RuntimeTabSnapshot,
} from '@shared/protocol';
import {
  RuntimeBridge,
  RuntimeBridgeError,
  type BrowserCommandOptions,
  type UserScriptSyncOptions,
} from './runtime-bridge';
import { DEFAULT_BROWSER_COMMAND_TIMEOUT_MS } from '../browser/command-contracts';
import {
  resolveScreenshotDirectory,
  storeBrowserScreenshotBytes,
  storeBrowserScreenshotBytesAtPath,
  type StoredScreenshotResult,
} from '../browser/screenshot-store';

const EXECUTION_RESPONSE_GRACE_MS = 5_000;

interface PendingExecution {
  sessionId: string;
  scriptDefinition: ScriptDefinition;
  tab: RuntimeTabSnapshot;
  includeTabInResult: boolean;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (value: ScriptExecutionResult) => void;
  reject: (error: Error) => void;
}

interface PendingBrowserCommand {
  sessionId: string;
  command: BrowserCommandName;
  tab: RuntimeTabSnapshot;
  startedAt: number;
  timer: NodeJS.Timeout;
  onEvent?: (event: Record<string, unknown>) => void;
  resolve: (value: BrowserCommandResult) => void;
  reject: (error: Error) => void;
}

interface RuntimeConnection {
  socket: WebSocket;
  snapshot: RuntimeConnectionSnapshot;
}

interface PendingBinaryTransfer {
  sessionId: string;
  requestId: string;
  transferId: string;
  kind: 'screenshot';
  mimeType: string;
  type: 'png' | 'jpeg';
  byteLength: number;
  resultShape: 'path' | 'metadata';
  path?: string;
}

interface StoredBinaryTransfer {
  resultShape: 'path' | 'metadata';
  stored: StoredScreenshotResult;
}

export interface WebSocketRuntimeBridgeOptions {
  port?: number;
  onRuntimeCountChanged?: (runtimeCount: number) => void;
}

export class WebSocketRuntimeBridge implements RuntimeBridge {
  private server?: WebSocketServer;
  private runtimes = new Map<string, RuntimeConnection>();
  private socketSessions = new Map<WebSocket, string>();
  private activeSessionId?: string;
  private pendingExecutions = new Map<string, PendingExecution>();
  private pendingBrowserCommands = new Map<string, PendingBrowserCommand>();
  private pendingBinaryTransfers = new Map<WebSocket, PendingBinaryTransfer>();
  private storedBinaryTransfers = new Map<string, Promise<StoredBinaryTransfer>>();
  private port: number;
  private scriptHistoryLoader?: () => Promise<ScriptExecutionHistoryEntry[]>;
  private scriptRegistryLoader?: () => Promise<ScriptDefinition[]>;
  private userScriptRegistryLoader?: () => Promise<UserScriptDefinition[]>;

  constructor(private readonly options: WebSocketRuntimeBridgeOptions = {}) {
    this.port = options.port ?? DEFAULT_RUNTIME_PORT;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
    });

    this.server.on('connection', (socket: WebSocket) => this.attachClient(socket));

    await new Promise<void>((resolve, reject) => {
      this.server?.once('listening', () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        resolve();
      });
      this.server?.once('error', (error) => {
        this.server?.close();
        this.server = undefined;
        reject(error);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  getRuntimeCount(): number {
    return this.runtimes.size;
  }

  setScriptHistoryLoader(loader: () => Promise<ScriptExecutionHistoryEntry[]>): void {
    this.scriptHistoryLoader = loader;
  }

  setScriptRegistryLoader(loader: () => Promise<ScriptDefinition[]>): void {
    this.scriptRegistryLoader = loader;
  }

  setUserScriptRegistryLoader(loader: () => Promise<UserScriptDefinition[]>): void {
    this.userScriptRegistryLoader = loader;
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.pendingExecutions) {
      clearTimeout(pending.timer);
      pending.reject(
        new RuntimeBridgeError(
          'Runtime bridge closed before execution completed.',
          'RUNTIME_DISCONNECTED',
        ),
      );
      this.pendingExecutions.delete(requestId);
      this.cleanupBinaryTransfersForRequest(pending.sessionId, requestId);
    }

    for (const [requestId, pending] of this.pendingBrowserCommands) {
      clearTimeout(pending.timer);
      pending.reject(
        new RuntimeBridgeError(
          'Runtime bridge closed before browser command completed.',
          'RUNTIME_DISCONNECTED',
        ),
      );
      this.pendingBrowserCommands.delete(requestId);
      this.cleanupBinaryTransfersForRequest(pending.sessionId, requestId);
    }

    await new Promise<void>((resolve) => {
      for (const runtime of this.runtimes.values()) {
        runtime.socket.close();
      }
      this.server?.close(() => resolve());
      if (!this.server) {
        resolve();
      }
    });

    this.server = undefined;
    this.runtimes.clear();
    this.socketSessions.clear();
    this.pendingBinaryTransfers.clear();
    this.storedBinaryTransfers.clear();
    this.activeSessionId = undefined;
  }

  getSessionStatus(): RuntimeSessionSnapshot {
    const runtimes = [...this.runtimes.values()].map((runtime) => ({
      ...runtime.snapshot,
      tabs: [...runtime.snapshot.tabs],
      authenticatedSites: [...runtime.snapshot.authenticatedSites],
      userScriptsAvailable: runtime.snapshot.userScriptsAvailable,
    }));
    const activeRuntime =
      (this.activeSessionId ? this.runtimes.get(this.activeSessionId)?.snapshot : undefined) ??
      runtimes[0];

    return {
      connected: runtimes.length > 0,
      sessionId: activeRuntime?.sessionId,
      browserName: activeRuntime?.browserName,
      extensionVersion: activeRuntime?.extensionVersion,
      activeTab: activeRuntime?.activeTab,
      tabs: activeRuntime ? [...activeRuntime.tabs] : [],
      authenticatedSites: activeRuntime ? [...activeRuntime.authenticatedSites] : [],
      userScriptsAvailable: activeRuntime?.userScriptsAvailable,
      lastSeenAt: activeRuntime?.lastSeenAt,
      runtimes,
    };
  }

  async executeScript(
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    options: ExecuteScriptOptions = {},
  ): Promise<ScriptExecutionResult> {
    const target = this.findRuntimeForExecution(options.tabId);
    if (!target || target.runtime.socket.readyState !== target.runtime.socket.OPEN) {
      throw this.createTargetUnavailableError(options.tabId);
    }

    const tab = options.tabId === undefined
      ? target.runtime.snapshot.activeTab
      : target.runtime.snapshot.tabs.find((candidate) => candidate.tabId === options.tabId);

    if (!tab) {
      throw new RuntimeBridgeError(
        options.tabId === undefined
          ? 'No target tab is available for execution.'
          : `Browser tab ${options.tabId} was not found.`,
        'TAB_NOT_FOUND',
      );
    }

    const requestId = randomUUID();
    const evidence = normalizeEvidenceOptions(options.evidence);

    return await new Promise<ScriptExecutionResult>((resolve, reject) => {
      const timeoutMs = scriptDefinition.script.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      const responseTimeoutMs = timeoutMs + EXECUTION_RESPONSE_GRACE_MS;
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.pendingExecutions.delete(requestId);
        this.cleanupBinaryTransfersForRequest(target.sessionId, requestId);
        resolve({
          scriptId: scriptDefinition.id,
          status: 'interrupted',
          result: {
            interrupted: true,
            reason: 'timeout',
            message: `Browser runtime did not return a result within ${responseTimeoutMs}ms for script ${scriptDefinition.id}.`,
          },
          evidence: {
            events:
              shouldCollectExecutionEvidence(evidence, 'events')
                ? [
                    {
                      type: 'execution_interrupted_by_timeout',
                      value: {
                        scriptId: scriptDefinition.id,
                        timeoutMs,
                        responseTimeoutMs,
                        requestId,
                      },
                    },
                  ]
                : [],
          },
          timingMs: Date.now() - startedAt,
          tab: summarizeExecutionTab(tab, options.includeTabInResult ?? options.tabId === undefined),
        });
      }, responseTimeoutMs);

      this.pendingExecutions.set(requestId, {
        sessionId: target.sessionId,
        scriptDefinition,
        tab,
        includeTabInResult: options.includeTabInResult ?? options.tabId === undefined,
        startedAt,
        timer,
        resolve,
        reject,
      });

      this.sendEnvelope(
        target.runtime,
        createRuntimeEnvelope(
          'execute_script',
          {
            scriptDefinition,
            input,
            scriptRegistry: options.scriptRegistry ?? [],
            tabId: tab.tabId,
            activateTab: options.activateTab,
            evidence,
            screenshotArtifactBasePath: resolveScreenshotDirectory(),
            executionPageIndicator: options.executionPageIndicator,
            executionTabGroupIndicator: options.executionTabGroupIndicator,
            mouseTrajectorySimulation: options.mouseTrajectorySimulation,
          },
          {
            requestId,
            sessionId: target.sessionId,
          },
        ),
      );
    });
  }

  async executeBrowserCommand(
    command: BrowserCommandName,
    input: Record<string, unknown>,
    options: BrowserCommandOptions = {},
  ): Promise<BrowserCommandResult> {
    const target = this.findRuntimeForExecution(options.tabId);
    if (!target || target.runtime.socket.readyState !== target.runtime.socket.OPEN) {
      throw this.createTargetUnavailableError(options.tabId);
    }

    const tab = options.tabId === undefined
      ? target.runtime.snapshot.activeTab
      : target.runtime.snapshot.tabs.find((candidate) => candidate.tabId === options.tabId);

    if (!tab) {
      throw new RuntimeBridgeError(
        options.tabId === undefined
          ? 'No target tab is available for browser command.'
          : `Browser tab ${options.tabId} was not found.`,
        'TAB_NOT_FOUND',
      );
    }

    const requestId = randomUUID();

    return await new Promise<BrowserCommandResult>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingBrowserCommands.delete(requestId);
        this.cleanupBinaryTransfersForRequest(target.sessionId, requestId);
        reject(
          new RuntimeBridgeError(
            `Browser command ${command} timed out after ${timeoutMs}ms.`,
            'TIMEOUT',
          ),
        );
      }, timeoutMs);

      this.pendingBrowserCommands.set(requestId, {
        sessionId: target.sessionId,
        command,
        tab,
        startedAt: Date.now(),
        timer,
        onEvent: options.onEvent,
        resolve,
        reject,
      });

      this.sendEnvelope(
        target.runtime,
        createRuntimeEnvelope(
          'browser_command',
          {
            command,
            input,
            tabId: tab.tabId,
          },
          {
            requestId,
            sessionId: target.sessionId,
          },
        ),
      );
    });
  }

  async syncScriptHistory(entries: ScriptExecutionHistoryEntry[]): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      this.sendEnvelope(
        runtime,
        createRuntimeEnvelope(
          'script_history_sync',
          {
            entries,
          },
          { sessionId: runtime.snapshot.sessionId },
        ),
      );
    }
  }

  async syncScriptRegistry(scripts: ScriptDefinition[]): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      this.sendEnvelope(
        runtime,
        createRuntimeEnvelope(
          'script_registry_sync',
          {
            scripts,
          },
          { sessionId: runtime.snapshot.sessionId },
        ),
      );
    }
  }

  async syncUserScriptRegistry(
    userscripts: UserScriptDefinition[],
    options: UserScriptSyncOptions = {},
  ): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      this.sendEnvelope(
        runtime,
        createRuntimeEnvelope(
          'userscript_registry_sync',
          {
            userscripts,
            applyNowUserScriptIds: options.applyNowUserScriptIds,
          },
          { sessionId: runtime.snapshot.sessionId },
        ),
      );
    }
  }

  private attachClient(socket: WebSocket): void {
    socket.on('message', (buffer: Buffer, isBinary: boolean) => {
      void this.handleSocketMessage(socket, buffer, isBinary);
    });

    socket.on('close', () => {
      const sessionId = this.socketSessions.get(socket);
      this.pendingBinaryTransfers.delete(socket);
      this.removeRuntime(socket);
      this.rejectPendingForSession(
        sessionId,
        new RuntimeBridgeError('Browser runtime disconnected.', 'RUNTIME_DISCONNECTED'),
      );
    });

    socket.on('error', () => {
      const sessionId = this.socketSessions.get(socket);
      this.pendingBinaryTransfers.delete(socket);
      this.removeRuntime(socket);
      this.rejectPendingForSession(
        sessionId,
        new RuntimeBridgeError('Browser runtime connection errored.', 'RUNTIME_DISCONNECTED'),
      );
    });
  }

  private async handleSocketMessage(
    socket: WebSocket,
    buffer: Buffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      await this.handleBinaryFrame(socket, buffer);
      return;
    }

    const parsed = JSON.parse(buffer.toString()) as RuntimeEnvelope;
    await this.handleEnvelope(socket, parsed);
  }

  private findRuntimeForExecution(
    tabId?: number,
  ): { sessionId: string; runtime: RuntimeConnection } | undefined {
    if (tabId !== undefined) {
      for (const [sessionId, runtime] of this.runtimes) {
        if (runtime.snapshot.tabs.some((tab) => tab.tabId === tabId)) {
          return { sessionId, runtime };
        }
      }
      return undefined;
    }

    const activeRuntime = this.activeSessionId
      ? this.runtimes.get(this.activeSessionId)
      : undefined;
    if (activeRuntime && activeRuntime.snapshot.activeTab) {
      return { sessionId: activeRuntime.snapshot.sessionId, runtime: activeRuntime };
    }

    const first = this.runtimes.entries().next();
    if (first.done) {
      return undefined;
    }

    const [sessionId, runtime] = first.value;
    return { sessionId, runtime };
  }

  private createTargetUnavailableError(tabId?: number): RuntimeBridgeError {
    if (tabId !== undefined && this.runtimes.size > 0) {
      return new RuntimeBridgeError(`Browser tab ${tabId} was not found.`, 'TAB_NOT_FOUND');
    }

    return new RuntimeBridgeError('No browser runtime is connected.', 'RUNTIME_DISCONNECTED');
  }

  private async handleEnvelope(socket: WebSocket, envelope: RuntimeEnvelope): Promise<void> {
    const runtime = this.runtimeForSocket(socket);
    if (runtime) {
      runtime.snapshot.lastSeenAt = envelope.timestamp;
    }

    switch (envelope.type) {
      case 'hello':
        await this.handleHello(socket, envelope.payload);
        break;
      case 'heartbeat':
        break;
      case 'tab_snapshot':
        if (runtime) {
          runtime.snapshot.tabs = envelope.payload.tabs;
          runtime.snapshot.activeTab = envelope.payload.tabs.find(
            (candidate) => candidate.tabId === envelope.payload.activeTabId,
          );
          runtime.snapshot.authenticatedSites = envelope.payload.authenticatedSites;
          this.activeSessionId = runtime.snapshot.sessionId;
        }
        break;
      case 'binary_payload_start':
        if (runtime) {
          this.pendingBinaryTransfers.set(socket, {
            sessionId: runtime.snapshot.sessionId,
            requestId: envelope.requestId,
            transferId: envelope.payload.transferId,
            kind: envelope.payload.kind,
            mimeType: envelope.payload.mimeType,
            type: envelope.payload.type,
            byteLength: envelope.payload.byteLength,
            resultShape: envelope.payload.resultShape,
            path: envelope.payload.path,
          });
        }
        break;
      case 'execution_result': {
        const pending = this.pendingExecutions.get(envelope.requestId);
        if (!pending || runtime?.snapshot.sessionId !== pending.sessionId) {
          return;
        }

        try {
          await this.awaitScreenshotArtifactTransfers(
            envelope.payload.screenshotArtifacts,
            pending.sessionId,
            envelope.requestId,
          );
          clearTimeout(pending.timer);
          this.pendingExecutions.delete(envelope.requestId);
          pending.resolve({
            scriptId: pending.scriptDefinition.id,
            status: envelope.payload.status ?? inferExecutionStatus(envelope.payload.evidence),
            result: envelope.payload.result,
            evidence: summarizeExecutionEvidence(envelope.payload.evidence),
            timingMs: Date.now() - pending.startedAt,
            tab: summarizeExecutionTab(pending.tab, pending.includeTabInResult),
          });
          this.cleanupBinaryTransfersForRequest(pending.sessionId, envelope.requestId);
        } catch (error) {
          clearTimeout(pending.timer);
          this.pendingExecutions.delete(envelope.requestId);
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.cleanupBinaryTransfersForRequest(pending.sessionId, envelope.requestId);
        }
        break;
      }
      case 'browser_command_result': {
        const pending = this.pendingBrowserCommands.get(envelope.requestId);
        if (!pending || runtime?.snapshot.sessionId !== pending.sessionId) {
          return;
        }

        try {
          const result = await this.materializeBinaryTransferArtifacts(
            envelope.payload.result,
            pending.sessionId,
            envelope.requestId,
          );
          clearTimeout(pending.timer);
          this.pendingBrowserCommands.delete(envelope.requestId);
          pending.resolve({
            command: pending.command,
            result,
            timingMs: Date.now() - pending.startedAt,
            tab: pending.tab,
          });
          this.cleanupBinaryTransfersForRequest(pending.sessionId, envelope.requestId);
        } catch (error) {
          clearTimeout(pending.timer);
          this.pendingBrowserCommands.delete(envelope.requestId);
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          this.cleanupBinaryTransfersForRequest(pending.sessionId, envelope.requestId);
        }
        break;
      }
      case 'browser_command_event': {
        const pending = this.pendingBrowserCommands.get(envelope.requestId);
        if (!pending || runtime?.snapshot.sessionId !== pending.sessionId) {
          return;
        }

        pending.onEvent?.(envelope.payload.event);
        break;
      }
      case 'error': {
        const pending = envelope.requestId
          ? this.pendingExecutions.get(envelope.requestId)
          : undefined;

        if (pending && envelope.requestId && runtime?.snapshot.sessionId === pending.sessionId) {
          clearTimeout(pending.timer);
          pending.reject(
            new RuntimeBridgeError(
              envelope.payload.message,
              envelope.payload.code as RuntimeBridgeError['code'],
            ),
          );
          this.pendingExecutions.delete(envelope.requestId);
          this.cleanupBinaryTransfersForRequest(pending.sessionId, envelope.requestId);
        }

        const browserCommand = envelope.requestId
          ? this.pendingBrowserCommands.get(envelope.requestId)
          : undefined;

        if (
          browserCommand &&
          envelope.requestId &&
          runtime?.snapshot.sessionId === browserCommand.sessionId
        ) {
          clearTimeout(browserCommand.timer);
          browserCommand.reject(
            new RuntimeBridgeError(
              envelope.payload.message,
              envelope.payload.code as RuntimeBridgeError['code'],
            ),
          );
          this.pendingBrowserCommands.delete(envelope.requestId);
          this.cleanupBinaryTransfersForRequest(browserCommand.sessionId, envelope.requestId);
        }
        break;
      }
      case 'hello_ack':
        break;
    }
  }

  private async handleBinaryFrame(socket: WebSocket, buffer: Buffer): Promise<void> {
    const transfer = this.pendingBinaryTransfers.get(socket);
    if (!transfer) {
      console.warn('WEB_CAP received an unexpected binary payload.');
      return;
    }

    this.pendingBinaryTransfers.delete(socket);
    if (buffer.byteLength !== transfer.byteLength) {
      const error = new RuntimeBridgeError(
        `Binary payload ${transfer.transferId} size mismatch: expected ${transfer.byteLength} bytes, received ${buffer.byteLength}.`,
        'EXECUTION_FAILED',
      );
      this.rejectPendingForRequest(transfer.sessionId, transfer.requestId, error);
      return;
    }

    const storage = (
      transfer.path
        ? storeBrowserScreenshotBytesAtPath(buffer, {
            mimeType: transfer.mimeType,
            type: transfer.type,
          }, transfer.path)
        : storeBrowserScreenshotBytes(buffer, {
            mimeType: transfer.mimeType,
            type: transfer.type,
          })
    ).then((stored) => ({
      resultShape: transfer.resultShape,
      stored,
    }));
    storage.catch(() => undefined);
    this.storedBinaryTransfers.set(this.binaryTransferKey(transfer), storage);
  }

  private async awaitScreenshotArtifactTransfers(
    artifacts: { transferId: string; path: string }[] | undefined,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    if (!artifacts?.length) {
      return;
    }
    await Promise.all(
      artifacts.map(async (artifact) => {
        const transfer = await this.readStoredBinaryTransfer(
          sessionId,
          requestId,
          artifact.transferId,
        );
        if (resolvePath(transfer.stored.path) !== resolvePath(artifact.path)) {
          throw new RuntimeBridgeError(
            `Screenshot artifact ${artifact.transferId} path did not match its binary payload path.`,
            'EXECUTION_FAILED',
          );
        }
      }),
    );
  }

  private async materializeBinaryTransferArtifacts(
    value: unknown,
    sessionId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const materialized = await this.materializeBinaryTransferValue(value, sessionId, requestId);
    if (!isRecord(materialized)) {
      throw new RuntimeBridgeError(
        'Browser runtime returned a non-object result after binary payload materialization.',
        'EXECUTION_FAILED',
      );
    }
    return materialized;
  }

  private async materializeBinaryTransferValue(
    value: unknown,
    sessionId: string,
    requestId: string,
  ): Promise<unknown> {
    if (isBinaryTransferMarker(value)) {
      const transfer = await this.readStoredBinaryTransfer(sessionId, requestId, value.transferId);
      return transfer.resultShape === 'metadata'
        ? { ...transfer.stored }
        : transfer.stored.path;
    }

    if (Array.isArray(value)) {
      return await Promise.all(
        value.map((item) => this.materializeBinaryTransferValue(item, sessionId, requestId)),
      );
    }

    if (isRecord(value)) {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, item]) => [
          key,
          await this.materializeBinaryTransferValue(item, sessionId, requestId),
        ]),
      );
      return Object.fromEntries(entries);
    }

    return value;
  }

  private async readStoredBinaryTransfer(
    sessionId: string,
    requestId: string,
    transferId: string,
  ): Promise<StoredBinaryTransfer> {
    const key = this.binaryTransferKey({ sessionId, requestId, transferId });
    const transfer = this.storedBinaryTransfers.get(key);
    if (!transfer) {
      throw new RuntimeBridgeError(
        `Binary payload ${transferId} was not received for request ${requestId}.`,
        'EXECUTION_FAILED',
      );
    }
    return await transfer;
  }

  private cleanupBinaryTransfersForRequest(sessionId: string, requestId: string): void {
    const prefix = `${sessionId}:${requestId}:`;
    for (const [socket, transfer] of this.pendingBinaryTransfers) {
      if (transfer.sessionId === sessionId && transfer.requestId === requestId) {
        this.pendingBinaryTransfers.delete(socket);
      }
    }

    for (const [key, transfer] of this.storedBinaryTransfers) {
      if (key.startsWith(prefix)) {
        transfer.catch(() => undefined);
        this.storedBinaryTransfers.delete(key);
      }
    }
  }

  private binaryTransferKey(input: {
    sessionId: string;
    requestId: string;
    transferId: string;
  }): string {
    return `${input.sessionId}:${input.requestId}:${input.transferId}`;
  }

  private rejectPendingForRequest(sessionId: string, requestId: string, error: Error): void {
    const execution = this.pendingExecutions.get(requestId);
    if (execution?.sessionId === sessionId) {
      clearTimeout(execution.timer);
      execution.reject(error);
      this.pendingExecutions.delete(requestId);
    }

    const browserCommand = this.pendingBrowserCommands.get(requestId);
    if (browserCommand?.sessionId === sessionId) {
      clearTimeout(browserCommand.timer);
      browserCommand.reject(error);
      this.pendingBrowserCommands.delete(requestId);
    }

    this.cleanupBinaryTransfersForRequest(sessionId, requestId);
  }

  private async handleHello(socket: WebSocket, payload: RuntimeHelloPayload): Promise<void> {
    this.removeRuntime(socket);
    const sessionId = randomUUID();
    this.socketSessions.set(socket, sessionId);
    this.runtimes.set(sessionId, {
      socket,
      snapshot: {
        connected: true,
        sessionId,
        browserName: payload.browserName,
        extensionVersion: payload.extensionVersion,
        authenticatedSites: payload.authenticatedSites,
        userScriptsAvailable: payload.userScriptsAvailable === true,
        tabs: [],
        lastSeenAt: new Date().toISOString(),
      },
    });
    this.activeSessionId = sessionId;
    this.notifyRuntimeCountChanged();

    this.sendEnvelope(
      this.runtimes.get(sessionId),
      createRuntimeEnvelope(
        'hello_ack',
        {
          serverVersion: '0.0.1',
          sessionId,
          protocolVersion: payload.protocolVersion,
        },
        { sessionId },
      ),
    );

    if (this.scriptHistoryLoader) {
      try {
        const runtime = this.runtimes.get(sessionId);
        const entries = await this.scriptHistoryLoader();
        this.sendEnvelope(
          runtime,
          createRuntimeEnvelope(
            'script_history_sync',
            {
              entries,
            },
            { sessionId },
          ),
        );
      } catch (error) {
        console.error('WEB_CAP failed to sync script history to runtime:', error);
      }
    }

    if (this.scriptRegistryLoader) {
      try {
        const runtime = this.runtimes.get(sessionId);
        const scripts = await this.scriptRegistryLoader();
        this.sendEnvelope(
          runtime,
          createRuntimeEnvelope(
            'script_registry_sync',
            {
              scripts,
            },
            { sessionId },
          ),
        );
      } catch (error) {
        console.error('WEB_CAP failed to sync script registry to runtime:', error);
      }
    }

    if (this.userScriptRegistryLoader) {
      try {
        const runtime = this.runtimes.get(sessionId);
        const userscripts = await this.userScriptRegistryLoader();
        this.sendEnvelope(
          runtime,
          createRuntimeEnvelope(
            'userscript_registry_sync',
            {
              userscripts,
            },
            { sessionId },
          ),
        );
      } catch (error) {
        console.error('WEB_CAP failed to sync userscript registry to runtime:', error);
      }
    }
  }

  private sendEnvelope(runtime: RuntimeConnection | undefined, envelope: RuntimeEnvelope): void {
    runtime?.socket.send(JSON.stringify(envelope));
  }

  private runtimeForSocket(socket: WebSocket): RuntimeConnection | undefined {
    const sessionId = this.socketSessions.get(socket);
    return sessionId ? this.runtimes.get(sessionId) : undefined;
  }

  private removeRuntime(socket: WebSocket): void {
    const sessionId = this.socketSessions.get(socket);
    if (!sessionId) {
      return;
    }

    this.socketSessions.delete(socket);
    this.runtimes.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.runtimes.keys().next().value;
    }
    this.notifyRuntimeCountChanged();
  }

  private notifyRuntimeCountChanged(): void {
    this.options.onRuntimeCountChanged?.(this.runtimes.size);
  }

  private rejectPendingForSession(sessionId: string | undefined, error: Error): void {
    if (!sessionId) {
      return;
    }

    for (const [requestId, pending] of this.pendingExecutions) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingExecutions.delete(requestId);
      this.cleanupBinaryTransfersForRequest(sessionId, requestId);
    }

    for (const [requestId, pending] of this.pendingBrowserCommands) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingBrowserCommands.delete(requestId);
      this.cleanupBinaryTransfersForRequest(sessionId, requestId);
    }
  }
}

function inferExecutionStatus(evidence: ExecutionEvidence): 'succeeded' | 'interrupted' {
  return evidence.events.some((event) => String(event.type).startsWith('execution_interrupted_'))
    ? 'interrupted'
    : 'succeeded';
}

function summarizeExecutionEvidence(evidence: ExecutionEvidence): ExecutionEvidence {
  const summarized: ExecutionEvidence = {
    events: summarizeExecutionEvents(evidence.events),
  };

  if (evidence.screenshots?.length) {
    summarized.screenshots = evidence.screenshots;
  }

  if (evidence.visibleElements && hasVisibleElementChanges(evidence.visibleElements)) {
    summarized.visibleElements = evidence.visibleElements;
  }

  return summarized;
}

function summarizeExecutionEvents(
  events: ExecutionEvidence['events'],
): ExecutionEvidence['events'] {
  const summarized: ExecutionEvidence['events'] = [];
  let pendingMove: ExecutionEvidence['events'][number] | undefined;
  let pendingMoveStartPoint: { x: number; y: number } | undefined;
  let pendingMoveCount = 0;

  const flushPendingMove = () => {
    if (!pendingMove) {
      return;
    }

    if (pendingMoveCount <= 1) {
      summarized.push(pendingMove);
      pendingMove = undefined;
      pendingMoveStartPoint = undefined;
      pendingMoveCount = 0;
      return;
    }

    const value = isRecord(pendingMove.value) ? { ...pendingMove.value } : {};
    const lastPoint = readEvidencePoint(value);
    value.action = 'move';
    value.count = pendingMoveCount;
    if (pendingMoveStartPoint) {
      value.from = pendingMoveStartPoint;
    }
    if (lastPoint) {
      value.to = lastPoint;
    }

    summarized.push({
      type: pendingMove.type,
      value,
    });
    pendingMove = undefined;
    pendingMoveStartPoint = undefined;
    pendingMoveCount = 0;
  };

  for (const event of events) {
    if (isManagedMouseMoveEvent(event)) {
      pendingMoveStartPoint ??= readEvidencePoint(event.value);
      pendingMove = event;
      pendingMoveCount += 1;
      continue;
    }

    flushPendingMove();
    summarized.push(event);
  }

  flushPendingMove();
  return summarized;
}

function isManagedMouseMoveEvent(event: ExecutionEvidence['events'][number]): boolean {
  return event.type === 'managed_mouse' && isRecord(event.value) && event.value.action === 'move';
}

function readEvidencePoint(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const point = isRecord(value.point) ? value.point : value;
  const x = typeof point.x === 'number' ? point.x : undefined;
  const y = typeof point.y === 'number' ? point.y : undefined;
  if (x === undefined || y === undefined) {
    return undefined;
  }

  return { x: Math.round(x), y: Math.round(y) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasVisibleElementChanges(
  visibleElements: NonNullable<ExecutionEvidence['visibleElements']>,
): boolean {
  return (
    visibleElements.truncated ||
    visibleElements.added.length > 0 ||
    visibleElements.removed.length > 0 ||
    visibleElements.updated.length > 0
  );
}

function isBinaryTransferMarker(value: unknown): value is {
  transferId: string;
} {
  return (
    isRecord(value) &&
    value.__webCapType === 'screenshot_transfer' &&
    typeof value.transferId === 'string'
  );
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

function normalizeEvidenceOptions(
  evidence: ExecutionEvidenceOption[] | undefined,
): ExecutionEvidenceOption[] {
  return [...new Set(evidence ?? (['common'] as ExecutionEvidenceOption[]))];
}

function summarizeExecutionTab(
  tab: RuntimeTabSnapshot,
  includeTab: boolean,
): RuntimeTabSummary | undefined {
  if (!includeTab) {
    return undefined;
  }

  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
  };
}
