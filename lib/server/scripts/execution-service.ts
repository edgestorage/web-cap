import type {
  ScriptDefinition,
} from '@shared/script-schema';
import {
  matchesUrlPatterns,
  validateInputAgainstSchema,
} from '@shared/validation';
import type {
  ScriptExecutionHistoryEntry,
  ScriptExecutionResult,
  RuntimeTabSnapshot,
  ExecutionEvidenceOption,
} from '@shared/protocol';
import type {
  ExecuteScriptOptions,
  ExecuteScriptRequest,
  ExecuteScriptResult,
} from '../agent/contracts';
import type { RuntimeBridge } from '../runtime/runtime-bridge';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';
import { ScriptExecutionHistory } from './execution-history';
import { executeScriptOptionsSchema } from '../tool-contracts';
import { BrowserSessionService } from '../browser/session-service';
import {
  buildInlineScriptDefinition,
  ScriptRegistryService,
} from './registry-service';

export interface ExecutionPlan {
  scriptDefinition: ScriptDefinition;
  input: Record<string, unknown>;
  target: {
    tabId: number;
    url: string;
    tab: RuntimeTabSnapshot;
  };
  registry: ScriptDefinition[];
  timeoutMs: number;
  activateTab?: boolean;
  evidence: ExecutionEvidenceOption[];
  mouseTrajectorySimulation?: boolean;
  includeTabInResult: boolean;
  historyMode: 'temporary' | 'permanent';
}

interface ScriptExecutionServiceOptions {
  runtimeBridge: RuntimeBridge;
  scriptExecutionHistory: ScriptExecutionHistory;
  registryService: ScriptRegistryService;
  browserSessionService: BrowserSessionService;
  onHistoryChanged?: () => Promise<void>;
  onRegistryChanged?: () => Promise<void>;
}

export class ScriptExecutionService {
  private readonly runtimeBridge: RuntimeBridge;
  private readonly scriptExecutionHistory: ScriptExecutionHistory;
  private readonly registryService: ScriptRegistryService;
  private readonly browserSessionService: BrowserSessionService;
  private readonly onHistoryChanged?: () => Promise<void>;
  private readonly onRegistryChanged?: () => Promise<void>;

  constructor(options: ScriptExecutionServiceOptions) {
    this.runtimeBridge = options.runtimeBridge;
    this.scriptExecutionHistory = options.scriptExecutionHistory;
    this.registryService = options.registryService;
    this.browserSessionService = options.browserSessionService;
    this.onHistoryChanged = options.onHistoryChanged;
    this.onRegistryChanged = options.onRegistryChanged;
  }

  async executeInline(request: ExecuteScriptRequest): Promise<ExecuteScriptResult> {
    const shouldRegister = request.register === true;
    const options = normalizeExecuteScriptOptions(request.options);
    const historyOptions = buildHistoryOptions(options);
    const reserved = await this.scriptExecutionHistory.reserve(
      request.script,
      request.input,
      historyOptions,
      shouldRegister ? 'permanent' : 'temporary',
    );
    await this.onHistoryChanged?.();
    const scriptDefinition = buildInlineScriptDefinition(
      reserved.localScriptId,
      request.script,
      options.timeoutMs,
    );

    try {
      const plan = await this.buildExecutionPlan(
        scriptDefinition,
        request.input,
        options,
        shouldRegister ? 'permanent' : 'temporary',
      );
      const execution = await this.executePlan(plan);
      const completed = await this.completeInlineExecution({
        execution,
        targetUrl: plan.target.url,
        reserved,
        request,
        shouldRegister,
      });
      await this.onHistoryChanged?.();
      return completed;
    } catch (error) {
      await this.scriptExecutionHistory.markFailed(reserved.localScriptId, error);
      await this.onHistoryChanged?.();
      throw error;
    }
  }

  async buildExecutionPlan(
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    options: ExecuteScriptOptions = {},
    historyMode: 'temporary' | 'permanent' = 'temporary',
  ): Promise<ExecutionPlan> {
    const validation = validateInputAgainstSchema(input, scriptDefinition.inputSchema);
    if (!validation.ok) {
      throw new RuntimeBridgeError(
        `Script input validation failed: ${validation.errors.join(' ')}`,
        'INVALID_INPUT',
      );
    }

    const target = this.browserSessionService.resolveExecutionTarget(options.tabId);
    if (!matchesUrlPatterns(target.tab.url, scriptDefinition.target.urlPatterns)) {
      throw new RuntimeBridgeError(
        `Active tab ${target.tab.url} does not match script target patterns.`,
        'PAGE_MISMATCH',
      );
    }

    return {
      scriptDefinition,
      input,
      target: {
        tabId: target.tab.tabId,
        url: target.tab.url,
        tab: target.tab,
      },
      registry: await this.registryService.buildExecutionScriptRegistry(scriptDefinition.id),
      timeoutMs: scriptDefinition.script.timeoutMs,
      activateTab: options.activateTab,
      evidence: normalizeEvidenceOptions(options.evidence),
      mouseTrajectorySimulation: options.mouseTrajectorySimulation,
      includeTabInResult: options.tabId === undefined,
      historyMode,
    };
  }

