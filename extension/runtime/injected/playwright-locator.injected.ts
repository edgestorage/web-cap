/* eslint-disable */
import type { LocatorQuery, PlaywrightShimDeps, RuntimeMethodTable, ScriptPlaywrightLocator, ScriptPlaywrightPage } from './playwright-shim-types.injected';
import { accessibleName, cssEscape, hideHighlightOverlay, implicitRole, isVisibleElement, notImplemented, pressKeyOnElement, queryLocatorSelectorAll, showHighlightOverlay, smallestTextMatches, textMatches, timeoutFromOptions, waitForLocator } from './playwright-shim-helpers.injected';

const PLAYWRIGHT_LOCATOR_METHODS = [
  'elementHandle',
  'highlight',
  'toString',
  'all',
  'allInnerTexts',
  'allTextContents',
  'and',
  'ariaSnapshot',
  'blur',
  'boundingBox',
  'check',
  'clear',
  'click',
  'contentFrame',
  'count',
  'dblclick',
  'describe',
  'description',
  'dispatchEvent',
  'dragTo',
  'drop',
  'elementHandles',
  'fill',
  'filter',
  'first',
  'focus',
  'frameLocator',
  'getAttribute',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'hideHighlight',
  'hover',
  'innerHTML',
  'innerText',
  'inputValue',
  'isChecked',
  'isDisabled',
  'isEditable',
  'isEnabled',
  'isHidden',
  'isVisible',
  'last',
  'locator',
  'normalize',
  'nth',
  'or',
  'page',
  'press',
  'pressSequentially',
  'screenshot',
  'scrollIntoViewIfNeeded',
  'selectOption',
  'selectText',
  'setChecked',
  'setInputFiles',
  'tap',
  'textContent',
  'type',
  'uncheck',
  'waitFor',
];


