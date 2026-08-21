import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';

const hooks = vi.hoisted(() => ({
  rejectLinks: false,
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  failSyncPath: undefined as string | undefined,
  failOpenPath: undefined as string | undefined,
  failClosePath: undefined as string | undefined,
  remainingSyncFailures: 0,
  remainingCloseFailures: 0
}));

interface ActualFileSystem {
  link(existingPath: string, newPath: string): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<object>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<ActualFileSystem>();
  return {
    ...actual,
    link: (existingPath: string, newPath: string) => {
      if (hooks.rejectLinks) return Promise.reject(errno('EPERM'));
      return actual.link(existingPath, newPath);
    },
    open: async (path: string, flags: string, mode?: number) => {
      if (path === hooks.failOpenPath && flags === 'wx') throw errno('EIO');
      const handle = await actual.open(path, flags, mode);
      if (path !== hooks.failSyncPath && path !== hooks.failClosePath) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync' && hooks.remainingSyncFailures > 0) {
            return () => {
              hooks.remainingSyncFailures -= 1;
              return Promise.reject(errno('EIO'));
            };
          }
          if (property === 'close' && hooks.remainingCloseFailures > 0) {
            return () => {
              hooks.remainingCloseFailures -= 1;
              return Reflect.apply(Reflect.get(target, property, receiver) as () => Promise<void>, target, [])
                .then(() => Promise.reject(errno('EIO')));
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function'
            ? (...arguments_: unknown[]): unknown => Reflect.apply(value, target, arguments_)
            : value;
        }
      });
    },
    rename: async (oldPath: string, newPath: string) => {
      await hooks.beforeRename?.(oldPath, newPath);
      return actual.rename(oldPath, newPath);
    }
  };
});

const {commitOutput} = await import('../src/archive/output.js');
const directories: string[] = [];

afterEach(async () => {
  hooks.rejectLinks = false;
  hooks.beforeRename = undefined;
  hooks.failSyncPath = undefined;
  hooks.failOpenPath = undefined;
  hooks.failClosePath = undefined;
  hooks.remainingSyncFailures = 0;
  hooks.remainingCloseFailures = 0;
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('portable output publication fallbacks', () => {
  it('uses exclusive copy when the filesystem rejects no-force hardlinks', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    hooks.rejectLinks = true;
    await commitOutput(output, false, path => writeFile(path, 'portable'), () => Promise.resolve());
    expect(await readFile(output, 'utf8')).toBe('portable');
    expect((await readdir(directory)).filter(name => name.startsWith('.output.sb3.'))).toEqual([]);
  });

  it('creates and syncs a fallback backup before atomically replacing an existing output', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    await writeFile(output, 'old');
    hooks.rejectLinks = true;
    let observedBackupBeforeReplacement = false;
    hooks.beforeRename = async (from, to) => {
      if (to === output && from.includes('.output.sb3.tmp-')) {
        expect(await readFile(output, 'utf8')).toBe('old');
        expect(await readFile(backup, 'utf8')).toBe('old');
        observedBackupBeforeReplacement = true;
      }
    };
    await commitOutput(output, true, path => writeFile(path, 'new'), () => Promise.resolve());
    expect(observedBackupBeforeReplacement).toBe(true);
    expect(await readFile(output, 'utf8')).toBe('new');
    expect((await readdir(directory)).filter(name => name.startsWith('.output.sb3.'))).toEqual([]);
  });

  it('atomically restores the durable backup when post-replacement syncing fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await writeFile(output, 'old');
    hooks.failSyncPath = output;
    hooks.remainingSyncFailures = 1;
    await expect(commitOutput(output, true, path => writeFile(path, 'new'), () => Promise.resolve())).rejects.toThrowError(/EIO/);
    expect(await readFile(output, 'utf8')).toBe('old');
    expect((await readdir(directory)).filter(name => name.startsWith('.output.sb3.'))).toEqual([]);
  });

  it('normalizes exclusive-copy destination failures and removes the temporary file', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    hooks.rejectLinks = true;
    hooks.failOpenPath = output;
    await expect(commitOutput(output, false, path => writeFile(path, 'new'), () => Promise.resolve())).rejects.toThrowError(/EIO/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('removes an exclusive-copy destination when closing its handle fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    hooks.rejectLinks = true;
    hooks.failClosePath = output;
    hooks.remainingCloseFailures = 1;
    await expect(commitOutput(output, false, path => writeFile(path, 'new'), () => Promise.resolve())).rejects.toThrowError(/EIO/);
    expect(await readdir(directory)).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-link-fallback-'));
  directories.push(directory);
  return directory;
}

function errno(code: string): NodeJS.ErrnoException & Error {
  const error = new Error(code) as NodeJS.ErrnoException & Error;
  error.code = code;
  return error;
}
