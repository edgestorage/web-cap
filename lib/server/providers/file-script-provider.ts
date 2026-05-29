import Database from 'better-sqlite3';
import { glob } from 'tinyglobby';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ScriptDefinition,
  CloudScriptRecord,
} from '@shared/script-schema';
import { cloudScriptRecordSchema } from '@shared/script-schema';
import { resolveWebCapStateDir } from '../state-dir';
import type { ScriptProvider, ScriptSaveContext } from './script-provider';

const SCRIPT_METADATA_HEADER = 'web-cap-script';
const SCRIPT_METADATA_SCHEMA_VERSION = 1;

interface ScriptFileMetadata {
  schemaVersion: number;
  id: string;
  status: CloudScriptRecord['status'];
  publishedAt?: string;
  updatedAt?: string;
  createdAt: string;
  lastExecutedPage: string | null;
  scriptDefinition: Omit<ScriptDefinition, 'script'> & {
    script: Omit<ScriptDefinition['script'], 'code'>;
  };
}

interface ScriptIndexRow {
  script_id: string;
  version: string;
  name: string;
  summary: string;
  type: ScriptDefinition['type'];
  site: string;
  tags_json: string;
  status: CloudScriptRecord['status'];
  url_patterns_json: string;
  file_path: string;
  search_text: string;
  last_executed_page: string | null;
}

interface RecordFileMetadataContext {
  lastExecutedPage: string | null;
}

interface ScriptFileRecord {
  record: CloudScriptRecord;
  filePath: string;
  lastExecutedPage: string | null;
}

export class FileScriptProvider implements ScriptProvider {
  private readonly stateDir: string;
  private readonly scriptsDir: string;
  private readonly indexPath: string;

  constructor(stateDir = resolveWebCapStateDir()) {
    this.stateDir = stateDir;
    this.scriptsDir = join(this.stateDir, 'scripts');
    this.indexPath = join(this.stateDir, 'script-registry.sqlite');
  }

  async getById(id: string, version?: string): Promise<ScriptDefinition | null> {
    const row = await this.findIndexRow(id, version);
    if (!row) {
      return null;
    }

    try {
      return (await this.readRecordFile(row.file_path)).scriptDefinition;
    } catch {
      await this.rebuildIndex();
      const rebuilt = await this.findIndexRow(id, version, false);
      return rebuilt ? (await this.readRecordFile(rebuilt.file_path)).scriptDefinition : null;
    }
  }

  async listTargets(site?: string): Promise<Array<{ site: string; urlPatterns: string[] }>> {
    const rows = await this.withIndex((db) => {
      if (site) {
        return db
          .prepare(
            'SELECT site, url_patterns_json FROM script_records WHERE status = ? AND site = ?',
          )
          .all('active', site) as Pick<ScriptIndexRow, 'site' | 'url_patterns_json'>[];
      }

      return db
        .prepare('SELECT site, url_patterns_json FROM script_records WHERE status = ?')
        .all('active') as Pick<ScriptIndexRow, 'site' | 'url_patterns_json'>[];
    });

    return rows.map((row) => ({
      site: row.site,
      urlPatterns: parseJsonArray(row.url_patterns_json),
    }));
  }

  async listRecords(): Promise<CloudScriptRecord[]> {
    const rows = await this.withIndex((db) =>
      db
        .prepare('SELECT file_path FROM script_records ORDER BY script_id ASC, version ASC')
        .all() as Pick<ScriptIndexRow, 'file_path'>[],
    );

    const records: CloudScriptRecord[] = [];
    for (const row of rows) {
      try {
        records.push(await this.readRecordFile(row.file_path));
      } catch {
        await this.rebuildIndex();
        return await this.listRecordsFromRebuiltIndex();
      }
    }
    return records;
  }

  async saveRecord(
    record: CloudScriptRecord,
    context?: ScriptSaveContext,
  ): Promise<CloudScriptRecord> {
    const normalized = cloudScriptRecordSchema.parse(record);
    await this.ensureStorage();

    const pathSite = resolvePathSite(normalized, context?.lastExecutedPage);
    const filePath = this.scriptPathForRecord(normalized, pathSite);
    await mkdir(dirname(filePath), { recursive: true });
    const body = formatRecordFile(normalized, {
      lastExecutedPage: context?.lastExecutedPage ?? null,
    });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, filePath);

