/* eslint-disable */
import type { PlaywrightShimDeps, RuntimeMethodTable, ScriptPlaywrightPage } from './playwright-shim-types.injected';
import { createLocator } from './playwright-locator.injected';
import { cssEscape, hideHighlightOverlay, notImplemented, pressKeyOnElement, queryLocatorSelectorAll, timeoutFromOptions, waitForLocator } from './playwright-shim-helpers.injected';

export function createPlaywrightPageApi(deps: PlaywrightShimDeps): ScriptPlaywrightPage {
let defaultTimeoutMs = 5000;
async function browserCommand<T = RuntimeMethodTable>(method: string, params: Record<string, unknown> = {}) {
  if (!deps.browserCommand) {
    throw new Error(`page.${method} requires the debugger CDP bridge.`);
  }
  return await deps.browserCommand(method, params) as T;
}

async function browserEvent<T = RuntimeMethodTable>(method: string, params: Record<string, unknown> = {}, timeoutMs = defaultTimeoutMs) {
  if (!deps.browserEvent) {
    throw new Error(`page.${method} requires the debugger CDP bridge.`);
  }
  return await deps.browserEvent(method, params, timeoutMs) as T;
}

function serializeUrlMatcher(matcher: unknown) {
  if (typeof matcher === 'string') {
    return { url: matcher };
  }
  if (matcher instanceof RegExp) {
    return { regexSource: matcher.source, regexFlags: matcher.flags };
  }
  return {};
}

function frameDocument(frameElement: HTMLIFrameElement | null) {
  return frameElement ? frameElement.contentDocument : document;
}

type FrameMetadata = {
  id?: string;
  parentId?: string;
  name?: string;
  url?: string;
};

const PLAYWRIGHT_PAGE_METHODS = [
  '$',
  '$$',
  'waitForSelector',
  'exposeBinding',
  'removeAllListeners',
  'on',
  'once',
  'addListener',
  'removeListener',
  'off',
  'prependListener',
  'addLocatorHandler',
  'addScriptTag',
  'addStyleTag',
  'ariaSnapshot',
  'bringToFront',
  'cancelPickLocator',
  'check',
  'clearConsoleMessages',
  'clearPageErrors',
  'click',
  'close',
  'consoleMessages',
  'content',
  'context',
  'dblclick',
  'dispatchEvent',
  'dragAndDrop',
  'emulateMedia',
  'exposeFunction',
  'fill',
  'focus',
  'frame',
  'frameLocator',
  'frames',
  'getAttribute',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'goBack',
  'goForward',
  'goto',
  'hideHighlight',
  'hover',
  'innerHTML',
  'innerText',
  'inputValue',
  'isChecked',
  'isClosed',
  'isDisabled',
  'isEditable',
  'isEnabled',
  'isHidden',
  'isVisible',
  'locator',
  'mainFrame',
  'opener',
  'pageErrors',
  'pause',
  'pdf',
  'pickLocator',
  'press',
  'reload',
  'removeLocatorHandler',
  'requestGC',
  'requests',
  'route',
  'routeFromHAR',
  'routeWebSocket',
  'screenshot',
  'selectOption',
  'setChecked',
  'setContent',
  'setDefaultNavigationTimeout',
  'setDefaultTimeout',
  'setExtraHTTPHeaders',
  'setInputFiles',
  'setViewportSize',
  'tap',
  'textContent',
  'title',
  'type',
  'uncheck',
  'unroute',
  'unrouteAll',
  'url',
  'video',
  'viewportSize',
  'waitForEvent',
  'waitForLoadState',
  'waitForNavigation',
  'waitForRequest',
  'waitForResponse',
  'waitForTimeout',
  'waitForURL',
  'workers',
];

function createPageApi(): ScriptPlaywrightPage {
  const pageApi: ScriptPlaywrightPage = {};
  const mouseState = {
    x: 0,
    y: 0,
    buttons: 0,
  };
  const mouseButtonName = (button: unknown) => {
    const value = String(button ?? 'left');
    return value === 'right' || value === 'middle' || value === 'back' || value === 'forward'
      ? value
      : 'left';
  };
  const mouseButtonsMask = (button: string) =>
    button === 'right' ? 2 : button === 'middle' ? 4 : button === 'back' ? 8 : button === 'forward' ? 16 : 1;
  const recordMouseAction = (action: string, value: Record<string, unknown> = {}) => {
    deps.recordEvidenceEvent?.('managed_mouse', {
      action,
      x: mouseState.x,
      y: mouseState.y,
      buttons: mouseState.buttons,
      ...value,
    });
  };
  const dispatchMouseEvent = async (
    type: string,
    x: number,
    y: number,
    options: { button?: unknown; buttons?: number; clickCount?: unknown; deltaX?: unknown; deltaY?: unknown } = {},
  ) => {
    const button = mouseButtonName(options.button);
    await browserCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: options.buttons ?? mouseState.buttons,
      clickCount: Math.max(Math.trunc(Number(options.clickCount ?? 1)), 1),
      deltaX: Number(options.deltaX ?? 0),
      deltaY: Number(options.deltaY ?? 0),
      pointerType: 'mouse',
    });
  };
  const mouseApi: RuntimeMethodTable = {
    async move(x: unknown, y: unknown, options: { steps?: unknown } = {}) {
      const targetX = Number(x);
      const targetY = Number(y);
      if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
        throw new Error('page.mouse.move requires finite x and y coordinates.');
      }
      const steps = Math.max(Math.trunc(Number(options.steps ?? 1)), 1);
      const startX = mouseState.x;
      const startY = mouseState.y;
      for (let index = 1; index <= steps; index += 1) {
        const nextX = startX + ((targetX - startX) * index) / steps;
        const nextY = startY + ((targetY - startY) * index) / steps;
        await dispatchMouseEvent('mouseMoved', nextX, nextY, { buttons: mouseState.buttons });
      }
      mouseState.x = targetX;
      mouseState.y = targetY;
      recordMouseAction('move', {
        from: { x: startX, y: startY },
        to: { x: targetX, y: targetY },
        steps,
      });
    },
    async down(options: { button?: unknown; clickCount?: unknown } = {}) {
      const button = mouseButtonName(options.button);
      mouseState.buttons |= mouseButtonsMask(button);
      await dispatchMouseEvent('mousePressed', mouseState.x, mouseState.y, {
        button,
        buttons: mouseState.buttons,
        clickCount: options.clickCount,
      });
      recordMouseAction('down', { button });
    },
    async up(options: { button?: unknown; clickCount?: unknown } = {}) {
      const button = mouseButtonName(options.button);
      const nextButtons = mouseState.buttons & ~mouseButtonsMask(button);
      await dispatchMouseEvent('mouseReleased', mouseState.x, mouseState.y, {
        button,
        buttons: nextButtons,
        clickCount: options.clickCount,
      });
      mouseState.buttons = nextButtons;
      recordMouseAction('up', { button });
    },
    async click(x: unknown, y: unknown, options: { button?: unknown; clickCount?: unknown; delay?: unknown } = {}) {
      await mouseApi.move(x, y);
      await mouseApi.down(options);
      const delay = Math.max(Number(options.delay ?? 0), 0);
      if (delay > 0) {
        await deps.wait(delay);
      }
      await mouseApi.up(options);
    },
    async dblclick(x: unknown, y: unknown, options: { button?: unknown; delay?: unknown } = {}) {
      await mouseApi.click(x, y, { ...options, clickCount: 1 });
      await mouseApi.click(x, y, { ...options, clickCount: 2 });
    },
    async wheel(deltaX: unknown, deltaY: unknown) {
      await dispatchMouseEvent('mouseWheel', mouseState.x, mouseState.y, {
        buttons: mouseState.buttons,
        deltaX,
        deltaY,
      });
      recordMouseAction('wheel', {
        deltaX: Number(deltaX ?? 0),
        deltaY: Number(deltaY ?? 0),
      });
    },
  };
  const activeKeyboardTarget = () => {
    const element = document.activeElement;
    if (element instanceof HTMLElement) {
      return element;
    }
    if (document.body instanceof HTMLElement) {
      return document.body;
    }
    throw new Error('page.keyboard requires an active HTMLElement target.');
  };
  const keyboardDelay = async (options: { delay?: unknown } = {}) => {
    const delay = Math.max(Number(options.delay ?? 0), 0);
    if (delay > 0) {
      await deps.wait(delay);
    }
  };
  const dispatchKeyboardOnly = async (type: string, key: unknown) => {
    const target = activeKeyboardTarget();
    target.dispatchEvent(new KeyboardEvent(type, {
      key: String(key ?? ''),
      bubbles: true,
      cancelable: true,
    }));
    await deps.waitForManagedInput();
  };
  const keyboardApi: RuntimeMethodTable = {
    async down(key: unknown) {
      await dispatchKeyboardOnly('keydown', key);
    },
    async up(key: unknown) {
      await dispatchKeyboardOnly('keyup', key);
    },
    async press(key: unknown, options: { delay?: unknown } = {}) {
      await pressKeyOnElement(activeKeyboardTarget(), key, deps);
      await keyboardDelay(options);
    },
    async type(text: unknown, options: { delay?: unknown } = {}) {
      const value = String(text ?? '');
      for (const char of value) {
        await pressKeyOnElement(activeKeyboardTarget(), char, deps);
        await keyboardDelay(options);
      }
    },
    async insertText(text: unknown, options: { delay?: unknown } = {}) {
      await keyboardApi.type(text, options);
    },
  };
  const sameOriginFrameElements = () =>
    [...document.querySelectorAll('iframe')]
      .filter((element): element is HTMLIFrameElement => element instanceof HTMLIFrameElement)
      .filter((element) => Boolean(element.contentDocument));
  const findSameOriginFrameElement = (metadata: FrameMetadata) =>
    sameOriginFrameElements().find((element) => {
      const frameName = element.name || element.id || '';
      const frameUrl = element.contentDocument?.location?.href ?? element.src ?? '';
      return Boolean(
        (metadata.name && frameName === metadata.name) ||
          (metadata.url && frameUrl === metadata.url),
      );
    }) ?? null;
  const flattenFrameTree = (tree: RuntimeMethodTable | undefined, parentId?: string): FrameMetadata[] => {
    if (!tree?.frame || typeof tree.frame !== 'object') {
      return [];
    }
    const frame = tree.frame as RuntimeMethodTable;
    return [
      {
        id: typeof frame.id === 'string' ? frame.id : '',
        parentId,
        name: typeof frame.name === 'string' ? frame.name : '',
        url: typeof frame.url === 'string' ? frame.url : '',
      },
      ...((Array.isArray(tree.childFrames) ? tree.childFrames : []) as RuntimeMethodTable[]).flatMap((child) =>
        flattenFrameTree(child, typeof frame.id === 'string' ? frame.id : undefined),
      ),
    ];
  };
  const readFrameMetadata = async () => {
    if (!deps.browserCommand) {
      return [
        { name: '', url: globalThis.location?.href ?? '' },
        ...sameOriginFrameElements().map((element) => ({
          name: element.name || element.id || '',
          url: element.contentDocument?.location?.href ?? element.src ?? '',
        })),
      ];
    }
    const result = await browserCommand<{ frameTree?: RuntimeMethodTable }>('Page.getFrameTree');
    return flattenFrameTree(result.frameTree);
  };
  const frameExecutionContextId = async (frameId: string) => {
    const result = await browserCommand<{ executionContextId?: number }>('Page.createIsolatedWorld', {
      frameId,
      worldName: '__webCapPlaywrightFrame',
      grantUniveralAccess: true,
    });
    if (!result.executionContextId) {
      throw new Error(`Could not create execution context for frame ${frameId}.`);
    }
    return result.executionContextId;
  };
  const evaluateInFrame = async <T = unknown>(frameId: string, expression: string) => {
    const contextId = await frameExecutionContextId(frameId);
    const result = await browserCommand<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? `Frame evaluation failed for ${frameId}.`);
    }
    return result.result?.value as T;
  };
  const createCdpFrameLocator = (frameId: string, selector: string, locatorLabel: string, queryExpression?: string): RuntimeMethodTable => {
    const selectorJson = JSON.stringify(selector);
    const queryAllExpression = queryExpression ?? `[...document.querySelectorAll(${selectorJson})]`;
    const readOne = async <T = unknown>(body: string) =>
      await evaluateInFrame<T>(frameId, `(() => {
        const element = (${queryAllExpression})[0] ?? null;
        if (!element) return null;
        ${body}
      })()`);
    const locatorApi: RuntimeMethodTable = {
      async count() {
        return await evaluateInFrame<number>(frameId, `(${queryAllExpression}).length`);
      },
      async textContent() {
        return await readOne<string | null>('return element.textContent;');
      },
      async innerText() {
        return await readOne<string | null>('return element instanceof HTMLElement ? element.innerText : element.textContent;');
      },
      async allTextContents() {
        return await evaluateInFrame<string[]>(frameId, `(${queryAllExpression}).map((element) => element.textContent ?? '')`);
      },
      async allInnerTexts() {
        return await evaluateInFrame<string[]>(frameId, `(${queryAllExpression}).map((element) => element instanceof HTMLElement ? element.innerText : element.textContent ?? '')`);
      },
      async isVisible() {
        return Boolean(await readOne<boolean>(`const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;`));
      },
      async waitFor(options: { timeout?: number } = {}) {
        const timeout = timeoutFromOptions(options, defaultTimeoutMs);
        const startedAt = Date.now();
        while (Date.now() - startedAt <= timeout) {
          if (await locatorApi.count() > 0) {
            return;
          }
          await deps.wait(50);
        }
        throw new Error(`Timed out after ${timeout}ms waiting for ${locatorLabel}.`);
      },
      async click(options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        const rect = await readOne<{ left: number; top: number; width: number; height: number } | null>(
          `const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };`,
        );
        if (!rect) {
          throw new Error(`${locatorLabel} did not resolve to an element.`);
        }
        const owner = await browserCommand<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId });
        const box = owner.backendNodeId
          ? await browserCommand<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })
          : null;
        const content = box?.model?.content ?? [0, 0];
        const x = Number(content[0] ?? 0) + rect.left + rect.width / 2;
        const y = Number(content[1] ?? 0) + rect.top + rect.height / 2;
        await browserCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 0 });
        await browserCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await browserCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      },
      async hover(options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        const rect = await readOne<{ left: number; top: number; width: number; height: number } | null>(
          `const rect = element.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };`,
        );
        if (!rect) {
          throw new Error(`${locatorLabel} did not resolve to an element.`);
        }
        const owner = await browserCommand<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId });
        const box = owner.backendNodeId
          ? await browserCommand<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })
          : null;
        const content = box?.model?.content ?? [0, 0];
        const x = Number(content[0] ?? 0) + rect.left + rect.width / 2;
        const y = Number(content[1] ?? 0) + rect.top + rect.height / 2;
        await browserCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 0 });
      },
      async dblclick(options?: { timeout?: number }) {
        await locatorApi.click(options);
        await locatorApi.click(options);
      },
      async tap(options?: { timeout?: number }) {
        await locatorApi.click(options);
      },
      async fill(value: unknown, options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        const valueJson = JSON.stringify(String(value ?? ''));
        await evaluateInFrame(frameId, `(() => {
          const element = (${queryAllExpression})[0] ?? null;
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            throw new Error('Frame locator fill target is not editable.');
          }
          element.focus();
          element.value = ${valueJson};
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      async type(value: unknown, options?: { timeout?: number }) {
        await locatorApi.fill(value, options);
      },
      async press(key: unknown, options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        const keyJson = JSON.stringify(String(key ?? ''));
        await evaluateInFrame(frameId, `(() => {
          const element = (${queryAllExpression})[0] ?? null;
          if (!(element instanceof HTMLElement)) throw new Error('Frame locator press target is not an HTMLElement.');
          element.focus();
          const key = ${keyJson};
          element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
          element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        })()`);
      },
      async check(options?: { timeout?: number }) {
        await locatorApi.setChecked(true, options);
      },
      async uncheck(options?: { timeout?: number }) {
        await locatorApi.setChecked(false, options);
      },
      async setChecked(checked: unknown, options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        await evaluateInFrame(frameId, `(() => {
          const element = (${queryAllExpression})[0] ?? null;
          if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') {
            throw new Error('Frame locator checkbox target is not a checkbox input.');
          }
          const checked = ${Boolean(checked)};
          if (element.checked !== checked) {
            element.checked = checked;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
      },
      async selectOption(values: unknown, options?: { timeout?: number }) {
        await locatorApi.waitFor(options);
        const selectedValues = Array.isArray(values) ? values.map(String) : [String(values)];
        const valuesJson = JSON.stringify(selectedValues);
        await evaluateInFrame(frameId, `(() => {
          const element = (${queryAllExpression})[0] ?? null;
          if (!(element instanceof HTMLSelectElement)) {
            throw new Error('Frame locator select target is not a select element.');
          }
          const values = new Set(${valuesJson});
          for (const option of [...element.options]) {
            option.selected = values.has(option.value) || values.has(option.label);
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        return selectedValues;
      },
      locator(innerSelector: unknown) {
        if (typeof innerSelector !== 'string') {
          throw new Error('frame locator only supports string selectors in Web Cap script runtime.');
        }
        return createCdpFrameLocator(frameId, `${selector} ${innerSelector}`, `${locatorLabel}.locator(${innerSelector})`);
      },
      toString() {
        return locatorLabel;
      },
    };
    return locatorApi;
  };
  const createFrameApi = (frameElement: HTMLIFrameElement | null, metadata: FrameMetadata = {}): RuntimeMethodTable => {
    const frameApi: RuntimeMethodTable = {
      frameElement() {
        return frameElement;
      },
      _id() {
        return metadata.id ?? '';
      },
      _parentId() {
        return metadata.parentId ?? '';
      },
      parentFrame() {
        return null;
      },
      name() {
        return metadata.name ?? frameElement?.name ?? frameElement?.id ?? '';
      },
      url() {
        return metadata.url ?? frameDocument(frameElement)?.location?.href ?? '';
      },
      async title() {
        return frameDocument(frameElement)?.title ?? '';
      },
      locator(selector: unknown) {
        if (typeof selector !== 'string') {
          throw new Error('frame.locator only supports string selectors in Web Cap script runtime.');
        }
        if (!frameDocument(frameElement) && metadata.id) {
          return createCdpFrameLocator(metadata.id, selector, `frame(${metadata.id}).locator(${selector})`);
        }
        return createLocator(
          () => {
            const doc = frameDocument(frameElement);
            return doc ? queryLocatorSelectorAll(selector, doc.documentElement) : [];
          },
          `frame.locator(${selector})`,
          pageApi,
          deps,
        );
      },
      async waitForSelector(selector: unknown, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}) {
        if (!frameDocument(frameElement) && metadata.id) {
          const locator = createCdpFrameLocator(metadata.id, String(selector), `frame(${metadata.id}).locator(${String(selector)})`);
          await locator.waitFor(options);
          return null;
        }
        return await waitForLocator(
          () => {
            const doc = frameDocument(frameElement);
            return doc ? queryLocatorSelectorAll(String(selector), doc.documentElement) : [];
          },
          `frame.waitForSelector(${String(selector)})`,
          deps.wait,
          { timeout: defaultTimeoutMs, ...options },
        );
      },
    };
    frameApi.getByText = (text: unknown, options: { exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        const textJson = JSON.stringify(String(text ?? ''));
        const exact = options.exact === true;
        return createCdpFrameLocator(
          metadata.id,
          '*',
          `frame(${metadata.id}).getByText(${String(text)})`,
          `[...document.querySelectorAll('*')].filter((element) => {
            const value = String(element.textContent ?? '').replace(/\\s+/g, ' ').trim();
            return ${exact} ? value === ${textJson} : value.includes(${textJson});
          })`,
        );
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByText(text, options);
    };
    frameApi.getByTestId = (testId: unknown) => {
      const selector = `[data-testid="${cssEscape(String(testId))}"]`;
      return frameApi.locator(selector);
    };
    const cdpAttributeTextLocator = (attribute: string, text: unknown, exact = false, labelName = attribute) => {
      if (!metadata.id) {
        return null;
      }
      const textJson = JSON.stringify(String(text ?? ''));
      const attributeJson = JSON.stringify(attribute);
      return createCdpFrameLocator(
        metadata.id,
        '*',
        `frame(${metadata.id}).getBy${labelName}(${String(text)})`,
        `[...document.querySelectorAll('*')].filter((element) => {
          const value = String(element.getAttribute(${attributeJson}) ?? '').replace(/\\s+/g, ' ').trim();
          return ${exact} ? value === ${textJson} : value.includes(${textJson});
        })`,
      );
    };
    frameApi.getByPlaceholder = (text: unknown, options: { exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        return cdpAttributeTextLocator('placeholder', text, options.exact, 'Placeholder');
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByPlaceholder(text, options);
    };
    frameApi.getByTitle = (text: unknown, options: { exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        return cdpAttributeTextLocator('title', text, options.exact, 'Title');
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByTitle(text, options);
    };
    frameApi.getByAltText = (text: unknown, options: { exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        const textJson = JSON.stringify(String(text ?? ''));
        return createCdpFrameLocator(
          metadata.id,
          'img, area',
          `frame(${metadata.id}).getByAltText(${String(text)})`,
          `[...document.querySelectorAll('img, area')].filter((element) => {
            const value = String(element.getAttribute('alt') ?? '').replace(/\\s+/g, ' ').trim();
            return ${options.exact === true} ? value === ${textJson} : value.includes(${textJson});
          })`,
        );
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByAltText(text, options);
    };
    frameApi.getByLabel = (text: unknown, options: { exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        const textJson = JSON.stringify(String(text ?? ''));
        return createCdpFrameLocator(
          metadata.id,
          'input, textarea, select',
          `frame(${metadata.id}).getByLabel(${String(text)})`,
          `[...document.querySelectorAll('input, textarea, select')].filter((element) => {
            const labels = element.labels ? [...element.labels].map((label) => label.textContent ?? '').join(' ') : '';
            const aria = element.getAttribute('aria-label') ?? '';
            const value = String(aria || labels).replace(/\\s+/g, ' ').trim();
            return ${options.exact === true} ? value === ${textJson} : value.includes(${textJson});
          })`,
        );
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByLabel(text, options);
    };
    frameApi.getByRole = (role: unknown, options: { name?: unknown; exact?: boolean } = {}) => {
      if (!frameDocument(frameElement) && metadata.id) {
        const roleJson = JSON.stringify(String(role));
        const nameJson = JSON.stringify(options.name === undefined ? '' : String(options.name));
        const hasName = options.name !== undefined;
        return createCdpFrameLocator(
          metadata.id,
          '*',
          `frame(${metadata.id}).getByRole(${String(role)})`,
          `[...document.querySelectorAll('*')].filter((element) => {
            const explicitRole = element.getAttribute('role') || '';
            const tag = element.tagName.toLowerCase();
            const inputType = (element.getAttribute('type') || 'text').toLowerCase();
            const implicitRole =
              tag === 'button' ? 'button' :
              tag === 'a' && element.href ? 'link' :
              tag === 'img' ? 'img' :
              tag === 'textarea' ? 'textbox' :
              tag === 'select' ? 'combobox' :
              tag === 'input' && ['button', 'submit', 'reset'].includes(inputType) ? 'button' :
              tag === 'input' && inputType === 'checkbox' ? 'checkbox' :
              tag === 'input' && inputType === 'radio' ? 'radio' :
              tag === 'input' && inputType === 'search' ? 'searchbox' :
              tag === 'input' ? 'textbox' : '';
            if ((explicitRole || implicitRole) !== ${roleJson}) return false;
            if (!${hasName}) return true;
            const value = String(element.getAttribute('aria-label') || element.textContent || '').replace(/\\s+/g, ' ').trim();
            return ${options.exact === true} ? value === ${nameJson} : value.includes(${nameJson});
          })`,
        );
      }
      return (frameApi.locator('body') as RuntimeMethodTable).getByRole(role, options);
    };
    for (const method of [] as string[]) {
      frameApi[method] = (...args: unknown[]) =>
        (frameApi.locator('body') as RuntimeMethodTable)[method](...args);
    }
    return frameApi;
  };
  pageApi.__frameForElement = createFrameApi;
  Object.assign(pageApi, {
    keyboard: keyboardApi,
    mouse: mouseApi,
    async $(selector: unknown) {
      return queryLocatorSelectorAll(String(selector))[0] ?? null;
    },
    async $$(selector: unknown) {
      return queryLocatorSelectorAll(String(selector));
    },
    async evaluate(pageFunction: unknown, arg?: unknown) {
      if (typeof pageFunction === 'function') {
        return await Promise.resolve(pageFunction(arg));
      }
      if (typeof pageFunction === 'string') {
        return (0, eval)(pageFunction);
      }
      throw new Error('page.evaluate requires a function or string expression.');
    },
    async waitForSelector(selector: unknown, options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}) {
      return await waitForLocator(() => queryLocatorSelectorAll(String(selector)), `page.waitForSelector(${String(selector)})`, deps.wait, { timeout: defaultTimeoutMs, ...options });
    },
    async addScriptTag(options: { content?: unknown; type?: unknown; url?: unknown } = {}) {
      const script = document.createElement('script');
      if (options.type !== undefined) {
        script.type = String(options.type);
      }
      if (options.content !== undefined) {
        script.textContent = String(options.content);
      }
      if (options.url !== undefined) {
        await new Promise<void>((resolve, reject) => {
          script.addEventListener('load', () => resolve(), { once: true });
          script.addEventListener('error', () => reject(new Error(`Failed to load script ${String(options.url)}`)), { once: true });
          script.src = String(options.url);
          document.head.appendChild(script);
        });
        return script;
      }
      document.head.appendChild(script);
      return script;
    },
    async addStyleTag(options: { content?: unknown; url?: unknown } = {}) {
      if (options.url !== undefined) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        await new Promise<void>((resolve, reject) => {
          link.addEventListener('load', () => resolve(), { once: true });
          link.addEventListener('error', () => reject(new Error(`Failed to load stylesheet ${String(options.url)}`)), { once: true });
          link.href = String(options.url);
          document.head.appendChild(link);
        });
        return link;
      }
      const style = document.createElement('style');
      style.textContent = String(options.content ?? '');
      document.head.appendChild(style);
      return style;
    },
    async bringToFront() {
      await browserCommand('Page.bringToFront');
    },
    async check(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).setChecked(true, options);
    },
    async click(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).click(options);
    },
    async close() {
      globalThis.close?.();
    },
    async content() {
      return document.documentElement.outerHTML;
    },
    async dblclick(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).dblclick(options);
    },
    async dispatchEvent(selector: unknown, type: unknown, eventInit?: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).dispatchEvent(type, eventInit, options);
    },
    async dragAndDrop(source: unknown, target: unknown, options?: unknown) {
      const sourceLocator = (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(source));
      const targetLocator = (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(target));
      await sourceLocator.dragTo(targetLocator, options);
    },
    async fill(selector: unknown, value: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).fill(value, options);
    },
    async emulateMedia(options: { media?: unknown; colorScheme?: unknown; reducedMotion?: unknown } = {}) {
      const features = [];
      if (options.colorScheme !== undefined) {
        features.push({ name: 'prefers-color-scheme', value: String(options.colorScheme) });
      }
      if (options.reducedMotion !== undefined) {
        features.push({ name: 'prefers-reduced-motion', value: String(options.reducedMotion) });
      }
      await browserCommand('Emulation.setEmulatedMedia', {
        media: options.media === undefined ? '' : String(options.media),
        features,
      });
    },
    async focus(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).focus(options);
    },
    async frame(options: unknown = {}) {
      const frames = await (pageApi.frames as () => Promise<RuntimeMethodTable[]>)();
      if (typeof options === 'string') {
        return frames.find((frame) => frame.name() === options || frame.url() === options) ?? null;
      }
      const name = options && typeof options === 'object' && 'name' in options ? String((options as { name?: unknown }).name ?? '') : '';
      const url = options && typeof options === 'object' && 'url' in options ? (options as { url?: unknown }).url : undefined;
      return frames.find((frame) => {
        if (name && frame.name() !== name) {
          return false;
        }
        if (typeof url === 'string' && frame.url() !== url) {
          return false;
        }
        if (url instanceof RegExp && !url.test(frame.url())) {
          return false;
        }
        return true;
      }) ?? null;
    },
    frameLocator(selector: unknown) {
      if (typeof selector !== 'string') {
        throw new Error('page.frameLocator only supports string selectors in Web Cap script runtime.');
      }
      const queryFrameDocuments = () =>
        queryLocatorSelectorAll(selector)
          .filter((element): element is HTMLIFrameElement => element instanceof HTMLIFrameElement)
          .map((element) => element.contentDocument)
          .filter((item): item is Document => Boolean(item));
      const frameLocatorApi: RuntimeMethodTable = {
        locator(innerSelector: unknown) {
          if (typeof innerSelector !== 'string') {
            throw new Error('frameLocator.locator only supports string selectors in Web Cap script runtime.');
          }
          return createLocator(
            () => queryFrameDocuments().flatMap((frameDoc) => queryLocatorSelectorAll(innerSelector, frameDoc.documentElement)),
            `page.frameLocator(${selector}).locator(${innerSelector})`,
            pageApi,
            deps,
          );
        },
      };
      for (const method of ['getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId', 'getByText', 'getByTitle']) {
        frameLocatorApi[method] = (...args: unknown[]) =>
          (frameLocatorApi.locator('body') as RuntimeMethodTable)[method](...args);
      }
      return frameLocatorApi;
    },
    async frames() {
      const metadata = await readFrameMetadata();
      if (metadata.length === 0) {
        return [createFrameApi(null, { name: '', url: globalThis.location?.href ?? '' })];
      }
      const frameApis = metadata.map((frame, index) =>
        createFrameApi(index === 0 ? null : findSameOriginFrameElement(frame), frame),
      );
      const frameById = new Map(frameApis.map((frame) => [frame._id(), frame]));
      for (const frame of frameApis) {
        frame.parentFrame = () => frameById.get(frame._parentId()) ?? null;
      }
      return frameApis;
    },
    async goBack() {
      globalThis.history?.back();
      return null;
    },
    async goForward() {
      globalThis.history?.forward();
      return null;
    },
    getAttribute(selector: unknown, name: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).getAttribute(name, options);
    },
    getByAltText(text: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByAltText(text, options);
    },
    getByLabel(text: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByLabel(text, options);
    },
    getByPlaceholder(text: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByPlaceholder(text, options);
    },
    getByRole(role: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByRole(role, options);
    },
    getByTestId(testId: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(`[data-testid="${cssEscape(String(testId))}"]`);
    },
    getByText(text: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByText(text, options);
    },
    getByTitle(text: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)('body').getByTitle(text, options);
    },
    async hover(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).hover(options);
    },
    async hideHighlight() {
      hideHighlightOverlay();
    },
    innerHTML(selector: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).innerHTML(options);
    },
    innerText(selector: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).innerText(options);
    },
    inputValue(selector: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).inputValue(options);
    },
    isChecked(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isChecked();
    },
    isClosed() {
      return false;
    },
    isDisabled(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isDisabled();
    },
    isEditable(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isEditable();
    },
    isEnabled(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isEnabled();
    },
    isHidden(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isHidden();
    },
    isVisible(selector: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).isVisible();
    },
    locator(selector: unknown) {
      if (typeof selector !== 'string') {
        throw new Error('page.locator only supports string selectors in Web Cap script runtime.');
      }
      return createLocator(() => queryLocatorSelectorAll(selector), `page.locator(${selector})`, pageApi, deps);
    },
    async mainFrame() {
      const frames = await (pageApi.frames as () => Promise<RuntimeMethodTable[]>)();
      return frames[0] ?? createFrameApi(null, { name: '', url: globalThis.location?.href ?? '' });
    },
    async goto(url: unknown) {
      globalThis.location.href = String(url);
      return null;
    },
    async press(selector: unknown, key: unknown, options?: unknown) {
      const locator = (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector));
      await locator.press(key, options);
    },
    async selectOption(selector: unknown, values: unknown, options?: unknown) {
      return await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).selectOption(values, options);
    },
    async setChecked(selector: unknown, checked: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).setChecked(checked, options);
    },
    async setContent(html: unknown) {
      document.open();
      document.write(String(html));
      document.close();
    },
    async tap(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).tap(options);
    },
    textContent(selector: unknown, options?: unknown) {
      return (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).textContent(options);
    },
    async title() {
      return document.title;
    },
    async type(selector: unknown, text: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).type(text, options);
    },
    async uncheck(selector: unknown, options?: unknown) {
      await (pageApi.locator as (selector: string) => RuntimeMethodTable)(String(selector)).uncheck(options);
    },
    url() {
      return globalThis.location?.href ?? '';
    },
    viewportSize() {
      return { width: window.innerWidth, height: window.innerHeight };
    },
    async reload() {
      globalThis.location.reload();
      return null;
    },
    async requestGC() {
      await browserCommand('HeapProfiler.collectGarbage');
    },
    async pdf(options: Record<string, unknown> = {}) {
      const result = await browserCommand<{ data?: string }>('Page.printToPDF', options);
      return result.data ?? result;
    },
    async screenshot(options: { type?: unknown; quality?: unknown; fullPage?: unknown } = {}) {
      const format = options.type === 'jpeg' ? 'jpeg' : 'png';
      const params: Record<string, unknown> = { format, fromSurface: true };
      if (format === 'jpeg' && options.quality !== undefined) {
        params.quality = Number(options.quality);
      }
      if (options.fullPage === true) {
        const metrics = await browserCommand<{
          contentSize?: { x?: number; y?: number; width?: number; height?: number };
        }>('Page.getLayoutMetrics');
        const contentSize = metrics.contentSize;
        if (contentSize) {
          params.captureBeyondViewport = true;
          params.clip = {
            x: Number(contentSize.x ?? 0),
            y: Number(contentSize.y ?? 0),
            width: Number(contentSize.width ?? window.innerWidth),
            height: Number(contentSize.height ?? window.innerHeight),
            scale: 1,
          };
        }
      }
      const result = await browserCommand<{ data?: string }>('Page.captureScreenshot', params);
      if (typeof result.data !== 'string' || result.data.length === 0) {
        throw new Error('Page.captureScreenshot returned no image data.');
      }
      const data = result.data;
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return deps.createScreenshotArtifact
        ? deps.createScreenshotArtifact({ data, mimeType, type: format })
        : { data, mimeType, type: format };
    },
    async setDefaultNavigationTimeout(timeout: unknown) {
      defaultTimeoutMs = Math.max(Number(timeout) || 0, 0);
    },
    async setDefaultTimeout(timeout: unknown) {
      defaultTimeoutMs = Math.max(Number(timeout) || 0, 0);
    },
    async setExtraHTTPHeaders(headers: Record<string, unknown> = {}) {
      await browserCommand('Network.enable');
      await browserCommand('Network.setExtraHTTPHeaders', { headers });
    },
    async setViewportSize(size: { width?: unknown; height?: unknown }) {
      const width = Math.max(Math.trunc(Number(size?.width ?? window.innerWidth)), 1);
      const height = Math.max(Math.trunc(Number(size?.height ?? window.innerHeight)), 1);
      await browserCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: window.devicePixelRatio || 1,
        mobile: false,
      });
    },
    async waitForLoadState(state: unknown = 'load', options: { timeout?: number } = {}) {
      const target = String(state);
      const isReady = () =>
        target === 'domcontentloaded'
          ? document.readyState === 'interactive' || document.readyState === 'complete'
          : document.readyState === 'complete';
      if (isReady()) {
        if (target === 'networkidle') {
          await deps.wait(500);
        }
        return;
      }
      const timeout = timeoutFromOptions(options, defaultTimeoutMs);
      await Promise.race([
        new Promise<void>((resolve) => {
          const eventName = target === 'domcontentloaded' ? 'DOMContentLoaded' : 'load';
          globalThis.addEventListener(eventName, () => resolve(), { once: true });
        }),
        deps.wait(timeout).then(() => {
          throw new Error(`Timed out after ${timeout}ms waiting for load state ${target}.`);
        }),
      ]);
      if (target === 'networkidle') {
        await deps.wait(500);
      }
    },
    async waitForNavigation(options: { timeout?: number } = {}) {
      await browserCommand('Page.enable');
      const event = await browserEvent('Page.frameNavigated', {}, timeoutFromOptions(options, defaultTimeoutMs));
      await (pageApi.waitForLoadState as (state?: unknown, options?: { timeout?: number }) => Promise<void>)('load', options).catch(() => undefined);
      return event;
    },
    async waitForEvent(event: unknown, options: { timeout?: number; predicate?: unknown } = {}) {
      const eventName = String(event);
      if (eventName === 'request') {
        return await (pageApi.waitForRequest as (urlOrPredicate?: unknown, options?: { timeout?: number }) => Promise<unknown>)(undefined, options);
      }
      if (eventName === 'response') {
        return await (pageApi.waitForResponse as (urlOrPredicate?: unknown, options?: { timeout?: number }) => Promise<unknown>)(undefined, options);
      }
      if (eventName === 'load') {
        await (pageApi.waitForLoadState as (state?: unknown, options?: { timeout?: number }) => Promise<void>)('load', options);
        return { type: 'load' };
      }
      if (eventName === 'domcontentloaded') {
        await (pageApi.waitForLoadState as (state?: unknown, options?: { timeout?: number }) => Promise<void>)('domcontentloaded', options);
        return { type: 'domcontentloaded' };
      }
      if (eventName === 'framenavigated') {
        await browserCommand('Page.enable');
        return await browserEvent('Page.frameNavigated', {}, timeoutFromOptions(options, defaultTimeoutMs));
      }
      throw new Error(`page.waitForEvent(${eventName}) is not implemented by Web Cap script runtime yet.`);
    },
    async waitForRequest(urlOrPredicate: unknown, options: { timeout?: number } = {}) {
      await browserCommand('Network.enable');
      return await browserEvent('Network.requestWillBeSent', serializeUrlMatcher(urlOrPredicate), timeoutFromOptions(options, defaultTimeoutMs));
    },
    async waitForResponse(urlOrPredicate: unknown, options: { timeout?: number } = {}) {
      await browserCommand('Network.enable');
      return await browserEvent('Network.responseReceived', serializeUrlMatcher(urlOrPredicate), timeoutFromOptions(options, defaultTimeoutMs));
    },
    async waitForTimeout(timeout: unknown) {
      await deps.wait(Number(timeout) || 0);
    },
    async waitForURL(url: unknown, options: { timeout?: number } = {}) {
      const timeout = timeoutFromOptions(options, defaultTimeoutMs);
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeout) {
        const currentUrl = globalThis.location?.href ?? '';
        if (
          (typeof url === 'string' && currentUrl === url) ||
          (url instanceof RegExp && url.test(currentUrl)) ||
          (typeof url === 'function' && url(new URL(currentUrl)))
        ) {
          return;
        }
        await deps.wait(50);
      }
      throw new Error(`Timed out after ${timeout}ms waiting for URL ${String(url)}.`);
    },
  });

  for (const method of PLAYWRIGHT_PAGE_METHODS) {
    if (!(method in pageApi)) {
      pageApi[method] = notImplemented(`page.${method}`);
    }
  }

  return pageApi;
}


return createPageApi();
}