  async executePlan(plan: ExecutionPlan): Promise<ScriptExecutionResult> {
    return await this.runtimeBridge.executeScript(plan.scriptDefinition, plan.input, {
      tabId: plan.target.tabId,
      scriptRegistry: plan.registry,
      activateTab: plan.activateTab,
      evidence: plan.evidence,
      mouseTrajectorySimulation: plan.mouseTrajectorySimulation,
      includeTabInResult: plan.includeTabInResult,
    });
  }

  private async completeInlineExecution(input: {
    execution: ScriptExecutionResult;
    targetUrl: string;
    reserved: ScriptExecutionHistoryEntry;
    request: ExecuteScriptRequest;
    shouldRegister: boolean;
  }): Promise<ExecuteScriptResult> {
    const { execution, targetUrl, reserved, request, shouldRegister } = input;
    let notice: string | undefined;
    let resultLocalScriptId = reserved.localScriptId;
    let executionResult = execution;
    if (shouldRegister) {
      if (hasSuccessfulOkResult(execution.result)) {
        try {
          await this.registryService.saveScriptDefinition(
            buildInlineScriptDefinition(reserved.localScriptId, request.script),
            { lastExecutedPage: targetUrl },
          );
          await this.onRegistryChanged?.();
          notice = buildPermanentScriptNotice(reserved.localScriptId);
        } catch (error) {
          const temporaryEntry = await this.scriptExecutionHistory.convertToTemporary(
            reserved.localScriptId,
          );
          resultLocalScriptId = temporaryEntry.localScriptId;
          executionResult = {
            ...execution,
            scriptId: resultLocalScriptId,
          };
          notice = buildRegistrationFailedNotice(
            reserved.localScriptId,
            resultLocalScriptId,
            error,
          );
        }
      } else {
        const temporaryEntry = await this.scriptExecutionHistory.convertToTemporary(
          reserved.localScriptId,
        );
        resultLocalScriptId = temporaryEntry.localScriptId;
        executionResult = {
          ...execution,
          scriptId: resultLocalScriptId,
        };
        notice = buildRegistrationSkippedNotice(reserved.localScriptId, resultLocalScriptId);
      }
    } else {
      notice = undefined;
    }

    const executionWithNotice =
      notice === undefined
        ? executionResult
        : {
            ...executionResult,
            notice,
          };
    if (executionWithNotice.status === 'interrupted') {
      await this.scriptExecutionHistory.markInterrupted(resultLocalScriptId, executionWithNotice);
    } else {
      await this.scriptExecutionHistory.markSucceeded(resultLocalScriptId, executionWithNotice);
    }

    return executionWithNotice;
  }
}

function normalizeExecuteScriptOptions(options?: ExecuteScriptOptions): ExecuteScriptOptions {
  const parsed = executeScriptOptionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    throw new RuntimeBridgeError(
      `Invalid script execution options: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'options'} ${issue.message}`)
        .join('; ')}`,
      'INVALID_INPUT',
    );
  }

  return parsed.data;
}

function normalizeEvidenceOptions(
  evidence: ExecutionEvidenceOption[] | undefined,
): ExecutionEvidenceOption[] {
  return [...new Set(evidence ?? (['common'] as ExecutionEvidenceOption[]))];
}

function buildHistoryOptions(options: ExecuteScriptOptions): { tabId?: number } | undefined {
  if (options.tabId === undefined) {
    return undefined;
  }

  return { tabId: options.tabId };
}

function buildPermanentScriptNotice(scriptId: string): string {
  return `Registered as permanent script ${scriptId}. You can reuse it by calling cap.call('${scriptId}', xxx).`;
}

function buildRegistrationSkippedNotice(scriptId: string, temporaryScriptId: string): string {
  return `Script ${scriptId} was not registered because register=true requires the execution result to include ok: true. It remains available temporarily as ${temporaryScriptId}.`;
}

function buildRegistrationFailedNotice(
  scriptId: string,
  temporaryScriptId: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Script ${scriptId} could not be registered: ${message}. It remains available temporarily as ${temporaryScriptId}.`;
}

function hasSuccessfulOkResult(result: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(result, 'ok') && result.ok === true;
}
