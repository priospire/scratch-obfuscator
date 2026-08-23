#!/usr/bin/env node

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
import {DEFAULT_LIMITS, type ArchiveEntry, type ObfuscationMode, type ObfuscationStats} from './types.js';

const VERSION = '0.6.0';

const HELP = `Usage: scratch-obfuscator <input.sb3> [options]

Deterministically obfuscate a Scratch 3 project archive.

Modes (mutually exclusive):
  -lossless, --lossless       Preserve the executable graph (default)
  -lossy, --lossy             Allow bounded non-yielding overhead
  -no-preserve, --no-preserve Maximum bounded obfuscation; timing may change

Options:
  -anticheat, --anticheat     Add tamper-response sentinels and event guards
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
  readonly force: boolean;
}

interface InformationalArguments {
  readonly kind: 'help' | 'version';
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export function parseCliArguments(arguments_: readonly string[]): ParsedCliArguments | InformationalArguments {
  const argumentsNormalized = arguments_.map(argument => {
    if (argument === '-lossless' || argument === '-lossy' || argument === '-no-preserve' || argument === '-anticheat') {
      return `-${argument}`;
    }
    return argument;
  });
  if (argumentsNormalized.includes('--help') || argumentsNormalized.includes('-h')) return {kind: 'help'};
  if (argumentsNormalized.includes('--version') || argumentsNormalized.includes('-V')) return {kind: 'version'};

  const positionals: string[] = [];
  const modes = new Set<ObfuscationMode>();
  let output: string | undefined;
  let force = false;
  let antiCheat = false;
  let optionsEnded = false;

  for (let index = 0; index < argumentsNormalized.length; index += 1) {
    const argument = argumentsNormalized[index] as string;
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && (argument === '--lossless' || argument === '--lossy' || argument === '--no-preserve')) {
      modes.add(argument.slice(2) as ObfuscationMode);
    } else if (!optionsEnded && argument === '--anticheat') {
      antiCheat = true;
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
  return output === undefined
    ? {kind: 'run', input, mode, antiCheat, force}
    : {kind: 'run', input, output, mode, antiCheat, force};
}

export async function runCli(
  arguments_: readonly string[],
  io: CliIo = {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text)
  },
  signal?: AbortSignal
): Promise<number> {
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.kind !== 'run') {
      io.stdout(parsed.kind === 'help' ? HELP : `${VERSION}\n`);
      return 0;
    }

    const {paths, stats} = await executeObfuscation(parsed, signal);
    io.stdout(
      `Obfuscated ${JSON.stringify(basename(paths.inputPath))} -> ${JSON.stringify(basename(paths.outputPath))}` +
      ` (mode=${parsed.mode}, anticheat=${parsed.antiCheat ? 'on' : 'off'},` +
      ` blocks=${stats.blocksBefore}->${stats.blocksAfter}, renamed=${stats.identifiersRenamed + stats.symbolsRenamed},` +
      ` packed=${stats.variablesVirtualized ?? 0}, folded=${stats.constantsFolded ?? 0},` +
      ` fallbacks=${stats.inactiveFallbacksRemoved ?? 0}, comments=${stats.commentsRemoved},` +
      ` packed-lists=${stats.listsVirtualized ?? 0},` +
      ` decoys=${stats.decoysAdded}, virtualized=${stats.virtualizedBlocks}, warnings=${stats.warnings.length})\n`
    );
    for (const warning of stats.warnings) {
      io.stderr(`warning: ${warning}\n`);
    }
    return 0;
  } catch (error) {
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
  signal: AbortSignal | undefined
): Promise<{paths: Awaited<ReturnType<typeof prepareOutput>>; stats: ObfuscationStats}> {
  const paths = await prepareOutput(parsed.input, parsed.output, parsed.force);
  const source = await loadArchive(paths.inputPath, DEFAULT_LIMITS, signal);
  try {
    validateProject(source.project, {
      allowRecoverableLocalSymbolIdCollisions: true,
      allowRecoverableInactiveShadowOwnership: true,
      allowRecoverableStaleInvisibleMonitors: true
    });
    validateReferencedAssets(source.project, source.entries);
    const modeSeed = deriveModeSeed(source.seed, parsed.mode);
    const transformed = obfuscateProject(source.project, parsed.mode, modeSeed, {antiCheat: parsed.antiCheat});
    validateProject(transformed.project);
    const projectBytes = serializeProject(transformed.project, parsed.mode);

    await commitOutput(
      paths.outputPath,
      parsed.force,
      temporaryPath => writeDeterministicArchive(temporaryPath, projectBytes, source.entries, signal),
      async temporaryPath => {
        const outputLimits = parsed.mode === 'no-preserve' ? {
          ...DEFAULT_LIMITS,
          maxProjectBytes: 128 * 1024 * 1024
        } : DEFAULT_LIMITS;
        const reopened = await loadArchive(temporaryPath, outputLimits, signal);
        try {
          validateProject(reopened.project);
          validateReferencedAssets(reopened.project, reopened.entries);
          assertAssetsPreserved(source.entries, reopened.entries);
        } finally {
          await reopened.cleanup();
        }
      },
      signal
    );
    return {paths, stats: transformed.stats};
  } finally {
    await source.cleanup();
  }
}

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
