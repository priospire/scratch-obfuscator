import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {BigIntStats, PathLike, Stats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {zipSync} from 'fflate';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_LIMITS, type ArchiveEntry, type ScratchProject} from '../src/types.js';
import {UsageError} from '../src/errors.js';

interface ActualFileSystem {
  access(path: PathLike, mode?: number): Promise<void>;
  link(existingPath: PathLike, newPath: PathLike): Promise<void>;
  lstat(path: PathLike): Promise<Stats>;
  mkdir(path: PathLike): Promise<string | undefined>;
  mkdtemp(prefix: string): Promise<string>;
  open(path: PathLike, flags: string | number, mode?: number): Promise<FileHandle>;
  readFile(path: PathLike, encoding: 'utf8'): Promise<string>;
  readdir(path: PathLike): Promise<string[]>;
  realpath(path: PathLike): Promise<string>;
  rename(oldPath: PathLike, newPath: PathLike): Promise<void>;
  rm(path: PathLike, options: {recursive: boolean; force: boolean}): Promise<void>;
  stat(path: PathLike, options?: {bigint?: boolean}): Promise<BigIntStats | Stats>;
  unlink(path: PathLike): Promise<void>;
  writeFile(path: PathLike, data: string | Uint8Array): Promise<void>;
}

type OpenHook = (path: PathLike, flags: string | number, mode?: number) => Promise<FileHandle>;
type PairHook = (first: PathLike, second: PathLike) => Promise<void>;

const hooks = vi.hoisted(() => ({
  link: undefined as PairHook | undefined,
  lstat: undefined as ((path: PathLike) => Promise<Stats>) | undefined,
  open: undefined as OpenHook | undefined,
  randomBytes: undefined as ((size: number) => Buffer) | undefined,
  rename: undefined as PairHook | undefined,
  stat: undefined as ((path: PathLike, options?: {bigint?: boolean}) => Promise<BigIntStats | Stats>) | undefined,
  unlink: undefined as ((path: PathLike) => Promise<void>) | undefined
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<ActualFileSystem>();
  return {
    ...actual,
    link: (first: PathLike, second: PathLike) => hooks.link?.(first, second) ?? actual.link(first, second),
    lstat: (path: PathLike) => hooks.lstat?.(path) ?? actual.lstat(path),
    open: (path: PathLike, flags: string | number, mode?: number) => hooks.open?.(path, flags, mode) ?? actual.open(path, flags, mode),
    rename: (first: PathLike, second: PathLike) => hooks.rename?.(first, second) ?? actual.rename(first, second),
    stat: (path: PathLike, options?: {bigint?: boolean}) => hooks.stat?.(path, options) ?? actual.stat(path, options),
    unlink: (path: PathLike) => hooks.unlink?.(path) ?? actual.unlink(path)
  };
});

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown> & {randomBytes(size: number): Buffer}>();
  return {
    ...actual,
    randomBytes: (size: number) => hooks.randomBytes?.(size) ?? actual.randomBytes(size)
  };
});

const actualFs = await vi.importActual<ActualFileSystem>('node:fs/promises');
const {commitOutput, prepareOutput} = await import('../src/archive/output.js');
const {loadArchiveBuffer} = await import('../src/archive/reader.js');
const {serializeProject} = await import('../src/archive/writer.js');

const directories: string[] = [];

afterEach(async () => {
  resetHooks();
  vi.doUnmock('fflate');
  vi.doUnmock('yauzl');
  await Promise.all(directories.splice(0).map(directory => actualFs.rm(directory, {recursive: true, force: true})));
});

