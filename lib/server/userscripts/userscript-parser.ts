import { MatchPattern } from '@webext-core/match-patterns';
import {
  userScriptDefinitionSchema,
  type UserScriptDefinition,
  type UserScriptRunAt,
} from '@shared/script-schema';

const DEFAULT_USER_SCRIPT_VERSION = '1.0.0';
const DEFAULT_USER_SCRIPT_RUN_AT: UserScriptRunAt = 'document-idle';
const USER_SCRIPT_MARKER = 'web-cap userscript';
const VALID_RUN_AT = new Set<UserScriptRunAt>([
  'document-start',
  'document-end',
  'document-idle',
]);

interface ParsedUserScriptHeader {
  name: string;
  version: string;
  matches: string[];
  runAt: UserScriptRunAt;
}

export interface ParseUserScriptOptions {
  id?: string;
  sourcePath?: string;
  installedAt?: string;
  updatedAt?: string;
}

export function parseUserScriptDefinition(
  source: string,
  options: ParseUserScriptOptions = {},
): UserScriptDefinition {
  const header = parseUserScriptHeader(source);
  const now = new Date().toISOString();
  return userScriptDefinitionSchema.parse({
    id: options.id ?? buildUserScriptId(header.name),
    name: header.name,
    version: header.version,
    status: 'active',
    matches: header.matches,
    runAt: header.runAt,
    code: source.trimEnd(),
    sourcePath: options.sourcePath,
    installedAt: options.installedAt ?? now,
    updatedAt: options.updatedAt ?? now,
  });
}

export function parseUserScriptHeader(source: string): ParsedUserScriptHeader {
  const header = extractLeadingJsDoc(source);
  const lines = header
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim());
  const contentLines = lines.filter((line) => line.length > 0);
  if (contentLines[0] !== USER_SCRIPT_MARKER) {
    throw new Error(`User script must start with a JSDoc block whose first line is "${USER_SCRIPT_MARKER}".`);
  }

  const fields = new Map<string, string[]>();
  for (const line of contentLines.slice(1)) {
    const match = line.match(/^@([A-Za-z][\w-]*)\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    const values = fields.get(key) ?? [];
    values.push(rawValue.trim());
    fields.set(key, values);
  }

  const name = readSingleField(fields, 'name')?.trim();
  if (!name) {
    throw new Error('User script metadata requires @name.');
  }

  const matches = readRepeatedValues(fields, 'match');
  if (matches.length === 0) {
    throw new Error('User script metadata requires at least one @match.');
  }
  for (const pattern of matches) {
    validateMatchPattern(pattern);
  }

  const runAt = readSingleField(fields, 'runAt') ?? DEFAULT_USER_SCRIPT_RUN_AT;
  if (!VALID_RUN_AT.has(runAt as UserScriptRunAt)) {
    throw new Error(
      `Invalid @runAt "${runAt}". Expected document-start, document-end, or document-idle.`,
    );
  }

  return {
    name,
    version: readSingleField(fields, 'version') || DEFAULT_USER_SCRIPT_VERSION,
    matches,
    runAt: runAt as UserScriptRunAt,
  };
}

export function buildUserScriptId(name: string): string {
  return `userscript.${sanitizeIdSegment(name)}`;
}

export function validateMatchPattern(pattern: string): void {
  if (pattern.trim() !== pattern || /\s/.test(pattern)) {
    throw new Error(`Invalid @match pattern "${pattern}". Match patterns cannot contain whitespace.`);
  }
  if (pattern === '<all_urls>') {
    throw new Error('@match <all_urls> is not supported.');
  }

  if (pattern.startsWith('file://')) {
    validateFileMatchPattern(pattern);
    return;
  }

  try {
    new MatchPattern(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid @match pattern "${pattern}". ${message}`);
  }
  validateHttpMatchHost(pattern);
}

function validateFileMatchPattern(pattern: string): void {
  const match = pattern.match(/^file:\/\/(\/.*)$/);
  if (!match) {
    throw new Error(`Invalid file @match pattern "${pattern}". File patterns must use file:///.`);
  }
}

function validateHttpMatchHost(pattern: string): void {
  const match = pattern.match(/^(?:\*|http|https):\/\/([^/]+)\//);
  const host = match?.[1];
  if (!host || host === '*') {
    return;
  }

  const normalizedHost = host.startsWith('*.') ? host.slice(2) : host;
  const labels = normalizedHost.split('.');
  if (!labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    throw new Error(`Invalid @match host in "${pattern}".`);
  }
}

function extractLeadingJsDoc(source: string): string {
  const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!match) {
    throw new Error('User script metadata JSDoc block was not found.');
  }
  return match[1];
}

function readSingleField(fields: Map<string, string[]>, key: string): string | undefined {
  return fields.get(key)?.find((value) => value.length > 0);
}

function readRepeatedValues(fields: Map<string, string[]>, key: string): string[] {
  return (fields.get(key) ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function sanitizeIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^\.+|\.+$/g, '') || 'unnamed';
}
