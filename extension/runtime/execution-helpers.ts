import type { ScriptDefinition } from '@shared/script-schema';
import type {
  ExecutionEvidence,
  ExecutionEvidenceEvent,
  ExecutionEvidenceOption,
} from '@shared/protocol';
import { scriptRuntimeSource } from './injected/script-runtime.generated';
import ts from 'typescript';

export interface ScriptExecutionResponse {
  ok: boolean;
  status?: 'succeeded' | 'interrupted';
  result?: Record<string, unknown>;
  evidence?: ExecutionEvidence;
  error?: string;
}

export interface ScriptExecutionExpressionOptions {
  managedClickBridgeFunctionName?: string;
  managedKeyboardBridgeFunctionName?: string;
  managedWindowBridgeFunctionName?: string;
  managedTimerBridgeFunctionName?: string;
  managedBrowserBridgeFunctionName?: string;
  evidence?: ExecutionEvidenceOption[];
}

export function scriptToFunctionExpression(code: string): string {
  const trimmed = rewriteTimerCallsToScopedTimers(
    insertManagedInputWaitAfterManagedInputStatements(code.trim()),
  );
  if (trimmed.startsWith('export default')) {
    return `(${ensureAsyncFunctionExpression(trimmed.replace(/^export\s+default\s+/, ''))})`;
  }
  if (looksLikeFunctionExpression(trimmed)) {
    return `(${ensureAsyncFunctionExpression(trimmed)})`;
  }
  return `(async function (input) {\n${trimmed}\n})`;
}

function looksLikeFunctionExpression(code: string): boolean {
  return (
    /^(?:async\s+)?function(?:\s+[\w$]+)?\s*\(/.test(code) ||
    /^(?:async\s*)?\([^)]*\)\s*=>/.test(code) ||
    /^(?:async\s+)?[\w$]+\s*=>/.test(code)
  );
}

function ensureAsyncFunctionExpression(code: string): string {
  if (/^async\b/.test(code)) {
    return code;
  }

  if (/^function\b/.test(code)) {
    return `async ${code}`;
  }

  if (/^\([^)]*\)\s*=>/.test(code) || /^[\w$]+\s*=>/.test(code)) {
    return `async ${code}`;
  }

  return code;
}