describe('output transaction regression coverage', () => {
  it('distinguishes unsupported publication errors from an exclusive-copy creation race', async () => {
    const failedDirectory = await temporaryDirectory();
    const failedOutput = join(failedDirectory, 'failed.sb3');
    hooks.link = () => Promise.reject(errno('EIO'));
    await expect(commitOutput(
      failedOutput,
      false,
      path => actualFs.writeFile(path, 'temporary'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot commit output file.*EIO/u);
    expect(await actualFs.readdir(failedDirectory)).toEqual([]);

    resetHooks();
    const racedDirectory = await temporaryDirectory();
    const racedOutput = join(racedDirectory, 'raced.sb3');
    hooks.link = async (_temporary, output) => {
      await actualFs.writeFile(output, 'competing output');
      throw errno('EPERM');
    };
    await expect(commitOutput(
      racedOutput,
      false,
      path => actualFs.writeFile(path, 'temporary'),
      () => Promise.resolve()
    )).rejects.toBeInstanceOf(UsageError);
    expect(await actualFs.readFile(racedOutput, 'utf8')).toBe('competing output');
    expect(await actualFs.readdir(racedDirectory)).toEqual(['raced.sb3']);
  });

  it('removes a newly linked output when directory syncing fails and accepts EINVAL portability', async () => {
    const failedDirectory = await temporaryDirectory();
    const failedOutput = join(failedDirectory, 'failed.sb3');
    hooks.open = directorySyncFailure(failedDirectory, 'EIO');
    await expect(commitOutput(
      failedOutput,
      false,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/EIO/u);
    expect(await actualFs.readdir(failedDirectory)).toEqual([]);

    resetHooks();
    const portableDirectory = await temporaryDirectory();
    const portableOutput = join(portableDirectory, 'portable.sb3');
    hooks.open = directorySyncFailure(portableDirectory, 'EINVAL');
    await commitOutput(
      portableOutput,
      false,
      path => actualFs.writeFile(path, 'portable'),
      () => Promise.resolve()
    );
    expect(await actualFs.readFile(portableOutput, 'utf8')).toBe('portable');
  });

  it('cleans a durable backup when replacement fails before installation', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await actualFs.writeFile(output, 'old');
    hooks.rename = (from, to) => {
      if (String(from).includes('.tmp-') && resolve(String(to)) === resolve(output)) return Promise.reject(errno('EIO'));
      return actualFs.rename(from, to);
    };

    await expect(commitOutput(
      output,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/EIO/u);
    expect(await actualFs.readFile(output, 'utf8')).toBe('old');
    expect(await actualFs.readdir(directory)).toEqual(['output.sb3']);
  });

  it('removes a newly installed force output when its durability sync fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    let remainingFailures = 1;
    hooks.open = async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode);
      if (resolve(String(path)) !== resolve(output) || flags !== 'r+' || remainingFailures === 0) return handle;
      return proxyHandle(handle, {
        sync: () => {
          remainingFailures -= 1;
          return Promise.reject(errno('EIO'));
        }
      });
    };

    await expect(commitOutput(
      output,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/EIO/u);
    expect(await actualFs.readdir(directory)).toEqual([]);
  });

  it('retains a durable backup and reports both failures when restoration itself fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    await actualFs.writeFile(output, 'old');
    let remainingSyncFailures = 1;
    hooks.open = async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode);
      if (resolve(String(path)) !== resolve(output) || flags !== 'r+' || remainingSyncFailures === 0) return handle;
      return proxyHandle(handle, {
        sync: () => {
          remainingSyncFailures -= 1;
          return Promise.reject(errno('EIO'));
        }
      });
    };
    hooks.rename = (from, to) => {
      if (resolve(String(from)) === resolve(backup) && resolve(String(to)) === resolve(output)) {
        return Promise.reject(errno('EACCES'));
      }
      return actualFs.rename(from, to);
    };

    await expect(commitOutput(
      output,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot restore previous output after EIO.*backup remains.*EACCES/u);
    expect(await actualFs.readFile(output, 'utf8')).toBe('new');
    expect(await actualFs.readFile(backup, 'utf8')).toBe('old');
  });

  it('preserves a failed journal cleanup for later recovery without masking the rename failure', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    const journal = join(directory, '.output.sb3.scratch-obfuscator.transaction');
    hooks.rename = (from, to) => {
      if (String(from).includes('.tmp-') && resolve(String(to)) === resolve(output)) return Promise.reject(errno('EIO'));
      return actualFs.rename(from, to);
    };
    hooks.unlink = path => resolve(String(path)) === resolve(journal)
      ? Promise.reject(errno('EACCES'))
      : actualFs.unlink(path);

    await expect(commitOutput(
      output,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/EIO/u);
    expect(await actualFs.readFile(journal, 'utf8')).toContain('"version":1');
    expect((await actualFs.readdir(directory)).some(name => name.includes('.tmp-'))).toBe(false);
  });

  it('detects backup creation races before both hardlink and fallback-copy publication', async () => {
    for (const hardlinkError of ['EEXIST', 'EPERM']) {
      resetHooks();
      const directory = await temporaryDirectory();
      const output = join(directory, `output-${hardlinkError}.sb3`);
      const backup = join(directory, `.${`output-${hardlinkError}.sb3`}.scratch-obfuscator.backup`);
      await actualFs.writeFile(output, 'old');
      hooks.link = async (from, to) => {
        if (resolve(String(to)) === resolve(backup)) {
          await actualFs.writeFile(to, 'racer');
          throw errno(hardlinkError);
        }
        await actualFs.link(from, to);
      };

      await expect(commitOutput(
        output,
        true,
        path => actualFs.writeFile(path, 'new'),
        () => Promise.resolve()
      )).rejects.toThrowError(/reserved backup path already exists/u);
      expect(await actualFs.readFile(output, 'utf8')).toBe('old');
      expect(await actualFs.readFile(backup, 'utf8')).toBe('racer');
    }
  });

  it('removes an incomplete backup after a sync failure and reports cleanup failure if removal is denied', async () => {
    for (const unlinkFails of [false, true]) {
      resetHooks();
      const directory = await temporaryDirectory();
      const output = join(directory, `output-${String(unlinkFails)}.sb3`);
      const backup = join(directory, `.${`output-${String(unlinkFails)}.sb3`}.scratch-obfuscator.backup`);
      await actualFs.writeFile(output, 'old');
      hooks.open = async (path, flags, mode) => {
        const handle = await actualFs.open(path, flags, mode);
        if (resolve(String(path)) !== resolve(backup) || flags !== 'r+') return handle;
        return proxyHandle(handle, {sync: () => Promise.reject(errno('EIO'))});
      };
      if (unlinkFails) {
        hooks.unlink = path => resolve(String(path)) === resolve(backup)
          ? Promise.reject(errno('EACCES'))
          : actualFs.unlink(path);
      }

      const attempt = commitOutput(
        output,
        true,
        path => actualFs.writeFile(path, 'new'),
        () => Promise.resolve()
      );
      if (unlinkFails) await expect(attempt).rejects.toThrowError(/cannot remove an incomplete backup after EIO.*EACCES/u);
      else await expect(attempt).rejects.toThrowError(/EIO/u);
      expect(await actualFs.readFile(output, 'utf8')).toBe('old');
      expect((await actualFs.readdir(directory)).includes(backup.split(/[\\/]/u).at(-1) ?? '')).toBe(unlinkFails);
    }
  });

  it('recovers conservatively from a malformed marker and identifies a non-file marker', async () => {
    const conservativeDirectory = await temporaryDirectory();
    const input = join(conservativeDirectory, 'input.sb3');
    const output = join(conservativeDirectory, 'output.sb3');
    const backup = join(conservativeDirectory, '.output.sb3.scratch-obfuscator.backup');
    const journal = join(conservativeDirectory, '.output.sb3.scratch-obfuscator.transaction');
    await Promise.all([
      actualFs.writeFile(input, 'input'),
      actualFs.writeFile(output, 'new'),
      actualFs.writeFile(backup, 'old'),
      actualFs.writeFile(journal, 'null')
    ]);
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/invalid transaction marker/u);
    expect(await actualFs.readFile(output, 'utf8')).toBe('new');
    expect(await actualFs.readFile(backup, 'utf8')).toBe('old');
    expect(await actualFs.readFile(journal, 'utf8')).toBe('null');

    resetHooks();
    const markerDirectory = await temporaryDirectory();
    const markerInput = join(markerDirectory, 'input.sb3');
    const markerOutput = join(markerDirectory, 'output.sb3');
    const markerPath = join(markerDirectory, '.output.sb3.scratch-obfuscator.transaction');
    await actualFs.writeFile(markerInput, 'input');
    hooks.lstat = path => resolve(String(path)) === resolve(markerPath)
      ? Promise.resolve(fakeNonFileStats())
      : actualFs.lstat(path);
    await expect(prepareOutput(markerInput, markerOutput, true))
      .rejects.toThrowError(/transaction marker is not a regular file/u);
  });

  it('wraps a reserved-path inspection failure with recovery context', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const journal = join(directory, '.output.sb3.scratch-obfuscator.transaction');
    await actualFs.writeFile(input, 'input');
    hooks.lstat = path => resolve(String(path)) === resolve(journal)
      ? Promise.reject(errno('EACCES'))
      : actualFs.lstat(path);

    await expect(prepareOutput(input, output, false))
      .rejects.toThrowError(/cannot recover output transaction.*EACCES/u);
  });

  it('rejects a canonical output parent that is not a directory', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const parent = join(directory, 'parent-file');
    await Promise.all([actualFs.writeFile(input, 'input'), actualFs.writeFile(parent, 'not a directory')]);
    await expect(prepareOutput(input, join(parent, 'output.sb3'), false))
      .rejects.toThrowError(/cannot access output directory.*not a directory|ENOTDIR/u);
  });

  it('fails closed without atomic no-replace support and bounds temporary-name allocation', async () => {
    const writeDirectory = await temporaryDirectory();
    const writeOutput = join(writeDirectory, 'output.sb3');
    const finalOpen = vi.fn();
    hooks.link = () => Promise.reject(errno('EPERM'));
    hooks.open = async (path, flags, mode) => {
      if (resolve(String(path)) === resolve(writeOutput)) finalOpen();
      return actualFs.open(path, flags, mode);
    };
    await expect(commitOutput(
      writeOutput,
      false,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot atomically publish a new output/u);
    expect(finalOpen).not.toHaveBeenCalled();
    expect(await actualFs.readdir(writeDirectory)).toEqual([]);

    resetHooks();
    const collisionDirectory = await temporaryDirectory();
    const collisionOutput = join(collisionDirectory, 'output.sb3');
    const suffix = 'ab'.repeat(12);
    const reserved = join(collisionDirectory, `.output.sb3.tmp-${suffix}`);
    await actualFs.writeFile(reserved, 'reserved');
    hooks.randomBytes = size => Buffer.alloc(size, 0xab);
    const writer = vi.fn<(path: string) => Promise<void>>(path => actualFs.writeFile(path, 'new'));
    await expect(commitOutput(collisionOutput, false, writer, () => Promise.resolve()))
      .rejects.toThrowError(/cannot allocate a temporary tmp path/u);
    expect(writer).not.toHaveBeenCalled();
    expect(await actualFs.readFile(reserved, 'utf8')).toBe('reserved');
  });

  it('reports temporary cleanup failure after publication without discarding the published output', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    hooks.unlink = path => String(path).includes('.tmp-')
      ? Promise.reject(errno('EACCES'))
      : actualFs.unlink(path);

    await expect(commitOutput(
      output,
      false,
      path => actualFs.writeFile(path, 'published'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot clean up the temporary output.*EACCES/u);
    expect(await actualFs.readFile(output, 'utf8')).toBe('published');
    expect((await actualFs.readdir(directory)).some(name => name.includes('.tmp-'))).toBe(true);
  });

  it('honors cancellation before publication and completes an atomic publication already in progress', async () => {
    const beforeDirectory = await temporaryDirectory();
    const beforeOutput = join(beforeDirectory, 'output.sb3');
    const beforeBackup = join(beforeDirectory, '.output.sb3.scratch-obfuscator.backup');
    const beforeController = new AbortController();
    await actualFs.writeFile(beforeOutput, 'old');
    hooks.link = async (from, to) => {
      await actualFs.link(from, to);
      if (resolve(String(to)) === resolve(beforeBackup)) {
        beforeController.abort(new Error('cancel before replacement'));
      }
    };
    await expect(commitOutput(
      beforeOutput,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve(),
      beforeController.signal
    )).rejects.toThrowError(/interrupted/u);
    expect(await actualFs.readFile(beforeOutput, 'utf8')).toBe('old');
    expect(await actualFs.readdir(beforeDirectory)).toEqual(['output.sb3']);

    resetHooks();
    const noForceDirectory = await temporaryDirectory();
    const noForceOutput = join(noForceDirectory, 'output.sb3');
    const noForceController = new AbortController();
    hooks.link = async (from, to) => {
      await actualFs.link(from, to);
      noForceController.abort(new Error('cancel during atomic link'));
    };
    await commitOutput(
      noForceOutput,
      false,
      path => actualFs.writeFile(path, 'published'),
      () => Promise.resolve(),
      noForceController.signal
    );
    expect(await actualFs.readFile(noForceOutput, 'utf8')).toBe('published');
    expect(await actualFs.readdir(noForceDirectory)).toEqual(['output.sb3']);

    resetHooks();
    const forceDirectory = await temporaryDirectory();
    const forceOutput = join(forceDirectory, 'output.sb3');
    const forceController = new AbortController();
    await actualFs.writeFile(forceOutput, 'old');
    hooks.rename = async (from, to) => {
      await actualFs.rename(from, to);
      if (resolve(String(to)) === resolve(forceOutput)) {
        forceController.abort(new Error('cancel during atomic rename'));
      }
    };
    await commitOutput(
      forceOutput,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve(),
      forceController.signal
    );
    expect(await actualFs.readFile(forceOutput, 'utf8')).toBe('new');
    expect(await actualFs.readdir(forceDirectory)).toEqual(['output.sb3']);
  });

  it('reports cleanup failures before and after a force installation', async () => {
    const beforeDirectory = await temporaryDirectory();
    const beforeOutput = join(beforeDirectory, 'output.sb3');
    const beforeBackup = join(beforeDirectory, '.output.sb3.scratch-obfuscator.backup');
    await actualFs.writeFile(beforeOutput, 'old');
    hooks.rename = (from, to) => String(from).includes('.tmp-') && resolve(String(to)) === resolve(beforeOutput)
      ? Promise.reject(errno('EIO'))
      : actualFs.rename(from, to);
    hooks.unlink = path => resolve(String(path)) === resolve(beforeBackup)
      ? Promise.reject(errno('EACCES'))
      : actualFs.unlink(path);
    await expect(commitOutput(
      beforeOutput,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot clean up a failed replacement after EIO.*EACCES/u);
    expect(await actualFs.readFile(beforeOutput, 'utf8')).toBe('old');
    expect(await actualFs.readFile(beforeBackup, 'utf8')).toBe('old');

    resetHooks();
    const afterDirectory = await temporaryDirectory();
    const afterOutput = join(afterDirectory, 'output.sb3');
    let remainingFailures = 1;
    hooks.open = async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode);
      if (resolve(String(path)) !== resolve(afterOutput) || flags !== 'r+' || remainingFailures === 0) return handle;
      return proxyHandle(handle, {
        sync: () => {
          remainingFailures -= 1;
          return Promise.reject(errno('EIO'));
        }
      });
    };
    hooks.unlink = path => resolve(String(path)) === resolve(afterOutput)
      ? Promise.reject(errno('EACCES'))
      : actualFs.unlink(path);
    await expect(commitOutput(
      afterOutput,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/cannot roll back a failed output installation after EIO.*EACCES/u);
    expect(await actualFs.readFile(afterOutput, 'utf8')).toBe('new');
  });

  it('rejects a non-portable backup-link error without modifying the previous output', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    await actualFs.writeFile(output, 'old');
    hooks.link = (from, to) => resolve(String(to)) === resolve(backup)
      ? Promise.reject(errno('EIO'))
      : actualFs.link(from, to);
    await expect(commitOutput(
      output,
      true,
      path => actualFs.writeFile(path, 'new'),
      () => Promise.resolve()
    )).rejects.toThrowError(/EIO/u);
    expect(await actualFs.readFile(output, 'utf8')).toBe('old');
    expect(await actualFs.readdir(directory)).toEqual(['output.sb3']);
  });

  it('finishes stale recovery when the installed output exists without a backup', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const journal = join(directory, '.output.sb3.scratch-obfuscator.transaction');
    const temporaryName = '.output.sb3.tmp-0123456789abcdef01234567';
    const temporary = join(directory, temporaryName);
    await Promise.all([
      actualFs.writeFile(input, 'input'),
      actualFs.writeFile(output, 'installed'),
      actualFs.writeFile(temporary, 'obsolete'),
      actualFs.writeFile(journal, JSON.stringify({
        version: 1,
        output: 'output.sb3',
        temporary: temporaryName,
        pid: 2_147_483_647
      }))
    ]);

    expect((await prepareOutput(input, output, true)).outputExists).toBe(true);
    expect(await actualFs.readFile(output, 'utf8')).toBe('installed');
    expect(await actualFs.readdir(directory)).toEqual(['input.sb3', 'output.sb3']);
  });

  it('uses nonzero inode identity when the device identifier is unavailable', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await Promise.all([actualFs.writeFile(input, 'input'), actualFs.writeFile(output, 'output')]);
    hooks.stat = path => {
      const absolute = resolve(String(path));
      if (absolute === resolve(input) || absolute === resolve(output)) return Promise.resolve(fakeFileStats(0n, 91n));
      return actualFs.stat(path);
    };
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/hardlinks to the same file/u);
  });

  it('exercises the opposite platform path-key policy without changing native files', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await actualFs.writeFile(input, 'input');
    const nativePlatform = process.platform;
    vi.spyOn(process, 'platform', 'get').mockReturnValue(nativePlatform === 'win32' ? 'linux' : 'win32');
    const prepared = await prepareOutput(input, output, false);
    expect(prepared.inputPath).toBe(resolve(input));
    expect(prepared.outputPath).toBe(resolve(output));
  });
});

