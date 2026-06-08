export const MAX_REPEATED_SCRIPT_GOTO_CONTINUATIONS = 3;

export interface ScriptGotoLoopRecord {
  url: string;
  input: Record<string, unknown>;
}

export interface ScriptGotoLoopDetection {
  url: string;
  repeatCount: number;
  maxRepeatCount: number;
}

export interface ScriptGotoLoopDetector {
  record(record: ScriptGotoLoopRecord): ScriptGotoLoopDetection | undefined;
}

export function createScriptGotoLoopDetector(
  maxRepeatCount = MAX_REPEATED_SCRIPT_GOTO_CONTINUATIONS,
): ScriptGotoLoopDetector {
  const seenCounts = new Map<string, number>();

  return {
    record(record) {
      const fingerprint = createScriptGotoFingerprint(record);
      const repeatCount = (seenCounts.get(fingerprint) ?? 0) + 1;
      seenCounts.set(fingerprint, repeatCount);
      if (repeatCount < maxRepeatCount) {
        return undefined;
      }
      return {
        url: record.url,
        repeatCount,
        maxRepeatCount,
      };
    },
  };
}

export function createScriptGotoLoopError(detection: ScriptGotoLoopDetection): Error {
  return new Error(
    `Script appears to be stuck in a repeated cap.goto loop for ${detection.url}. ` +
      `The same URL and input were returned ${detection.repeatCount} times; ` +
      'return a final result or change the continuation input to make progress.',
  );
}

function createScriptGotoFingerprint(record: ScriptGotoLoopRecord): string {
  return `${record.url}\n${stableStringify(record.input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}
