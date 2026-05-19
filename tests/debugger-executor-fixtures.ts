import { scriptDefinitionSchema } from '@shared/script-schema';

export type DebuggerCommand = {
  method: string;
  params: Record<string, unknown>;
};

export type DebuggerEventListener = (
  source: { tabId: number },
  method: string,
  params?: Record<string, unknown>,
) => void;

export function createDebuggerActionScript(options: {
  id: string;
  name: string;
  summary: string;
  outputProperties: Record<string, unknown>;
  outputRequired: string[];
  code: string;
}) {
  return scriptDefinitionSchema.parse({
    id: options.id,
    name: options.name,
    version: '1.0.0',
    status: 'active',
    type: 'act',
    summary: options.summary,
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: [],
    },
    tags: ['test'],
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: options.outputProperties,
      required: options.outputRequired,
      additionalProperties: false,
    },
    script: {
      timeoutMs: 1_000,
      code: options.code.trim(),
    },
  });
}

export function successEvaluationResult(result: Record<string, unknown>) {
  return {
    result: {
      value: {
        ok: true,
        result,
        evidence: {
          url: 'https://example.com',
          events: [],
          screenshots: [],
        },
      },
    },
  };
}
