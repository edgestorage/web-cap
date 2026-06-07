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

  it('annotates execution responses with notes without adding executor noise', () => {
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
    expect(scriptRuntimeSource).toContain('managed_mouse');
    expect(scriptRuntimeSource).toContain('function installManagedClickHook(');
    expect(scriptRuntimeSource).toContain('async waitForManagedInput()');
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

    const commentedExportDefault = eval(
      scriptToFunctionExpression(`
// Leading comments should not hide export default.
/* Block comments should not hide it either. */
export default function () {
  return { ok: true };
}
      `),
    ) as () => Promise<{ ok: boolean }>;
    await expect(commentedExportDefault()).resolves.toEqual({ ok: true });

    const commentedExportDefaultArrow = eval(
      scriptToFunctionExpression(`
// Leading comments should also work for export assignments.
export default () => ({ ok: true });
      `),
    ) as () => Promise<{ ok: boolean }>;
    await expect(commentedExportDefaultArrow()).resolves.toEqual({ ok: true });

    const parenthesizedExportDefaultArrow = eval(
      scriptToFunctionExpression(`
// Parenthesized arrows should still become executable script functions.
export default (() => ({ ok: true }));
      `),
    ) as () => Promise<{ ok: boolean }>;
    await expect(parenthesizedExportDefaultArrow()).resolves.toEqual({ ok: true });

    const defaultFunctionWithHelper = eval(
      scriptToFunctionExpression(`
export default async function (input) {
  return buildResult(input.value);
}

function buildResult(value) {
  return { ok: true, value };
}
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultFunctionWithHelper({ value: 'helper' })).resolves.toEqual({
      ok: true,
      value: 'helper',
    });

    const defaultArrowWithHelper = eval(
      scriptToFunctionExpression(`
export default (input) => buildResult(input.value);

const buildResult = (value) => ({ ok: true, value });
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultArrowWithHelper({ value: 'arrow-helper' })).resolves.toEqual({
      ok: true,
      value: 'arrow-helper',
    });

    const defaultFunctionWithLeadingConst = eval(
      scriptToFunctionExpression(`
const prefix = 'leading';

export default function (input) {
  return { ok: true, value: prefix + ':' + input.value };
}
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultFunctionWithLeadingConst({ value: 'const' })).resolves.toEqual({
      ok: true,
      value: 'leading:const',
    });

    const defaultArrowWithLeadingConst = eval(
      scriptToFunctionExpression(`
const buildResult = (value) => ({ ok: true, value });

export default (input) => buildResult(input.value);
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultArrowWithLeadingConst({ value: 'leading-arrow' })).resolves.toEqual({
      ok: true,
      value: 'leading-arrow',
    });

    const defaultIdentifierWithLeadingConst = eval(
      scriptToFunctionExpression(`
const exportedScript = async (input) => ({ ok: true, value: input.value });

export default exportedScript;
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultIdentifierWithLeadingConst({ value: 'identifier' })).resolves.toEqual({
      ok: true,
      value: 'identifier',
    });

    const defaultArrowWithExportedConstHelper = eval(
      scriptToFunctionExpression(`
export const prefix = 'named-export';

export default (input) => ({ ok: true, value: prefix + ':' + input.value });
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultArrowWithExportedConstHelper({ value: 'const-helper' })).resolves.toEqual({
      ok: true,
      value: 'named-export:const-helper',
    });

    const defaultArrowWithExportedFunctionHelper = eval(
      scriptToFunctionExpression(`
export function buildResult(value) {
  return { ok: true, value };
}

export default (input) => buildResult(input.value);
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultArrowWithExportedFunctionHelper({ value: 'function-helper' })).resolves.toEqual({
      ok: true,
      value: 'function-helper',
    });

    const defaultArrowWithExportList = eval(
      scriptToFunctionExpression(`
const buildResult = (value) => ({ ok: true, value });
export { buildResult };

export default (input) => buildResult(input.value);
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultArrowWithExportList({ value: 'export-list' })).resolves.toEqual({
      ok: true,
      value: 'export-list',
    });

    const defaultExportListAlias = eval(
      scriptToFunctionExpression(`
const exportedScript = async (input) => ({ ok: true, value: input.value });

export { exportedScript as default };
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultExportListAlias({ value: 'default-alias' })).resolves.toEqual({
      ok: true,
      value: 'default-alias',
    });

    const defaultExportWithInternalNameCollision = eval(
      scriptToFunctionExpression(`
const __webCapDefaultExport = 'user-value';

export default (input) => ({ ok: true, value: __webCapDefaultExport + ':' + input.value });
      `),
    ) as (input: { value: string }) => Promise<{ ok: boolean; value: string }>;
    await expect(defaultExportWithInternalNameCollision({ value: 'collision' })).resolves.toEqual({
      ok: true,
      value: 'user-value:collision',
    });

    expect(
      scriptToFunctionExpression(`
export { helper } from './helper.js';
export default function () {
  return { ok: true };
}
      `),
    ).toContain(`export { helper } from './helper.js';`);
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
    const transformedDefaultFunction = scriptToFunctionExpression(
      'export default function () { button.click(); }',
    );
    expect(transformedDefaultFunction).toContain('async function');
    expect(transformedDefaultFunction).toContain('await cap.waitForManagedInput();');
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
      { evidence: ['all'] },
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

  it('lets cap.goto return an internal continuation before output validation', async () => {
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://example.com/start' },
      configurable: true,
    });

    const script = scriptDefinitionSchema.parse({
      id: 'workflow.goto',
      name: 'Workflow Goto',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Continues after navigation.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: true,
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
export default async function (input) {
  return cap.goto('/next', { step: 'next', query: input.query });
}
        `.trim(),
      },
    });

    const expression = buildScriptExecutionExpression(
      script,
      { query: 'web-cap' },
      [],
      { evidence: ['events'] },
    );

    const response = (await eval(expression)) as {
      ok: boolean;
      result?: Record<string, unknown>;
    };

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      __webCapType: 'web_cap.goto',
      url: '/next',
      input: {
        step: 'next',
        query: 'web-cap',
      },
    });
  });

  it('records Playwright mouse actions as managed action evidence', async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridgeName = '__webCapTestBrowserBridge';
    (globalThis as typeof globalThis & Record<string, unknown>)[bridgeName] = (
      payload: Record<string, unknown>,
    ) => {
      if (payload.action === 'command') {
        commands.push({
          method: String(payload.method),
          params: payload.params as Record<string, unknown>,
        });
      }
      return {};
    };

    try {
      const script = scriptDefinitionSchema.parse({
        id: 'mouse.click',
        name: 'Mouse Click',
        version: '1.0.0',
        status: 'active',
        type: 'act',
        summary: 'Clicks through the Playwright mouse shim.',
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
  await page.mouse.click(12, 34);
  return { ok: true };
}
          `.trim(),
        },
      });

      const expression = buildScriptExecutionExpression(script, {}, [], {
        managedBrowserBridgeFunctionName: bridgeName,
        evidence: ['events'],
      });
      const response = (await eval(expression)) as {
        ok: boolean;
        evidence?: { events: Array<{ type: string; value: Record<string, unknown> }> };
      };

      expect(response.ok).toBe(true);
      expect(commands.map((command) => command.method)).toEqual([
        'Input.dispatchMouseEvent',
        'Input.dispatchMouseEvent',
        'Input.dispatchMouseEvent',
      ]);
      expect(response.evidence?.events).toContainEqual({
        type: 'managed_mouse',
        value: {
          action: 'up',
          x: 12,
          y: 34,
          buttons: 0,
          button: 'left',
        },
      });

      const commonExpression = buildScriptExecutionExpression(script, {}, [], {
        managedBrowserBridgeFunctionName: bridgeName,
        evidence: ['common'],
      });
      const commonResponse = (await eval(commonExpression)) as {
        ok: boolean;
        evidence?: { events: Array<{ type: string; value: Record<string, unknown> }> };
      };
      expect(commonResponse.ok).toBe(true);
      expect(commonResponse.evidence?.events).not.toContainEqual(
        expect.objectContaining({ type: 'managed_mouse' }),
      );
    } finally {
      delete (globalThis as typeof globalThis & Record<string, unknown>)[bridgeName];
    }
  });

  it('exposes Playwright keyboard actions on the page shim', async () => {
    class FakeHTMLElement {
      textContent = '';
      isContentEditable = true;
      events: string[] = [];

      scrollIntoView() {}

      focus() {
        fakeDocument.activeElement = this;
      }

      dispatchEvent(event: { type: string }) {
        this.events.push(event.type);
        return true;
      }
    }

    class FakeInputElement extends FakeHTMLElement {
      value = '';
      isContentEditable = false;
    }

    class FakeKeyboardEvent {
      type: string;

      constructor(type: string) {
        this.type = type;
      }
    }

    class FakeInputEvent {
      type: string;

      constructor(type: string) {
        this.type = type;
      }
    }

    const target = new FakeHTMLElement();
    const fakeDocument = {
      activeElement: target,
      body: target,
      documentElement: target,
      querySelectorAll() {
        return [];
      },
    };
    const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
    const previousHTMLInputElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement');
    const previousHTMLTextAreaElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLTextAreaElement');
    const previousKeyboardEvent = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent');
    const previousInputEvent = Object.getOwnPropertyDescriptor(globalThis, 'InputEvent');

    Object.defineProperty(globalThis, 'document', {
      value: fakeDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'HTMLElement', {
      value: FakeHTMLElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'HTMLInputElement', {
      value: FakeInputElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'HTMLTextAreaElement', {
      value: FakeInputElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'KeyboardEvent', {
      value: FakeKeyboardEvent,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'InputEvent', {
      value: FakeInputEvent,
      configurable: true,
    });

    try {
      const script = scriptDefinitionSchema.parse({
        id: 'keyboard.type',
        name: 'Keyboard Type',
        version: '1.0.0',
        status: 'active',
        type: 'act',
        summary: 'Types through the Playwright keyboard shim.',
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
            text: { type: 'string' },
            eventCount: { type: 'number' },
          },
          required: ['ok', 'text', 'eventCount'],
          additionalProperties: false,
        },
        script: {
          timeoutMs: 1_000,
          code: `
export default async function () {
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  return { ok: true, text: document.activeElement.textContent, eventCount: document.activeElement.events.length };
}
          `.trim(),
        },
      });

      const expression = buildScriptExecutionExpression(script, {}, [], { evidence: ['events'] });
      const response = (await eval(expression)) as {
        ok: boolean;
        result?: Record<string, unknown>;
      };

      expect(response.ok).toBe(true);
      expect(response.result).toEqual({ ok: true, text: 'hi', eventCount: 11 });
    } finally {
      if (previousHTMLElement) {
        Object.defineProperty(globalThis, 'HTMLElement', previousHTMLElement);
      } else {
        delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
      }
      if (previousHTMLInputElement) {
        Object.defineProperty(globalThis, 'HTMLInputElement', previousHTMLInputElement);
      } else {
        delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
      }
      if (previousHTMLTextAreaElement) {
        Object.defineProperty(globalThis, 'HTMLTextAreaElement', previousHTMLTextAreaElement);
      } else {
        delete (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement;
      }
      if (previousKeyboardEvent) {
        Object.defineProperty(globalThis, 'KeyboardEvent', previousKeyboardEvent);
      } else {
        delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
      }
      if (previousInputEvent) {
        Object.defineProperty(globalThis, 'InputEvent', previousInputEvent);
      } else {
        delete (globalThis as { InputEvent?: unknown }).InputEvent;
      }
    }
  });

  it('waits for a Playwright-style page function', async () => {
    const script = scriptDefinitionSchema.parse({
      id: 'page.waitForFunction',
      name: 'Page Wait For Function',
      version: '1.0.0',
      status: 'active',
      type: 'read',
      summary: 'Waits for a page function.',
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
          functionValue: { type: 'string' },
          stringValue: { type: 'string' },
          timeoutMessage: { type: 'string' },
        },
        required: ['ok', 'functionValue', 'stringValue', 'timeoutMessage'],
        additionalProperties: false,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  globalThis.__webCapWaitFunctionValue = 'pending';
  globalThis.__webCapWaitStringValue = 'pending';
  setTimeout(() => { globalThis.__webCapWaitFunctionValue = 'ready'; }, 10);
  setTimeout(() => { globalThis.__webCapWaitStringValue = 'ready'; }, 10);

  await page.waitForFunction(
    (expected) => globalThis.__webCapWaitFunctionValue === expected,
    'ready',
    { timeout: 200, polling: 5 },
  );
  const stringValue = await page.waitForFunction(
    'globalThis.__webCapWaitStringValue === "ready" ? globalThis.__webCapWaitStringValue : false',
    undefined,
    { timeout: 200, polling: 'raf' },
  );

  let timeoutMessage = '';
  try {
    await page.waitForFunction(() => false, undefined, { timeout: 20, polling: 5 });
  } catch (error) {
    timeoutMessage = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: true,
    functionValue: globalThis.__webCapWaitFunctionValue,
    stringValue,
    timeoutMessage,
  };
}
        `.trim(),
      },
    });

    const expression = buildScriptExecutionExpression(script, {}, [], { evidence: ['events'] });
    const response = (await eval(expression)) as {
      ok: boolean;
      result?: Record<string, unknown>;
    };

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      ok: true,
      functionValue: 'ready',
      stringValue: 'ready',
      timeoutMessage: 'Timed out after 20ms waiting for page.waitForFunction.',
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

    const expression = buildScriptExecutionExpression(script, {}, [], {
      evidence: ['events'],
    });
    const response = (await eval(expression)) as {
      ok: boolean;
      evidence?: { events: Array<{ type: string; value: unknown }> };
    };

    expect(response.ok).toBe(true);
    expect(response.evidence?.events).toContainEqual({
      type: 'page_changed',
      value: {
        from: {
          url: 'https://example.com/start',
        },
        to: {
          url: 'https://example.com/next',
        },
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
