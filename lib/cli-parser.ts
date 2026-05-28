import { readFile } from 'node:fs/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import type { ExecuteScriptRequest } from './server/agent/contracts';
import type { ScriptSearchFilters } from '@shared/script-schema';
import { formatError } from './daemon-bootstrap';
import type { WebCapConfigKey } from './config';

export interface ScriptExecuteCliOptions {
  script?: string;
  scriptFile?: string;
  input?: string;
  inputFile?: string;
  tabId?: number;
  timeoutMs?: number;
  register?: boolean;
  compact?: boolean;
}

export interface JsonOutputCliOptions {
  compact?: boolean;
}

export interface ScriptSearchCliOptions extends JsonOutputCliOptions {
  query: string;
  type?: ScriptSearchFilters['type'];
  site?: string;
}

export interface ScriptGetCliOptions extends JsonOutputCliOptions {
  scriptId: string;
  version?: string;
}

export interface ScriptRegisterCliOptions extends JsonOutputCliOptions {
  definition?: string;
  definitionFile?: string;
}

export interface BrowserNewTabCliOptions extends JsonOutputCliOptions {
  url?: string;
  active?: boolean;
}

export interface WaitEventsCliOptions {
  durationMs?: number;
  tabId?: number;
}

export interface ConfigCliOptions extends JsonOutputCliOptions {
  action: 'get' | 'set' | 'list';
  key?: WebCapConfigKey;
  value?: boolean;
}

export type CliCommand =
  | { name: 'help'; text: string }
  | { name: 'mcp' }
  | { name: 'config'; options: ConfigCliOptions }
  | { name: 'session-status'; options: JsonOutputCliOptions }
  | { name: 'script-search'; options: ScriptSearchCliOptions }
  | { name: 'script-get'; options: ScriptGetCliOptions }
  | { name: 'script-execute'; options: ScriptExecuteCliOptions }
  | { name: 'script-register'; options: ScriptRegisterCliOptions }
  | { name: 'browser-new-tab'; options: BrowserNewTabCliOptions }
  | { name: 'wait-events'; options: WaitEventsCliOptions };

type CliCommandName = Exclude<CliCommand['name'], 'help'>;

export function parseCliArgs(argv: string[]): CliCommand {
  const [commandName, ...args] = argv;
  if (!commandName || commandName === '--help' || commandName === '-h') {
    return { name: 'help', text: usage() };
  }
  if (commandName === 'help') {
    return parseHelpArgs(args);
  }

  switch (commandName) {
    case 'mcp':
      return parseMcpArgs(args);
    case 'config':
      return parseConfigArgs(args);
    case 'session-status':
      return parseSessionStatusArgs(args);
    case 'script-search':
      return parseScriptSearchArgs(args);
    case 'script-get':
      return parseScriptGetArgs(args);
    case 'script-execute':
      return parseScriptExecuteArgs(args);
    case 'script-register':
      return parseScriptRegisterArgs(args);
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

  const inputRaw =
    options.input ?? (options.inputFile ? await readFile(options.inputFile, 'utf8') : '{}');
  const input = parseJsonObject(inputRaw, 'input');
  const request: ExecuteScriptRequest = {
    script,
    input,
  };

  const executionOptions: ExecuteScriptRequest['options'] = {};
  if (options.tabId !== undefined) {
    executionOptions.tabId = options.tabId;
  }
  if (options.timeoutMs !== undefined) {
    executionOptions.timeoutMs = options.timeoutMs;
  }
  if (Object.keys(executionOptions).length > 0) {
    request.options = executionOptions;
  }
  if (options.register === true) {
    request.register = true;
  }

  return request;
}

export async function buildScriptRegisterRequest(
  options: ScriptRegisterCliOptions,
): Promise<Record<string, unknown>> {
  if (options.definition && options.definitionFile) {
    throw new Error('Use either --definition or --definition-file, not both.');
  }

  const definitionRaw =
    options.definition ??
    (options.definitionFile ? await readFile(options.definitionFile, 'utf8') : undefined);
  if (!definitionRaw || definitionRaw.trim().length === 0) {
    throw new Error('script-register requires --definition or --definition-file.');
  }

  return parseJsonObject(definitionRaw, 'definition');
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

function parseConfigArgs(args: string[]): CliCommand {
  const command = createConfigParser();
  const result = parseCommander<{ compact?: boolean }>(command, args);
  if (result === 'help') {
    return helpForCommand(command);
  }

  const [action = 'list', key, value] = command.args;
  switch (action) {
    case 'list': {
      if (key !== undefined || value !== undefined) {
        throw new Error('config list does not accept a config key or value.');
      }
      return { name: 'config', options: { action: 'list', compact: result.compact } };
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
          compact: result.compact,
        },
      };
    }
    case 'set': {
      if (key === undefined || value === undefined) {
        throw new Error('config set requires a config key and true or false value.');
      }
      return {
        name: 'config',
        options: {
          action: 'set',
          key: parseConfigKeyOption(key),
          value: parseBooleanOption(value),
          compact: result.compact,
        },
      };
    }
    default:
      throw new Error(`Unknown config action: ${action}`);
  }
}

