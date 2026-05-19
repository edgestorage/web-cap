import {
  scriptDefinitionSchema,
  cloudScriptRecordSchema,
  type CloudScriptRecord,
} from '@shared/script-schema';

const pageInspectSummaryScript = scriptDefinitionSchema.parse({
  id: 'cap_page_inspect_summary',
  name: 'Inspect current page summary',
  version: '1.0.0',
  status: 'active',
  type: 'read',
  summary: 'Read the current document title and anchor count from the active page.',
  target: {
    site: 'generic-web',
    urlPatterns: ['http://*', 'https://*'],
    pageHints: ['Any regular web page'],
  },
  tags: ['page', 'dom', 'read'],
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      linkCount: { type: 'integer' },
    },
    required: ['title', 'linkCount'],
    additionalProperties: false,
  },
  script: {
    timeoutMs: 8_000,
    code: `
export default async function () {
  return {
    title: document.title,
    linkCount: document.querySelectorAll('a').length,
  };
}
    `.trim(),
  },
});

const fillInputWithTextScript = scriptDefinitionSchema.parse({
  id: 'cap_fill_input_with_text',
  name: 'Fill input with text',
  version: '1.0.0',
  status: 'active',
  type: 'act',
  summary: 'Fill a text input on the active page.',
  target: {
    site: 'generic-web',
    urlPatterns: ['http://*', 'https://*'],
    pageHints: ['Form pages with text inputs'],
  },
  tags: ['form', 'input', 'action'],
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector pointing at the target input element.',
      },
      value: {
        type: 'string',
        description: 'Text value to write into the target input.',
      },
    },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  script: {
    timeoutMs: 10_000,
    code: `
export default async function (args) {
  return await cap.call('builtin.page.fill_input', args);
}
    `.trim(),
  },
});

export const testScriptRecords: CloudScriptRecord[] = [
  {
    id: pageInspectSummaryScript.id,
    scriptDefinition: pageInspectSummaryScript,
    status: 'active',
    publishedAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  },
  {
    id: fillInputWithTextScript.id,
    scriptDefinition: fillInputWithTextScript,
    status: 'active',
    publishedAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  },
].map((record) => cloudScriptRecordSchema.parse(record));
