import {resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArguments);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('executable CLI entry point', () => {
  it('runs main through the entry-point guard and removes its signal handlers', async () => {
    const modulePath = resolve('src', 'cli.ts');
    process.argv.splice(0, process.argv.length, process.execPath, modulePath, '--version');
    process.exitCode = undefined;
    const initialInterruptListeners = process.listenerCount('SIGINT');
    const initialTerminateListeners = process.listenerCount('SIGTERM');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.resetModules();
    const entryModule = '../src/cli.js?entry-point-test';
    await import(entryModule);
    await vi.waitFor(() => {
      expect(process.exitCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith('0.5.1\n');
      expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
      expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);
    });
  });
});
