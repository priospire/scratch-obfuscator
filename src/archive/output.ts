import {constants as fsConstants, type BigIntStats} from 'node:fs';
import {access, link, lstat, open, readFile, realpath, rename, stat, unlink} from 'node:fs/promises';
import {basename, dirname, extname, join, parse, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {FileSystemError, InputError, UsageError} from '../errors.js';

const COPY_BUFFER_BYTES = 1024 * 1024;
const JOURNAL_VERSION = 1;
const ACTIVE_OUTPUTS = new Set<string>();

export interface OutputPreparation {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly outputExists: boolean;
}

interface TransactionJournal {
  readonly version: number;
  readonly output: string;
  readonly temporary: string;
  readonly pid: number;
}

interface TransactionPaths {
  readonly directory: string;
  readonly journal: string;
  readonly backup: string;
}

export async function prepareOutput(inputArgument: string, outputArgument: string | undefined, force: boolean): Promise<OutputPreparation> {
  const inputPath = resolve(inputArgument);
  if (extname(inputPath).toLowerCase() !== '.sb3') {
    throw new InputError('input file must have an .sb3 extension');
  }

  let inputStats: BigIntStats;
  let canonicalInput: string;
  try {
    inputStats = await stat(inputPath, {bigint: true});
    canonicalInput = await realpath(inputPath);
  } catch (error) {
    throw filesystemFailure(`cannot access input file ${JSON.stringify(inputPath)}`, error);
  }
  if (!inputStats.isFile()) {
    throw new FileSystemError(`input path is not a regular file: ${JSON.stringify(inputPath)}`);
  }

  const outputPath = resolve(outputArgument ?? defaultOutputPath(inputPath));
  if (samePlatformPath(inputPath, outputPath)) {
    throw new UsageError('input and output paths must be different');
  }

  await recoverInterruptedCommit(outputPath);
  const canonicalParent = await validateOutputDirectory(outputPath);

  let outputExists = false;
  let outputLinkStats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    outputLinkStats = await lstat(outputPath);
    outputExists = true;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw filesystemFailure(`cannot inspect output path ${JSON.stringify(outputPath)}`, error);
    }
  }

  if (outputExists) {
    let canonicalOutput: string | undefined;
    let outputStats: BigIntStats | undefined;
    try {
      canonicalOutput = await realpath(outputPath);
      outputStats = await stat(outputPath, {bigint: true});
    } catch (error) {
      if (outputLinkStats?.isSymbolicLink() !== true || !isErrno(error, 'ENOENT')) {
        throw filesystemFailure(`cannot inspect output path ${JSON.stringify(outputPath)}`, error);
      }
    }
    if (canonicalOutput !== undefined && samePlatformPath(canonicalInput, canonicalOutput)) {
      throw new UsageError('input and output resolve to the same file');
    }
    if (outputStats !== undefined && sameFileIdentity(inputStats, outputStats)) {
      throw new UsageError('input and output are hardlinks to the same file');
    }
    if (outputStats?.isDirectory() === true) {
      throw new FileSystemError(`output path is a directory: ${JSON.stringify(outputPath)}`);
    }
    if (outputStats !== undefined && !outputStats.isFile()) {
      throw new FileSystemError(`output path is not a regular file: ${JSON.stringify(outputPath)}`);
    }
    if (!force) {
      throw new UsageError('output already exists; use --force to replace it');
    }
  } else {
    const prospective = join(canonicalParent, basename(outputPath));
    if (samePlatformPath(canonicalInput, prospective)) {
      throw new UsageError('input and output resolve to the same file');
    }
  }

  return {inputPath, outputPath, outputExists};
}

export function defaultOutputPath(inputPath: string): string {
  const parts = parse(inputPath);
  return join(parts.dir, `${parts.name}.obfuscated.sb3`);
}