function insertManagedInputWaitAfterManagedInputStatements(code: string): string {
  const sourceFile = ts.createSourceFile(
    'web-cap-script.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const insertions: Array<{ position: number; text: string }> = [];
  const asyncFunctionInsertionPositions = new Set<number>();

  const recordStatements = (
    statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    containingFunction: ts.FunctionLikeDeclaration | null,
  ) => {
    for (const statement of statements) {
      if (!isManagedInputStatement(statement)) {
        continue;
      }
      const position = statement.getEnd();
      const nextText = code.slice(position, position + 80);
      if (/^\s*await\s+cap\.waitForManagedInput\s*\(/.test(nextText)) {
        continue;
      }
      const indentation = readNextLineIndentation(code, position);
      insertions.push({
        position,
        text: `\n${indentation}await cap.waitForManagedInput();`,
      });
      if (containingFunction && !hasAsyncModifier(containingFunction)) {
        asyncFunctionInsertionPositions.add(readAsyncInsertionPosition(containingFunction));
      }
    }
  };

  const visit = (node: ts.Node, containingFunction: ts.FunctionLikeDeclaration | null) => {
    const nextContainingFunction = isFunctionLikeDeclaration(node)
      ? node
      : containingFunction;

    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      recordStatements(node.statements, ts.isSourceFile(node) ? null : containingFunction);
    }
    ts.forEachChild(node, (child) => visit(child, nextContainingFunction));
  };
  visit(sourceFile, null);

  for (const position of asyncFunctionInsertionPositions) {
    insertions.push({ position, text: 'async ' });
  }

  if (insertions.length === 0) {
    return code;
  }

  return applyInsertions(code, insertions);
}

function isManagedInputStatement(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && isManagedInputCall(skipExpressionParens(statement.expression));
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function hasAsyncModifier(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
  );
}

function readAsyncInsertionPosition(node: ts.FunctionLikeDeclaration): number {
  const modifiers = ts.getModifiers(node);
  if (modifiers && modifiers.length > 0) {
    return modifiers[modifiers.length - 1].end + 1;
  }
  return node.getStart();
}

function isManagedInputCall(expression: ts.Expression): boolean {
  if (ts.isAwaitExpression(expression)) {
    return isManagedInputCall(skipExpressionParens(expression.expression));
  }
  if (!ts.isCallExpression(expression)) {
    return false;
  }
  const callee = skipExpressionParens(expression.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  return callee.name.text === 'click' || callee.name.text === 'dispatchEvent';
}

function skipExpressionParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function readNextLineIndentation(code: string, position: number): string {
  const lineBreakIndex = code.indexOf('\n', position);
  if (lineBreakIndex < 0) {
    const lineStart = code.lastIndexOf('\n', position - 1) + 1;
    const currentLine = code.slice(lineStart, position);
    return currentLine.match(/^[ \t]*/)?.[0] ?? '';
  }
  return code.slice(lineBreakIndex + 1).match(/^[ \t]*/)?.[0] ?? '';
}

function applyInsertions(code: string, insertions: Array<{ position: number; text: string }>) {
  let output = '';
  let cursor = 0;
  for (const insertion of [...insertions].sort((first, second) => first.position - second.position)) {
    output += code.slice(cursor, insertion.position);
    output += insertion.text;
    cursor = insertion.position;
  }
  return output + code.slice(cursor);
}

function rewriteTimerCallsToScopedTimers(code: string): string {
  const sourceFile = ts.createSourceFile(
    'web-cap-script.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let changed = false;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const scopedTimerName = readScopedTimerName(node.expression);
        if (scopedTimerName) {
          changed = true;
          return ts.factory.updateCallExpression(
            node,
            ts.factory.createIdentifier(scopedTimerName),
            node.typeArguments,
            node.arguments,
          );
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };

  const result = ts.transform(sourceFile, [transformer]);
  try {
    if (!changed) {
      return code;
    }

    return ts
      .createPrinter({ removeComments: false })
      .printFile(result.transformed[0])
      .trim();
  } finally {
    result.dispose();
  }
}

function readScopedTimerName(expression: ts.Expression): 'setTimeout' | 'clearTimeout' | undefined {
  const callee = skipExpressionParens(expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const receiver = skipExpressionParens(callee.expression);
  if (!ts.isIdentifier(receiver) || !['window', 'globalThis', 'self'].includes(receiver.text)) {
    return undefined;
  }

  if (callee.name.text === 'setTimeout' || callee.name.text === 'clearTimeout') {
    return callee.name.text;
  }

  return undefined;
}

export function isDebuggerFallbackEligibleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('unsafe-eval') ||
    message.includes('Content Security Policy') ||
    message.includes('Refused to evaluate a string as JavaScript') ||
    message.includes('Refused to compile or execute string') ||
    message.includes('chrome.userScripts') ||
    message.includes('userScripts') ||
    message.includes('Cannot access contents of url') ||
    message.includes('No user script injection result') ||
    message.includes('document is not defined') ||
    message.includes('window is not defined')
  );
}

export function isExecutionInterruptedByNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'Execution context was destroyed',
    'Cannot find context with specified id',
    'Inspected target navigated or closed',
    'Frame was detached',
    'No frame with given id found',
    'Target closed',
  ].some((fragment) => message.includes(fragment));
}

export function annotateExecutionResponse(
  response: ScriptExecutionResponse,
  _executor: 'user-script' | 'debugger',
  note?: string,
): ScriptExecutionResponse {
  const evidence = response.evidence ?? {
    url: undefined,
    events: [],
    screenshots: [],
  };

  const events: ExecutionEvidenceEvent[] = [];
  if (note) {
    events.push({ type: 'note', value: note });
  }

  response.evidence = {
    ...evidence,
    events: [...events, ...evidence.events],
  };
  return response;
}

