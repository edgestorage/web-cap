import {
  type ScriptDefinition,
  type UserScriptDefinition,
} from '@shared/script-schema';
import type {
  BrowserCommandResult,
  BrowserScreenshotResult,
  ScriptExecutionHistoryEntry,
} from '@shared/protocol';
import type { CreateTabInput, WaitEventsInput } from '@shared/browser-command-contracts';
import type { BrowserScreenshotInput } from '@shared/browser-command-contracts';
import { builtinScripts, builtinScriptRecords } from './scripts/builtin-scripts';
import type {
  ExecuteScriptRequest,
  ExecuteScriptResult,
  InstallUserScriptRequest,
  RemoveUserScriptRequest,
  WebCapAgentService,
} from './agent/contracts';
import type { ScriptProvider } from './providers/script-provider';
import { CloudScriptProvider } from './providers/cloud-script-provider';
import { CompositeScriptProvider } from './providers/composite-script-provider';
import { FileScriptProvider } from './providers/file-script-provider';
import { MemoryScriptProvider } from './providers/memory-script-provider';
import type { RuntimeBridge } from './runtime/runtime-bridge';
import { ScriptExecutionHistory } from './scripts/execution-history';
import { resolveWebCapStateDir } from './state-dir';
import { BrowserSessionService } from './browser/session-service';
import { ScriptExecutionService } from './scripts/execution-service';
import { ScriptRegistryService } from './scripts/registry-service';
import {
  FileUserScriptProvider,
  type UserScriptProvider,
} from './userscripts/file-userscript-provider';

export interface WebCapAppOptions {
  scriptProvider?: ScriptProvider;
  userScriptProvider?: UserScriptProvider;
  runtimeBridge: RuntimeBridge;
  scriptExecutionHistory?: ScriptExecutionHistory;
}

export type {
  ExecuteScriptOptions,
  ExecuteScriptRequest,
  ExecuteScriptResult,
  WebCapAgentService,
} from './agent/contracts';

export class WebCapAgentApp implements WebCapAgentService {
  public readonly scriptProvider: ScriptProvider;
  public readonly userScriptProvider: UserScriptProvider;
  public readonly runtimeBridge: RuntimeBridge;
  public readonly scriptExecutionHistory: ScriptExecutionHistory;
  private readonly browserSessionService: BrowserSessionService;
  private readonly scriptExecutionService: ScriptExecutionService;
  private readonly scriptRegistryService: ScriptRegistryService;

  constructor(options: WebCapAppOptions) {
    this.scriptProvider =
      options.scriptProvider ?? createDefaultScriptProvider(process.env);
    this.userScriptProvider =
      options.userScriptProvider ?? createDefaultUserScriptProvider(process.env);
    this.runtimeBridge = options.runtimeBridge;
    this.scriptExecutionHistory =
      options.scriptExecutionHistory ?? createDefaultScriptExecutionHistory(process.env);
    this.browserSessionService = new BrowserSessionService(this.runtimeBridge);
    this.scriptRegistryService = new ScriptRegistryService(
      this.scriptProvider,
      this.scriptExecutionHistory,
    );
    this.scriptExecutionService = new ScriptExecutionService({
      runtimeBridge: this.runtimeBridge,
      scriptExecutionHistory: this.scriptExecutionHistory,
      registryService: this.scriptRegistryService,
      browserSessionService: this.browserSessionService,
      onHistoryChanged: () => this.syncScriptHistory(),
      onRegistryChanged: () => this.syncScriptRegistry(),
    });
  }

  async start(): Promise<void> {
    await this.runtimeBridge.start();
  }

  async close(): Promise<void> {
    await this.runtimeBridge.close();
  }

  async scriptExecute(request: ExecuteScriptRequest): Promise<ExecuteScriptResult> {
    return await this.scriptExecutionService.executeInline(request);
  }

  async scriptHistoryList(limit?: number): Promise<ScriptExecutionHistoryEntry[]> {
    const entries = await this.scriptExecutionHistory.list();
    if (limit === undefined) {
      return entries;
    }

    return entries.slice(0, Math.max(0, limit));
  }

  async scriptRegistryList(): Promise<ScriptDefinition[]> {
    return await this.scriptRegistryService.buildRegisteredScriptRegistry();
  }

  async userScriptInstall(request: InstallUserScriptRequest): Promise<UserScriptDefinition> {
    const definition = await this.userScriptProvider.install(request);
    await this.syncUserScriptRegistry();
    return definition;
  }

  async userScriptList(): Promise<UserScriptDefinition[]> {
    return await this.userScriptProvider.list();
  }

  async userScriptRemove(request: RemoveUserScriptRequest): Promise<UserScriptDefinition> {
    const definition = await this.userScriptProvider.remove(request.id);
    await this.syncUserScriptRegistry();
    return definition;
  }

  async browserScreenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult> {
    return await this.browserSessionService.screenshot(input);
  }

  async browserNewTab(input: CreateTabInput): Promise<BrowserCommandResult> {
    return await this.browserSessionService.newTab(input);
  }

  async browserWaitEvents(
    input: WaitEventsInput,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResult> {
    return await this.browserSessionService.waitEvents(input, onEvent);
  }

  sessionStatus() {
    return this.browserSessionService.status();
  }

  private async syncScriptHistory(): Promise<void> {
    if (typeof this.runtimeBridge.syncScriptHistory !== 'function') {
      return;
    }

    await this.runtimeBridge.syncScriptHistory(await this.scriptExecutionHistory.list());
  }

  private async syncScriptRegistry(): Promise<void> {
    if (typeof this.runtimeBridge.syncScriptRegistry !== 'function') {
      return;
    }

    await this.runtimeBridge.syncScriptRegistry(await this.scriptRegistryList());
  }

  private async syncUserScriptRegistry(): Promise<void> {
    if (typeof this.runtimeBridge.syncUserScriptRegistry !== 'function') {
      return;
    }

    await this.runtimeBridge.syncUserScriptRegistry(await this.userScriptList());
  }
}

interface ScriptProviderEnvironment {
  WEB_CAP_SCRIPT_REGISTRY_URL?: string;
  WEB_CAP_SCRIPT_REGISTRY_API_KEY?: string;
  WEB_CAP_STATE_DIR?: string;
}

export function createDefaultScriptProvider(
  env: ScriptProviderEnvironment = process.env,
): ScriptProvider {
  const stateDir = resolveWebCapStateDir(env);
  const builtinProvider = new MemoryScriptProvider([...builtinScriptRecords]);
  const cloudProvider = new CloudScriptProvider({
    baseUrl: env.WEB_CAP_SCRIPT_REGISTRY_URL,
    apiKey: env.WEB_CAP_SCRIPT_REGISTRY_API_KEY,
    fallback: null,
  });
  const fileProvider = new FileScriptProvider(stateDir);

  return new CompositeScriptProvider({
    providers: [builtinProvider, cloudProvider, fileProvider],
    writableProviders: [cloudProvider, fileProvider],
  });
}

export function createDefaultUserScriptProvider(
  env: ScriptProviderEnvironment = process.env,
): UserScriptProvider {
  return new FileUserScriptProvider(resolveWebCapStateDir(env));
}

export function createDefaultScriptExecutionHistory(
  env: ScriptProviderEnvironment = process.env,
): ScriptExecutionHistory {
  const stateDir = resolveWebCapStateDir(env);
  return new ScriptExecutionHistory(`${stateDir}/script-execution-history.json`);
}

export { builtinScripts };