export async function commitOutput(
  outputPathArgument: string,
  force: boolean,
  writeTemporary: (temporaryPath: string) => Promise<void>,
  verifyTemporary: (temporaryPath: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const outputPath = resolve(outputPathArgument);
  const activeKey = platformPathKey(outputPath);
  if (ACTIVE_OUTPUTS.has(activeKey)) {
    throw new FileSystemError(`another output transaction is active for ${JSON.stringify(outputPath)}`);
  }
  ACTIVE_OUTPUTS.add(activeKey);

  let temporaryPath: string | undefined;
  let failure: Error | undefined;
  try {
    await recoverInterruptedCommit(outputPath, true);
    await validateOutputDirectory(outputPath);
    temporaryPath = await unusedSiblingPath(outputPath, 'tmp');
    throwIfAborted(signal);
    await writeTemporary(temporaryPath);
    throwIfAborted(signal);
    await verifyTemporary(temporaryPath);
    throwIfAborted(signal);
    await syncFile(temporaryPath);
    throwIfAborted(signal);

    if (force) await publishWithRecovery(outputPath, temporaryPath);
    else await publishWithoutReplacement(outputPath, temporaryPath);
  } catch (error) {
    failure = normalizeCommitError(error);
  }

  if (temporaryPath !== undefined) {
    try {
      await unlinkIfExists(temporaryPath);
    } catch (error) {
      failure = filesystemFailure(
        failure === undefined ? 'cannot clean up the temporary output' : `cannot clean up the temporary output after ${errorMessage(failure)}`,
        error
      );
    }
  }
  ACTIVE_OUTPUTS.delete(activeKey);
  if (failure !== undefined) throw failure;
}

async function publishWithoutReplacement(outputPath: string, temporaryPath: string): Promise<void> {
  try {
    await link(temporaryPath, outputPath);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new UsageError('output was created while processing; use --force to replace it');
    }
    if (!hardlinkUnsupported(error)) throw error;
    await copyExclusive(temporaryPath, outputPath, () => new UsageError('output was created while processing; use --force to replace it'));
    return;
  }
  try {
    await syncDirectory(dirname(outputPath));
  } catch (error) {
    await unlinkIfExists(outputPath);
    throw error;
  }
}

async function copyExclusive(sourcePath: string, destinationPath: string, destinationExists: () => Error): Promise<void> {
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  let failure: Error | undefined;
  try {
    source = await open(sourcePath, 'r');
    try {
      destination = await open(destinationPath, 'wx', 0o600);
      created = true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        throw destinationExists();
      }
      throw error;
    }

    // Node has no cross-platform rename-without-replacement primitive. An exclusive
    // destination handle provides portable no-clobber publication without hardlinks.
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    while (true) {
      const {bytesRead} = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await writeAll(destination, buffer.subarray(0, bytesRead));
    }
    await destination.sync();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(errorMessage(error));
  }

  for (const handle of [destination, source]) {
    if (handle === undefined) continue;
    try {
      await handle.close();
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(errorMessage(error));
    }
  }

  if (failure !== undefined) {
    if (created) {
      try {
        await unlinkIfExists(destinationPath);
        await syncDirectory(dirname(destinationPath));
      } catch (cleanupError) {
        throw filesystemFailure(`cannot remove an incomplete output after ${errorMessage(failure)}`, cleanupError);
      }
    }
    throw failure;
  }
  await syncDirectory(dirname(destinationPath));
}

async function publishWithRecovery(outputPath: string, temporaryPath: string): Promise<void> {
  const paths = transactionPaths(outputPath);
  if (await pathExists(paths.backup)) {
    throw new FileSystemError(`reserved backup path already exists: ${JSON.stringify(paths.backup)}`);
  }
  await createJournal(paths.journal, {
    version: JOURNAL_VERSION,
    output: basename(outputPath),
    temporary: basename(temporaryPath),
    pid: process.pid
  });
  await syncDirectory(paths.directory);

  const hadPrevious = await pathExists(outputPath);
  let backupAvailable = false;
  let outputInstalled = false;
  try {
    if (hadPrevious) {
      await createDurableBackup(outputPath, paths.backup);
      backupAvailable = true;
    }

    await rename(temporaryPath, outputPath);
    outputInstalled = true;
    await syncFile(outputPath);
    await syncDirectory(paths.directory);

    if (backupAvailable) {
      await unlink(paths.backup);
      backupAvailable = false;
      await syncDirectory(paths.directory);
    }
    await unlink(paths.journal);
    await syncDirectory(paths.directory);
  } catch (error) {
    if (backupAvailable) {
      if (outputInstalled) {
        await restoreBackup(paths.backup, outputPath, paths.journal, error);
      } else {
        try {
          await unlinkIfExists(paths.backup);
          await unlinkIfExists(paths.journal);
          await syncDirectory(paths.directory);
        } catch (cleanupError) {
          throw filesystemFailure(`cannot clean up a failed replacement after ${errorMessage(error)}`, cleanupError);
        }
      }
    } else if (!hadPrevious && outputInstalled) {
      try {
        await unlinkIfExists(outputPath);
        await unlinkIfExists(paths.journal);
        await syncDirectory(paths.directory);
      } catch (cleanupError) {
        throw filesystemFailure(`cannot roll back a failed output installation after ${errorMessage(error)}`, cleanupError);
      }
    } else {
      await unlinkIfExists(paths.journal).catch(() => undefined);
    }
    throw error;
  }
}