describe('ZIP reader regression coverage', () => {
  it('accepts one-sided ZIP64 local sizes after unknown extra fields and rejects a malformed field length', async () => {
    const archive = makeZip();
    for (const sentinel of ['compressed', 'uncompressed'] as const) {
      const loaded = await loadArchiveBuffer(withOneSidedZip64(archive, sentinel));
      expect(loaded.project).toEqual({fixture: true});
      await loaded.cleanup();
    }
    const descriptor = await loadArchiveBuffer(withExactDescriptorMetadata(archive));
    expect(descriptor.project).toEqual({fixture: true});
    await descriptor.cleanup();
    await expect(loadArchiveBuffer(withMalformedLocalExtra(archive)))
      .rejects.toThrowError(/missing ZIP64 sizes/u);
  });

  it('normalizes asynchronous ZIP errors, aborts a pending entry read, and preserves stream I/O errors', async () => {
    const queued: FakeZip[] = [];
    vi.doMock('yauzl', () => ({
      fromBuffer: (_buffer: Buffer, _options: unknown, callback: (error: Error | null, zip?: FakeZip) => void) => {
        callback(null, queued.shift());
      },
      open: (_path: string, _options: unknown, callback: (error: Error | null, zip?: FakeZip) => void) => {
        callback(null, queued.shift());
      }
    }));
    vi.resetModules();
    const mockedReader = await import('../src/archive/reader.js');

    const outerError = new FakeZip([]);
    outerError.readBehavior = zip => queueMicrotask(() => zip.emit('error', errno('EIO')));
    queued.push(outerError);
    await expect(mockedReader.loadArchiveBuffer(new Uint8Array()))
      .rejects.toThrowError(/cannot read input archive.*EIO/u);
    expect(() => outerError.emit('error', new Error('late ZIP error'))).not.toThrow();

    const pending = new FakeZip([]);
    pending.readBehavior = () => undefined;
    queued.push(pending);
    const controller = new AbortController();
    const pendingLoad = mockedReader.loadArchiveBuffer(new Uint8Array(), DEFAULT_LIMITS, controller.signal);
    await vi.waitFor(() => expect(pending.readCalls).toBe(1));
    controller.abort(new Error('stop pending ZIP read'));
    await expect(pendingLoad).rejects.toThrowError(/input operation was interrupted/u);
    expect(pending.closed).toBe(true);

    const streaming = new FakeZip([fakeEntry('project.json', Buffer.from('{}'), () => new Readable({
      read() {
        this.destroy(errno('EIO'));
      }
    }))]);
    queued.push(streaming);
    await expect(mockedReader.loadArchiveBuffer(new Uint8Array()))
      .rejects.toThrowError(/cannot read archive entry "project.json".*EIO/u);

    let reportStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>(resolvePromise => {
      reportStreamStarted = resolvePromise;
    });
    const interruptedStream = new FakeZip([fakeEntry('project.json', Buffer.from('{}'), () => new Readable({
      read() {
        reportStreamStarted?.();
      }
    }))]);
    queued.push(interruptedStream);
    const streamController = new AbortController();
    const streamLoad = mockedReader.loadArchiveBuffer(new Uint8Array(), DEFAULT_LIMITS, streamController.signal);
    await streamStarted;
    streamController.abort(new Error('stop active entry stream'));
    await expect(streamLoad).rejects.toThrowError(/input operation was interrupted/u);

    const spooled = new FakeZip([
      fakeEntry('project.json', Buffer.from('{}')),
      fakeEntry('asset.bin', Buffer.from('asset'), () => new Readable({
        read() {
          this.destroy(new Error('asset stream failed'));
        }
      }))
    ]);
    queued.push(spooled);
    hooks.unlink = path => String(path).endsWith('.bin')
      ? Promise.reject(errno('ENOENT'))
      : actualFs.unlink(path);
    await expect(mockedReader.loadArchive('unused.sb3'))
      .rejects.toThrowError(/cannot decompress archive entry "asset.bin"/u);
  });

  it('rejects a buffer load that is already aborted before ZIP parsing', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted input'));
    await expect(loadArchiveBuffer(makeZip(), DEFAULT_LIMITS, controller.signal))
      .rejects.toThrowError(/input operation was interrupted/u);

    const valueController = new AbortController();
    valueController.abort('cancelled without an Error object');
    await expect(loadArchiveBuffer(makeZip(), DEFAULT_LIMITS, valueController.signal))
      .rejects.toMatchObject({name: 'FileSystemError', exitCode: 4});
  });
});

