import { z } from 'zod';
import {
  MAX_EXECUTION_TIMEOUT_MS,
} from '@shared/script-schema';
import { WEB_CAP_EVIDENCE_OPTIONS } from '../config';
import type { WebCapAgentService } from './agent/contracts';
import { browserCommandRequestSchemas } from './browser/command-contracts';
import { RuntimeBridgeError } from './runtime/runtime-bridge';

export const executeScriptOptionsSchema = z
  .object({
    tabId: z.number().int().optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_EXECUTION_TIMEOUT_MS)
      .optional(),
    activateTab: z.boolean().optional(),
    evidence: z.array(z.enum(WEB_CAP_EVIDENCE_OPTIONS)).optional(),
  })
  .default({});

export const toolInputSchemas = {
  session_status: z.object({}),
  browser_new_tab: browserCommandRequestSchemas.create_tab,
  script_execute: z.object({
    script: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    options: executeScriptOptionsSchema.optional(),
    register: z.boolean().optional(),
  }),
} as const;

export const rpcInputSchemas = {
  health: z.object({}),
  scriptHistoryList: z.object({
    limit: z.number().int().optional(),
  }),
  scriptRegistryList: z.object({}),
  browserWaitEvents: browserCommandRequestSchemas.wait_events,
  sessionStatus: toolInputSchemas.session_status,
  browserNewTab: browserCommandRequestSchemas.create_tab,
  scriptExecute: toolInputSchemas.script_execute,
} as const;

export type CoreToolName = keyof typeof toolInputSchemas;
export type RpcMethod = keyof typeof rpcInputSchemas;
export type ToolInput<T extends CoreToolName> = z.infer<(typeof toolInputSchemas)[T]>;
export type RpcInput<T extends RpcMethod> = z.infer<(typeof rpcInputSchemas)[T]>;

export const coreToolNames = Object.keys(toolInputSchemas) as CoreToolName[];

export const mcpToolDefinitions: {
  [K in CoreToolName]: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  };
} = {
  session_status: {
    title: 'Get Session Status',
    description:
      'Return the current browser runtime connection status, including the last active tab, all known tabs for the active runtime, and connected runtime snapshots.',
    inputSchema: {},
  },
  browser_new_tab: {
    title: 'Create Browser Tab',
    description:
      'Create a new browser tab in the connected runtime, optionally with a target URL and active state.',
    inputSchema: {
      url: z.string().optional(),
      active: z.boolean().optional(),
    },
  },
  script_execute: {
    title: 'Execute Script',
    description:
      'Execute script code directly in a specified tab of the connected browser. During execution, the script can call registered scripts through `cap.call("script-id", input)`, where the script id can be obtained via script search, for example: `(input) => cap.call("script-id", input)`. Inline executions receive a local script id in the execution result and local history. Set `register` to true to request permanent registration; the script is registered only after execution succeeds with a result object that includes `ok: true`.',
    inputSchema: {
      script: z
        .string()
        .min(1)
        .describe('Script source code to execute in the specified browser tab. The script can call registered scripts through cap.call(...).'),
      input: z
        .record(z.string(), z.unknown())
        .describe('Input object passed to the script at execution time.'),
      options: z
        .object({
          tabId: z
            .number()
            .int()
            .optional()
            .describe('Target browser tab id where the script should run. If omitted, the runtime selects the tab according to its current context.'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .max(MAX_EXECUTION_TIMEOUT_MS)
            .optional()
            .describe('Execution timeout in milliseconds. If omitted, execution times out after 30000 ms. Maximum is 60000 ms.'),
          activateTab: z
            .boolean()
            .optional()
            .describe('When true, activate the target browser tab before executing the script.'),
          evidence: z
            .array(z.enum(WEB_CAP_EVIDENCE_OPTIONS))
            .optional()
            .describe('Evidence to collect for the script run. Use multiple entries such as ["events", "visibleElements"], or ["all"]. Defaults to ["common"].'),
        })
        .describe('Optional execution settings for the script run.')
        .optional(),
      register: z
        .boolean()
        .optional()
        .describe('When true, request permanent registration. The script is saved only if execution returns a result object with ok: true.'),
    },
  },
};

export function parseToolInput<T extends CoreToolName>(
  toolName: T,
  input: unknown,
): ToolInput<T> {
  return parseInput(toolInputSchemas[toolName], input, `Invalid ${toolName} input`) as ToolInput<T>;
}

export function parseRpcInput<T extends RpcMethod>(
  method: T,
  input: unknown,
): RpcInput<T> {
  return parseInput(rpcInputSchemas[method], input ?? {}, `Invalid ${method} RPC input`) as RpcInput<T>;
}

export async function executeCoreTool(
  app: WebCapAgentService,
  toolName: CoreToolName,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'session_status': {
      const status = await app.sessionStatus();
      return {
        connected: status.connected,
        sessionId: status.sessionId,
        browserName: status.browserName,
        extensionVersion: status.extensionVersion,
        lastActiveTab: status.activeTab,
        tabs: status.tabs,
        authenticatedSites: status.authenticatedSites,
        lastSeenAt: status.lastSeenAt,
        runtimes: status.runtimes ?? [],
      };
    }
    case 'browser_new_tab': {
      const input = parseToolInput(toolName, rawInput);
      return (await app.browserNewTab(input)) as unknown as Record<string, unknown>;
    }
    case 'script_execute': {
      const input = parseToolInput(toolName, rawInput);
      return (await app.scriptExecute(input)) as unknown as Record<string, unknown>;
    }
  }
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
