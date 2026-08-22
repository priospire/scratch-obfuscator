import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {UsageError} from '../src/errors.js';
import {deriveArchiveSeed} from '../src/archive/seed.js';
import type {
  ArchiveEntry,
  LoadedArchive,
  ObfuscationResult,
  ObfuscationStats,
  ScratchProject
} from '../src/types.js';
import {createFixtureProject} from './support.js';

type CommitWriter = (temporaryPath: string) => Promise<void>;
type CommitVerifier = (temporaryPath: string) => Promise<void>;

interface ObfuscationExports {
  obfuscateProject(
    project: ScratchProject,
    mode: 'lossless' | 'lossy' | 'no-preserve',
    seed: Uint8Array,
    options?: {antiCheat?: boolean}
  ): ObfuscationResult;
}

const archiveMocks = vi.hoisted(() => ({
  commitOutput: vi.fn<(
    outputPath: string,
    force: boolean,
    writeTemporary: CommitWriter,
    verifyTemporary: CommitVerifier,
    signal?: AbortSignal
  ) => Promise<void>>(),
  loadArchive: vi.fn<(path: string, limits: unknown, signal?: AbortSignal) => Promise<LoadedArchive>>(),
  prepareOutput: vi.fn<(input: string, output: string | undefined, force: boolean) => Promise<{
    inputPath: string;
    outputPath: string;
    outputExists: boolean;
  }>>(),
  serializeProject: vi.fn<(project: ScratchProject, mode: string) => Uint8Array>(),
  validateReferencedAssets: vi.fn<(project: ScratchProject, entries: readonly ArchiveEntry[]) => void>(),
  writeDeterministicArchive: vi.fn<(
    path: string,
    projectBytes: Uint8Array,
    entries: readonly ArchiveEntry[],
    signal?: AbortSignal
  ) => Promise<void>>()
}));

const obfuscationMocks = vi.hoisted(() => ({
  obfuscateProject: vi.fn<(
    project: ScratchProject,
    mode: 'lossless' | 'lossy' | 'no-preserve',
    seed: Uint8Array,
    options?: {antiCheat?: boolean}
  ) => ObfuscationResult>()
}));

vi.mock('../src/archive/index.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commitOutput: archiveMocks.commitOutput,
  loadArchive: archiveMocks.loadArchive,
  prepareOutput: archiveMocks.prepareOutput,
  serializeProject: archiveMocks.serializeProject,
  validateReferencedAssets: archiveMocks.validateReferencedAssets,
  writeDeterministicArchive: archiveMocks.writeDeterministicArchive
}));

vi.mock('../src/obfuscation/index.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  obfuscateProject: obfuscationMocks.obfuscateProject
}));

const actualObfuscation = await vi.importActual<ObfuscationExports>(
  '../src/obfuscation/index.js'
);
const {parseCliArguments, runCli} = await import('../src/cli.js');

const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;

beforeEach(() => {
  for (const mock of Object.values(archiveMocks)) mock.mockReset();
  obfuscationMocks.obfuscateProject.mockReset();
  archiveMocks.prepareOutput.mockResolvedValue({
    inputPath: resolve('input.sb3'),
    outputPath: resolve('output.sb3'),
    outputExists: false
  });
  archiveMocks.commitOutput.mockImplementation(async (_output, _force, writeTemporary, verifyTemporary) => {
    await writeTemporary(resolve('temporary.sb3'));
    await verifyTemporary(resolve('temporary.sb3'));
  });
  archiveMocks.serializeProject.mockReturnValue(Buffer.from('{}'));
  archiveMocks.validateReferencedAssets.mockReturnValue(undefined);
  archiveMocks.writeDeterministicArchive.mockResolvedValue(undefined);
  obfuscationMocks.obfuscateProject.mockImplementation((project, mode, seed, options) => (
    actualObfuscation.obfuscateProject(project, mode, seed, options)
  ));
});

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArguments);
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('core defensive contracts', () => {
  it('rejects invalid archive digest widths before deriving a deterministic seed', () => {
    const entry = archiveEntry('asset.bin', Buffer.from('asset'));
    const malformed: ArchiveEntry = {...entry, contentHash: new Uint8Array(31)};
    expect(() => deriveArchiveSeed(Buffer.from('{}'), [malformed]))
      .toThrowError(/content hash for "asset\.bin" must be 32 bytes/u);
  });

  it('emits a plural warning when two stale invisible monitors are removed', () => {
    const project = createFixtureProject();
    project.monitors.push(staleMonitor('first'), staleMonitor('second'));
    const result = actualObfuscation.obfuscateProject(project, 'lossless', new Uint8Array(32));
    expect(result.stats.warnings).toContain(
      'Removed 2 stale invisible data monitors for a missing sprite.'
    );
    expect(result.project.monitors.some(monitor => monitor['spriteName'] === 'Missing Sprite')).toBe(false);
  });
});

