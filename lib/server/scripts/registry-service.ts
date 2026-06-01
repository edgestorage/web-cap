import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  cloudScriptRecordSchema,
  scriptDefinitionSchema,
  type CloudScriptRecord,
  type ScriptDefinition,
} from '@shared/script-schema';
import type { ScriptExecutionHistoryEntry } from '@shared/protocol';
import type { ScriptExecutionHistory } from './execution-history';
import { builtinScripts } from './builtin-scripts';
import type { ScriptProvider, ScriptSaveContext } from '../providers/script-provider';

export class ScriptRegistryService {
  constructor(
    private readonly scriptProvider: ScriptProvider,
    private readonly scriptExecutionHistory: ScriptExecutionHistory,
  ) {}

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

function dedupeScriptDefinitions(scripts: ScriptDefinition[]): ScriptDefinition[] {
  return scripts.filter(
    (candidate, index, list) =>
      list.findIndex((item) => item.id === candidate.id) === index,
  );
}
