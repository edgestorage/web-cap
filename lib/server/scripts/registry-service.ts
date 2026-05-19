import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  cloudScriptRecordSchema,
  scriptDefinitionSchema,
  type CloudScriptRecord,
  type ScriptDefinition,
  type ScriptSearchFilters,
} from '@shared/script-schema';
import type { ScriptExecutionHistoryEntry } from '@shared/protocol';
import { toSchemaSummary } from '@shared/validation';
import type { ScriptExecutionHistory } from './execution-history';
import {
  builtinScripts,
  getBuiltinScriptById,
} from './builtin-scripts';
import type { ScriptProvider, ScriptSaveContext } from '../providers/script-provider';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';

export class ScriptRegistryService {
  constructor(
    private readonly scriptProvider: ScriptProvider,
    private readonly scriptExecutionHistory: ScriptExecutionHistory,
  ) {}

  async search(query: string, filters?: ScriptSearchFilters) {
    return await this.scriptProvider.search(query, filters);
  }

  async getSchemaSummary(scriptId: string, version?: string) {
    return toSchemaSummary(await this.getScriptDefinition(scriptId, version));
  }

  async getScriptDefinition(scriptId: string, version?: string): Promise<ScriptDefinition> {
    const scriptDefinition =
      getBuiltinScriptById(scriptId) ??
      (await this.scriptProvider.getById(scriptId, version)) ??
      (await this.getHistoryScriptDefinition(scriptId));
    if (!scriptDefinition) {
      throw new RuntimeBridgeError(
        `Script ${scriptId} was not found.`,
        'SCRIPT_NOT_FOUND',
      );
    }

    return scriptDefinition;
  }

  async register(rawScriptDefinition: unknown): Promise<CloudScriptRecord> {
    const scriptDefinition = scriptDefinitionSchema.parse(rawScriptDefinition);
    assertRegisterableOutputSchema(scriptDefinition);
    return await this.saveScriptDefinition(scriptDefinition);
  }

  async saveScriptDefinition(
    scriptDefinition: ScriptDefinition,
    context?: ScriptSaveContext,
  ): Promise<CloudScriptRecord> {
    const now = new Date().toISOString();
    const record = cloudScriptRecordSchema.parse({
      id: scriptDefinition.id,
      scriptDefinition,
      status: scriptDefinition.status,
      publishedAt: now,
      updatedAt: now,
    });

    return await this.scriptProvider.saveRecord(record, context);
  }

  async buildRegisteredScriptRegistry(): Promise<ScriptDefinition[]> {
    return dedupeScriptDefinitions([
      ...builtinScripts,
      ...(await this.buildActiveProviderScriptDefinitions()),
    ]);
  }

  async buildExecutionScriptRegistry(currentScriptId: string): Promise<ScriptDefinition[]> {
    const historyScriptDefinitions = (await this.scriptExecutionHistory.list())
      .filter(isReusableTemporaryHistoryScript)
      .map((entry) => buildInlineScriptDefinition(entry.localScriptId, entry.script));

    return dedupeScriptDefinitions([
      ...builtinScripts,
      ...(await this.buildActiveProviderScriptDefinitions()),
      ...historyScriptDefinitions,
    ]).filter((candidate) => candidate.id !== currentScriptId);
  }

  private async getHistoryScriptDefinition(scriptId: string): Promise<ScriptDefinition | undefined> {
    if (!isTempScriptId(scriptId)) {
      return undefined;
    }

    const entry = await this.scriptExecutionHistory.get(scriptId);
    if (!entry || !isReusableTemporaryHistoryScript(entry)) {
      return undefined;
    }

    return buildInlineScriptDefinition(entry.localScriptId, entry.script);
  }

  private async buildActiveProviderScriptDefinitions(): Promise<ScriptDefinition[]> {
    const records = await this.scriptProvider.listRecords();
    return records
      .filter((record) => record.status === 'active')
      .map((record) => record.scriptDefinition);
  }
}

export function buildInlineScriptDefinition(
  localScriptId: string,
  script: string,
  timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
): ScriptDefinition {
  return scriptDefinitionSchema.parse({
    id: localScriptId,
    name: localScriptId,
    version: '1.0.0',
    status: 'active',
    type: 'act',
    summary: 'Temporary local script execution.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Any regular web page'],
    },
    tags: ['local-script'],
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    script: {
      code: script,
      timeoutMs,
    },
  });
}

export function isTempScriptId(scriptId: string): boolean {
  return scriptId.startsWith('temp.script.');
}

function isReusableTemporaryHistoryScript(entry: ScriptExecutionHistoryEntry): boolean {
  return (
    isTempScriptId(entry.localScriptId) &&
    (entry.status === 'succeeded' || entry.status === 'interrupted')
  );
}

function assertRegisterableOutputSchema(scriptDefinition: ScriptDefinition): void {
  if (
    !Object.prototype.hasOwnProperty.call(scriptDefinition.outputSchema.properties, 'ok') ||
    !scriptDefinition.outputSchema.required.includes('ok')
  ) {
    throw new RuntimeBridgeError(
      'Registered scripts must declare outputSchema.properties.ok and include ok in outputSchema.required.',
      'INVALID_INPUT',
    );
  }
}

function dedupeScriptDefinitions(scripts: ScriptDefinition[]): ScriptDefinition[] {
  return scripts.filter(
    (candidate, index, list) =>
      list.findIndex((item) => item.id === candidate.id) === index,
  );
}
