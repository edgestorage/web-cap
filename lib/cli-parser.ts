import { readFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import type { ExecuteScriptRequest } from './server/agent/contracts';
import { formatError } from './daemon-bootstrap';
import type { WebCapConfigKey, WebCapEvidenceConfig } from './config';

export interface ScriptExecuteCliOptions {
  script?: string;
  scriptFile?: string;
  input?: string;
  inputFile?: string;
  tabId?: number;
  timeoutMs?: number;
  register?: boolean;
  pretty?: boolean;
}

export interface JsonOutputCliOptions {
  pretty?: boolean;
}

export interface BrowserNewTabCliOptions extends JsonOutputCliOptions {
  url?: string;
  active?: boolean;
}

export interface BrowserScreenshotCliOptions extends JsonOutputCliOptions {
  tabId?: number;
  type?: 'png' | 'jpeg';
  quality?: number;
  omitBackground?: boolean;
}

export interface WaitEventsCliOptions {
  durationMs?: number;
  tabId?: number;
}

export interface ConfigCliOptions extends JsonOutputCliOptions {
  action: 'get' | 'set' | 'list';
  key?: WebCapConfigKey;
  value?: boolean | WebCapEvidenceConfig;
}

export interface UserScriptCliOptions extends JsonOutputCliOptions {
  action: 'install' | 'list' | 'remove' | 'show' | 'enable' | 'disable';
  file?: string;
  id?: string;
  applyNow?: boolean;
}

export type CliCommand =
  | { name: 'help'; text: string }
  | { name: 'version' }
  | { name: 'mcp' }
  | { name: 'config'; options: ConfigCliOptions }
  | { name: 'userscript'; options: UserScriptCliOptions }
  | { name: 'session-status'; options: JsonOutputCliOptions }
  | { name: 'script-execute'; options: ScriptExecuteCliOptions }
  | { name: 'browser-screenshot'; options: BrowserScreenshotCliOptions }
  | { name: 'browser-new-tab'; options: BrowserNewTabCliOptions }
  | { name: 'wait-events'; options: WaitEventsCliOptions };

type CliCommandName = Exclude<CliCommand['name'], 'help'>;

export function parseCliArgs(argv: string[]): CliCommand {
  const [commandName, ...args] = argv;
  if (!commandName || commandName === '--help' || commandName === '-h') {
    return { name: 'help', text: usage() };
  }
  if (commandName === '--version' || commandName === '-V') {
    return { name: 'version' };
  }
  if (commandName === 'help') {
    return parseHelpArgs(args);
  }

  switch (commandName) {
    case 'version':
      return parseVersionArgs(args);
    case 'mcp':
      return parseMcpArgs(args);
    case 'config':
      return parseConfigArgs(args);
    case 'userscript':
      return parseUserScriptArgs(args);
    case 'session-status':
      return parseSessionStatusArgs(args);
    case 'script-execute':
      return parseScriptExecuteArgs(args);
    case 'browser-screenshot':
      return parseBrowserScreenshotArgs(args);
    case 'browser-new-tab':
      return parseBrowserNewTabArgs(args);
    case 'wait-events':
      return parseWaitEventsArgs(args);
    default:
      throw new Error(`Unknown command: ${commandName}`);
  }
}

function parseHelpArgs(args: string[]): CliCommand {
  const [commandName, ...extraArgs] = args;
  if (!commandName || commandName === '--help' || commandName === '-h') {
    return { name: 'help', text: usage() };
  }
  if (extraArgs.length > 0) {
    throw new Error('help accepts at most one command name.');
  }
  if (!isCliCommandName(commandName)) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  return helpForCommand(createCommandParser(commandName));
}

export async function buildScriptExecuteRequest(
  options: ScriptExecuteCliOptions,
): Promise<ExecuteScriptRequest> {
  if (options.script && options.scriptFile) {
    throw new Error('Use either --script or --script-file, not both.');
  }
  if (options.input && options.inputFile) {
    throw new Error('Use either --input or --input-file, not both.');
  }

  const script =
    options.script ?? (options.scriptFile ? await readFile(options.scriptFile, 'utf8') : undefined);
  if (!script || script.trim().length === 0) {
    throw new Error('script-execute requires --script or --script-file.');
  }
  if (options.tabId === undefined) {
    throw new Error('script-execute requires --tab-id.');
  }

  const inputRaw =
    options.input ?? (options.inputFile ? await readFile(options.inputFile, 'utf8') : '{}');
  const input = parseJsonObject(inputRaw, 'input');
  const executionOptions: NonNullable<ExecuteScriptRequest['options']> = {
    tabId: options.tabId,
  };
  const request: ExecuteScriptRequest = {
    script,
    input,
    options: executionOptions,
  };

  if (options.timeoutMs !== undefined) {
    executionOptions.timeoutMs = options.timeoutMs;
  }
  if (options.register === true) {
    request.register = true;
  }

  return request;
}

export function usage(): string {
  return `${createRootHelpParser().helpInformation()}
${scriptExecutionHelp()}`;
}

function parseMcpArgs(args: string[]): CliCommand {
  const command = createMcpParser();
  if (parseCommander(command, args) === 'help') {
    return helpForCommand(command);
  }
  return { name: 'mcp' };
}

function parseVersionArgs(args: string[]): CliCommand {
  const command = createVersionParser();
  if (parseCommander(command, args) === 'help') {
    return helpForCommand(command);
  }
  return { name: 'version' };
}

function parseConfigArgs(args: string[]): CliCommand {
  const command = createConfigParser();
  const result = parseCommander<JsonOutputCliOptions>(command, args);
  if (result === 'help') {
    return helpForCommand(command);
  }

  const [action = 'list', key, value] = command.args;
  switch (action) {
    case 'list': {
      if (key !== undefined || value !== undefined) {
        throw new Error('config list does not accept a config key or value.');
      }
      return {
        name: 'config',
        options: { action: 'list', pretty: result.pretty },
      };
    }
    case 'get': {
      if (key === undefined || value !== undefined) {
        throw new Error('config get requires exactly one config key.');
      }
      return {
        name: 'config',
        options: {
          action: 'get',
          key: parseConfigKeyOption(key),
          pretty: result.pretty,
        },
      };
    }
    case 'set': {
      if (key === undefined || value === undefined) {
        throw new Error('config set requires a config key and value.');
      }
      const configKey = parseConfigKeyOption(key);
      return {
        name: 'config',
        options: {
          action: 'set',
          key: configKey,
          value: parseConfigValueOption(configKey, value),
          pretty: result.pretty,
        },
      };
    }
    default:
      throw new Error(`Unknown config action: ${action}`);
  }
}

function parseUserScriptArgs(args: string[]): CliCommand {
  const command = createUserScriptParser();
  const options = parseCommander<{ file?: string; pretty?: boolean; applyNow?: boolean }>(
    command,
    args,
  );
  if (options === 'help') {
    return helpForCommand(command);
  }

  const [action = 'list', id, ...extraArgs] = command.args;
  if (extraArgs.length > 0) {
    throw new Error('userscript accepts at most one id argument.');
  }
  switch (action) {
    case 'list':
      if (id) {
        throw new Error('userscript list does not accept an id argument.');
      }
      if (options.file) {
        throw new Error('userscript list does not accept --file.');
      }
      if (options.applyNow) {
        throw new Error('userscript list does not accept --apply-now.');
      }
      return { name: 'userscript', options: { action: 'list', pretty: options.pretty } };
    case 'install':
      if (id) {
        throw new Error('userscript install does not accept an id argument.');
      }
      if (!options.file) {
        throw new Error('userscript install requires --file.');
      }
      return {
        name: 'userscript',
        options: {
          action: 'install',
          file: options.file,
          applyNow: options.applyNow,
          pretty: options.pretty,
        },
      };
    case 'enable':
      if (options.file) {
        throw new Error(`userscript ${action} does not accept --file.`);
      }
      if (!id) {
        throw new Error(`userscript ${action} requires an id.`);
      }
      return {
        name: 'userscript',
        options: {
          action,
          id,
          applyNow: options.applyNow,
          pretty: options.pretty,
        },
      };
    case 'disable':
      if (options.file) {
        throw new Error('userscript disable does not accept --file.');
      }
      if (options.applyNow) {
        throw new Error('userscript disable does not accept --apply-now.');
      }
      if (!id) {
        throw new Error('userscript disable requires an id.');
      }
      return {
        name: 'userscript',
        options: {
          action,
          id,
          pretty: options.pretty,
        },
      };
    case 'remove':
      if (options.applyNow) {
        throw new Error('userscript remove does not accept --apply-now.');
      }
      if (options.file) {
        throw new Error('userscript remove does not accept --file.');
      }
      if (!id) {
        throw new Error('userscript remove requires an id.');
      }
      return {
        name: 'userscript',
        options: {
          action: 'remove',
          id,
          pretty: options.pretty,
        },
      };
    case 'show':
      if (options.applyNow) {
        throw new Error('userscript show does not accept --apply-now.');
      }
      if (options.file) {
        throw new Error('userscript show does not accept --file.');
      }
      if (!id) {
        throw new Error('userscript show requires an id.');
      }
      return {
        name: 'userscript',
        options: {
          action: 'show',
          id,
          pretty: options.pretty,
        },
      };
    default:
      throw new Error(`Unknown userscript action: ${action}`);
  }
}

function parseScriptExecuteArgs(args: string[]): CliCommand {
  const command = createScriptExecuteParser();
  const options = parseCommander<ScriptExecuteCliOptions>(command, args);
  if (options === 'help') {
    return helpForCommand(command);
  }
  if (options.tabId === undefined) {
    throw new Error('script-execute requires --tab-id.');
  }
  return { name: 'script-execute', options };
}

function parseSessionStatusArgs(args: string[]): CliCommand {
  const command = createSessionStatusParser();
  const options = parseCommander<JsonOutputCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'session-status', options };
}