    this.upsertIndexRecord(normalized, filePath, {
      lastExecutedPage: context?.lastExecutedPage ?? null,
    });
    return normalized;
  }

  private async findIndexRow(
    id: string,
    version: string | undefined,
    rebuildOnMiss = true,
  ): Promise<ScriptIndexRow | null> {
    const row = await this.withIndex((db) => {
      if (version) {
        return db
          .prepare('SELECT * FROM script_records WHERE script_id = ? AND version = ?')
          .get(id, version) as ScriptIndexRow | undefined;
      }

      return db
        .prepare(
          [
            'SELECT * FROM script_records WHERE script_id = ?',
            "ORDER BY status = 'active' DESC, updated_at DESC, version DESC",
            'LIMIT 1',
          ].join(' '),
        )
        .get(id) as ScriptIndexRow | undefined;
    });

    if (row || !rebuildOnMiss) {
      return row ?? null;
    }

    await this.rebuildIndex();
    return await this.findIndexRow(id, version, false);
  }

  private async listRecordsFromRebuiltIndex(): Promise<CloudScriptRecord[]> {
    const rows = await this.withIndex((db) =>
      db
        .prepare('SELECT file_path FROM script_records ORDER BY script_id ASC, version ASC')
        .all() as Pick<ScriptIndexRow, 'file_path'>[],
    );

    const records: CloudScriptRecord[] = [];
    for (const row of rows) {
      records.push(await this.readRecordFile(row.file_path));
    }
    return records;
  }

  private async withIndex<T>(task: (db: Database.Database) => T): Promise<T> {
    await this.ensureStorage();
    const db = this.openIndex();
    try {
      return task(db);
    } catch {
      db.close();
      await this.rebuildIndex();
      const rebuilt = this.openIndex();
      try {
        return task(rebuilt);
      } finally {
        rebuilt.close();
      }
    } finally {
      if (db.open) {
        db.close();
      }
    }
  }

  private async ensureStorage(): Promise<void> {
    await mkdir(this.scriptsDir, { recursive: true });
    try {
      await this.createOrRefreshIndex();
    } catch {
      await this.removeIndexFiles();
      await this.createOrRefreshIndex();
    }
  }

  private async createOrRefreshIndex(): Promise<void> {
    const db = this.openIndex();
    try {
      createSchema(db);
      const count = db
        .prepare('SELECT COUNT(*) AS count FROM script_records')
        .get() as { count: number };
      if (count.count === 0) {
        await this.rebuildIndex(db);
      }
    } finally {
      db.close();
    }
  }

  private async removeIndexFiles(): Promise<void> {
    await Promise.all([
      removeFileWithRetries(this.indexPath),
      removeFileWithRetries(`${this.indexPath}-wal`),
      removeFileWithRetries(`${this.indexPath}-shm`),
    ]);
  }

  private openIndex(): Database.Database {
    const db = new Database(this.indexPath, { timeout: 2_000 });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    return db;
  }

  private async rebuildIndex(existingDb?: Database.Database): Promise<void> {
    await mkdir(this.scriptsDir, { recursive: true });
    const records = await this.readAllScriptFiles();
    const db = existingDb ?? this.openIndex();
    try {
      createSchema(db);
      const rebuild = db.transaction((items: ScriptFileRecord[]) => {
        db.prepare('DELETE FROM script_records').run();
        for (const item of items) {
          insertIndexRecord(db, item.record, item.filePath, {
            lastExecutedPage: item.lastExecutedPage,
          });
        }
      });
      rebuild(records);
    } finally {
      if (!existingDb) {
        db.close();
      }
    }
  }

  private upsertIndexRecord(
    record: CloudScriptRecord,
    filePath: string,
    metadata: RecordFileMetadataContext,
  ): void {
    const db = this.openIndex();
    try {
      createSchema(db);
      insertIndexRecord(db, record, filePath, metadata);
    } finally {
      db.close();
    }
  }

  private async readAllScriptFiles(): Promise<ScriptFileRecord[]> {
    const files = await findScriptFiles(this.scriptsDir);
    const records: ScriptFileRecord[] = [];
    for (const file of files) {
      try {
        const fileRecord = await this.readScriptFileRecord(file);
        records.push({
          record: fileRecord.record,
          filePath: file,
          lastExecutedPage: fileRecord.lastExecutedPage,
        });
      } catch {
        // Ignore files that are not managed registry scripts.
      }
    }
    return records;
  }

  private async readRecordFile(filePath: string): Promise<CloudScriptRecord> {
    return (await this.readScriptFileRecord(filePath)).record;
  }

  private async readScriptFileRecord(
    filePath: string,
  ): Promise<{ record: CloudScriptRecord; lastExecutedPage: string | null }> {
    const raw = await readFile(filePath, 'utf8');
    const { metadata, code } = parseRecordFile(raw);
    const record = cloudScriptRecordSchema.parse({
      id: metadata.id,
      status: metadata.status,
      publishedAt: metadata.publishedAt,
      updatedAt: metadata.updatedAt,
      scriptDefinition: {
        ...metadata.scriptDefinition,
        script: {
          ...metadata.scriptDefinition.script,
          code,
        },
      },
    });
    return { record, lastExecutedPage: metadata.lastExecutedPage };
  }

  private scriptPathForRecord(record: CloudScriptRecord, site: string): string {
    return join(
      this.scriptsDir,
      sanitizePathSegment(site),
      `${sanitizePathSegment(record.scriptDefinition.id)}.js`,
    );
  }

}

