import type { ScriptDefinition } from '@shared/script-schema';
import type {
  BrowserCommandResult,
  BrowserScreenshotResult,
  ScriptExecutionHistoryEntry,
  ScriptExecutionResult,
  ExecutionEvidenceOption,
  RuntimeSessionSnapshot,
} from '@shared/protocol';
import type {
  BrowserScreenshotInput,
  CreateTabInput,
  WaitEventsInput,
} from '@shared/browser-command-contracts';

export interface ExecuteScriptRequest {
  script: string;
  input: Record<string, unknown>;
  options?: ExecuteScriptOptions;
  register?: boolean;
}

export interface ExecuteScriptOptions {
  tabId?: number;
  timeoutMs?: number;
  activateTab?: boolean;
  evidence?: ExecutionEvidenceOption[];
}

export type ExecuteScriptResult = ScriptExecutionResult;

export interface WebCapAgentService {
  start(): Promise<void>;
  close(): Promise<void>;
  scriptExecute(request: ExecuteScriptRequest): Promise<ExecuteScriptResult>;
  scriptHistoryList(limit?: number): Promise<ScriptExecutionHistoryEntry[]>;
  scriptRegistryList(): Promise<ScriptDefinition[]>;
  browserScreenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult>;
  browserNewTab(input: CreateTabInput): Promise<BrowserCommandResult>;
  browserWaitEvents(
    input: WaitEventsInput,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResult>;
  sessionStatus(): RuntimeSessionSnapshot | Promise<RuntimeSessionSnapshot>;
}
