import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  ScriptDefinition,
} from '@shared/script-schema';
import type {
  BrowserCommandResult,
  BrowserScreenshotResult,
  RuntimeSessionSnapshot,
  ScriptExecutionHistoryEntry,
} from '@shared/protocol';
import { DEFAULT_EXECUTION_TIMEOUT_MS } from '@shared/protocol';
import type {
  BrowserScreenshotInput,
  CreateTabInput,
  WaitEventsInput,
} from '@shared/browser-command-contracts';
import { delay, formatError, startDetachedDaemon } from '../daemon-bootstrap';
import type {
  ExecuteScriptRequest,
  ExecuteScriptResult,
  WebCapAgentService,
} from './agent/contracts';
import { RuntimeBridgeError } from './runtime/runtime-bridge';
import { timeoutForBrowserCommand } from './browser/command-contracts';
import { parseRpcInput, rpcInputSchemas, type RpcMethod } from './tool-contracts';

export const DEFAULT_AGENT_RPC_PORT = 38948;
const SCRIPT_EXECUTION_RESPONSE_GRACE_MS = 5_000;
const RPC_RESPONSE_GRACE_MS = 1_000;
export const DEFAULT_RUNTIME_RECONNECT_GRACE_MS = 4_000;

interface RpcRequest {
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  id: string;
  result?: unknown;
  event?: unknown;
  error?: {
    message: string;
    code?: RuntimeBridgeError['code'];
  };
}

interface PendingRpcRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface HealthResponse {
  ok: true;
  buildId?: string;
  pid?: number;
}

interface StaleDaemonDetails {
  actualBuildId?: string;
  expectedBuildId: string;
  pid?: number;
}

class StaleDaemonError extends Error {
  constructor(
    message: string,
    readonly details: StaleDaemonDetails,
  ) {
    super(message);
    this.name = 'StaleDaemonError';
  }
}

export interface WebCapRpcClientOptions {
  autoStartDaemon?: boolean;
  connectTimeoutMs?: number;
  expectedBuildId?: string;
  handleStaleDaemon?: (details: StaleDaemonDetails) => Promise<void> | void;
  retryIntervalMs?: number;
  runtimeReconnectGraceMs?: number;
  startDaemon?: () => void;
}

export interface WebCapRpcServerOptions {
  buildId?: string;
  onClientCountChanged?: (clientCount: number) => void;
}

