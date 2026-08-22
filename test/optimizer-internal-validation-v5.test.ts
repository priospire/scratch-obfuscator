import {afterEach, describe, expect, it, vi} from 'vitest';
import {createFixtureProject} from './support.js';

describe('optimizer internal validation boundary', () => {
  afterEach(() => {
    vi.doUnmock('../src/validation/index.js');
    vi.resetModules();
  });

  it('wraps a post-transform invariant failure with its original cause', async () => {
    const cause = new Error('injected post-transform rejection');
    let validations = 0;
    vi.doMock('../src/validation/index.js', () => ({
      validateProject: (): void => {
        validations += 1;
        if (validations === 2) throw cause;
      }
    }));
    const {optimizeProject} = await import('../src/obfuscation/optimizer.js');

    let thrown: unknown;
    try {
      optimizeProject(createFixtureProject(), {foldConstants: false});
    } catch (error) {
      thrown = error;
    }

    expect(validations).toBe(2);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('internal validation rejected the optimized project');
    expect((thrown as Error).cause).toBe(cause);
  });
});