function parseScriptExecuteArgs(args: string[]): CliCommand {
  const command = createScriptExecuteParser();
  const options = parseCommander<ScriptExecuteCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'script-execute', options };
}

function parseSessionStatusArgs(args: string[]): CliCommand {
  const command = createSessionStatusParser();
  const options = parseCommander<JsonOutputCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'session-status', options };
}

function parseScriptSearchArgs(args: string[]): CliCommand {
  const command = createScriptSearchParser();
  const result = parseCommander<Omit<ScriptSearchCliOptions, 'query'> & { query?: string }>(
    command,
    args,
  );
  if (result === 'help') {
    return helpForCommand(command);
  }

  const query = result.query ?? command.args[0];
  if (!query) {
    throw new Error('script-search requires a query argument or --query value.');
  }

  return { name: 'script-search', options: { ...result, query } };
}

function parseScriptGetArgs(args: string[]): CliCommand {
  const command = createScriptGetParser();
  const result = parseCommander<Omit<ScriptGetCliOptions, 'scriptId'> & { scriptId?: string }>(
    command,
    args,
  );
  if (result === 'help') {
    return helpForCommand(command);
  }

  const scriptId = result.scriptId ?? command.args[0];
  if (!scriptId) {
    throw new Error('script-get requires a script id argument or --script-id value.');
  }

  return { name: 'script-get', options: { ...result, scriptId } };
}

function parseScriptRegisterArgs(args: string[]): CliCommand {
  const command = createScriptRegisterParser();
  const options = parseCommander<ScriptRegisterCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'script-register', options };
}

