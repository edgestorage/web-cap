#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScriptExecuteRequest,
  parseCliArgs,
  type CliCommand,
  type JsonOutputCliOptions,
} from './cli-parser';
import {
  loadWebCapConfig,
  saveWebCapConfig,
  type WebCapConfig,
} from './config';
import { connectToDaemon } from './daemon-client';
import type { ExecuteScriptRequest, WebCapAgentService } from './server/agent/contracts';
import { executeCoreTool, type CoreToolName } from './server/tool-contracts';
import { runMcpServer } from './mcp-server';

export { buildScriptExecuteRequest, parseCliArgs } from './cli-parser';

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  connect: () => Promise<WebCapAgentService> = connectToDaemon,
  runMcp: (connect: () => Promise<WebCapAgentService>) => Promise<void> = runMcpServer,
): Promise<number> {
  try {
    const command = parseCliArgs(argv);
    if (command.name === 'help') {
      io.stdout.write(`${command.text}\n`);
      return 0;
    }
    if (command.name === 'version') {
      io.stdout.write(`${readPackageVersion()}\n`);
      return 0;
    }
    if (command.name === 'mcp') {
      await runMcp(connect);
      return 0;
    }
    if (command.name === 'config') {
      const result = await handleConfigCommand(command.options);
      writeJson(io, result, command.options);
      return 0;
    }

    const scriptExecuteRequest =
      command.name === 'script-execute'
        ? await buildScriptExecuteRequest(command.options)
        : undefined;
    if (scriptExecuteRequest) {
      await applyConfiguredScriptExecutionOptions(scriptExecuteRequest);
    }
    const app = await connect();
    try {
      const coreToolName = coreToolNameForCommand(command);
      if (coreToolName) {
        const result = await executeCoreTool(
          app,
          coreToolName,
          buildCoreToolInput(command, scriptExecuteRequest),
        );
        writeJson(io, result, jsonOutputOptionsForCommand(command));
        return 0;
      }

      if (command.name === 'userscript') {
        const result = await handleUserScriptCommand(app, command.options);
        writeJson(io, result, command.options);
        await writeUserScriptAvailabilityHint(app, io);
        return 0;
      }

      if (command.name !== 'wait-events') {
        throw new Error(`Unsupported command: ${command.name}`);
      }

      const result = await app.browserWaitEvents(command.options, (event) => {
        io.stdout.write(`${JSON.stringify({ type: 'event', event })}\n`);
      });
      io.stdout.write(`${JSON.stringify({ type: 'done', result })}\n`);
      return 0;
    } finally {
      await app.close().catch(() => undefined);
    }
  } catch (error) {
    io.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

async function handleUserScriptCommand(
  app: WebCapAgentService,
  options: Extract<CliCommand, { name: 'userscript' }>['options'],
): Promise<unknown> {
  switch (options.action) {
    case 'install':
      return await app.userScriptInstall({
        filePath: options.file!,
        applyNow: options.applyNow,
      });
    case 'enable':
      return await app.userScriptEnable({
        id: options.id!,
        applyNow: options.applyNow,
      });
    case 'disable':
      return await app.userScriptDisable({
        id: options.id!,
      });
    case 'remove':
      return await app.userScriptRemove({ id: options.id! });
    case 'show': {
      const script = (await app.userScriptList()).find((candidate) => candidate.id === options.id);
      if (!script) {
        throw new Error(`User script ${options.id} was not found.`);
      }
      return script;
    }
    case 'list':
      return { userscripts: await app.userScriptList() };
  }
}

async function writeUserScriptAvailabilityHint(
  app: WebCapAgentService,
  io: CliIo,
): Promise<void> {
  try {
    const status = await app.sessionStatus();
    const runtimes = status.runtimes ?? [];
    const userScriptsAvailable =
      status.userScriptsAvailable === true ||
      runtimes.some((runtime) => runtime.userScriptsAvailable === true);
    if (userScriptsAvailable) {
      return;
    }

    const reason = status.connected
      ? 'The connected browser runtime has not enabled chrome.userScripts.'
      : 'No browser runtime is connected, so installed userscripts cannot be registered yet.';
    io.stderr.write(
      `WEB_CAP userscript notice: ${reason} Enable the extension's user scripts support and reconnect the runtime.\n`,
    );
  } catch {
    io.stderr.write(
      'WEB_CAP userscript notice: Could not verify browser user scripts support. Enable the extension user scripts support before expecting automatic injection.\n',
    );
  }
}

async function handleConfigCommand(
  options: Extract<CliCommand, { name: 'config' }>['options'],
): Promise<Record<string, unknown>> {
  const current = await loadWebCapConfig();
  if (options.action === 'list') {
    return { config: current };
  }

  if (!options.key) {
    throw new Error(`config ${options.action} requires a config key.`);
  }

  if (options.action === 'get') {
    return {
      key: options.key,
      value: readDefaultedConfigValue(current, options.key),
      config: current,
    };
  }

  const next: WebCapConfig = {
    ...current,
    [options.key]: options.value ?? readDefaultConfigValue(options.key),
  };
  const saved = await saveWebCapConfig(next);
  return {
    key: options.key,
    value: readDefaultedConfigValue(saved, options.key),
    config: saved,
  };
}

async function applyConfiguredScriptExecutionOptions(
  request: ExecuteScriptRequest,
): Promise<void> {
  const config = await loadWebCapConfig();
  const evidence = config.evidence ?? ['common'];

  if (config.activateTabOnScriptExecute === true) {
    request.options = {
      ...request.options,
      activateTab: true,
    };
  }

  if (config.mouseTrajectorySimulation === true) {
    request.options = {
      ...request.options,
      mouseTrajectorySimulation: true,
    };
  }

  if (evidence.length > 0) {
    request.options = {
      ...request.options,
      evidence,
    };
  }
}

function readDefaultedConfigValue(
  config: WebCapConfig,
  key: keyof WebCapConfig,
): boolean | string[] {
  return config[key] ?? readDefaultConfigValue(key);
}

function readDefaultConfigValue(key: keyof WebCapConfig): boolean | string[] {
  return key === 'evidence' ? ['common'] : false;
}

function coreToolNameForCommand(command: CliCommand): CoreToolName | undefined {
  switch (command.name) {
    case 'session-status':
      return 'session_status';
    case 'script-execute':
      return 'script_execute';
    case 'browser-screenshot':
      return 'browser_screenshot';
    case 'browser-new-tab':
      return 'browser_new_tab';
    default:
      return undefined;
  }
}

function buildCoreToolInput(
  command: CliCommand,
  scriptExecuteRequest: ExecuteScriptRequest | undefined,
): unknown {
  switch (command.name) {
    case 'session-status':
      return {};
    case 'script-execute':
      return scriptExecuteRequest!;
    case 'browser-screenshot':
      return {
        tabId: command.options.tabId,
        type: command.options.type,
        quality: command.options.quality,
        omitBackground: command.options.omitBackground,
      };
    case 'browser-new-tab':
      return {
        url: command.options.url,
        active: command.options.active,
      };
    default:
      return {};
  }
}

function jsonOutputOptionsForCommand(command: CliCommand): JsonOutputCliOptions {
  switch (command.name) {
    case 'session-status':
    case 'script-execute':
    case 'browser-screenshot':
    case 'browser-new-tab':
    case 'config':
    case 'userscript':
      return command.options;
    default:
      return {};
  }
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `WEB_CAP CLI failed: ${message}`;
}

function writeJson(io: CliIo, value: unknown, options: JsonOutputCliOptions): void {
  io.stdout.write(`${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`);
}

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('Package version is unavailable.');
  }

  return packageJson.version;
}

if (isDirectEntryPoint(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

function isDirectEntryPoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(moduleUrl) === argvPath;
  }
}
