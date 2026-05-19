import type { ScriptDefinition } from '@shared/script-schema';

export function scriptRequiresBrowserLevelClick(
  scriptDefinition: ScriptDefinition,
  scriptRegistry: ScriptDefinition[],
): boolean {
  return scriptMatchesScriptPredicate(scriptDefinition, scriptRegistry, scriptUsesManagedClick);
}

export function scriptRequiresBrowserLevelKeyboard(
  scriptDefinition: ScriptDefinition,
  scriptRegistry: ScriptDefinition[],
): boolean {
  return scriptMatchesScriptPredicate(
    scriptDefinition,
    scriptRegistry,
    scriptUsesManagedKeyboard,
  );
}

export function scriptRequiresBrowserLevelWindow(
  scriptDefinition: ScriptDefinition,
  scriptRegistry: ScriptDefinition[],
): boolean {
  return scriptMatchesScriptPredicate(
    scriptDefinition,
    scriptRegistry,
    scriptUsesManagedWindow,
  );
}

function scriptMatchesScriptPredicate(
  scriptDefinition: ScriptDefinition,
  scriptRegistry: ScriptDefinition[],
  predicate: (code: string) => boolean,
): boolean {
  const registry = new Map<string, ScriptDefinition>();
  for (const item of scriptRegistry) {
    registry.set(item.id, item);
  }
  registry.set(scriptDefinition.id, scriptDefinition);

  const visited = new Set<string>();
  const stack = [scriptDefinition.id];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const current = registry.get(currentId);
    if (!current) {
      continue;
    }

    if (predicate(current.script.code)) {
      return true;
    }

    for (const nestedId of extractScriptCalls(current.script.code)) {
      if (!visited.has(nestedId)) {
        stack.push(nestedId);
      }
    }
  }

  return false;
}

function scriptUsesManagedClick(code: string): boolean {
  if (code.includes('builtin.page.click')) {
    return true;
  }

  return (
    /\.\s*click\s*\(/.test(code) ||
    /new\s+MouseEvent\s*\(/.test(code) ||
    /dispatchEvent\s*\(\s*new\s+MouseEvent/.test(code)
  );
}

function scriptUsesManagedKeyboard(code: string): boolean {
  if (code.includes('builtin.page.fill_input')) {
    return true;
  }

  return (
    /new\s+KeyboardEvent\s*\(/.test(code) ||
    /dispatchEvent\s*\(\s*new\s+KeyboardEvent/.test(code)
  );
}

function scriptUsesManagedWindow(code: string): boolean {
  return /\bwindow\s*\.\s*close\s*\(/.test(code) || /\bglobalThis\s*\.\s*close\s*\(/.test(code);
}

function extractScriptCalls(code: string): string[] {
  const calls = new Set<string>();
  const patterns = [
    /cap\.call\(\s*['"`]([^'"`]+)['"`]/g,
    /cap\[['"`]call['"`]\]\(\s*['"`]([^'"`]+)['"`]/g,
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) {
        calls.add(match[1]);
      }
    }
  }

  return [...calls];
}
