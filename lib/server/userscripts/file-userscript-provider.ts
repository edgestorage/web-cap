import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { glob } from 'tinyglobby';
import type { UserScriptDefinition } from '@shared/script-schema';
import { userScriptDefinitionSchema } from '@shared/script-schema';
import { resolveWebCapStateDir } from '../state-dir';
import {
  parseUserScriptDefinition,
} from './userscript-parser';

export interface UserScriptInstallInput {
  filePath: string;
}

export interface UserScriptProvider {
  install(input: UserScriptInstallInput): Promise<UserScriptDefinition>;
  list(): Promise<UserScriptDefinition[]>;
  remove(id: string): Promise<UserScriptDefinition>;
}

export class FileUserScriptProvider implements UserScriptProvider {
  private readonly userscriptsDir: string;

  constructor(stateDir = resolveWebCapStateDir()) {
    this.userscriptsDir = join(stateDir, 'userscripts');
  }

  async install(input: UserScriptInstallInput): Promise<UserScriptDefinition> {
    const source = await readFile(input.filePath, 'utf8');
    const now = new Date().toISOString();
    const parsed = parseUserScriptDefinition(source, {
      sourcePath: input.filePath,
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
      try {
        const source = await readFile(file, 'utf8');
        const fileStat = await stat(file);
        definitions.push(parseUserScriptDefinition(source, {
          sourcePath: file,
          installedAt: fileStat.birthtime.toISOString(),
          updatedAt: fileStat.mtime.toISOString(),
        }));
      } catch {
        // Ignore files that are not valid managed userscripts.
      }
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

  private async findById(id: string): Promise<UserScriptDefinition | undefined> {
    return (await this.list()).find((definition) => definition.id === id);
  }

  private pathForDefinition(definition: UserScriptDefinition): string {
    return join(this.userscriptsDir, `${sanitizePathSegment(definition.id)}.js`);
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'userscript';
}