function parseBrowserNewTabArgs(args: string[]): CliCommand {
  const command = createBrowserNewTabParser();
  const options = parseCommander<BrowserNewTabCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'browser-new-tab', options };
}

function parseBrowserScreenshotArgs(args: string[]): CliCommand {
  const command = createBrowserScreenshotParser();
  const options = parseCommander<BrowserScreenshotCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'browser-screenshot', options };
}

function parseWaitEventsArgs(args: string[]): CliCommand {
  const command = createWaitEventsParser();
  const options = parseCommander<WaitEventsCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'wait-events', options };
}

function createRootHelpParser(): Command {
  const command = createParser('web-cap')
    .description(
      'Local-first browser automation CLI for agents. Inspect real tabs, run in-page scripts, and save successful scripts as reusable capabilities.',
    )
    .usage('<command> [options]');
  for (const commandName of cliCommandNames()) {
    command.addCommand(createCommandParser(commandName));
  }
  return command;
}

function scriptExecutionHelp(): string {
  return `Script execution:
  web-cap script-execute --tab-id <id> --script <code> [--input <json>] [--timeout-ms <ms>] [--register]
  web-cap script-execute --tab-id <id> --script-file <path> [--input-file <path>] [--pretty]

  Runs JavaScript in the selected browser tab. Scripts receive one JSON object,
  return one JSON object, and can use the Playwright-style page API.

  Scripts also receive a Playwright-style page API as global page and cap.page,
  plus cap.goto(url, input) for controlled multi-page workflows.
${scriptRuntimeApiHelp('  ')}

  --script <code>       Script source code to run in the browser tab.
  --script-file <path>  Read script source code from a file.
  --input <json>        JSON object passed to the script. Defaults to {}.
  --input-file <path>   Read the script input object from a file.
  --tab-id <id>         Required browser tab id to target. Use session-status to find it.
  --timeout-ms <ms>     Execution timeout in milliseconds.
  --register            Save the script for reuse only if it returns ok: true.
  --pretty              Print formatted JSON output. Default output is compact.
`;
}

