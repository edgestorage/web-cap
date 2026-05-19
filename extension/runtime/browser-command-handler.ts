import type {
  BrowserCommandName,
  RuntimeTabSnapshot,
} from '@shared/protocol';
import {
  browserCommandInputSchemas,
  normalizeWaitEventsDurationMs,
} from '@shared/browser-command-contracts';

interface BrowserCommandResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface BrowserTabLike {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  openerTabId?: number;
}

interface BrowserCommandHandlerOptions {
  setLastActiveTabId: (tabId: number | undefined) => void;
  sendTabSnapshot: () => Promise<void>;
  toTabSnapshot: (tab: BrowserTabLike) => RuntimeTabSnapshot;
}

export class BrowserCommandHandler {
  constructor(private readonly options: BrowserCommandHandlerOptions) {}

  async execute(
    tabId: number,
    command: BrowserCommandName,
    input: Record<string, unknown>,
    emitEvent?: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResponse> {
    if (command === 'page_inspect') {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: pageInspectScript,
        args: [],
      });
      return results[0]?.result ?? { ok: false, error: 'Page script returned no result.' };
    }

    if (command === 'create_tab') {
      const parsed = browserCommandInputSchemas.create_tab.parse(input ?? {});
      const createdTab = await browser.tabs.create({
        url: parsed.url && parsed.url.length > 0 ? parsed.url : undefined,
        active: parsed.active ?? true,
      });
      this.options.setLastActiveTabId(createdTab.id);
      await this.options.sendTabSnapshot();

      return {
        ok: true,
        result: {
          createdTab: this.options.toTabSnapshot(createdTab),
        },
      };
    }

    if (command === 'wait_events') {
      return await this.waitForBrowserEvents(tabId, input, emitEvent ?? (() => undefined));
    }

