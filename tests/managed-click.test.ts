import { afterEach, describe, expect, it, vi } from 'vitest';
import { installManagedClickHook } from '../extension/runtime/injected/managed-click.injected';

class FakeEventTarget {
  dispatchEvent(_event: Event) {
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  ownerDocument: FakeDocument | null = null;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  childNodes: FakeElement[] = [];
  attributes = new Map<string, string>();
  style = {
    setProperty(_property: string, _value: string, _priority?: string) {},
  };
  hidden = false;
  id = '';
  className = '';
  textContent = '';
  tagName = 'DIV';
  isConnected = true;
  tabIndex = 0;
  rect = {
    left: 20,
    top: 30,
    width: 100,
    height: 60,
    right: 120,
    bottom: 90,
  };

  contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  closest(_selector: string) {
    return null;
  }

  focus() {}

  click() {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === 'id') {
      this.id = value;
    }
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
    this.childNodes.push(...children);
    children.forEach((child) => {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
    });
  }

  appendChild(child: FakeElement) {
    this.append(child);
    return child;
  }

  attachShadow(_options: { mode: string }) {
    return {
      querySelector: (_selector: string) => null,
      replaceChildren: (..._children: FakeElement[]) => {},
    };
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  body: FakeElement;
  documentElement: FakeElement;
  target: FakeElement;
  defaultView: {
    innerWidth: number;
    innerHeight: number;
    getComputedStyle: (_element: FakeElement) => Record<string, string>;
  };

  constructor(target: FakeElement, body: FakeElement) {
    this.target = target;
    this.body = body;
    this.documentElement = body;
    this.defaultView = {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle: () => ({
        display: 'block',
        visibility: 'visible',
        pointerEvents: 'auto',
        opacity: '1',
        overflow: 'visible',
        overflowX: 'visible',
        overflowY: 'visible',
      }),
    };
  }

  elementFromPoint(x: number, y: number) {
    return x >= 20 && x <= 120 && y >= 30 && y <= 90 ? this.target : this.body;
  }

  createElement(_tagName: string) {
    const element = new FakeElement();
    element.ownerDocument = this;
    return element;
  }

  createElementNS(_namespace: string, tagName: string) {
    const element = new FakeElement();
    element.tagName = tagName.toUpperCase();
    element.ownerDocument = this;
    return element;
  }
}

describe('managed click hook', () => {
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousEventTarget = globalThis.EventTarget;
  const previousMouseEvent = globalThis.MouseEvent;
  const previousWindow = globalThis.Window;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const mutableGlobal = globalThis as unknown as Record<string, unknown>;

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as typeof globalThis & { Element?: unknown }).Element = previousElement;
    (globalThis as typeof globalThis & { HTMLElement?: unknown }).HTMLElement = previousHTMLElement;
    (globalThis as typeof globalThis & { EventTarget?: unknown }).EventTarget = previousEventTarget;
    (globalThis as typeof globalThis & { MouseEvent?: unknown }).MouseEvent = previousMouseEvent;
    (globalThis as typeof globalThis & { Window?: unknown }).Window = previousWindow;
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', previousDocument);
    } else {
      delete mutableGlobal.document;
    }
    delete (globalThis as typeof globalThis & { __managedClickBridge?: unknown }).__managedClickBridge;
  });

  it('uses a random offset point only after the offset still hit-tests to the target', async () => {
    mutableGlobal.Element = FakeElement;
    mutableGlobal.HTMLElement = FakeElement;
    mutableGlobal.EventTarget = FakeEventTarget;
    mutableGlobal.Window = class {};

    const body = new FakeElement();
    body.tagName = 'BODY';
    const button = new FakeElement();
    button.tagName = 'BUTTON';
    body.children = [button];
    body.childNodes = [button];

    const document = new FakeDocument(button, body);
    body.ownerDocument = document;
    button.ownerDocument = document;
    button.parentElement = body;
    Object.defineProperty(globalThis, 'document', {
      value: document,
      configurable: true,
    });

    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    random.mockReturnValueOnce(0.75).mockReturnValueOnce(0.25);

    const bridgePayloads: Array<{ clientX: number; clientY: number }> = [];
    (globalThis as typeof globalThis & { __managedClickBridge?: unknown }).__managedClickBridge =
      (payload: { clientX: number; clientY: number }) => {
        bridgePayloads.push(payload);
      };

    const evidence = { events: [] };
    const context = { pendingAsyncOperations: Promise.resolve() };
    const restore = installManagedClickHook(evidence, context, '__managedClickBridge', async () => {});

    button.click();
    await context.pendingAsyncOperations;
    restore();

    expect(bridgePayloads).toMatchObject([{ clientX: 75, clientY: 57 }]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        type: 'managed_click',
        value: expect.objectContaining({
          point: { x: 75, y: 57 },
        }),
      }),
    );
  });

  it('accepts same-text mirrored hit targets for hidden click proxy elements', async () => {
    mutableGlobal.Element = FakeElement;
    mutableGlobal.HTMLElement = FakeElement;
    mutableGlobal.EventTarget = FakeEventTarget;
    mutableGlobal.Window = class {};

    const body = new FakeElement();
    body.tagName = 'BODY';
    const proxy = new FakeElement();
    proxy.tagName = 'DIV';
    proxy.textContent = '最多点赞';
    const visibleMirror = new FakeElement();
    visibleMirror.tagName = 'DIV';
    visibleMirror.textContent = '最多点赞';
    const visibleMirrorLabel = new FakeElement();
    visibleMirrorLabel.tagName = 'SPAN';
    visibleMirrorLabel.textContent = '最多点赞';
    visibleMirrorLabel.rect = {
      left: 36,
      top: 41,
      width: 64,
      height: 19,
      right: 100,
      bottom: 60,
    };
    visibleMirror.append(visibleMirrorLabel);
    body.children = [proxy, visibleMirror];
    body.childNodes = [proxy, visibleMirror];

    const document = new FakeDocument(visibleMirrorLabel, body);
    body.ownerDocument = document;
    proxy.ownerDocument = document;
    proxy.parentElement = body;
    visibleMirror.ownerDocument = document;
    visibleMirror.parentElement = body;
    visibleMirrorLabel.ownerDocument = document;
    Object.defineProperty(globalThis, 'document', {
      value: document,
      configurable: true,
    });

    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const bridgePayloads: Array<{ clientX: number; clientY: number }> = [];
    (globalThis as typeof globalThis & { __managedClickBridge?: unknown }).__managedClickBridge =
      (payload: { clientX: number; clientY: number }) => {
        bridgePayloads.push(payload);
      };

    const evidence = { events: [] };
    const context = { pendingAsyncOperations: Promise.resolve() };
    const restore = installManagedClickHook(evidence, context, '__managedClickBridge', async () => {});

    proxy.click();
    await context.pendingAsyncOperations;
    restore();

    expect(bridgePayloads).toMatchObject([{ clientX: 70, clientY: 60 }]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        type: 'managed_click',
        value: expect.objectContaining({
          point: { x: 70, y: 60 },
          target: expect.objectContaining({
            text: '最多点赞',
          }),
          containsOriginal: false,
        }),
      }),
    );
  });

  it('routes synthetic mousedown as a browser-level down action', async () => {
    mutableGlobal.Element = FakeElement;
    mutableGlobal.HTMLElement = FakeElement;
    mutableGlobal.EventTarget = FakeEventTarget;
    mutableGlobal.Window = class {};
    mutableGlobal.MouseEvent = class FakeMouseEvent extends Event {
      clientX = 70;
      clientY = 60;
      isTrusted = false;

      constructor(type: string) {
        super(type);
      }
    };

    const body = new FakeElement();
    body.tagName = 'BODY';
    const button = new FakeElement();
    button.tagName = 'BUTTON';
    body.children = [button];
    body.childNodes = [button];

    const document = new FakeDocument(button, body);
    body.ownerDocument = document;
    button.ownerDocument = document;
    button.parentElement = body;
    Object.defineProperty(globalThis, 'document', {
      value: document,
      configurable: true,
    });

    const bridgePayloads: Array<{ action?: string; clientX: number; clientY: number }> = [];
    (globalThis as typeof globalThis & { __managedClickBridge?: unknown }).__managedClickBridge =
      (payload: { action?: string; clientX: number; clientY: number }) => {
        bridgePayloads.push(payload);
      };

    const evidence = { events: [] };
    const context = { pendingAsyncOperations: Promise.resolve() };
    const restore = installManagedClickHook(evidence, context, '__managedClickBridge', async () => {});

    button.dispatchEvent(new MouseEvent('mousedown'));
    await context.pendingAsyncOperations;
    restore();

    expect(bridgePayloads).toMatchObject([{ action: 'down', clientX: 70, clientY: 60 }]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        type: 'managed_mouse',
        value: expect.objectContaining({
          action: 'down',
        }),
      }),
    );
  });

  it('awaits managed mousemove automation in background pages', async () => {
    mutableGlobal.Element = FakeElement;
    mutableGlobal.HTMLElement = FakeElement;
    mutableGlobal.EventTarget = FakeEventTarget;
    mutableGlobal.Window = class {};
    mutableGlobal.MouseEvent = class FakeMouseEvent extends Event {
      clientX = 70;
      clientY = 60;
      isTrusted = false;

      constructor(type: string) {
        super(type);
      }
    };

    const body = new FakeElement();
    body.tagName = 'BODY';
    const button = new FakeElement();
    button.tagName = 'BUTTON';
    body.children = [button];
    body.childNodes = [button];

    const document = new FakeDocument(button, body) as FakeDocument & {
      hidden?: boolean;
      visibilityState?: string;
    };
    document.hidden = true;
    document.visibilityState = 'hidden';
    body.ownerDocument = document;
    button.ownerDocument = document;
    button.parentElement = body;
    Object.defineProperty(globalThis, 'document', {
      value: document,
      configurable: true,
    });

    const bridgePayloads: Array<{ action?: string; clientX: number; clientY: number }> = [];
    let bridgeResolved = false;
    let resolveBridge: (() => void) | undefined;
    (globalThis as typeof globalThis & { __managedClickBridge?: unknown }).__managedClickBridge =
      (payload: { action?: string; clientX: number; clientY: number }) => {
        bridgePayloads.push(payload);
        return new Promise<void>((resolve) => {
          resolveBridge = () => {
            bridgeResolved = true;
            resolve();
          };
        });
      };

    const evidence = { events: [] };
    const context = { pendingAsyncOperations: Promise.resolve() };
    let waitCalls = 0;
    const restore = installManagedClickHook(evidence, context, '__managedClickBridge', async () => {
      waitCalls += 1;
    });

    button.dispatchEvent(new MouseEvent('mousemove'));
    await Promise.resolve();
    await Promise.resolve();
    const completedBeforeBridge = await Promise.race([
      context.pendingAsyncOperations.then(
        () => true,
        () => 'rejected' as const,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(resolveBridge).toBeTypeOf('function');
    resolveBridge?.();
    await context.pendingAsyncOperations;
    restore();

    expect(completedBeforeBridge).toBe(false);
    expect(bridgeResolved).toBe(true);
    expect(waitCalls).toBe(15);
    expect(bridgePayloads).toMatchObject([{ action: 'move', clientX: 70, clientY: 60 }]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        type: 'managed_mouse',
        value: expect.objectContaining({
          action: 'move',
          point: { x: 70, y: 60 },
        }),
      }),
    );
  });
});
