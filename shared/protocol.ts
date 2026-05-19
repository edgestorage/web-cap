import type { ScriptDefinition, ScriptType } from './script-schema';

export const DEFAULT_RUNTIME_PORT = 38947;
export { DEFAULT_EXECUTION_TIMEOUT_MS, MAX_EXECUTION_TIMEOUT_MS } from './script-schema';
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;

export type RuntimeErrorCode =
  | 'RUNTIME_DISCONNECTED'
  | 'TAB_NOT_FOUND'
  | 'PAGE_MISMATCH'
  | 'AUTH_REQUIRED'
  | 'INVALID_INPUT'
  | 'SCRIPT_NOT_FOUND'
  | 'EXECUTION_FAILED'
  | 'TIMEOUT';

export type BrowserCommandName =
  | 'page_inspect'
  | 'query_elements'
  | 'click_element'
  | 'fill_input'
  | 'navigate'
  | 'create_tab'
  | 'wait_events';

export interface RuntimeTabSnapshot {
  tabId: number;
  url: string;
  title: string;
  site: string;
  readyState: string;
  updatedAt: string;
}

export interface RuntimeHelloPayload {
  browserName: string;
  extensionVersion: string;
  protocolVersion: string;
  authenticatedSites: string[];
}

export interface RuntimeHelloAckPayload {
  serverVersion: string;
  sessionId: string;
  protocolVersion: string;
}

export interface RuntimeTabSnapshotPayload {
  activeTabId?: number;
  tabs: RuntimeTabSnapshot[];
  authenticatedSites: string[];
}

export interface ExecuteScriptPayload {
  scriptDefinition: ScriptDefinition;
  input: Record<string, unknown>;
  scriptRegistry: ScriptDefinition[];
  tabId?: number;
  activateTab?: boolean;
}

export interface BrowserCommandPayload {
  command: BrowserCommandName;
  input: Record<string, unknown>;
  tabId?: number;
}

export interface VisibleElementSnapshotItem {
  key: string;
  tag: string;
  id: string;
  class: string;
  merged?: boolean;
  text: string;
  rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface VisibleElementDiff {
  truncated: boolean;
  added: VisibleElementSnapshotItem[];
  removed: VisibleElementSnapshotItem[];
  updated: Array<{
    before: VisibleElementSnapshotItem;
    after: VisibleElementSnapshotItem;
  }>;
}

export interface ExecutionEvidenceEvent {
  type: string;
  value: unknown;
}

export interface ExecutionEvidence {
  url?: string;
  events: ExecutionEvidenceEvent[];
  screenshots: string[];
  visibleElements?: VisibleElementDiff;
  visibleElementsTimingMs?: number;
}

export interface ExecutionResultPayload {
  result: Record<string, unknown>;
  evidence: ExecutionEvidence;
  status?: 'succeeded' | 'interrupted';
}

export interface RuntimeErrorPayload {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface BrowserCommandResultPayload {
  result: Record<string, unknown>;
}

export interface BrowserCommandEventPayload {
  event: Record<string, unknown>;
}

export interface ScriptHistorySyncPayload {
  entries: ScriptExecutionHistoryEntry[];
}

export interface ScriptRegistrySyncPayload {
  scripts: ScriptDefinition[];
}

export type RuntimeEnvelope =
  | {
      type: 'hello';
      sessionId?: string;
      requestId?: string;
      timestamp: string;
      payload: RuntimeHelloPayload;
    }
  | {
      type: 'hello_ack';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: RuntimeHelloAckPayload;
    }
  | {
      type: 'heartbeat';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: Record<string, never>;
    }
  | {
      type: 'tab_snapshot';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: RuntimeTabSnapshotPayload;
    }
  | {
      type: 'execute_script';
      sessionId: string;
      requestId: string;
      timestamp: string;
      payload: ExecuteScriptPayload;
    }
  | {
      type: 'browser_command';
      sessionId: string;
      requestId: string;
      timestamp: string;
      payload: BrowserCommandPayload;
    }
  | {
      type: 'browser_command_result';
      sessionId: string;
      requestId: string;
      timestamp: string;
      payload: BrowserCommandResultPayload;
    }
  | {
      type: 'browser_command_event';
      sessionId: string;
      requestId: string;
      timestamp: string;
      payload: BrowserCommandEventPayload;
    }
  | {
      type: 'execution_result';
      sessionId: string;
      requestId: string;
      timestamp: string;
      payload: ExecutionResultPayload;
    }
  | {
      type: 'script_history_sync';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: ScriptHistorySyncPayload;
    }
  | {
      type: 'script_registry_sync';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: ScriptRegistrySyncPayload;
    }
  | {
      type: 'error';
      sessionId: string;
      requestId?: string;
      timestamp: string;
      payload: RuntimeErrorPayload;
    };

export interface ScriptExecutionResult {
  scriptId: string;
  scriptType: ScriptType;
  status: 'succeeded' | 'failed' | 'interrupted';
  result: Record<string, unknown>;
  notice?: string;
  evidence: ExecutionEvidence;
  timingMs: number;
  tab: RuntimeTabSnapshot;
}

export interface ScriptExecutionHistoryEntry {
  localScriptId: string;
  script: string;
  input: Record<string, unknown>;
  options?: { tabId?: number };
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  execution?: ScriptExecutionResult;
  error?: {
    message: string;
    code?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionSnapshot {
  connected: boolean;
  sessionId?: string;
  browserName?: string;
  extensionVersion?: string;
  activeTab?: RuntimeTabSnapshot;
  tabs: RuntimeTabSnapshot[];
  authenticatedSites: string[];
  lastSeenAt?: string;
  runtimes?: RuntimeConnectionSnapshot[];
}

export interface BrowserCommandResult {
  command: BrowserCommandName;
  result: Record<string, unknown>;
  timingMs: number;
  tab: RuntimeTabSnapshot;
}

export interface RuntimeConnectionSnapshot {
  connected: boolean;
  sessionId: string;
  browserName?: string;
  extensionVersion?: string;
  activeTab?: RuntimeTabSnapshot;
  tabs: RuntimeTabSnapshot[];
  authenticatedSites: string[];
  lastSeenAt?: string;
}

export interface ExecuteScriptOptions {
  tabId?: number;
  scriptRegistry?: ScriptDefinition[];
  activateTab?: boolean;
}

export function createRuntimeEnvelope<T extends RuntimeEnvelope['type']>(
  type: T,
  payload: Extract<RuntimeEnvelope, { type: T }>['payload'],
  options: {
    sessionId?: string;
    requestId?: string;
  } = {},
): Extract<RuntimeEnvelope, { type: T }> {
  const envelope = {
    type,
    timestamp: new Date().toISOString(),
    payload,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };

  return envelope as unknown as Extract<RuntimeEnvelope, { type: T }>;
}