describe('deterministic writer regression coverage', () => {
  it('serializes finite-domain exceptions as JSON null values', () => {
    const project = minimalProject();
    const stage = project.targets[0];
    if (stage === undefined) throw new Error('fixture stage is missing');
    stage.variables['not-a-number'] = ['not a number', Number.NaN];
    stage.variables['positive-infinity'] = ['positive infinity', Number.POSITIVE_INFINITY];
    const parsed = JSON.parse(Buffer.from(serializeProject(project, 'lossless')).toString('utf8')) as ScratchProject;
    expect(parsed.targets[0]?.variables['not-a-number']?.[1]).toBeNull();
    expect(parsed.targets[0]?.variables['positive-infinity']?.[1]).toBeNull();
  });

  it('surfaces a compressor callback error at the per-entry checkpoint', async () => {
    vi.doMock('fflate', async importOriginal => {
      const actual = await importOriginal<Record<string, unknown>>();
      class ErrorZipDeflate {
        attrs = 0;
        mtime = new Date(0);
        os = 0;
        reportError: (() => void) | undefined;

        constructor(readonly name: string) {}

        push(): void {
          queueMicrotask(() => this.reportError?.());
        }
      }
      class ErrorZip {
        constructor(private readonly callback: (error: Error | null, chunk: Uint8Array | null, final: boolean) => void) {}

        add(compressor: ErrorZipDeflate): void {
          compressor.reportError = () => this.callback(new Error('synthetic compression failure'), null, false);
        }

        end(): void {}
        terminate(): void {}
      }
      return {...actual, Zip: ErrorZip, ZipDeflate: ErrorZipDeflate};
    });
    vi.resetModules();
    const mockedWriter = await import('../src/archive/writer.js');
    const directory = await temporaryDirectory();
    const projectBytes = Buffer.from('{}');
    const projectEntry = memoryEntry('project.json', projectBytes);

    const attempt = mockedWriter.writeDeterministicArchive(
      join(directory, 'output.sb3'),
      projectBytes,
      [projectEntry]
    );
    await expect(attempt).rejects.toMatchObject({name: 'FileSystemError', exitCode: 4});
    await expect(attempt).rejects.toThrowError(/synthetic compression failure/u);
  });
});

