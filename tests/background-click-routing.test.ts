import { describe, expect, it } from 'vitest';
import {
  scriptRequiresBrowserLevelClick,
  scriptRequiresBrowserLevelKeyboard,
  scriptRequiresBrowserLevelWindow,
} from '../extension/runtime/click-routing';
import { scriptDefinitionSchema } from '@shared/script-schema';

describe('background click routing', () => {
  it('routes direct click scripts to debugger', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'click.direct',
      name: 'Direct Click',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Clicks directly.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  document.querySelector('button')?.click();
  return { ok: true };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelClick(script, [])).toBe(true);
  });

  it('routes nested builtin click calls to debugger', () => {
    const nested = scriptDefinitionSchema.parse({
      id: 'builtin.page.click',
      name: 'Builtin Click',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Builtin click.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['builtin'],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: 'export default async function () { return { clicked: true }; }',
      },
    });

    const parent = scriptDefinitionSchema.parse({
      id: 'parent.click',
      name: 'Parent Click',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Calls builtin click.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  return await cap.call('builtin.page.click', { selector: '#submit' });
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelClick(parent, [nested])).toBe(true);
  });

  it('routes synthetic mouse dispatch scripts to debugger', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'click.synthetic-mouse',
      name: 'Synthetic Mouse Click',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Dispatches mouse events directly.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  const target = document.querySelector('button');
  const r = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  return { ok: true };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelClick(script, [])).toBe(true);
  });

  it('keeps non-click scripts on the user-script path', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'read.only',
      name: 'Read Only',
      version: '1.0.0',
      status: 'active',
      type: 'read',
      summary: 'Reads title only.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  return { title: document.title };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelClick(script, [])).toBe(false);
  });

  it('routes window close scripts to debugger', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'window.close',
      name: 'Window Close',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Closes the current tab.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  window.close();
  return { requestedClose: true };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelWindow(script, [])).toBe(true);
  });

  it('routes synthetic keyboard dispatch scripts to debugger', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'keyboard.direct',
      name: 'Direct Keyboard',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Dispatches keyboard events directly.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
  return { ok: true };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelKeyboard(script, [])).toBe(true);
  });

  it('routes document-level keyboard shortcuts to debugger', () => {
    const script = scriptDefinitionSchema.parse({
      id: 'keyboard.global',
      name: 'Global Keyboard Shortcut',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Dispatches a document-level keyboard shortcut.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX', bubbles: true }));
  return { ok: true };
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelKeyboard(script, [])).toBe(true);
  });

  it('routes nested builtin fill_input calls to debugger', () => {
    const nested = scriptDefinitionSchema.parse({
      id: 'builtin.page.fill_input',
      name: 'Builtin Fill Input',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Builtin fill input.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['builtin'],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: 'export default async function () { return { filled: true }; }',
      },
    });

    const parent = scriptDefinitionSchema.parse({
      id: 'parent.fill',
      name: 'Parent Fill',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Calls builtin fill_input.',
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
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 1_000,
        code: `
export default async function () {
  return await cap.call('builtin.page.fill_input', { selector: '#email', value: 'hi' });
}
        `.trim(),
      },
    });

    expect(scriptRequiresBrowserLevelKeyboard(parent, [nested])).toBe(true);
  });
});
