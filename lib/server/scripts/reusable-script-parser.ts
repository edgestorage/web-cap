const REUSABLE_SCRIPT_MARKER = 'web-cap script';

export interface ParsedReusableScriptHeader {
  description: string;
  matches: string[];
}

export function parseReusableScriptHeader(source: string): ParsedReusableScriptHeader {
  const header = extractLeadingJsDoc(source);
  const lines = header
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim());
  const contentLines = lines.filter((line) => line.length > 0);
  if (contentLines[0] !== REUSABLE_SCRIPT_MARKER) {
    throw new Error(
      `Web Cap script must start with a JSDoc block whose first line is "${REUSABLE_SCRIPT_MARKER}".`,
    );
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

  const description = readSingleField(fields, 'description')?.trim();
  if (!description) {
    throw new Error('Web Cap script metadata requires @description.');
  }

  const matches = readRepeatedValues(fields, 'match');
  if (matches.length === 0) {
    throw new Error('Web Cap script metadata requires at least one @match.');
  }
  for (const pattern of matches) {
    validateReusableScriptMatchPattern(pattern);
  }

  return {
    description,
    matches,
  };
}

export function validateReusableScriptMatchPattern(pattern: string): void {
  if (pattern.trim() !== pattern || /\s/.test(pattern)) {
    throw new Error(`Invalid @match pattern "${pattern}". Match patterns cannot contain whitespace.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(pattern.replace(/:([A-Za-z][A-Za-z0-9_-]*)/g, 'param-$1'));
  } catch {
    throw new Error(`Invalid @match pattern "${pattern}". Expected a full URL pattern.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    throw new Error(`Invalid @match pattern "${pattern}". Expected http, https, or file URL patterns.`);
  }

  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) {
    throw new Error(`Invalid @match pattern "${pattern}". Expected a URL host.`);
  }
}

function extractLeadingJsDoc(source: string): string {
  const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!match) {
    throw new Error('Web Cap script metadata JSDoc block was not found.');
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
