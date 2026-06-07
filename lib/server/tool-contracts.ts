import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_EXECUTION_TIMEOUT_MS,
} from '@shared/script-schema';
import type {
  RuntimeConnectionSnapshot,
  RuntimeSessionSnapshot,
  RuntimeTabSnapshot,
} from '@shared/protocol';
import { WEB_CAP_EVIDENCE_OPTIONS } from '../config';
import type { WebCapAgentService } from './agent/contracts';
import { browserCommandRequestSchemas } from './browser/command-contracts';
import { RuntimeBridgeError } from './runtime/runtime-bridge';

const ACTIVE_TAB_AVAILABLE_SCRIPT_LIMIT = 10;
const INACTIVE_TAB_AVAILABLE_SCRIPT_LIMIT = 3;
const TOTAL_AVAILABLE_SCRIPT_LIMIT = 30;

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
    executionPageIndicator: z.boolean().optional(),
    executionTabGroupIndicator: z.boolean().optional(),
    mouseTrajectorySimulation: z.boolean().optional(),
  })
  .default({});

export const toolInputSchemas = {
  session_status: z.object({}),
  browser_screenshot: browserCommandRequestSchemas.browser_screenshot,
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
  userScriptInstall: z
    .object({
      filePath: z.string().min(1).optional(),
      source: z.string().min(1).optional(),
      sourcePath: z.string().min(1).optional(),
      applyNow: z.boolean().optional(),
    })
    .refine((input) => (input.filePath === undefined) !== (input.source === undefined), {
      message: 'Provide exactly one of filePath or source.',
    }),
  userScriptList: z.object({}),
  userScriptEnable: z.object({
    id: z.string().min(1),
    applyNow: z.boolean().optional(),
  }),
  userScriptDisable: z.object({
    id: z.string().min(1),
    applyNow: z.boolean().optional(),
  }),
  userScriptRemove: z.object({
    id: z.string().min(1),
  }),
  browserWaitEvents: browserCommandRequestSchemas.wait_events,
  sessionStatus: toolInputSchemas.session_status,
  browserScreenshot: browserCommandRequestSchemas.browser_screenshot,
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
      'Return browser runtime connection status grouped by runtime, including known tabs and reusable Web Cap script counts for each tab domain.',
    inputSchema: {},
  },
  browser_screenshot: {
    title: 'Capture Browser Screenshot',
    description:
      'Capture a screenshot of the selected browser tab, save it under the Web Cap temporary screenshot directory, and return file metadata. Defaults to PNG visible viewport; set fullPage for a full-page screenshot when supported.',
    inputSchema: {
      tabId: z
        .number()
        .int()
        .optional()
        .describe('Target browser tab id. If omitted, the active tab is used.'),
      type: z.enum(['png', 'jpeg']).optional().describe('Image format. Defaults to png.'),
      quality: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('JPEG quality from 0 to 100. Only used when type is jpeg.'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full page instead of only the visible viewport when supported.'),
      omitBackground: z
        .boolean()
        .optional()
        .describe('Hide the default white background for pages with transparency when supported.'),
    },
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
      'Execute script code directly in a specified tab of the connected browser. Scripts receive an input object, return a JSON-compatible result object, and can use the Playwright-style page API. Inline executions receive a local script id in the execution result and local history. Set `register` to true to request permanent registration; the script is registered only after execution succeeds with a result object that includes `ok: true`.',
    inputSchema: {
      script: z
        .string()
        .min(1)
        .describe('Script source code to execute in the specified browser tab.'),
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
            .describe('Execution timeout in milliseconds. If omitted, execution times out after 30000 ms. Maximum is 120000 ms.'),
          activateTab: z
            .boolean()
            .optional()
            .describe('When true, activate the target browser tab before executing the script.'),
          evidence: z
            .array(z.enum(WEB_CAP_EVIDENCE_OPTIONS))
            .optional()
            .describe('Evidence to collect for the script run. Use multiple entries such as ["events", "visibleElements"], or ["all"]. Defaults to ["common"].'),
          executionPageIndicator: z
            .boolean()
            .optional()
            .describe('When true, show a transparent in-page execution indicator while the script runs. Defaults to false.'),
          executionTabGroupIndicator: z
            .boolean()
            .optional()
            .describe('When true, temporarily update the target tab group title/color while the script runs. Ungrouped tabs are placed in a temporary group and restored after execution. Defaults to true.'),
          mouseTrajectorySimulation: z
            .boolean()
            .optional()
            .describe('When true, browser-level managed mouse input sends a multi-step movement path before press/release. Defaults to false.'),
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
      return (await formatSessionStatusResult(status)) as unknown as Record<string, unknown>;
    }
    case 'browser_new_tab': {
      const input = parseToolInput(toolName, rawInput);
      return (await app.browserNewTab(input)) as unknown as Record<string, unknown>;
    }
    case 'browser_screenshot': {
      const input = parseToolInput(toolName, rawInput);
      return (await app.browserScreenshot(input)) as unknown as Record<string, unknown>;
    }
    case 'script_execute': {
      const input = parseToolInput(toolName, rawInput);
      return (await app.scriptExecute(input)) as unknown as Record<string, unknown>;
    }
  }
}

