import {
  scriptDefinitionSchema,
  cloudScriptRecordSchema,
  emptyObjectSchema,
  type ScriptDefinition,
  type CloudScriptRecord,
} from '@shared/script-schema';

function createBuiltinScript(definition: ScriptDefinition): ScriptDefinition {
  return scriptDefinitionSchema.parse(definition);
}

function asScriptFunction(body: string): string {
  return `export default async function (input) {\n${body.trim()}\n}`;
}

export const builtinScripts: ScriptDefinition[] = [
  createBuiltinScript({
    id: 'builtin.page.inspect',
    name: 'Inspect current page',
    version: '1.0.0',
    status: 'active',
    type: 'read',
    summary: 'Read the current page title, URL, ready state, link count, and visible inputs.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Any regular web page'],
    },
    tags: ['builtin', 'page', 'inspect'],
    inputSchema: emptyObjectSchema,
    outputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    script: {
      timeoutMs: 8_000,
      code: asScriptFunction(`
const inputs = [...document.querySelectorAll('input, textarea')]
  .slice(0, 20)
  .map((element) => {
    const field = element;
    return {
      tagName: field.tagName.toLowerCase(),
      id: field.id,
      name: field.getAttribute('name') ?? '',
      type: field instanceof HTMLInputElement ? field.type : 'textarea',
      placeholder: field.getAttribute('placeholder') ?? '',
      value: 'value' in field ? field.value : '',
    };
  });

return {
  url: window.location.href,
  title: document.title,
  readyState: document.readyState,
  linkCount: document.querySelectorAll('a').length,
  inputCount: inputs.length,
  inputs,
};
      `),
    },
  }),
  createBuiltinScript({
    id: 'builtin.page.wait_for_element',
    name: 'Wait for element',
    version: '1.0.0',
    status: 'active',
    type: 'act',
    summary: 'Wait until a selector resolves to an element on the current page.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Dynamic pages'],
    },
    tags: ['builtin', 'page', 'wait'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait time in milliseconds.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        found: { type: 'boolean' },
      },
      required: ['selector', 'found'],
      additionalProperties: false,
    },
    script: {
      timeoutMs: 10_000,
      code: asScriptFunction(`
const selector = String(input.selector ?? '');
const timeoutMs = Math.max(Number(input.timeoutMs ?? 5000), 1);
if (!selector) {
  throw new Error('selector is required.');
}

const isVisible = (element) => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.pointerEvents === 'none' ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const getElement = () => {
  const elements = [...document.querySelectorAll(selector)];
  return elements.find(isVisible) ?? elements[0] ?? null;
};

const existing = getElement();
if (existing) {
  return { selector, found: true };
}

await new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const observer = new MutationObserver(() => {
    if (getElement()) {
      observer.disconnect();
      resolve(undefined);
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      observer.disconnect();
      reject(new Error(\`Timed out waiting for selector \${selector}\`));
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    reject(new Error(\`Timed out waiting for selector \${selector}\`));
  }, timeoutMs);
});

return { selector, found: true };
      `),
    },
  }),
  createBuiltinScript({
    id: 'builtin.page.query_elements',
    name: 'Query page elements',
    version: '1.0.0',
    status: 'active',
    type: 'read',
    summary: 'Find DOM elements by selector with optional paging, visibility, and text filters.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Pages with large DOMs'],
    },
    tags: ['builtin', 'page', 'query'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to match.' },
        limit: { type: 'integer', description: 'Maximum number of elements to return.' },
        offset: { type: 'integer', description: 'Result offset.' },
        visibleOnly: { type: 'boolean', description: 'Only include visible elements.' },
        textContains: { type: 'string', description: 'Case-insensitive text filter.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    script: {
      timeoutMs: 8_000,
      code: asScriptFunction(`
const selector = String(input.selector ?? '');
if (!selector) {
  throw new Error('selector is required.');
}

const normalizedLimit = Math.min(Math.max(Math.trunc(Number(input.limit ?? 20)), 1), 200);
const normalizedOffset = Math.max(Math.trunc(Number(input.offset ?? 0)), 0);
const textFilter = String(input.textContains ?? '').trim().toLowerCase();
const visibleOnly = Boolean(input.visibleOnly ?? false);

const isVisible = (element) => {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.pointerEvents === 'none' ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const elements = [...document.querySelectorAll(selector)]
  .filter((element) => !visibleOnly || isVisible(element))
  .filter((element) => {
    if (!textFilter) {
      return true;
    }
    return (element.textContent ?? '').trim().toLowerCase().includes(textFilter);
  })
  .slice(normalizedOffset, normalizedOffset + normalizedLimit)
  .map((element, index) => {
    const rect = element instanceof HTMLElement ? element.getBoundingClientRect() : null;
    return {
      index: normalizedOffset + index,
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      className: element instanceof HTMLElement ? element.className : '',
      text: (element.textContent ?? '').trim().slice(0, 500),
      visible: isVisible(element),
      rect: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
    };
  });

return {
  selector,
  count: elements.length,
  items: elements,
};
      `),
    },
  }),
  createBuiltinScript({
    id: 'builtin.page.click',
    name: 'Click page element',
    version: '1.0.0',
    status: 'active',
    type: 'act',
    summary: 'Click an element matched by selector on the current page.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Interactive pages'],
    },
    tags: ['builtin', 'page', 'click'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element to click.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        clicked: { type: 'boolean' },
      },
      required: ['selector', 'clicked'],
      additionalProperties: false,
    },
    script: {
      timeoutMs: 8_000,
      code: asScriptFunction(`
await cap.call('builtin.page.wait_for_element', {
  selector: String(input.selector ?? ''),
});

const selector = String(input.selector ?? '');
const elements = [...document.querySelectorAll(selector)];
const element = elements.find((candidate) => candidate instanceof HTMLElement) ?? elements[0];
if (!(element instanceof HTMLElement)) {
  throw new Error(\`Selector \${selector} did not resolve to an HTMLElement.\`);
}

element.click();
return { selector, clicked: true };
      `),
    },
  }),
  createBuiltinScript({
    id: 'builtin.page.fill_input',
    name: 'Fill page input',
    version: '1.0.0',
    status: 'active',
    type: 'act',
    summary: 'Fill an input or textarea on the current page and dispatch input/change events.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Form pages with text fields'],
    },
    tags: ['builtin', 'page', 'fill', 'input'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input element.' },
        value: { type: 'string', description: 'Text value to write.' },
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
      timeoutMs: 8_000,
      code: asScriptFunction(`
await cap.call('builtin.page.wait_for_element', {
  selector: String(input.selector ?? ''),
});

const selector = String(input.selector ?? '');
const value = String(input.value ?? '');
const element = [...document.querySelectorAll(selector)][0];
if (
  !(element instanceof HTMLInputElement) &&
  !(element instanceof HTMLTextAreaElement) &&
  !(element instanceof HTMLElement && element.isContentEditable)
) {
  throw new Error(\`Selector \${selector} did not resolve to an editable input target.\`);
}

await cap.typeIntoElement(element, value);
return { selector, value };
      `),
    },
  }),
  createBuiltinScript({
    id: 'builtin.page.read_text',
    name: 'Read element text',
    version: '1.0.0',
    status: 'active',
    type: 'read',
    summary: 'Read trimmed text from the first matched element.',
    target: {
      site: 'generic-web',
      urlPatterns: ['http://*', 'https://*'],
      pageHints: ['Text-heavy pages'],
    },
    tags: ['builtin', 'page', 'read', 'text'],
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the target element.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
    script: {
      timeoutMs: 8_000,
      code: asScriptFunction(`
const selector = String(input.selector ?? '');
if (!selector) {
  throw new Error('selector is required.');
}

const element = [...document.querySelectorAll(selector)][0];
if (!(element instanceof HTMLElement)) {
  throw new Error(\`Selector \${selector} did not resolve to an HTMLElement.\`);
}

return {
  selector,
  text: element.textContent?.trim() ?? '',
};
      `),
    },
  }),
];

export function getBuiltinScriptById(scriptId: string): ScriptDefinition | undefined {
  return builtinScripts.find((scriptDefinition) => scriptDefinition.id === scriptId);
}

export const builtinScriptRecords: CloudScriptRecord[] = builtinScripts.map(
  (scriptDefinition) =>
    cloudScriptRecordSchema.parse({
      id: scriptDefinition.id,
      scriptDefinition,
      status: scriptDefinition.status,
      publishedAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
    }),
);
