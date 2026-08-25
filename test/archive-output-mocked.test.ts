import type {BigIntStats} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FileSystemError, UsageError} from '../src/errors.js';

const fileSystem = vi.hoisted(() => ({
  access: vi.fn(),
  link: vi.fn(),
  lstat: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn()
}));

vi.mock('node:fs/promises', () => fileSystem);

const {commitOutput, prepareOutput} = await import('../src/archive/output.js');

beforeEach(() => {
  vi.resetAllMocks();
  fileSystem.stat.mockImplementation((value: string) => Promise.resolve(extnameForTest(value) === '.sb3' ? fakeStats(1n) : fakeDirectoryStats()));
  fileSystem.realpath.mockImplementation((value: string) => Promise.resolve(resolve(value)));
  fileSystem.lstat.mockRejectedValue(errno('ENOENT'));
  fileSystem.access.mockResolvedValue(undefined);
  fileSystem.link.mockResolvedValue(undefined);
  fileSystem.rename.mockResolvedValue(undefined);
  fileSystem.unlink.mockResolvedValue(undefined);
  fileSystem.readFile.mockRejectedValue(errno('ENOENT'));
  fileSystem.open.mockResolvedValue(fakeHandle());
});

describe('mocked filesystem edge paths', () => {
  it('maps a non-ENOENT output inspection failure', async () => {
    fileSystem.lstat.mockImplementation((value: string) => isReservedPath(value) ? Promise.reject(errno('ENOENT')) : Promise.reject(errno('EACCES')));
    await expect(prepareOutput('input.sb3', 'output.sb3', false)).rejects.toBeInstanceOf(FileSystemError);
  });

  it('maps an existing non-symlink resolution failure', async () => {
    const input = resolve('input.sb3');
    fileSystem.lstat.mockImplementation((value: string) => isReservedPath(value)
      ? Promise.reject(errno('ENOENT'))
      : Promise.resolve({isSymbolicLink: () => false}));
    fileSystem.realpath.mockImplementation((value: string) => resolve(value) === resolve('output.sb3')
      ? Promise.reject(errno('EACCES'))
      : Promise.resolve(resolve(value)));
    await expect(prepareOutput(input, 'output.sb3', true)).rejects.toBeInstanceOf(FileSystemError);
  });

  it('recognizes a dangling symlink as an existing output', async () => {
    const input = resolve('input.sb3');
    fileSystem.lstat.mockImplementation((value: string) => isReservedPath(value)
      ? Promise.reject(errno('ENOENT'))
      : Promise.resolve({isSymbolicLink: () => true}));
    fileSystem.realpath.mockImplementation((value: string) => resolve(value) === resolve('output.sb3')
      ? Promise.reject(errno('ENOENT'))
      : Promise.resolve(resolve(value)));
    await expect(prepareOutput(input, 'output.sb3', false)).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects an output whose canonical path resolves to the input', async () => {
    const canonical = resolve('canonical.sb3');
    fileSystem.lstat.mockImplementation((value: string) => isReservedPath(value)
      ? Promise.reject(errno('ENOENT'))
      : Promise.resolve({isSymbolicLink: () => false}));
    fileSystem.realpath.mockImplementation((value: string) => {
      const absolute = resolve(value);
      if (absolute === resolve('input.sb3') || absolute === resolve('output.sb3')) return Promise.resolve(canonical);
      return Promise.resolve(absolute);
    });
    fileSystem.stat.mockImplementation((value: string) => Promise.resolve(extnameForTest(value) === '.sb3' ? fakeStats(2n) : fakeDirectoryStats()));
    await expect(prepareOutput('input.sb3', 'output.sb3', true)).rejects.toThrowError(/resolve to the same file/);
  });

  it('rejects a prospective output that canonicalizes to the input', async () => {
    const requestedOutput = resolve('virtual', 'output.sb3');
    const canonicalDirectory = resolve('canonical');
    const canonicalInput = join(canonicalDirectory, basename(requestedOutput));
    fileSystem.realpath.mockImplementation((value: string) => {
      const absolute = resolve(value);
      if (absolute === resolve('input.sb3')) return Promise.resolve(canonicalInput);
      if (absolute === dirname(requestedOutput)) return Promise.resolve(canonicalDirectory);
      return Promise.resolve(absolute);
    });
    await expect(prepareOutput('input.sb3', requestedOutput, false)).rejects.toThrowError(/resolve to the same file/);
    expect(dirname(canonicalInput)).toBe(canonicalDirectory);
  });

  it('rejects an existing output that is not a regular file', async () => {
    const output = resolve('output.sb3');
    fileSystem.lstat.mockImplementation((value: string) => isReservedPath(value)
      ? Promise.reject(errno('ENOENT'))
      : Promise.resolve({isSymbolicLink: () => false}));
    fileSystem.stat.mockImplementation((value: string) => {
      const absolute = resolve(value);
      if (absolute === output) return Promise.resolve(fakeSpecialStats());
      return Promise.resolve(extnameForTest(value) === '.sb3' ? fakeStats(1n) : fakeDirectoryStats());
    });
    await expect(prepareOutput('input.sb3', output, true)).rejects.toThrowError(/not a regular file/);
  });

  it('falls back to a read-only durability handle when write access is denied', async () => {
    fileSystem.open.mockImplementation((_path: string, flags: string) => flags === 'r+'
      ? Promise.reject(errno('EACCES'))
      : Promise.resolve(fakeHandle()));

    await expect(commitOutput('output.sb3', false, () => Promise.resolve(), () => Promise.resolve()))
      .resolves.toBeUndefined();
    expect(fileSystem.open).toHaveBeenCalledWith(expect.any(String), 'r+');
    expect(fileSystem.open).toHaveBeenCalledWith(expect.any(String), 'r');
  });
});

function fakeStats(inode: bigint): BigIntStats {
  return {
    dev: 1n,
    ino: inode,
    isFile: () => true,
    isDirectory: () => false
  } as BigIntStats;
}

function fakeDirectoryStats(): BigIntStats {
  return {
    dev: 1n,
    ino: 99n,
    isFile: () => false,
    isDirectory: () => true
  } as BigIntStats;
}

function fakeSpecialStats(): BigIntStats {
  return {
    dev: 1n,
    ino: 88n,
    isFile: () => false,
    isDirectory: () => false
  } as BigIntStats;
}

function fakeHandle(): {
  close: () => Promise<void>;
  sync: () => Promise<void>;
} {
  return {
    close: () => Promise.resolve(),
    sync: () => Promise.resolve()
  };
}

function isReservedPath(value: string): boolean {
  return value.includes('.scratch-obfuscator.') || value.includes('.tmp-');
}

function extnameForTest(value: string): string {
  return value.toLowerCase().endsWith('.sb3') ? '.sb3' : '';
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
