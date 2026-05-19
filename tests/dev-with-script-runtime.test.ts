import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runDevWithScriptRuntime } from '../scripts/dev-with-script-runtime';

describe('dev-with-script-runtime script', () => {
  it('spawns local package binaries through the injected runner', () => {
    const spawned: Array<{ command: string; args: string[] }> = [];
    const runner = {
      sync: vi.fn(() => ({ status: 0 })),
      spawn: vi.fn((command: string, args: string[]) => {
        spawned.push({ command, args });
        return Object.assign(new EventEmitter(), {
          killed: false,
          kill: vi.fn(),
        });
      }),
    };

    runDevWithScriptRuntime(['-b', 'firefox'], runner as never);

    expect(runner.sync).toHaveBeenCalledWith(
      'tsx',
      ['scripts/generate-script-runtime.ts'],
      { stdio: 'inherit' },
    );
    expect(spawned).toEqual([
      {
        command: 'tsx',
        args: ['scripts/generate-script-runtime.ts', '--watch'],
      },
      {
        command: 'wxt',
        args: ['-b', 'firefox'],
      },
    ]);
  });
});
