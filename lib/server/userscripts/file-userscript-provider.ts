import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { glob } from 'tinyglobby';
import type { UserScriptDefinition, UserScriptStatus } from '@shared/script-schema';
import { userScriptDefinitionSchema } from '@shared/script-schema';
import { resolveWebCapStateDir } from '../state-dir';
import {
  parseUserScriptDefinition,
} from './userscript-parser';

export interface UserScriptInstallInput {
  filePath?: string;
  source?: string;
  sourcePath?: string;
}

export interface UserScriptProvider {
  install(input: UserScriptInstallInput): Promise<UserScriptDefinition>;
  list(): Promise<UserScriptDefinition[]>;
  setStatus(id: string, status: UserScriptStatus): Promise<UserScriptDefinition>;
  remove(id: string): Promise<UserScriptDefinition>;
}

export class FileUserScriptProvider implements UserScriptProvider {
  private readonly userscriptsDir: string;

  constructor(stateDir = resolveWebCapStateDir()) {
    this.userscriptsDir = join(stateDir, 'userscripts');
  }

  async install(input: UserScriptInstallInput): Promise<UserScriptDefinition> {
    const source = input.source ?? (input.filePath ? await readFile(input.filePath, 'utf8') : undefined);
    if (source === undefined) {
      throw new Error('User script install requires source or filePath.');
    }
    const now = new Date().toISOString();
    const parsed = parseUserScriptDefinition(source, {
      sourcePath: input.sourcePath ?? input.filePath ?? '<stdin>',
      updatedAt: now,
    });
    await mkdir(this.userscriptsDir, { recursive: true });

    const existing = await this.findById(parsed.id);
    let definition = userScriptDefinitionSchema.parse({
      ...parsed,
      installedAt: existing?.installedAt ?? parsed.installedAt,
      updatedAt: now,
    });
    const destination = this.pathForDefinition(definition);
    definition = userScriptDefinitionSchema.parse({
      ...definition,
      sourcePath: destination,
    });
    const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, definition.code, 'utf8');
    await rename(tempPath, destination);

    return definition;
  }

  async list(): Promise<UserScriptDefinition[]> {
    await mkdir(this.userscriptsDir, { recursive: true });
    const files = await this.findUserScriptFiles();
    const definitions: UserScriptDefinition[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const fileStat = await stat(file);
      definitions.push(parseUserScriptDefinition(source, {
        sourcePath: file,
        installedAt: fileStat.birthtime.toISOString(),
        updatedAt: fileStat.mtime.toISOString(),
      }));
    }
    return definitions.sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(id: string): Promise<UserScriptDefinition> {
    const existing = await this.findById(id);
    if (!existing?.sourcePath) {
      throw new Error(`User script ${id} was not found.`);
    }

    await rm(existing.sourcePath, { force: true });
    return existing;
  }

  async setStatus(id: string, status: UserScriptStatus): Promise<UserScriptDefinition> {
    const existing = await this.findById(id);
    if (!existing?.sourcePath) {
      throw new Error(`User script ${id} was not found.`);
    }

    const source = await readFile(existing.sourcePath, 'utf8');
    const updatedSource = setUserScriptStatusInSource(source, status);
    const tempPath = `${existing.sourcePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, updatedSource, 'utf8');
    await rename(tempPath, existing.sourcePath);

    return parseUserScriptDefinition(updatedSource, {
      sourcePath: existing.sourcePath,
      installedAt: existing.installedAt,
      updatedAt: new Date().toISOString(),
    });
  }

  private async findById(id: string): Promise<UserScriptDefinition | undefined> {
    return (await this.list()).find((definition) => definition.id === id);
  }

  private pathForDefinition(definition: UserScriptDefinition): string {
    return join(this.userscriptsDir, `${definition.id}.js`);
  }

  private async findUserScriptFiles(): Promise<string[]> {
    try {
      return await glob('**/*.js', {
        absolute: true,
        cwd: this.userscriptsDir,
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
}

function setUserScriptStatusInSource(source: string, status: UserScriptStatus): string {
  const lines = source.split('\n');
  const headerEndIndex = lines.findIndex((line) => line.includes('*/'));
  if (headerEndIndex === -1) {
    throw new Error('User script metadata header was not found.');
  }

  const statusLineIndex = lines.findIndex((line, index) => {
    return index <= headerEndIndex && /@status\b/.test(line);
  });
  if (statusLineIndex !== -1) {
    lines[statusLineIndex] = lines[statusLineIndex].replace(/@status\s+\S+/, `@status ${status}`);
    return lines.join('\n');
  }

  lines.splice(headerEndIndex, 0, ` * @status ${status}`);
  return lines.join('\n');
}