export function buildScriptExecutionExpression(
  scriptDefinition: ScriptDefinition,
  input: Record<string, unknown>,
  scriptRegistry: ScriptDefinition[],
  options: ScriptExecutionExpressionOptions = {},
): string {
  const managedClickBridgeFunctionName =
    options.managedClickBridgeFunctionName === undefined
      ? null
      : String(options.managedClickBridgeFunctionName);
  const managedKeyboardBridgeFunctionName =
    options.managedKeyboardBridgeFunctionName === undefined
      ? null
      : String(options.managedKeyboardBridgeFunctionName);
  const managedWindowBridgeFunctionName =
    options.managedWindowBridgeFunctionName === undefined
      ? null
      : String(options.managedWindowBridgeFunctionName);
  const managedTimerBridgeFunctionName =
    options.managedTimerBridgeFunctionName === undefined
      ? null
      : String(options.managedTimerBridgeFunctionName);
  const managedBrowserBridgeFunctionName =
    options.managedBrowserBridgeFunctionName === undefined
      ? null
      : String(options.managedBrowserBridgeFunctionName);
  const evidence = options.evidence ?? [];
  const scripts = new Map<string, ScriptDefinition>();
  for (const item of scriptRegistry) {
    scripts.set(item.id, item);
  }
  scripts.set(scriptDefinition.id, scriptDefinition);

  const scriptFactoriesSource = [...scripts.values()]
    .map(
      (item) =>
        `${JSON.stringify(item.id)}: ${scriptToFunctionExpression(item.script.code)}`,
    )
    .join(',\n');

  return `
(() => {
  const scriptDefinition = ${JSON.stringify(scriptDefinition)};
  const input = ${JSON.stringify(input)};
  const scriptRegistry = ${JSON.stringify(scriptRegistry)};
  const managedClickBridgeFunctionName = ${JSON.stringify(managedClickBridgeFunctionName)};
  const managedKeyboardBridgeFunctionName = ${JSON.stringify(managedKeyboardBridgeFunctionName)};
  const managedWindowBridgeFunctionName = ${JSON.stringify(managedWindowBridgeFunctionName)};
  const managedTimerBridgeFunctionName = ${JSON.stringify(managedTimerBridgeFunctionName)};
  const managedBrowserBridgeFunctionName = ${JSON.stringify(managedBrowserBridgeFunctionName)};
  const evidence = ${JSON.stringify(evidence)};
  const timerBridge = managedTimerBridgeFunctionName ? globalThis[managedTimerBridgeFunctionName] : null;
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const managedTimerHandles = new Map();
  const createTimerId = () =>
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
  const setTimeout = (handler, timeout = 0, ...args) => {
    if (typeof timerBridge !== 'function' || typeof handler !== 'function') {
      return nativeSetTimeout(handler, timeout, ...args);
    }

    const id = createTimerId();
    const handle = { cleared: false };
    managedTimerHandles.set(id, handle);
    Promise.resolve(timerBridge({ action: 'schedule', id, delayMs: Number(timeout) || 0 }))
      .then(() => {
        managedTimerHandles.delete(id);
        if (!handle.cleared) {
          handler(...args);
        }
      })
      .catch((error) => {
        managedTimerHandles.delete(id);
        if (!handle.cleared) {
          console.error('[WEB_CAP] managed timer failed', error);
        }
      });
    return id;
  };
  const clearTimeout = (id) => {
    if (managedTimerHandles.has(id)) {
      const handle = managedTimerHandles.get(id);
      handle.cleared = true;
      managedTimerHandles.delete(id);
      if (typeof timerBridge === 'function') {
        void Promise.resolve(timerBridge({ action: 'clear', id })).catch(() => undefined);
      }
      return;
    }
    nativeClearTimeout(id);
  };
  const scriptFactories = {
    ${scriptFactoriesSource}
  };

  return ${scriptRuntimeSource}({
    scriptDefinition,
    input,
    scriptRegistry,
    managedClickBridgeFunctionName,
    managedKeyboardBridgeFunctionName,
    managedWindowBridgeFunctionName,
    managedTimerBridgeFunctionName,
    managedBrowserBridgeFunctionName,
    evidence,
    scriptFactories,
  });
})()
  `.trim();
}
