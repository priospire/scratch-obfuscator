#!/usr/bin/env node

import {Buffer} from 'node:buffer';
import {fileURLToPath} from 'node:url';
import {basename} from 'node:path';
import {realpathSync} from 'node:fs';
import {AppError, FileSystemError, UsageError, type ExitCode} from './errors.js';
import {
  commitOutput,
  deriveModeSeed,
  loadArchive,
  prepareOutput,
  serializeProject,
  validateReferencedAssets,
  writeDeterministicArchive
} from './archive/index.js';
import {obfuscateProject} from './obfuscation/index.js';
import {validateProject} from './validation/index.js';
import {compareUtf8} from './deterministic.js';
import {
  DEFAULT_LIMITS,
  type ArchiveEntry,
  type ExtraPrivacyLevel,
  type ObfuscationMode,
  type ObfuscationStats
} from './types.js';
import {
  CliProgressReporter,
  cliCaveats,
  formatSuccessSummary,
  formatVerboseReport,
  type CliExecutionMetrics,
  type CliVerbosity
} from './cli-reporting.js';

const VERSION = '0.8.0';

const HELP = `Scratch Obfuscator — PrioSDK Gen 4

Usage: scratch-obfuscator <input.sb3> [options]

Deterministically obfuscate a Scratch 3 project archive.

Modes (mutually exclusive):
  -lossless, --lossless       Preserve the executable graph (default)
  -lossy, --lossy             Allow bounded non-yielding overhead
  -no-preserve, --no-preserve Maximum bounded obfuscation; timing may change

Options:
  -anticheat, --anticheat     Add tamper-response sentinels and event guards
  -antisave, --antisave       Add signed-zero resave guards and Unicode canaries
  -allowsize, --allowsize     Permit expanded bounded block/JSON growth in stronger modes
  -extra, --extra [2]         Level 1 adds project privacy; level 2 also disables and hides event stacks
  -verbose, --verbose [max]   Show progress and reporting; max adds safe details
  -o, --output <file.sb3>      Output path (default: <stem>.obfuscated.sb3)
  --force                     Replace an existing output transactionally
  -h, --help                  Show this help
  -V, --version               Show the version
`;

export interface ParsedCliArguments {
  readonly kind: 'run';
  readonly input: string;
  readonly output?: string;
  readonly mode: ObfuscationMode;
  readonly antiCheat: boolean;
  readonly antiSave: boolean;
  readonly allowSize: boolean;
  readonly extra: boolean;
  readonly extraLevel: ExtraPrivacyLevel;
  readonly force: boolean;
  readonly verbosity: CliVerbosity;
}

interface InformationalArguments {
  readonly kind: 'help' | 'version';
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly interactive?: boolean;
}

