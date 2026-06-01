/* eslint-disable */
// Mechanically extracted from script-runtime.injected.ts. Keep behavior changes out of this file.
interface ManagedClickEvidence {
  events: Array<{
    type: string;
    value: unknown;
  }>;
}

interface ManagedClickContext {
  pendingAsyncOperations: Promise<unknown>;
}

interface ManagedMouseState {
  cursor: HTMLDivElement | null;
  x: number | undefined;
  y: number | undefined;
  generation: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  idleToken: number;
}

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface RectSample {
  label: string;
  rect: RectSnapshot;
}

interface ActionablePointResult {
  point: ManagedClickPoint | null;
  clickableRect: RectSnapshot | null;
  hitTarget: Element | null;
  blockedBy: Element | null;
  reason: string | null;
}

interface RoundedRectSnapshot {
  x: number;
  y: number;
  w: number;
  h: number;
}

type ManagedClickBridge = (payload: {
  action?: 'click' | 'move' | 'down' | 'up';
  clientX: number;
  clientY: number;
  debug: Record<string, unknown>;
}) => unknown;

interface ManagedClickPoint {
  clientX: number;
  clientY: number;
}

type ManagedMouseAction = 'click' | 'move' | 'down' | 'up';

interface SyntheticMouseState {
  point?: ManagedClickPoint;
  buttonDown?: boolean;
  released?: boolean;
  sequenceStarted?: boolean;
  clickedElement?: HTMLElement;
  clickPoint?: ManagedClickPoint | null;
}

