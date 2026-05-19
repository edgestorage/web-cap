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

interface ScriptExecutionHistoryFile {
  nextSequence: number;
  entries: ScriptExecutionHistoryEntry[];
}

export class ScriptExecutionHistory {
  constructor(
    private readonly filePath = join(resolveWebCapStateDir(), 'script-execution-history.json'),
    private readonly limit = DEFAULT_HISTORY_LIMIT,
  ) {}

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
      state.entries.unshift(entry);
      state.entries = trimHistoryEntries(state.entries, this.limit);
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
    return state.entries.find((entry) => entry.localScriptId === localScriptId) ?? null;
  }

  async list(): Promise<ScriptExecutionHistoryEntry[]> {
    const state = await this.readState();
    return trimHistoryEntries(state.entries, this.limit);
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

      const updated = apply(state.entries[index]);
      state.entries[index] = updated;
      state.entries = trimHistoryEntries(state.entries, this.limit);
      await this.writeState(state);
      return updated;
    });
  }

  private async readState(): Promise<ScriptExecutionHistoryFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ScriptExecutionHistoryFile>;
      const nextSequence =
        typeof parsed.nextSequence === 'number' && parsed.nextSequence > 0
          ? Math.floor(parsed.nextSequence)
          : 1;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      return { nextSequence, entries };
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

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
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

function formatLocalScriptId(sequence: number): string {
  return `temp.script.${String(sequence).padStart(6, '0')}`;
}

function formatPermanentScriptId(sequence: number): string {
  return `local.script.${String(sequence).padStart(6, '0')}`;
}

function failMissingHistoryEntry(localScriptId: string): never {
  throw new Error(`Script execution history entry ${localScriptId} was not found.`);
}

function trimHistoryEntries(
  entries: ScriptExecutionHistoryEntry[],
  limit: number,
): ScriptExecutionHistoryEntry[] {
  const trimmed: ScriptExecutionHistoryEntry[] = [];
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
