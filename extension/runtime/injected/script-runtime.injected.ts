/* eslint-disable */
// Mechanically extracted from execution-helpers.ts. Keep behavior changes out of this file.
import { createPlaywrightPageApi } from './playwright-shim.injected';
import type {
  RuntimeScreenshotArtifactInput,
  ScriptPlaywrightPage,
} from './playwright-shim-types.injected';
import { installManagedClickHook } from './managed-click.injected';
import { captureVisibleElementsDiff } from './visible-elements.injected';

type RuntimeJsonObject = Record<string, unknown>;

interface RuntimeEvidenceEvent {
  type: string;
  value: unknown;
}

type RuntimeEvidenceOption = 'events' | 'visibleElements' | 'common' | 'all';

interface RuntimeFieldSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
}

interface RuntimeObjectSchema {
  properties: Record<string, RuntimeFieldSchema>;
  required: string[];
  additionalProperties?: boolean;
}

interface RuntimeScript {
  id: string;
  name: string;
  summary: string;
  inputSchema: RuntimeObjectSchema;
  outputSchema: RuntimeObjectSchema;
  script: {
    timeoutMs: number;
  };
}

interface RuntimeEvidence {
  url: string | undefined;
  events: RuntimeEvidenceEvent[];
  screenshots: unknown[];
  visibleElements?: unknown;
  visibleElementsTimingMs?: number;
  visibleElementsDebugTiming?: {
    scriptTimingMs: number;
    beforeSnapshotTimingMs: number;
    postActionDelayMs: number;
    afterSnapshotTimingMs: number;
    diffTimingMs: number;
  };
}

interface RuntimeScreenshotArtifact {
  kind: 'screenshot';
  path: string;
  data: string;
  mimeType: string;
  type: 'png' | 'jpeg';
  encoding: 'base64';
}

interface RuntimeContext {
  registry: Map<string, RuntimeScript>;
  evidence: RuntimeEvidence;
  state: RuntimeJsonObject;
  callStack: string[];
  screenshotArtifacts: RuntimeScreenshotArtifact[];
  pendingAsyncOperations: Promise<unknown>;
  visibleElementsTracker: {
    start(): void;
    stop(): unknown[];
    snapshot(): unknown;
    snapshotForChanges(changeRecords?: unknown[]): unknown;
    diff(
      beforeSnapshot: unknown,
      afterSnapshot: unknown,
      changeRecords?: unknown[],
    ): unknown;
  };
}

type RuntimeApi = {
  get(scriptId: string): RuntimeJsonObject;
  list(): RuntimeJsonObject[];
  call(scriptId: string, nestedInput?: RuntimeJsonObject): Promise<RuntimeJsonObject>;
  page: ScriptPlaywrightPage;
  typeIntoElement(element: unknown, value: unknown): Promise<void>;
  waitForManagedInput(): Promise<void>;
};

type ManagedKeyboardBridge = (payload: RuntimeJsonObject) => unknown;
type ManagedWindowBridge = (payload: RuntimeJsonObject) => unknown;
type ManagedBrowserBridge = (payload: RuntimeJsonObject) => unknown;

export interface ScriptRuntimeArgs {
  scriptDefinition: RuntimeScript;
  input: RuntimeJsonObject;
  scriptRegistry: RuntimeScript[];
  managedClickBridgeFunctionName: string | null;
  managedKeyboardBridgeFunctionName: string | null;
  managedWindowBridgeFunctionName: string | null;
  managedBrowserBridgeFunctionName: string | null;
  screenshotArtifactBasePath: string | null;
  evidence: RuntimeEvidenceOption[];
  scriptFactories: Record<string, (input: RuntimeJsonObject) => unknown>;
}