export function createLocator(
  query: LocatorQuery,
  label: string,
  pageApi: ScriptPlaywrightPage,
  deps: PlaywrightShimDeps,
): ScriptPlaywrightLocator {
  const elementCenter = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  };
  const requireElement = async (options?: { timeout?: number; state?: 'attached' | 'visible' }) => {
    const element = await waitForLocator(query, label, deps.wait, {
      timeout: timeoutFromOptions(options),
      state: options?.state ?? 'visible',
    });
    if (!element) {
      throw new Error(`Locator ${label} did not resolve to an element.`);
    }
    return element;
  };

  const implementation: ScriptPlaywrightLocator = {
    __query: query,
    __description: '',
    async evaluate(pageFunction: unknown, arg?: unknown, options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      if (typeof pageFunction === 'function') {
        return await Promise.resolve(pageFunction(element, arg));
      }
      if (typeof pageFunction === 'string') {
        return (0, eval)(pageFunction);
      }
      throw new Error('locator.evaluate requires a function or string expression.');
    },
    async evaluateAll(pageFunction: unknown, arg?: unknown) {
      if (typeof pageFunction !== 'function') {
        throw new Error('locator.evaluateAll requires a function.');
      }
      return await Promise.resolve(pageFunction(query(), arg));
    },
    async all() {
      return query().map((_, index) => createLocator(() => query().slice(index, index + 1), `${label}.nth(${index})`, pageApi, deps));
    },
    async allInnerTexts() {
      return query().map((element) => (element instanceof HTMLElement ? element.innerText : element.textContent ?? ''));
    },
    async allTextContents() {
      return query().map((element) => element.textContent ?? '');
    },
    and(locator: RuntimeMethodTable) {
      if (typeof locator?.__query !== 'function') {
        throw new Error('locator.and requires a Web Cap locator.');
      }
      return createLocator(
        () => {
          const otherElements = new Set(locator.__query() as Element[]);
          return query().filter((element) => otherElements.has(element));
        },
        `${label}.and(${String(locator)})`,
        pageApi,
        deps,
      );
    },
    async boundingBox() {
      const element = await requireElement();
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    async check(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') {
        throw new Error(`Locator ${label} did not resolve to a checkbox input.`);
      }
      if (!element.checked) {
        element.click();
        await deps.waitForManagedInput();
      }
    },
    async contentFrame(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      if (!(element instanceof HTMLIFrameElement)) {
        return null;
      }
      return typeof pageApi.__frameForElement === 'function'
        ? pageApi.__frameForElement(element)
        : null;
    },
    async clear(options?: unknown) {
      await implementation.fill('', options);
    },
    async click(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Locator ${label} did not resolve to an HTMLElement.`);
      }
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      element.click();
      await deps.waitForManagedInput();
    },
    async dblclick(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Locator ${label} did not resolve to an HTMLElement.`);
      }
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await deps.waitForManagedInput();
    },
    async count() {
      return query().length;
    },
    async dispatchEvent(type: unknown, eventInit: unknown = {}, options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      element.dispatchEvent(new Event(String(type), { bubbles: true, ...(eventInit as EventInit) }));
      await deps.waitForManagedInput();
    },
    describe(description: unknown) {
      const next = createLocator(query, label, pageApi, deps);
      next.__description = String(description ?? '');
      return next;
    },
    description() {
      return String(implementation.__description ?? '');
    },
    async dragTo(target: RuntimeMethodTable, options?: unknown) {
      const source = await requireElement({ timeout: timeoutFromOptions(options) });
      const targetElement = typeof target?.elementHandle === 'function'
        ? await target.elementHandle(options)
        : null;
      if (!(source instanceof HTMLElement) || !(targetElement instanceof HTMLElement)) {
        throw new Error('locator.dragTo requires source and target HTMLElements.');
      }
      if (pageApi.mouse) {
        const sourcePoint = elementCenter(source);
        const targetPoint = elementCenter(targetElement);
        await pageApi.mouse.move(sourcePoint.x, sourcePoint.y);
        await pageApi.mouse.down();
        await pageApi.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
        await pageApi.mouse.up();
        return;
      }
      const dataTransfer = typeof DataTransfer !== 'undefined' ? new DataTransfer() : undefined;
      const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
      const createDragLikeEvent = (type: string) =>
        typeof DragEvent !== 'undefined'
          ? new DragEvent(type, eventInit)
          : new MouseEvent(type, eventInit);
      source.dispatchEvent(createDragLikeEvent('dragstart'));
      targetElement.dispatchEvent(createDragLikeEvent('dragenter'));
      targetElement.dispatchEvent(createDragLikeEvent('dragover'));
      targetElement.dispatchEvent(createDragLikeEvent('drop'));
      source.dispatchEvent(createDragLikeEvent('dragend'));
      await deps.waitForManagedInput();
    },
    async drop(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Locator ${label} did not resolve to an HTMLElement.`);
      }
      const dataTransfer = typeof DataTransfer !== 'undefined' ? new DataTransfer() : undefined;
      const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
      element.dispatchEvent(
        typeof DragEvent !== 'undefined'
          ? new DragEvent('drop', eventInit)
          : new MouseEvent('drop', eventInit),
      );
      await deps.waitForManagedInput();
    },
    async elementHandle(options?: unknown) {
      return await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
    },
    async elementHandles() {
      return query();
    },
    fill: async (value: unknown, options?: unknown) => {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      await deps.typeIntoElement(element, value);
      await deps.waitForManagedInput();
    },
    filter(options: { hasText?: unknown; hasNotText?: unknown } = {}) {
      return createLocator(
        () =>
          query().filter((element) => {
            if (options.hasText !== undefined && !textMatches(element.textContent, options.hasText)) {
              return false;
            }
            if (options.hasNotText !== undefined && textMatches(element.textContent, options.hasNotText)) {
              return false;
            }
            return true;
          }),
        `${label}.filter()`,
        pageApi,
        deps,
      );
    },
    first() {
      return createLocator(() => query().slice(0, 1), `${label}.first()`, pageApi, deps);
    },
    async focus(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (element instanceof HTMLElement) {
        element.focus();
      }
    },
    async blur(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      if (element instanceof HTMLElement) {
        element.blur();
      }
    },
    async getAttribute(name: unknown, options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      return element.getAttribute(String(name));
    },
    async highlight(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      showHighlightOverlay(element);
    },
    getByAltText(text: unknown, options: { exact?: boolean } = {}) {
      return createLocator(
        () => query().flatMap((root) => [...root.querySelectorAll('img, area')]).filter((element) => textMatches(element.getAttribute('alt'), text, options.exact)),
        `${label}.getByAltText(${String(text)})`,
        pageApi,
        deps,
      );
    },
    getByLabel(text: unknown, options: { exact?: boolean } = {}) {
      return createLocator(
        () =>
          query()
            .flatMap((root) => [root, ...root.querySelectorAll('*')])
            .filter((element) => {
              if (
                !(element instanceof HTMLInputElement) &&
                !(element instanceof HTMLTextAreaElement) &&
                !(element instanceof HTMLSelectElement)
              ) {
                return false;
              }
              return textMatches(accessibleName(element), text, options.exact);
            }),
        `${label}.getByLabel(${String(text)})`,
        pageApi,
        deps,
      );
    },
    getByPlaceholder(text: unknown, options: { exact?: boolean } = {}) {
      return createLocator(
        () => query().flatMap((root) => [root, ...root.querySelectorAll('*')]).filter((element) => textMatches(element.getAttribute('placeholder'), text, options.exact)),
        `${label}.getByPlaceholder(${String(text)})`,
        pageApi,
        deps,
      );
    },
    getByRole(role: unknown, options: { name?: unknown; exact?: boolean } = {}) {
      return createLocator(
        () =>
          query()
            .flatMap((root) => [root, ...root.querySelectorAll('*')])
            .filter((element) => {
              if (implicitRole(element) !== String(role)) {
                return false;
              }
              return options.name === undefined || textMatches(accessibleName(element), options.name, options.exact);
            }),
        `${label}.getByRole(${String(role)})`,
        pageApi,
        deps,
      );
    },
    getByTestId(testId: unknown) {
      return implementation.locator(`[data-testid="${cssEscape(String(testId))}"]`);
    },
    getByText(text: unknown, options: { exact?: boolean } = {}) {
      return createLocator(
        () => smallestTextMatches(query(), text, options.exact),
        `${label}.getByText(${String(text)})`,
        pageApi,
        deps,
      );
    },
    getByTitle(text: unknown, options: { exact?: boolean } = {}) {
      return createLocator(
        () => query().flatMap((root) => [root, ...root.querySelectorAll('*')]).filter((element) => textMatches(element.getAttribute('title'), text, options.exact)),
        `${label}.getByTitle(${String(text)})`,
        pageApi,
        deps,
      );
    },
    async hover(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (element instanceof HTMLElement && pageApi.mouse) {
        const point = elementCenter(element);
        await pageApi.mouse.move(point.x, point.y);
        return;
      }
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await deps.waitForManagedInput();
    },
    async hideHighlight() {
      hideHighlightOverlay();
    },
    async innerHTML(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      return element.innerHTML;
    },
    async innerText(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      return element instanceof HTMLElement ? element.innerText : element.textContent ?? '';
    },
    async inputValue(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        return element.value;
      }
      throw new Error(`Locator ${label} did not resolve to an input, textarea, or select.`);
    },
    async isChecked() {
      const element = query()[0];
      return element instanceof HTMLInputElement ? element.checked : false;
    },
    async isDisabled() {
      const element = query()[0];
      return element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ? element.disabled
        : false;
    },
    async isEditable() {
      const element = query()[0];
      return deps.isEditableElement(element);
    },
    async isEnabled() {
      return !(await implementation.isDisabled());
    },
    async isHidden() {
      return !(await implementation.isVisible());
    },
    async isVisible() {
      return isVisibleElement(query()[0]);
    },
    last() {
      return createLocator(() => query().slice(-1), `${label}.last()`, pageApi, deps);
    },
    locator(selector: unknown) {
      if (typeof selector !== 'string') {
        throw new Error('locator.locator only supports string selectors in Web Cap script runtime.');
      }
      return createLocator(
        () => query().flatMap((element) => queryLocatorSelectorAll(selector, element)),
        `${label}.locator(${selector})`,
        pageApi,
        deps,
      );
    },
    nth(index: unknown) {
      const normalizedIndex = Math.max(Math.trunc(Number(index)), 0);
      return createLocator(() => query().slice(normalizedIndex, normalizedIndex + 1), `${label}.nth(${normalizedIndex})`, pageApi, deps);
    },
    or(locator: RuntimeMethodTable) {
      if (typeof locator?.__query !== 'function') {
        throw new Error('locator.or requires a Web Cap locator.');
      }
      return createLocator(
        () => {
          const seen = new Set<Element>();
          const elements = [...query(), ...(locator.__query() as Element[])];
          return elements.filter((element) => {
            if (seen.has(element)) {
              return false;
            }
            seen.add(element);
            return true;
          });
        },
        `${label}.or(${String(locator)})`,
        pageApi,
        deps,
      );
    },
    page() {
      return pageApi;
    },
    async press(key: unknown, options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      await pressKeyOnElement(element, key, deps);
    },
    async pressSequentially(text: unknown, options?: { delay?: number; timeout?: number }) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      const delay = Math.max(Number(options?.delay ?? 0), 0);
      for (const char of String(text ?? '')) {
        await pressKeyOnElement(element, char, deps);
        if (delay > 0) {
          await deps.wait(delay);
        }
      }
    },
    async scrollIntoViewIfNeeded(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (element instanceof HTMLElement) {
        element.scrollIntoView?.({ block: 'center', inline: 'center' });
      }
    },
    async screenshot(options: { type?: unknown; quality?: unknown } = {}) {
      const element = await requireElement();
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Locator ${label} did not resolve to an HTMLElement.`);
      }
      if (!deps.browserCommand) {
        throw new Error('locator.screenshot requires the debugger CDP bridge.');
      }
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const format = options.type === 'jpeg' ? 'jpeg' : 'png';
      const params: Record<string, unknown> = {
        format,
        fromSurface: true,
        clip: {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: Math.max(rect.width, 1),
          height: Math.max(rect.height, 1),
          scale: 1,
        },
      };
      if (format === 'jpeg' && options.quality !== undefined) {
        params.quality = Number(options.quality);
      }
      const result = await deps.browserCommand('Page.captureScreenshot', params) as { data?: string };
      return result.data ?? result;
    },
    async setChecked(checked: unknown, options?: unknown) {
      const shouldBeChecked = Boolean(checked);
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') {
        throw new Error(`Locator ${label} did not resolve to a checkbox input.`);
      }
      if (element.checked !== shouldBeChecked) {
        element.click();
        await deps.waitForManagedInput();
      }
    },
    async selectOption(values: unknown, options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error(`Locator ${label} did not resolve to a select element.`);
      }
      const selectedValues = Array.isArray(values) ? values.map(String) : [String(values)];
      for (const option of [...element.options]) {
        option.selected = selectedValues.includes(option.value) || selectedValues.includes(option.label);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await deps.waitForManagedInput();
      return selectedValues;
    },
    async selectText(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options) });
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.select();
        return;
      }
      const selection = globalThis.getSelection?.();
      if (!selection || !(element instanceof HTMLElement)) {
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    async tap(options?: unknown) {
      await implementation.click(options);
    },
    async textContent(options?: unknown) {
      const element = await requireElement({ timeout: timeoutFromOptions(options), state: 'attached' });
      return element.textContent;
    },
    async type(text: unknown, options?: { delay?: number; timeout?: number }) {
      await implementation.pressSequentially(text, options);
    },
    async uncheck(options?: unknown) {
      await implementation.setChecked(false, options);
    },
    async waitFor(options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}) {
      await waitForLocator(query, label, deps.wait, options);
    },
    toString() {
      return label;
    },
  };

  for (const method of PLAYWRIGHT_LOCATOR_METHODS) {
    if (!(method in implementation)) {
      implementation[method] = notImplemented(`locator.${method}`);
    }
  }

  return implementation;
}
