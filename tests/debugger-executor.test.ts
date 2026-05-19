import { afterEach, describe, expect, it } from 'vitest';
import { DebuggerScriptExecutor } from '../extension/runtime/debugger-executor';
import {
  createDebuggerActionScript,
  successEvaluationResult,
  type DebuggerCommand,
  type DebuggerEventListener,
} from './debugger-executor-fixtures';

describe('DebuggerScriptExecutor', () => {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  const previousBrowser = (globalThis as typeof globalThis & { browser?: unknown }).browser;

  afterEach(() => {
    if (previousChrome === undefined) {
      delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    } else {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }

    if (previousBrowser === undefined) {
      delete (globalThis as typeof globalThis & { browser?: unknown }).browser;
    } else {
      (globalThis as typeof globalThis & { browser?: unknown }).browser = previousBrowser;
    }
  });

  it('dispatches CDP mouse events for managed clicks', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    let bindingName = '';
    let resolverStoreName = '';
    let bridgeEvalCount = 0;

    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('ClickBinding')) {
              bindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedClickResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              const resolverStoreMatch = expression.match(
                /const resolverStoreName = "([^"]+)";/,
              );
              resolverStoreName = resolverStoreMatch?.[1] ?? '';
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedClickBridgeFunctionName')) {
              bridgeEvalCount += 1;
              for (const listener of listeners) {
                listener(target, 'Runtime.bindingCalled', {
                  name: bindingName,
                  payload: JSON.stringify({
                    id: 'click-1',
                    clientX: 120,
                    clientY: 45,
                    debug: {
                      viewport: {
                        innerWidth: 300,
                        innerHeight: 200,
                      },
                    },
                  }),
                });
              }
              callback(successEvaluationResult({ clicked: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor();
    const script = createDebuggerActionScript({
      id: 'click.test',
      name: 'Click Test',
      summary: 'Trigger a click.',
      outputProperties: {
        clicked: { type: 'boolean' },
      },
      outputRequired: ['clicked'],
      code: `
export default async function () {
  document.querySelector('button').click();
  return { clicked: true };
}
      `,
    });

    const response = await executor.executeScript(7, script, {}, []);

    expect(response.result).toEqual({ clicked: true });
    expect(bridgeEvalCount).toBe(1);
    expect(bindingName).toContain('__webCapDebuggerClickBinding_');
    expect(resolverStoreName).toContain('__webCapManagedClickResolvers_');
    const mouseEvents = commands
      .filter(({ method }) => method === 'Input.dispatchMouseEvent')
      .map(({ params }) => ({
        type: params.type,
        x: params.x,
        y: params.y,
        buttons: params.buttons,
      }));
    expect(mouseEvents.length).toBeGreaterThan(3);
    expect(mouseEvents[0]).toEqual({
      type: 'mouseMoved',
      x: 143,
      y: 86,
      buttons: 0,
    });
    expect(mouseEvents.at(-3)).toEqual({
      type: 'mouseMoved',
      x: 120,
      y: 45,
      buttons: 0,
    });
    expect(mouseEvents.at(-2)).toEqual({
      type: 'mousePressed',
      x: 120,
      y: 45,
      buttons: 1,
    });
    expect(mouseEvents.at(-1)).toEqual({
      type: 'mouseReleased',
      x: 120,
      y: 45,
      buttons: 0,
    });
    expect(commands.some(({ method }) => method === 'Runtime.removeBinding')).toBe(true);
  });

  it('closes tabs through the managed window bridge', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    const closedTabs: number[] = [];
    let bindingName = '';

    (globalThis as typeof globalThis & { browser?: unknown }).browser = {
      tabs: {
        async remove(tabId: number) {
          closedTabs.push(tabId);
        },
      },
    };
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('WindowBinding')) {
              bindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedWindowResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedWindowBridgeFunctionName')) {
              for (const listener of listeners) {
                listener(target, 'Runtime.bindingCalled', {
                  name: bindingName,
                  payload: JSON.stringify({
                    id: 'close-1',
                    action: 'close',
                    debug: { url: 'https://example.com/temporary' },
                  }),
                });
              }
              callback(successEvaluationResult({ requestedClose: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor();
    const script = createDebuggerActionScript({
      id: 'window.close.test',
      name: 'Window Close Test',
      summary: 'Trigger a window close.',
      outputProperties: {
        requestedClose: { type: 'boolean' },
      },
      outputRequired: ['requestedClose'],
      code: `
export default async function () {
  window.close();
  return { requestedClose: true };
}
      `,
    });

    const response = await executor.executeScript(7, script, {}, []);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(response.result).toEqual({ requestedClose: true });
    expect(bindingName).toContain('__webCapDebuggerWindowBinding_');
    expect(closedTabs).toEqual([7]);
    expect(commands.some(({ method }) => method === 'Runtime.removeBinding')).toBe(true);
  });

  it('dispatches CDP mouse move, press, and release for synthetic MouseEvent dispatches', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    let bindingName = '';

    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('ClickBinding')) {
              bindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedClickResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedClickBridgeFunctionName')) {
              for (const payload of [
                { id: 'move-1', action: 'move', clientX: 40, clientY: 50 },
                { id: 'down-1', action: 'down', clientX: 40, clientY: 50 },
                { id: 'up-1', action: 'up', clientX: 40, clientY: 50 },
              ]) {
                for (const listener of listeners) {
                  listener(target, 'Runtime.bindingCalled', {
                    name: bindingName,
                    payload: JSON.stringify(payload),
                  });
                }
              }
              callback(successEvaluationResult({ moved: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor();
    const script = createDebuggerActionScript({
      id: 'mouse.synthetic.test',
      name: 'Synthetic Mouse Test',
      summary: 'Trigger synthetic mouse input.',
      outputProperties: {
        moved: { type: 'boolean' },
      },
      outputRequired: ['moved'],
      code: `
export default async function () {
  const target = document.querySelector('button');
  target.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50, bubbles: true }));
  target.dispatchEvent(new MouseEvent('mousedown', { clientX: 40, clientY: 50, bubbles: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { clientX: 40, clientY: 50, bubbles: true }));
  return { moved: true };
}
      `,
    });

    const response = await executor.executeScript(7, script, {}, []);

    expect(response.result).toEqual({ moved: true });
    const mouseEvents = commands
      .filter(({ method }) => method === 'Input.dispatchMouseEvent')
      .map(({ params }) => ({
        type: params.type,
        x: params.x,
        y: params.y,
        buttons: params.buttons,
      }));
    expect(mouseEvents.at(-3)).toEqual({
      type: 'mouseMoved',
      x: 40,
      y: 50,
      buttons: 0,
    });
    expect(mouseEvents.at(-2)).toEqual({
      type: 'mousePressed',
      x: 40,
      y: 50,
      buttons: 1,
    });
    expect(mouseEvents.at(-1)).toEqual({
      type: 'mouseReleased',
      x: 40,
      y: 50,
      buttons: 0,
    });
  });

  it('moves from the last pointer position on subsequent clicks in the same tab', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    let bindingName = '';
    let clickIndex = 0;

    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('ClickBinding')) {
              bindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedClickResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedClickBridgeFunctionName')) {
              clickIndex += 1;
              const payload =
                clickIndex === 1
                  ? {
                      id: 'click-1',
                      clientX: 120,
                      clientY: 45,
                      debug: {
                        viewport: {
                          innerWidth: 300,
                          innerHeight: 200,
                        },
                      },
                    }
                  : {
                      id: 'click-2',
                      clientX: 220,
                      clientY: 145,
                      debug: {
                        viewport: {
                          innerWidth: 300,
                          innerHeight: 200,
                        },
                      },
                    };
              for (const listener of listeners) {
                listener(target, 'Runtime.bindingCalled', {
                  name: bindingName,
                  payload: JSON.stringify(payload),
                });
              }
              callback(successEvaluationResult({ clicked: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor(60_000);
    const script = createDebuggerActionScript({
      id: 'click.test',
      name: 'Click Test',
      summary: 'Trigger a click.',
      outputProperties: {
        clicked: { type: 'boolean' },
      },
      outputRequired: ['clicked'],
      code: `
export default async function () {
  document.querySelector('button').click();
  return { clicked: true };
}
      `,
    });

    await executor.executeScript(7, script, {}, []);
    await executor.executeScript(7, script, {}, []);

    const mouseEvents = commands
      .filter(({ method }) => method === 'Input.dispatchMouseEvent')
      .map(({ params }) => ({
        type: params.type,
        x: params.x,
        y: params.y,
      }));
    const pressedIndices = mouseEvents.reduce<number[]>((indices, event, index) => {
      if (event.type === 'mousePressed') {
        indices.push(index);
      }
      return indices;
    }, []);

    expect(pressedIndices).toHaveLength(2);
    const secondClickStart = pressedIndices[0] + 2;
    expect(mouseEvents[secondClickStart]).toEqual({
      type: 'mouseMoved',
      x: 137,
      y: 62,
    });
    expect(mouseEvents[secondClickStart + 5]).toEqual({
      type: 'mouseMoved',
      x: 220,
      y: 145,
    });
  });

  it('dispatches CDP key events for managed keyboard input', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    let keyboardBindingName = '';

    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('KeyboardBinding')) {
              keyboardBindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedKeyboardResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedKeyboardBridgeFunctionName')) {
              const payloads = [
                {
                  id: 'key-1',
                  action: 'dispatchEvent',
                  eventType: 'rawKeyDown',
                  key: 'n',
                  code: 'KeyN',
                  keyCode: 78,
                  which: 78,
                },
                {
                  id: 'key-2',
                  action: 'dispatchEvent',
                  eventType: 'char',
                  key: 'n',
                  code: 'KeyN',
                  keyCode: 78,
                  which: 78,
                },
                {
                  id: 'key-3',
                  action: 'dispatchEvent',
                  eventType: 'keyUp',
                  key: 'n',
                  code: 'KeyN',
                  keyCode: 78,
                  which: 78,
                },
              ];
              for (const payload of payloads) {
                for (const listener of listeners) {
                  listener(target, 'Runtime.bindingCalled', {
                    name: keyboardBindingName,
                    payload: JSON.stringify(payload),
                  });
                }
              }
              callback(successEvaluationResult({ typed: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor();
    const script = createDebuggerActionScript({
      id: 'keyboard.test',
      name: 'Keyboard Test',
      summary: 'Trigger keyboard input.',
      outputProperties: {
        typed: { type: 'boolean' },
      },
      outputRequired: ['typed'],
      code: `
export default async function () {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keypress', { key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'n', code: 'KeyN', keyCode: 78, which: 78, bubbles: true }));
  return { typed: true };
}
      `,
    });

    const response = await executor.executeScript(7, script, {}, []);

    expect(response.result).toEqual({ typed: true });
    const keyEvents = commands
      .filter(({ method }) => method === 'Input.dispatchKeyEvent')
      .map(({ params }) => ({
        type: params.type,
        key: params.key,
        code: params.code,
        keyCode: params.windowsVirtualKeyCode,
        text: params.text,
      }));
    expect(keyEvents).toEqual([
      {
        type: 'rawKeyDown',
        key: 'n',
        code: 'KeyN',
        keyCode: 78,
        text: undefined,
      },
      {
        type: 'char',
        key: 'n',
        code: 'KeyN',
        keyCode: 78,
        text: 'n',
      },
      {
        type: 'keyUp',
        key: 'n',
        code: 'KeyN',
        keyCode: 78,
        text: undefined,
      },
    ]);
  });

  it('dispatches CDP insertText for managed fill input', async () => {
    const commands: DebuggerCommand[] = [];
    const listeners = new Set<DebuggerEventListener>();
    let keyboardBindingName = '';

    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      debugger: {
        attach: (_target: { tabId: number }, _version: string, callback: () => void) => callback(),
        detach: (_target: { tabId: number }, callback: () => void) => callback(),
        sendCommand: (
          target: { tabId: number },
          method: string,
          params: Record<string, unknown>,
          callback: (result?: unknown) => void,
        ) => {
          commands.push({ method, params });

          if (method === 'Runtime.addBinding') {
            const name = String(params.name);
            if (name.includes('KeyboardBinding')) {
              keyboardBindingName = name;
            }
            callback({});
            return;
          }

          if (method === 'Runtime.evaluate') {
            const expression = String(params.expression ?? '');
            if (
              expression.includes('__webCapManagedKeyboardResolvers_') &&
              expression.includes('globalThis[bridgeFunctionName] = (payload) =>')
            ) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('entry.resolve();')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('active.setSelectionRange(0, length);')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('delete globalThis[bridgeFunctionName];')) {
              callback({ result: { type: 'undefined' } });
              return;
            }

            if (expression.includes('managedKeyboardBridgeFunctionName')) {
              for (const listener of listeners) {
                listener(target, 'Runtime.bindingCalled', {
                  name: keyboardBindingName,
                  payload: JSON.stringify({
                    id: 'fill-1',
                    action: 'insertText',
                    text: 'hello@example.com',
                    replaceExistingText: true,
                  }),
                });
              }
              callback(successEvaluationResult({ typed: true }));
              return;
            }
          }

          callback({});
        },
        onEvent: {
          addListener: (listener: DebuggerEventListener) => {
            listeners.add(listener);
          },
          removeListener: (listener: DebuggerEventListener) => {
            listeners.delete(listener);
          },
        },
      },
      runtime: {
        lastError: undefined,
      },
    };

    const executor = new DebuggerScriptExecutor();
    const script = createDebuggerActionScript({
      id: 'fill.test',
      name: 'Fill Test',
      summary: 'Trigger fill input.',
      outputProperties: {
        typed: { type: 'boolean' },
      },
      outputRequired: ['typed'],
      code: `
export default async function () {
  return { typed: true };
}
      `,
    });

    await executor.executeScript(7, script, {}, []);

    expect(
      commands.some(
        ({ method, params }) =>
          method === 'Runtime.evaluate' &&
          String(params.expression ?? '').includes('active.setSelectionRange(0, length);'),
      ),
    ).toBe(true);
    expect(commands.some(({ method, params }) => method === 'Input.insertText' && params.text === 'hello@example.com')).toBe(true);
  });
});
