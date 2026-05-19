import type {
  ScriptDefinition,
  ScriptSearchFilters,
  ScriptSearchResult,
  CloudScriptRecord,
} from '@shared/script-schema';

export interface ScriptProvider {
  search(
    query: string,
    filters?: ScriptSearchFilters,
  ): Promise<ScriptSearchResult[]>;
  getById(id: string, version?: string): Promise<ScriptDefinition | null>;
  listTargets(site?: string): Promise<Array<{ site: string; urlPatterns: string[] }>>;
  listRecords(): Promise<CloudScriptRecord[]>;
  saveRecord(record: CloudScriptRecord, context?: ScriptSaveContext): Promise<CloudScriptRecord>;
}

export interface ScriptSaveContext {
  lastExecutedPage?: string;
}
