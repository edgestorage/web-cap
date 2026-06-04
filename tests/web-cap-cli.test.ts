import { mkdir, mkdtemp, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
    delete process.env.WEB_CAP_PATH;
  });

  function createService(overrides: Partial<WebCapAgentService>): WebCapAgentService {
    return {
      async start() {},
      async close() {},
      async scriptExecute() {
        throw new Error('not used');
      },
      async scriptHistoryList() {
        return [];
      },
      async scriptRegistryList() {
        return [];
      },
      async userScriptInstall() {
        throw new Error('not used');
      },
      async userScriptList() {
        return [];
      },
      async userScriptEnable() {
        throw new Error('not used');
      },
      async userScriptDisable() {
        throw new Error('not used');
      },
      async userScriptRemove() {
        throw new Error('not used');
      },
      async browserScreenshot() {
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
        tabId: 42,
      }),
    ).resolves.toEqual({
      script: 'export default async function () { return { ok: true }; }',
      input: { ok: true },
      options: {
        tabId: 42,
      },
    });
  });

  it('requires a tab id for script execution', async () => {
    expect(() =>
      parseCliArgs(['script-execute', '--script', 'export default async function () {}']),
    ).toThrow(/--tab-id/);

    await expect(
      buildScriptExecuteRequest({
        script: 'export default async function () {}',
      }),
    ).rejects.toThrow(/--tab-id/);
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
    expect(parseCliArgs(['version'])).toEqual({ name: 'version' });
    expect(parseCliArgs(['--version'])).toEqual({ name: 'version' });
    expect(parseCliArgs(['-V'])).toEqual({ name: 'version' });
    expect(parseCliArgs(['mcp'])).toEqual({ name: 'mcp' });
    expect(parseCliArgs(['session-status', '--pretty'])).toEqual({
      name: 'session-status',
      options: { pretty: true },
    });
    expect(parseCliArgs(['browser-new-tab', '--url', 'https://example.com', '--active', 'false'])).toEqual({
      name: 'browser-new-tab',
      options: {
        url: 'https://example.com',
        active: false,
      },
    });
    expect(parseCliArgs([
      'browser-screenshot',
      '--tab-id',
      '7',
      '--type',
      'jpeg',
      '--quality',
      '80',
    ])).toEqual({
      name: 'browser-screenshot',
      options: {
        tabId: 7,
        type: 'jpeg',
        quality: 80,
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
    expect(parseCliArgs(['config', 'set', 'mouseTrajectorySimulation', 'true'])).toEqual({
      name: 'config',
      options: {
        action: 'set',
        key: 'mouseTrajectorySimulation',
        value: true,
      },
    });
    expect(parseCliArgs(['config', 'set', 'evidence', 'events,visibleElements'])).toEqual({
      name: 'config',
      options: {
        action: 'set',
        key: 'evidence',
        value: ['events', 'visibleElements'],
      },
    });
    expect(parseCliArgs(['config', 'set', 'evidence', 'all'])).toMatchObject({
      options: {
        key: 'evidence',
        value: ['all'],
      },
    });
    expect(parseCliArgs(['config', 'set', 'evidence', 'common'])).toMatchObject({
      options: {
        key: 'evidence',
        value: ['common'],
      },
    });
  });

  it('parses userscript commands', () => {
    expect(parseCliArgs(['userscript', 'list', '--pretty'])).toEqual({
      name: 'userscript',
      options: {
        action: 'list',
        pretty: true,
      },
    });
    expect(parseCliArgs(['userscript', 'install', '--file', './foo.js', '--apply-now'])).toEqual({
      name: 'userscript',
      options: {
        action: 'install',
        file: './foo.js',
        applyNow: true,
      },
    });
    expect(parseCliArgs(['userscript', 'enable', 'userscript.foo', '--apply-now'])).toEqual({
      name: 'userscript',
      options: {
        action: 'enable',
        id: 'userscript.foo',
        applyNow: true,
      },
    });
    expect(parseCliArgs(['userscript', 'disable', 'userscript.foo'])).toEqual({
      name: 'userscript',
      options: {
        action: 'disable',
        id: 'userscript.foo',
      },
    });
    expect(parseCliArgs(['userscript', 'remove', 'userscript.foo'])).toEqual({
      name: 'userscript',
      options: {
        action: 'remove',
        id: 'userscript.foo',
      },
    });
    expect(parseCliArgs(['userscript', 'show', 'userscript.foo', '--pretty'])).toEqual({
      name: 'userscript',
      options: {
        action: 'show',
        id: 'userscript.foo',
        pretty: true,
      },
    });
    expect(() => parseCliArgs(['userscript', 'install'])).toThrow(/--file/);
    expect(() => parseCliArgs(['userscript', 'enable'])).toThrow(/requires an id/);
    expect(() => parseCliArgs(['userscript', 'disable', 'userscript.foo', '--apply-now'])).toThrow(/--apply-now/);
    expect(() => parseCliArgs(['userscript', 'remove'])).toThrow(/requires an id/);
    expect(() => parseCliArgs(['userscript', 'show'])).toThrow(/requires an id/);
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
    expect(stdout).toContain('web-cap script-execute --tab-id <id> --script <code>');
    expect(stdout).toContain('Runs JavaScript in the selected browser tab.');
    expect(stdout).not.toContain('use cap.call(...) inside the script');
    expect(stdout).toContain('Playwright-style page API as global page and cap.page');
    expect(stdout).toContain("await page.getByRole('button', { name: 'Login' }).click();");
    expect(stdout).toContain("await page.locator('input[name=email]').fill(input.email);");
    expect(stdout).toContain('--script-file <path>');
    expect(stdout).toContain('--tab-id <id>');
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
      async browserScreenshot(input) {
        calls.push(`browserScreenshot:${input.tabId ?? ''}:${input.type ?? ''}`);
        return {
          result: {
            path: '/tmp/web-cap/temp-screenshots/s-Abc_123-xYz.png',
            sizeBytes: 8,
          },
          timingMs: 1,
          tab: {
            tabId: input.tabId ?? 2,
            url: 'https://example.com',
            title: 'Example',
          },
        };
      },
    });

    const runs = [
      ['session-status'],
      ['browser-screenshot', '--tab-id', '2'],
      ['browser-new-tab', '--url', 'https://example.com', '--active', 'true'],
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
      if (argv[0] === 'browser-screenshot') {
        const parsed = JSON.parse(stdout) as { result: Record<string, unknown> };
        expect(parsed.result.path).toContain('temp-screenshots');
        expect(parsed.result).not.toHaveProperty('data');
      }
    }

    expect(calls).toEqual([
      'sessionStatus',
      'browserScreenshot:2:',
      'browserNewTab:https://example.com:true',
    ]);
  });

  it('routes userscript commands through the injected service', async () => {
    const calls: string[] = [];
    const service = createService({
      async userScriptInstall(request) {
        calls.push(`install:${request.filePath}:${request.applyNow === true}`);
        return {
          id: 'userscript.foo',
          name: 'Foo',
          version: '1.0.0',
          status: 'active',
          matches: ['https://example.com/*'],
          runAt: 'document-idle',
          code: 'console.log("foo");',
          sourcePath: request.filePath,
          installedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        };
      },
      async userScriptList() {
        calls.push('list');
        return [
          {
            id: 'userscript.foo',
            name: 'Foo',
            version: '1.0.0',
            status: 'active',
            matches: ['https://example.com/*'],
            runAt: 'document-idle',
            code: 'console.log("foo");',
            installedAt: '2026-06-04T00:00:00.000Z',
            updatedAt: '2026-06-04T00:00:00.000Z',
          },
        ];
      },
      async userScriptRemove(request) {
        calls.push(`remove:${request.id}`);
        return {
          id: request.id,
          name: 'Foo',
          version: '1.0.0',
          status: 'active',
          matches: ['https://example.com/*'],
          runAt: 'document-idle',
          code: 'console.log("foo");',
          installedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        };
      },
      async userScriptEnable(request) {
        calls.push(`enable:${request.id}:${request.applyNow === true}`);
        return {
          id: request.id,
          name: 'Foo',
          version: '1.0.0',
          status: 'active',
          matches: ['https://example.com/*'],
          runAt: 'document-idle',
          code: 'console.log("foo");',
          installedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        };
      },
      async userScriptDisable(request) {
        calls.push(`disable:${request.id}`);
        return {
          id: request.id,
          name: 'Foo',
          version: '1.0.0',
          status: 'disabled',
          matches: ['https://example.com/*'],
          runAt: 'document-idle',
          code: 'console.log("foo");',
          installedAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        };
      },
      sessionStatus() {
        return {
          connected: true,
          tabs: [],
          authenticatedSites: [],
          userScriptsAvailable: true,
        };
      },
    });

    let stdout = '';
    let stderr = '';
    let code = await runCli(
      ['userscript', 'install', '--file', './foo.js', '--apply-now'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ id: 'userscript.foo' });

    stdout = '';
    code = await runCli(
      ['userscript', 'enable', 'userscript.foo', '--apply-now'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 'userscript.foo', status: 'active' });

    stdout = '';
    code = await runCli(
      ['userscript', 'disable', 'userscript.foo'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 'userscript.foo', status: 'disabled' });

    stdout = '';
    code = await runCli(
      ['userscript', 'list'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      userscripts: [{ id: 'userscript.foo' }],
    });

    stdout = '';
    code = await runCli(
      ['userscript', 'show', 'userscript.foo'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 'userscript.foo' });

    stdout = '';
    code = await runCli(
      ['userscript', 'remove', 'userscript.foo'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 'userscript.foo' });
    expect(calls).toEqual([
      'install:./foo.js:true',
      'enable:userscript.foo:true',
      'disable:userscript.foo',
      'list',
      'list',
      'remove:userscript.foo',
    ]);
  });

  it('prints a userscript support notice for userscript commands', async () => {
    const service = createService({
      async userScriptList() {
        return [];
      },
      sessionStatus() {
        return {
          connected: true,
          tabs: [],
          authenticatedSites: [],
          userScriptsAvailable: false,
        };
      },
    });
    let stdout = '';
    let stderr = '';

    const code = await runCli(
      ['userscript', 'list'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ userscripts: [] });
    expect(stderr).toContain('WEB_CAP userscript notice');
    expect(stderr).toContain('chrome.userScripts');
  });

  it('prints compact JSON by default and formatted JSON with --pretty', async () => {
    const service = createService({
      sessionStatus() {
        return {
          connected: false,
          tabs: [],
          authenticatedSites: [],
        };
      },
    });

    let stdout = '';
    let stderr = '';
    const compactCode = await runCli(
      ['session-status'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(compactCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.trim()).toBe(JSON.stringify(JSON.parse(stdout)));

    stdout = '';
    const prettyCode = await runCli(
      ['session-status', '--pretty'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(prettyCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('\n  "connected": false');
  });

  it('prints session status grouped by runtime with available script counts', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-cli-test-'));
    process.env.WEB_CAP_PATH = tempDir;
    await mkdir(join(tempDir, 'github.com'), { recursive: true });
    const readIssueScript = 'export default async function () { return { ok: true, issue: 1 }; }';
    const readIssuePath = join(tempDir, 'github.com', 'read-issue.js');
    await writeFile(
      readIssuePath,
      readIssueScript,
    );
    await writeFile(
      join(tempDir, 'github.com', 'fill-search.js'),
      'export default async function () {}',
    );
    for (let index = 1; index <= 10; index += 1) {
      const extraPath = join(tempDir, 'github.com', `extra-${String(index).padStart(2, '0')}.js`);
      await writeFile(
        extraPath,
        `export default async function () { return { ok: true, index: ${index} }; }`,
      );
      await utimes(
        extraPath,
        new Date('2020-01-01T00:00:00.000Z'),
        new Date('2020-01-01T00:00:00.000Z'),
      );
    }
    await utimes(
      join(tempDir, 'github.com', 'fill-search.js'),
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z'),
    );
    await writeFile(join(tempDir, 'github.com', 'README.md'), '# github.com scripts');
    await mkdir(join(tempDir, 'example.com'), { recursive: true });
    await writeFile(
      join(tempDir, 'example.com', 'read-page.js'),
      'export default async function () {}',
    );
    await mkdir(join(tempDir, 'inactive.example'), { recursive: true });
    for (const name of ['open-dashboard.js', 'read-list.js', 'submit-form.js', 'update-filter.js']) {
      const inactiveScriptPath = join(tempDir, 'inactive.example', name);
      await writeFile(
        inactiveScriptPath,
        `export default async function () { return { ok: true, name: ${JSON.stringify(name)} }; }`,
      );
      await utimes(
        inactiveScriptPath,
        new Date('2020-01-01T00:00:00.000Z'),
        new Date('2020-01-01T00:00:00.000Z'),
      );
    }
    await utimes(
      readIssuePath,
      new Date('2030-01-01T00:00:00.000Z'),
      new Date('2026-05-15T00:00:00.000Z'),
    );

    const service = createService({
      sessionStatus() {
        return {
          connected: true,
          sessionId: 'active-runtime',
          browserName: 'Chrome',
          extensionVersion: '1.2.3',
          activeTab: {
            tabId: 7,
            url: 'https://github.com/edgestorage/web-cap/issues',
            title: 'Issues',
            site: 'generic-web',
            readyState: 'complete',
            updatedAt: '2026-05-15T00:00:00.000Z',
          },
          tabs: [
            {
              tabId: 7,
              url: 'https://github.com/edgestorage/web-cap/issues',
              title: 'Issues',
              site: 'generic-web',
              readyState: 'complete',
              updatedAt: '2026-05-15T00:00:00.000Z',
            },
          ],
          authenticatedSites: ['github.com'],
          lastSeenAt: '2026-05-15T00:00:01.000Z',
          runtimes: [
            {
              connected: true,
              sessionId: 'active-runtime',
              browserName: 'Chrome',
              extensionVersion: '1.2.3',
              activeTab: {
                tabId: 7,
                url: 'https://github.com/edgestorage/web-cap/issues',
                title: 'Issues',
                site: 'generic-web',
                readyState: 'complete',
                updatedAt: '2026-05-15T00:00:00.000Z',
              },
              tabs: [
                {
                  tabId: 7,
                  url: 'https://github.com/edgestorage/web-cap/issues',
                  title: 'Issues',
                  site: 'generic-web',
                  readyState: 'complete',
                  updatedAt: '2026-05-15T00:00:00.000Z',
                },
              ],
              authenticatedSites: ['github.com'],
              lastSeenAt: '2026-05-15T00:00:01.000Z',
            },
            {
              connected: true,
              sessionId: 'second-runtime',
              browserName: 'Edge',
              extensionVersion: '1.2.3',
              activeTab: {
                tabId: 7,
                url: 'https://www.example.com/docs',
                title: 'Docs',
                site: 'generic-web',
                readyState: 'complete',
                updatedAt: '2026-05-15T00:00:00.000Z',
              },
              tabs: [
                {
                  tabId: 7,
                  url: 'https://www.example.com/docs',
                  title: 'Docs',
                  site: 'generic-web',
                  readyState: 'complete',
                  updatedAt: '2026-05-15T00:00:00.000Z',
                },
                {
                  tabId: 8,
                  url: 'https://empty.example/docs',
                  title: 'Empty Docs',
                  site: 'generic-web',
                  readyState: 'complete',
                  updatedAt: '2026-05-15T00:00:00.000Z',
                },
                {
                  tabId: 9,
                  url: 'https://inactive.example/docs',
                  title: 'Inactive Docs',
                  site: 'generic-web',
                  readyState: 'complete',
                  updatedAt: '2026-05-15T00:00:00.000Z',
                },
              ],
              authenticatedSites: [],
              lastSeenAt: '2026-05-15T00:00:02.000Z',
            },
          ],
        };
      },
    });

    let stdout = '';
    let stderr = '';
    const code = await runCli(
      ['session-status'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => service,
    );

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout) as Record<string, any>;
    expect(parsed).toEqual({
      connected: true,
      availableScripts: {
        webCapPath: tempDir,
        sites: [
          {
            site: 'example.com',
            count: 1,
            directory: join(tempDir, 'example.com'),
            scripts: ['read-page.js'],
          },
          {
            site: 'github.com',
            count: 12,
            directory: join(tempDir, 'github.com'),
            scripts: [
              'read-issue.js',
              'extra-01.js',
              'extra-02.js',
              'extra-03.js',
              'extra-04.js',
              'extra-05.js',
              'extra-06.js',
              'extra-07.js',
              'extra-08.js',
              'extra-09.js',
            ],
          },
          {
            site: 'inactive.example',
            count: 4,
            directory: join(tempDir, 'inactive.example'),
            scripts: ['open-dashboard.js', 'read-list.js', 'submit-form.js'],
          },
        ],
      },
      runtimes: [
        {
          sessionId: 'active-runtime',
          browserName: 'Chrome',
          extensionVersion: '1.2.3',
          lastSeenAt: '2026-05-15T00:00:01.000Z',
          activeTab: {
            tabId: 7,
            url: 'https://github.com/edgestorage/web-cap/issues',
            title: 'Issues',
            site: 'generic-web',
            readyState: 'complete',
          },
          tabs: [
            {
              tabId: 7,
              url: 'https://github.com/edgestorage/web-cap/issues',
              title: 'Issues',
              site: 'generic-web',
              readyState: 'complete',
            },
          ],
        },
        {
          sessionId: 'second-runtime',
          browserName: 'Edge',
          extensionVersion: '1.2.3',
          lastSeenAt: '2026-05-15T00:00:02.000Z',
          activeTab: {
            tabId: 7,
            url: 'https://www.example.com/docs',
            title: 'Docs',
            site: 'generic-web',
            readyState: 'complete',
          },
          tabs: [
            {
              tabId: 7,
              url: 'https://www.example.com/docs',
              title: 'Docs',
              site: 'generic-web',
              readyState: 'complete',
            },
            {
              tabId: 8,
              url: 'https://empty.example/docs',
              title: 'Empty Docs',
              site: 'generic-web',
              readyState: 'complete',
            },
            {
              tabId: 9,
              url: 'https://inactive.example/docs',
              title: 'Inactive Docs',
              site: 'generic-web',
              readyState: 'complete',
            },
          ],
        },
      ],
    });
    expect(parsed.availableScripts.sites).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ site: 'empty.example' })]),
    );
    expect(parsed).not.toHaveProperty('lastActiveTab');
    expect(parsed).not.toHaveProperty('tabs');
    expect(parsed).not.toHaveProperty('authenticatedSites');
    expect(parsed.runtimes[0]).not.toHaveProperty('authenticatedSites');
    expect(parsed.runtimes[0].tabs[0]).not.toHaveProperty('updatedAt');
    expect(parsed.runtimes[0].tabs[0]).not.toHaveProperty('availableScripts');
    expect(parsed.runtimes[1].tabs[0]).not.toHaveProperty('updatedAt');
    expect(parsed.runtimes[1].tabs[0]).not.toHaveProperty('availableScripts');
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

  it('prints the package version without connecting to the daemon', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    const connect = vi.fn();
    let stdout = '';
    let stderr = '';

    const code = await runCli(
      ['version'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      connect,
    );

    expect(code).toBe(0);
    expect(stdout).toBe(`${packageJson.version}\n`);
    expect(stderr).toBe('');
    expect(connect).not.toHaveBeenCalled();
  });

  it('executes through the injected service and prints JSON', async () => {
    const calls: ExecuteScriptRequest[] = [];
    const service = {
      async start() {},
      async close() {},
      async scriptExecute(request: ExecuteScriptRequest) {
        calls.push(request);
        return {
          scriptId: 'temp.script.000001',
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
      async userScriptInstall() {
        throw new Error('not used');
      },
      async userScriptList() {
        return [];
      },
      async userScriptEnable() {
        throw new Error('not used');
      },
      async userScriptDisable() {
        throw new Error('not used');
      },
      async userScriptRemove() {
        throw new Error('not used');
      },
      async browserScreenshot() {
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
        '--tab-id',
        '1',
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
        options: {
          tabId: 1,
          evidence: ['common'],
        },
      },
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
    });
    expect(stdout.trim()).toBe(JSON.stringify(JSON.parse(stdout)));
  });

  it('persists config and applies configured script execution options', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-cli-test-'));
    process.env.WEB_CAP_STATE_DIR = tempDir;
    const calls: ExecuteScriptRequest[] = [];
    const service = createService({
      async scriptExecute(request: ExecuteScriptRequest) {
        calls.push(request);
        return {
          scriptId: 'temp.script.000001',
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
      ['config', 'set', 'activateTabOnScriptExecute', 'true'],
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
    const setEvidenceCode = await runCli(
      ['config', 'set', 'evidence', 'events,visibleElements'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => {
        throw new Error('config should not connect to daemon');
      },
    );

    expect(setEvidenceCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      key: 'evidence',
      value: ['events', 'visibleElements'],
      config: {
        activateTabOnScriptExecute: true,
        evidence: ['events', 'visibleElements'],
      },
    });

    stdout = '';
    const setMouseTrajectoryCode = await runCli(
      ['config', 'set', 'mouseTrajectorySimulation', 'true'],
      {
        stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
        stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
      },
      async () => {
        throw new Error('config should not connect to daemon');
      },
    );

    expect(setMouseTrajectoryCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      key: 'mouseTrajectorySimulation',
      value: true,
      config: {
        activateTabOnScriptExecute: true,
        evidence: ['events', 'visibleElements'],
        mouseTrajectorySimulation: true,
      },
    });

    stdout = '';
    const executeCode = await runCli(
      [
        'script-execute',
        '--script',
        'export default async function () { return { ok: true }; }',
        '--tab-id',
        '9',
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
          tabId: 9,
          activateTab: true,
          evidence: ['events', 'visibleElements'],
          mouseTrajectorySimulation: true,
        },
      },
    ]);
  });

  it('streams wait-events records as JSON lines', async () => {
    const service = {
      async start() {},
      async close() {},
      async scriptExecute() {
        throw new Error('not used');
      },
      async scriptHistoryList() {
        return [];
      },
      async scriptRegistryList() {
        return [];
      },
      async userScriptInstall() {
        throw new Error('not used');
      },
      async userScriptList() {
        return [];
      },
      async userScriptEnable() {
        throw new Error('not used');
      },
      async userScriptDisable() {
        throw new Error('not used');
      },
      async userScriptRemove() {
        throw new Error('not used');
      },
      async browserScreenshot() {
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
      ['script-execute', '--script', 'export default async function () {}', '--tab-id', '1', '--input', '[]'],
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