async function restoreBackup(backupPath: string, outputPath: string, journalPath: string, originalError?: unknown): Promise<void> {
  try {
    await rename(backupPath, outputPath);
    await syncFile(outputPath);
    await unlinkIfExists(journalPath);
    await syncDirectory(dirname(outputPath));
  } catch (restoreError) {
    const original = originalError === undefined ? '' : ` after ${errorMessage(originalError)}`;
    throw new FileSystemError(`cannot restore previous output${original}; backup remains at ${JSON.stringify(backupPath)}: ${errorMessage(restoreError)}`, restoreError instanceof Error ? {cause: restoreError} : undefined);
  }
}

async function createDurableBackup(outputPath: string, backupPath: string): Promise<void> {
  try {
    await link(outputPath, backupPath);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new FileSystemError(`reserved backup path already exists: ${JSON.stringify(backupPath)}`);
    }
    if (!hardlinkUnsupported(error)) throw error;
    await copyExclusive(outputPath, backupPath, () => new FileSystemError(`reserved backup path already exists: ${JSON.stringify(backupPath)}`));
    return;
  }
  try {
    await syncFile(backupPath);
    await syncDirectory(dirname(outputPath));
  } catch (error) {
    try {
      await unlinkIfExists(backupPath);
      await syncDirectory(dirname(outputPath));
    } catch (cleanupError) {
      throw filesystemFailure(`cannot remove an incomplete backup after ${errorMessage(error)}`, cleanupError);
    }
    throw error;
  }
}

async function recoverInterruptedCommit(outputPath: string, ignoreInProcess = false): Promise<void> {
  try {
    await recoverInterruptedCommitUnsafe(outputPath, ignoreInProcess);
  } catch (error) {
    if (error instanceof FileSystemError) throw error;
    throw filesystemFailure(`cannot recover output transaction for ${JSON.stringify(outputPath)}`, error);
  }
}

async function recoverInterruptedCommitUnsafe(outputPath: string, ignoreInProcess: boolean): Promise<void> {
  const paths = transactionPaths(outputPath);
  if (!ignoreInProcess && ACTIVE_OUTPUTS.has(platformPathKey(outputPath))) {
    throw new FileSystemError(`another output transaction is active for ${JSON.stringify(outputPath)}`);
  }
  if (!await pathExists(paths.journal)) {
    if (await pathExists(paths.backup)) {
      throw new FileSystemError(`orphaned output backup requires manual recovery: ${JSON.stringify(paths.backup)}`);
    }
    return;
  }
  let journal: TransactionJournal;
  try {
    const journalStats = await lstat(paths.journal);
    if (!journalStats.isFile() || journalStats.isSymbolicLink()) throw new Error('transaction marker is not a regular file');
    journal = parseJournal(await readFile(paths.journal), outputPath);
  } catch (error) {
    const backupExists = await pathExists(paths.backup);
    const outputExists = await pathExists(outputPath);
    if (backupExists && !outputExists) {
      await rename(paths.backup, outputPath);
      await syncFile(outputPath);
      await syncDirectory(paths.directory);
    }
    if (!backupExists || !outputExists) {
      await unlinkIfExists(paths.journal);
      await syncDirectory(paths.directory);
    }
    throw filesystemFailure(`cannot recover output transaction ${JSON.stringify(paths.journal)}`, error);
  }

  if (journal.pid !== process.pid && processIsAlive(journal.pid)) {
    throw new FileSystemError(`another process is committing ${JSON.stringify(outputPath)}`);
  }

  const temporaryPath = join(paths.directory, journal.temporary);
  const outputExists = await pathExists(outputPath);
  const backupExists = await pathExists(paths.backup);
  if (backupExists && !outputExists) {
    await rename(paths.backup, outputPath);
    await syncFile(outputPath);
  } else if (outputExists) {
    await syncFile(outputPath);
    if (backupExists) await unlink(paths.backup);
  }
  await unlinkIfExists(temporaryPath);
  await unlinkIfExists(paths.journal);
  await syncDirectory(paths.directory);
}

