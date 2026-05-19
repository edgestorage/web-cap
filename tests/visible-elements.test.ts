import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureVisibleElementsDiff } from '../extension/runtime/injected/visible-elements.injected';

type FakeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

class FakeText {
  parentNode: FakeElement | null = null;
  childNodes: unknown[] = [];

  constructor(private value: string) {}

  get textContent() {
    return this.value;
  }

  set textContent(value: string) {
    this.value = value;
  }
}

class FakeElement {
  parentNode: FakeElement | null = null;
  hidden = false;
  attributes = new Map<string, string>();
  style = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
  };
  childNodes: Array<FakeElement | FakeText> = [];

  constructor(
    readonly tagName: string,
    public id = '',
    public className = '',
    private rect: FakeRect = { left: 0, top: 0, width: 80, height: 20 },
  ) {}

  get parentElement() {
    return this.parentNode;
  }

  get children() {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent || '').join('');
  }

  set textContent(value: string) {
    this.childNodes = [new FakeText(value)];
    this.childNodes[0].parentNode = this;
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeElement | FakeText>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  getAttribute(name: string) {
    if (name === 'id') {
      return this.id || null;
    }
    if (name === 'class') {
      return this.className || null;
    }
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }
}

type FakeMutationRecord = {
  type: 'childList' | 'characterData' | 'attributes';
  target: FakeElement | FakeText;
  attributeName?: string;
};

class FakeMutationObserver {
  static current: FakeMutationObserver | null = null;
  static lastObserveOptions: unknown = null;

  constructor(private callback: (records: FakeMutationRecord[]) => void) {}

  observe(_target: unknown, options?: unknown) {
    FakeMutationObserver.current = this;
    FakeMutationObserver.lastObserveOptions = options ?? null;
  }

  disconnect() {
    if (FakeMutationObserver.current === this) {
      FakeMutationObserver.current = null;
    }
  }

  emit(records: FakeMutationRecord[]) {
    this.callback(records);
  }
}

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
const previousGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');

