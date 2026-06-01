import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ScriptExecutionResult,
  ScriptExecutionHistoryEntry,
} from '@shared/protocol';
import { RuntimeBridgeError } from '../runtime/runtime-bridge';
import { resolveWebCapStateDir } from '../state-dir';

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;

interface StoredScriptExecutionHistoryEntry
  extends Omit<ScriptExecutionHistoryEntry, 'script'> {
  scriptPath: string;
}

interface ScriptExecutionHistoryFile {
  nextSequence: number;
  entries: StoredScriptExecutionHistoryEntry[];
}

type LegacyScriptExecutionHistoryEntry =
  | ScriptExecutionHistoryEntry
  | StoredScriptExecutionHistoryEntry;

interface LegacyScriptExecutionHistoryFile {
  nextSequence: number;
  entries: LegacyScriptExecutionHistoryEntry[];
}

export class ScriptExecutionHistory {
  private readonly filePath: string;
  private readonly scriptsDir: string;

  constructor(
    historyPath = join(resolveWebCapStateDir(), 'script-execution-history.json'),
    private readonly limit = DEFAULT_HISTORY_LIMIT,
  ) {
    this.filePath = historyPath.endsWith('.json') ? historyPath : `${historyPath}.json`;
    this.scriptsDir = join(this.filePath.slice(0, -'.json'.length), 'scripts');
  }

  async reserve(
    script: string,
    input: Record<string, unknown>,
    options?: { tabId?: number },
    idKind: 'temporary' | 'permanent' = 'temporary',
  ): Promise<ScriptExecutionHistoryEntry> {
    return await this.withLock(async () => {
      const state = await this.readState();
      const now = new Date().toISOString();
      const entry: ScriptExecutionHistoryEntry = {
        localScriptId:
          idKind === 'permanent'
            ? formatPermanentScriptId(state.nextSequence)
            : formatLocalScriptId(state.nextSequence),
        script,
        input,
        options,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };

      state.nextSequence += 1;
      state.entries.unshift(await this.storeEntry(entry));
      await this.trimState(state);
      await this.writeState(state);
      return entry;
    });
  }