function resetHooks(): void {
  hooks.link = undefined;
  hooks.lstat = undefined;
  hooks.open = undefined;
  hooks.randomBytes = undefined;
  hooks.rename = undefined;
  hooks.stat = undefined;
  hooks.unlink = undefined;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await actualFs.mkdtemp(join(tmpdir(), 'scratch-obfuscator-coverage-'));
  directories.push(directory);
  return directory;
}

function errno(code: string): NodeJS.ErrnoException & Error {
  const error = new Error(code) as NodeJS.ErrnoException & Error;
  error.code = code;
  return error;
}

interface HandleOverrides {
  close?: () => Promise<void>;
  sync?: () => Promise<void>;
  write?: (buffer: Uint8Array) => Promise<{bytesWritten: number; buffer: Uint8Array}>;
}

function proxyHandle(handle: FileHandle, overrides: HandleOverrides): FileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      const override = overrides[property as keyof HandleOverrides];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function'
        ? (...arguments_: unknown[]): unknown => Reflect.apply(value, target, arguments_)
        : value;
    }
  });
}

function directorySyncFailure(directory: string, code: string): OpenHook {
  return async (path, flags, mode) => {
    const handle = await actualFs.open(path, flags, mode);
    if (resolve(String(path)) !== resolve(directory) || flags !== 'r') return handle;
    return proxyHandle(handle, {sync: () => Promise.reject(errno(code))});
  };
}

