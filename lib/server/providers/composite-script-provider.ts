import type {
  ScriptDefinition,
  CloudScriptRecord,
} from '@shared/script-schema';
import type { ScriptProvider, ScriptSaveContext } from './script-provider';

export interface CompositeScriptProviderOptions {
  providers: ScriptProvider[];
  writableProviders?: ScriptProvider[];
}

export class CompositeScriptProvider implements ScriptProvider {
  private readonly providers: ScriptProvider[];
  private readonly writableProviders: ScriptProvider[];

  constructor(options: CompositeScriptProviderOptions) {
    this.providers = options.providers;
    this.writableProviders = options.writableProviders ?? options.providers;
  }

  async getById(id: string, version?: string): Promise<ScriptDefinition | null> {
    for (const provider of this.providers) {
      const scriptDefinition = await provider.getById(id, version);
      if (scriptDefinition) {
        return scriptDefinition;
      }
    }

    return null;
  }

  async listTargets(site?: string): Promise<Array<{ site: string; urlPatterns: string[] }>> {
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.listTargets(site)),
    );

    const merged = new Map<string, { site: string; urlPatterns: Set<string> }>();
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        continue;
      }

      for (const target of result.value) {
        const existing = merged.get(target.site) ?? {
          site: target.site,
          urlPatterns: new Set<string>(),
        };
        target.urlPatterns.forEach((pattern) => existing.urlPatterns.add(pattern));
        merged.set(target.site, existing);
      }
    }

    return [...merged.values()].map((target) => ({
      site: target.site,
      urlPatterns: [...target.urlPatterns],
    }));
  }

  async listRecords(): Promise<CloudScriptRecord[]> {
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.listRecords()),
    );

    const merged = new Map<string, CloudScriptRecord>();
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        continue;
      }

      for (const record of result.value) {
        const key = this.recordKey(record);
        if (!merged.has(key)) {
          merged.set(key, record);
        }
      }
    }

    return [...merged.values()];
  }

  async saveRecord(
    record: CloudScriptRecord,
    context?: ScriptSaveContext,
  ): Promise<CloudScriptRecord> {
    let lastError: unknown;
    for (const provider of this.writableProviders) {
      try {
        return await provider.saveRecord(record, context);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('No script provider accepted the record.');
  }

  private recordKey(record: CloudScriptRecord): string {
    return `${record.scriptDefinition.id}@${record.scriptDefinition.version}`;
  }
}
