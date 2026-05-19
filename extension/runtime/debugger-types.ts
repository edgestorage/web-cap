import type { ScriptExecutionResponse } from './execution-helpers';

export interface DebuggeeTarget {
  tabId: number;
}

export interface ChromeLike {
  debugger?: {
    attach(
      target: DebuggeeTarget,
      requiredVersion: string,
      callback: () => void,
    ): void;
    detach(target: DebuggeeTarget, callback: () => void): void;
    sendCommand(
      target: DebuggeeTarget,
      method: string,
      commandParams: Record<string, unknown>,
      callback: (result?: unknown) => void,
    ): void;
    onEvent?: {
      addListener(
        listener: (
          source: DebuggeeTarget,
          method: string,
          params?: Record<string, unknown>,
        ) => void,
      ): void;
      removeListener(
        listener: (
          source: DebuggeeTarget,
          method: string,
          params?: Record<string, unknown>,
        ) => void,
      ): void;
    };
  };
  runtime?: {
    lastError?: {
      message: string;
    };
  };
}

export interface DebuggerEvaluateResult {
  result?: {
    type?: string;
    value?: ScriptExecutionResponse;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: string;
    };
  };
}

export interface ManagedInputBridge {
  bridgeFunctionName: string;
  dispose: () => Promise<void>;
}
