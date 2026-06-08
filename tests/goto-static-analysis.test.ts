import { describe, expect, it } from 'vitest';
import {
  analyzeStaticGotoLoops,
  assertNoStaticGotoLoops,
} from '../extension/runtime/goto-static-analysis';

describe('static cap.goto loop analysis', () => {
  it('detects an entry point that unconditionally returns cap.goto', () => {
    const issues = analyzeStaticGotoLoops(`
export default async function (input) {
  return cap.goto('/next', { step: input.step });
}
    `);

    expect(issues.map((issue) => issue.kind)).toContain('entry_always_returns_goto');
    expect(() => assertNoStaticGotoLoops(`
export default async function () {
  return cap.goto('/next', {});
}
    `)).toThrow(/only returns cap\.goto/);
  });

  it('detects if/else branches that all return cap.goto', () => {
    const issues = analyzeStaticGotoLoops(`
export default async function (input) {
  if (input.done) {
    return cap.goto('/done', { done: true });
  } else {
    return cap.goto('/next', { done: false });
  }
}
    `);

    expect(issues.map((issue) => issue.kind)).toContain('all_if_else_branches_return_goto');
    expect(issues.map((issue) => issue.kind)).toContain('entry_always_returns_goto');
  });

  it('detects infinite loops that return cap.goto', () => {
    const issues = analyzeStaticGotoLoops(`
export default async function () {
  while (true) {
    return cap.goto('/again', {});
  }
}
    `);

    expect(issues.map((issue) => issue.kind)).toContain('infinite_loop_returns_goto');
  });

  it('detects multiple return paths with the same static cap.goto continuation', () => {
    const issues = analyzeStaticGotoLoops(`
export default async function (input) {
  if (input.left) {
    return cap.goto('/same', { b: 2, a: 1 });
  }
  return cap.goto('/same', { a: 1, b: 2 });
}
    `);

    expect(issues.map((issue) => issue.kind)).toContain('same_static_goto_return');
  });

  it('allows scripts with a final result branch', () => {
    const issues = analyzeStaticGotoLoops(`
export default async function (input) {
  if (input.step === 'next') {
    return { ok: true };
  }
  return cap.goto('/next', { step: 'next' });
}
    `);

    expect(issues).toEqual([]);
  });
});