export function parseCliArguments(arguments_: readonly string[]): ParsedCliArguments | InformationalArguments {
  let normalizationEnded = false;
  const argumentsNormalized = arguments_.map(argument => {
    if (normalizationEnded) return argument;
    if (argument === '--') {
      normalizationEnded = true;
      return argument;
    }
    if (
      argument === '-lossless'
      || argument === '-lossy'
      || argument === '-no-preserve'
      || argument === '-anticheat'
      || argument === '-antisave'
      || argument === '-allowsize'
      || argument === '-extra'
      || argument === '-verbose'
    ) {
      return `-${argument}`;
    }
    if (argument.startsWith('-verbose=')) return `--${argument.slice(1)}`;
    return argument;
  });
  const terminatorIndex = argumentsNormalized.indexOf('--');
  const optionArguments = terminatorIndex === -1
    ? argumentsNormalized
    : argumentsNormalized.slice(0, terminatorIndex);
  if (optionArguments.includes('--help') || optionArguments.includes('-h')) return {kind: 'help'};
  if (optionArguments.includes('--version') || optionArguments.includes('-V')) return {kind: 'version'};

  const positionals: string[] = [];
  const modes = new Set<ObfuscationMode>();
  let output: string | undefined;
  let force = false;
  let antiCheat = false;
  let antiSave = false;
  let allowSize = false;
  let extraLevel: ExtraPrivacyLevel = 0;
  let verbosity: CliVerbosity = 'normal';
  let optionsEnded = false;

  for (let index = 0; index < argumentsNormalized.length; index += 1) {
    const argument = argumentsNormalized[index] as string;
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && (argument === '--lossless' || argument === '--lossy' || argument === '--no-preserve')) {
      modes.add(argument.slice(2) as ObfuscationMode);
    } else if (!optionsEnded && argument === '--anticheat') {
      antiCheat = true;
    } else if (!optionsEnded && argument === '--antisave') {
      antiSave = true;
    } else if (!optionsEnded && argument === '--allowsize') {
      allowSize = true;
    } else if (!optionsEnded && argument === '--extra') {
      const requestedLevel: ExtraPrivacyLevel = argumentsNormalized[index + 1] === '2' ? 2 : 1;
      extraLevel = Math.max(extraLevel, requestedLevel) as ExtraPrivacyLevel;
      if (requestedLevel === 2) index += 1;
    } else if (!optionsEnded && argument === '--verbose') {
      if (argumentsNormalized[index + 1] === 'max') {
        verbosity = 'max';
        index += 1;
      } else if (verbosity !== 'max') {
        verbosity = 'verbose';
      }
    } else if (!optionsEnded && argument.startsWith('--verbose=')) {
      const value = argument.slice('--verbose='.length);
      if (value !== 'max') throw new UsageError('--verbose accepts only the optional value "max"');
      verbosity = 'max';
    } else if (!optionsEnded && argument === '--force') {
      force = true;
    } else if (!optionsEnded && (argument === '-o' || argument === '--output')) {
      const value = argumentsNormalized[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('-')) throw new UsageError(`${argument} requires an output path`);
      if (output !== undefined) throw new UsageError('output path was specified more than once');
      output = value;
      index += 1;
    } else if (!optionsEnded && argument.startsWith('--output=')) {
      const value = argument.slice('--output='.length);
      if (value.length === 0) throw new UsageError('--output requires an output path');
      if (output !== undefined) throw new UsageError('output path was specified more than once');
      output = value;
    } else if (!optionsEnded && argument.startsWith('-')) {
      throw new UsageError(`unknown option ${JSON.stringify(argument)}`);
    } else {
      positionals.push(argument);
    }
  }

  if (modes.size > 1) throw new UsageError('choose only one of --lossless, --lossy, or --no-preserve');
  if (positionals.length !== 1) throw new UsageError('exactly one input .sb3 file is required');
  const input = positionals[0] as string;
  const mode = modes.values().next().value ?? 'lossless';
  const extra = extraLevel > 0;
  return output === undefined
    ? {kind: 'run', input, mode, antiCheat, antiSave, allowSize, extra, extraLevel, force, verbosity}
    : {kind: 'run', input, output, mode, antiCheat, antiSave, allowSize, extra, extraLevel, force, verbosity};
}