interface SessionStatusAvailableScriptSummary {
  site: string | null;
  count: number;
  directory: string | null;
  scripts: string[];
}

interface AvailableScriptDirectorySummary {
  count: number;
  scripts: string[];
}

interface SessionStatusTabResult {
  tabId: number;
  url: string;
  title: string;
  site: string;
  readyState: string;
}

interface SessionStatusRuntimeResult {
  sessionId?: string;
  browserName?: string;
  extensionVersion?: string;
  userScriptsAvailable?: boolean;
  lastSeenAt?: string;
  activeTab?: SessionStatusTabResult;
  tabs: SessionStatusTabResult[];
}

interface SessionStatusResult {
  connected: boolean;
  availableScripts: {
    webCapPath: string;
    sites: SessionStatusAvailableScriptSummary[];
  };
  runtimes: SessionStatusRuntimeResult[];
}

async function formatSessionStatusResult(
  status: RuntimeSessionSnapshot,
): Promise<SessionStatusResult> {
  const webCapPath = resolveWebCapPath(process.env);
  const scriptSummaryCache = new Map<string, Promise<AvailableScriptDirectorySummary>>();
  const runtimes = statusRuntimes(status).map(formatRuntime);

  return {
    connected: status.connected,
    availableScripts: {
      webCapPath,
      sites: await summarizeAvailableScriptSites(
        runtimes,
        webCapPath,
        scriptSummaryCache,
      ),
    },
    runtimes,
  };
}

function resolveWebCapPath(env: NodeJS.ProcessEnv): string {
  const configured = env.WEB_CAP_PATH?.trim();
  return configured && configured.length > 0 ? configured : '.web-cap';
}

function statusRuntimes(status: RuntimeSessionSnapshot): RuntimeConnectionSnapshot[] {
  if (status.runtimes?.length) {
    return status.runtimes;
  }

  if (
    !status.sessionId &&
    !status.browserName &&
    !status.extensionVersion &&
    !status.lastSeenAt &&
    !status.activeTab &&
    status.tabs.length === 0
  ) {
    return [];
  }

  return [
    {
      connected: status.connected,
      sessionId: status.sessionId ?? '',
      browserName: status.browserName,
      extensionVersion: status.extensionVersion,
      activeTab: status.activeTab,
      tabs: status.tabs,
      authenticatedSites: status.authenticatedSites,
      userScriptsAvailable: status.userScriptsAvailable,
      lastSeenAt: status.lastSeenAt,
    },
  ];
}

function formatRuntime(runtime: RuntimeConnectionSnapshot): SessionStatusRuntimeResult {
  return {
    sessionId: runtime.sessionId,
    browserName: runtime.browserName,
    extensionVersion: runtime.extensionVersion,
    userScriptsAvailable: runtime.userScriptsAvailable,
    lastSeenAt: runtime.lastSeenAt,
    activeTab: runtime.activeTab ? formatTab(runtime.activeTab) : undefined,
    tabs: runtime.tabs.map(formatTab),
  };
}