  async markSucceeded(
    localScriptId: string,
    execution: ScriptExecutionResult,
  ): Promise<ScriptExecutionHistoryEntry> {
    return await this.update(localScriptId, (entry) => ({
      ...entry,
      status: 'succeeded',
      execution,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markInterrupted(
    localScriptId: string,
    execution: ScriptExecutionResult,
  ): Promise<ScriptExecutionHistoryEntry> {
    return await this.update(localScriptId, (entry) => ({
      ...entry,
      status: 'interrupted',
      execution,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markFailed(
    localScriptId: string,
    error: unknown,
  ): Promise<ScriptExecutionHistoryEntry> {
    return await this.update(localScriptId, (entry) => ({
      ...entry,
      status: 'failed',
      execution: undefined,
      error: serializeError(error),
      updatedAt: new Date().toISOString(),
    }));
  }

  async convertToTemporary(localScriptId: string): Promise<ScriptExecutionHistoryEntry> {
    if (!localScriptId.startsWith('local.script.')) {
      return (await this.get(localScriptId)) ?? failMissingHistoryEntry(localScriptId);
    }

    const temporaryScriptId = `temp.script.${localScriptId.slice('local.script.'.length)}`;
    return await this.update(localScriptId, (entry) => ({
      ...entry,
      localScriptId: temporaryScriptId,
      updatedAt: new Date().toISOString(),
    }));
  }

  async get(localScriptId: string): Promise<ScriptExecutionHistoryEntry | null> {
    const state = await this.readState();
    const entry = state.entries.find((item) => item.localScriptId === localScriptId);
    return entry ? await this.hydrateEntry(entry) : null;
  }

  async list(): Promise<ScriptExecutionHistoryEntry[]> {
    const state = await this.readState();
    const entries = trimHistoryEntries(state.entries, this.limit);
    return await Promise.all(entries.map((entry) => this.hydrateEntry(entry)));
  }

  private async update(
    localScriptId: string,
    apply: (entry: ScriptExecutionHistoryEntry) => ScriptExecutionHistoryEntry,
  ): Promise<ScriptExecutionHistoryEntry> {
    return await this.withLock(async () => {
      const state = await this.readState();
      const index = state.entries.findIndex((entry) => entry.localScriptId === localScriptId);
      if (index < 0) {
        throw new Error(`Script execution history entry ${localScriptId} was not found.`);
      }

      const existing = await this.hydrateEntry(state.entries[index]);
      const updated = apply(existing);
      const stored = await this.storeEntry(updated);
      if (stored.scriptPath !== state.entries[index].scriptPath) {
        await removeFileWithRetries(state.entries[index].scriptPath);
      }
      state.entries[index] = stored;
      await this.trimState(state);
      await this.writeState(state);
      return updated;
    });
  }

  private async readState(): Promise<ScriptExecutionHistoryFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LegacyScriptExecutionHistoryFile>;
      const nextSequence =
        typeof parsed.nextSequence === 'number' && parsed.nextSequence > 0
          ? Math.floor(parsed.nextSequence)
          : 1;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const migrated = entries.some(
        (entry) =>
          !('scriptPath' in entry) ||
          typeof entry.scriptPath !== 'string' ||
          'script' in entry,
      );
      const state = {
        nextSequence,
        entries: await Promise.all(entries.map((entry) => this.normalizeStoredEntry(entry))),
      };
      if (migrated) {
        await this.writeState(state);
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { nextSequence: 1, entries: [] };
      }
      throw error;
    }
  }

  private async writeState(state: ScriptExecutionHistoryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempFilePath, this.filePath);
  }

  private async normalizeStoredEntry(
    entry: LegacyScriptExecutionHistoryEntry,
  ): Promise<StoredScriptExecutionHistoryEntry> {
    if ('scriptPath' in entry && typeof entry.scriptPath === 'string') {
      const { script: _script, ...stored } = entry as StoredScriptExecutionHistoryEntry & {
        script?: string;
      };
      return stored;
    }

    return await this.storeEntry(entry as ScriptExecutionHistoryEntry);
  }

  private async hydrateEntry(
    entry: StoredScriptExecutionHistoryEntry,
  ): Promise<ScriptExecutionHistoryEntry> {
    return {
      ...entry,
      script: await readFile(entry.scriptPath, 'utf8'),
    };
  }

  private async storeEntry(
    entry: ScriptExecutionHistoryEntry,
  ): Promise<StoredScriptExecutionHistoryEntry> {
    const scriptPath = this.scriptPathForEntry(entry.localScriptId);
    await mkdir(dirname(scriptPath), { recursive: true });
    const tempFilePath = `${scriptPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempFilePath, entry.script, 'utf8');
    await rename(tempFilePath, scriptPath);

    const { script: _script, ...stored } = entry;
    return {
      ...stored,
      scriptPath,
    };
  }

  private async trimState(state: ScriptExecutionHistoryFile): Promise<void> {
    const keptEntries = trimHistoryEntries(state.entries, this.limit);
    const keptPaths = new Set(keptEntries.map((entry) => entry.scriptPath));
    await Promise.all(
      state.entries
        .filter((entry) => !keptPaths.has(entry.scriptPath))
        .map((entry) => removeFileWithRetries(entry.scriptPath)),
    );
    state.entries = keptEntries;
  }

  private scriptPathForEntry(localScriptId: string): string {
    return join(this.scriptsDir, `${sanitizePathSegment(localScriptId)}.js`);
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockDir = `${this.filePath}.lock`;
    const startedAt = Date.now();

    while (true) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        if (Date.now() - startedAt >= DEFAULT_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for script history lock at ${lockDir}.`);
        }

        await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOCK_RETRY_MS));
      }
    }

    try {
      return await task();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
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

function formatLocalScriptId(sequence: number): string {
  return `temp.script.${String(sequence).padStart(6, '0')}`;
}

function formatPermanentScriptId(sequence: number): string {
  return `local.script.${String(sequence).padStart(6, '0')}`;
}

function failMissingHistoryEntry(localScriptId: string): never {
  throw new Error(`Script execution history entry ${localScriptId} was not found.`);
}

function trimHistoryEntries<T extends { status: ScriptExecutionHistoryEntry['status'] }>(
  entries: T[],
  limit: number,
): T[] {
  const trimmed: T[] = [];
  let completedCount = 0;

  for (const entry of entries) {
    if (entry.status === 'running') {
      trimmed.push(entry);
      continue;
    }

    if (completedCount < limit) {
      trimmed.push(entry);
      completedCount += 1;
    }
  }

  return trimmed;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'unknown';
}

function serializeError(error: unknown): { message: string; code?: string } {
  if (error instanceof RuntimeBridgeError) {
    return {
      message: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    const code =
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? String((error as Error & { code?: unknown }).code)
        : undefined;
    return {
      message: error.message,
      code,
    };
  }

  return {
    message: String(error),
  };
}
