import {mkdtemp, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  commitOutput,
  prepareOutput,
  serializeProject,
  validateReferencedAssets,
  writeDeterministicArchive
} from '../src/archive/index.js';
import {FileSystemError, InputError, UsageError} from '../src/errors.js';
import type {ArchiveEntry, ScratchProject} from '../src/types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('asset descriptor validation', () => {
  it('accepts canonical fallback names in costumes and sounds', () => {
    const project = minimalProject();
    delete project.targets[0]?.costumes[0]?.['md5ext'];
    project.targets[0]?.sounds.push({assetId: 'sound', dataFormat: 'wav', name: 'sound'});
    expect(() => validateReferencedAssets(project, [archiveEntry('asset.svg', '<svg/>'), archiveEntry('sound.wav', 'wave')])).not.toThrow();
  });

  it('rejects malformed and inconsistent descriptors', () => {
    const malformed = minimalProject();
    const malformedCostume = malformed.targets[0]?.costumes[0];
    if (malformedCostume === undefined) throw new Error('fixture costume is missing');
    malformedCostume['assetId'] = 1;
    expect(() => validateReferencedAssets(malformed, [])).toThrowError(/invalid asset descriptor/);

    const mismatched = minimalProject();
    const mismatchedCostume = mismatched.targets[0]?.costumes[0];
    if (mismatchedCostume === undefined) throw new Error('fixture costume is missing');
    mismatchedCostume['md5ext'] = 'other.svg';
    expect(() => validateReferencedAssets(mismatched, [archiveEntry('other.svg', '<svg/>')])).toThrowError(/does not match assetId/);
  });
});