function parseJournal(bytes: Uint8Array, outputPath: string): TransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`invalid transaction marker: ${errorMessage(error)}`, {cause: error});
  }
  if (value === null || typeof value !== 'object') throw new Error('invalid transaction marker');
  const record = value as Record<string, unknown>;
  const expectedPrefix = `.${basename(outputPath)}.tmp-`;
  if (record['version'] !== JOURNAL_VERSION || record['output'] !== basename(outputPath) ||
      typeof record['temporary'] !== 'string' || !record['temporary'].startsWith(expectedPrefix) ||
      !/^[0-9a-f]{24}$/.test(record['temporary'].slice(expectedPrefix.length)) ||
      !Number.isSafeInteger(record['pid']) || (record['pid'] as number) <= 0) {
    throw new Error('invalid transaction marker');
  }
  return {
    version: JOURNAL_VERSION,
    output: basename(outputPath),
    temporary: record['temporary'],
    pid: record['pid'] as number
  };
}

async function createJournal(filePath: string, journal: TransactionJournal): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(filePath, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file?.close();
  }
}

async function validateOutputDirectory(outputPath: string): Promise<string> {
  const requestedParent = dirname(outputPath);
  try {
    const canonicalParent = await realpath(requestedParent);
    const parentStats = await stat(canonicalParent);
    if (!parentStats.isDirectory()) {
      throw new Error('path is not a directory');
    }
    await access(canonicalParent, fsConstants.W_OK);
    return canonicalParent;
  } catch (error) {
    throw filesystemFailure(`cannot access output directory ${JSON.stringify(requestedParent)}`, error);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const file = await open(filePath, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(directory, 'r');
    await file.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await file?.close();
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  if (isErrno(error, 'EINVAL') || isErrno(error, 'ENOTSUP')) return true;
  return process.platform === 'win32' && (isErrno(error, 'EACCES') || isErrno(error, 'EISDIR') || isErrno(error, 'EPERM'));
}

function hardlinkUnsupported(error: unknown): boolean {
  return ['EACCES', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].some(code => isErrno(error, code));
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesWritten} = await file.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new Error('output write made no progress');
    offset += bytesWritten;
  }
}

async function unusedSiblingPath(outputPath: string, kind: string): Promise<string> {
  const directory = dirname(outputPath);
  const name = basename(outputPath);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const suffix = randomBytes(12).toString('hex');
    const candidate = join(directory, `.${name}.${kind}-${suffix}`);
    if (!await pathExists(candidate)) return candidate;
  }
  throw new FileSystemError(`cannot allocate a temporary ${kind} path next to the output`);
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function transactionPaths(outputPath: string): TransactionPaths {
  const directory = dirname(outputPath);
  const name = basename(outputPath);
  return {
    directory,
    journal: join(directory, `.${name}.scratch-obfuscator.transaction`),
    backup: join(directory, `.${name}.scratch-obfuscator.backup`)
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && (left.dev !== 0n || left.ino !== 0n);
}

function platformPathKey(value: string): string {
  const absolute = resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function samePlatformPath(left: string, right: string): boolean {
  return platformPathKey(left) === platformPathKey(right);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FileSystemError('output operation was interrupted', signal.reason instanceof Error ? {cause: signal.reason} : undefined);
  }
}

function normalizeCommitError(error: unknown): Error {
  if (error instanceof UsageError || error instanceof FileSystemError || error instanceof InputError) return error;
  return filesystemFailure('cannot commit output file', error);
}

function filesystemFailure(message: string, error: unknown): FileSystemError {
  return new FileSystemError(`${message}: ${errorMessage(error)}`, error instanceof Error ? {cause: error} : undefined);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException & Error {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