    return { ok: false, error: `Browser command ${command} is not supported directly.` };
  }

  private async waitForBrowserEvents(
    tabId: number,
    input: Record<string, unknown>,
    emitEvent: (event: Record<string, unknown>) => void,
  ): Promise<BrowserCommandResponse> {
    const parsed = browserCommandInputSchemas.wait_events.parse(input ?? {});
    const durationMs = normalizeWaitEventsDurationMs(parsed.durationMs);
    const token = `web-cap-events-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let eventCount = 0;

    const emit = (event: Record<string, unknown>) => {
      eventCount += 1;
      emitEvent({
        ...event,
        atMs: Date.now() - startedAt,
        tabId,
        observedAt: new Date().toISOString(),
      });
    };

    const messageListener = (message: unknown): void => {
      if (!isBrowserEventMessage(message, token)) {
        return;
      }
      emit(message.event);
    };

    const tabUpdateListener = async (
      updatedTabId: number,
      changeInfo: { status?: string; url?: string },
    ): Promise<void> => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.url) {
        emit({ type: 'page_url_changed', value: { url: changeInfo.url } });
      }
      if (changeInfo.status) {
        emit({ type: 'page_status_changed', value: { status: changeInfo.status } });
      }
      if (changeInfo.status === 'complete') {
        await this.installBrowserEventObserver(tabId, token).catch(() => undefined);
      }
    };

    browser.runtime.onMessage.addListener(messageListener);
    browser.tabs.onUpdated.addListener(tabUpdateListener);

    try {
      await this.installBrowserEventObserver(tabId, token);
      emit({ type: 'wait_started', value: { durationMs } });
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      return {
        ok: true,
        result: {
          ok: true,
          durationMs,
          eventCount,
        },
      };
    } finally {
      browser.runtime.onMessage.removeListener(messageListener);
      browser.tabs.onUpdated.removeListener(tabUpdateListener);
      await this.removeBrowserEventObserver(tabId, token).catch(() => undefined);
    }
  }

  private async installBrowserEventObserver(tabId: number, token: string): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId },
      func: browserEventObserverScript,
      args: [token],
    });
  }

  private async removeBrowserEventObserver(tabId: number, token: string): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId },
      func: browserEventObserverCleanupScript,
      args: [token],
    });
  }
}

function pageInspectScript(): BrowserCommandResponse {
  const inputs = [...document.querySelectorAll('input, textarea')]
    .slice(0, 20)
    .map((element) => {
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      return {
        tagName: field.tagName.toLowerCase(),
        id: field.id,
        name: field.getAttribute('name') ?? '',
        type: field instanceof HTMLInputElement ? field.type : 'textarea',
        placeholder: field.getAttribute('placeholder') ?? '',
        value: field.value,
      };
    });

  return {
    ok: true,
    result: {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      linkCount: document.querySelectorAll('a').length,
      inputCount: inputs.length,
      inputs,
    },
  };
}

function browserEventObserverScript(token: string): void {
  const stateKey = `__webCapEventObserver_${token}`;
  const existing = (window as unknown as Record<string, (() => void) | undefined>)[stateKey];
  existing?.();

  const send = (event: Record<string, unknown>) => {
    void browser.runtime.sendMessage({
      type: 'WEB_CAP_BROWSER_EVENT',
      token,
      event,
    });
  };
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  let currentUrl = location.href;
  const detectUrlChange = (method: string) => {
    const nextUrl = location.href;
    if (nextUrl === currentUrl) {
      return;
    }
    send({
      type: 'page_url_changed',
      value: { from: currentUrl, to: nextUrl, method },
    });
    currentUrl = nextUrl;
  };
  const shortText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const describeElement = (target: EventTarget | null) => {
    if (!(target instanceof Element)) {
      return {};
    }
    const rect = target.getBoundingClientRect();
    return {
      tagName: target.tagName.toLowerCase(),
      id: target.id || undefined,
      className: typeof target.className === 'string' ? shortText(target.className) || undefined : undefined,
      role: target.getAttribute('role') || undefined,
      ariaLabel: target.getAttribute('aria-label') || undefined,
      name: target.getAttribute('name') || undefined,
      type: target.getAttribute('type') || undefined,
      href: target instanceof HTMLAnchorElement ? target.href || undefined : undefined,
      text: shortText(target.textContent),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };
  const onClick = (event: MouseEvent) => {
    send({
      type: 'click',
      value: {
        button: event.button,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        target: describeElement(event.target),
      },
    });
  };
  const onInput = (event: Event) => {
    const target = event.target as EventTarget & { value?: unknown; checked?: unknown };
    send({
      type: event.type,
      value: {
        target: describeElement(event.target),
        valueLength: target && 'value' in target ? String(target.value ?? '').length : undefined,
        checked: target && 'checked' in target ? Boolean(target.checked) : undefined,
      },
    });
  };
  const onSubmit = (event: SubmitEvent) => {
    send({ type: 'submit', value: { target: describeElement(event.target) } });
  };
  const onPopState = () => detectUrlChange('popstate');
  const onHashChange = () => detectUrlChange('hashchange');

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    detectUrlChange('pushState');
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    detectUrlChange('replaceState');
    return result;
  };

  addEventListener('popstate', onPopState, true);
  addEventListener('hashchange', onHashChange, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('submit', onSubmit, true);
  (window as unknown as Record<string, () => void>)[stateKey] = () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    removeEventListener('popstate', onPopState, true);
    removeEventListener('hashchange', onHashChange, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('submit', onSubmit, true);
    delete (window as unknown as Record<string, unknown>)[stateKey];
  };
}

function browserEventObserverCleanupScript(token: string): void {
  const stateKey = `__webCapEventObserver_${token}`;
  const existing = (window as unknown as Record<string, (() => void) | undefined>)[stateKey];
  existing?.();
}

function isBrowserEventMessage(
  message: unknown,
  token: string,
): message is { type: 'WEB_CAP_BROWSER_EVENT'; token: string; event: Record<string, unknown> } {
  return Boolean(
    message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'WEB_CAP_BROWSER_EVENT' &&
      (message as { token?: unknown }).token === token &&
      typeof (message as { event?: unknown }).event === 'object' &&
      !Array.isArray((message as { event?: unknown }).event),
  );
}
