import { afterEach, describe, expect, it } from 'vitest';
import { createLocator } from '../extension/runtime/injected/playwright-locator.injected';

class FakeElement {
  clickCount = 0;
  focusOptions: FocusOptions | undefined;
  scrollCount = 0;
  textContent = '';
  tagName = 'BUTTON';
  hidden = false;
  rect = {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    width: 80,
    height: 30,
    right: 90,
    bottom: 50,
  };
  ownerDocument = {
    defaultView: {
      innerWidth: 400,
      innerHeight: 300,
    },
  };

  click() {
    this.clickCount += 1;
  }

  scrollIntoView() {
    this.scrollCount += 1;
  }

  focus(options?: FocusOptions) {
    this.focusOptions = options;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

describe('playwright locator shim', () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousGetComputedStyle = globalThis.getComputedStyle;

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).HTMLElement = previousHTMLElement;
    globalThis.getComputedStyle = previousGetComputedStyle;
  });

  it('does not scroll before clicking an already visible element', async () => {
    (globalThis as unknown as Record<string, unknown>).HTMLElement = FakeElement;
    globalThis.getComputedStyle = () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }) as CSSStyleDeclaration;

    const element = new FakeElement();
    const locator = createLocator(
      () => [element as unknown as Element],
      'button',
      {} as never,
      {
        wait: async () => {},
        waitForManagedInput: async () => {},
      } as never,
    );

    await locator.click();

    expect(element.clickCount).toBe(1);
    expect(element.scrollCount).toBe(0);
  });

  it('scrolls into view only when the element is outside the viewport', async () => {
    (globalThis as unknown as Record<string, unknown>).HTMLElement = FakeElement;
    globalThis.getComputedStyle = () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }) as CSSStyleDeclaration;

    const element = new FakeElement();
    const locator = createLocator(
      () => [element as unknown as Element],
      'button',
      {} as never,
      {
        wait: async () => {},
        waitForManagedInput: async () => {},
      } as never,
    );

    await locator.scrollIntoViewIfNeeded();
    expect(element.scrollCount).toBe(0);

    element.rect = {
      x: 10,
      y: 9000,
      left: 10,
      top: 9000,
      width: 80,
      height: 30,
      right: 90,
      bottom: 9030,
    };

    await locator.scrollIntoViewIfNeeded();
    expect(element.scrollCount).toBe(1);
  });

  it('focuses without scrolling', async () => {
    (globalThis as unknown as Record<string, unknown>).HTMLElement = FakeElement;
    globalThis.getComputedStyle = () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    }) as CSSStyleDeclaration;

    const element = new FakeElement();
    const locator = createLocator(
      () => [element as unknown as Element],
      'button',
      {} as never,
      {
        wait: async () => {},
        waitForManagedInput: async () => {},
      } as never,
    );

    await locator.focus();

    expect(element.focusOptions).toEqual({ preventScroll: true });
  });
});
