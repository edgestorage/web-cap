/* eslint-disable */
import type { LocatorQuery, PlaywrightShimDeps } from './playwright-shim-types.injected';

export function notImplemented(apiName: string) {
  return () => {
    throw new Error(`${apiName} is part of the Playwright API surface but is not implemented by Web Cap script runtime yet.`);
  };
}

export function timeoutFromOptions(options: unknown, defaultMs = 5000) {
  const timeout =
    options && typeof options === 'object' && 'timeout' in options
      ? Number((options as { timeout?: unknown }).timeout)
      : defaultMs;
  return Math.max(Number.isFinite(timeout) ? timeout : defaultMs, 0);
}

function normalizeText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function textMatches(value: unknown, expected: unknown, exact = false) {
  const text = normalizeText(value);
  if (expected instanceof RegExp) {
    return expected.test(text);
  }
  const normalizedExpected = normalizeText(expected);
  return exact ? text === normalizedExpected : text.includes(normalizedExpected);
}

export function smallestTextMatches(roots: Element[], expected: unknown, exact = false) {
  const matches = roots.flatMap((root) => {
    const candidates = [root, ...root.querySelectorAll('*')];
    const matchingCandidates = candidates.filter((element) => textMatches(element.textContent, expected, exact));
    return matchingCandidates.filter(
      (element) => !matchingCandidates.some((other) => other !== element && element.contains(other)),
    );
  });
  return matches.filter((element, index) => matches.indexOf(element) === index);
}

export function cssEscape(value: string) {
  const cssObject = (globalThis as typeof globalThis & { CSS?: { escape?: (value: string) => string } }).CSS;
  if (typeof cssObject?.escape === 'function') {
    return cssObject.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

export function isVisibleElement(element: unknown) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = globalThis.getComputedStyle?.(element);
  if (!style) {
    return false;
  }
  if (
    element.hidden ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const HIGHLIGHT_OVERLAY_ID = '__web-cap-playwright-highlight';

export function hideHighlightOverlay() {
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
}

export function showHighlightOverlay(element: Element) {
  hideHighlightOverlay();
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = HIGHLIGHT_OVERLAY_ID;
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: '2px solid #2563eb',
    boxShadow: '0 0 0 99999px rgba(37, 99, 235, 0.12)',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  document.documentElement.appendChild(overlay);
}

export function accessibleName(element: Element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    return ariaLabel;
  }
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return [...(element.labels ?? [])].map((label) => label.textContent ?? '').join(' ').trim();
  }
  if (element instanceof HTMLImageElement) {
    return element.alt || element.title || '';
  }
  return element.textContent ?? '';
}

export function implicitRole(element: Element) {
  const role = element.getAttribute('role');
  if (role) {
    return role;
  }
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') {
    return 'button';
  }
  if (tagName === 'a' && element instanceof HTMLAnchorElement && element.href) {
    return 'link';
  }
  if (tagName === 'img') {
    return 'img';
  }
  if (tagName === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      return 'button';
    }
    if (type === 'checkbox') {
      return 'checkbox';
    }
    if (type === 'radio') {
      return 'radio';
    }
    if (type === 'search') {
      return 'searchbox';
    }
    return 'textbox';
  }
  if (tagName === 'textarea') {
    return 'textbox';
  }
  if (tagName === 'select') {
    return 'combobox';
  }
  return '';
}

function allElements() {
  return [...document.querySelectorAll('*')];
}

function keyboardInfoForKey(key: string) {
  const aliases: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Space: { key: ' ', code: 'Space', keyCode: 32 },
  };
  if (aliases[key]) {
    return aliases[key];
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  return { key, code: key, keyCode: 0 };
}

function applyPressedKeyToEditable(element: HTMLElement, key: string) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (key === 'Backspace') {
      element.value = element.value.slice(0, -1);
    } else if (key.length === 1) {
      element.value += key;
    } else {
      return;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: key.length === 1 ? key : null }));
    return;
  }

  if (element.isContentEditable && key.length === 1) {
    element.textContent = `${element.textContent ?? ''}${key}`;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: key }));
  }
}

export async function pressKeyOnElement(element: unknown, key: unknown, deps: PlaywrightShimDeps) {
  if (!(element instanceof HTMLElement)) {
    throw new Error('Keyboard press target must be an HTMLElement.');
  }
  const normalizedKey = String(key);
  const keyInfo = keyboardInfoForKey(normalizedKey);
  const eventInit = {
    key: keyInfo.key,
    code: keyInfo.code,
    keyCode: keyInfo.keyCode,
    which: keyInfo.keyCode,
    bubbles: true,
    cancelable: true,
  };
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  element.focus?.();
  element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  if (keyInfo.key.length === 1 || keyInfo.key === 'Enter') {
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
  }
  if (deps.useDomKeyboardFallback()) {
    applyPressedKeyToEditable(element, keyInfo.key);
  }
  element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  await deps.waitForManagedInput();
}

export async function waitForLocator(
  query: LocatorQuery,
  label: string,
  wait: PlaywrightShimDeps['wait'],
  options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {},
) {
  const state = options.state ?? 'visible';
  const timeout = timeoutFromOptions(options);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeout) {
    const element = query()[0] ?? null;
    const visible = isVisibleElement(element);
    if (
      (state === 'attached' && element) ||
      (state === 'detached' && !element) ||
      (state === 'visible' && visible) ||
      (state === 'hidden' && (!element || !visible))
    ) {
      return element;
    }
    await wait(50);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${label} to be ${state}.`);
}
