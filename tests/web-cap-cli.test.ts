import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScriptRegisterRequest,
  buildScriptExecuteRequest,
  parseCliArgs,
  runCli,
} from '../lib/cli';
import type { ExecuteScriptRequest, WebCapAgentService } from '../lib/server/app';

describe('WEB_CAP CLI', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
    delete process.env.WEB_CAP_STATE_DIR;
  });

  function createService(overrides: Partial<WebCapAgentService>): WebCapAgentService {
    return {
      async start() {},
      async close() {},
      async scriptSearch() {
        return [];
      },
      async scriptGet() {
        throw new Error('not used');
      },
      async scriptExecute() {
        throw new Error('not used');
      },
      async scriptHistoryList() {
        return [];
      },
      async scriptRegistryList() {
        return [];
      },
      async scriptRegister() {
        throw new Error('not used');
      },
      async browserNewTab() {
        throw new Error('not used');
      },
      async browserWaitEvents() {
        throw new Error('not used');
      },
      sessionStatus() {
        return {
          connected: false,
          tabs: [],
          authenticatedSites: [],
        };
      },
      ...overrides,
    } as WebCapAgentService;
  }

  it('parses script-execute arguments into a one-shot execution request', async () => {
    const command = parseCliArgs([
      'script-execute',
      '--script',
      'export default async function () { return { ok: true }; }',
      '--input',
      '{"name":"Ada"}',
      '--tab-id',
      '42',
      '--timeout-ms',
      '60000',
      '--register',
    ]);

    expect(command).toMatchObject({
      name: 'script-execute',
      options: {
        script: 'export default async function () { return { ok: true }; }',
        input: '{"name":"Ada"}',
        tabId: 42,
        timeoutMs: 60_000,
        register: true,
      },
    });

    if (command.name !== 'script-execute') {
      throw new Error('Expected script-execute command.');
    }

    await expect(buildScriptExecuteRequest(command.options)).resolves.toEqual({
      script: 'export default async function () { return { ok: true }; }',
      input: { name: 'Ada' },
      options: {
        tabId: 42,
        timeoutMs: 60_000,
      },
      register: true,
    });
  });

  it('loads script and input from files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-cli-test-'));
    const scriptFile = join(tempDir, 'script.js');
    const inputFile = join(tempDir, 'input.json');
    await writeFile(scriptFile, 'export default async function () { return { ok: true }; }');
    await writeFile(inputFile, '{"ok":true}');

    await expect(
      buildScriptExecuteRequest({
        scriptFile,
        inputFile,
      }),
    ).resolves.toEqual({
      script: 'export default async function () { return { ok: true }; }',
      input: { ok: true },
    });
  });

  it('parses wait-events arguments', () => {
    expect(parseCliArgs(['wait-events', '--duration-ms', '2500', '--tab-id', '9'])).toEqual({
      name: 'wait-events',
      options: {
        durationMs: 2500,
        tabId: 9,
      },
    });
  });

  it('parses MCP-equivalent utility commands', () => {
    expect(parseCliArgs(['mcp'])).toEqual({ name: 'mcp' });
    expect(parseCliArgs(['session-status', '--compact'])).toEqual({
      name: 'session-status',
      options: { compact: true },
    });
    expect(parseCliArgs(['script-search', 'inspect page', '--type', 'act', '--site', 'docs'])).toEqual({
      name: 'script-search',
      options: {
        query: 'inspect page',
        type: 'act',
        site: 'docs',
      },
    });
    expect(parseCliArgs(['script-get', 'builtin.page.inspect', '--version', '1.0.0'])).toEqual({
      name: 'script-get',
      options: {
        scriptId: 'builtin.page.inspect',
        version: '1.0.0',
      },
    });
    expect(parseCliArgs(['browser-new-tab', '--url', 'https://example.com', '--active', 'false'])).toEqual({
      name: 'browser-new-tab',
      options: {
        url: 'https://example.com',
        active: false,
      },
    });
    expect(parseCliArgs(['config', 'set', 'activateTabOnScriptExecute', 'true'])).toEqual({
      name: 'config',
      options: {
        action: 'set',
        key: 'activateTabOnScriptExecute',
        value: true,
      },
    });
  });

  it('prints top-level help with expanded script-execute guidance only', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['--help'], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: web-cap <command> [options]');
    expect(stdout).toContain('Local-first browser automation CLI for agents.');
    expect(stdout).toContain('save successful scripts as reusable capabilities.');
    expect(stdout).toContain('Commands:');
    expect(stdout).toContain('script-execute');
    expect(stdout).toContain('Script execution:');
    expect(stdout).toContain('web-cap script-execute --script <code>');
    expect(stdout).toContain('Runs JavaScript in the selected browser tab.');
    expect(stdout).toContain('use cap.call(...) inside the script');
    expect(stdout).toContain('Playwright-style page API as global page and cap.page');
    expect(stdout).toContain("await page.getByRole('button', { name: 'Login' }).click();");
    expect(stdout).toContain("await page.locator('input[name=email]').fill(input.email);");
    expect(stdout).toContain('--script-file <path>');
    expect(stdout).toContain('--timeout-ms <ms>');
    expect(stdout).not.toContain('--definition-file');
    expect(stdout).not.toContain('--active <true|false>');
    expect(stdout).not.toContain('--duration-ms <ms>');
  });

  it('prints command-specific help for script-execute', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['script-execute', '--help'], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: script-execute [options]');
    expect(stdout).toContain('Run JavaScript in the selected browser tab');
    expect(stdout).toContain('Playwright-style page/locator helpers');
    expect(stdout).toContain('Runtime script APIs:');
    expect(stdout).toContain('page / cap.page');
    expect(stdout).toContain('page.locator()');
    expect(stdout).not.toContain('inline script code through the local runtime daemon');
    expect(stdout).toContain('--script <code>');
    expect(stdout).toContain('--script-file <path>');
    expect(stdout).toContain('--input <json>');
    expect(stdout).not.toContain('--definition');
    expect(stdout).not.toContain('browser-new-tab');
  });

  it('prints command-specific help through the help command', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['help', 'script-execute'], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: script-execute [options]');
    expect(stdout).toContain('--script <code>');
    expect(stdout).toContain('Runtime script APIs:');
    expect(stdout).toContain('page.locator()');
    expect(stdout).not.toContain('Usage: web-cap <command> [options]');
    expect(stdout).not.toContain('browser-new-tab');
  });

  it('loads script-register definition from JSON and files', async () => {
    const definition = {
      id: 'local.test',
      name: 'Test script',
      version: '1.0.0',
      status: 'active',
      type: 'act',
    };

    await expect(
      buildScriptRegisterRequest({
        definition: JSON.stringify(definition),
      }),
    ).resolves.toEqual(definition);

    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-cli-test-'));
    const definitionFile = join(tempDir, 'definition.json');
    await writeFile(definitionFile, JSON.stringify(definition));

    await expect(
      buildScriptRegisterRequest({
        definitionFile,
      }),
    ).resolves.toEqual(definition);
  });

  it('routes MCP-equivalent commands through the injected service', async () => {
    const calls: string[] = [];
    const service = createService({
      sessionStatus() {
        calls.push('sessionStatus');
        return {
          connected: true,
          tabs: [],
          authenticatedSites: [],
        };
      },
      async scriptSearch(query, filters) {
        calls.push(`scriptSearch:${query}:${filters?.type ?? ''}:${filters?.site ?? ''}`);
        return [
          {
            scriptId: 'builtin.page.inspect',
            name: 'Inspect current page',
            summary: 'Inspect current page.',
            type: 'act',
            target: { site: 'generic-web' },
            tags: ['builtin'],
            score: 1,
          },
        ];
      },
      async scriptGet(scriptId, version) {
        calls.push(`scriptGet:${scriptId}:${version ?? ''}`);
        return {
          scriptId,
          name: 'Inspect current page',
          version,
          type: 'act',
          summary: 'Inspect current page.',
          description: 'Inspect current page.',
          target: { site: 'generic-web' },
          tags: ['builtin'],
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        } as unknown as Awaited<ReturnType<WebCapAgentService['scriptGet']>>;
      },
      async scriptRegister(scriptDefinition) {
        calls.push(`scriptRegister:${(scriptDefinition as { id?: string }).id ?? ''}`);
        return {
          id: (scriptDefinition as { id: string }).id,
          scriptDefinition,
          status: 'active',
          publishedAt: '2026-05-15T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:00.000Z',
        } as Awaited<ReturnType<WebCapAgentService['scriptRegister']>>;
      },
      async browserNewTab(input) {
        calls.push(`browserNewTab:${input.url ?? ''}:${String(input.active)}`);
        return {
          command: 'create_tab',
          result: { ok: true },
          timingMs: 1,
          tab: {
            tabId: 2,
            url: input.url ?? 'about:blank',
            title: 'Example',
            site: 'generic-web',
            readyState: 'complete',
            updatedAt: '2026-05-15T00:00:00.000Z',
          },
        };
      },
    });

    const runs = [
      ['session-status', '--compact'],
      ['script-search', 'inspect', '--type', 'act', '--site', 'generic-web', '--compact'],
      ['script-get', 'builtin.page.inspect', '--version', '1.0.0', '--compact'],
      ['script-register', '--definition', '{"id":"local.test"}', '--compact'],
      ['browser-new-tab', '--url', 'https://example.com', '--active', 'true', '--compact'],
    ];

    for (const argv of runs) {
      let stdout = '';
      let stderr = '';
      const code = await runCli(
        argv,
        {
          stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
          stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
        },
        async () => service,
      );

      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(() => JSON.parse(stdout)).not.toThrow();
    }

    expect(calls).toEqual([
      'sessionStatus',
      'scriptSearch:inspect:act:generic-web',
      'scriptGet:builtin.page.inspect:1.0.0',
      'scriptRegister:local.test',
      'browserNewTab:https://example.com:true',
    ]);
  });

  it('runs the stdio MCP adapter as a CLI command', async () => {
    const service = createService({});
    const connect = vi.fn(async () => service);
    const runMcp = vi.fn(async (receivedConnect: () => Promise<WebCapAgentService>) => {
      expect(receivedConnect).toBe(connect);
    });
    let stdout = '';
    let stderr = '';

    const code = await runCli(
      ['mcp'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      connect,
      runMcp,
    );

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(connect).not.toHaveBeenCalled();
    expect(runMcp).toHaveBeenCalledTimes(1);
  });

  it('executes through the injected service and prints JSON', async () => {
    const calls: ExecuteScriptRequest[] = [];
    const service = {
      async start() {},
      async close() {},
      async scriptSearch() {
        return [];
      },
      async scriptGet() {
        throw new Error('not used');
      },
      async scriptExecute(request: ExecuteScriptRequest) {
        calls.push(request);
        return {
          scriptId: 'temp.script.000001',
          localScriptId: 'temp.script.000001',
          scriptType: 'act',
          status: 'succeeded',
          result: { ok: true },
          evidence: { events: [], screenshots: [] },
          timingMs: 1,
          tab: {
            tabId: 1,
            url: 'https://example.com',
            title: 'Example',
            site: 'generic-web',
            readyState: 'complete',
            updatedAt: new Date().toISOString(),
          },
        };
      },
      async scriptHistoryList() {
        return [];
      },
      async scriptRegistryList() {
        return [];
      },
      async scriptRegister() {
        throw new Error('not used');
      },
      async browserNewTab() {
        throw new Error('not used');
      },
      async browserWaitEvents() {
        throw new Error('not used');
      },
      sessionStatus() {
        return {
          connected: false,
          tabs: [],
          authenticatedSites: [],
        };
      },
    } satisfies WebCapAgentService;
    let stdout = '';
    let stderr = '';

    const code = await runCli(
      [
        'script-execute',
        '--script',
        'export default async function () { return { ok: true }; }',
        '--input',
        '{"x":1}',
        '--compact',
      ],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(calls).toEqual([
      {
        script: 'export default async function () { return { ok: true }; }',
        input: { x: 1 },
      },
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
    });
  });

  it('persists config and applies activateTab to script execution', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-cli-test-'));
    process.env.WEB_CAP_STATE_DIR = tempDir;
    const calls: ExecuteScriptRequest[] = [];
    const service = createService({
      async scriptExecute(request: ExecuteScriptRequest) {
        calls.push(request);
        return {
          scriptId: 'temp.script.000001',
          localScriptId: 'temp.script.000001',
          scriptType: 'act',
          status: 'succeeded',
          result: { ok: true },
          evidence: { events: [], screenshots: [] },
          timingMs: 1,
          tab: {
            tabId: 9,
            url: 'https://example.com',
            title: 'Example',
            site: 'generic-web',
            readyState: 'complete',
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    let stdout = '';
    let stderr = '';

    const setCode = await runCli(
      ['config', 'set', 'activateTabOnScriptExecute', 'true', '--compact'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => {
        throw new Error('config should not connect to daemon');
      },
    );

    expect(setCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      key: 'activateTabOnScriptExecute',
      value: true,
      config: { activateTabOnScriptExecute: true },
    });

    stdout = '';
    const executeCode = await runCli(
      [
        'script-execute',
        '--script',
        'export default async function () { return { ok: true }; }',
        '--compact',
      ],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(executeCode).toBe(0);
    expect(stderr).toBe('');
    expect(calls).toEqual([
      {
        script: 'export default async function () { return { ok: true }; }',
        input: {},
        options: {
          activateTab: true,
        },
      },
    ]);
  });

  it('streams wait-events records as JSON lines', async () => {
    const service = {
      async start() {},
      async close() {},
      async scriptSearch() {
        return [];
      },
      async scriptGet() {
        throw new Error('not used');
      },
      async scriptExecute() {
        throw new Error('not used');
      },
      async scriptHistoryList() {
        return [];
      },
      async scriptRegistryList() {
        return [];
      },
      async scriptRegister() {
        throw new Error('not used');
      },
      async browserNewTab() {
        throw new Error('not used');
      },
      async browserWaitEvents(
        input: { durationMs?: number; tabId?: number },
        onEvent?: (event: Record<string, unknown>) => void,
      ) {
        onEvent?.({
          type: 'click',
          atMs: 12,
          value: { target: { tagName: 'button', text: 'Save' } },
        });
        return {
          command: 'wait_events',
          result: { ok: true, durationMs: input.durationMs, eventCount: 1 },
          timingMs: 20,
          tab: {
            tabId: input.tabId ?? 1,
            url: 'https://example.com',
            title: 'Example',
            site: 'generic-web',
            readyState: 'complete',
            updatedAt: new Date().toISOString(),
          },
        };
      },
      sessionStatus() {
        return {
          connected: false,
          tabs: [],
          authenticatedSites: [],
        };
      },
    } satisfies WebCapAgentService;
    let stdout = '';
    let stderr = '';

    const code = await runCli(
      ['wait-events', '--duration-ms', '100', '--tab-id', '3'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        type: 'event',
        event: {
          type: 'click',
          atMs: 12,
          value: { target: { tagName: 'button', text: 'Save' } },
        },
      },
      expect.objectContaining({
        type: 'done',
        result: expect.objectContaining({
          command: 'wait_events',
          result: { ok: true, durationMs: 100, eventCount: 1 },
        }),
      }),
    ]);
  });

  it('returns a non-zero exit code for invalid input JSON', async () => {
    const connect = vi.fn();
    let stderr = '';
    const code = await runCli(
      ['script-execute', '--script', 'export default async function () {}', '--input', '[]'],
      {
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      connect,
    );

    expect(code).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(stderr).toMatch(/input must be a JSON object/i);
  });
});
