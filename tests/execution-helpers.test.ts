import { afterEach, describe, expect, it } from 'vitest';
import { scriptDefinitionSchema } from '@shared/script-schema';
import { scriptRuntimeSource } from '../extension/runtime/injected/script-runtime.generated';
import {
  annotateExecutionResponse,
  buildScriptExecutionExpression,
  isDebuggerFallbackEligibleError,
  isExecutionInterruptedByNavigationError,
  scriptToFunctionExpression,
} from '../extension/runtime/execution-helpers';

describe('execution helpers', () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  afterEach(() => {
    if (previousLocation) {
      Object.defineProperty(globalThis, 'location', previousLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }

    if (previousHistory) {
      Object.defineProperty(globalThis, 'history', previousHistory);
    } else {
      delete (globalThis as { history?: unknown }).history;
    }

    if (previousNavigator) {
      Object.defineProperty(globalThis, 'navigator', previousNavigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }

    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', previousDocument);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('detects CSP failures as debugger fallback candidates', () => {
    expect(
      isDebuggerFallbackEligibleError(
        new Error("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed."),
      ),
    ).toBe(true);
    expect(isDebuggerFallbackEligibleError(new Error('Selector #email was not found.'))).toBe(
      false,
    );
  });

  it('only treats actual execution-context loss as navigation interruption', () => {
    expect(
      isExecutionInterruptedByNavigationError(
        new Error('Execution context was destroyed, most likely because of a navigation.'),
      ),
    ).toBe(true);
    expect(
      isExecutionInterruptedByNavigationError(
        new Error('Inspected target navigated or closed'),
      ),
    ).toBe(true);

    expect(isExecutionInterruptedByNavigationError(new Error('URL changed to #/system'))).toBe(
      false,
    );
    expect(isExecutionInterruptedByNavigationError(new Error('Selector #submit was not found.'))).toBe(
      false,
    );
  });

  it('annotates execution responses with the executor used', () => {
    const response = annotateExecutionResponse(
      {
        ok: true,
        result: { ok: true },
        evidence: {
          url: 'https://example.com',
          events: [{ type: 'message', value: 'original-log' }],
          screenshots: [],
        },
      },
      'debugger',
      'fallback:csp',
    );

    expect(response.evidence?.events).toEqual([
      { type: 'executor', value: 'debugger' },
      { type: 'note', value: 'fallback:csp' },
      { type: 'message', value: 'original-log' },
    ]);
  });

  it('keeps the generated injected runtime inspectable and free of bundler wrappers', () => {
    expect(scriptRuntimeSource).toMatch(/^\(\(\) => \{/);
    expect(scriptRuntimeSource).toContain('function captureVisibleElementsDiff()');
    expect(scriptRuntimeSource).toContain('snapshotForChanges');
    expect(scriptRuntimeSource).toContain('async function runScriptRuntime');
    expect(scriptRuntimeSource).toContain('MutationObserver');
    expect(scriptRuntimeSource).toContain('managed_click');
    expect(scriptRuntimeSource).toContain('function installManagedClickHook(');
    expect(scriptRuntimeSource).toContain('async waitForManagedInput()');
    expect(scriptRuntimeSource).toContain('function managedMouseDispatch(');
    expect(scriptRuntimeSource).toContain('function installManagedKeyboardDispatchHook()');
    expect(scriptRuntimeSource).not.toContain('__name');
    expect(scriptRuntimeSource).not.toContain('import_');
    expect(scriptRuntimeSource).not.toMatch(/^\s*export\s/m);
    expect(scriptRuntimeSource).not.toMatch(/^\s*import\s/m);
  });

  it('accepts arrow functions and bare function bodies as inline script source', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: {
        title: 'Example',
        querySelectorAll() {
          return [
            {
              innerText: '消息中心',
              textContent: '消息中心',
              getAttribute(name: string) {
                return name === 'aria-label' ? '通知' : null;
              },
              href: 'https://example.com/messages',
              className: 'nav-item',
            },
          ];
        },
      },
      configurable: true,
    });

    const arrowFunction = eval(scriptToFunctionExpression(`async () => {
  const texts = [...document.querySelectorAll('a,button,div,span')]
    .map((el, i) => ({
      i,
      text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      href: el.href,
      cls: el.className?.toString().slice(0, 80),
    }))
    .filter((x) => /消息|通知|私信|回复|@|动态/.test([x.text, x.aria, x.title, x.href].filter(Boolean).join(' ')));
  return { title: document.title, matches: texts.slice(0, 80) };
}`)) as () => Promise<{ title: string; matches: unknown[] }>;

    await expect(arrowFunction()).resolves.toMatchObject({
      title: 'Example',
      matches: [
        {
          i: 0,
          text: '消息中心',
          aria: '通知',
        },
      ],
    });

    const bodyFunction = eval(scriptToFunctionExpression('const value = input.value ?? 1; return { value };')) as (
      input: { value: number },
    ) => Promise<{ value: number }>;
    await expect(bodyFunction({ value: 7 })).resolves.toEqual({ value: 7 });
  });

  it('inserts a managed input barrier after generated managed input statements', () => {
    expect(
      scriptToFunctionExpression(`
export default function () {
  button.click();
  const option = document.querySelector('[role=option]');
  return { option: Boolean(option) };
}
      `),
    ).toContain(`button.click();\n  await cap.waitForManagedInput();\n  const option`);

    expect(
      scriptToFunctionExpression(`
const text = ".click();";
// ignored.click();
document.querySelector('button').click()
const option = document.querySelector('[role=option]');
return { option };
      `),
    ).toContain(`document.querySelector('button').click()\nawait cap.waitForManagedInput();\nconst option`);

    expect(
      scriptToFunctionExpression(`
button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const option = document.querySelector('[role=option]');
      `),
    ).toContain(
      `button.dispatchEvent(new MouseEvent('click', { bubbles: true }));\nawait cap.waitForManagedInput();\nconst option`,
    );

    expect(
      scriptToFunctionExpression(`
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
return { active: document.activeElement?.tagName };
      `),
    ).toContain(
      `input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));\nawait cap.waitForManagedInput();\nreturn`,
    );

    expect(
      scriptToFunctionExpression(`
document
  .querySelector('button')
  .click();
const option = document.querySelector('[role=option]');
      `),
    ).toContain(`.click();\nawait cap.waitForManagedInput();\nconst option`);
  });

  it('does not insert managed input barriers for click text in non-statement positions', () => {
    const transformed = scriptToFunctionExpression(`
const text = ".click();";
const callback = () => button.click();
return { text, callback };
    `);

    expect(transformed).toContain('const text = ".click();"');
    expect(transformed).toContain('const callback = () => button.click();');
    expect(transformed).not.toContain('await cap.waitForManagedInput();');
  });

  it('makes non-async click scripts awaitable after barrier insertion', () => {
    expect(scriptToFunctionExpression('export default function () { button.click(); }')).toMatch(
      /^\(async function/,
    );
    expect(scriptToFunctionExpression('() => { button.click(); }')).toMatch(/^\(async \(\) =>/);
    expect(
      scriptToFunctionExpression(`
const changeOne = (email) => {
  button.click();
  return document.querySelector('[role=option]');
};
return { changeOne };
      `),
    ).toContain('const changeOne = async (email) => {');
  });

  it('builds a debugger expression that preserves cap.call semantics', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://example.com/app' },
      configurable: true,
    });

    const nestedScript = scriptDefinitionSchema.parse({
      id: 'nested.echo',
      name: 'Nested Echo',
      version: '1.0.0',
      status: 'active',
      type: 'read',
      summary: 'Upper-case text.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          echoed: { type: 'string' },
        },
        required: ['echoed'],
        additionalProperties: false,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function (input) {
  return { echoed: String(input.text ?? '').toUpperCase() };
}
        `.trim(),
      },
    });

    const parentScript = scriptDefinitionSchema.parse({
      id: 'parent.echo',
      name: 'Parent Echo',
      version: '1.0.0',
      status: 'active',
      type: 'read',
      summary: 'Proxy echo.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          echoed: { type: 'string' },
        },
        required: ['echoed'],
        additionalProperties: false,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function (input) {
  return await cap.call('nested.echo', input);
}
        `.trim(),
      },
    });

    const expression = buildScriptExecutionExpression(
      parentScript,
      { text: 'hello' },
      [nestedScript],
    );

    expect(expression).toContain('function captureVisibleElementsDiff()');
    expect(expression).toContain('managed_click');
    expect(expression).not.toContain('__name');
    expect(expression).not.toContain('import_');

    const response = (await eval(expression)) as {
      ok: boolean;
      result?: Record<string, unknown>;
      evidence?: { url?: string; events: Array<{ type: string; value: unknown }> };
    };

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ echoed: 'HELLO' });
    expect(response.evidence?.url).toBe('https://example.com/app');
    expect(response.evidence?.events).toContainEqual({
      type: 'script_call',
      value: {
        scriptId: 'nested.echo',
        result: { echoed: 'HELLO' },
      },
    });
    expect(response.evidence?.events).not.toContainEqual({
      type: 'script_call',
      value: {
        scriptId: 'parent.echo',
        result: { echoed: 'HELLO' },
      },
    });
  });

  it('routes user script setTimeout through the managed timer bridge when provided', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const script = scriptDefinitionSchema.parse({
      id: 'sleep.test',
      name: 'Sleep Test',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Wait before returning.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
  return { ok: true };
}
        `.trim(),
      },
    });

    const scheduledPayloads: Record<string, unknown>[] = [];
    const releases = new Map<number, () => void>();
    (globalThis as typeof globalThis & { __testTimerBridge?: unknown }).__testTimerBridge =
      (payload: Record<string, unknown>) => {
        scheduledPayloads.push(payload);
        return new Promise<void>((resolve) => {
          releases.set(Number(payload.delayMs ?? 0), resolve);
        });
      };

    try {
      const expression = buildScriptExecutionExpression(script, {}, [], {
        managedTimerBridgeFunctionName: '__testTimerBridge',
      });

      const pendingResponse = eval(expression) as Promise<{
        ok: boolean;
        result?: Record<string, unknown>;
      }>;
      await Promise.resolve();

      expect(
        scheduledPayloads.some(
          (payload) => payload.action === 'schedule' && payload.delayMs === 250,
        ),
      ).toBe(true);

      releases.get(250)?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(
        scheduledPayloads.some(
          (payload) => payload.action === 'schedule' && payload.delayMs === 300,
        ),
      ).toBe(true);

      releases.get(300)?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(
        scheduledPayloads.some(
          (payload) => payload.action === 'schedule' && payload.delayMs === 350,
        ),
      ).toBe(true);

      releases.get(350)?.();
      const response = await pendingResponse;

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ ok: true });
      expect(globalThis.setTimeout).toBe(originalSetTimeout);
      expect(globalThis.clearTimeout).toBe(originalClearTimeout);
    } finally {
      delete (globalThis as typeof globalThis & { __testTimerBridge?: unknown }).__testTimerBridge;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('records page URL and clipboard side effects from inline scripts', async () => {
    const locationState = { href: 'https://example.com/start' };
    Object.defineProperty(globalThis, 'location', {
      value: locationState,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'history', {
      value: {
        pushState(_state: unknown, _unused: string, url?: string | URL | null) {
          if (url) {
            locationState.href = new URL(String(url), locationState.href).href;
          }
        },
        replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
          if (url) {
            locationState.href = new URL(String(url), locationState.href).href;
          }
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          async writeText(_text: string) {
            return undefined;
          },
        },
      },
      configurable: true,
    });

    const script = scriptDefinitionSchema.parse({
      id: 'side.effects',
      name: 'Side Effects',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Triggers page side effects.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  history.pushState({}, '', '/next');
  await navigator.clipboard.writeText('copied text');
  return { ok: true };
}
        `.trim(),
      },
    });

    const expression = buildScriptExecutionExpression(script, {}, []);
    const response = (await eval(expression)) as {
      ok: boolean;
      evidence?: { events: Array<{ type: string; value: unknown }> };
    };

    expect(response.ok).toBe(true);
    expect(response.evidence?.events).toContainEqual({
      type: 'page_url_changed',
      value: {
        from: 'https://example.com/start',
        to: 'https://example.com/next',
        mode: 'history',
        method: 'pushState',
      },
    });
    expect(response.evidence?.events).toContainEqual({
      type: 'clipboard_written',
      value: {
        method: 'writeText',
        textLength: 11,
      },
    });
  });
});