export async function runCli(
  arguments_: readonly string[],
  io: CliIo = {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    interactive: process.stderr.isTTY === true
  },
  signal?: AbortSignal
): Promise<number> {
  let progress: CliProgressReporter | undefined;
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.kind !== 'run') {
      io.stdout(parsed.kind === 'help' ? HELP : `${VERSION}\n`);
      return 0;
    }

    progress = new CliProgressReporter({
      stderr: io.stderr,
      interactive: io.interactive === true,
      verbosity: parsed.verbosity
    });
    progress.update(0, 'Preparing output');
    const {paths, stats, metrics} = await executeObfuscation(parsed, signal, progress);
    progress.complete();
    const caveats = new Set([
      ...(stats.caveats ?? []),
      ...cliCaveats(parsed.mode, parsed.antiCheat, parsed.extraLevel, parsed.allowSize, parsed.antiSave)
    ]);
    io.stdout(formatSuccessSummary(
      basename(paths.inputPath),
      basename(paths.outputPath),
      parsed.mode,
      parsed.antiCheat,
      stats,
      caveats.size,
      parsed.extraLevel,
      parsed.allowSize,
      parsed.antiSave
    ));
    io.stdout(formatVerboseReport(stats, metrics, parsed.verbosity));
    for (const warning of stats.warnings) {
      io.stderr(`warning: ${warning}\n`);
    }
    for (const caveat of caveats) {
      io.stderr(`caveat: ${caveat}\n`);
    }
    return 0;
  } catch (error) {
    progress?.stop();
    if (error instanceof AppError) {
      io.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    if (isNodeFilesystemError(error)) {
      io.stderr(`error: filesystem failure: ${errorMessage(error)}\n`);
      return 4 satisfies ExitCode;
    }
    io.stderr(`error: unexpected failure: ${errorMessage(error)}\n`);
    return 5 satisfies ExitCode;
  }
}

async function executeObfuscation(
  parsed: ParsedCliArguments,
  signal: AbortSignal | undefined,
  progress: CliProgressReporter
): Promise<{
  paths: Awaited<ReturnType<typeof prepareOutput>>;
  stats: ObfuscationStats;
  metrics: CliExecutionMetrics;
}> {
  const paths = await prepareOutput(parsed.input, parsed.output, parsed.force);
  progress.update(0.04, 'Reading input archive');
  const source = await loadArchive(paths.inputPath, DEFAULT_LIMITS, signal);
  try {
    progress.update(0.10, 'Validating input archive');
    validateProject(source.project, {
      allowRecoverableLocalSymbolIdCollisions: true,
      allowRecoverableInactiveShadowOwnership: true,
      allowRecoverableOrphanedShadowHatRoots: true,
      allowRecoverableStaleInvisibleMonitors: true
    });
    validateReferencedAssets(source.project, source.entries);
    const modeSeed = deriveModeSeed(source.seed, parsed.mode);
    progress.update(0.15, 'Transforming project');
    const transformed = obfuscateProject(source.project, parsed.mode, modeSeed, {
      antiCheat: parsed.antiCheat,
      antiSave: parsed.antiSave,
      allowSize: parsed.allowSize,
      extra: parsed.extra,
      extraLevel: parsed.extraLevel,
      onProgress: event => {
        progress.update(
          0.15 + ((event.percentage / 100) * 0.60),
          formatEngineProgress(event.stage, event.detail, event.metrics, parsed.verbosity)
        );
      }
    });
    progress.update(0.78, 'Validating transformed project');
    validateProject(transformed.project);
    progress.update(0.80, 'Serializing transformed project');
    const projectBytes = serializeProject(transformed.project, parsed.mode);
    const sourceAssets = source.entries.filter(entry => entry.name !== 'project.json');
    const assetBytes = sourceAssets.reduce((total, entry) => total + entry.uncompressedSize, 0);

    progress.update(0.84, 'Writing deterministic archive');
    await commitOutput(
      paths.outputPath,
      parsed.force,
      temporaryPath => writeDeterministicArchive(temporaryPath, projectBytes, source.entries, signal),
      async temporaryPath => {
        progress.update(0.90, 'Reopening written archive');
        const outputLimits = parsed.mode === 'no-preserve' ? {
          ...DEFAULT_LIMITS,
          maxProjectBytes: 128 * 1024 * 1024
        } : DEFAULT_LIMITS;
        const reopened = await loadArchive(temporaryPath, outputLimits, signal);
        try {
          progress.update(0.94, 'Validating written archive');
          validateProject(reopened.project);
          validateReferencedAssets(reopened.project, reopened.entries);
          progress.update(0.96, 'Verifying serialized project state');
          const reopenedProjectBytes = serializeProject(reopened.project, parsed.mode);
          if (Buffer.compare(projectBytes, reopenedProjectBytes) !== 0) {
            throw new Error('archive serialization altered the verified project state during write or reopen');
          }
          progress.update(0.97, 'Verifying preserved assets');
          assertAssetsPreserved(source.entries, reopened.entries);
        } finally {
          await reopened.cleanup();
        }
      },
      signal
    );
    progress.update(0.99, 'Verified output committed');
    return {
      paths,
      stats: transformed.stats,
      metrics: {
        archiveEntries: source.entries.length,
        assetsVerified: sourceAssets.length,
        assetBytesVerified: assetBytes,
        projectBytesWritten: projectBytes.length
      }
    };
  } finally {
    await source.cleanup();
  }
}

