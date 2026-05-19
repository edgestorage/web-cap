#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScriptExecuteRequest,
  buildScriptRegisterRequest,
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

export { buildScriptExecuteRequest, buildScriptRegisterRequest, parseCliArgs } from './cli-parser';

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
    const scriptRegisterRequest =
      command.name === 'script-register'
        ? await buildScriptRegisterRequest(command.options)
        : undefined;

    const app = await connect();
    try {
      const coreToolName = coreToolNameForCommand(command);
      if (coreToolName) {
        const result = await executeCoreTool(
          app,
          coreToolName,
          buildCoreToolInput(command, scriptExecuteRequest, scriptRegisterRequest),
        );
        writeJson(io, result, jsonOutputOptionsForCommand(command));
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
      value: current[options.key] ?? false,
      config: current,
    };
  }

  const next: WebCapConfig = {
    ...current,
    [options.key]: options.value ?? false,
  };
  const saved = await saveWebCapConfig(next);
  return {
    key: options.key,
    value: saved[options.key] ?? false,
    config: saved,
  };
}

async function applyConfiguredScriptExecutionOptions(
  request: ExecuteScriptRequest,
): Promise<void> {
  const config = await loadWebCapConfig();
  if (config.activateTabOnScriptExecute !== true) {
    return;
  }

  request.options = {
    ...request.options,
    activateTab: true,
  };
}

function coreToolNameForCommand(command: CliCommand): CoreToolName | undefined {
  switch (command.name) {
    case 'session-status':
      return 'session_status';
    case 'script-search':
      return 'script_search';
    case 'script-get':
      return 'script_get';
    case 'script-execute':
      return 'script_execute';
    case 'script-register':
      return 'script_register';
    case 'browser-new-tab':
      return 'browser_new_tab';
    default:
      return undefined;
  }
}

function buildCoreToolInput(
  command: CliCommand,
  scriptExecuteRequest: ExecuteScriptRequest | undefined,
  scriptRegisterRequest: Record<string, unknown> | undefined,
): unknown {
  switch (command.name) {
    case 'session-status':
      return {};
    case 'script-search':
      return {
        query: command.options.query,
        filters: {
          type: command.options.type,
          site: command.options.site,
        },
      };
    case 'script-get':
      return {
        scriptId: command.options.scriptId,
        version: command.options.version,
      };
    case 'script-execute':
      return scriptExecuteRequest!;
    case 'script-register':
      return { scriptDefinition: scriptRegisterRequest! };
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
    case 'script-search':
    case 'script-get':
    case 'script-execute':
    case 'script-register':
    case 'browser-new-tab':
    case 'config':
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
  io.stdout.write(`${JSON.stringify(value, null, options.compact ? 0 : 2)}\n`);
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