function formatTab(tab: RuntimeTabSnapshot): SessionStatusTabResult {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    site: tab.site,
    readyState: tab.readyState,
  };
}

function collectRuntimeTabs(runtimes: SessionStatusRuntimeResult[]): SessionStatusTabResult[] {
  const tabsByRuntimeId = new Map<string, SessionStatusTabResult>();
  for (const runtime of runtimes) {
    if (runtime.activeTab) {
      tabsByRuntimeId.set(tabKey(runtime, runtime.activeTab), runtime.activeTab);
    }
    for (const tab of runtime.tabs) {
      tabsByRuntimeId.set(tabKey(runtime, tab), tab);
    }
  }
  return [...tabsByRuntimeId.values()];
}

function tabKey(runtime: SessionStatusRuntimeResult, tab: SessionStatusTabResult): string {
  return `${runtime.sessionId ?? 'runtime'}:${tab.tabId}`;
}

async function summarizeAvailableScriptSites(
  runtimes: SessionStatusRuntimeResult[],
  webCapPath: string,
  scriptSummaryCache: Map<string, Promise<AvailableScriptDirectorySummary>>,
): Promise<SessionStatusAvailableScriptSummary[]> {
  const activeDomains = collectActiveDomains(runtimes);
  const tabs = collectRuntimeTabs(runtimes);
  const domains = [...new Set(tabs.flatMap((tab) => domainsForUrl(tab.url)))].sort();
  domains.sort(
    (left, right) =>
      Number(activeDomains.has(right)) - Number(activeDomains.has(left)) ||
      left.localeCompare(right),
  );
  let remainingScriptLimit = TOTAL_AVAILABLE_SCRIPT_LIMIT;
  const summaries: SessionStatusAvailableScriptSummary[] = [];

  for (const domain of domains) {
    const directory = join(webCapPath, domain);
    let summary = scriptSummaryCache.get(domain);
    if (!summary) {
      summary = summarizeAvailableScripts(directory);
      scriptSummaryCache.set(domain, summary);
    }
    const resolved = await summary;
    const domainScriptLimit = activeDomains.has(domain)
      ? ACTIVE_TAB_AVAILABLE_SCRIPT_LIMIT
      : INACTIVE_TAB_AVAILABLE_SCRIPT_LIMIT;
    const scripts = resolved.scripts.slice(
      0,
      Math.min(domainScriptLimit, remainingScriptLimit),
    );
    remainingScriptLimit -= scripts.length;

    summaries.push({
      site: domain,
      count: resolved.count,
      directory,
      scripts,
    });
  }

  return summaries.filter((summary) => summary.count > 0);
}

function domainsForUrl(value: string): string[] {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!hostname) {
      return [];
    }

    const domains = [hostname];
    if (hostname.startsWith('www.')) {
      domains.push(hostname.slice(4));
    }
    return domains;
  } catch {
    return [];
  }
}

function collectActiveDomains(runtimes: SessionStatusRuntimeResult[]): Set<string> {
  const domains = new Set<string>();
  for (const runtime of runtimes) {
    if (!runtime.activeTab) {
      continue;
    }
    for (const domain of domainsForUrl(runtime.activeTab.url)) {
      domains.add(domain);
    }
  }
  return domains;
}

async function summarizeAvailableScripts(
  directory: string,
): Promise<AvailableScriptDirectorySummary> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name);
    const scripts = await Promise.all(
      files.map(async (name) => ({
        name,
        lastUsedAt: await getLastAccessedAt(join(directory, name)),
      })),
    );

    scripts.sort(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    );
    return {
      count: scripts.length,
      scripts: scripts.map((script) => script.name),
    };
  } catch {
    return { count: 0, scripts: [] };
  }
}

async function getLastAccessedAt(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).atimeMs;
  } catch {
    return 0;
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