function scriptRuntimeApiHelp(indent = ''): string {
  return `${indent}Use page.locator(...) and locator actions such as click(), fill(), count(),
${indent}textContent(), first(), nth(), waitFor(), and getByRole()/getByText().

${indent}Example:
${indent}  await page.getByRole('button', { name: 'Login' }).click();
${indent}  await page.locator('input[name=email]').fill(input.email);
${indent}  return cap.goto('/next-page', { step: 'next' });`;
}

function createCommandParser(commandName: CliCommandName): Command {
  switch (commandName) {
    case 'version':
      return createVersionParser();
    case 'mcp':
      return createMcpParser();
    case 'config':
      return createConfigParser();
    case 'userscript':
      return createUserScriptParser();
    case 'session-status':
      return createSessionStatusParser();
    case 'script-execute':
      return createScriptExecuteParser();
    case 'browser-screenshot':
      return createBrowserScreenshotParser();
    case 'browser-new-tab':
      return createBrowserNewTabParser();
    case 'wait-events':
      return createWaitEventsParser();
  }
}

function cliCommandNames(): CliCommandName[] {
  return [
    'version',
    'mcp',
    'config',
    'userscript',
    'session-status',
    'script-execute',
    'browser-screenshot',
    'browser-new-tab',
    'wait-events',
  ];
}