describe('project serialization and deterministic writer failures', () => {
  it('serializes each limit mode and rejects cycles or undefined roots', () => {
    const project = minimalProject();
    expect(Buffer.from(serializeProject(project, 'lossless')).toString()).toContain('"targets"');
    expect(serializeProject(project, 'no-preserve')).toBeInstanceOf(Uint8Array);

    const cyclic = minimalProject() as ScratchProject & {cycle?: unknown};
    cyclic.cycle = cyclic;
    expect(() => serializeProject(cyclic, 'lossy')).toThrowError(/cannot be serialized/);
    expect(() => serializeProject(undefined as unknown as ScratchProject, 'lossless')).toThrowError(/cannot be serialized/);
  });

  it('preserves negative zero and ordered container values', () => {
    const project = minimalProject();
    const target = project.targets[0];
    if (target === undefined) throw new Error('fixture target is missing');
    target.variables['negative'] = ['value', -0];
    target.lists['values'] = ['values', [-0, 0]];
    const parsed = JSON.parse(Buffer.from(serializeProject(project, 'lossless')).toString()) as ScratchProject;
    expect(Object.is(parsed.targets[0]?.variables['negative']?.[1], -0)).toBe(true);
    const listValues = parsed.targets[0]?.lists['values']?.[1] as unknown[];
    expect(Object.is(listValues[0], -0)).toBe(true);
    expect(Object.is(listValues[1], 0)).toBe(true);
  });

  it('enforces the transformed JSON size ceiling', () => {
    const oversized = minimalProject() as ScratchProject & {padding?: string};
    oversized.padding = 'x'.repeat(64 * 1024 * 1024);
    expect(() => serializeProject(oversized, 'lossless')).toThrowError(/limit is 67108864 bytes/);
  });

  it('writes empty and multi-chunk entries', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'large.sb3');
    const bytes = Buffer.allocUnsafe(2 * 1024 * 1024 + 17);
    let state = 0x12345678;
    for (let index = 0; index < bytes.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state >>> 24;
    }
    const projectBytes = serializeProject(minimalProject(), 'lossless');
    await writeDeterministicArchive(output, projectBytes, [
      archiveEntry('project.json', projectBytes),
      archiveEntry('empty.bin', new Uint8Array(0)),
      archiveEntry('large.bin', bytes)
    ]);
    expect((await readFile(output)).length).toBeGreaterThan(1024 * 1024);
  });

  it('streams file-backed assets and rejects size or digest changes', async () => {
    const directory = await temporaryDirectory();
    const projectBytes = serializeProject(minimalProject(), 'lossless');
    const projectEntry = archiveEntry('project.json', projectBytes);
    const assetPath = join(directory, 'asset.bin');
    await writeFile(assetPath, 'abc');
    const fileEntry = (size: number, hash: Uint8Array): ArchiveEntry => ({
      name: 'asset.bin',
      content: {kind: 'file', path: assetPath},
      contentHash: hash,
      compressedSize: 3,
      uncompressedSize: size
    });

    await writeDeterministicArchive(join(directory, 'file-backed.sb3'), projectBytes, [
      projectEntry,
      fileEntry(3, createHash('sha256').update('abc').digest())
    ]);
    await expect(writeDeterministicArchive(join(directory, 'too-large.sb3'), projectBytes, [
      projectEntry,
      fileEntry(1, createHash('sha256').update('a').digest())
    ])).rejects.toThrowError(/changed while writing/);
    await expect(writeDeterministicArchive(join(directory, 'wrong-hash.sb3'), projectBytes, [
      projectEntry,
      fileEntry(3, createHash('sha256').update('abd').digest())
    ])).rejects.toThrowError(/changed while writing/);

    await writeFile(assetPath, Buffer.alloc(8 * 1024 * 1024, 7));
    const controller = new AbortController();
    const writing = writeDeterministicArchive(join(directory, 'file-aborted.sb3'), projectBytes, [
      projectEntry,
      fileEntry(8 * 1024 * 1024, createHash('sha256').update(Buffer.alloc(8 * 1024 * 1024, 7)).digest())
    ], controller.signal);
    setTimeout(() => controller.abort(new Error('stop file stream')), 0);
    await expect(writing).rejects.toThrowError(/interrupted/);
  });

  it('rejects missing/duplicate project entries, interruption, existing files, and invalid names', async () => {
    const directory = await temporaryDirectory();
    const projectBytes = serializeProject(minimalProject(), 'lossless');
    await expect(writeDeterministicArchive(join(directory, 'missing.sb3'), projectBytes, [])).rejects.toBeInstanceOf(InputError);
    await expect(writeDeterministicArchive(join(directory, 'duplicate.sb3'), projectBytes, [
      archiveEntry('project.json', projectBytes),
      archiveEntry('project.json', projectBytes)
    ])).rejects.toBeInstanceOf(InputError);

    const abortController = new AbortController();
    abortController.abort('stop');
    await expect(writeDeterministicArchive(join(directory, 'aborted.sb3'), projectBytes, [archiveEntry('project.json', projectBytes)], abortController.signal)).rejects.toThrowError(/interrupted/);
    const errorAbortController = new AbortController();
    errorAbortController.abort(new Error('stop'));
    await expect(writeDeterministicArchive(join(directory, 'error-aborted.sb3'), projectBytes, [archiveEntry('project.json', projectBytes)], errorAbortController.signal)).rejects.toThrowError(/interrupted/);

    const existing = join(directory, 'existing.sb3');
    await writeFile(existing, 'old');
    await expect(writeDeterministicArchive(existing, projectBytes, [archiveEntry('project.json', projectBytes)])).rejects.toBeInstanceOf(FileSystemError);

    const invalidName = 'x'.repeat(65_536);
    await expect(writeDeterministicArchive(join(directory, 'bad-name.sb3'), projectBytes, [
      archiveEntry('project.json', projectBytes),
      archiveEntry(invalidName, 'x')
    ])).rejects.toBeInstanceOf(FileSystemError);
  });
});