function formatEngineProgress(
  stage: string,
  detail: string | undefined,
  metrics: Readonly<Record<string, number | string | boolean>> | undefined,
  verbosity: CliVerbosity
): string {
  const stageLabel = stage
    .split('-')
    .filter(part => part.length > 0)
    .map((part, index) => index === 0 ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}` : part)
    .join(' ') || 'Transforming project';
  const label = detail === undefined ? stageLabel : `${stageLabel} - ${detail}`;
  if (verbosity !== 'max' || metrics === undefined) return label;
  const values = Object.entries(metrics)
    .filter((entry): entry is [string, number | boolean] => (
      SAFE_PROGRESS_METRICS.has(entry[0]) && (typeof entry[1] === 'number' || typeof entry[1] === 'boolean')
    ))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${String(value)}`);
  return values.length === 0 ? label : `${label} - ${values.join(', ')}`;
}

const SAFE_PROGRESS_METRICS = new Set([
  'blockEquivalents',
  'blocksAfter',
  'blocksBefore',
  'candidates',
  'canaries',
  'cap',
  'changedHats',
  'commentsRemoved',
  'conditions',
  'coveredHats',
  'decoyBlocks',
  'decoyVariables',
  'displayNames',
  'guards',
  'identifiers',
  'linearRuns',
  'numbers',
  'packedLists',
  'packedVariables',
  'pools',
  'protectedVariables',
  'strings',
  'variables',
  'virtualizedBlocks',
  'warnings'
]);

function assertAssetsPreserved(before: readonly ArchiveEntry[], after: readonly ArchiveEntry[]): void {
  const beforeAssets = before.filter(entry => entry.name !== 'project.json').sort((left, right) => compareUtf8(left.name, right.name));
  const afterAssets = after.filter(entry => entry.name !== 'project.json').sort((left, right) => compareUtf8(left.name, right.name));
  if (beforeAssets.length !== afterAssets.length) {
    throw new FileSystemError('output verification failed: archive entry count changed');
  }
  for (let index = 0; index < beforeAssets.length; index += 1) {
    const expected = beforeAssets[index] as ArchiveEntry;
    const actual = afterAssets[index] as ArchiveEntry;
    if (expected.name !== actual.name || expected.uncompressedSize !== actual.uncompressedSize ||
        !Buffer.from(expected.contentHash).equals(Buffer.from(actual.contentHash))) {
      throw new FileSystemError(`output verification failed: asset ${JSON.stringify(expected.name)} was not preserved`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

async function main(): Promise<void> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort(new Error('interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    process.exitCode = await runCli(process.argv.slice(2), undefined, abortController.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

function isNodeFilesystemError(error: unknown): error is NodeJS.ErrnoException & Error {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code.startsWith('E') && !code.startsWith('ERR_');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && sameEntryPoint(fileURLToPath(import.meta.url), invokedPath)) {
  void main();
}

function sameEntryPoint(modulePath: string, argumentPath: string): boolean {
  const left = realpathSync.native(modulePath);
  const right = realpathSync.native(argumentPath);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
