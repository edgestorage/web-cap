import { describe, expect, it } from 'vitest';
import {
  BROWSER_COMMAND_RESPONSE_GRACE_MS,
  browserCommandInputSchemas,
  normalizeWaitEventsDurationMs,
} from '@shared/browser-command-contracts';
import {
  parseBrowserCommandRequest,
  timeoutForBrowserCommand,
} from '../lib/server/browser/command-contracts';

describe('browser command contracts', () => {
  it('shares create_tab parsing between callers and runtime input', () => {
    expect(browserCommandInputSchemas.create_tab.parse({ active: false })).toEqual({
      active: false,
    });
    expect(parseBrowserCommandRequest('create_tab', {
      url: 'https://example.com',
      active: true,
    })).toEqual({
      url: 'https://example.com',
      active: true,
    });
  });

  it('validates browser_screenshot options', () => {
    expect(parseBrowserCommandRequest('browser_screenshot', {
      tabId: 7,
      type: 'jpeg',
      quality: 80,
      fullPage: true,
    })).toEqual({
      tabId: 7,
      type: 'jpeg',
      quality: 80,
      fullPage: true,
    });

    expect(() => parseBrowserCommandRequest('browser_screenshot', { type: 'webp' })).toThrow(
      /Invalid browser_screenshot browser command input/,
    );
    expect(() => parseBrowserCommandRequest('browser_screenshot', { quality: 101 })).toThrow(
      /Invalid browser_screenshot browser command input/,
    );
  });

  it('normalizes wait_events duration and derives command timeout', () => {
    expect(normalizeWaitEventsDurationMs(undefined)).toBe(30_000);
    expect(timeoutForBrowserCommand('wait_events', { durationMs: 250 })).toBe(
      250 + BROWSER_COMMAND_RESPONSE_GRACE_MS,
    );
  });

  it('rejects invalid wait_events input before reaching the runtime', () => {
    expect(() => parseBrowserCommandRequest('wait_events', { durationMs: 0 })).toThrow(
      /Invalid wait_events browser command input/,
    );
    expect(() => parseBrowserCommandRequest('wait_events', { tabId: 1.5 })).toThrow(
      /Invalid wait_events browser command input/,
    );
  });
});
