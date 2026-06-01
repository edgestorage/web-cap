import type { ScriptDefinition } from '@shared/script-schema';
import type { ExecutionEvidenceOption } from '@shared/protocol';
import {
  annotateExecutionResponse,
  buildScriptExecutionExpression,
  type ScriptExecutionResponse,
} from './execution-helpers';

interface ChromeLike {
  userScripts?: {
    execute?(injection: UserScriptInjection): Promise<UserScriptInjectionResult[]>;
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

interface UserScriptInjectionResult {
  documentId?: string;
  frameId?: number;
  result?: ScriptExecutionResponse;
}

export class UserScriptExecutor {
  isAvailable(): boolean {
    return typeof this.getChromeApi()?.userScripts?.execute === 'function';
  }

  async executeScript(
    tabId: number,
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    scriptRegistry: ScriptDefinition[],
    evidence: ExecutionEvidenceOption[] = [],
  ): Promise<ScriptExecutionResponse> {
    const chromeApi = this.getChromeApi();
    if (!chromeApi?.userScripts?.execute) {
      throw new Error('chrome.userScripts.execute is not available in this browser runtime.');
    }

    const results = await chromeApi.userScripts.execute({
      target: { tabId },
      world: 'USER_SCRIPT',
      injectImmediately: true,
      js: [
        {
          code: buildScriptExecutionExpression(scriptDefinition, input, scriptRegistry, {
            evidence,
          }),
        },
      ],
    });

    const response = results.find((item) => item.result)?.result;
    if (!response) {
      throw new Error('No user script injection result was returned.');
    }

    return annotateExecutionResponse(response, 'user-script');
  }

  private getChromeApi(): ChromeLike | undefined {
    return (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome;
  }
}