function parseBrowserNewTabArgs(args: string[]): CliCommand {
  const command = createBrowserNewTabParser();
  const options = parseCommander<BrowserNewTabCliOptions>(command, args);
  return options === 'help' ? helpForCommand(command) : { name: 'browser-new-tab', options };
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
  web-cap script-execute --script <code> [--input <json>] [--tab-id <id>] [--timeout-ms <ms>] [--register]
  web-cap script-execute --script-file <path> [--input-file <path>] [--compact]

  Runs JavaScript in the selected browser tab. Scripts receive one JSON object,
  return one JSON object, and can use cap.call(...) inside the script to call
  reusable capabilities.

  Scripts also receive a Playwright-style page API as global page and cap.page.
${scriptRuntimeApiHelp('  ')}

  --script <code>       Script source code to run in the browser tab.
  --script-file <path>  Read script source code from a file.
  --input <json>        JSON object passed to the script. Defaults to {}.
  --input-file <path>   Read the script input object from a file.
  --tab-id <id>         Browser tab id to target. Defaults to the active connected tab.
  --timeout-ms <ms>     Execution timeout in milliseconds.
  --register            Save the script for reuse only if it returns ok: true.
`;
}

function scriptRuntimeApiHelp(indent = ''): string {
  return `${indent}Use page.locator(...) and locator actions such as click(), fill(), count(),
${indent}textContent(), first(), nth(), waitFor(), and getByRole()/getByText().

${indent}Example:
${indent}  await page.getByRole('button', { name: 'Login' }).click();
${indent}  await page.locator('input[name=email]').fill(input.email);`;
}

function createCommandParser(commandName: CliCommandName): Command {
  switch (commandName) {
    case 'mcp':
      return createMcpParser();
    case 'config':
      return createConfigParser();
    case 'session-status':
      return createSessionStatusParser();
    case 'script-search':
      return createScriptSearchParser();
    case 'script-get':
      return createScriptGetParser();
    case 'script-execute':
      return createScriptExecuteParser();
    case 'script-register':
      return createScriptRegisterParser();
    case 'browser-new-tab':
      return createBrowserNewTabParser();
    case 'wait-events':
      return createWaitEventsParser();
  }
}

function cliCommandNames(): CliCommandName[] {
  return [
    'mcp',
    'config',
    'session-status',
    'script-search',
    'script-get',
    'script-execute',
    'script-register',
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

function createConfigParser(): Command {
  return createParser('config')
    .description('View or update persistent Web Cap CLI configuration.')
    .usage('[list|get|set] [key] [value] [options]')
    .argument('[action]')
    .argument('[key]')
    .argument('[value]')
    .option('--compact', 'Print compact JSON output.');
}

function createSessionStatusParser(): Command {
  return createJsonOutputParser('session-status').description(
    'Print connected browser status, known tabs, and runtime connection details.',
  );
}

function createScriptSearchParser(): Command {
  return createJsonOutputParser('script-search')
    .description('Search built-in and locally registered reusable scripts.')
    .argument('[query]')
    .option('--query <query>', 'Search query for reusable browser capabilities.')
    .addOption(
      new Option('--type <type>', 'Filter by script type: read or act.').choices(['read', 'act']),
    )
    .option('--site <site>', 'Filter results to scripts related to a site or domain.');
}

function createScriptGetParser(): Command {
  return createJsonOutputParser('script-get')
    .description('Print one script definition and its callable schema summary.')
    .argument('[script-id]')
    .option('--script-id <scriptId>', 'Script id to inspect.')
    .option('--version <version>', 'Script version to inspect.');
}

function createScriptExecuteParser(): Command {
  return createParser('script-execute')
    .description(
      'Run JavaScript in the selected browser tab with JSON input, observable page evidence, and Playwright-style page/locator helpers.',
    )
    .option('--script <code>', 'Script source code to run in the browser tab.')
    .option('--script-file <path>', 'Read script source code from a file.')
    .option('--input <json>', 'JSON object passed to the script. Defaults to {}.')
    .option('--input-file <path>', 'Read the script input object from a file.')
    .option('--tab-id <id>', 'Browser tab id to target.', parseIntegerOption)
    .option('--timeout-ms <ms>', 'Execution timeout in milliseconds.', parseIntegerOption)
    .option('--register', 'Save the script for reuse only if it returns ok: true.')
    .option('--compact', 'Print compact JSON output.');
}

function createScriptRegisterParser(): Command {
  return createJsonOutputParser('script-register')
    .description('Register a reusable script definition without running it.')
    .option('--definition <json>', 'JSON script definition to register.')
    .option('--definition-file <path>', 'Read JSON script definition from a file.');
}

function createBrowserNewTabParser(): Command {
  return createJsonOutputParser('browser-new-tab')
    .description('Create a tab in the connected browser.')
    .option('--url <url>', 'URL for the new tab.')
    .option('--active <true|false>', 'Whether the tab should be activated.', parseBooleanOption);
}

function createWaitEventsParser(): Command {
  return createParser('wait-events')
    .description('Stream page events from the connected browser as JSON Lines.')
    .option('--duration-ms <ms>', 'Event monitoring duration in milliseconds.', parseIntegerOption)
    .option('--tab-id <id>', 'Browser tab id to observe.', parseIntegerOption);
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
  return createParser(name).option('--compact', 'Print compact JSON output.');
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
  if (value === 'activateTabOnScriptExecute') {
    return value;
  }

  throw new Error(`Unknown config key: ${value}`);
}

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError('must be an integer.');
  }

  return parsed;
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
