import type { ScriptDefinition } from '@shared/script-schema';
import type {
  BrowserCommandName,
  BrowserCommandResult,
  ScriptExecutionResult,
  ExecuteScriptOptions,
  ScriptExecutionHistoryEntry,
  RuntimeSessionSnapshot,
} from '@shared/protocol';

export interface BrowserCommandOptions {
  tabId?: number;
  timeoutMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface RuntimeBridge {
  start(): Promise<void>;
  close(): Promise<void>;
  getSessionStatus(): RuntimeSessionSnapshot;
  executeScript(
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    options?: ExecuteScriptOptions,
  ): Promise<ScriptExecutionResult>;
  executeBrowserCommand(
    command: BrowserCommandName,
    input: Record<string, unknown>,
    options?: BrowserCommandOptions,
  ): Promise<BrowserCommandResult>;
  syncScriptHistory?(entries: ScriptExecutionHistoryEntry[]): Promise<void>;
  syncScriptRegistry?(scripts: ScriptDefinition[]): Promise<void>;
}

export class RuntimeBridgeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'RUNTIME_DISCONNECTED'
      | 'PAGE_MISMATCH'
      | 'AUTH_REQUIRED'
      | 'TAB_NOT_FOUND'
      | 'SCRIPT_NOT_FOUND'
      | 'TIMEOUT'
      | 'INVALID_INPUT'
      | 'EXECUTION_FAILED',
  ) {
    super(message);
  }
}