function fakeNonFileStats(): Stats {
  return {
    isFile: () => false,
    isSymbolicLink: () => false
  } as Stats;
}

function fakeFileStats(device: bigint, inode: bigint): BigIntStats {
  return {
    dev: device,
    ino: inode,
    isFile: () => true,
    isDirectory: () => false
  } as BigIntStats;
}

function makeZip(): Uint8Array {
  return zipSync({'project.json': Buffer.from('{"fixture":true}')}, {
    level: 0,
    mtime: new Date(1980, 0, 1)
  });
}

function withOneSidedZip64(input: Uint8Array, sentinel: 'compressed' | 'uncompressed'): Uint8Array {
  const original = Buffer.from(input);
  const localOffset = findSignature(original, 0x04034b50);
  const compressedSize = original.readUInt32LE(localOffset + 18);
  const uncompressedSize = original.readUInt32LE(localOffset + 22);
  const unknown = Buffer.from([0xfe, 0xca, 0x01, 0x00, 0x7f]);
  const zip64 = Buffer.alloc(12);
  zip64.writeUInt16LE(0x0001, 0);
  zip64.writeUInt16LE(8, 2);
  zip64.writeBigUInt64LE(BigInt(sentinel === 'compressed' ? compressedSize : uncompressedSize), 4);
  const extra = Buffer.concat([unknown, zip64]);
  const output = insertLocalExtra(original, extra);
  output.writeUInt32LE(0xffffffff, localOffset + (sentinel === 'compressed' ? 18 : 22));
  return output;
}

