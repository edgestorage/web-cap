import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultProjectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SOURCE_DIRS = ['lib', 'shared'];
const DEFAULT_GENERATED_FILE = '.generated/build-id.json';
const PACKAGE_NAME = 'web-capability';

type BuildIdMode = 'auto' | 'dynamic' | 'generated';

interface BuildIdFile {
  buildId: string;
  generatedAt: string;
}

export interface BuildIdOptions {
  env?: NodeJS.ProcessEnv;
  generatedFilePath?: string;
  packageJsonPath?: string;
  processArgv?: string[];
  processExecArgv?: string[];
  projectRoot?: string;
  sourceDirs?: string[];
}

export async function computeWebCapBuildId(options: BuildIdOptions = {}): Promise<string> {
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;
  const files = await collectTrackedFiles(projectRoot, sourceDirs);
  const hash = createHash('sha1');

  for (const file of files) {
    const fullPath = join(projectRoot, file);
    const fileStat = await stat(fullPath);
    hash.update(file);
    hash.update(':');
    hash.update(String(fileStat.size));
    hash.update(':');
    hash.update(String(Math.trunc(fileStat.mtimeMs)));
    hash.update('\n');
  }

  return hash.digest('hex');
}

export async function resolveWebCapBuildId(options: BuildIdOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicitBuildId = env.WEB_CAP_BUILD_ID?.trim();
  if (explicitBuildId) {
    return explicitBuildId;
  }

  const mode = normalizeBuildIdMode(env.WEB_CAP_BUILD_ID_MODE);
  if (mode === 'dynamic') {
    return await computeWebCapBuildId(options);
  }

  const packageVersionBuildId = await readPackageVersionBuildId(options);
  const generatedBuildId = await readGeneratedWebCapBuildId(options);
  if (mode === 'generated') {
    return packageVersionBuildId ?? generatedBuildId ?? (await computeWebCapBuildId(options));
  }

  if (shouldPreferGeneratedBuildId(options)) {
    return packageVersionBuildId ?? generatedBuildId ?? (await computeWebCapBuildId(options));
  }

  return await computeWebCapBuildId(options);
}

export async function writeGeneratedWebCapBuildId(
  options: BuildIdOptions = {},
): Promise<string> {
  const buildId = await computeWebCapBuildId(options);
  const generatedFilePath = resolveGeneratedFilePath(options);
  const payload: BuildIdFile = {
    buildId,
    generatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(generatedFilePath), { recursive: true });
  await writeFile(generatedFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return buildId;
}

export async function readGeneratedWebCapBuildId(
  options: BuildIdOptions = {},
): Promise<string | undefined> {
  const generatedFilePath = resolveGeneratedFilePath(options);

  try {
    const raw = await readFile(generatedFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildIdFile>;
    return typeof parsed.buildId === 'string' && parsed.buildId.trim().length > 0
      ? parsed.buildId.trim()
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function readPackageVersionBuildId(
  options: BuildIdOptions = {},
): Promise<string | undefined> {
  const packageJsonPath = await resolvePackageJsonPath(options);
  if (!packageJsonPath) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await readFile(packageJsonPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  if (parsed.name !== PACKAGE_NAME || typeof parsed.version !== 'string') {
    return undefined;
  }

  const version = parsed.version.trim();
  return version ? version : undefined;
}

export function shouldPreferGeneratedBuildId(options: BuildIdOptions = {}): boolean {
  const processArgv = options.processArgv ?? process.argv;
  const processExecArgv = options.processExecArgv ?? process.execArgv;
  return !isTsxRuntime(processArgv, processExecArgv);
}

function normalizeBuildIdMode(rawMode: string | undefined): BuildIdMode {
  const mode = rawMode?.trim().toLowerCase();
  if (mode === 'dynamic' || mode === 'generated') {
    return mode;
  }
  return 'auto';
}

function resolveGeneratedFilePath(options: BuildIdOptions): string {
  if (options.generatedFilePath) {
    return options.generatedFilePath;
  }

  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  return join(projectRoot, DEFAULT_GENERATED_FILE);
}

async function resolvePackageJsonPath(options: BuildIdOptions): Promise<string | undefined> {
  if (options.packageJsonPath) {
    return options.packageJsonPath;
  }

  const startDirectory = options.projectRoot ?? dirname(fileURLToPath(import.meta.url));
  let directory = startDirectory;

  while (true) {
    const packageJsonPath = join(directory, 'package.json');
    try {
      await stat(packageJsonPath);
      return packageJsonPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

async function collectTrackedFiles(projectRoot: string, sourceDirs: string[]): Promise<string[]> {
  const files = new Set<string>();

  for (const dir of sourceDirs) {
    const fullPath = join(projectRoot, dir);
    await walk(projectRoot, fullPath, files);
  }

  return [...files].sort();
}

async function walk(projectRoot: string, directory: string, files: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(projectRoot, fullPath, files);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }

    files.add(relative(projectRoot, fullPath));
  }
}

function isTsxRuntime(processArgv: string[], processExecArgv: string[]): boolean {
  return [...processArgv, ...processExecArgv].some((value) =>
    /(^|[\\/])tsx([\\/]|$)|tsx\/dist\//.test(value),
  );
}
