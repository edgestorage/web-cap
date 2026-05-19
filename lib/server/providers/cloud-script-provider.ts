import type {
  ScriptDefinition,
  ScriptSearchFilters,
  ScriptSearchResult,
  CloudScriptRecord,
} from '@shared/script-schema';
import {
  scriptDefinitionSchema,
  scriptSearchResultSchema,
  cloudScriptRecordSchema,
} from '@shared/script-schema';
import type { ScriptProvider } from './script-provider';

export interface CloudScriptProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  fallback?: ScriptProvider | null;
}

export class CloudScriptProvider implements ScriptProvider {
  private readonly fallback: ScriptProvider | null;

  constructor(private readonly options: CloudScriptProviderOptions = {}) {
    this.fallback = options.fallback ?? null;
  }

  async search(
    query: string,
    filters?: ScriptSearchFilters,
  ): Promise<ScriptSearchResult[]> {
    const response = await this.fetchJson<unknown>(
      '/scripts/search',
      new URLSearchParams({
        query,
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.site ? { site: filters.site } : {}),
      }),
    );

    if (!response) {
      return this.fallback ? this.fallback.search(query, filters) : [];
    }

    return scriptSearchResultSchema.array().parse(response);
  }

  async getById(id: string, version?: string): Promise<ScriptDefinition | null> {
    const response = await this.fetchJson<unknown>(
      `/scripts/${encodeURIComponent(id)}`,
      version ? new URLSearchParams({ version }) : undefined,
    );

    if (!response) {
      return this.fallback ? this.fallback.getById(id, version) : null;
    }

    return scriptDefinitionSchema.parse(response);
  }

  async listTargets(site?: string): Promise<Array<{ site: string; urlPatterns: string[] }>> {
    const response = await this.fetchJson<unknown>(
      '/scripts/targets',
      site ? new URLSearchParams({ site }) : undefined,
    );

    if (!response) {
      return this.fallback ? this.fallback.listTargets(site) : [];
    }

    return cloudScriptRecordSchema
      .array()
      .parse(response)
      .map((record) => ({
        site: record.scriptDefinition.target.site,
        urlPatterns: record.scriptDefinition.target.urlPatterns,
      }));
  }

  async listRecords(): Promise<CloudScriptRecord[]> {
    const response = await this.fetchJson<unknown>('/scripts');

    if (!response) {
      return this.fallback ? this.fallback.listRecords() : [];
    }

    return cloudScriptRecordSchema.array().parse(response);
  }

  async saveRecord(record: CloudScriptRecord): Promise<CloudScriptRecord> {
    const response = await this.fetchJson<unknown>('/scripts', undefined, {
      method: 'POST',
      body: JSON.stringify(record),
    });

    if (!response) {
      if (this.fallback) {
        return this.fallback.saveRecord(record);
      }

      throw new Error('Cloud script registry is unavailable.');
    }

    return cloudScriptRecordSchema.parse(response);
  }

  private async fetchJson<T>(
    path: string,
    searchParams?: URLSearchParams,
    init: RequestInit = {},
  ): Promise<T | null> {
    if (!this.options.baseUrl) {
      return null;
    }

    const url = new URL(path, this.options.baseUrl);
    if (searchParams) {
      url.search = searchParams.toString();
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
          ...init.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`Cloud registry request failed with ${response.status}.`);
      }

      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