function withMalformedLocalExtra(input: Uint8Array): Uint8Array {
  const malformed = Buffer.alloc(4);
  malformed.writeUInt16LE(0xcafe, 0);
  malformed.writeUInt16LE(20, 2);
  const output = insertLocalExtra(Buffer.from(input), malformed);
  const localOffset = findSignature(output, 0x04034b50);
  output.writeUInt32LE(0xffffffff, localOffset + 18);
  output.writeUInt32LE(0xffffffff, localOffset + 22);
  return output;
}

function withExactDescriptorMetadata(input: Uint8Array): Uint8Array {
  const output = Buffer.from(input);
  const localOffset = findSignature(output, 0x04034b50);
  const centralOffset = findSignature(output, 0x02014b50);
  output.writeUInt16LE(output.readUInt16LE(localOffset + 6) | 0x0008, localOffset + 6);
  output.writeUInt16LE(output.readUInt16LE(centralOffset + 8) | 0x0008, centralOffset + 8);
  return output;
}

function insertLocalExtra(original: Buffer, extra: Buffer): Buffer {
  const localOffset = findSignature(original, 0x04034b50);
  const nameLength = original.readUInt16LE(localOffset + 26);
  const oldExtraLength = original.readUInt16LE(localOffset + 28);
  const insertionOffset = localOffset + 30 + nameLength + oldExtraLength;
  const centralOffset = findSignature(original, 0x02014b50);
  const output = Buffer.concat([original.subarray(0, insertionOffset), extra, original.subarray(insertionOffset)]);
  output.writeUInt16LE(oldExtraLength + extra.length, localOffset + 28);
  const endOffset = findSignature(output, 0x06054b50);
  output.writeUInt32LE(centralOffset + extra.length, endOffset + 16);
  return output;
}

