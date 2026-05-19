import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  ScriptDefinition,
  ObjectSchemaDefinition,
} from './script-schema';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ScriptSchemaSummary {
  scriptId: string;
  name: string;
  description: string;
  inputSchema: ObjectSchemaDefinition;
  outputSchema: ObjectSchemaDefinition;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new WeakMap<ObjectSchemaDefinition, ValidateFunction>();

export function validateInputAgainstSchema(
  input: Record<string, unknown>,
  schema: ObjectSchemaDefinition,
): ValidationResult {
  const validate = getInputValidator(schema);
  const ok = validate(input);
  const errors = ok ? [] : formatAjvErrors(validate.errors ?? []);

  return {
    ok: Boolean(ok),
    errors,
  };
}

function getInputValidator(schema: ObjectSchemaDefinition): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

function formatAjvErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    switch (error.keyword) {
      case 'required':
        return `Missing required field: ${String(error.params.missingProperty)}`;
      case 'additionalProperties':
        return `Unexpected field: ${String(error.params.additionalProperty)}`;
      case 'type':
        return `Field ${fieldName(error)} must be ${typeDescription(error.params.type)}.`;
      case 'minimum':
        return `Field ${fieldName(error)} must be >= ${String(error.params.limit)}.`;
      case 'maximum':
        return `Field ${fieldName(error)} must be <= ${String(error.params.limit)}.`;
      case 'enum':
        return `Field ${fieldName(error)} must be one of: ${enumValues(error).join(', ')}.`;
      default:
        return `Field ${fieldName(error)} ${error.message ?? 'is invalid'}.`;
    }
  });
}

function fieldName(error: ErrorObject): string {
  const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  return path || 'input';
}

function typeDescription(type: unknown): string {
  if (Array.isArray(type)) {
    return type.join(' or ');
  }
  if (type === 'integer') {
    return 'an integer';
  }
  return `a ${String(type)}`;
}

function enumValues(error: ErrorObject): string[] {
  const values = (error.parentSchema as { enum?: unknown[] } | undefined)?.enum ?? [];
  return values.map((value) => String(value));
}

export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

export function matchesUrlPatterns(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => wildcardToRegExp(pattern).test(url));
}

export function toSchemaSummary(scriptDefinition: ScriptDefinition): ScriptSchemaSummary {
  return {
    scriptId: scriptDefinition.id,
    name: scriptDefinition.name,
    description: scriptDefinition.summary,
    inputSchema: scriptDefinition.inputSchema,
    outputSchema: scriptDefinition.outputSchema,
  };
}