async function removeFileWithRetries(path: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(path, { force: true });
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

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_records (
      record_key TEXT PRIMARY KEY,
      script_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      type TEXT NOT NULL,
      site TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL,
      url_patterns_json TEXT NOT NULL,
      file_path TEXT NOT NULL,
      search_text TEXT NOT NULL,
      last_executed_page TEXT,
      published_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_script_records_script_id ON script_records(script_id);
    CREATE INDEX IF NOT EXISTS idx_script_records_filters ON script_records(status, type, site);
  `);
}

function insertIndexRecord(
  db: Database.Database,
  record: CloudScriptRecord,
  filePath: string,
  metadata: RecordFileMetadataContext,
): void {
  const definition = record.scriptDefinition;
  db.prepare('DELETE FROM script_records WHERE script_id = ?').run(definition.id);
  db.prepare(
    [
      'INSERT OR REPLACE INTO script_records',
      [
        '(record_key, script_id, version, name, summary, type, site, tags_json,',
        [
          'status, url_patterns_json, file_path, search_text, last_executed_page,',
          'published_at, updated_at)',
        ].join(' '),
      ].join(' '),
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ].join(' '),
  ).run(
    `${definition.id}@${definition.version}`,
    definition.id,
    definition.version,
    definition.name,
    definition.summary,
    definition.type,
    definition.target.site,
    JSON.stringify(definition.tags),
    record.status,
    JSON.stringify(definition.target.urlPatterns),
    filePath,
    buildSearchText(record),
    metadata.lastExecutedPage,
    record.publishedAt ?? null,
    record.updatedAt ?? null,
  );
}

function buildSearchText(record: CloudScriptRecord): string {
  const definition = record.scriptDefinition;
  return [
    definition.id,
    definition.name,
    definition.summary,
    definition.target.site,
    ...definition.target.pageHints,
    ...definition.tags,
  ].join(' ');
}

function formatRecordFile(
  record: CloudScriptRecord,
  context: RecordFileMetadataContext,
): string {
  const metadata = buildMetadata(record, context);
  return [
    `/* ${SCRIPT_METADATA_HEADER}`,
    JSON.stringify(metadata, null, 2),
    '*/',
    record.scriptDefinition.script.code,
    '',
  ].join('\n');
}

function buildMetadata(
  record: CloudScriptRecord,
  context: RecordFileMetadataContext,
): ScriptFileMetadata {
  const now = new Date().toISOString();
  const { code: _code, ...scriptMetadata } = record.scriptDefinition.script;
  return {
    schemaVersion: SCRIPT_METADATA_SCHEMA_VERSION,
    id: record.scriptDefinition.id,
    status: record.status,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt ?? now,
    createdAt: record.publishedAt ?? record.updatedAt ?? now,
    lastExecutedPage: context.lastExecutedPage,
    scriptDefinition: {
      ...record.scriptDefinition,
      script: scriptMetadata,
    },
  };
}

function resolvePathSite(record: CloudScriptRecord, lastExecutedPage?: string): string {
  return hostnameFromUrl(lastExecutedPage) ?? record.scriptDefinition.target.site;
}

function hostnameFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const hostname = new URL(value).hostname;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

function parseRecordFile(raw: string): { metadata: ScriptFileMetadata; code: string } {
  const match = raw.match(/^\/\*\s*web-cap-script\n([\s\S]*?)\n\*\/\n?/);
  if (!match) {
    throw new Error('Script metadata header was not found.');
  }

  const metadata = JSON.parse(match[1]) as ScriptFileMetadata;
  if (metadata.schemaVersion !== SCRIPT_METADATA_SCHEMA_VERSION) {
    throw new Error(`Unsupported script metadata schema ${metadata.schemaVersion}.`);
  }

  return {
    metadata,
    code: raw.slice(match[0].length).trimEnd(),
  };
}

async function findScriptFiles(root: string): Promise<string[]> {
  try {
    return await glob('**/*.js', {
      absolute: true,
      cwd: root,
      dot: true,
      onlyFiles: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown';
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}
