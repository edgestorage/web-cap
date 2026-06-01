import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
  DaemonIdleShutdown,
  getDaemonIdleTimeoutMs,
} from '../lib/runtime-daemon';
import {
  WebCapAgentApp,
  createDefaultScriptProvider,
  type WebCapAgentService,
} from '../lib/server/app';
import { WebCapRpcClient, WebCapRpcServer } from '../lib/server/app-rpc';
import { MemoryScriptProvider } from '../lib/server/providers/memory-script-provider';
import { WebSocketRuntimeBridge } from '../lib/server/runtime/websocket-runtime-bridge';
import { ScriptExecutionHistory } from '../lib/server/scripts/execution-history';
import { resolveWebCapStateDir } from '../lib/server/state-dir';
import { scriptDefinitionSchema } from '@shared/script-schema';
import { createRuntimeEnvelope, type RuntimeEnvelope } from '@shared/protocol';
import { testScriptRecords } from './fixtures/script-records';

describe('WebCapAgentApp', () => {
  let bridge: WebSocketRuntimeBridge;
  let app: WebCapAgentApp;
  let scriptProvider: MemoryScriptProvider;
  let client: WebSocket | undefined;
  let clients: WebSocket[];
  let tempDir: string;

  beforeEach(async () => {
    clients = [];
    tempDir = await mkdtemp(join(tmpdir(), 'web-cap-test-'));
    bridge = new WebSocketRuntimeBridge({ port: 0 });
    scriptProvider = new MemoryScriptProvider([...testScriptRecords]);
    app = new WebCapAgentApp({
      scriptProvider,
      runtimeBridge: bridge,
      scriptExecutionHistory: new ScriptExecutionHistory(
        join(tempDir, 'script-execution-history.json'),
      ),
    });
    bridge.setScriptHistoryLoader(() => app.scriptHistoryList());

    await app.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.WEB_CAP_STATE_DIR;
    for (const connectedClient of clients) {
      connectedClient.close();
    }
    await app.close();
    await removePathWithRetries(tempDir, { recursive: true });
  });

  async function connectRuntime(
    handler?: (message: RuntimeEnvelope, runtimeClient: WebSocket) => void,
    options: {
      tabId?: number;
      url?: string;
      title?: string;
      site?: string;
      authenticatedSites?: string[];
      browserName?: string;
    } = {},
  ) {
    const port = bridge.getPort();
    const runtimeClient = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(runtimeClient);
    client = runtimeClient;

    await new Promise<void>((resolve) => {
      runtimeClient.once('open', resolve);
    });

    runtimeClient.on('message', (buffer: Buffer) => {
      const envelope = JSON.parse(buffer.toString()) as RuntimeEnvelope;
      handler?.(envelope, runtimeClient);
    });

    const tabId = options.tabId ?? 101;
    const url = options.url ?? 'https://example.com/form';
    const site = options.site ?? 'generic-web';
    const authenticatedSites = options.authenticatedSites ?? [];

    runtimeClient.send(
      JSON.stringify(
        createRuntimeEnvelope('hello', {
          browserName: options.browserName ?? 'vitest',
          extensionVersion: '1.0.0',
          protocolVersion: '2026-05-05',
          authenticatedSites,
        }),
      ),
    );

    runtimeClient.send(
      JSON.stringify(
        createRuntimeEnvelope(
          'tab_snapshot',
          {
            activeTabId: tabId,
            tabs: [
              {
                tabId,
                url,
                title: options.title ?? 'Example Form',
                site,
                readyState: 'complete',
                updatedAt: new Date().toISOString(),
              },
            ],
            authenticatedSites,
          },
          { sessionId: 'runtime-session' },
        ),
      ),
    );

    await waitFor(
      () =>
        app.sessionStatus().runtimes?.some((runtime) => runtime.tabs.some((tab) => tab.tabId === tabId)) ??
        false,
    );
    return runtimeClient;
  }

  it('supports search -> get -> execute with script capabilities', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.scriptDefinition.id).toBe('temp.script.000001');
      expect(
        envelope.payload.scriptRegistry.some(
          (script) => script.id === 'builtin.page.fill_input',
        ),
      ).toBe(true);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: {
                selector: '#email',
                value: 'hello',
              },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'filled selector' }],
                screenshots: [],
                visibleElements: {
                  added: [],
                  removed: [],
                  truncated: false,
                  updated: [],
                },
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: "(input) => cap.call('cap_fill_input_with_text', input)",
      input: {
        selector: '#email',
        value: 'hello',
      },
    });

    expect(execution.status).toBe('succeeded');
    expect(execution.result).toEqual({
      selector: '#email',
      value: 'hello',
    });
    expect(execution.evidence).toEqual({
      events: [{ type: 'message', value: 'filled selector' }],
    });
    expect(execution.tab).toEqual({
      tabId: 101,
      url: 'https://example.com/form',
      title: 'Example Form',
    });
  });

  it('stores page screenshot artifacts returned from script execution', async () => {
    process.env.WEB_CAP_STATE_DIR = tempDir;
    const screenshotBytes = Buffer.from('script screenshot bytes');
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      const screenshotPath = join(
        String(envelope.payload.screenshotArtifactBasePath),
        's-abcdefghijk.png',
      );
      const transferId = 'script-screenshot-transfer';
      client?.send(JSON.stringify(createRuntimeEnvelope(
        'binary_payload_start',
        {
          transferId,
          kind: 'screenshot',
          mimeType: 'image/png',
          type: 'png',
          byteLength: screenshotBytes.byteLength,
          resultShape: 'metadata',
          path: screenshotPath,
        },
        { sessionId: 'runtime-session', requestId: envelope.requestId },
      )));
      client?.send(screenshotBytes);
      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: {
                ok: true,
                screenshot: {
                  path: screenshotPath,
                },
              },
              screenshotArtifacts: [
                {
                  kind: 'screenshot',
                  path: screenshotPath,
                  transferId,
                  mimeType: 'image/png',
                  type: 'png',
                },
              ],
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
    });

    const screenshot = execution.result.screenshot as Record<string, unknown>;
    expect(screenshot.path).toEqual(expect.stringContaining(join(tempDir, 'temp-screenshots')));
    await expect(readFile(String(screenshot.path))).resolves.toEqual(screenshotBytes);
  });

  it('summarizes consecutive managed mouse move evidence', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                events: [
                  { type: 'managed_mouse', value: { action: 'move', point: { x: 10, y: 20 } } },
                  { type: 'managed_mouse', value: { action: 'move', point: { x: 15, y: 25 } } },
                  { type: 'managed_mouse', value: { action: 'move', point: { x: 30, y: 40 } } },
                  { type: 'managed_mouse', value: { action: 'down', x: 30, y: 40 } },
                ],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: '() => ({ ok: true })',
      input: {},
      options: { tabId: 101 },
    });

    expect(execution.evidence.events).toEqual([
      {
        type: 'managed_mouse',
        value: {
          action: 'move',
          point: { x: 30, y: 40 },
          count: 3,
          from: { x: 10, y: 20 },
          to: { x: 30, y: 40 },
        },
      },
      { type: 'managed_mouse', value: { action: 'down', x: 30, y: 40 } },
    ]);
  });

  it('executes script wrappers and passes the registry to the runtime', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.scriptDefinition.id).toBe('temp.script.000001');
      expect(
        envelope.payload.scriptRegistry.some(
          (script) => script.id === 'cap_page_inspect_summary',
        ),
      ).toBe(true);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { echoed: 'hello' },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function (args) { return { echoed: args.text }; }',
      input: { text: 'hello' },
    });

    expect(execution.result).toEqual({ echoed: 'hello' });
  });

  it('passes activateTab execution option to the browser runtime', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.tabId).toBe(101);
      expect(envelope.payload.activateTab).toBe(true);
      expect(envelope.payload.evidence).toEqual(['common']);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      options: {
        tabId: 101,
        activateTab: true,
      },
    });

    expect(execution).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
    });
    expect(execution.tab).toBeUndefined();
  });

  it('passes evidence execution options to the browser runtime', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.evidence).toEqual(['events', 'visibleElements']);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      options: {
        tabId: 101,
        evidence: ['events', 'visibleElements'],
      },
    });

    expect(execution.result).toEqual({ ok: true });
  });

  it('passes mouse trajectory simulation option to the browser runtime', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.mouseTrajectorySimulation).toBe(true);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      options: {
        tabId: 101,
        mouseTrajectorySimulation: true,
      },
    });

    expect(execution.result).toEqual({ ok: true });
  });

  it('executes script source with a temporary local id and persists it to local history', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.scriptDefinition.id).toBe('temp.script.000001');
      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { echoed: 'hello' },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function (input) { return { echoed: input.text }; }',
      input: { text: 'hello' },
    });

    expect(execution.scriptId).toBe('temp.script.000001');
    expect(execution.result).toEqual({ echoed: 'hello' });

    const historyRaw = await readFile(join(tempDir, 'script-execution-history.json'), 'utf8');
    const history = JSON.parse(historyRaw) as {
      nextSequence: number;
      entries: Array<{
        localScriptId: string;
        status: string;
        script?: string;
        scriptPath: string;
        execution?: { scriptId: string };
      }>;
    };

    expect(history.nextSequence).toBe(2);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.localScriptId).toBe('temp.script.000001');
    expect(history.entries[0]?.status).toBe('succeeded');
    expect(history.entries[0]?.script).toBeUndefined();
    expect(history.entries[0]?.execution?.scriptId).toBe('temp.script.000001');
    await expect(readFile(history.entries[0]!.scriptPath, 'utf8')).resolves.toBe(
      'export default async function (input) { return { echoed: input.text }; }',
    );
  });

  it('does not add a temporary reuse notice when the same long script is executed again', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { echoed: 'hello' },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const repeatedScript = `export default async function (input) {
  const message = input.text ?? 'hello';
  return {
    echoed: message,
    upper: String(message).toUpperCase(),
    length: String(message).length,
  };
}`;

    const firstExecution = await app.scriptExecute({
      script: repeatedScript,
      input: { text: 'hello' },
    });
    expect(firstExecution.notice).toBeUndefined();

    const secondExecution = await app.scriptExecute({
      script: repeatedScript,
      input: { text: 'world' },
    });

    expect(secondExecution.notice).toBeUndefined();

    const historyEntries = await app.scriptHistoryList();
    expect(historyEntries[0]?.execution?.notice).toBeUndefined();
  });

  it('does not add a temporary reuse notice for scripts longer than 400 characters', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const longScript = `export default async function (input) {
  const source = String(input.source ?? 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega');
  const normalized = source
    .split(/\\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('-');
  return {
    source,
    normalized,
    reversed: normalized.split('').reverse().join(''),
    size: normalized.length,
  };
}`;

    const execution = await app.scriptExecute({
      script: longScript,
      input: { source: 'hello world' },
    });

    expect(execution.notice).toBeUndefined();
  });

  it('allows temporary script executions to be reused through cap.call', async () => {
    const seenRegistryIds: string[][] = [];

    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      seenRegistryIds.push(envelope.payload.scriptRegistry.map((script) => script.id));

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    await app.scriptExecute({
      script: 'export default async function (input) { return { echoed: input.text }; }',
      input: { text: 'hello' },
    });

    await app.scriptExecute({
      script: "export default async function (input) { return await cap.call('temp.script.000001', input); }",
      input: { text: 'again' },
    });

    expect(seenRegistryIds[1]).toContain('temp.script.000001');

    const registry = await app.scriptRegistryList();
    expect(registry.map((script) => script.id)).not.toContain('temp.script.000001');
  });

  it('does not include failed temporary scripts in execution registries', async () => {
    const failedEntry = await app.scriptExecutionHistory.reserve(
      'export default async function () { return { broken: /unterminated/flags }; }',
      {},
    );
    await app.scriptExecutionHistory.markFailed(failedEntry.localScriptId, new Error('boom'));

    const seenRegistryIds: string[][] = [];

    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      seenRegistryIds.push(envelope.payload.scriptRegistry.map((script) => script.id));

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
    });

    expect(seenRegistryIds[0]).not.toContain(failedEntry.localScriptId);
  });

  it('registers inline scripts as permanent ids when requested', async () => {
    const executedScriptIds: string[] = [];
    const executedTimeouts: number[] = [];

    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      executedScriptIds.push(envelope.payload.scriptDefinition.id);
      executedTimeouts.push(envelope.payload.scriptDefinition.script.timeoutMs);

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'registered inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      options: { timeoutMs: 60_000 },
      register: true,
    });

    expect(executedScriptIds).toEqual(['local.script.000001']);
    expect(executedTimeouts).toEqual([60_000]);
    expect(execution.scriptId).toBe('local.script.000001');
    expect(execution.notice).toBe(
      "Registered as permanent script local.script.000001. You can reuse it by calling cap.call('local.script.000001', xxx).",
    );

    const registry = await app.scriptRegistryList();
    expect(registry.find((script) => script.id === 'local.script.000001')?.script.timeoutMs).toBe(
      30_000,
    );

    expect(registry.some((script) => script.id === 'local.script.000001')).toBe(true);
  });

  it('does not register requested inline scripts when the result is missing ok', async () => {
    const seenRegistryIds: string[][] = [];

    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      seenRegistryIds.push(envelope.payload.scriptRegistry.map((script) => script.id));

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { value: 1 },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { value: 1 }; }',
      input: {},
      register: true,
    });

    expect(execution.scriptId).toBe('temp.script.000001');
    expect(execution.notice).toBe(
      'Script local.script.000001 was not registered because register=true requires the execution result to include ok: true. It remains available temporarily as temp.script.000001.',
    );
    const registry = await app.scriptRegistryList();
    expect(registry.map((script) => script.id)).not.toContain('local.script.000001');
    expect(registry.map((script) => script.id)).not.toContain('temp.script.000001');

    await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
    });

    expect(seenRegistryIds[1]).not.toContain('local.script.000001');
    expect(seenRegistryIds[1]).toContain('temp.script.000001');
  });

  it('does not register requested inline scripts when ok is false', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: false },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: false }; }',
      input: {},
      register: true,
    });

    expect(execution.scriptId).toBe('temp.script.000001');
    expect(execution.notice).toBe(
      'Script local.script.000001 was not registered because register=true requires the execution result to include ok: true. It remains available temporarily as temp.script.000001.',
    );
    const registry = await app.scriptRegistryList();
    expect(registry.map((script) => script.id)).not.toContain('local.script.000001');
    expect(registry.map((script) => script.id)).not.toContain('temp.script.000001');
  });

  it('keeps successfully executed scripts temporary when provider registration fails', async () => {
    scriptProvider.saveRecord = vi.fn(async () => {
      throw new Error('registry offline');
    });

    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const execution = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      register: true,
    });

    expect(execution.status).toBe('succeeded');
    expect(execution.scriptId).toBe('temp.script.000001');
    expect(execution.notice).toBe(
      'Script local.script.000001 could not be registered: registry offline. It remains available temporarily as temp.script.000001.',
    );
    const registry = await app.scriptRegistryList();
    expect(registry.map((script) => script.id)).not.toContain('local.script.000001');
    expect(registry.map((script) => script.id)).not.toContain('temp.script.000001');
  });

  it('records failed script executions in local history', async () => {
    await connectRuntime();

    client?.send(
      JSON.stringify(
        createRuntimeEnvelope(
          'tab_snapshot',
          {
            activeTabId: 102,
            tabs: [
              {
                tabId: 102,
                url: 'chrome://settings',
                title: 'Settings',
                site: 'chrome',
                readyState: 'complete',
                updatedAt: new Date().toISOString(),
              },
            ],
            authenticatedSites: [],
          },
          { sessionId: 'runtime-session' },
        ),
      ),
    );

    await waitFor(() => app.sessionStatus().activeTab?.tabId === 102);

    await expect(
      app.scriptExecute({
        script: 'export default async function () { return { ok: true }; }',
        input: {},
      }),
    ).rejects.toThrow(/does not match script target patterns/i);

    const historyRaw = await readFile(join(tempDir, 'script-execution-history.json'), 'utf8');
    const history = JSON.parse(historyRaw) as {
      entries: Array<{
        localScriptId: string;
        status: string;
        script?: string;
        scriptPath: string;
        error?: { code?: string; message: string };
      }>;
    };

    expect(history.entries[0]?.localScriptId).toBe('temp.script.000001');
    expect(history.entries[0]?.status).toBe('failed');
    expect(history.entries[0]?.script).toBeUndefined();
    expect(history.entries[0]?.error?.code).toBe('PAGE_MISMATCH');
    await expect(readFile(history.entries[0]!.scriptPath, 'utf8')).resolves.toBe(
      'export default async function () { return { ok: true }; }',
    );
  });

  it('keeps only the most recent script history entries up to the configured limit', async () => {
    const history = new ScriptExecutionHistory(join(tempDir, 'bounded-script-history.json'), 3);

    for (let index = 0; index < 4; index += 1) {
      const entry = await history.reserve(
        `export default async function () { return { index: ${index} }; }`,
        { index },
      );
      await history.markFailed(entry.localScriptId, new Error(`failure-${index}`));
    }

    const entries = await history.list();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.localScriptId)).toEqual([
      'temp.script.000004',
      'temp.script.000003',
      'temp.script.000002',
    ]);
  });

  it('migrates legacy inline script history to script files', async () => {
    const legacyPath = join(tempDir, 'legacy-script-history.json');
    await writeFile(
      legacyPath,
      `${JSON.stringify(
        {
          nextSequence: 2,
          entries: [
            {
              localScriptId: 'temp.script.000001',
              script: 'export default async function () {}',
              input: {},
              status: 'failed',
              error: { message: 'boom' },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const history = new ScriptExecutionHistory(legacyPath);

    await expect(history.list()).resolves.toMatchObject([
      {
        localScriptId: 'temp.script.000001',
        script: 'export default async function () {}',
        status: 'failed',
      },
    ]);
    const migratedRaw = await readFile(legacyPath, 'utf8');
    expect(migratedRaw).not.toContain('"script": "export default async function () {}"');
    await expect(
      readFile(join(tempDir, 'legacy-script-history', 'scripts', 'temp.script.000001.js'), 'utf8'),
    ).resolves.toBe('export default async function () {}');
  });

  it('removes inline scripts from mixed history index entries', async () => {
    const historyPath = join(tempDir, 'mixed-script-history.json');
    const scriptPath = join(tempDir, 'mixed-script-history', 'scripts', 'temp.script.000001.js');
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(
      scriptPath,
      'export default async function () { return { old: true }; }',
      'utf8',
    );
    await writeFile(
      historyPath,
      `${JSON.stringify(
        {
          nextSequence: 2,
          entries: [
            {
              localScriptId: 'temp.script.000001',
              script: 'export default async function () { return { newer: true }; }',
              scriptPath,
              input: {},
              status: 'running',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const history = new ScriptExecutionHistory(historyPath);

    await expect(history.list()).resolves.toMatchObject([
      {
        localScriptId: 'temp.script.000001',
        script: 'export default async function () { return { old: true }; }',
      },
    ]);
    const migratedRaw = await readFile(historyPath, 'utf8');
    expect(migratedRaw).not.toContain('"script":');
  });

  it('lists recent script history entries through the app service', async () => {
    const first = await app.scriptExecutionHistory.reserve('export default async function () {}', {
      step: 1,
    });
    await app.scriptExecutionHistory.markFailed(first.localScriptId, new Error('boom'));

    const second = await app.scriptExecutionHistory.reserve(
      'export default async function () { return { ok: true }; }',
      {
        step: 2,
      },
    );

    const entries = await app.scriptHistoryList(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.localScriptId).toBe(second.localScriptId);
    expect(entries[0]?.status).toBe('running');
  });

  it('pushes script history snapshots to connected runtimes', async () => {
    const historySnapshots: Array<
      Array<{ localScriptId: string; status: string }>
    > = [];

    await connectRuntime((envelope) => {
      if (envelope.type === 'script_history_sync') {
        historySnapshots.push(
          envelope.payload.entries.map((entry) => ({
            localScriptId: entry.localScriptId,
            status: entry.status,
          })),
        );
        return;
      }

      if (envelope.type !== 'execute_script') {
        return;
      }

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { echoed: 'synced' },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inline script' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    await app.scriptExecute({
      script: 'export default async function () { return { echoed: "synced" }; }',
      input: {},
    });

    await waitFor(() =>
      historySnapshots.some(
        (snapshot) =>
          snapshot[0]?.localScriptId === 'temp.script.000001' &&
          snapshot[0]?.status === 'succeeded',
      ),
    );
  });

  it('uses the optional inline script execution timeout only for the current run', async () => {
    const executionTimeouts: number[] = [];
    const reusedTimeouts: number[] = [];
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      executionTimeouts.push(envelope.payload.scriptDefinition.script.timeoutMs);
      const reusableScript = envelope.payload.scriptRegistry.find(
        (script) => script.id === 'temp.script.000001',
      );
      if (reusableScript) {
        reusedTimeouts.push(reusableScript.script.timeoutMs);
      }
      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: { ok: true },
              evidence: {
                url: 'https://example.com/form',
                events: [],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const result = await app.scriptExecute({
      script: 'export default async function () { return { ok: true }; }',
      input: {},
      options: { timeoutMs: 60_000 },
    });

    expect(result.status).toBe('succeeded');
    expect(executionTimeouts).toEqual([60_000]);

    const history = await app.scriptHistoryList();
    expect(history[0]?.options).toBeUndefined();

    await app.scriptExecute({
      script: "(input) => cap.call('temp.script.000001', input)",
      input: {},
    });
    expect(executionTimeouts).toEqual([60_000, 30_000]);
    expect(reusedTimeouts).toEqual([30_000]);
  });

  it('defaults inline script execution timeout to 30 seconds and rejects values above 60 seconds', async () => {
    await connectRuntime();

    const parsed = scriptDefinitionSchema.parse({
      id: 'default.timeout',
      name: 'Default Timeout',
      version: '1.0.0',
      status: 'active',
      type: 'read',
      summary: 'Uses the schema default timeout.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: [],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        code: 'export default async function () { return { ok: true }; }',
      },
    });

    expect(parsed.script.timeoutMs).toBe(30_000);
    expect(() =>
      scriptDefinitionSchema.parse({
        ...parsed,
        script: {
          ...parsed.script,
          timeoutMs: 60_001,
        },
      }),
    ).toThrow(/less than or equal to 60000/i);

    await expect(
      app.scriptExecute({
        script: 'export default async function () { return { ok: true }; }',
        input: {},
        options: { timeoutMs: 60_001 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('allows multiple MCP adapters to share one runtime daemon over RPC', async () => {
    await connectRuntime();

    const rpcServer = new WebCapRpcServer(app, 0);
    await rpcServer.start();

    const firstAdapter = new WebCapRpcClient(rpcServer.getPort());
    const secondAdapter = new WebCapRpcClient(rpcServer.getPort());

    try {
      await firstAdapter.start();
      await secondAdapter.start();

      const status = await firstAdapter.sessionStatus();
      const secondStatus = await secondAdapter.sessionStatus();

      expect(status.connected).toBe(true);
      expect(status.activeTab?.url).toBe('https://example.com/form');
      expect(secondStatus.connected).toBe(true);
    } finally {
      await firstAdapter.close();
      await secondAdapter.close();
      await rpcServer.close();
    }
  });

  it('validates RPC input before dispatching to the app service', async () => {
    const rpcServer = new WebCapRpcServer(app, 0);
    await rpcServer.start();

    const adapter = new WebCapRpcClient(rpcServer.getPort());
    try {
      await adapter.start();

      await expect(
        adapter.scriptExecute({ script: '', input: {}, options: { tabId: 101 } }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    } finally {
      await adapter.close();
      await rpcServer.close();
    }
  });

  it('keeps RPC script execution requests alive for the requested execution timeout', async () => {
    const rpcApp = {
      async start() {},
      async close() {},
      async scriptExecute() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          scriptId: 'temp.script.000001',
          status: 'succeeded',
          result: { ok: true },
          evidence: { events: [], screenshots: [] },
          timingMs: 40,
          tab: {
            tabId: 101,
            url: 'https://example.com/form',
            title: 'Example Form',
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
    const rpcServer = new WebCapRpcServer(rpcApp, 0);
    await rpcServer.start();
    const adapter = new WebCapRpcClient(rpcServer.getPort(), 30);

    try {
      await adapter.start();
      await expect(
        adapter.scriptExecute({
          script: 'export default async function () { return { ok: true }; }',
          input: {},
          options: { timeoutMs: 100 },
        }),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: { ok: true },
      });
    } finally {
      await adapter.close().catch(() => undefined);
      await rpcServer.close();
    }
  });

  it('creates a new browser tab through the shared runtime bridge', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'browser_command') {
        return;
      }

      expect(envelope.payload.command).toBe('create_tab');
      expect(envelope.payload.input).toEqual({
        url: 'https://example.com/new',
        active: true,
      });

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'browser_command_result',
            {
              result: {
                createdTab: {
                  tabId: 202,
                  url: 'https://example.com/new',
                  title: 'New Tab',
                  site: 'example.com',
                  readyState: 'loading',
                  updatedAt: new Date().toISOString(),
                },
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const result = await app.browserNewTab({
      url: 'https://example.com/new',
      active: true,
    });

    expect(result.command).toBe('create_tab');
    expect(result.result).toEqual({
      createdTab: {
        tabId: 202,
        url: 'https://example.com/new',
        title: 'New Tab',
        site: 'example.com',
        readyState: 'loading',
        updatedAt: expect.any(String),
      },
    });
  });

  it('captures a browser screenshot through the shared runtime bridge', async () => {
    process.env.WEB_CAP_STATE_DIR = tempDir;
    const screenshotDirectory = join(tempDir, 'temp-screenshots');
    await mkdir(screenshotDirectory, { recursive: true });
    const expiredScreenshot = join(screenshotDirectory, 'screenshot-old.png');
    const freshScreenshot = join(screenshotDirectory, 'screenshot-fresh.jpg');
    const nonScreenshotFile = join(screenshotDirectory, 'notes.txt');
    await writeFile(expiredScreenshot, 'old');
    await writeFile(freshScreenshot, 'fresh');
    await writeFile(nonScreenshotFile, 'notes');
    const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(expiredScreenshot, expiredDate, expiredDate);

    const screenshotBytes = Buffer.from('jpeg image bytes');
    await connectRuntime((envelope) => {
      if (envelope.type !== 'browser_command') {
        return;
      }

      expect(envelope.payload.command).toBe('browser_screenshot');
      expect(envelope.payload.tabId).toBe(101);
      expect(envelope.payload.input).toEqual({
        type: 'jpeg',
        quality: 80,
        fullPage: true,
      });

      const transferId = 'browser-screenshot-transfer';
      client?.send(JSON.stringify(createRuntimeEnvelope(
        'binary_payload_start',
        {
          transferId,
          kind: 'screenshot',
          mimeType: 'image/jpeg',
          type: 'jpeg',
          byteLength: screenshotBytes.byteLength,
          resultShape: 'metadata',
        },
        { sessionId: 'runtime-session', requestId: envelope.requestId },
      )));
      client?.send(screenshotBytes);
      client?.send(JSON.stringify(createRuntimeEnvelope(
        'browser_command_result',
        {
          result: {
            __webCapType: 'screenshot_transfer',
            transferId,
            resultShape: 'metadata',
          },
        },
        { sessionId: 'runtime-session', requestId: envelope.requestId },
      )));
    });

    const result = await app.browserScreenshot({
      tabId: 101,
      type: 'jpeg',
      quality: 80,
      fullPage: true,
    });

    expect(result.result).toMatchObject({
      sizeBytes: screenshotBytes.byteLength,
    });
    expect(result.result.path).toEqual(expect.stringContaining(screenshotDirectory));
    expect(result.result).not.toHaveProperty('data');
    expect(result).not.toHaveProperty('command');
    expect(result.tab).toEqual({
      tabId: 101,
      url: 'https://example.com/form',
      title: 'Example Form',
    });

    const storedPath = result.result.path;
    if (typeof storedPath !== 'string') {
      throw new Error('Expected screenshot path.');
    }
    await expect(readFile(storedPath)).resolves.toEqual(screenshotBytes);
    await expect(readFile(expiredScreenshot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(freshScreenshot, 'utf8')).resolves.toBe('fresh');
    await expect(readFile(nonScreenshotFile, 'utf8')).resolves.toBe('notes');
    await expect(stat(storedPath)).resolves.toMatchObject({ size: screenshotBytes.byteLength });
  });

  it('waits for browser events with routed tab input and event streaming', async () => {
    const observedEvents: Record<string, unknown>[] = [];
    await connectRuntime((envelope) => {
      if (envelope.type !== 'browser_command') {
        return;
      }

      expect(envelope.payload.command).toBe('wait_events');
      expect(envelope.payload.tabId).toBe(101);
      expect(envelope.payload.input).toEqual({
        durationMs: 250,
      });

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'browser_command_event',
            {
              event: {
                type: 'wait_started',
                value: { durationMs: 250 },
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );

      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'browser_command_result',
            {
              result: {
                ok: true,
                durationMs: 250,
                eventCount: 1,
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const result = await app.browserWaitEvents(
      {
        durationMs: 250,
        tabId: 101,
      },
      (event) => observedEvents.push(event),
    );

    expect(observedEvents).toEqual([
      {
        type: 'wait_started',
        value: { durationMs: 250 },
      },
    ]);
    expect(result.command).toBe('wait_events');
    expect(result.result).toEqual({
      ok: true,
      durationMs: 250,
      eventCount: 1,
    });
  });

  it('keeps browser command timeout independent from script execution defaults', async () => {
    await connectRuntime();
    vi.useFakeTimers();

    const resultPromise = expect(
      app.browserNewTab({
        url: 'https://example.com/new',
        active: true,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Browser command create_tab timed out after 15000ms.',
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await resultPromise;
  });

  it('reconnects an MCP adapter after the RPC daemon restarts', async () => {
    await connectRuntime();

    const firstRpcServer = new WebCapRpcServer(app, 0);
    await firstRpcServer.start();
    const port = firstRpcServer.getPort();
    const adapter = new WebCapRpcClient(port);

    try {
      await adapter.start();
      expect((await adapter.sessionStatus()).connected).toBe(true);

      await firstRpcServer.close();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const secondRpcServer = new WebCapRpcServer(app, port);
      await secondRpcServer.start();
      try {
        expect((await adapter.sessionStatus()).connected).toBe(true);
      } finally {
        await secondRpcServer.close();
      }
    } finally {
      await adapter.close().catch(() => undefined);
      await firstRpcServer.close().catch(() => undefined);
    }
  });

  it('can invoke daemon auto-start while reconnecting', async () => {
    const startDaemon = vi.fn();
    const adapter = new WebCapRpcClient(9, 100, {
      autoStartDaemon: true,
      connectTimeoutMs: 30,
      retryIntervalMs: 5,
      startDaemon,
    });

    try {
      await expect(adapter.sessionStatus()).rejects.toThrow(/did not become ready/i);
      expect(startDaemon).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });

  it('waits briefly for browser runtime after auto-starting the daemon', async () => {
    const port = await findAvailablePort();
    let rpcServer: WebCapRpcServer | undefined;
    const startDaemon = vi.fn(() => {
      void (async () => {
        rpcServer = new WebCapRpcServer(app, port);
        await rpcServer.start();
        setTimeout(() => {
          void connectRuntime();
        }, 30);
      })();
    });
    const adapter = new WebCapRpcClient(port, 1_000, {
      autoStartDaemon: true,
      connectTimeoutMs: 500,
      retryIntervalMs: 5,
      runtimeReconnectGraceMs: 500,
      startDaemon,
    });

    try {
      const status = await adapter.sessionStatus();

      expect(status.connected).toBe(true);
      expect(status.activeTab?.tabId).toBe(101);
      expect(startDaemon).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close().catch(() => undefined);
      await rpcServer?.close();
    }
  });

  it('restarts a stale daemon when the build id mismatches', async () => {
    const staleBuildId = 'stale-build';
    const freshBuildId = 'fresh-build';
    const staleServer = new WebCapRpcServer(app, 0, {
      buildId: staleBuildId,
    });
    await staleServer.start();

    const port = staleServer.getPort();
    let activeServer: WebCapRpcServer = staleServer;
    let restartPromise: Promise<void> | undefined;
    const startDaemon = vi.fn(() => {
      if (restartPromise) {
        return;
      }

      restartPromise = (async () => {
        await activeServer.close();
        activeServer = new WebCapRpcServer(app, port, {
          buildId: freshBuildId,
        });
        await activeServer.start();
      })();
    });

    const adapter = new WebCapRpcClient(port, 500, {
      autoStartDaemon: true,
      expectedBuildId: freshBuildId,
      retryIntervalMs: 5,
      startDaemon,
    });

    try {
      await adapter.start();
      await restartPromise;
      expect(startDaemon).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close().catch(() => undefined);
      await activeServer.close().catch(() => undefined);
    }
  });

  it('uses a 60 second daemon idle timeout by default', () => {
    expect(DEFAULT_DAEMON_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(getDaemonIdleTimeoutMs({})).toBe(60_000);
    expect(getDaemonIdleTimeoutMs({ WEB_CAP_DAEMON_IDLE_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(getDaemonIdleTimeoutMs({ WEB_CAP_DAEMON_IDLE_TIMEOUT_MS: '0' })).toBe(0);
  });

  it('schedules daemon shutdown after the last MCP adapter disconnects', async () => {
    const shutdown = vi.fn();
    const idleShutdown = new DaemonIdleShutdown(20, shutdown);
    const rpcServer = new WebCapRpcServer(app, 0, {
      onClientCountChanged: (clientCount) => idleShutdown.handleClientCountChanged(clientCount),
    });
    await rpcServer.start();
    idleShutdown.handleClientCountChanged(rpcServer.getClientCount());

    const adapter = new WebCapRpcClient(rpcServer.getPort());

    try {
      await adapter.start();
      expect(rpcServer.getClientCount()).toBe(1);

      await adapter.close();
      await waitFor(() => rpcServer.getClientCount() === 0);
      expect(shutdown).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      idleShutdown.cancel();
      await adapter.close().catch(() => undefined);
      await rpcServer.close();
    }
  });

  it('cancels daemon idle shutdown when a new MCP adapter connects', async () => {
    const shutdown = vi.fn();
    const idleShutdown = new DaemonIdleShutdown(30, shutdown);

    try {
      idleShutdown.handleClientCountChanged(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      idleShutdown.handleClientCountChanged(1);

      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      idleShutdown.cancel();
    }
  });

  it('keeps daemon idle shutdown cancelled while a browser runtime is connected', async () => {
    const shutdown = vi.fn();
    const idleShutdown = new DaemonIdleShutdown(25, shutdown);
    let runtimeCount = 0;
    const idleAwareBridge = new WebSocketRuntimeBridge({
      port: 0,
      onRuntimeCountChanged: (count) => {
        runtimeCount = count;
        idleShutdown.handleClientCountChanged(runtimeCount);
      },
    });
    const idleAwareApp = new WebCapAgentApp({
      runtimeBridge: idleAwareBridge,
      scriptProvider: new MemoryScriptProvider([]),
      scriptExecutionHistory: new ScriptExecutionHistory(
        join(tempDir, 'idle-script-execution-history.json'),
      ),
    });
    let runtimeClient: WebSocket | undefined;

    try {
      await idleAwareApp.start();
      idleShutdown.handleClientCountChanged(0);

      runtimeClient = new WebSocket(`ws://127.0.0.1:${idleAwareBridge.getPort()}`);
      await new Promise<void>((resolve) => {
        runtimeClient?.once('open', resolve);
      });
      runtimeClient.send(
        JSON.stringify(
          createRuntimeEnvelope('hello', {
            browserName: 'vitest',
            extensionVersion: '1.0.0',
            protocolVersion: '2026-05-05',
            authenticatedSites: [],
          }),
        ),
      );

      await waitFor(() => idleAwareBridge.getRuntimeCount() === 1 && runtimeCount === 1);
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(shutdown).not.toHaveBeenCalled();

      runtimeClient.close();
      await waitFor(() => idleAwareBridge.getRuntimeCount() === 0 && runtimeCount === 0);
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      idleShutdown.cancel();
      runtimeClient?.close();
      await idleAwareApp.close();
    }
  });

  it('rejects page mismatch before runtime execution', async () => {
    await connectRuntime();

    client?.send(
      JSON.stringify(
        createRuntimeEnvelope(
          'tab_snapshot',
          {
            activeTabId: 102,
            tabs: [
              {
                tabId: 102,
                url: 'chrome://settings',
                title: 'Settings',
                site: 'chrome',
                readyState: 'complete',
                updatedAt: new Date().toISOString(),
              },
            ],
            authenticatedSites: [],
          },
          { sessionId: 'runtime-session' },
        ),
      ),
    );

    await waitFor(() => app.sessionStatus().activeTab?.tabId === 102);

    await expect(
      app.scriptExecute({
        script: "(input) => cap.call('cap_page_inspect_summary', input)",
        input: {},
      }),
    ).rejects.toThrow(/does not match script target patterns/i);
  });

  it('returns interrupted when the browser runtime does not answer before the response grace timeout', async () => {
    await connectRuntime();
    vi.useFakeTimers();

    const script = scriptDefinitionSchema.parse({
      id: 'timeout.test',
      name: 'Timeout Test',
      version: '1.0.0',
      status: 'active',
      type: 'act',
      summary: 'Times out.',
      target: {
        site: 'generic-web',
        urlPatterns: ['http://*', 'https://*'],
        pageHints: [],
      },
      tags: ['test'],
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: true,
      },
      script: {
        timeoutMs: 10,
        code: 'export default async function () { return { ok: true }; }',
      },
    });

    const executionPromise = bridge.executeScript(script, {}, { evidence: ['events'] });
    await vi.advanceTimersByTimeAsync(5_010);
    const execution = await executionPromise;

    expect(execution.status).toBe('interrupted');
    expect(execution.result).toMatchObject({
      interrupted: true,
      reason: 'timeout',
    });
    expect(execution.evidence.events).toContainEqual({
      type: 'execution_interrupted_by_timeout',
      value: expect.objectContaining({
        scriptId: 'timeout.test',
        timeoutMs: 10,
        responseTimeoutMs: 5010,
      }),
    });
  });

  it('runs builtin.page.inspect through script execution', async () => {
    await connectRuntime((envelope) => {
      if (envelope.type !== 'execute_script') {
        return;
      }

      expect(envelope.payload.scriptDefinition.id).toBe('temp.script.000001');
      client?.send(
        JSON.stringify(
          createRuntimeEnvelope(
            'execution_result',
            {
              result: {
                url: 'https://example.com/form',
                title: 'Example Form',
                readyState: 'complete',
                linkCount: 3,
                inputCount: 1,
                inputs: [],
              },
              evidence: {
                url: 'https://example.com/form',
                events: [{ type: 'message', value: 'inspect page' }],
                screenshots: [],
              },
            },
            { sessionId: 'runtime-session', requestId: envelope.requestId },
          ),
        ),
      );
    });

    const result = await app.scriptExecute({
      script: "(input) => cap.call('builtin.page.inspect', input)",
      input: {},
      options: { tabId: 101 },
    });
    expect(result.status).toBe('succeeded');
    expect(result.result.title).toBe('Example Form');
  });

  it(
    'default script provider loads builtin scripts and local file registry records together',
    async () => {
      const stateDir = join(tempDir, 'state');
      const provider = createDefaultScriptProvider({
        WEB_CAP_STATE_DIR: stateDir,
      });
      await provider.saveRecord({
        id: 'persisted.script',
        scriptDefinition: scriptDefinitionSchema.parse({
          id: 'persisted.script',
          name: 'Persisted Script',
          version: '1.0.0',
          status: 'active',
          type: 'read',
          summary: 'Persisted script',
          target: {
            site: 'generic-web',
            urlPatterns: ['http://*', 'https://*'],
            pageHints: [],
          },
          tags: ['persisted'],
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
            },
            required: ['ok'],
            additionalProperties: false,
          },
          script: {
            timeoutMs: 1000,
            code: 'export default async function () { return { ok: true }; }',
          },
        }),
        status: 'active',
      });

      const builtin = await provider.getById('builtin.page.inspect');
      const persisted = await provider.getById('persisted.script');
      const scriptFile = join(stateDir, 'scripts', 'generic-web', 'persisted.script.js');
      const indexFile = join(stateDir, 'script-registry.sqlite');
      const scriptSource = await readFile(scriptFile, 'utf8');

      expect(builtin?.id).toBe('builtin.page.inspect');
      expect(persisted?.id).toBe('persisted.script');
      expect(scriptSource).toContain('web-cap-script');
      expect(scriptSource).toContain('"lastExecutedPage": null');
      expect(await readFile(indexFile)).toBeInstanceOf(Buffer);

      await provider.saveRecord(
        {
          id: 'url.script',
          scriptDefinition: scriptDefinitionSchema.parse({
            id: 'url.script',
            name: 'URL Script',
            version: '1.0.0',
            status: 'active',
            type: 'read',
            summary: 'URL-backed script',
            target: {
              site: 'generic-web',
              urlPatterns: ['http://*', 'https://*'],
              pageHints: [],
            },
            tags: ['url'],
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
              },
              required: ['ok'],
              additionalProperties: false,
            },
            script: {
              timeoutMs: 1000,
              code: 'export default async function () { return { ok: true }; }',
            },
          }),
          status: 'active',
        },
        { lastExecutedPage: 'https://example.com/form' },
      );
      const urlScriptSource = await readFile(
        join(stateDir, 'scripts', 'example.com', 'url.script.js'),
        'utf8',
      );

      expect(urlScriptSource).toContain('"lastExecutedPage": "https://example.com/form"');
      expect(urlScriptSource).toContain('"site": "generic-web"');
      expect((await provider.getById('url.script'))?.id).toBe('url.script');

      await removeFileWithRetries(indexFile);
      await removeFileWithRetries(`${indexFile}-wal`);
      await removeFileWithRetries(`${indexFile}-shm`);
      expect((await provider.getById('persisted.script'))?.id).toBe('persisted.script');

      await removeFileWithRetries(`${indexFile}-wal`);
      await removeFileWithRetries(`${indexFile}-shm`);
      await writeFile(indexFile, 'not a sqlite index', 'utf8');
      expect((await provider.getById('persisted.script'))?.id).toBe('persisted.script');
    },
    20_000,
  );

  it('defaults state dir to the user home when WEB_CAP_STATE_DIR is unset on POSIX platforms', () => {
    const stateDir = resolveWebCapStateDir({}, 'darwin', '/Users/ada');

    expect(stateDir).toBe(join('/Users/ada', '.web-cap'));
  });

  it('uses LOCALAPPDATA for the default Windows state dir', () => {
    const stateDir = resolveWebCapStateDir(
      { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
      'win32',
      'C:\\Users\\Ada',
    );

    expect(stateDir).toBe(join('C:\\Users\\Ada\\AppData\\Local', 'web-cap'));
  });

  it('falls back to the Windows local app data path under home', () => {
    const stateDir = resolveWebCapStateDir({}, 'win32', 'C:\\Users\\Ada');

    expect(stateDir).toBe(join('C:\\Users\\Ada', 'AppData', 'Local', 'web-cap'));
  });
});

async function removeFileWithRetries(path: string): Promise<void> {
  await removePathWithRetries(path);
}

async function removePathWithRetries(
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(path, { recursive: options.recursive ?? false, force: true });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === 29) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 25));
    }
  }
}

function isRetryableRemoveError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!address || typeof address === 'string') {
    throw new Error('Failed to reserve an available port.');
  }

  return address.port;
}
