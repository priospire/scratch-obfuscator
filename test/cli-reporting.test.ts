import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  CliProgressReporter,
  cliCaveats,
  formatReleaseTestCoverage,
  formatSuccessSummary,
  formatVerboseReport,
  type CliExecutionMetrics,
  type CliVerbosity
} from '../src/cli-reporting.js';
import {parseCliArguments, runCli} from '../src/cli.js';
import {UsageError} from '../src/errors.js';
import {RELEASE_TEST_COVERAGE} from '../src/release-coverage.js';
import type {ObfuscationStats} from '../src/types.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

const temporaryDirectories: string[] = [];

interface CoverageReportingModule {
  formatReleaseTestCoverage(): string;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('CLI verbosity contract', () => {
  it('accepts the documented verbose spellings and optional max value', () => {
    expect(parseCliArguments(['input.sb3', '-verbose'])).toMatchObject({verbosity: 'verbose'});
    expect(parseCliArguments(['input.sb3', '--verbose'])).toMatchObject({verbosity: 'verbose'});
    expect(parseCliArguments(['input.sb3', '-verbose=max'])).toMatchObject({verbosity: 'max'});
    expect(parseCliArguments(['input.sb3', '--verbose=max'])).toMatchObject({verbosity: 'max'});
    expect(parseCliArguments(['input.sb3', '--verbose', 'max'])).toMatchObject({verbosity: 'max'});
    expect(parseCliArguments(['input.sb3', '--verbose=max', '--verbose'])).toMatchObject({verbosity: 'max'});
  });

  it('consumes only the exact optional value and rejects assigned alternatives', () => {
    expect(parseCliArguments(['--verbose', '--', 'maximum.sb3'])).toMatchObject({
      input: 'maximum.sb3',
      verbosity: 'verbose'
    });
    expect(() => parseCliArguments(['input.sb3', '--verbose=full'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '-verbose='])).toThrow(UsageError);
    expect(() => parseCliArguments(['--verbose', 'maximum', 'input.sb3'])).toThrow(UsageError);
  });
});

describe('CLI progress reporting', () => {
  it('writes deterministic ten-percent bars by default when output is captured', () => {
    const output: string[] = [];
    const reporter = progressReporter(output, false, 'normal');
    reporter.update(0, 'Preparing');
    reporter.update(0, 'Preparing');
    for (let percent = 9; percent < 100; percent += 10) {
      reporter.update(percent / 100, `Stage ${percent}`);
    }
    reporter.update(0.20, 'Regressive update');
    reporter.complete();

    const lines = output.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.map(line => Number(/\s(\d+)%/u.exec(line)?.[1]))).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    ]);
    expect(lines.every(line => /^progress: .+ \s?\d+% \[[#-]{24}\]$/u.test(line))).toBe(true);
  });

  it('leads verbose lines with the stage and reserves every event for max', () => {
    const verboseOutput: string[] = [];
    const verbose = progressReporter(verboseOutput, false, 'verbose');
    verbose.update(0.51, 'Virtualizing lists - packed storage');
    verbose.update(0.52, 'Virtualizing lists - packed storage');
    verbose.update(1, 'Virtualizing lists - packed storage');
    expect(verboseOutput.join('')).toMatch(/^progress: Virtualizing lists - packed storage\s+51%/u);
    expect(verboseOutput).toHaveLength(2);

    const maxOutput: string[] = [];
    const max = progressReporter(maxOutput, false, 'max');
    const detailedLabel = `Virtualizing lists - ${'packedLists=2;'.repeat(12)}`;
    max.update(0.51, detailedLabel);
    max.update(0.52, detailedLabel);
    expect(maxOutput).toHaveLength(2);
    expect(maxOutput.join('')).toContain(detailedLabel);

    const interactiveMaxOutput: string[] = [];
    const interactiveMax = progressReporter(interactiveMaxOutput, true, 'max');
    interactiveMax.update(0.51, 'Virtualizing lists');
    interactiveMax.update(0.52, 'Virtualizing lists');
    interactiveMax.complete();
    expect(interactiveMaxOutput.join('')).not.toContain('\r');
    expect(interactiveMaxOutput).toHaveLength(3);
  });

  it('uses one rewritable interactive line, sanitizes controls, and closes it', () => {
    const output: string[] = [];
    const reporter = progressReporter(output, true, 'normal');
    reporter.update(Number.NaN, 'Preparing\r\nspoofed');
    reporter.update(0.5, 'Working');
    reporter.stop();
    reporter.stop();

    expect(output.join('')).toContain('\rPreparing spoofed   0%');
    expect(output.join('')).not.toContain('\r\nspoofed');
    expect(output.at(-1)).toBe('\n');
    expect(output.filter(part => part === '\n')).toHaveLength(1);
  });

  it('clamps completion, substitutes an empty label, and closes an interactive completion exactly once', () => {
    const captured: string[] = [];
    const capturedReporter = progressReporter(captured, false, 'normal');
    capturedReporter.update(-4, '\r\n');
    capturedReporter.update(4, 'Past the end');
    expect(captured[0]).toContain('Working   0%');
    expect(captured.at(-1)).toContain('Past the end 100%');

    const interactive: string[] = [];
    const interactiveReporter = progressReporter(interactive, true, 'normal');
    interactiveReporter.update(0.2, 'A deliberately longer first status');
    interactiveReporter.update(0.3, 'Short');
    interactiveReporter.complete();
    interactiveReporter.complete();
    expect(interactive.filter(part => part === '\n')).toHaveLength(1);
    expect(interactive.join('')).toContain('\rComplete 100%');
  });
});

describe('CLI completion reporting', () => {
  it('includes exact release test coverage and its scope disclaimer in every summary', () => {
    const summary = formatSuccessSummary('input.sb3', 'output.sb3', 'lossless', false, stats());
    expect(summary).toContain('Obfuscation completed: 100%');
    for (const [name, metric] of Object.entries(RELEASE_TEST_COVERAGE).filter(([, value]) => typeof value === 'object')) {
      const coverage = metric as {covered: number; total: number; percentage: number; allCovered: boolean};
      expect(summary).toContain(
        `${name}=${coverage.percentage.toFixed(2)}% (${coverage.covered}/${coverage.total}, ${coverage.allCovered ? 'all' : 'not-all'})`
      );
    }
    expect(summary).toContain('100%-covered categories=functions');
    expect(summary).toContain('all-categories-100%=no');
    expect(summary).toContain('Test coverage does not guarantee correctness.');
    expect(formatReleaseTestCoverage()).toContain(`release test coverage (v${RELEASE_TEST_COVERAGE.version})`);

    const protectedSummary = formatSuccessSummary(
      'input.sb3',
      'output.sb3',
      'lossless',
      true,
      stats({caveats: ['first', 'second']})
    );
    expect(protectedSummary).toContain('anticheat=on');
    expect(protectedSummary).toContain('allowsize=off');
    expect(protectedSummary).toContain('caveats=2');
    expect(formatSuccessSummary('in.sb3', 'out.sb3', 'lossy', false, stats(), 7)).toContain('caveats=7');
    expect(formatSuccessSummary('in.sb3', 'out.sb3', 'lossy', false, stats(), 1, false, true))
      .toContain('allowsize=on');
    expect(formatSuccessSummary('in.sb3', 'out.sb3', 'lossy', false, statsWithoutOptionalCounters())).toContain(
      'packed=0, folded=0, fallbacks=0, comments=0, packed-lists=0'
    );
  });

  it('labels transformation activity separately and keeps zero-block ratios finite', () => {
    const report = formatVerboseReport(stats({blocksBefore: 0, blocksAfter: 2, virtualizedBlocks: 2}), metrics(), 'max');
    expect(report).toContain('transform activity, not test coverage');
    expect(report).toContain('growth=n/a');
    expect(report).not.toContain('+inf');
    expect(formatVerboseReport(stats(), metrics(), 'normal')).toBe('');
  });

  it('reports verifier evidence and absent optional counters without overstating them', () => {
    const verified = formatVerboseReport(stats({
      verification: {
        scope: 'static-project-structure',
        verdict: 'verified-with-caveats',
        provenInvariants: 12,
        attributedPasses: 4,
        caveats: 2
      }
    }), metrics(), 'verbose');
    expect(verified).toContain(
      'verification: static=verified-with-caveats, proven-invariants=12, attributed-passes=4, scope=static-project-structure'
    );
    expect(verified).not.toContain('max-detail:');

    const withoutOptionalCounters = statsWithoutOptionalCounters();
    const max = formatVerboseReport(withoutOptionalCounters, metrics(), 'max');
    expect(max).toContain('block-delta=-1, growth=-25.00%');
    expect(max).toContain('variables-packed=0, lists-packed=0, constants-folded=0');
    expect(max).toContain('static-verifier-caveats=0, attributed-passes=0');
  });

  it('reports applicable mode, anti-cheat, and progress caveats at normal verbosity', () => {
    expect(cliCaveats('lossless', false)).toEqual(expect.arrayContaining([
      expect.stringContaining('executable opcode topology'),
      expect.stringContaining('operation completion')
    ]));
    expect(cliCaveats('lossy', false)).toEqual(expect.arrayContaining([
      expect.stringContaining('statically certified')
    ]));
    expect(cliCaveats('no-preserve', true)).toEqual(expect.arrayContaining([
      expect.stringContaining('intentionally waives timing'),
      expect.stringContaining('local tamper response')
    ]));
    const protectedLossless = cliCaveats('lossless', true);
    expect(protectedLossless).toEqual(expect.arrayContaining([
      expect.stringContaining('before anti-cheat instrumentation'),
      expect.stringContaining('intentionally adds executable guard topology')
    ]));
    expect(protectedLossless).not.toContain(
      'lossless preserves executable opcode topology; comments and workspace layout are intentionally not preserved.'
    );
    expect(cliCaveats('lossy', false, false, true)).toEqual(expect.arrayContaining([
      expect.stringContaining('expanded bounded block and file-size growth')
    ]));
    expect(cliCaveats('lossless', false, false, true)).toEqual(expect.arrayContaining([
      expect.stringContaining('does not change lossless executable growth limits')
    ]));
  });

  it('keeps the verifier topology caveat visible for lossless anti-cheat output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-anticheat-reporting-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    await writeFile(input, createFixtureArchive(createFixtureProject()));
    const captured = capture();

    expect(await runCli([
      input,
      '-lossless',
      '-anticheat',
      '-o',
      join(directory, 'output.sb3')
    ], captured.io), captured.stderr.join('')).toBe(0);
    expect(captured.stderr.join('')).toContain(
      'code=anti-cheat-topology-additions-prevent-end-to-end-lossless-isomorphism'
    );
    expect(captured.stderr.join('')).toContain('intentionally adds executable guard topology');
  });

  it('keeps max-mode progress and final reports deterministic across output directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-reporting-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    const firstDirectory = join(directory, 'first');
    const secondDirectory = join(directory, 'second');
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    const fixture = createFixtureProject();
    fixture.monitors.push({
      id: 'stale-local-variable',
      mode: 'default',
      opcode: 'data_variable',
      params: {VARIABLE: 'Readable stale variable'},
      spriteName: 'Deleted sprite',
      value: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      visible: false
    });
    await writeFile(input, createFixtureArchive(fixture));

    const first = capture();
    const second = capture();
    expect(await runCli([input, '-verbose', 'max', '-o', join(firstDirectory, 'result.sb3')], first.io), first.stderr.join('')).toBe(0);
    expect(await runCli([input, '--verbose=max', '-o', join(secondDirectory, 'result.sb3')], second.io), second.stderr.join('')).toBe(0);

    expect(await readFile(join(firstDirectory, 'result.sb3'))).toEqual(await readFile(join(secondDirectory, 'result.sb3')));
    expect(first.stdout.join('')).toBe(second.stdout.join(''));
    expect(first.stderr.join('')).toBe(second.stderr.join(''));
    expect(first.stderr.join('')).toMatch(/progress: Renaming identifiers.+\d+%/u);
    expect(first.stderr.join('')).toContain(
      'Renaming identifiers - identifier and display-name remapping complete - commentsRemoved='
    );
    expect(first.stderr.join('')).not.toContain('\r');
    expect(first.stdout.join('')).toContain('release test coverage');
    expect(first.stdout.join('')).toContain('max-detail:');
    const warningCount = Number(/warnings=(\d+)/u.exec(first.stdout.join(''))?.[1]);
    const caveatCount = Number(/caveats=(\d+)/u.exec(first.stdout.join(''))?.[1]);
    const warningLines = first.stderr.join('').split('\n').filter(line => line.startsWith('warning: '));
    const caveatLines = first.stderr.join('').split('\n').filter(line => line.startsWith('caveat: '));
    expect(warningCount).toBe(warningLines.length);
    expect(caveatCount).toBe(new Set(caveatLines).size);
    expect(warningLines).toEqual([
      'warning: Removed 1 stale invisible data monitor for a missing sprite.'
    ]);
  });

  it('formats valid release snapshots with no or all categories at 100%', async () => {
    try {
      const none = await reportingWithCoverage(false);
      expect(none.formatReleaseTestCoverage()).toContain('100%-covered categories=none; all-categories-100%=no');

      const all = await reportingWithCoverage(true);
      expect(all.formatReleaseTestCoverage()).toContain(
        '100%-covered categories=statements,branches,functions,lines; all-categories-100%=yes'
      );
    } finally {
      vi.doUnmock('../src/release-coverage.js');
      vi.resetModules();
    }
  });
});