describe('CLI verification and diagnostics', () => {
  it('rejects a repeated short output option and formats a non-Error commit rejection', async () => {
    expect(() => parseCliArguments(['input.sb3', '-o', 'first.sb3', '-o', 'second.sb3']))
      .toThrowError(UsageError);

    const project = createFixtureProject();
    archiveMocks.loadArchive.mockResolvedValueOnce(loadedArchive(project, [
      archiveEntry('project.json', Buffer.from('{}'))
    ]));
    obfuscationMocks.obfuscateProject.mockReturnValue({project, stats: baseStats()});
    archiveMocks.commitOutput.mockRejectedValue('closed commit channel');
    const diagnostics: string[] = [];
    const code = await runCli(['input.sb3', '-o', 'output.sb3'], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    });
    expect(code).toBe(5);
    expect(diagnostics.join('')).toContain('unexpected failure: closed commit channel');
  });

  it('sorts multiple assets during verification and reports absent optional counters as zero', async () => {
    const project = createFixtureProject();
    const source = loadedArchive(project, [
      archiveEntry('project.json', Buffer.from('{}')),
      archiveEntry('z-last.bin', Buffer.from('z')),
      archiveEntry('a-first.bin', Buffer.from('a'))
    ]);
    const reopened = loadedArchive(project, [
      archiveEntry('a-first.bin', Buffer.from('a')),
      archiveEntry('project.json', Buffer.from('{}')),
      archiveEntry('z-last.bin', Buffer.from('z'))
    ]);
    archiveMocks.loadArchive.mockResolvedValueOnce(source).mockResolvedValueOnce(reopened);
    obfuscationMocks.obfuscateProject.mockReturnValue({project, stats: baseStats()});
    const output: string[] = [];

    expect(await runCli(['input.sb3', '-o', 'output.sb3'], {
      stdout: text => output.push(text),
      stderr: () => undefined
    })).toBe(0);
    expect(output.join('')).toContain('packed=0, folded=0, fallbacks=0');
    expect(source.cleanup.mock.calls).toHaveLength(1);
    expect(reopened.cleanup.mock.calls).toHaveLength(1);
  });

  it('rejects an output whose verified archive loses an asset', async () => {
    const project = createFixtureProject();
    const source = loadedArchive(project, [
      archiveEntry('project.json', Buffer.from('{}')),
      archiveEntry('asset.bin', Buffer.from('original'))
    ]);
    const reopened = loadedArchive(project, [archiveEntry('project.json', Buffer.from('{}'))]);
    archiveMocks.loadArchive.mockResolvedValueOnce(source).mockResolvedValueOnce(reopened);
    obfuscationMocks.obfuscateProject.mockReturnValue({project, stats: baseStats()});
    const diagnostics: string[] = [];

    expect(await runCli(['input.sb3', '-o', 'output.sb3'], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    })).toBe(4);
    expect(diagnostics.join('')).toContain('archive entry count changed');
    expect(source.cleanup.mock.calls).toHaveLength(1);
    expect(reopened.cleanup.mock.calls).toHaveLength(1);
  });

  it('rejects an output whose verified asset digest changes', async () => {
    const project = createFixtureProject();
    const source = loadedArchive(project, [
      archiveEntry('project.json', Buffer.from('{}')),
      archiveEntry('asset.bin', Buffer.from('original'))
    ]);
    const reopened = loadedArchive(project, [
      archiveEntry('project.json', Buffer.from('{}')),
      archiveEntry('asset.bin', Buffer.from('tampered'))
    ]);
    archiveMocks.loadArchive.mockResolvedValueOnce(source).mockResolvedValueOnce(reopened);
    obfuscationMocks.obfuscateProject.mockReturnValue({project, stats: baseStats()});
    const diagnostics: string[] = [];

    expect(await runCli(['input.sb3', '-o', 'output.sb3'], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    })).toBe(4);
    expect(diagnostics.join('')).toContain('asset "asset.bin" was not preserved');
  });

  it('routes an actual SIGINT through the executable handler and removes both listeners', async () => {
    const initialInterruptListeners = process.listenerCount('SIGINT');
    const initialTerminateListeners = process.listenerCount('SIGTERM');
    const modulePath = resolve('src', 'cli.ts');
    process.argv.splice(0, process.argv.length, process.execPath, modulePath, 'input.sb3');
    process.exitCode = undefined;
    archiveMocks.loadArchive.mockImplementation((_path, _limits, signal) => new Promise((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error('missing CLI abort signal'));
        return;
      }
      signal.addEventListener('abort', () => {
        const error = new Error('interrupted archive load') as NodeJS.ErrnoException;
        error.code = 'EINTR';
        reject(error);
      }, {once: true});
    }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();

    await import('../src/cli.js');
    await vi.waitFor(() => expect(archiveMocks.loadArchive).toHaveBeenCalledOnce());
    process.emit('SIGINT');
    await vi.waitFor(() => expect(process.exitCode).toBe(4));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('interrupted archive load'));
    expect(process.listenerCount('SIGINT')).toBe(initialInterruptListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialTerminateListeners);
  });

  it('does not run main for a different entry path under the opposite platform comparison', async () => {
    const simulatedPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    vi.spyOn(process, 'platform', 'get').mockReturnValue(simulatedPlatform);
    process.argv.splice(0, process.argv.length, process.execPath, resolve('package.json'), '--version');
    process.exitCode = 37;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.resetModules();

    await import('../src/cli.js');
    await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
    expect(process.exitCode).toBe(37);
    expect(stdout).not.toHaveBeenCalled();
  });
});

function loadedArchive(project: ScratchProject, entries: readonly ArchiveEntry[]): LoadedArchive & {
  cleanup: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    projectBytes: Buffer.from('{}'),
    project,
    entries,
    seed: new Uint8Array(32),
    cleanup: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };
}

function archiveEntry(name: string, bytes: Uint8Array): ArchiveEntry {
  return {
    name,
    content: {kind: 'memory', data: bytes},
    contentHash: createHash('sha256').update(bytes).digest(),
    compressedSize: bytes.length,
    uncompressedSize: bytes.length
  };
}

function baseStats(): ObfuscationStats {
  return {
    mode: 'lossless',
    blocksBefore: 0,
    blocksAfter: 0,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function staleMonitor(id: string): ScratchProject['monitors'][number] {
  return {
    id,
    opcode: 'data_variable',
    params: {VARIABLE: 'obsolete'},
    spriteName: 'Missing Sprite',
    value: 0,
    visible: false,
    mode: 'default',
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}
