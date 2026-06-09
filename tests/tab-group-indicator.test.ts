import { describe, expect, it } from 'vitest';
import { createExecutionTabGroupOptions } from '../extension/runtime/tab-group-indicator';

describe('execution tab group indicator', () => {
  it('creates the temporary tab group in the target tab window', () => {
    expect(createExecutionTabGroupOptions({ id: 42, windowId: 7 })).toEqual({
      tabIds: 42,
      createProperties: {
        windowId: 7,
      },
    });
  });

  it('omits create properties when the tab window is unavailable', () => {
    expect(createExecutionTabGroupOptions({ id: 42 })).toEqual({
      tabIds: 42,
    });
    expect(createExecutionTabGroupOptions({ id: 42, windowId: -1 })).toEqual({
      tabIds: 42,
    });
  });
});