function progressReporter(output: string[], interactive: boolean, verbosity: CliVerbosity): CliProgressReporter {
  return new CliProgressReporter({stderr: text => output.push(text), interactive, verbosity});
}

function stats(overrides: Partial<ObfuscationStats> = {}): ObfuscationStats {
  return {
    mode: 'lossless',
    blocksBefore: 10,
    blocksAfter: 10,
    identifiersRenamed: 4,
    symbolsRenamed: 3,
    commentsRemoved: 2,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    variablesVirtualized: 0,
    listsVirtualized: 0,
    constantsFolded: 0,
    inactiveFallbacksRemoved: 1,
    antiCheatDecoys: 0,
    warnings: [],
    ...overrides
  };
}

function metrics(): CliExecutionMetrics {
  return {
    archiveEntries: 2,
    assetsVerified: 1,
    assetBytesVerified: 42,
    projectBytesWritten: 512
  };
}

function statsWithoutOptionalCounters(): ObfuscationStats {
  return {
    mode: 'lossy',
    blocksBefore: 4,
    blocksAfter: 3,
    identifiersRenamed: 1,
    symbolsRenamed: 1,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function capture(): {
  stdout: string[];
  stderr: string[];
  io: {stdout: (text: string) => void; stderr: (text: string) => void; interactive: false};
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {stdout: text => stdout.push(text), stderr: text => stderr.push(text), interactive: false}
  };
}

async function reportingWithCoverage(allCovered: boolean): Promise<CoverageReportingModule> {
  vi.doMock('../src/release-coverage.js', () => ({
    RELEASE_TEST_COVERAGE: {
      version: 'test-snapshot',
      statements: coverageMetric(allCovered),
      branches: coverageMetric(allCovered),
      functions: coverageMetric(allCovered),
      lines: coverageMetric(allCovered)
    }
  }));
  vi.resetModules();
  return import('../src/cli-reporting.js');
}

function coverageMetric(allCovered: boolean): {covered: number; total: number; percentage: number; allCovered: boolean} {
  return allCovered
    ? {covered: 10, total: 10, percentage: 100, allCovered: true}
    : {covered: 9, total: 10, percentage: 90, allCovered: false};
}