function isCliCommandName(commandName: string): commandName is CliCommandName {
  return cliCommandNames().includes(commandName as CliCommandName);
}

function createMcpParser(): Command {
  return createParser('mcp').description('Run the stdio MCP server for agent clients.');
}

function createVersionParser(): Command {
  return createParser('version').description('Print the Web Cap CLI version.');
}

function createConfigParser(): Command {
  return createParser('config')
    .description('View or update persistent Web Cap CLI configuration.')
    .usage('[list|get|set] [key] [value] [options]')
    .argument('[action]')
    .argument('[key]')
    .argument('[value]')
    .option('--pretty', 'Print formatted JSON output.');
}

function createUserScriptParser(): Command {
  return createParser('userscript')
    .description(
      'Install, inspect, and remove page userscripts that automatically run on matching browser pages.',
    )
    .usage('[install|list|show|enable|disable|remove] [id] [options]')
    .argument('[action]')
    .argument('[id]')
    .option('--file <path>', 'JSDoc-style web-cap userscript file to install.')
    .option('--apply-now', 'Immediately run the installed or enabled userscript on matching open tabs.')
    .option('--pretty', 'Print formatted JSON output.');
}

function createSessionStatusParser(): Command {
  return createJsonOutputParser('session-status').description(
    'Print browser runtime status, known tabs, and available script counts by tab site.',
  );
}

function createScriptExecuteParser(): Command {
  return createParser('script-execute')
    .description(
      'Run JavaScript in the selected browser tab with JSON input, optional observable page evidence, and Playwright-style page/locator helpers.',
    )
    .option('--script <code>', 'Script source code to run in the browser tab.')
    .option('--script-file <path>', 'Read script source code from a file.')
    .option('--input <json>', 'JSON object passed to the script. Defaults to {}.')
    .option('--input-file <path>', 'Read the script input object from a file.')
    .requiredOption('--tab-id <id>', 'Browser tab id to target.', parseIntegerOption)
    .option('--timeout-ms <ms>', 'Execution timeout in milliseconds.', parseIntegerOption)
    .option('--register', 'Save the script for reuse only if it returns ok: true.')
    .option('--pretty', 'Print formatted JSON output.');
}

