import { describe, expect, it } from 'vitest';
import {
  createScriptGotoLoopDetector,
  createScriptGotoLoopError,
} from '../extension/runtime/goto-loop-detection';

describe('cap.goto loop detection', () => {
  it('detects repeated continuations with the same URL and input', () => {
    const detector = createScriptGotoLoopDetector(3);

    expect(detector.record({ url: 'https://example.com/next', input: { q: 'web-cap' } }))
      .toBeUndefined();
    expect(detector.record({ url: 'https://example.com/next', input: { q: 'web-cap' } }))
      .toBeUndefined();

    const detection = detector.record({
      url: 'https://example.com/next',
      input: { q: 'web-cap' },
    });

    expect(detection).toEqual({
      url: 'https://example.com/next',
      repeatCount: 3,
      maxRepeatCount: 3,
    });
    expect(createScriptGotoLoopError(detection!).message).toContain(
      'repeated cap.goto loop for https://example.com/next',
    );
  });

  it('normalizes object key order when fingerprinting input', () => {
    const detector = createScriptGotoLoopDetector(2);

    expect(detector.record({ url: 'https://example.com/next', input: { a: 1, b: 2 } }))
      .toBeUndefined();

    expect(detector.record({ url: 'https://example.com/next', input: { b: 2, a: 1 } }))
      .toMatchObject({
        url: 'https://example.com/next',
        repeatCount: 2,
      });
  });

  it('allows workflows that change continuation input', () => {
    const detector = createScriptGotoLoopDetector(2);

    expect(detector.record({ url: 'https://example.com/next', input: { page: 1 } }))
      .toBeUndefined();
    expect(detector.record({ url: 'https://example.com/next', input: { page: 2 } }))
      .toBeUndefined();
  });
});