export async function runScriptRuntime({
  scriptDefinition,
  input,
  scriptRegistry,
  managedClickBridgeFunctionName,
  managedKeyboardBridgeFunctionName,
  managedWindowBridgeFunctionName,
  managedBrowserBridgeFunctionName,
  screenshotArtifactBasePath,
  evidence,
  scriptFactories,
}: ScriptRuntimeArgs) {
  function validateScalarField(
    key: string,
    value: unknown,
    schema: RuntimeFieldSchema,
    errors: string[],
  ) {
    if (value === undefined || value === null) {
      errors.push(`Missing required field: ${key}`);
      return;
    }

    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push(`Field ${key} must be a string.`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push(`Field ${key} must be a number.`);
        }
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push(`Field ${key} must be an integer.`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`Field ${key} must be a boolean.`);
        }
        break;
    }

    if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`Field ${key} must be >= ${schema.minimum}.`);
    }

    if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`Field ${key} must be <= ${schema.maximum}.`);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`Field ${key} must be one of: ${schema.enum.join(', ')}.`);
    }
  }

  function validateInputAgainstSchema(candidate: RuntimeJsonObject, schema: RuntimeObjectSchema) {
    const errors: string[] = [];

    for (const requiredKey of schema.required) {
      if (!(requiredKey in candidate)) {
        errors.push(`Missing required field: ${requiredKey}`);
      }
    }

    for (const [key, value] of Object.entries(candidate)) {
      const fieldSchema = schema.properties[key];
      if (!fieldSchema) {
        if (!schema.additionalProperties) {
          errors.push(`Unexpected field: ${key}`);
        }
        continue;
      }

      validateScalarField(key, value, fieldSchema, errors);
    }

    return {
      ok: errors.length === 0,
      errors,
    };
  }

  function normalizeResult(value: unknown): RuntimeJsonObject {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as RuntimeJsonObject;
    }

    throw new Error('Script script must return a JSON object.');
  }

  function createEvidence(includeUrl = false): RuntimeEvidence {
    return {
      url: includeUrl ? globalThis.location?.href : undefined,
      events: [],
      screenshots: [],
      visibleElements: undefined,
      visibleElementsTimingMs: undefined,
    };
  }

  function wait(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }

  const POST_ACTION_VISIBLE_DIFF_DELAY_MS = 200;
  const MAX_SCROLL_TARGETS = 200;
  const collectEvents = shouldCollectEvidence('events');
  const collectVisibleElements = shouldCollectEvidence('visibleElements');

  function hasPostActionEventSince(eventStartIndex: number) {
    return context.evidence.events
      .slice(eventStartIndex)
      .some((event) => event.type === 'managed_click' || event.type === 'managed_mouse');
  }

  function shouldCollectEvidence(
    option: Exclude<RuntimeEvidenceOption, 'common' | 'all'>,
  ): boolean {
    return evidence.includes('all') || evidence.includes('common') || evidence.includes(option);
  }

  function buildResponseEvidence(): RuntimeEvidence {
    const responseEvidence = createEvidence(collectEvents || collectVisibleElements);
    if (collectEvents) {
      responseEvidence.events = context.evidence.events.filter(shouldIncludeEvidenceEvent);
    }
    if (collectVisibleElements) {
      responseEvidence.visibleElements = context.evidence.visibleElements;
      responseEvidence.visibleElementsTimingMs = context.evidence.visibleElementsTimingMs;
      responseEvidence.visibleElementsDebugTiming = context.evidence.visibleElementsDebugTiming;
    }
    return responseEvidence;
  }

  function shouldIncludeEvidenceEvent(event: RuntimeEvidenceEvent): boolean {
    if (evidence.includes('all') || evidence.includes('events')) {
      return true;
    }
    if (evidence.includes('common')) {
      return event.type !== 'managed_mouse';
    }
    return false;
  }

  function toSchemaSummary(item: RuntimeScript): RuntimeJsonObject {
    return {
      scriptId: item.id,
      name: item.name,
      description: item.summary,
      inputSchema: item.inputSchema,
      outputSchema: item.outputSchema,
    };
  }

  const context: RuntimeContext = {
    registry: new Map(),
    evidence: createEvidence(collectEvents || collectVisibleElements),
    state: {},
    callStack: [],
    screenshotArtifacts: [],
    pendingAsyncOperations: Promise.resolve(),
    visibleElementsTracker: captureVisibleElementsDiff(),
  };

  for (const item of scriptRegistry) {
    context.registry.set(item.id, item);
  }
  context.registry.set(scriptDefinition.id, scriptDefinition);

  function roundedPoint(x: number, y: number) {
    return {
      x: Number.isFinite(x) ? Math.round(x) : 0,
      y: Number.isFinite(y) ? Math.round(y) : 0,
    };
  }

  function describeScrollTarget(element: Element): RuntimeJsonObject {
    return {
      kind: 'element',
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      className: element instanceof HTMLElement ? element.className || '' : '',
    };
  }

  function isScrollableElement(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    return (
      element.scrollHeight > element.clientHeight ||
      element.scrollWidth > element.clientWidth
    );
  }

  function collectScrollPositions() {
    const positions = new Map<Window | HTMLElement, { x: number; y: number }>();
    if (typeof window !== 'undefined') {
      positions.set(window, { x: window.scrollX || 0, y: window.scrollY || 0 });
    }

    if (typeof document === 'undefined') {
      return positions;
    }

    for (const element of [...document.querySelectorAll('*')]) {
      if (positions.size >= MAX_SCROLL_TARGETS) {
        break;
      }
      if (isScrollableElement(element)) {
        positions.set(element, {
          x: element.scrollLeft || 0,
          y: element.scrollTop || 0,
        });
      }
    }

    return positions;
  }

  function installPageSideEffectTracking() {
    const initialScrollPositions = collectScrollPositions();
    const initialUrl = globalThis.location?.href;
    const initialTitle = globalThis.document?.title ?? '';
    let lastUrl = initialUrl;
    let lastTitle = initialTitle;

    const runtimeGlobal = globalThis as typeof globalThis & {
      history?: History;
      navigator?: Navigator;
    };
    const historyObject = runtimeGlobal.history;
    const originalPushState = historyObject?.pushState;
    const originalReplaceState = historyObject?.replaceState;
    const clipboard = runtimeGlobal.navigator?.clipboard;
    const originalClipboardWriteText = clipboard?.writeText;
    const originalClipboardWrite = clipboard?.write;
    const restoreTasks: Array<() => void> = [];

    const recordUrlChange = (method: string) => {
      const nextUrl = globalThis.location?.href;
      const nextTitle = globalThis.document?.title ?? '';
      if (!nextUrl || !lastUrl || (nextUrl === lastUrl && nextTitle === lastTitle)) {
        return;
      }

      const from: { title?: string; url?: string } = {};
      const to: { title?: string; url?: string } = {};
      if (nextUrl !== lastUrl) {
        from.url = lastUrl;
        to.url = nextUrl;
      }
      if (nextTitle !== lastTitle) {
        from.title = lastTitle;
        to.title = nextTitle;
      }

      context.evidence.events.push({
        type: 'page_changed',
        value: {
          from,
          to,
          mode: 'history',
          method,
        },
      });
      lastUrl = nextUrl;
      lastTitle = nextTitle;
    };

    if (historyObject && originalPushState) {
      historyObject.pushState = function patchedPushState(...args) {
        const result = originalPushState.apply(this, args);
        recordUrlChange('pushState');
        return result;
      };
      restoreTasks.push(() => {
        historyObject.pushState = originalPushState;
      });
    }

    if (historyObject && originalReplaceState) {
      historyObject.replaceState = function patchedReplaceState(...args) {
        const result = originalReplaceState.apply(this, args);
        recordUrlChange('replaceState');
        return result;
      };
      restoreTasks.push(() => {
        historyObject.replaceState = originalReplaceState;
      });
    }

    const handlePopState = () => {
      setTimeout(() => recordUrlChange('popstate'), 0);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', handlePopState);
      restoreTasks.push(() => window.removeEventListener('popstate', handlePopState));
    }

    if (clipboard && originalClipboardWriteText) {
      clipboard.writeText = function patchedWriteText(text: string) {
        context.evidence.events.push({
          type: 'clipboard_written',
          value: {
            method: 'writeText',
            textLength: String(text ?? '').length,
          },
        });
        return originalClipboardWriteText.call(this, text);
      };
      restoreTasks.push(() => {
        clipboard.writeText = originalClipboardWriteText;
      });
    }

    if (clipboard && originalClipboardWrite) {
      clipboard.write = function patchedWrite(data: ClipboardItem[]) {
        context.evidence.events.push({
          type: 'clipboard_written',
          value: {
            method: 'write',
            itemCount: Array.isArray(data) ? data.length : 0,
            types: Array.isArray(data)
              ? data.flatMap((item) => ('types' in item ? [...item.types] : []))
              : [],
          },
        });
        return originalClipboardWrite.call(this, data);
      };
      restoreTasks.push(() => {
        clipboard.write = originalClipboardWrite;
      });
    }

    return {
      finish() {
        const finalScrollPositions = collectScrollPositions();
        for (const [target, from] of initialScrollPositions) {
          const to = finalScrollPositions.get(target);
          if (!to) {
            continue;
          }

          const delta = {
            x: to.x - from.x,
            y: to.y - from.y,
          };
          if (delta.x === 0 && delta.y === 0) {
            continue;
          }

          context.evidence.events.push({
            type: 'scroll_changed',
            value: {
              target:
                typeof window !== 'undefined' && target === window
                  ? { kind: 'window' }
                  : target instanceof HTMLElement
                    ? describeScrollTarget(target)
                    : { kind: 'window' },
              from: roundedPoint(from.x, from.y),
              to: roundedPoint(to.x, to.y),
              delta: roundedPoint(delta.x, delta.y),
            },
          });
        }
      },
      restore() {
        for (const restore of restoreTasks.reverse()) {
          restore();
        }
      },
    };
  }

  function getRuntimeBridge<T extends (payload: RuntimeJsonObject) => unknown>(
    bridgeFunctionName: string | null,
  ): T | null {
    if (!bridgeFunctionName) {
      return null;
    }

    const candidate = (globalThis as typeof globalThis & Record<string, unknown>)[
      bridgeFunctionName
    ];
    return typeof candidate === 'function' ? (candidate as T) : null;
  }

  function getManagedKeyboardBridge(): ManagedKeyboardBridge | null {
    return getRuntimeBridge<ManagedKeyboardBridge>(managedKeyboardBridgeFunctionName);
  }

  function getManagedWindowBridge(): ManagedWindowBridge | null {
    return getRuntimeBridge<ManagedWindowBridge>(managedWindowBridgeFunctionName);
  }

  function getManagedBrowserBridge(): ManagedBrowserBridge | null {
    return getRuntimeBridge<ManagedBrowserBridge>(managedBrowserBridgeFunctionName);
  }

  function createScreenshotFileName(type: 'png' | 'jpeg'): string {
    const extension = type === 'jpeg' ? 'jpg' : 'png';
    const bytes = new Uint8Array(8);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    const id = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `s-${id}.${extension}`;
  }

  function joinArtifactPath(basePath: string, fileName: string): string {
    return `${basePath.replace(/[\\/]+$/, '')}/${fileName}`;
  }

  function createScreenshotArtifact(input: RuntimeScreenshotArtifactInput): RuntimeJsonObject {
    if (!screenshotArtifactBasePath) {
      return {
        data: input.data,
        mimeType: input.mimeType,
        type: input.type,
      };
    }

    const path = joinArtifactPath(
      screenshotArtifactBasePath,
      createScreenshotFileName(input.type),
    );
    context.screenshotArtifacts.push({
      kind: 'screenshot',
      path,
      data: input.data,
      mimeType: input.mimeType,
      type: input.type,
      encoding: 'base64',
    });
    return { path };
  }

  function isEditableElement(element: unknown) {
    const hasInputClass = typeof HTMLInputElement !== 'undefined';
    const hasTextareaClass = typeof HTMLTextAreaElement !== 'undefined';
    const hasHtmlElementClass = typeof HTMLElement !== 'undefined';
    const isInput = hasInputClass && element instanceof HTMLInputElement;
    const isTextarea = hasTextareaClass && element instanceof HTMLTextAreaElement;
    const isContentEditable =
      hasHtmlElementClass && element instanceof HTMLElement && element.isContentEditable;
    return (
      isInput ||
      isTextarea ||
      isContentEditable
    )
      ? true
      : false;
  }

  function describeKeyboardTarget(element: unknown): RuntimeJsonObject | null {
    if (!(element instanceof Element)) {
      return null;
    }

    const rect = element.getBoundingClientRect?.();
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      className: element instanceof HTMLElement ? element.className || '' : '',
      text: (element.textContent || '').trim().slice(0, 120),
      rect: rect
        ? {
            left: Number.isFinite(rect.left) ? rect.left : 0,
            top: Number.isFinite(rect.top) ? rect.top : 0,
            width: Number.isFinite(rect.width) ? rect.width : 0,
            height: Number.isFinite(rect.height) ? rect.height : 0,
          }
        : null,
    };
  }

  function describeKeyboardEvidenceTarget(element: unknown): RuntimeJsonObject | null {
    if (!(element instanceof Element)) {
      return null;
    }

    const target: RuntimeJsonObject = {
      tag: element.tagName.toLowerCase(),
    };

    if (element.id) {
      target.id = element.id;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.name) {
        target.name = element.name;
      }
      if (element.placeholder) {
        target.placeholder = element.placeholder;
      }
    }

    if (element instanceof HTMLInputElement && element.type) {
      target.type = element.type;
    }

    return target;
  }

  function enqueueManagedOperation(operation: () => Promise<void>) {
    const next = context.pendingAsyncOperations
      .catch(() => undefined)
      .then(async () => {
        await operation();
      });
    context.pendingAsyncOperations = next;
    return next;
  }

  async function typeIntoElement(element: unknown, value: unknown) {
    const bridgeFunction = getManagedKeyboardBridge();
    const text = String(value ?? '');
    if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) {
      throw new Error('Keyboard typing target must be an HTMLElement.');
    }

    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();

    if (!bridgeFunction || !isEditableElement(element)) {
      if (
        (typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement) ||
        (typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement)
      ) {
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      if (element.isContentEditable) {
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      throw new Error('Typing target is not editable.');
    }

    context.evidence.events.push({
      type: 'managed_type',
      value: {
        target: describeKeyboardEvidenceTarget(element),
        length: text.length,
      },
    });
    await enqueueManagedOperation(async () => {
      await Promise.resolve(
        bridgeFunction({
          action: 'insertText',
          text,
          replaceExistingText: true,
          debug: {
            target: describeKeyboardTarget(element),
          },
        }),
      );
    });
  }

  function installManagedKeyboardDispatchHook() {
    const bridgeFunction = getManagedKeyboardBridge();
    if (!bridgeFunction || typeof EventTarget === 'undefined') {
      return () => {};
    }

    const prototype = EventTarget.prototype;
    const originalDispatchEvent = prototype.dispatchEvent;
    prototype.dispatchEvent = function managedKeyboardDispatch(event) {
      if (!(event instanceof KeyboardEvent) || event.isTrusted) {
        return originalDispatchEvent.call(this, event);
      }

      const eventTarget =
        this instanceof Window
          ? document.activeElement
          : this instanceof Document
            ? this.activeElement
            : this;
      const isGlobalShortcutDispatch = this instanceof Window || this instanceof Document;
      if (!isEditableElement(eventTarget) && !isGlobalShortcutDispatch) {
        return originalDispatchEvent.call(this, event);
      }

      const keyboardEventType =
        event.type === 'keypress'
          ? 'char'
          : event.type === 'keyup'
            ? 'keyUp'
            : 'rawKeyDown';
      context.evidence.events.push({
        type: 'managed_keyboard_event',
        value: {
          eventType: event.type,
          key: event.key || '',
          scope: isGlobalShortcutDispatch && !isEditableElement(eventTarget) ? 'global' : 'editable',
        },
      });
      void enqueueManagedOperation(async () => {
        await Promise.resolve(
          bridgeFunction({
            action: 'dispatchEvent',
            eventType: keyboardEventType,
            key: event.key,
            code: event.code,
            keyCode: event.keyCode,
            which: event.which,
            location: event.location,
            repeat: event.repeat,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            debug: {
              target: describeKeyboardTarget(eventTarget),
              scope:
                isGlobalShortcutDispatch && !isEditableElement(eventTarget)
                  ? 'global'
                  : 'editable',
            },
          }),
        );
      });
      return true;
    };

    return () => {
      prototype.dispatchEvent = originalDispatchEvent;
    };
  }

  function installManagedWindowCloseHook() {
    const bridgeFunction = getManagedWindowBridge();
    if (!bridgeFunction || typeof window === 'undefined') {
      return () => {};
    }

    const runtimeGlobal = globalThis as typeof globalThis & {
      close?: (...args: unknown[]) => void;
    };
    const originalClose = runtimeGlobal.close;
    runtimeGlobal.close = function managedWindowClose(...args: unknown[]) {
      context.evidence.events.push({
        type: 'managed_window_close',
        value: {
          url: globalThis.location?.href,
          title: globalThis.document?.title,
        },
      });
      void enqueueManagedOperation(async () => {
        await Promise.resolve(
          bridgeFunction({
            action: 'close',
            debug: {
              url: globalThis.location?.href,
              title: globalThis.document?.title,
            },
          }),
        );
      });
      return undefined;
    };

    return () => {
      if (originalClose) {
        runtimeGlobal.close = originalClose;
      } else {
        Reflect.deleteProperty(runtimeGlobal, 'close');
      }
    };
  }

  function createApi(page: ScriptPlaywrightPage): RuntimeApi {
    return {
      get(scriptId: string) {
        const nested = context.registry.get(scriptId);
        if (!nested) {
          throw new Error(`Script ${scriptId} was not found.`);
        }
        return toSchemaSummary(nested);
      },
      list() {
        return [...context.registry.values()].map((nested) => toSchemaSummary(nested));
      },
      async call(scriptId: string, nestedInput: RuntimeJsonObject = {}) {
        return await executeScriptById(scriptId, nestedInput, true);
      },
      page,
      async typeIntoElement(element: unknown, value: unknown) {
        await typeIntoElement(element, value);
      },
      async waitForManagedInput() {
        await context.pendingAsyncOperations;
      },
    };
  }

  async function runScriptCode(
    item: RuntimeScript,
    candidateInput: RuntimeJsonObject,
  ): Promise<RuntimeJsonObject> {
    const validation = validateInputAgainstSchema(candidateInput, item.inputSchema);
    if (!validation.ok) {
      throw new Error(
        `Script input validation failed for ${item.id}: ${validation.errors.join(' ')}`,
      );
    }

    const page = createPlaywrightPageApi({
      wait,
      typeIntoElement,
      isEditableElement,
      useDomKeyboardFallback: () => !getManagedKeyboardBridge(),
      browserCommand: async (method, params = {}) => {
        const bridgeFunction = getManagedBrowserBridge();
        if (!bridgeFunction) {
          throw new Error('Browser-level Playwright API requires the debugger CDP bridge.');
        }
        return await Promise.resolve(bridgeFunction({ action: 'command', method, params }));
      },
      browserEvent: async (method, params = {}, timeoutMs) => {
        const bridgeFunction = getManagedBrowserBridge();
        if (!bridgeFunction) {
          throw new Error('Browser-level Playwright API requires the debugger CDP bridge.');
        }
        return await Promise.resolve(bridgeFunction({ action: 'waitForEvent', method, params, timeoutMs }));
      },
      createScreenshotArtifact,
      recordEvidenceEvent: (type, value) => {
        context.evidence.events.push({ type, value });
      },
      waitForManagedInput: async () => {
        await context.pendingAsyncOperations;
      },
    });
    const cap = createApi(page);
    const scriptFunction = scriptFactories[item.id];
    if (typeof scriptFunction !== 'function') {
      throw new Error(
        `Script ${item.id} script must evaluate to a function. Use export default async function (...) { ... }.`,
      );
    }

    const runtimeGlobal = globalThis as typeof globalThis & { cap?: RuntimeApi; page?: ScriptPlaywrightPage };
    const previousCap = runtimeGlobal.cap;
    const previousPage = runtimeGlobal.page;
    runtimeGlobal.cap = cap;
    runtimeGlobal.page = page;
    const visibleElementsStartedAt = collectVisibleElements ? Date.now() : 0;
    const beforeSnapshotStartedAt = collectVisibleElements ? Date.now() : 0;
    const beforeVisibleElements = collectVisibleElements
      ? context.visibleElementsTracker.snapshot()
      : undefined;
    const beforeSnapshotTimingMs = collectVisibleElements
      ? Date.now() - beforeSnapshotStartedAt
      : 0;
    if (collectVisibleElements) {
      context.visibleElementsTracker.start();
    }

    let result;
    let scriptTimingMs = 0;
    const scriptEventStartIndex = context.evidence.events.length;
    try {
      const scriptStartedAt = Date.now();
      result = await Promise.resolve(scriptFunction(candidateInput));
      await context.pendingAsyncOperations;
      scriptTimingMs = Date.now() - scriptStartedAt;
    } finally {
      if (previousCap === undefined) {
        delete runtimeGlobal.cap;
      } else {
        runtimeGlobal.cap = previousCap;
      }
      if (previousPage === undefined) {
        delete runtimeGlobal.page;
      } else {
        runtimeGlobal.page = previousPage;
      }
    }

    let postActionDelayMs = 0;
    if (
      collectVisibleElements &&
      typeof document !== 'undefined' &&
      hasPostActionEventSince(scriptEventStartIndex)
    ) {
      const postActionDelayStartedAt = Date.now();
      await wait(POST_ACTION_VISIBLE_DIFF_DELAY_MS);
      postActionDelayMs = Date.now() - postActionDelayStartedAt;
    }
    if (collectVisibleElements) {
      const visibleElementChanges = context.visibleElementsTracker.stop();
      const afterSnapshotStartedAt = Date.now();
      const afterVisibleElements =
        context.visibleElementsTracker.snapshotForChanges(visibleElementChanges);
      const afterSnapshotTimingMs = Date.now() - afterSnapshotStartedAt;
      const diffStartedAt = Date.now();
      const visibleElementsDiff = context.visibleElementsTracker.diff(
        beforeVisibleElements,
        afterVisibleElements,
        visibleElementChanges,
      );
      const diffTimingMs = Date.now() - diffStartedAt;
      context.evidence.visibleElements = visibleElementsDiff;
      context.evidence.visibleElementsTimingMs = Date.now() - visibleElementsStartedAt;
      context.evidence.visibleElementsDebugTiming = {
        scriptTimingMs,
        beforeSnapshotTimingMs,
        postActionDelayMs,
        afterSnapshotTimingMs,
        diffTimingMs,
      };
    }

    const output = normalizeResult(result);
    const outputValidation = validateInputAgainstSchema(output, item.outputSchema);
    if (!outputValidation.ok) {
      throw new Error(
        `Script output validation failed for ${item.id}: ${outputValidation.errors.join(' ')}`,
      );
    }

    return output;
  }

  async function executeScriptById(
    scriptId: string,
    candidateInput: RuntimeJsonObject,
    recordCall = false,
  ): Promise<RuntimeJsonObject> {
    const item = context.registry.get(scriptId);
    if (!item) {
      throw new Error(`Script ${scriptId} was not found.`);
    }

    if (context.callStack.length >= 12) {
      throw new Error('Script call depth exceeded 12.');
    }

    if (context.callStack.includes(scriptId)) {
      throw new Error(`Script recursion detected for ${scriptId}.`);
    }

    context.callStack.push(scriptId);
    try {
      const result = await Promise.race([
        runScriptCode(item, candidateInput),
        new Promise<RuntimeJsonObject>((resolve) => {
          setTimeout(
            () => {
              const message = `Script ${item.id} timed out after ${item.script.timeoutMs}ms.`;
              if (collectEvents) {
                context.evidence.events.push({
                  type: 'execution_interrupted_by_timeout',
                  value: {
                    scriptId: item.id,
                    timeoutMs: item.script.timeoutMs,
                    message,
                  },
                });
              }
              resolve({
                interrupted: true,
                reason: 'timeout',
                message,
              });
            },
            item.script.timeoutMs,
          );
        }),
      ]);
      if (recordCall) {
        context.evidence.events.push({
          type: 'script_call',
          value: {
            scriptId,
            result,
          },
        });
      }
      Object.assign(context.state, result);
      return result;
    } finally {
      context.callStack.pop();
    }
  }

  return (async () => {
    const pageSideEffects = installPageSideEffectTracking();
    const restoreClickHook = installManagedClickHook(
      context.evidence,
      context,
      managedClickBridgeFunctionName,
      wait,
    );
    const restoreKeyboardHook = installManagedKeyboardDispatchHook();
    const restoreWindowCloseHook = installManagedWindowCloseHook();
    try {
      const result = await executeScriptById(scriptDefinition.id, input);
      pageSideEffects.finish();
      const interrupted = Boolean((result as { interrupted?: unknown }).interrupted);
      return {
        ok: true,
        status: interrupted ? 'interrupted' : 'succeeded',
        result,
        evidence: buildResponseEvidence(),
        screenshotArtifacts: context.screenshotArtifacts,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        evidence: buildResponseEvidence(),
      };
    } finally {
      restoreWindowCloseHook();
      restoreKeyboardHook();
      restoreClickHook();
      pageSideEffects.restore();
    }
  })();
}
