import type { ChromeDebuggerClient } from './chrome-debugger-client';
import type { DebuggeeTarget, ManagedInputBridge } from './debugger-types';

interface RuntimeBindingCalledEvent {
  name?: string;
  payload?: string;
}

interface DebuggerManagedClickPayload {
  id: string;
  action?: 'click' | 'move' | 'down' | 'up';
  clientX: number;
  clientY: number;
  debug?: Record<string, unknown>;
}

interface DebuggerManagedKeyboardPayload {
  id: string;
  action?: 'dispatchEvent' | 'insertText';
  eventType?: 'rawKeyDown' | 'keyDown' | 'char' | 'keyUp';
  key?: string;
  code?: string;
  keyCode?: number;
  which?: number;
  location?: number;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text?: string;
  replaceExistingText?: boolean;
  debug?: Record<string, unknown>;
}

interface DebuggerManagedWindowPayload {
  id: string;
  action?: 'close';
  debug?: Record<string, unknown>;
}

interface DebuggerManagedTimerPayload {
  id: string;
  action?: 'schedule' | 'clear';
  delayMs?: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

export interface ManagedInputBridgeExecutionScope {
  executionId: string;
  timerBridgeFunctionName?: string;
}

const CDP_MOUSE_BUTTON = 'left';
const PAGE_INPUT_SETTLE_QUIET_MS = 120;
const PAGE_INPUT_SETTLE_MAX_MS = 800;
const BACKGROUND_MOUSE_MOVE_EVENT_TIMEOUT_MS = 500;

export class ManagedInputBridgeFactory {
  private readonly pointerPositions = new Map<number, PointerPosition>();
  private readonly timerHandles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly client: ChromeDebuggerClient,
    private readonly closeTab: (tabId: number) => Promise<void> = async () => undefined,
  ) {}

  clearPointerPosition(tabId: number): void {
    this.pointerPositions.delete(tabId);
  }

  createExecutionScope(executionId?: string): ManagedInputBridgeExecutionScope {
    return {
      executionId: this.normalizeExecutionId(executionId ?? this.createBridgeSuffix()),
    };
  }

