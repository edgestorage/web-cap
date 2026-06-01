import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep, join } from 'node:path';
import { resolveWebCapStateDir } from '../state-dir';

const SCREENSHOT_DIR_NAME = 'temp-screenshots';
const SCREENSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SCREENSHOT_FILE_PATTERN = /^(?:s-[A-Za-z0-9_-]{11}|screenshot-.*)\.(?:png|jpe?g)$/i;

interface ScreenshotStoreEnvironment {
  WEB_CAP_STATE_DIR?: string;
}

interface RuntimeScreenshotResult {
  data: string;
  mimeType: string;
  type: 'png' | 'jpeg';
}

export interface StoredScreenshotResult {
  path: string;
  mimeType: string;
  type: 'png' | 'jpeg';
  encoding: 'file';
  sizeBytes: number;
}

export async function storeBrowserScreenshot(
  result: Record<string, unknown>,
  env: ScreenshotStoreEnvironment = process.env,
): Promise<StoredScreenshotResult> {
  const screenshot = parseRuntimeScreenshotResult(result);
  return await storeBrowserScreenshotBytes(
    Buffer.from(screenshot.data, 'base64'),
    screenshot,
    env,
  );
}

export async function storeBrowserScreenshotBytes(
  bytes: Buffer,
  screenshot: Omit<RuntimeScreenshotResult, 'data'>,
  env: ScreenshotStoreEnvironment = process.env,
): Promise<StoredScreenshotResult> {
  const directory = resolveScreenshotDirectory(env);
  await mkdir(directory, { recursive: true });
  await cleanupExpiredScreenshots(directory).catch((error) => {
    console.warn('WEB_CAP failed to clean expired screenshots:', error);
  });

  const filePath = join(directory, createScreenshotFileName(screenshot.type));
  await writeFile(filePath, bytes);

  return {
    path: filePath,
    mimeType: screenshot.mimeType,
    type: screenshot.type,
    encoding: 'file',
    sizeBytes: bytes.byteLength,
  };
}

export async function storeBrowserScreenshotBytesAtPath(
  bytes: Buffer,
  screenshot: Omit<RuntimeScreenshotResult, 'data'>,
  filePath: string,
  env: ScreenshotStoreEnvironment = process.env,
): Promise<StoredScreenshotResult> {
  const directory = resolveScreenshotDirectory(env);
  await mkdir(directory, { recursive: true });
  await cleanupExpiredScreenshots(directory).catch((error) => {
    console.warn('WEB_CAP failed to clean expired screenshots:', error);
  });

  const safePath = resolveSafeScreenshotPath(directory, filePath);
  await writeFile(safePath, bytes);
  return {
    path: safePath,
    mimeType: screenshot.mimeType,
    type: screenshot.type,
    encoding: 'file',
    sizeBytes: bytes.byteLength,
  };
}

export async function storeScriptScreenshotArtifacts(
  value: unknown,
  env: ScreenshotStoreEnvironment = process.env,
): Promise<unknown> {
  if (isRuntimeScreenshotMarker(value)) {
    return (await storeBrowserScreenshot(value, env)).path;
  }

  if (Array.isArray(value)) {
    return await Promise.all(value.map((item) => storeScriptScreenshotArtifacts(item, env)));
  }

  if (isRecord(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, nested]) => [
        key,
        await storeScriptScreenshotArtifacts(nested, env),
      ]),
    );
    return Object.fromEntries(entries);
  }

  return value;
}

export function resolveScreenshotDirectory(
  env: ScreenshotStoreEnvironment = process.env,
): string {
  return join(resolveWebCapStateDir(env), SCREENSHOT_DIR_NAME);
}

async function cleanupExpiredScreenshots(directory: string): Promise<void> {
  const now = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !SCREENSHOT_FILE_PATTERN.test(entry.name)) {
        return;
      }

      const filePath = join(directory, entry.name);
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs <= SCREENSHOT_RETENTION_MS) {
        return;
      }

      await rm(filePath, { force: true });
    }),
  );
}

function parseRuntimeScreenshotResult(result: Record<string, unknown>): RuntimeScreenshotResult {
  if (typeof result.data !== 'string' || result.data.length === 0) {
    throw new Error('Browser screenshot returned no image data.');
  }

  const type: 'png' | 'jpeg' = result.type === 'jpeg' ? 'jpeg' : 'png';
  const mimeType = typeof result.mimeType === 'string'
    ? result.mimeType
    : type === 'jpeg'
      ? 'image/jpeg'
      : 'image/png';
  return {
    data: result.data,
    mimeType,
    type,
  };
}

function resolveSafeScreenshotPath(directory: string, candidatePath: string): string {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(candidatePath);
  const relativePath = relative(resolvedDirectory, resolvedPath);
  if (
    relativePath.startsWith('..') ||
    relativePath === '' ||
    relativePath.includes(sep) ||
    !SCREENSHOT_FILE_PATTERN.test(basename(resolvedPath))
  ) {
    throw new Error('Browser screenshot artifact path is not allowed.');
  }
  return resolvedPath;
}

function isRuntimeScreenshotMarker(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.__webCapType === 'screenshot' &&
    typeof value.data === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createScreenshotFileName(type: 'png' | 'jpeg'): string {
  const id = randomBytes(8).toString('base64url');
  return `s-${id}.${type === 'jpeg' ? 'jpg' : 'png'}`;
}
