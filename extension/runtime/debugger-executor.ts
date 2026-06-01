import type { ScriptDefinition } from '@shared/script-schema';
import type { ExecutionEvidenceOption } from '@shared/protocol';
import { ChromeDebuggerClient } from './chrome-debugger-client';
import type { DebuggerEvaluateResult } from './debugger-types';
import {
  annotateExecutionResponse,
  buildScriptExecutionExpression,
  type ScriptExecutionResponse,
} from './execution-helpers';
import { ManagedInputBridgeFactory } from './managed-input-bridge';

export class DebuggerScriptExecutor {
  private readonly client: ChromeDebuggerClient;
  private readonly managedInputBridgeFactory: ManagedInputBridgeFactory;

  constructor(idleDetachDelayMs?: number) {
    this.client = new ChromeDebuggerClient(idleDetachDelayMs, (tabId) => {
      this.managedInputBridgeFactory.clearPointerPosition(tabId);
    });
    this.managedInputBridgeFactory = new ManagedInputBridgeFactory(this.client, async (tabId) => {
      await browser.tabs.remove(tabId);
    });
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  async executeScript(
    tabId: number,
    scriptDefinition: ScriptDefinition,
    input: Record<string, unknown>,
    scriptRegistry: ScriptDefinition[],
    evidence: ExecutionEvidenceOption[] = [],
  ): Promise<ScriptExecutionResponse> {
    if (!this.isAvailable()) {
      throw new Error('chrome.debugger is not available in this browser runtime.');
    }

    return await this.client.withAttachedDebugger(tabId, async (target) => {
      await this.client.sendCommand(target, 'Runtime.enable');
      const executionScope = this.managedInputBridgeFactory.createExecutionScope(
        globalThis.crypto?.randomUUID?.(),
      );
      const timerBridge =
        await this.managedInputBridgeFactory.createManagedTimerBridge(target, executionScope);
      const clickBridge =
        await this.managedInputBridgeFactory.createManagedClickBridge(
          target,
          executionScope,
        );
      const keyboardBridge =
        await this.managedInputBridgeFactory.createManagedKeyboardBridge(target, executionScope);
      const windowBridge =
        await this.managedInputBridgeFactory.createManagedWindowBridge(target, executionScope);
      const browserBridge =
        await this.managedInputBridgeFactory.createManagedBrowserBridge(target, executionScope);
      let evaluation: DebuggerEvaluateResult;
      try {
        evaluation = await this.client.sendCommand<DebuggerEvaluateResult>(target, 'Runtime.evaluate', {
          expression: buildScriptExecutionExpression(scriptDefinition, input, scriptRegistry, {
            managedClickBridgeFunctionName: clickBridge.bridgeFunctionName,
            managedKeyboardBridgeFunctionName: keyboardBridge.bridgeFunctionName,
            managedWindowBridgeFunctionName: windowBridge.bridgeFunctionName,
            managedTimerBridgeFunctionName: timerBridge.bridgeFunctionName,
            managedBrowserBridgeFunctionName: browserBridge.bridgeFunctionName,
            evidence,
          }),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          allowUnsafeEvalBlockedByCSP: true,
        });
      } finally {
        await browserBridge.dispose();
        await timerBridge.dispose();
        await windowBridge.dispose();
        await keyboardBridge.dispose();
        await clickBridge.dispose();
      }

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.exception?.value ??
          evaluation.exceptionDetails.text ??
          'Debugger evaluation failed.';
        throw new Error(message);
      }

      const response = evaluation.result?.value;
      if (!response) {
        throw new Error('Debugger evaluation returned no result.');
      }

      return annotateExecutionResponse(response, 'debugger');
    });
  }
}
