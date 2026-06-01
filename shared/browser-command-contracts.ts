import { z } from 'zod';
import type { BrowserCommandName } from './protocol';
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
} from './script-schema';

export const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 15_000;
export const BROWSER_COMMAND_RESPONSE_GRACE_MS = 5_000;

export const browserCommandInputSchemas = {
  browser_screenshot: z.object({
    type: z.enum(['png', 'jpeg']).optional(),
    quality: z.number().int().min(0).max(100).optional(),
    fullPage: z.boolean().optional(),
    omitBackground: z.boolean().optional(),
  }),
  create_tab: z.object({
    url: z.string().optional(),
    active: z.boolean().optional(),
  }),
  wait_events: z.object({
    durationMs: z.number().int().positive().max(MAX_EXECUTION_TIMEOUT_MS).optional(),
  }),
} as const;

export const browserCommandRequestSchemas = {
  browser_screenshot: browserCommandInputSchemas.browser_screenshot.extend({
    tabId: z.number().int().optional(),
  }),
  create_tab: browserCommandInputSchemas.create_tab,
  wait_events: browserCommandInputSchemas.wait_events.extend({
    tabId: z.number().int().optional(),
  }),
} as const;

export type ContractedBrowserCommandName = keyof typeof browserCommandInputSchemas;
export type BrowserScreenshotInput = z.infer<typeof browserCommandRequestSchemas.browser_screenshot>;
export type CreateTabInput = z.infer<typeof browserCommandRequestSchemas.create_tab>;
export type WaitEventsInput = z.infer<typeof browserCommandRequestSchemas.wait_events>;

export function isContractedBrowserCommand(
  command: BrowserCommandName,
): command is ContractedBrowserCommandName {
  return command === 'browser_screenshot' || command === 'create_tab' || command === 'wait_events';
}

export function normalizeWaitEventsDurationMs(durationMs: number | undefined): number {
  const parsed = z
    .number()
    .int()
    .positive()
    .max(MAX_EXECUTION_TIMEOUT_MS)
    .default(DEFAULT_EXECUTION_TIMEOUT_MS)
    .safeParse(durationMs);
  if (!parsed.success) {
    throw new Error(
      `Invalid browser wait-events duration: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  return parsed.data;
}
