import { z } from 'zod';
import {
  BROWSER_COMMAND_RESPONSE_GRACE_MS,
  DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
  browserCommandInputSchemas,
  browserCommandRequestSchemas,
  normalizeWaitEventsDurationMs,
  type BrowserScreenshotInput,
  type ContractedBrowserCommandName,
  type CreateTabInput,
  type WaitEventsInput,
} from '@shared/browser-command-contracts';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';

export {
  BROWSER_COMMAND_RESPONSE_GRACE_MS,
  DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
  browserCommandInputSchemas,
  browserCommandRequestSchemas,
  normalizeWaitEventsDurationMs,
  type BrowserScreenshotInput,
  type ContractedBrowserCommandName,
  type CreateTabInput,
  type WaitEventsInput,
};

export function parseBrowserCommandRequest<T extends ContractedBrowserCommandName>(
  command: T,
  input: unknown,
): z.infer<(typeof browserCommandRequestSchemas)[T]> {
  return parseInput(
    browserCommandRequestSchemas[command],
    input,
    `Invalid ${command} browser command input`,
  ) as z.infer<(typeof browserCommandRequestSchemas)[T]>;
}

export function parseBrowserCommandRuntimeInput<T extends ContractedBrowserCommandName>(
  command: T,
  input: unknown,
): z.infer<(typeof browserCommandInputSchemas)[T]> {
  return parseInput(
    browserCommandInputSchemas[command],
    input,
    `Invalid ${command} runtime input`,
  ) as z.infer<(typeof browserCommandInputSchemas)[T]>;
}

export function timeoutForBrowserCommand(
  command: ContractedBrowserCommandName,
  input: unknown,
): number {
  if (command === 'wait_events') {
    const parsed = parseBrowserCommandRequest(command, input);
    return normalizeWaitEventsDurationMs(parsed.durationMs) + BROWSER_COMMAND_RESPONSE_GRACE_MS;
  }

  return DEFAULT_BROWSER_COMMAND_TIMEOUT_MS;
}

function parseInput(schema: z.ZodTypeAny, input: unknown, label: string): unknown {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new RuntimeBridgeError(
      `${label}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
        .join('; ')}`,
      'INVALID_INPUT',
    );
  }

  return parsed.data;
}