describe('output preparation edge cases', () => {
  it('rejects bad input paths, directories, same paths, output directories, and absent parents', async () => {
    const directory = await temporaryDirectory();
    await expect(prepareOutput(join(directory, 'input.txt'), undefined, false)).rejects.toBeInstanceOf(InputError);
    await expect(prepareOutput(join(directory, 'missing.sb3'), undefined, false)).rejects.toBeInstanceOf(FileSystemError);
    const inputDirectory = join(directory, 'directory.sb3');
    await writeFile(join(directory, 'source.sb3'), 'source');
    await import('node:fs/promises').then(module => module.mkdir(inputDirectory));
    await expect(prepareOutput(inputDirectory, undefined, false)).rejects.toThrowError(/not a regular file/);
    const input = join(directory, 'source.sb3');
    await expect(prepareOutput(input, input, true)).rejects.toBeInstanceOf(UsageError);
    const outputDirectory = join(directory, 'output.sb3');
    await import('node:fs/promises').then(module => module.mkdir(outputDirectory));
    await expect(prepareOutput(input, outputDirectory, true)).rejects.toThrowError(/output path is a directory/);
    await expect(prepareOutput(input, join(directory, 'absent', 'output.sb3'), false)).rejects.toThrowError(/cannot access output directory/);
  });

  it('reports existing and new output state', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await writeFile(input, 'source');
    expect((await prepareOutput(input, output, false)).outputExists).toBe(false);
    await writeFile(output, 'old');
    expect((await prepareOutput(input, output, true)).outputExists).toBe(true);
  });
});