function findSignature(buffer: Buffer, signature: number): number {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(signature);
  const offset = buffer.indexOf(marker);
  if (offset < 0) throw new Error(`ZIP signature ${signature.toString(16)} is missing`);
  return offset;
}

interface FakeEntry {
  compressedSize: number;
  compressionMethod: number;
  crc32: number;
  externalFileAttributes: number;
  fileName: Buffer;
  generalPurposeBitFlag: number;
  uncompressedSize: number;
  versionMadeBy: number;
  data: Buffer;
  isEncrypted(): boolean;
  streamFactory?: () => Readable;
}

class FakeZip extends EventEmitter {
  readonly entryCount: number;
  readonly entries: FakeEntry[];
  closed = false;
  readCalls = 0;
  readBehavior: ((zip: FakeZip) => void) | undefined;

  constructor(entries: FakeEntry[]) {
    super();
    this.entries = [...entries];
    this.entryCount = entries.length;
  }

  close(): void {
    this.closed = true;
  }

  readEntry(): void {
    this.readCalls += 1;
    if (this.readBehavior !== undefined) {
      this.readBehavior(this);
      return;
    }
    queueMicrotask(() => {
      const entry = this.entries.shift();
      if (entry === undefined) this.emit('end');
      else this.emit('entry', entry);
    });
  }

  readLocalFileHeader(
    entry: FakeEntry,
    _options: unknown,
    callback: (error: Error | null, value: Record<string, unknown>) => void
  ): void {
    callback(null, {
      generalPurposeBitFlag: entry.generalPurposeBitFlag,
      compressionMethod: entry.compressionMethod,
      crc32: entry.crc32,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      fileName: entry.fileName,
      extraField: Buffer.alloc(0)
    });
  }

  openReadStream(entry: FakeEntry, callback: (error: Error | null, stream?: Readable) => void): void {
    callback(null, entry.streamFactory?.() ?? Readable.from([entry.data]));
  }
}

function fakeEntry(name: string, data: Buffer, streamFactory?: () => Readable): FakeEntry {
  return {
    compressedSize: data.length,
    compressionMethod: 0,
    crc32: crc32(data),
    externalFileAttributes: 0,
    fileName: Buffer.from(name, 'ascii'),
    generalPurposeBitFlag: 0,
    uncompressedSize: data.length,
    versionMadeBy: 0,
    data,
    isEncrypted: () => false,
    ...(streamFactory === undefined ? {} : {streamFactory})
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalProject(): ScratchProject {
  return {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [],
      sounds: []
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: 'test', agent: 'test'}
  };
}

function memoryEntry(name: string, bytes: Uint8Array): ArchiveEntry {
  return {
    name,
    content: {kind: 'memory', data: bytes},
    contentHash: createHash('sha256').update(bytes).digest(),
    compressedSize: bytes.length,
    uncompressedSize: bytes.length
  };
}