  async createManagedClickBridge(
    target: DebuggeeTarget,
    scope: ManagedInputBridgeExecutionScope = this.createExecutionScope(),
  ): Promise<ManagedInputBridge> {
    const bridgeSuffix = this.createBridgeSuffix(scope, 'click');
    const bindingName = `__webCapDebuggerClickBinding_${bridgeSuffix}`;
    const bridgeFunctionName = `__webCapManagedClickBridge_${bridgeSuffix}`;
    const resolverStoreName = `__webCapManagedClickResolvers_${bridgeSuffix}`;

    await this.client.sendCommand(target, 'Runtime.addBinding', {
      name: bindingName,
    });

    const listener = (
      source: DebuggeeTarget,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (source.tabId !== target.tabId || method !== 'Runtime.bindingCalled') {
        return;
      }

      const event = params as RuntimeBindingCalledEvent | undefined;
      if (event?.name !== bindingName || !event.payload) {
        return;
      }

      void this.handleManagedClickBinding(
        target,
        resolverStoreName,
        event.payload,
        scope.timerBridgeFunctionName,
      );
    };
    this.client.getChromeApi()?.debugger?.onEvent?.addListener(listener);

    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: this.buildClickBridgeInstaller(bindingName, bridgeFunctionName, resolverStoreName),
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });

    return this.createDisposableBridge(target, listener, bindingName, bridgeFunctionName, resolverStoreName);
  }

  async createManagedKeyboardBridge(
    target: DebuggeeTarget,
    scope: ManagedInputBridgeExecutionScope = this.createExecutionScope(),
  ): Promise<ManagedInputBridge> {
    const bridgeSuffix = this.createBridgeSuffix(scope, 'keyboard');
    const bindingName = `__webCapDebuggerKeyboardBinding_${bridgeSuffix}`;
    const bridgeFunctionName = `__webCapManagedKeyboardBridge_${bridgeSuffix}`;
    const resolverStoreName = `__webCapManagedKeyboardResolvers_${bridgeSuffix}`;

    await this.client.sendCommand(target, 'Runtime.addBinding', {
      name: bindingName,
    });

    const listener = (
      source: DebuggeeTarget,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (source.tabId !== target.tabId || method !== 'Runtime.bindingCalled') {
        return;
      }

      const event = params as RuntimeBindingCalledEvent | undefined;
      if (event?.name !== bindingName || !event.payload) {
        return;
      }

      void this.handleManagedKeyboardBinding(target, resolverStoreName, event.payload);
    };
    this.client.getChromeApi()?.debugger?.onEvent?.addListener(listener);

    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: this.buildKeyboardBridgeInstaller(bindingName, bridgeFunctionName, resolverStoreName),
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });

    return this.createDisposableBridge(target, listener, bindingName, bridgeFunctionName, resolverStoreName);
  }

  async createManagedWindowBridge(
    target: DebuggeeTarget,
    scope: ManagedInputBridgeExecutionScope = this.createExecutionScope(),
  ): Promise<ManagedInputBridge> {
    const bridgeSuffix = this.createBridgeSuffix(scope, 'window');
    const bindingName = `__webCapDebuggerWindowBinding_${bridgeSuffix}`;
    const bridgeFunctionName = `__webCapManagedWindowBridge_${bridgeSuffix}`;
    const resolverStoreName = `__webCapManagedWindowResolvers_${bridgeSuffix}`;

    await this.client.sendCommand(target, 'Runtime.addBinding', {
      name: bindingName,
    });

    const listener = (
      source: DebuggeeTarget,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (source.tabId !== target.tabId || method !== 'Runtime.bindingCalled') {
        return;
      }

      const event = params as RuntimeBindingCalledEvent | undefined;
      if (event?.name !== bindingName || !event.payload) {
        return;
      }

      void this.handleManagedWindowBinding(target, resolverStoreName, event.payload);
    };
    this.client.getChromeApi()?.debugger?.onEvent?.addListener(listener);

    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: this.buildWindowBridgeInstaller(bindingName, bridgeFunctionName, resolverStoreName),
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });

    return this.createDisposableBridge(
      target,
      listener,
      bindingName,
      bridgeFunctionName,
      resolverStoreName,
    );
  }

  async createManagedTimerBridge(
    target: DebuggeeTarget,
    scope: ManagedInputBridgeExecutionScope = this.createExecutionScope(),
  ): Promise<ManagedInputBridge> {
    const bridgeSuffix = this.createBridgeSuffix(scope, 'timer');
    const bindingName = `__webCapDebuggerTimerBinding_${bridgeSuffix}`;
    const bridgeFunctionName = `__webCapManagedTimerBridge_${bridgeSuffix}`;
    const resolverStoreName = `__webCapManagedTimerResolvers_${bridgeSuffix}`;

    await this.client.sendCommand(target, 'Runtime.addBinding', {
      name: bindingName,
    });

    const listener = (
      source: DebuggeeTarget,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      if (source.tabId !== target.tabId || method !== 'Runtime.bindingCalled') {
        return;
      }

      const event = params as RuntimeBindingCalledEvent | undefined;
      if (event?.name !== bindingName || !event.payload) {
        return;
      }

      void this.handleManagedTimerBinding(target, resolverStoreName, event.payload);
    };
    this.client.getChromeApi()?.debugger?.onEvent?.addListener(listener);

    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: this.buildTimerBridgeInstaller(bindingName, bridgeFunctionName, resolverStoreName),
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    scope.timerBridgeFunctionName = bridgeFunctionName;
    return this.createDisposableBridge(
      target,
      listener,
      bindingName,
      bridgeFunctionName,
      resolverStoreName,
      () => this.clearManagedTimersForResolver(target.tabId, resolverStoreName),
    );
  }

  private createDisposableBridge(
    target: DebuggeeTarget,
    listener: (
      source: DebuggeeTarget,
      method: string,
      params?: Record<string, unknown>,
    ) => void,
    bindingName: string,
    bridgeFunctionName: string,
    resolverStoreName: string,
    onDispose?: () => void,
  ): ManagedInputBridge {
    return {
      bridgeFunctionName,
      dispose: async () => {
        onDispose?.();
        this.client.getChromeApi()?.debugger?.onEvent?.removeListener(listener);
        await this.client.sendCommand(target, 'Runtime.evaluate', {
          expression: `
(() => {
  const bridgeFunctionName = ${JSON.stringify(bridgeFunctionName)};
  const resolverStoreName = ${JSON.stringify(resolverStoreName)};
  delete globalThis[bridgeFunctionName];
  delete globalThis[resolverStoreName];
})();
          `,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
        }).catch(() => undefined);
        await this.client.sendCommand(target, 'Runtime.removeBinding', {
          name: bindingName,
        }).catch(() => undefined);
      },
    };
  }

  private async handleManagedClickBinding(
    target: DebuggeeTarget,
    resolverStoreName: string,
    payloadJson: string,
    timerBridgeFunctionName?: string,
  ): Promise<void> {
    let payload: DebuggerManagedClickPayload | undefined;
    try {
      payload = JSON.parse(payloadJson) as DebuggerManagedClickPayload;
    } catch {
      return;
    }

    if (!payload?.id) {
      return;
    }

    try {
      await this.dispatchManagedMouse(target, payload);
      await this.waitForPageInputSettled(target, timerBridgeFunctionName);
      await this.resolveManagedPromise(target, resolverStoreName, payload.id);
    } catch (error) {
      await this.rejectManagedPromise(
        target,
        resolverStoreName,
        payload.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleManagedKeyboardBinding(
    target: DebuggeeTarget,
    resolverStoreName: string,
    payloadJson: string,
  ): Promise<void> {
    let payload: DebuggerManagedKeyboardPayload | undefined;
    try {
      payload = JSON.parse(payloadJson) as DebuggerManagedKeyboardPayload;
    } catch {
      return;
    }

    if (!payload?.id) {
      return;
    }

    try {
      await this.dispatchManagedKeyboard(target, payload);
      await this.resolveManagedPromise(target, resolverStoreName, payload.id);
    } catch (error) {
      await this.rejectManagedPromise(
        target,
        resolverStoreName,
        payload.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleManagedWindowBinding(
    target: DebuggeeTarget,
    resolverStoreName: string,
    payloadJson: string,
  ): Promise<void> {
    let payload: DebuggerManagedWindowPayload | undefined;
    try {
      payload = JSON.parse(payloadJson) as DebuggerManagedWindowPayload;
    } catch {
      return;
    }

    if (!payload?.id) {
      return;
    }

    try {
      await this.resolveManagedPromise(target, resolverStoreName, payload.id);
      if ((payload.action ?? 'close') === 'close') {
        setTimeout(() => {
          void this.closeTab(target.tabId).catch((error) => {
            console.info('[WEB_CAP] managed window close failed', {
              tabId: target.tabId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 50);
      }
    } catch (error) {
      await this.rejectManagedPromise(
        target,
        resolverStoreName,
        payload.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleManagedTimerBinding(
    target: DebuggeeTarget,
    resolverStoreName: string,
    payloadJson: string,
  ): Promise<void> {
    let payload: DebuggerManagedTimerPayload | undefined;
    try {
      payload = JSON.parse(payloadJson) as DebuggerManagedTimerPayload;
    } catch {
      return;
    }

    if (!payload?.id) {
      return;
    }

    const timerKey = this.createManagedTimerKey(target.tabId, resolverStoreName, payload.id);
    if (payload.action === 'clear') {
      const timer = this.timerHandles.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.timerHandles.delete(timerKey);
      }
      await this.resolveManagedPromise(target, resolverStoreName, payload.id).catch(
        () => undefined,
      );
      return;
    }

    const delayMs = Math.max(0, Math.trunc(Number(payload.delayMs ?? 0)));
    const timer = setTimeout(() => {
      this.timerHandles.delete(timerKey);
      void this.resolveManagedPromise(target, resolverStoreName, payload.id).catch(
        () => undefined,
      );
    }, delayMs);
    this.timerHandles.set(timerKey, timer);
  }

  private async dispatchManagedMouse(
    target: DebuggeeTarget,
    payload: DebuggerManagedClickPayload,
  ): Promise<void> {
    const x = Number.isFinite(payload.clientX) ? payload.clientX : 0;
    const y = Number.isFinite(payload.clientY) ? payload.clientY : 0;
    const action = payload.action ?? 'click';
    const isBackgroundMouse = payload.debug?.backgroundPage === true;
    const from =
      this.pointerPositions.get(target.tabId) ??
      this.getInitialPointerPosition(x, y, payload.debug);
    const movePath = isBackgroundMouse ? [{ x, y }] : this.buildMouseMovePath(from, { x, y });
    let dispatchedAllMoveEvents = true;
    for (const [index, point] of movePath.entries()) {
      const dispatched = await this.sendMouseEvent(
        target,
        {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: CDP_MOUSE_BUTTON,
          buttons: 0,
          pointerType: 'mouse',
          debug: {
            action,
            phase: 'move-path',
            index,
            total: movePath.length,
            backgroundPage: isBackgroundMouse,
          },
        },
        isBackgroundMouse ? BACKGROUND_MOUSE_MOVE_EVENT_TIMEOUT_MS : undefined,
      );
      dispatchedAllMoveEvents &&= dispatched;
    }

    if (action === 'move') {
      if (dispatchedAllMoveEvents) {
        this.pointerPositions.set(target.tabId, { x, y });
      }
      return;
    }

    if (action === 'down' || action === 'click') {
      await this.sendMouseEvent(
        target,
        {
          type: 'mousePressed',
          x,
          y,
          button: CDP_MOUSE_BUTTON,
          buttons: 1,
          clickCount: 1,
          pointerType: 'mouse',
          debug: {
            action,
            phase: 'press',
            backgroundPage: isBackgroundMouse,
          },
        },
        isBackgroundMouse ? BACKGROUND_MOUSE_MOVE_EVENT_TIMEOUT_MS : undefined,
      );
    }

    if (action === 'up' || action === 'click') {
      await this.sendMouseEvent(
        target,
        {
          type: 'mouseReleased',
          x,
          y,
          button: CDP_MOUSE_BUTTON,
          buttons: 0,
          clickCount: 1,
          pointerType: 'mouse',
          debug: {
            action,
            phase: 'release',
            backgroundPage: isBackgroundMouse,
          },
        },
        isBackgroundMouse ? BACKGROUND_MOUSE_MOVE_EVENT_TIMEOUT_MS : undefined,
      );
    }
    this.pointerPositions.set(target.tabId, { x, y });
  }

  private async sendMouseEvent(
    target: DebuggeeTarget,
    payload: Record<string, unknown> & { debug?: Record<string, unknown> },
    timeoutMs?: number,
  ): Promise<boolean> {
    const { debug: _debug, ...commandPayload } = payload;
    const command = this.client.sendCommand(target, 'Input.dispatchMouseEvent', commandPayload);
    if (timeoutMs !== undefined) {
      const result = await Promise.race([
        command.then(
          () => 'finished' as const,
          (error) => {
            throw error;
          },
        ),
        this.delay(timeoutMs).then(() => 'timed_out' as const),
      ]);
      if (result === 'timed_out') {
        command.catch(() => undefined);
        return false;
      }
    } else {
      await command;
    }
    return true;
  }

  private async waitForPageInputSettled(
    target: DebuggeeTarget,
    timerBridgeFunctionName?: string,
  ): Promise<void> {
    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: `
(() => {
  const timerBridge = globalThis[${JSON.stringify(timerBridgeFunctionName)}];
  const quietMs = ${PAGE_INPUT_SETTLE_QUIET_MS};
  const maxMs = ${PAGE_INPUT_SETTLE_MAX_MS};
  const timerHandles = new Map();
  const scheduleHostTimer = (id, delayMs, handler) => {
    const handle = { cleared: false, nativeTimer: undefined };
    timerHandles.set(id, handle);
    if (typeof timerBridge !== 'function') {
      handle.nativeTimer = setTimeout(() => {
        timerHandles.delete(id);
        if (!handle.cleared) {
          handler();
        }
      }, delayMs);
      return;
    }
    Promise.resolve(timerBridge({ action: 'schedule', id, delayMs }))
      .then(() => {
        timerHandles.delete(id);
        if (!handle.cleared) {
          handler();
        }
      })
      .catch(() => {
        timerHandles.delete(id);
        if (!handle.cleared) {
          handler();
        }
      });
  };
  const clearHostTimer = (id) => {
    const handle = timerHandles.get(id);
    if (!handle) {
      return;
    }
    handle.cleared = true;
    timerHandles.delete(id);
    if (typeof timerBridge !== 'function') {
      clearTimeout(handle.nativeTimer);
      return;
    }
    void Promise.resolve(timerBridge({ action: 'clear', id })).catch(() => undefined);
  };

  return new Promise((resolve) => {
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver !== 'function') {
      scheduleHostTimer('settle-fallback', quietMs, resolve);
      return;
    }

    const suffix = Date.now() + '-' + Math.random().toString(16).slice(2);
    const quietTimerId = 'settle-quiet-' + suffix;
    const maxTimerId = 'settle-max-' + suffix;
    let completed = false;

    const observer = new MutationObserver(() => {
      clearHostTimer(quietTimerId);
      if (!completed) {
        scheduleHostTimer(quietTimerId, quietMs, done);
      }
    });

    const done = () => {
      if (completed) {
        return;
      }
      completed = true;
      observer.disconnect();
      clearHostTimer(quietTimerId);
      clearHostTimer(maxTimerId);
      resolve();
    };

    observer.observe(root, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleHostTimer(quietTimerId, quietMs, done);
    scheduleHostTimer(maxTimerId, maxMs, done);
  });
})()
      `,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }).catch(() => undefined);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async dispatchManagedKeyboard(
    target: DebuggeeTarget,
    payload: DebuggerManagedKeyboardPayload,
  ): Promise<void> {
    if (payload.action === 'insertText') {
      if (payload.replaceExistingText) {
        await this.selectAllFocusedEditableContent(target);
      }
      await this.client.sendCommand(target, 'Input.insertText', {
        text: String(payload.text ?? ''),
      });
      return;
    }

    const eventType = payload.eventType ?? 'rawKeyDown';
    const key = String(payload.key ?? '');
    const code = String(payload.code ?? '');
    const keyCode = this.normalizeKeyboardCode(payload.keyCode ?? payload.which ?? 0);
    const text = eventType === 'char' ? this.resolveKeyboardText(payload) : undefined;

    await this.client.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: eventType,
      key,
      code,
      text,
      unmodifiedText: text,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      location: Number(payload.location ?? 0),
      isKeypad: Number(payload.location ?? 0) === 3,
      autoRepeat: Boolean(payload.repeat),
      modifiers: this.buildKeyboardModifiers(payload),
    });
  }

  private async selectAllFocusedEditableContent(target: DebuggeeTarget): Promise<void> {
    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: `
(() => {
  const active = document.activeElement;
  if (!active) {
    return;
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const length = typeof active.value === 'string' ? active.value.length : 0;
    active.setSelectionRange(0, length);
    return;
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    const selection = active.ownerDocument?.getSelection?.();
    if (!selection) {
      return;
    }
    const range = active.ownerDocument.createRange();
    range.selectNodeContents(active);
    selection.removeAllRanges();
    selection.addRange(range);
  }
})();
      `,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
  }

  private async resolveManagedPromise(
    target: DebuggeeTarget,
    resolverStoreName: string,
    id: string,
  ): Promise<void> {
    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: `
(() => {
  const store = globalThis[${JSON.stringify(resolverStoreName)}];
  const entry = store?.[${JSON.stringify(id)}];
  if (!entry) {
    return;
  }
  delete store[${JSON.stringify(id)}];
  entry.resolve();
})();
      `,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
  }

  private async rejectManagedPromise(
    target: DebuggeeTarget,
    resolverStoreName: string,
    id: string,
    message: string,
  ): Promise<void> {
    await this.client.sendCommand(target, 'Runtime.evaluate', {
      expression: `
(() => {
  const store = globalThis[${JSON.stringify(resolverStoreName)}];
  const entry = store?.[${JSON.stringify(id)}];
  if (!entry) {
    return;
  }
  delete store[${JSON.stringify(id)}];
  entry.reject(new Error(${JSON.stringify(message)}));
})();
      `,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }).catch(() => undefined);
  }

  private getInitialPointerPosition(
    targetX: number,
    targetY: number,
    debug?: Record<string, unknown>,
  ): PointerPosition {
    const viewport = this.readRecord(debug?.viewport);
    const innerWidth = this.readFiniteNumber(viewport?.innerWidth);
    const innerHeight = this.readFiniteNumber(viewport?.innerHeight);
    if (innerWidth !== undefined && innerHeight !== undefined) {
      return {
        x: Math.round(innerWidth / 2),
        y: Math.round(innerHeight / 2),
      };
    }

    return {
      x: Math.round(targetX + 64),
      y: Math.round(targetY + 64),
    };
  }

  private buildMouseMovePath(from: PointerPosition, to: PointerPosition): PointerPosition[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 1) {
      return [{ x: to.x, y: to.y }];
    }

    const steps = Math.max(4, Math.min(24, Math.ceil(distance / 24)));
    const points: PointerPosition[] = [];
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      points.push({
        x: Math.round(from.x + dx * progress),
        y: Math.round(from.y + dy * progress),
      });
    }

    return points;
  }

  private readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  }

  private readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private buildKeyboardModifiers(payload: DebuggerManagedKeyboardPayload): number {
    let modifiers = 0;
    if (payload.altKey) {
      modifiers |= 1;
    }
    if (payload.ctrlKey) {
      modifiers |= 2;
    }
    if (payload.metaKey) {
      modifiers |= 4;
    }
    if (payload.shiftKey) {
      modifiers |= 8;
    }
    return modifiers;
  }

  private normalizeKeyboardCode(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private resolveKeyboardText(payload: DebuggerManagedKeyboardPayload): string | undefined {
    const key = String(payload.key ?? '');
    if (key.length === 1) {
      return key;
    }
    return undefined;
  }

  private createBridgeSuffix(scope?: ManagedInputBridgeExecutionScope, kind?: string): string {
    const localId = scope?.executionId ?? this.createRandomBridgeId();
    return kind ? `${localId}_${kind}` : localId;
  }

  private createRandomBridgeId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replace(/-/g, '');
    }

    return `${Date.now()}${Math.random().toString(16).slice(2)}`;
  }

  private normalizeExecutionId(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9_]/g, '');
    return normalized.length > 0 ? normalized : this.createRandomBridgeId();
  }

  private createManagedTimerKey(
    tabId: number,
    resolverStoreName: string,
    id: string,
  ): string {
    return `${tabId}:${resolverStoreName}:${id}`;
  }

  private clearManagedTimersForResolver(tabId: number, resolverStoreName: string): void {
    const prefix = `${tabId}:${resolverStoreName}:`;
    for (const [key, timer] of this.timerHandles) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timer);
      this.timerHandles.delete(key);
    }
  }

  private buildClickBridgeInstaller(
    bindingName: string,
    bridgeFunctionName: string,
    resolverStoreName: string,
  ): string {
    return `
(() => {
  const bindingName = ${JSON.stringify(bindingName)};
  const bridgeFunctionName = ${JSON.stringify(bridgeFunctionName)};
  const resolverStoreName = ${JSON.stringify(resolverStoreName)};
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') {
    throw new Error(\`Debugger binding \${bindingName} was not installed.\`);
  }

  globalThis[resolverStoreName] = Object.create(null);
  globalThis[bridgeFunctionName] = (payload) => {
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
    return new Promise((resolve, reject) => {
      globalThis[resolverStoreName][id] = { resolve, reject };
      binding(JSON.stringify({
        id,
        action:
          payload?.action === 'move' ||
          payload?.action === 'down' ||
          payload?.action === 'up'
            ? payload.action
            : 'click',
        clientX: Number(payload?.clientX ?? 0),
        clientY: Number(payload?.clientY ?? 0),
        debug:
          payload && typeof payload.debug === 'object' && payload.debug !== null
            ? payload.debug
            : null,
      }));
    });
  };
})();
    `;
  }

  private buildKeyboardBridgeInstaller(
    bindingName: string,
    bridgeFunctionName: string,
    resolverStoreName: string,
  ): string {
    return `
(() => {
  const bindingName = ${JSON.stringify(bindingName)};
  const bridgeFunctionName = ${JSON.stringify(bridgeFunctionName)};
  const resolverStoreName = ${JSON.stringify(resolverStoreName)};
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') {
    throw new Error(\`Debugger binding \${bindingName} was not installed.\`);
  }

  globalThis[resolverStoreName] = Object.create(null);
  globalThis[bridgeFunctionName] = (payload) => {
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
    return new Promise((resolve, reject) => {
      globalThis[resolverStoreName][id] = { resolve, reject };
      binding(JSON.stringify({
        id,
        action: payload?.action === 'dispatchEvent' ? 'dispatchEvent' : 'insertText',
        eventType:
          payload?.eventType === 'char' ||
          payload?.eventType === 'keyUp' ||
          payload?.eventType === 'keyDown'
            ? payload.eventType
            : 'rawKeyDown',
        key: typeof payload?.key === 'string' ? payload.key : '',
        code: typeof payload?.code === 'string' ? payload.code : '',
        keyCode: Number(payload?.keyCode ?? payload?.which ?? 0),
        which: Number(payload?.which ?? payload?.keyCode ?? 0),
        location: Number(payload?.location ?? 0),
        repeat: Boolean(payload?.repeat),
        altKey: Boolean(payload?.altKey),
        ctrlKey: Boolean(payload?.ctrlKey),
        metaKey: Boolean(payload?.metaKey),
        shiftKey: Boolean(payload?.shiftKey),
        text: typeof payload?.text === 'string' ? payload.text : '',
        replaceExistingText: Boolean(payload?.replaceExistingText),
        debug:
          payload && typeof payload.debug === 'object' && payload.debug !== null
            ? payload.debug
            : null,
      }));
    });
  };
})();
    `;
  }

  private buildWindowBridgeInstaller(
    bindingName: string,
    bridgeFunctionName: string,
    resolverStoreName: string,
  ): string {
    return `
(() => {
  const bindingName = ${JSON.stringify(bindingName)};
  const bridgeFunctionName = ${JSON.stringify(bridgeFunctionName)};
  const resolverStoreName = ${JSON.stringify(resolverStoreName)};
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') {
    throw new Error(\`Debugger binding \${bindingName} was not installed.\`);
  }

  globalThis[resolverStoreName] = Object.create(null);
  globalThis[bridgeFunctionName] = (payload) => {
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
    return new Promise((resolve, reject) => {
      globalThis[resolverStoreName][id] = { resolve, reject };
      binding(JSON.stringify({
        id,
        action: 'close',
        debug:
          payload && typeof payload.debug === 'object' && payload.debug !== null
            ? payload.debug
            : null,
      }));
    });
  };
})();
    `;
  }

  private buildTimerBridgeInstaller(
    bindingName: string,
    bridgeFunctionName: string,
    resolverStoreName: string,
  ): string {
    return `
(() => {
  const bindingName = ${JSON.stringify(bindingName)};
  const bridgeFunctionName = ${JSON.stringify(bridgeFunctionName)};
  const resolverStoreName = ${JSON.stringify(resolverStoreName)};
  const binding = globalThis[bindingName];
  if (typeof binding !== 'function') {
    throw new Error(\`Debugger binding \${bindingName} was not installed.\`);
  }

  globalThis[resolverStoreName] = Object.create(null);
  globalThis[bridgeFunctionName] = (payload) => {
    const id =
      typeof payload?.id === 'string' && payload.id.length > 0
        ? payload.id
        : \`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
    return new Promise((resolve, reject) => {
      globalThis[resolverStoreName][id] = { resolve, reject };
      binding(JSON.stringify({
        id,
        action: payload?.action === 'clear' ? 'clear' : 'schedule',
        delayMs: Number(payload?.delayMs ?? 0),
      }));
    });
  };
})();
    `;
  }
}