describe('output commit transactions', () => {
  it('successfully replaces existing and non-existing outputs with force', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await commitOutput(output, true, path => writeFile(path, 'first'), () => Promise.resolve());
    expect(await readFile(output, 'utf8')).toBe('first');
    await commitOutput(output, true, path => writeFile(path, 'second'), () => Promise.resolve());
    expect(await readFile(output, 'utf8')).toBe('second');
  });

  it('rejects a no-force creation race and preserves the competing file', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await expect(commitOutput(output, false, async path => {
      await writeFile(path, 'temporary');
      await writeFile(output, 'racer');
    }, () => Promise.resolve())).rejects.toBeInstanceOf(UsageError);
    expect(await readFile(output, 'utf8')).toBe('racer');
  });

  it('restores the previous output when the final rename fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await writeFile(output, 'old');
    await expect(commitOutput(output, true, path => writeFile(path, 'new'), path => unlink(path))).rejects.toBeInstanceOf(FileSystemError);
    expect(await readFile(output, 'utf8')).toBe('old');
  });

  it('reports a final rename failure when no previous output exists', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await expect(commitOutput(output, true, path => writeFile(path, 'new'), path => unlink(path))).rejects.toBeInstanceOf(FileSystemError);
    await expect(readFile(output)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('wraps non-Error callback failures and non-EEXIST link failures', async () => {
    const directory = await temporaryDirectory();
    await expect(commitOutput(join(directory, 'empty-error.sb3'), false, () => Promise.reject(new Error()), () => Promise.resolve())).rejects.toThrowError(/cannot commit output file/);
    const output = join(directory, 'directory-link.sb3');
    await expect(commitOutput(output, false, path => import('node:fs/promises').then(module => module.mkdir(path)), () => Promise.resolve())).rejects.toThrow();
  });

  it('handles callback failures and interruption without publishing output', async () => {
    const directory = await temporaryDirectory();
    const rawFailure = join(directory, 'raw.sb3');
    await expect(commitOutput(rawFailure, false, () => Promise.reject(new Error('write failed')), () => Promise.resolve())).rejects.toBeInstanceOf(FileSystemError);
    const typedFailure = join(directory, 'typed.sb3');
    await expect(commitOutput(typedFailure, false, () => Promise.reject(new FileSystemError('typed failure')), () => Promise.resolve())).rejects.toThrowError(/typed failure/);

    const controller = new AbortController();
    const writer = vi.fn((path: string) => writeFile(path, 'data'));
    controller.abort(new Error('cancel'));
    await expect(commitOutput(join(directory, 'aborted.sb3'), false, writer, () => Promise.resolve(), controller.signal)).rejects.toThrowError(/interrupted/);
    expect(writer).not.toHaveBeenCalled();

    const duringVerify = new AbortController();
    const output = join(directory, 'verify-abort.sb3');
    await expect(commitOutput(output, false, path => writeFile(path, 'data'), () => {
      duringVerify.abort('cancel');
      return Promise.resolve();
    }, duringVerify.signal)).rejects.toThrowError(/interrupted/);
    await expect(readFile(output)).rejects.toMatchObject({code: 'ENOENT'});
    expect((await readdir(directory)).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('recovers interrupted force transactions before preparing output', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    const journal = join(directory, '.output.sb3.scratch-obfuscator.transaction');
    const temporaryName = '.output.sb3.tmp-0123456789abcdef01234567';
    const temporary = join(directory, temporaryName);
    await writeFile(input, 'input');
    await writeFile(backup, 'old');
    await writeFile(temporary, 'pending');
    await writeFile(journal, JSON.stringify({version: 1, output: 'output.sb3', temporary: temporaryName, pid: process.pid}));

    expect((await prepareOutput(input, output, true)).outputExists).toBe(true);
    expect(await readFile(output, 'utf8')).toBe('old');
    expect((await readdir(directory)).sort()).toEqual(['input.sb3', 'output.sb3']);

    await writeFile(backup, 'older');
    await writeFile(output, 'newer');
    await writeFile(temporary, 'pending');
    await writeFile(journal, JSON.stringify({version: 1, output: 'output.sb3', temporary: temporaryName, pid: process.pid}));
    expect((await prepareOutput(input, output, true)).outputExists).toBe(true);
    expect(await readFile(output, 'utf8')).toBe('newer');
    expect((await readdir(directory)).sort()).toEqual(['input.sb3', 'output.sb3']);
  });

  it('rejects orphaned and raced backup paths without overwriting them', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    await writeFile(input, 'input');
    await writeFile(backup, 'orphan');
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/orphaned output backup/);
    await unlink(backup);

    await expect(commitOutput(output, true, path => writeFile(path, 'new'), async () => {
      await writeFile(backup, 'racer');
    })).rejects.toThrowError(/reserved backup path/);
    expect(await readFile(backup, 'utf8')).toBe('racer');
    await unlink(backup);
  });

  it('handles corrupt, incomplete, active, and stale transaction journals', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const backup = join(directory, '.output.sb3.scratch-obfuscator.backup');
    const journal = join(directory, '.output.sb3.scratch-obfuscator.transaction');
    const temporaryName = '.output.sb3.tmp-fedcba9876543210fedcba98';
    const marker = (pid: number): string => JSON.stringify({version: 1, output: 'output.sb3', temporary: temporaryName, pid});
    await writeFile(input, 'input');

    await writeFile(journal, '{');
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/invalid transaction marker/);
    await expect(readFile(journal)).rejects.toMatchObject({code: 'ENOENT'});

    await writeFile(backup, 'old');
    await writeFile(journal, JSON.stringify({version: 2}));
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/invalid transaction marker/);
    expect(await readFile(output, 'utf8')).toBe('old');
    await unlink(output);

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    if (child.pid === undefined) throw new Error('child process has no pid');
    await writeFile(journal, marker(child.pid));
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/another process is committing/);
    child.kill();
    await new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
    expect((await prepareOutput(input, output, true)).outputExists).toBe(false);
    await expect(readFile(journal)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects overlapping in-process transactions and preparation', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await writeFile(input, 'input');
    let releaseWriter: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const started = new Promise<void>(resolvePromise => {
      reportStarted = resolvePromise;
    });
    const release = new Promise<void>(resolvePromise => {
      releaseWriter = resolvePromise;
    });
    const first = commitOutput(output, false, async path => {
      await writeFile(path, 'first');
      reportStarted?.();
      await release;
    }, () => Promise.resolve());
    await started;
    await expect(commitOutput(output, false, path => writeFile(path, 'second'), () => Promise.resolve())).rejects.toThrowError(/transaction is active/);
    await expect(prepareOutput(input, output, true)).rejects.toThrowError(/transaction is active/);
    releaseWriter?.();
    await first;
  });
});

function archiveEntry(name: string, data: string | Uint8Array): ArchiveEntry {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return {
    name,
    content: {kind: 'memory', data: bytes},
    contentHash: createHash('sha256').update(bytes).digest(),
    compressedSize: bytes.length,
    uncompressedSize: bytes.length
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-output-'));
  directories.push(directory);
  return directory;
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
      costumes: [{assetId: 'asset', name: 'backdrop1', dataFormat: 'svg', md5ext: 'asset.svg'}],
      sounds: []
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: 'test', agent: ''}
  };
}