export function getAgentRpcPort(): number {
  const rawPort = process.env.WEB_CAP_RPC_PORT;
  if (!rawPort) {
    return DEFAULT_AGENT_RPC_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid WEB_CAP_RPC_PORT: ${rawPort}`);
  }

  return port;
}

export class WebCapRpcServer {
  private server?: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly app: WebCapAgentService,
    private readonly port = getAgentRpcPort(),
    private readonly options: WebCapRpcServerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.port,
    });

    this.server.on('connection', (socket) => {
      this.addClient(socket);
      socket.on('message', (buffer: Buffer) => {
        void this.handleMessage(socket, buffer);
      });
      socket.on('close', () => this.removeClient(socket));
      socket.on('error', () => this.removeClient(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('listening', resolve);
      this.server?.once('error', (error) => {
        this.server?.close();
        this.server = undefined;
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.notifyClientCountChanged();

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) {
        resolve();
      }
    });
    this.server = undefined;
  }

  getPort(): number {
    const address = this.server?.address();
    if (address && typeof address === 'object') {
      return address.port;
    }

    return this.port;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private addClient(socket: WebSocket): void {
    this.clients.add(socket);
    this.notifyClientCountChanged();
  }

  private removeClient(socket: WebSocket): void {
    if (!this.clients.delete(socket)) {
      return;
    }

    this.notifyClientCountChanged();
  }

  private notifyClientCountChanged(): void {
    this.options.onClientCountChanged?.(this.clients.size);
  }

  private async handleMessage(socket: WebSocket, buffer: Buffer): Promise<void> {
    try {
      const request = parseRpcRequest(JSON.parse(buffer.toString()));
      const result = await this.dispatch(request, (event) => sendEvent(socket, request.id, event));
      sendResponse(socket, { id: request.id, result });
    } catch (error) {
      const id = tryReadRpcRequestId(buffer);
      sendResponse(socket, { id, error: serializeError(error) });
    }
  }

  private async dispatch(
    request: RpcRequest,
    emitEvent?: (event: Record<string, unknown>) => void,
  ): Promise<unknown> {
    switch (request.method) {
      case 'health':
        return {
          ok: true,
          buildId: this.options.buildId,
          pid: process.pid,
        } satisfies HealthResponse;
      case 'sessionStatus':
        return await this.app.sessionStatus();
      case 'browserNewTab': {
        const params = parseRpcInput(request.method, request.params);
        return await this.app.browserNewTab(params);
      }
      case 'browserScreenshot': {
        const params = parseRpcInput(request.method, request.params);
        return await this.app.browserScreenshot(params);
      }
      case 'browserWaitEvents': {
        const params = parseRpcInput(request.method, request.params);
        return await this.app.browserWaitEvents(params, emitEvent);
      }
      case 'scriptExecute': {
        const params = parseRpcInput(request.method, request.params);
        return await this.app.scriptExecute(params);
      }
      case 'scriptHistoryList': {
        const params = parseRpcInput(request.method, request.params);
        return await this.app.scriptHistoryList(params.limit);
      }
      case 'scriptRegistryList':
        return await this.app.scriptRegistryList();
    }
  }
}

export class WebCapRpcClient {
  private socket?: WebSocket;
  private pending = new Map<string, PendingRpcRequest>();
  private connectPromise?: Promise<void>;
  private runtimeReconnectDeadlineMs = 0;

  constructor(
    private readonly port = getAgentRpcPort(),
    private readonly requestTimeoutMs = 30_000,
    private readonly options: WebCapRpcClientOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.ensureConnected();
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.connectPromise = undefined;
    this.rejectPending(new Error('WEB_CAP agent RPC client closed.'));
  }

  async sessionStatus(): Promise<RuntimeSessionSnapshot> {
    return (await this.requestWithRuntimeReconnectGrace(
      'sessionStatus',
    )) as RuntimeSessionSnapshot;
  }

  async browserNewTab(input: CreateTabInput): Promise<BrowserCommandResult> {
    return (await this.requestWithRuntimeReconnectGrace(
      'browserNewTab',
      input as Record<string, unknown>,
    )) as BrowserCommandResult;
  }

  async browserScreenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult> {
    return (await this.requestWithRuntimeReconnectGrace(
      'browserScreenshot',
      input as Record<string, unknown>,
    )) as BrowserScreenshotResult;
  }

  async browserWaitEvents(
    input: WaitEventsInput,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResult> {
    return (await this.requestWithRuntimeReconnectGrace(
      'browserWaitEvents',
      input as Record<string, unknown>,
      timeoutForBrowserCommand('wait_events', input) + RPC_RESPONSE_GRACE_MS,
      onEvent,
    )) as BrowserCommandResult;
  }

  async scriptExecute(
    request: ExecuteScriptRequest,
  ): Promise<ExecuteScriptResult> {
    const timeoutMs =
      (request.options?.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS) +
      SCRIPT_EXECUTION_RESPONSE_GRACE_MS +
      RPC_RESPONSE_GRACE_MS;
    return (await this.requestWithRuntimeReconnectGrace(
      'scriptExecute',
      request as unknown as Record<string, unknown>,
      timeoutMs,
    )) as ExecuteScriptResult;
  }

  async scriptHistoryList(limit?: number): Promise<ScriptExecutionHistoryEntry[]> {
    return (await this.request('scriptHistoryList', { limit })) as ScriptExecutionHistoryEntry[];
  }

  async scriptRegistryList(): Promise<ScriptDefinition[]> {
    return (await this.request('scriptRegistryList')) as ScriptDefinition[];
  }

  private async request(
    method: RpcMethod,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<unknown> {
    await this.ensureConnected();

    const id = randomUUID();
    const request: RpcRequest = { id, method, params };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeBridgeError(`WEB_CAP agent daemon request ${method} timed out.`, 'TIMEOUT'),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, onEvent });
      this.socket?.send(JSON.stringify(request), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async requestWithRuntimeReconnectGrace(
    method: RpcMethod,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<unknown> {
    await this.ensureConnected();

    const deadlineMs = this.runtimeReconnectDeadlineMs;
    if (!deadlineMs || Date.now() >= deadlineMs) {
      return await this.request(method, params, timeoutMs, onEvent);
    }

    let lastDisconnectedStatus: RuntimeSessionSnapshot | undefined;
    let lastError: unknown;

    while (Date.now() < deadlineMs) {
      try {
        const result = await this.request(method, params, timeoutMs, onEvent);
        if (method !== 'sessionStatus' || !isDisconnectedRuntimeStatus(result)) {
          return result;
        }

        lastDisconnectedStatus = result;
      } catch (error) {
        if (!isRuntimeDisconnectedError(error)) {
          throw error;
        }

        lastError = error;
      }

      await delay(this.options.retryIntervalMs ?? 100);
    }

    if (method === 'sessionStatus' && lastDisconnectedStatus) {
      return lastDisconnectedStatus;
    }

    if (lastError) {
      throw lastError;
    }

    return await this.request(method, params, timeoutMs, onEvent);
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.connectPromise = this.connectWithRetry();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connectWithRetry(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 5_000;
    const retryIntervalMs = this.options.retryIntervalMs ?? 100;
    const startedAt = Date.now();
    let daemonStarted = false;
    let lastError: unknown;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
        this.disposeSocket();

        if (
          this.options.autoStartDaemon &&
          (!daemonStarted || error instanceof StaleDaemonError)
        ) {
          (this.options.startDaemon ?? startDetachedDaemon)();
          daemonStarted = true;
          this.markRuntimeReconnectGrace();
        }

        await delay(retryIntervalMs);
      }
    }

    throw new Error(
      `WEB_CAP agent daemon did not become ready within ${timeoutMs}ms. Last error: ${formatError(lastError)}`,
    );
  }

  private markRuntimeReconnectGrace(): void {
    const graceMs =
      this.options.runtimeReconnectGraceMs ?? DEFAULT_RUNTIME_RECONNECT_GRACE_MS;
    if (graceMs <= 0) {
      return;
    }

    this.runtimeReconnectDeadlineMs = Math.max(
      this.runtimeReconnectDeadlineMs,
      Date.now() + graceMs,
    );
  }

  private async connectOnce(): Promise<void> {
    this.disposeSocket();
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;

    socket.on('message', (buffer: Buffer) => this.handleMessage(buffer));
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.rejectPending(new Error('WEB_CAP agent daemon disconnected.'));
    });
    socket.on('error', () => undefined);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const health = (await this.requestOnOpenSocket('health')) as HealthResponse;
    await this.ensureFreshDaemon(health);
  }

  private async requestOnOpenSocket(
    method: RpcMethod,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('WEB_CAP agent daemon is not connected.');
    }

    const id = randomUUID();
    const request: RpcRequest = { id, method, params };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeBridgeError(`WEB_CAP agent daemon request ${method} timed out.`, 'TIMEOUT'),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify(request), (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private disposeSocket(): void {
    if (!this.socket) {
      return;
    }

    this.socket.removeAllListeners();
    this.socket.close();
    this.socket = undefined;
  }

  private async ensureFreshDaemon(health: HealthResponse): Promise<void> {
    const expectedBuildId = this.options.expectedBuildId?.trim();
    if (!expectedBuildId || health.buildId === expectedBuildId) {
      return;
    }

    const details: StaleDaemonDetails = {
      actualBuildId: health.buildId,
      expectedBuildId,
      pid: health.pid,
    };

    await (this.options.handleStaleDaemon ?? defaultHandleStaleDaemon)(details);
    throw new StaleDaemonError(
      `WEB_CAP agent daemon build mismatch: expected ${expectedBuildId}, got ${health.buildId}.`,
      details,
    );
  }

  private handleMessage(buffer: Buffer): void {
    const response = JSON.parse(buffer.toString()) as RpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    if ('event' in response) {
      if (response.event && typeof response.event === 'object' && !Array.isArray(response.event)) {
        pending.onEvent?.(response.event as Record<string, unknown>);
      }
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new RuntimeBridgeError(
          response.error.message,
          response.error.code ?? 'EXECUTION_FAILED',
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isDisconnectedRuntimeStatus(value: unknown): value is RuntimeSessionSnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    'connected' in value &&
    (value as RuntimeSessionSnapshot).connected === false
  );
}

function isRuntimeDisconnectedError(error: unknown): boolean {
  return (
    error instanceof RuntimeBridgeError &&
    error.code === 'RUNTIME_DISCONNECTED'
  );
}

function sendResponse(socket: WebSocket, response: RpcResponse): void {
  socket.send(JSON.stringify(response));
}

function parseRpcRequest(raw: unknown): RpcRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeBridgeError('Invalid RPC request: request must be an object.', 'INVALID_INPUT');
  }

  const candidate = raw as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new RuntimeBridgeError('Invalid RPC request: id must be a non-empty string.', 'INVALID_INPUT');
  }
  if (!isRpcMethod(candidate.method)) {
    throw new RuntimeBridgeError('Invalid RPC request: unknown method.', 'INVALID_INPUT');
  }
  if (
    candidate.params !== undefined &&
    (!candidate.params || typeof candidate.params !== 'object' || Array.isArray(candidate.params))
  ) {
    throw new RuntimeBridgeError('Invalid RPC request: params must be an object.', 'INVALID_INPUT');
  }

  return {
    id: candidate.id,
    method: candidate.method,
    params: candidate.params as Record<string, unknown> | undefined,
  };
}

function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && value in rpcInputSchemas;
}

function tryReadRpcRequestId(buffer: Buffer): string {
  try {
    const raw = JSON.parse(buffer.toString()) as { id?: unknown };
    if (typeof raw.id === 'string' && raw.id.length > 0) {
      return raw.id;
    }
  } catch {
    return 'invalid-request';
  }

  return 'invalid-request';
}

function sendEvent(socket: WebSocket, id: string, event: Record<string, unknown>): void {
  socket.send(JSON.stringify({ id, event } satisfies RpcResponse));
}

function serializeError(error: unknown): RpcResponse['error'] {
  if (error instanceof RuntimeBridgeError) {
    return {
      message: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}

async function defaultHandleStaleDaemon(details: StaleDaemonDetails): Promise<void> {
  if (!details.pid || details.pid === process.pid) {
    return;
  }

  try {
    process.kill(details.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}
