import { z } from 'zod';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
export const MAX_EXECUTION_TIMEOUT_MS = 60_000;

export const scriptTypeSchema = z.enum(['read', 'act']);
export type ScriptType = z.infer<typeof scriptTypeSchema>;

export const scriptStatusSchema = z.enum(['draft', 'active', 'deprecated']);
export type ScriptStatus = z.infer<typeof scriptStatusSchema>;

const scalarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const scalarFieldSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  description: z.string().optional(),
  enum: z.array(scalarValueSchema).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
export type ScalarFieldSchema = z.infer<typeof scalarFieldSchema>;

export const objectSchemaDefinition = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), scalarFieldSchema),
  required: z.array(z.string()).default([]),
  additionalProperties: z.boolean().default(false),
});
export type ObjectSchemaDefinition = z.infer<typeof objectSchemaDefinition>;

export const scriptTargetSchema = z.object({
  site: z.string(),
  urlPatterns: z.array(z.string()).default([]),
  pageHints: z.array(z.string()).default([]),
});
export type ScriptTarget = z.infer<typeof scriptTargetSchema>;

export const scriptImplementationSchema = z.object({
  code: z.string().min(1),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_EXECUTION_TIMEOUT_MS)
    .default(DEFAULT_EXECUTION_TIMEOUT_MS),
});
export type ScriptImplementation = z.infer<typeof scriptImplementationSchema>;

export const scriptDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  status: scriptStatusSchema,
  type: scriptTypeSchema,
  summary: z.string().min(1),
  target: scriptTargetSchema,
  tags: z.array(z.string()).default([]),
  inputSchema: objectSchemaDefinition,
  outputSchema: objectSchemaDefinition,
  script: scriptImplementationSchema,
});
export type ScriptDefinition = z.infer<typeof scriptDefinitionSchema>;

export const cloudScriptRecordSchema = z.object({
  id: z.string().min(1),
  scriptDefinition: scriptDefinitionSchema,
  status: scriptStatusSchema,
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CloudScriptRecord = z.infer<typeof cloudScriptRecordSchema>;

export const emptyObjectSchema = objectSchemaDefinition.parse({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
});