export function installManagedClickHook(
  evidence: ManagedClickEvidence,
  context: ManagedClickContext,
  managedClickBridgeFunctionName: string | null,
  wait: (ms: number) => Promise<unknown>,
) {
  if (typeof HTMLElement === 'undefined') {
    return () => undefined;
  }

  const prototype = HTMLElement.prototype;
  const originalClick = prototype.click;
  const eventTargetPrototype =
    typeof EventTarget !== 'undefined' ? EventTarget.prototype : null;
  const originalDispatchEvent = eventTargetPrototype?.dispatchEvent;
  if (typeof originalClick !== 'function') {
    return () => undefined;
  }

  const managedStateKey = '__webCapManagedMouseState';
  const managedGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const managedState =
    (managedGlobal[managedStateKey] as ManagedMouseState | undefined) ??
    (managedGlobal[managedStateKey] = {
      cursor: null,
      x: undefined,
      y: undefined,
      generation: 0,
      idleTimer: undefined,
      idleToken: 0,
    } satisfies ManagedMouseState);
  const managedGeneration = (managedState.generation ?? 0) + 1;
  managedState.generation = managedGeneration;
  managedState.idleToken = managedState.idleToken ?? 0;
  let managedMouseSequence: Promise<unknown> = Promise.resolve();
  const MANAGED_CURSOR_IDLE_FADE_MS = 60_000;
  const MANAGED_CURSOR_FADE_IN_MS = 180;
  const MANAGED_CURSOR_FADE_OUT_MS = 450;
  const MANAGED_CURSOR_HOTSPOT_X = 10;
  const MANAGED_CURSOR_HOTSPOT_Y = 7;
  const MANAGED_CURSOR_WIDTH = 28;
  const MANAGED_CURSOR_HEIGHT = 28;
  const MANAGED_CURSOR_VIEWBOX_WIDTH = 200;
  const MANAGED_CURSOR_VIEWBOX_HEIGHT = 200;
  const MANAGED_CURSOR_VERSION = 'solid-rounded-blue-v2';

  function setManagedCursorStyle(
    element: HTMLElement | SVGElement,
    property: string,
    value: string,
  ) {
    element.style.setProperty(property, value, 'important');
  }

  function applyManagedCursorHostStyles(cursor: HTMLDivElement) {
    setManagedCursorStyle(cursor, 'position', 'fixed');
    setManagedCursorStyle(cursor, 'left', '0');
    setManagedCursorStyle(cursor, 'top', '0');
    setManagedCursorStyle(cursor, 'width', `${MANAGED_CURSOR_WIDTH}px`);
    setManagedCursorStyle(cursor, 'height', `${MANAGED_CURSOR_HEIGHT}px`);
    setManagedCursorStyle(cursor, 'display', 'block');
    setManagedCursorStyle(cursor, 'line-height', '0');
    setManagedCursorStyle(cursor, 'font-size', '0');
    setManagedCursorStyle(cursor, 'margin', '0');
    setManagedCursorStyle(cursor, 'padding', '0');
    setManagedCursorStyle(cursor, 'pointer-events', 'none');
    setManagedCursorStyle(cursor, 'z-index', '2147483647');
    setManagedCursorStyle(cursor, 'opacity', '0');
    setManagedCursorStyle(cursor, 'transform', 'translate3d(-9999px, -9999px, 0)');
    setManagedCursorStyle(
      cursor,
      'transform-origin',
      `${MANAGED_CURSOR_HOTSPOT_X}px ${MANAGED_CURSOR_HOTSPOT_Y}px`,
    );
    setManagedCursorStyle(cursor, 'transition', `opacity ${MANAGED_CURSOR_FADE_IN_MS}ms ease-out`);
    setManagedCursorStyle(cursor, 'will-change', 'transform, opacity');
    setManagedCursorStyle(cursor, 'contain', 'layout style paint');
    setManagedCursorStyle(cursor, 'overflow', 'visible');
  }

  function ensureManagedCursorShadow(cursor: HTMLDivElement) {
    const shadowRoot = cursor.shadowRoot ?? cursor.attachShadow({ mode: 'open' });
    const existingSvg = shadowRoot.querySelector('[data-web-cap-managed-cursor-svg="true"]');
    if (existingSvg?.getAttribute('data-web-cap-managed-cursor-version') === MANAGED_CURSOR_VERSION) {
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block !important;
        width: ${MANAGED_CURSOR_WIDTH}px !important;
        height: ${MANAGED_CURSOR_HEIGHT}px !important;
        line-height: 0 !important;
        font-size: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        pointer-events: none !important;
      }
      svg {
        display: block !important;
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: ${MANAGED_CURSOR_WIDTH}px !important;
        height: ${MANAGED_CURSOR_HEIGHT}px !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: none !important;
        overflow: visible !important;
        vertical-align: top !important;
        line-height: 0 !important;
      }
    `;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-web-cap-managed-cursor-svg', 'true');
    svg.setAttribute('data-web-cap-managed-cursor-version', MANAGED_CURSOR_VERSION);
    svg.setAttribute('viewBox', `0 0 ${MANAGED_CURSOR_VIEWBOX_WIDTH} ${MANAGED_CURSOR_VIEWBOX_HEIGHT}`);
    svg.setAttribute('width', String(MANAGED_CURSOR_WIDTH));
    svg.setAttribute('height', String(MANAGED_CURSOR_HEIGHT));
    svg.setAttribute('aria-hidden', 'true');
    setManagedCursorStyle(svg, 'display', 'block');
    setManagedCursorStyle(svg, 'position', 'absolute');
    setManagedCursorStyle(svg, 'left', '0');
    setManagedCursorStyle(svg, 'top', '0');
    setManagedCursorStyle(svg, 'width', `${MANAGED_CURSOR_WIDTH}px`);
    setManagedCursorStyle(svg, 'height', `${MANAGED_CURSOR_HEIGHT}px`);
    setManagedCursorStyle(svg, 'margin', '0');
    setManagedCursorStyle(svg, 'padding', '0');
    setManagedCursorStyle(svg, 'transform', 'none');
    setManagedCursorStyle(svg, 'overflow', 'visible');
    setManagedCursorStyle(svg, 'vertical-align', 'top');
    setManagedCursorStyle(svg, 'line-height', '0');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gradient.setAttribute('id', 'web-cap-cursor-solid-gradient');
    gradient.setAttribute('x1', '66');
    gradient.setAttribute('y1', '36.5');
    gradient.setAttribute('x2', '114.5');
    gradient.setAttribute('y2', '174');
    gradient.setAttribute('gradientUnits', 'userSpaceOnUse');
    const start = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    start.setAttribute('offset', '0%');
    start.setAttribute('stop-color', '#88C2FF');
    const end = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    end.setAttribute('offset', '100%');
    end.setAttribute('stop-color', '#3699FF');
    gradient.append(start, end);
    defs.appendChild(gradient);

    const cursorPath =
      'M128.899 154.589C124.553 145.678 111.921 119.624 111.921 119.624L150.112 116.694C154.659 116.35 156.548 110.502 153.264 107.534C153.264 107.534 82.2213 43.0566 80.5 41.5C62.4271 25.1564 45.5123 31.1959 45.5 53.5C45.5 103.188 46 106.046 46 155.733C46.0009 160.221 51.7619 162.721 55.032 159.454L82.6676 131.913L100.142 167.954C105.5 176.5 116.486 173.5 121 171C125.514 168.5 133.244 163.5 128.899 154.589Z';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', cursorPath);
    path.setAttribute('fill', 'url(#web-cap-cursor-solid-gradient)');
    svg.append(defs, path);
    shadowRoot.replaceChildren(style, svg);
  }

  function ensureManagedCursor(): HTMLDivElement {
    if (managedState.cursor?.isConnected) {
      applyManagedCursorHostStyles(managedState.cursor);
      ensureManagedCursorShadow(managedState.cursor);
      return managedState.cursor;
    }

    const cursor = document.createElement('div');
    cursor.setAttribute('data-web-cap-managed-cursor', 'true');
    applyManagedCursorHostStyles(cursor);
    ensureManagedCursorShadow(cursor);
    (document.documentElement ?? document.body ?? document).appendChild(cursor);
    managedState.cursor = cursor;
    return cursor;
  }

  function scheduleManagedCursorIdleFade() {
    const token = (managedState.idleToken ?? 0) + 1;
    managedState.idleToken = token;
    if (managedState.idleTimer !== undefined) {
      clearTimeout(managedState.idleTimer);
    }

    managedState.idleTimer = setTimeout(() => {
      if (managedState.idleToken !== token) {
        return;
      }

      const cursor = managedState.cursor;
      if (!cursor?.isConnected) {
        return;
      }

      setManagedCursorStyle(cursor, 'transition', `opacity ${MANAGED_CURSOR_FADE_OUT_MS}ms ease-out`);
      setManagedCursorStyle(cursor, 'opacity', '0');
    }, MANAGED_CURSOR_IDLE_FADE_MS);
  }

  function showManagedCursor(cursor: HTMLDivElement) {
    setManagedCursorStyle(cursor, 'transition', `opacity ${MANAGED_CURSOR_FADE_IN_MS}ms ease-out`);
    setManagedCursorStyle(cursor, 'opacity', '1');
    scheduleManagedCursorIdleFade();
  }

  function placeManagedCursor(x: number, y: number, visible: boolean) {
    const cursor = ensureManagedCursor();
    managedState.x = x;
    managedState.y = y;
    setManagedCursorStyle(
      cursor,
      'transform',
      `translate3d(${x - MANAGED_CURSOR_HOTSPOT_X}px, ${y - MANAGED_CURSOR_HOTSPOT_Y}px, 0)`,
    );
    if (visible) {
      showManagedCursor(cursor);
    } else {
      setManagedCursorStyle(cursor, 'transition', `opacity ${MANAGED_CURSOR_FADE_OUT_MS}ms ease-out`);
      setManagedCursorStyle(cursor, 'opacity', '0');
    }
  }

  async function animateManagedCursor(clientX: number, clientY: number) {
    const cursor = ensureManagedCursor();
    const startX =
      typeof managedState.x === 'number' ? managedState.x : clientX - 80 - Math.random() * 40;
    const startY =
      typeof managedState.y === 'number' ? managedState.y : clientY - 50 - Math.random() * 30;
    const endX = clientX;
    const endY = clientY;
    const distance = Math.hypot(endX - startX, endY - startY);
    const steps = Math.min(18, Math.max(8, Math.round(distance / 28)));
    const durationMs = Math.min(320, Math.max(140, Math.round(distance * 1.6)));

    placeManagedCursor(startX, startY, true);
    await wait(16);

    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const eased = 1 - Math.pow(1 - progress, 2);
      const wave = Math.sin(progress * Math.PI) * 6;
      const x = startX + (endX - startX) * eased;
      const y = startY + (endY - startY) * eased - wave;
      setManagedCursorStyle(
        cursor,
        'transform',
        `translate3d(${x - MANAGED_CURSOR_HOTSPOT_X}px, ${y - MANAGED_CURSOR_HOTSPOT_Y}px, 0)`,
      );
      managedState.x = x;
      managedState.y = y;
      await wait(durationMs / steps);
    }

    placeManagedCursor(endX, endY, true);
    await wait(24);
  }

  async function pulseManagedCursor() {
    const cursor = ensureManagedCursor();
    setManagedCursorStyle(
      cursor,
      'transition',
      `transform 70ms ease-out, opacity ${MANAGED_CURSOR_FADE_IN_MS}ms ease-out, filter 70ms ease-out`,
    );
    setManagedCursorStyle(cursor, 'filter', 'drop-shadow(0 0 6px rgba(59, 130, 246, 0.45))');
    setManagedCursorStyle(
      cursor,
      'transform',
      `translate3d(${(managedState.x ?? 0) - MANAGED_CURSOR_HOTSPOT_X}px, ${(managedState.y ?? 0) - MANAGED_CURSOR_HOTSPOT_Y}px, 0) scale(0.92)`,
    );
    showManagedCursor(cursor);
    await wait(70);
    setManagedCursorStyle(
      cursor,
      'transform',
      `translate3d(${(managedState.x ?? 0) - MANAGED_CURSOR_HOTSPOT_X}px, ${(managedState.y ?? 0) - MANAGED_CURSOR_HOTSPOT_Y}px, 0) scale(1)`,
    );
    setManagedCursorStyle(cursor, 'filter', 'drop-shadow(0 0 0 rgba(59, 130, 246, 0))');
    await wait(70);
    setManagedCursorStyle(cursor, 'transition', `opacity ${MANAGED_CURSOR_FADE_IN_MS}ms ease-out`);
  }

  function captureRectSnapshot(element: Element): RectSnapshot {
    const rect = element.getBoundingClientRect();
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    const top = Number.isFinite(rect.top) ? rect.top : 0;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    return {
      left,
      top,
      width,
      height,
      right: Number.isFinite(rect.right) ? rect.right : left + width,
      bottom: Number.isFinite(rect.bottom) ? rect.bottom : top + height,
    };
  }

  function rectDistance(first: RectSnapshot | null, second: RectSnapshot | null) {
    if (!first || !second) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(
      Math.abs(first.left - second.left),
      Math.abs(first.top - second.top),
      Math.abs(first.width - second.width),
      Math.abs(first.height - second.height),
    );
  }

  function simplifyRectSnapshot(rect: RectSnapshot | null): RoundedRectSnapshot | null {
    if (!rect) {
      return null;
    }

    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function getViewportRect(element: Element): RectSnapshot {
    const view = element.ownerDocument?.defaultView ?? window;
    const width = Number.isFinite(view.innerWidth) ? view.innerWidth : 0;
    const height = Number.isFinite(view.innerHeight) ? view.innerHeight : 0;
    return {
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
    };
  }

  function intersectRects(first: RectSnapshot, second: RectSnapshot): RectSnapshot | null {
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
      return null;
    }

    return { left, top, right, bottom, width, height };
  }

  function elementClipsOverflow(element: HTMLElement) {
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style) {
      return false;
    }

    const clips = (value: string) =>
      value === 'hidden' || value === 'clip' || value === 'scroll' || value === 'auto';
    return clips(style.overflowX) || clips(style.overflowY) || clips(style.overflow);
  }

  function clippedClickableRectForElement(element: HTMLElement, rect: RectSnapshot): RectSnapshot | null {
    let clipped = intersectRects(rect, getViewportRect(element));
    if (!clipped) {
      return null;
    }

    let ancestor = element.parentElement;
    while (ancestor && ancestor !== element.ownerDocument?.body) {
      if (elementClipsOverflow(ancestor)) {
        clipped = intersectRects(clipped, captureRectSnapshot(ancestor));
        if (!clipped) {
          return null;
        }
      }
      ancestor = ancestor.parentElement;
    }

    return clipped;
  }

  function elementCanReceivePointerEvents(element: HTMLElement) {
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style) {
      return true;
    }

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      style.pointerEvents !== 'none' &&
      Number(style.opacity) !== 0
    );
  }

  function isDisabledControl(element: HTMLElement) {
    return (
      'disabled' in element &&
      (element as HTMLElement & { disabled?: unknown }).disabled === true
    );
  }

  function normalizedClickText(element: Element | null) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function rectOverlapRatio(first: RectSnapshot, second: RectSnapshot) {
    const overlap = intersectRects(first, second);
    if (!overlap) {
      return 0;
    }

    const firstArea = Math.max(first.width * first.height, 1);
    return (overlap.width * overlap.height) / firstArea;
  }

  function isMirroredHitTarget(element: HTMLElement, hitTarget: Element) {
    const elementText = normalizedClickText(element);
    if (!elementText || elementText !== normalizedClickText(hitTarget)) {
      return false;
    }

    const elementRect = captureRectSnapshot(element);
    let candidate: Element | null = hitTarget;
    while (candidate && candidate !== element.ownerDocument?.body) {
      if (
        candidate instanceof HTMLElement &&
        normalizedClickText(candidate) === elementText &&
        rectOverlapRatio(elementRect, captureRectSnapshot(candidate)) >= 0.75
      ) {
        return true;
      }
      candidate = candidate.parentElement;
    }

    return false;
  }

  function isAcceptableHitTarget(element: HTMLElement, hitTarget: Element | null) {
    if (!hitTarget) {
      return false;
    }

    if (hitTarget === element || element.contains(hitTarget)) {
      return true;
    }

    if (typeof HTMLLabelElement !== 'undefined' && hitTarget instanceof HTMLLabelElement) {
      const control = hitTarget.control;
      return control === element || (control instanceof HTMLElement && control.contains(element));
    }

    const label = element.closest?.('label');
    if (label && (hitTarget === label || label.contains(hitTarget))) {
      return true;
    }

    return isMirroredHitTarget(element, hitTarget);
  }

  function centerPointForRect(rect: RectSnapshot): ManagedClickPoint {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    return { clientX: centerX, clientY: centerY };
  }

  function jitterPointInsideRect(point: ManagedClickPoint, rect: RectSnapshot): ManagedClickPoint {
    const horizontalJitter = rect.width * 0.1;
    const verticalJitter = rect.height * 0.1;
    return {
      clientX: clamp(point.clientX + randomOffset(horizontalJitter), rect.left, rect.right),
      clientY: clamp(point.clientY + randomOffset(verticalJitter), rect.top, rect.bottom),
    };
  }

  function findActionablePoint(
    element: HTMLElement,
    rect: RectSnapshot,
    requestedPoint: ManagedClickPoint | null,
  ): ActionablePointResult {
    if (rect.width <= 0 || rect.height <= 0) {
      return {
        point: null,
        clickableRect: null,
        hitTarget: null,
        blockedBy: null,
        reason: 'element_has_zero_area',
      };
    }

    if (!elementCanReceivePointerEvents(element)) {
      return {
        point: null,
        clickableRect: null,
        hitTarget: null,
        blockedBy: null,
        reason: 'element_not_pointer_interactive',
      };
    }

    if (isDisabledControl(element) || element.getAttribute('aria-disabled') === 'true') {
      return {
        point: null,
        clickableRect: null,
        hitTarget: null,
        blockedBy: null,
        reason: 'element_disabled',
      };
    }

    const clickableRect = clippedClickableRectForElement(element, rect);
    if (!clickableRect) {
      return {
        point: null,
        clickableRect: null,
        hitTarget: null,
        blockedBy: null,
        reason: 'element_outside_clickable_viewport',
      };
    }

    if (clickableRect.width < 2 || clickableRect.height < 2) {
      return {
        point: null,
        clickableRect,
        hitTarget: null,
        blockedBy: null,
        reason: 'element_clickable_area_too_small',
      };
    }

    const requestedPointIsUsable =
      pointInsideRect(requestedPoint, rect) && pointInsideRect(requestedPoint, clickableRect);
    const candidate = requestedPointIsUsable && requestedPoint
      ? requestedPoint
      : jitterPointInsideRect(centerPointForRect(clickableRect), clickableRect);
    const ownerDocument = element.ownerDocument;

    const hitTarget = ownerDocument?.elementFromPoint?.(candidate.clientX, candidate.clientY) ?? null;
    if (isAcceptableHitTarget(element, hitTarget)) {
      return {
        point: candidate,
        clickableRect,
        hitTarget,
        blockedBy: null,
        reason: null,
      };
    }

    return {
      point: null,
      clickableRect,
      hitTarget,
      blockedBy: hitTarget,
      reason: hitTarget ? 'element_covered_by_other_element' : 'element_not_hit_testable',
    };
  }

  async function captureStableRect(element: HTMLElement, didScroll: boolean) {
    const samples: RectSample[] = [];
    const pushSample = (label: string) => {
      const rect = captureRectSnapshot(element);
      samples.push({ label, rect });
      return rect;
    };

    const initial = pushSample(didScroll ? 'afterScrollStart' : 'visibleStart');
    await wait(16);
    let latest = pushSample(didScroll ? 'afterScrollFrame1' : 'visibleFrame1');
    let previous = initial;
    let stableFrameCount = 0;
    const maxFrames = didScroll ? 60 : 3;

    for (let index = 0; index < maxFrames; index += 1) {
      await wait(16);
      const next = pushSample('stabilityFrame' + (index + 2));
      if (rectDistance(latest, next) <= 1) {
        stableFrameCount += 1;
      } else {
        stableFrameCount = 0;
      }

      if (stableFrameCount >= 2) {
        latest = next;
        break;
      }
      previous = latest;
      latest = next;
    }

    return {
      rect: latest,
      samples,
      scrolled: didScroll,
      stabilized: stableFrameCount >= 2 || rectDistance(previous, latest) <= 1,
    };
  }

  const getBridgeFunction = () =>
    managedClickBridgeFunctionName &&
    typeof managedGlobal[managedClickBridgeFunctionName] === 'function'
      ? (managedGlobal[managedClickBridgeFunctionName] as ManagedClickBridge)
      : null;

  const randomOffset = (radius: number) => {
    if (!Number.isFinite(radius) || radius <= 0) {
      return 0;
    }
    return (Math.random() * 2 - 1) * radius;
  };
  const clamp = (value: number, min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      return value;
    }
    return Math.min(Math.max(value, min), max);
  };

  function toFinitePoint(event: MouseEvent): ManagedClickPoint | null {
    const clientX = Number(event.clientX);
    const clientY = Number(event.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return null;
    }
    return { clientX, clientY };
  }

  function describeElement(element: Element) {
    const description: Record<string, string> = {
      tag: element.tagName.toLowerCase(),
    };
    if (element.id) {
      description.id = element.id;
    }
    if (element instanceof HTMLElement && element.className) {
      description.class = element.className;
    }
    const text = (element.textContent || '').trim().slice(0, 120);
    if (text) {
      description.text = text;
    }
    return description;
  }

  function pointsAreClose(first: ManagedClickPoint | null | undefined, second: ManagedClickPoint | null | undefined) {
    if (!first || !second) {
      return first === second;
    }

    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) <= 2;
  }

  function isSameSyntheticClick(
    state: SyntheticMouseState | undefined,
    element: HTMLElement,
    point: ManagedClickPoint | null,
  ) {
    return Boolean(
      state?.released &&
        state.clickedElement === element &&
        pointsAreClose(state.clickPoint ?? state.point ?? null, point ?? state.point ?? null),
    );
  }

  function isCurrentManagedGeneration() {
    return managedState.generation === managedGeneration;
  }

  function isBackgroundPage(element?: Element) {
    const pageDocument = element?.ownerDocument ?? globalThis.document;
    return pageDocument?.visibilityState === 'hidden' || pageDocument?.hidden === true;
  }

  function pointInsideRect(point: ManagedClickPoint | null, rect: RectSnapshot, tolerance = 2) {
    if (!point) {
      return false;
    }

    return (
      point.clientX >= rect.left - tolerance &&
      point.clientX <= rect.right + tolerance &&
      point.clientY >= rect.top - tolerance &&
      point.clientY <= rect.bottom + tolerance
    );
  }

  async function enqueueManagedClick(
    element: HTMLElement,
    point: ManagedClickPoint | null,
    source: string,
    action: ManagedMouseAction = 'click',
  ) {
    const bridgeFunction = getBridgeFunction();

    managedMouseSequence = managedMouseSequence.catch(() => undefined).then(async () => {
      try {
        if (!isCurrentManagedGeneration()) {
          return;
        }
        let didScroll = false;
        let rectResult = await captureStableRect(element, didScroll);
        if (!isCurrentManagedGeneration()) {
          return;
        }
        let actionability = findActionablePoint(element, rectResult.rect, point);
        if (!actionability.point) {
          didScroll = true;
          element.scrollIntoView?.({ block: 'center', inline: 'center' });
          rectResult = await captureStableRect(element, didScroll);
          if (!isCurrentManagedGeneration()) {
            return;
          }
          actionability = findActionablePoint(element, rectResult.rect, point);
        }

        const rect = rectResult.rect;
        const { left, top, width, height } = rect;
        if (left === 0 && top === 0 && width === 0 && height === 0) {
          evidence.events.push({
            type: 'managed_click_skipped',
            value: {
              reason: 'element_not_visible',
              message: '点击的元素不可见，请重新确认元素',
              source,
              action,
              requestedPoint: point
                ? { x: Math.round(point.clientX), y: Math.round(point.clientY) }
                : null,
              target: describeElement(element),
              rect: simplifyRectSnapshot(rect),
            },
          });
          return;
        }

        if (!actionability.point || !actionability.clickableRect) {
          const blockedByRect =
            actionability.blockedBy instanceof Element
              ? captureRectSnapshot(actionability.blockedBy)
              : null;
          evidence.events.push({
            type: 'managed_click_skipped',
            value: {
              reason: actionability.reason ?? 'element_not_actionable',
              message: '点击的元素当前不可点击，请重新确认元素',
              source,
              action,
              requestedPoint: point
                ? { x: Math.round(point.clientX), y: Math.round(point.clientY) }
                : null,
              target: describeElement(element),
              rect: simplifyRectSnapshot(rect),
              clickableRect: simplifyRectSnapshot(actionability.clickableRect),
              scrolled: rectResult.scrolled,
              rectStabilized: rectResult.stabilized,
              blockedBy:
                actionability.blockedBy instanceof Element
                  ? {
                      tagName: actionability.blockedBy.tagName.toLowerCase(),
                      id: actionability.blockedBy.id || '',
                      className:
                        actionability.blockedBy instanceof HTMLElement
                          ? actionability.blockedBy.className || ''
                          : '',
                      text: (actionability.blockedBy.textContent || '').trim().slice(0, 120),
                      rect: simplifyRectSnapshot(blockedByRect),
                    }
                  : null,
            },
          });
          return;
        }

        const clickableRect = actionability.clickableRect;
        const clientX = clamp(
          actionability.point.clientX,
          clickableRect.left,
          clickableRect.right,
        );
        const clientY = clamp(
          actionability.point.clientY,
          clickableRect.top,
          clickableRect.bottom,
        );
        const view = (element.ownerDocument?.defaultView ?? globalThis) as unknown as Window;
        const hitTarget =
          element.ownerDocument?.elementFromPoint?.(clientX, clientY) ??
          actionability.hitTarget ??
          element;
        const eventTarget =
          isAcceptableHitTarget(element, hitTarget) &&
          (hitTarget instanceof HTMLElement || hitTarget instanceof Element)
            ? hitTarget
            : element;
        const createPointerLikeEvent = (type: string) => {
          const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view,
            detail: type === 'click' ? 1 : 0,
            button: 0,
            buttons:
              type === 'pointerup' || type === 'mouseup' || type === 'click' ? 0 : 1,
            clientX,
            clientY,
            screenX: clientX,
            screenY: clientY,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          };

          if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
            return new PointerEvent(type, base);
          }

          return new MouseEvent(type, base);
        };
        const dispatch = (type: string) => {
          eventTarget.dispatchEvent(createPointerLikeEvent(type));
        };
        const hitTargetRect =
          hitTarget instanceof Element ? captureRectSnapshot(hitTarget) : null;
        const containsOriginal =
          hitTarget === element ||
          (hitTarget instanceof HTMLElement && hitTarget.contains(element)) ||
          element.contains(hitTarget);
        const targetDescriptor: Record<string, unknown> = {
          target: hitTarget instanceof Element ? describeElement(hitTarget) : null,
          point: {
            x: Math.round(clientX),
            y: Math.round(clientY),
          },
          rect: simplifyRectSnapshot(rect),
        };

        if (action !== 'click') {
          targetDescriptor.action = action;
        }

        if (rectResult.scrolled) {
          targetDescriptor.scrolled = true;
        }

        if (!rectResult.stabilized) {
          targetDescriptor.rectStabilized = false;
        }

        if (!containsOriginal) {
          targetDescriptor.containsOriginal = false;
          targetDescriptor.hitTargetRect = simplifyRectSnapshot(hitTargetRect);
        }

        evidence.events.push({
          type: action === 'click' ? 'managed_click' : 'managed_mouse',
          value: targetDescriptor,
        });
        console.info('[WEB_CAP] managed click details', targetDescriptor);

        if (bridgeFunction) {
          const backgroundPage = isBackgroundPage(element);
          await animateManagedCursor(clientX, clientY);
          if (!isCurrentManagedGeneration()) {
            return;
          }
          element.focus?.();
          await Promise.resolve(
            bridgeFunction({
              action,
              clientX,
              clientY,
              debug: { ...targetDescriptor, backgroundPage },
            }),
          );
          if (!isCurrentManagedGeneration()) {
            return;
          }
          await pulseManagedCursor();
          return;
        }

        await animateManagedCursor(clientX, clientY);
        if (!isCurrentManagedGeneration()) {
          return;
        }
        element.focus?.();

        activeSyntheticClickDepth += 1;
        try {
          dispatch('pointerover');
          dispatch('pointerenter');
          dispatch('mouseover');
          dispatch('mouseenter');
          dispatch('pointermove');
          dispatch('mousemove');
          dispatch('pointerdown');
          dispatch('mousedown');
          await pulseManagedCursor();
          dispatch('pointerup');
          dispatch('mouseup');
          dispatch('click');
        } finally {
          activeSyntheticClickDepth -= 1;
        }
      } catch (error) {
        evidence.events.push({
          type: 'managed_click_error',
          value: {
            message: error instanceof Error ? error.message : String(error),
            source,
            action,
            requestedPoint: point
              ? { x: Math.round(point.clientX), y: Math.round(point.clientY) }
              : null,
            target: describeElement(element),
          },
        });
      }
    });
    context.pendingAsyncOperations = managedMouseSequence;
  }

  let activeSyntheticClickDepth = 0;
  const syntheticMouseStateByTarget = new WeakMap<EventTarget, SyntheticMouseState>();
  const managedMouseEventActions = new Map<string, ManagedMouseAction>([
    ['mouseover', 'move'],
    ['mouseenter', 'move'],
    ['mousemove', 'move'],
    ['mousedown', 'down'],
    ['mouseup', 'up'],
    ['click', 'click'],
  ]);

  prototype.click = function managedClick(this: HTMLElement) {
    if (!(this instanceof HTMLElement)) {
      return originalClick.call(this);
    }

    if (activeSyntheticClickDepth > 0) {
      return originalClick.call(this);
    }

    const syntheticState = syntheticMouseStateByTarget.get(this);
    if (isSameSyntheticClick(syntheticState, this, syntheticState?.point ?? null) && getBridgeFunction()) {
      syntheticMouseStateByTarget.delete(this);
      return;
    }

    void enqueueManagedClick(this, null, 'HTMLElement.click');
  };

  if (eventTargetPrototype && typeof originalDispatchEvent === 'function') {
    eventTargetPrototype.dispatchEvent = function managedMouseDispatch(
      this: EventTarget,
      event: Event,
    ) {
      const action = managedMouseEventActions.get(event.type);
      if (
        activeSyntheticClickDepth > 0 ||
        !getBridgeFunction() ||
        !(this instanceof HTMLElement) ||
        !(event instanceof MouseEvent) ||
        event.isTrusted ||
        !action
      ) {
        return originalDispatchEvent.call(this, event);
      }

      const point = toFinitePoint(event);
      const state = syntheticMouseStateByTarget.get(this) ?? {};
      if (point) {
        state.point = point;
      }

      if (action === 'move') {
        syntheticMouseStateByTarget.set(this, state);
        if (point) {
          void enqueueManagedClick(
            this,
            point,
            `dispatchEvent(MouseEvent.${event.type})`,
            'move',
          );
        }
        return true;
      }

      if (action === 'down') {
        state.buttonDown = true;
        state.released = false;
        state.sequenceStarted = true;
        state.clickedElement = this;
        state.clickPoint = point ?? state.point ?? null;
        syntheticMouseStateByTarget.set(this, state);
        void enqueueManagedClick(
          this,
          state.clickPoint,
          'dispatchEvent(MouseEvent.mousedown)',
          'down',
        );
        return true;
      } else if (action === 'up') {
        state.released = state.buttonDown === true;
        state.buttonDown = false;
      }
      syntheticMouseStateByTarget.set(this, state);

      if (action === 'up' && state.sequenceStarted && isSameSyntheticClick(state, this, point ?? state.point ?? null)) {
        return true;
      }

      if (action === 'click' && isSameSyntheticClick(state, this, point ?? state.point ?? null)) {
        syntheticMouseStateByTarget.delete(this);
        return true;
      }

      void enqueueManagedClick(
        this,
        point ?? state.point ?? null,
        `dispatchEvent(MouseEvent.${event.type})`,
        action,
      );

      if (action === 'click') {
        syntheticMouseStateByTarget.delete(this);
      }

      return true;
    };
  }

  return () => {
    if (managedState.generation === managedGeneration) {
      managedState.generation += 1;
    }
    prototype.click = originalClick;
    if (eventTargetPrototype && originalDispatchEvent) {
      eventTargetPrototype.dispatchEvent = originalDispatchEvent;
    }
  };
}
