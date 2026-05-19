import type {
  ScriptDefinition,
  ScriptSearchFilters,
  ScriptSearchResult,
  CloudScriptRecord,
} from '@shared/script-schema';
import type { ScriptProvider } from './script-provider';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function scoreRecord(record: CloudScriptRecord, query: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 1;
  }

  const corpus = tokenize(
    [
      record.scriptDefinition.name,
      record.scriptDefinition.summary,
      ...record.scriptDefinition.tags,
      record.scriptDefinition.target.site,
    ].join(' '),
  );

  const matchCount = queryTokens.filter((token) => corpus.includes(token)).length;
  return matchCount / queryTokens.length;
}

export class MemoryScriptProvider implements ScriptProvider {
  constructor(private readonly records: CloudScriptRecord[] = []) {}

  async search(
    query: string,
    filters?: ScriptSearchFilters,
  ): Promise<ScriptSearchResult[]> {
    return this.records
      .filter((record) => record.status === 'active')
      .filter((record) => !filters?.type || record.scriptDefinition.type === filters.type)
      .filter((record) => !filters?.site || record.scriptDefinition.target.site === filters.site)
      .map((record) => ({
        scriptId: record.scriptDefinition.id,
        name: record.scriptDefinition.name,
        summary: record.scriptDefinition.summary,
        type: record.scriptDefinition.type,
        site: record.scriptDefinition.target.site,
        tags: record.scriptDefinition.tags,
        score: scoreRecord(record, query),
      }))
      .sort((left, right) => right.score - left.score);
  }

  async getById(id: string, version?: string): Promise<ScriptDefinition | null> {
    const record = this.records.find(
      (candidate) =>
        candidate.scriptDefinition.id === id &&
        (!version || candidate.scriptDefinition.version === version),
    );

    return record?.scriptDefinition ?? null;
  }

  async listTargets(site?: string): Promise<Array<{ site: string; urlPatterns: string[] }>> {
    return this.records
      .filter((record) => record.status === 'active')
      .filter((record) => !site || record.scriptDefinition.target.site === site)
      .map((record) => ({
        site: record.scriptDefinition.target.site,
        urlPatterns: record.scriptDefinition.target.urlPatterns,
      }));
  }

  async listRecords(): Promise<CloudScriptRecord[]> {
    return this.records;
  }

  async saveRecord(record: CloudScriptRecord): Promise<CloudScriptRecord> {
    const index = this.records.findIndex(
      (candidate) =>
        candidate.scriptDefinition.id === record.scriptDefinition.id &&
        candidate.scriptDefinition.version === record.scriptDefinition.version,
    );
    if (index >= 0) {
      this.records[index] = record;
    } else {
      this.records.unshift(record);
    }
    return record;
  }
}
