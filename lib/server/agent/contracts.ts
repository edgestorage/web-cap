import type {
  ScriptSearchFilters,
  CloudScriptRecord,
  ScriptDefinition,
} from '@shared/script-schema';
import type {
  BrowserCommandResult,
  ScriptExecutionHistoryEntry,
  ScriptExecutionResult,
  ExecutionEvidenceOption,
  RuntimeSessionSnapshot,
} from '@shared/protocol';
import type {
  CreateTabInput,
  WaitEventsInput,
} from '@shared/browser-command-contracts';
import type { toSchemaSummary } from '@shared/validation';

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
  scriptSearch(query: string, filters?: ScriptSearchFilters): Promise<unknown>;
  scriptGet(scriptId: string, version?: string): Promise<ReturnType<typeof toSchemaSummary>>;
  scriptExecute(request: ExecuteScriptRequest): Promise<ExecuteScriptResult>;
  scriptHistoryList(limit?: number): Promise<ScriptExecutionHistoryEntry[]>;
  scriptRegistryList(): Promise<ScriptDefinition[]>;
  scriptRegister(rawScriptDefinition: unknown): Promise<CloudScriptRecord>;
  browserNewTab(input: CreateTabInput): Promise<BrowserCommandResult>;
  browserWaitEvents(
    input: WaitEventsInput,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResult>;
  sessionStatus(): RuntimeSessionSnapshot | Promise<RuntimeSessionSnapshot>;
}