function createBrowserNewTabParser(): Command {
  return createJsonOutputParser('browser-new-tab')
    .description('Create a tab in the connected browser.')
    .option('--url <url>', 'URL for the new tab.')
    .option('--active <true|false>', 'Whether the tab should be activated.', parseBooleanOption);
}

function createBrowserScreenshotParser(): Command {
  return createJsonOutputParser('browser-screenshot')
    .description('Capture a screenshot from the connected browser tab.')
    .option('--tab-id <id>', 'Browser tab id to target. Defaults to the active tab.', parseIntegerOption)
    .option('--type <png|jpeg>', 'Screenshot image format. Defaults to png.', parseScreenshotTypeOption)
    .option('--quality <0-100>', 'JPEG quality. Only applies when --type jpeg.', parseIntegerOption)
    .option('--omit-background <true|false>', 'Hide the default white background when supported.', parseBooleanOption);
}

function createWaitEventsParser(): Command {
  return createParser('wait-events')
    .description('Wait while the user completes a browser action and stream the resulting interaction path as JSON Lines.')
    .option('--duration-ms <ms>', 'How long to wait for the user to complete the browser action, in milliseconds.', parseIntegerOption)
    .option('--tab-id <id>', 'Browser tab id where the user action path should be observed.', parseIntegerOption);
}

function helpForCommand(command: Command): CliCommand {
  const runtimeHelp =
    command.name() === 'script-execute'
      ? `\nRuntime script APIs:\n  page / cap.page  Playwright-style Page helper for the current tab.\n  page.locator()   Create a Playwright-style Locator helper.\n${scriptRuntimeApiHelp('  ')}\n`
      : '';
  return { name: 'help', text: `${command.helpInformation()}${runtimeHelp}` };
}

function createParser(name: string): Command {
  return new Command(name)
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .allowUnknownOption(false)
    .allowExcessArguments(false);
}

function createJsonOutputParser(name: string): Command {
  return createParser(name).option('--pretty', 'Print formatted JSON output.');
}

function parseCommander<T extends object>(command: Command, args: string[]): T | 'help' {
  try {
    command.parse(args, { from: 'user' });
  } catch (error) {
    if (isCommanderHelp(error)) {
      return 'help';
    }
    throw new Error(formatCommanderError(error));
  }

  return command.opts<T>();
}

function isCommanderHelp(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'commander.helpDisplayed'
  );
}

function formatCommanderError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return formatError(error);
}

function parseConfigKeyOption(value: string): WebCapConfigKey {
  if (
    value === 'activateTabOnScriptExecute' ||
    value === 'evidence' ||
    value === 'executionPageIndicator' ||
    value === 'executionTabGroupIndicator' ||
    value === 'mouseTrajectorySimulation'
  ) {
    return value;
  }

  throw new Error(`Unknown config key: ${value}`);
}

function parseConfigValueOption(
  key: WebCapConfigKey,
  value: string,
): boolean | WebCapEvidenceConfig {
  if (key === 'evidence') {
    return parseEvidenceConfigOption(value);
  }

  return parseBooleanOption(value);
}

function parseEvidenceConfigOption(value: string): WebCapEvidenceConfig {
  const options = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (options.length === 0) {
    throw new Error('evidence config requires events, visibleElements, common, all, or a comma-separated list.');
  }

  const parsed: WebCapEvidenceConfig = [];
  for (const option of options) {
    if (
      option !== 'events' &&
      option !== 'visibleElements' &&
      option !== 'common' &&
      option !== 'all'
    ) {
      throw new Error(`Unknown evidence option: ${option}`);
    }
    if (!parsed.includes(option)) {
      parsed.push(option);
    }
  }

  return parsed;
}

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError('must be an integer.');
  }

  return parsed;
}

function parseScreenshotTypeOption(value: string): 'png' | 'jpeg' {
  if (value !== 'png' && value !== 'jpeg') {
    throw new InvalidArgumentError('Expected png or jpeg.');
  }
  return value;
}

function parseBooleanOption(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new InvalidArgumentError('must be true or false.');
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${formatError(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}