function installFakeDom(body: FakeElement) {
  Object.defineProperty(globalThis, 'document', {
    value: { body },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    value: FakeElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'MutationObserver', {
    value: FakeMutationObserver,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    value: (element: FakeElement) => element.style,
    configurable: true,
  });
}

function diffWithFakeSnapshots(
  tracker: ReturnType<typeof captureVisibleElementsDiff>,
  before: unknown,
  after: unknown,
  changes: unknown[],
) {
  return (tracker.diff as (before: unknown, after: unknown, changes: unknown[]) => {
    added: unknown[];
    removed: unknown[];
    updated: unknown[];
    truncated: boolean;
  })(before, after, changes);
}

function restoreGlobal(name: 'document' | 'HTMLElement' | 'MutationObserver' | 'getComputedStyle', descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

describe('visible elements diff', () => {
  beforeEach(() => {
    FakeMutationObserver.current = null;
    FakeMutationObserver.lastObserveOptions = null;
  });

  afterEach(() => {
    restoreGlobal('document', previousDocument);
    restoreGlobal('HTMLElement', previousHTMLElement);
    restoreGlobal('MutationObserver', previousMutationObserver);
    restoreGlobal('getComputedStyle', previousGetComputedStyle);
    FakeMutationObserver.current = null;
    FakeMutationObserver.lastObserveOptions = null;
  });

  it('reports visible structure added under a previously empty container', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const list = body.appendChild(
      new FakeElement('div', 'list', '', { left: 0, top: 0, width: 0, height: 0 }),
    );
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    const button = list.appendChild(new FakeElement('button'));
    button.textContent = 'Create';
    FakeMutationObserver.current?.emit([{ type: 'childList', target: list }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toMatchObject([{ tag: 'div', id: 'list', text: 'Create' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
  });

  it('reports visible structure removed from a container', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const list = body.appendChild(
      new FakeElement('div', 'list', '', { left: 0, top: 0, width: 0, height: 0 }),
    );
    const button = list.appendChild(new FakeElement('button'));
    button.textContent = 'Delete';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    list.removeChild(button);
    FakeMutationObserver.current?.emit([{ type: 'childList', target: list }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toMatchObject([{ tag: 'div', id: 'list', text: 'Delete' }]);
    expect(diff.updated).toEqual([]);
  });

  it('reports visible text updates from observed character data mutations', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const button = body.appendChild(new FakeElement('button'));
    const label = button.appendChild(new FakeElement('span', '', '', { left: 0, top: 0, width: 60, height: 20 }));
    const text = label.appendChild(new FakeText('Save'));
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    text.textContent = 'Saved';
    FakeMutationObserver.current?.emit([{ type: 'characterData', target: text }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toMatchObject([
      {
        before: { tag: 'button', text: 'Save' },
        after: { tag: 'button', text: 'Saved' },
      },
    ]);
  });

  it('reports elements added when a visibility attribute makes them visible', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const button = body.appendChild(new FakeElement('button'));
    button.textContent = 'Publish';
    button.style.display = 'none';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    button.style.display = 'block';
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: button, attributeName: 'style' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toMatchObject([{ tag: 'button', text: 'Publish' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
  });

  it('reports elements removed when a visibility attribute hides them', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const button = body.appendChild(new FakeElement('button'));
    button.textContent = 'Archive';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    button.hidden = true;
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: button, attributeName: 'hidden' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toMatchObject([{ tag: 'button', text: 'Archive' }]);
    expect(diff.updated).toEqual([]);
  });

  it('reports visible descendants removed when a parent container becomes hidden', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const panel = body.appendChild(
      new FakeElement('section', 'panel', '', { left: 0, top: 0, width: 0, height: 0 }),
    );
    const button = panel.appendChild(new FakeElement('button'));
    button.textContent = 'Close panel';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    panel.style.display = 'none';
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: panel, attributeName: 'style' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toMatchObject([{ tag: 'section', id: 'panel', text: 'Close panel' }]);
    expect(diff.updated).toEqual([]);
  });

  it('reports visible descendants added when a parent container becomes visible', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const panel = body.appendChild(
      new FakeElement('section', 'panel', '', { left: 0, top: 0, width: 0, height: 0 }),
    );
    const button = panel.appendChild(new FakeElement('button'));
    button.textContent = 'Open panel';
    panel.style.display = 'none';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    panel.style.display = 'block';
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: panel, attributeName: 'style' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toMatchObject([{ tag: 'section', id: 'panel', text: 'Open panel' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
  });

  it('reports key attribute changes as remove and add events', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const link = body.appendChild(new FakeElement('a'));
    link.textContent = 'Docs';
    link.setAttribute('href', '/old');
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    link.setAttribute('href', '/new');
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: link, attributeName: 'href' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toMatchObject([{ tag: 'a', text: 'Docs' }]);
    expect(diff.removed).toMatchObject([{ tag: 'a', text: 'Docs' }]);
    expect(diff.updated).toEqual([]);
    expect(String((diff.added[0] as { key: string }).key)).toContain('href=/new');
    expect(String((diff.removed[0] as { key: string }).key)).toContain('href=/old');
  });

  it('does not report form value attribute changes as visible element updates', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const input = body.appendChild(new FakeElement('input'));
    input.setAttribute('value', 'before');
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    input.setAttribute('value', 'after');
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: input, attributeName: 'value' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();

    expect(diffWithFakeSnapshots(tracker, before, after, changes)).toEqual({
      added: [],
      removed: [],
      updated: [],
      truncated: false,
    });
  });

  it('ignores non-semantic data attribute mutations', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const button = body.appendChild(new FakeElement('button'));
    button.textContent = 'Idle';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    button.setAttribute('data-testid', 'save-button');
    FakeMutationObserver.current?.emit([{ type: 'attributes', target: button, attributeName: 'data-testid' }]);

    const changes = tracker.stop();
    const after = tracker.snapshot();

    expect(diffWithFakeSnapshots(tracker, before, after, changes)).toEqual({
      added: [],
      removed: [],
      updated: [],
      truncated: false,
    });
  });

  it('observes only attributes that can affect visible element evidence', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    tracker.start();

    expect(FakeMutationObserver.lastObserveOptions).toMatchObject({
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'open',
        'src',
        'href',
        'value',
        'checked',
        'selected',
        'aria-hidden',
      ],
    });
  });

  it('merges many sibling additions into one group entry', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const list = body.appendChild(
      new FakeElement('div', 'list', '', { left: 0, top: 0, width: 0, height: 0 }),
    );
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();

    for (let index = 0; index < 4; index += 1) {
      const item = list.appendChild(new FakeElement('button', '', '', { left: 0, top: index * 24, width: 80, height: 20 }));
      item.textContent = `Item ${index + 1}`;
      FakeMutationObserver.current?.emit([{ type: 'childList', target: item }]);
    }

    const changes = tracker.stop();
    const after = tracker.snapshot();
    const diff = diffWithFakeSnapshots(tracker, before, after, changes);

    expect(diff.added).toMatchObject([
      {
        tag: 'group',
        merged: true,
        text: 'Item 1 | Item 2 | Item 3 | Item 4',
      },
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.updated).toEqual([]);
  });

  it('returns an empty diff when no relevant mutation was recorded', () => {
    const body = new FakeElement('body', '', '', { left: 0, top: 0, width: 0, height: 0 });
    const button = body.appendChild(new FakeElement('button'));
    button.textContent = 'Idle';
    installFakeDom(body);

    const tracker = captureVisibleElementsDiff();
    const before = tracker.snapshot();
    tracker.start();
    const changes = tracker.stop();
    const after = tracker.snapshot();

    expect(diffWithFakeSnapshots(tracker, before, after, changes)).toEqual({
      added: [],
      removed: [],
      updated: [],
      truncated: false,
    });
  });
});
