import type {
  ScriptDefinition,
  CloudScriptRecord,
} from '@shared/script-schema';
import type { ScriptProvider } from './script-provider';

export class MemoryScriptProvider implements ScriptProvider {
  constructor(private readonly records: CloudScriptRecord[] = []) {}

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
