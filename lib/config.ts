import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ExecutionEvidenceOption } from '@shared/protocol';
import { resolveWebCapStateDir } from './server/state-dir';

export const WEB_CAP_CONFIG_FILE_NAME = 'config.json';
export const WEB_CAP_CONFIG_KEYS = [
  'activateTabOnScriptExecute',
  'evidence',
  'mouseTrajectorySimulation',
] as const;
export const WEB_CAP_EVIDENCE_OPTIONS = ['events', 'visibleElements', 'common', 'all'] as const;

const webCapConfigSchema = z
  .object({
    activateTabOnScriptExecute: z.boolean().optional(),
    evidence: z.array(z.enum(WEB_CAP_EVIDENCE_OPTIONS)).optional(),
    mouseTrajectorySimulation: z.boolean().optional(),
  })
  .default({});

export type WebCapConfig = z.infer<typeof webCapConfigSchema>;
export type WebCapConfigKey = (typeof WEB_CAP_CONFIG_KEYS)[number];
export type WebCapEvidenceConfig = ExecutionEvidenceOption[];

export interface WebCapConfigEnvironment {
  WEB_CAP_STATE_DIR?: string;
}

export async function loadWebCapConfig(
  env: WebCapConfigEnvironment = process.env,
): Promise<WebCapConfig> {
  const filePath = resolveWebCapConfigPath(env);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return {};
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid WEB_CAP config JSON at ${filePath}: ${formatConfigError(error)}`);
  }

  const result = webCapConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid WEB_CAP config at ${filePath}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'config'} ${issue.message}`)
        .join('; ')}`,
    );
  }

  return result.data;
}

export async function saveWebCapConfig(
  config: WebCapConfig,
  env: WebCapConfigEnvironment = process.env,
): Promise<WebCapConfig> {
  const parsed = webCapConfigSchema.parse(config);
  const filePath = resolveWebCapConfigPath(env);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return parsed;
}

export function resolveWebCapConfigPath(
  env: WebCapConfigEnvironment = process.env,
): string {
  return join(resolveWebCapStateDir(env), WEB_CAP_CONFIG_FILE_NAME);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function formatConfigError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
