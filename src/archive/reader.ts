import {createHash} from 'node:crypto';
import {open as openFile, mkdtemp, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Readable} from 'node:stream';
import {open as openZipPath, fromBuffer as openZipBuffer, type Entry, type ZipFile} from 'yauzl';
import {FileSystemError, InputError} from '../errors.js';
import {
  DEFAULT_LIMITS,
  type ArchiveEntry,
  type ArchiveEntryContent,
  type LoadedArchive,
  type ResourceLimits,
  type ScratchProject
} from '../types.js';
import {parseUniqueJson} from './json.js';
import {deriveArchiveSeed} from './seed.js';

const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true});
const PROJECT_NAME = 'project.json';
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

interface LocalFileHeader {
  readonly generalPurposeBitFlag: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly fileName: Buffer;
  readonly extraField: Buffer;
}

interface ZipFileWithLocalHeaders extends ZipFile {
  readLocalFileHeader(
    entry: Entry,
    options: {minimal: false},
    callback: (error: Error | null, header: LocalFileHeader) => void
  ): void;
}

interface ReadEntryResult {
  readonly content: ArchiveEntryContent;
  readonly contentHash: Uint8Array;
}

export async function loadArchive(
  filePath: string,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
  signal?: AbortSignal
): Promise<LoadedArchive> {
  validateLimits(limits);
  throwIfAborted(signal);
  let zipFile: ZipFile;
  try {
    zipFile = await openPath(filePath);
  } catch (error) {
    if (isNodeFilesystemError(error)) {
      throw new FileSystemError(`cannot open input archive: ${error.message}`, {cause: error});
    }
    throw invalidZip(error);
  }

  let spoolDirectory: string;
  try {
    spoolDirectory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-assets-'));
  } catch (error) {
    zipFile.on('error', ignoreLateZipError);
    zipFile.close();
    throw filesystemFailure('cannot create the input asset spool', error);
  }

  try {
    return await readZipFile(zipFile, limits, spoolDirectory, signal);
  } catch (error) {
    await removeSpoolDirectory(spoolDirectory, error);
    throw error;
  }
}

export async function loadArchiveBuffer(
  buffer: Uint8Array,
  limits: Readonly<ResourceLimits> = DEFAULT_LIMITS,
  signal?: AbortSignal
): Promise<LoadedArchive> {
  validateLimits(limits);
  throwIfAborted(signal);
  let zipFile: ZipFile;
  try {
    zipFile = await openBuffer(Buffer.from(buffer));
  } catch (error) {
    throw invalidZip(error);
  }
  return readZipFile(zipFile, limits, undefined, signal);
}

async function readZipFile(
  zipFile: ZipFile,
  limits: Readonly<ResourceLimits>,
  spoolDirectory: string | undefined,
  signal: AbortSignal | undefined
): Promise<LoadedArchive> {
  if (zipFile.entryCount > limits.maxEntries) {
    zipFile.close();
    throw new InputError(`archive has ${zipFile.entryCount} entries; limit is ${limits.maxEntries}`);
  }

  const entries: ArchiveEntry[] = [];
  const exactNames = new Set<string>();
  const foldedNames = new Map<string, string>();
  let totalBytes = 0;
  let totalCompressedBytes = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const entry = await nextEntry(zipFile, signal);
      if (entry === null) break;

      const name = decodeAndValidateName(entry, limits);
      const folded = name.normalize('NFC').toLowerCase().normalize('NFC');
      if (exactNames.has(name)) {
        throw new InputError(`archive contains duplicate entry ${JSON.stringify(name)}`);
      }
      const existing = foldedNames.get(folded);
      if (existing !== undefined) {
        throw new InputError(`archive entries ${JSON.stringify(existing)} and ${JSON.stringify(name)} collide by case or normalization`);
      }
      exactNames.add(name);
      foldedNames.set(folded, name);

      validateEntryMetadata(entry, name, limits);
      await validateLocalHeader(zipFile, entry, name);
      totalBytes = checkedTotal(totalBytes, entry.uncompressedSize, limits.maxTotalBytes, 'uncompressed content');
      totalCompressedBytes = checkedTotal(totalCompressedBytes, entry.compressedSize, limits.maxTotalCompressedBytes, 'compressed content');

      const spoolPath = spoolDirectory === undefined || name === PROJECT_NAME
        ? undefined
        : join(spoolDirectory, `entry-${entries.length.toString().padStart(8, '0')}.bin`);
      const result = await readEntryData(zipFile, entry, name, limits, spoolPath, signal);
      entries.push({
        name,
        content: result.content,
        contentHash: result.contentHash,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize
      });
    }

    const projects = entries.filter(entry => entry.name === PROJECT_NAME);
    if (projects.length !== 1) {
      throw new InputError(`archive must contain exactly one root ${PROJECT_NAME}`);
    }
    const projectEntry = projects[0] as ArchiveEntry & {content: {kind: 'memory'; data: Uint8Array}};
    const parsed = parseUniqueJson(projectEntry.content.data, PROJECT_NAME);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InputError(`${PROJECT_NAME} root must be an object`);
    }
    const project = parsed as ScratchProject;
    return {
      projectBytes: projectEntry.content.data,
      project,
      entries,
      seed: deriveArchiveSeed(projectEntry.content.data, entries),
      cleanup: createCleanup(spoolDirectory)
    };
  } catch (error) {
    zipFile.on('error', ignoreLateZipError);
    zipFile.close();
    if (error instanceof InputError || error instanceof FileSystemError) throw error;
    if (isNodeFilesystemError(error)) throw filesystemFailure('cannot read input archive', error);
    throw invalidZip(error);
  }
}

function validateEntryMetadata(entry: Entry, name: string, limits: Readonly<ResourceLimits>): void {
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x2041) !== 0) {
    throw new InputError(`encrypted archive entry is not supported: ${JSON.stringify(name)}`);
  }
  if ((entry.generalPurposeBitFlag & 0x20) !== 0) {
    throw new InputError(`patched archive entry is not supported: ${JSON.stringify(name)}`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new InputError(`unsupported compression method ${entry.compressionMethod} for ${JSON.stringify(name)}`);
  }
  if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) || entry.compressedSize < 0 || entry.uncompressedSize < 0) {
    throw new InputError(`invalid entry size for ${JSON.stringify(name)}`);
  }

  const perEntryLimit = name === PROJECT_NAME ? limits.maxProjectBytes : limits.maxEntryBytes;
  if (entry.uncompressedSize > perEntryLimit || entry.compressedSize > limits.maxEntryBytes) {
    throw new InputError(`archive entry ${JSON.stringify(name)} exceeds its size limit`);
  }
  if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.maxInflationRatio)) {
    throw new InputError(`archive entry ${JSON.stringify(name)} exceeds the ${limits.maxInflationRatio}x inflation limit`);
  }

  const creatorOs = entry.versionMadeBy >>> 8;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (creatorOs === 3 && (unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
    throw new InputError(`symbolic-link archive entry is not supported: ${JSON.stringify(name)}`);
  }
}

async function validateLocalHeader(zipFile: ZipFile, entry: Entry, name: string): Promise<void> {
  let header: LocalFileHeader;
  try {
    header = await new Promise((resolve, reject) => {
      (zipFile as ZipFileWithLocalHeaders).readLocalFileHeader(entry, {minimal: false}, (error, value) => {
        if (error !== null) reject(error);
        else resolve(value);
      });
    });
  } catch (error) {
    if (isNodeFilesystemError(error)) throw filesystemFailure(`cannot read local ZIP header for ${JSON.stringify(name)}`, error);
    throw new InputError(`invalid local ZIP header for ${JSON.stringify(name)}: ${errorMessage(error)}`, error instanceof Error ? {cause: error} : undefined);
  }

  const centralName = entry.fileName as unknown as Buffer;
  if (header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) {
    throw localHeaderMismatch(name, 'flags');
  }
  if (header.compressionMethod !== entry.compressionMethod) {
    throw localHeaderMismatch(name, 'compression method');
  }
  if (!header.fileName.equals(centralName)) {
    throw localHeaderMismatch(name, 'file name');
  }

  const usesDescriptor = (entry.generalPurposeBitFlag & 0x0008) !== 0;
  const sizesMatch = usesDescriptor
    ? matchesDescriptorSize(header.compressedSize, entry.compressedSize) && matchesDescriptorSize(header.uncompressedSize, entry.uncompressedSize)
    : (() => {
        const sizes = resolveLocalSizes(header, name);
        return sizes.compressedSize === entry.compressedSize && sizes.uncompressedSize === entry.uncompressedSize;
      })();
  if (!sizesMatch) {
    throw localHeaderMismatch(name, 'sizes');
  }
  if (!matchesLocalValue(header.crc32, entry.crc32 >>> 0, usesDescriptor)) {
    throw localHeaderMismatch(name, 'CRC-32');
  }
}

function matchesDescriptorSize(local: number, central: number): boolean {
  return local === 0 || local === 0xffffffff || local === central;
}

function resolveLocalSizes(header: LocalFileHeader, name: string): {compressedSize: number; uncompressedSize: number} {
  let compressedSize = header.compressedSize;
  let uncompressedSize = header.uncompressedSize;
  if (compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff) return {compressedSize, uncompressedSize};

  let offset = 0;
  while (offset + 4 <= header.extraField.length) {
    const identifier = header.extraField.readUInt16LE(offset);
    const length = header.extraField.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > header.extraField.length) break;
    if (identifier === 0x0001) {
      const end = offset + length;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = readZip64Size(header.extraField, offset, end, name);
        offset += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = readZip64Size(header.extraField, offset, end, name);
      }
      return {compressedSize, uncompressedSize};
    }
    offset += length;
  }
  throw new InputError(`local ZIP header for ${JSON.stringify(name)} is missing ZIP64 sizes`);
}

function readZip64Size(bytes: Buffer, offset: number, end: number, name: string): number {
  if (offset + 8 > end) {
    throw new InputError(`local ZIP header for ${JSON.stringify(name)} has a truncated ZIP64 size`);
  }
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InputError(`local ZIP header for ${JSON.stringify(name)} has an unsafe ZIP64 size`);
  }
  return Number(value);
}

function matchesLocalValue(local: number, central: number, descriptor: boolean): boolean {
  return local === central || (descriptor && local === 0);
}

function localHeaderMismatch(name: string, field: string): InputError {
  return new InputError(`local and central ZIP headers disagree on ${field} for ${JSON.stringify(name)}`);
}

function decodeAndValidateName(entry: Entry, limits: Readonly<ResourceLimits>): string {
  const bytes = entry.fileName as unknown as Buffer;
  let name: string;
  if ((entry.generalPurposeBitFlag & 0x800) !== 0) {
    try {
      name = UTF8_DECODER.decode(bytes);
    } catch (error) {
      throw new InputError('archive contains an invalid UTF-8 entry name', {cause: error});
    }
  } else {
    if (bytes.some(byte => byte >= 0x80)) {
      throw new InputError('legacy non-ASCII ZIP entry names are not supported');
    }
    name = bytes.toString('ascii');
  }

  if (name.length === 0 || name.includes('\u0000') || name.includes('\\')) {
    throw new InputError(`unsafe archive entry name: ${JSON.stringify(name)}`);
  }
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    throw new InputError(`absolute archive entry name is not allowed: ${JSON.stringify(name)}`);
  }
  const components = name.split('/');
  if (components.length > limits.maxPathComponents || components.some(component => component === '' || component === '.' || component === '..')) {
    throw new InputError(`unsafe archive entry path: ${JSON.stringify(name)}`);
  }
  return name;
}

async function readEntryData(
  zipFile: ZipFile,
  entry: Entry,
  name: string,
  limits: Readonly<ResourceLimits>,
  spoolPath: string | undefined,
  signal: AbortSignal | undefined
): Promise<ReadEntryResult> {
  const data = spoolPath === undefined ? Buffer.allocUnsafe(entry.uncompressedSize) : undefined;
  const file = spoolPath === undefined ? undefined : await openSpoolFile(spoolPath, name);
  let stream: Readable;
  try {
    stream = await new Promise((resolve, reject) => {
      zipFile.openReadStream(entry, (error, value) => {
        if (error !== null) reject(error);
        else resolve(value);
      });
    });
  } catch (error) {
    await cleanupPartialSpool(file, spoolPath, error);
    if (isNodeFilesystemError(error)) throw filesystemFailure(`cannot read archive entry ${JSON.stringify(name)}`, error);
    throw new InputError(`cannot decompress archive entry ${JSON.stringify(name)}`, error instanceof Error ? {cause: error} : undefined);
  }

  const hash = createHash('sha256');
  let actualSize = 0;
  let crc = 0xffffffff;
  const interrupt = (): void => {
    stream.destroy(interruptedError(signal));
  };
  signal?.addEventListener('abort', interrupt, {once: true});
  try {
    for await (const value of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      actualSize += chunk.length;
      if (actualSize > entry.uncompressedSize || actualSize > limits.maxEntryBytes || (name === PROJECT_NAME && actualSize > limits.maxProjectBytes)) {
        throw new InputError(`archive entry ${JSON.stringify(name)} expanded beyond its declared or configured size`);
      }
      crc = updateCrc32(crc, chunk);
      hash.update(chunk);
      if (data !== undefined) chunk.copy(data, actualSize - chunk.length);
      else await writeAll(file as Awaited<ReturnType<typeof openFile>>, chunk);
    }
  } catch (error) {
    await cleanupPartialSpool(file, spoolPath, error);
    if (error instanceof InputError || error instanceof FileSystemError) throw error;
    if (isNodeFilesystemError(error)) throw filesystemFailure(`cannot read archive entry ${JSON.stringify(name)}`, error);
    throw new InputError(`cannot decompress archive entry ${JSON.stringify(name)}`, error instanceof Error ? {cause: error} : undefined);
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }

  if (file !== undefined) {
    try {
      await file.close();
    } catch (error) {
      await cleanupPartialSpool(undefined, spoolPath, error);
      throw filesystemFailure(`cannot close spooled archive entry ${JSON.stringify(name)}`, error);
    }
  }
  if (actualSize !== entry.uncompressedSize) {
    const error = new InputError(`archive entry ${JSON.stringify(name)} has an invalid uncompressed size`);
    await cleanupPartialSpool(undefined, spoolPath, error);
    throw error;
  }
  const calculatedCrc = (crc ^ 0xffffffff) >>> 0;
  if (calculatedCrc !== (entry.crc32 >>> 0)) {
    const error = new InputError(`archive entry ${JSON.stringify(name)} failed its CRC-32 check`);
    await cleanupPartialSpool(undefined, spoolPath, error);
    throw error;
  }
  return {
    content: spoolPath === undefined
      ? {kind: 'memory', data: data as Uint8Array}
      : {kind: 'file', path: spoolPath},
    contentHash: hash.digest()
  };
}

async function openSpoolFile(filePath: string, name: string): Promise<Awaited<ReturnType<typeof openFile>>> {
  try {
    return await openFile(filePath, 'wx', 0o600);
  } catch (error) {
    throw filesystemFailure(`cannot spool archive entry ${JSON.stringify(name)}`, error);
  }
}

async function writeAll(file: Awaited<ReturnType<typeof openFile>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) throw new FileSystemError('spool write made no progress');
    offset += result.bytesWritten;
  }
}

async function cleanupPartialSpool(
  file: Awaited<ReturnType<typeof openFile>> | undefined,
  spoolPath: string | undefined,
  originalError: unknown
): Promise<void> {
  let cleanupError: unknown;
  if (file !== undefined) {
    try {
      await file.close();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (spoolPath !== undefined) {
    try {
      await unlink(spoolPath);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw filesystemFailure(`cannot clean up a partial asset spool after ${errorMessage(originalError)}`, cleanupError);
  }
}

function updateCrc32(initial: number, bytes: Uint8Array): number {
  let crc = initial;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return crc;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function nextEntry(zipFile: ZipFile, signal: AbortSignal | undefined): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(interruptedError(signal));
    };
    const cleanup = (): void => {
      zipFile.removeListener('entry', onEntry);
      zipFile.removeListener('end', onEnd);
      zipFile.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    zipFile.once('entry', onEntry);
    zipFile.once('end', onEnd);
    zipFile.once('error', onError);
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted === true) onAbort();
    else zipFile.readEntry();
  });
}

function ignoreLateZipError(): void {
  // A path-backed random-access read can finish after an abort closes the ZIP.
}

function openPath(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZipPath(filePath, {autoClose: true, lazyEntries: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: false}, (error, zipFile) => {
      if (error !== null) reject(error);
      else resolve(zipFile);
    });
  });
}

function openBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZipBuffer(buffer, {autoClose: true, lazyEntries: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: false}, (error, zipFile) => {
      if (error !== null) reject(error);
      else resolve(zipFile);
    });
  });
}

function checkedTotal(current: number, addition: number, limit: number, label: string): number {
  const total = current + addition;
  if (!Number.isSafeInteger(total) || total > limit) {
    throw new InputError(`archive ${label} exceeds ${limit} bytes`);
  }
  return total;
}

function createCleanup(spoolDirectory: string | undefined): () => Promise<void> {
  if (spoolDirectory === undefined) return () => Promise.resolve();
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= removeSpoolDirectory(spoolDirectory);
    return cleanupPromise;
  };
}

async function removeSpoolDirectory(spoolDirectory: string, originalError?: unknown): Promise<void> {
  try {
    await rm(spoolDirectory, {recursive: true, force: true});
  } catch (error) {
    const suffix = originalError === undefined ? '' : ` after ${errorMessage(originalError)}`;
    throw new FileSystemError(`cannot remove the input asset spool${suffix}: ${errorMessage(error)}`, error instanceof Error ? {cause: error} : undefined);
  }
}

function invalidZip(error: unknown): InputError {
  const detail = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : '';
  return new InputError(`invalid SB3 ZIP archive${detail}`, error instanceof Error ? {cause: error} : undefined);
}

function filesystemFailure(message: string, error: unknown): FileSystemError {
  return new FileSystemError(`${message}: ${errorMessage(error)}`, error instanceof Error ? {cause: error} : undefined);
}

function interruptedError(signal: AbortSignal | undefined): FileSystemError {
  return new FileSystemError('input operation was interrupted', signal?.reason instanceof Error ? {cause: signal.reason} : undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw interruptedError(signal);
}

function isNodeFilesystemError(error: unknown): error is NodeJS.ErrnoException & Error {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code.startsWith('E') && !code.startsWith('ERR_');
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException & Error {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function validateLimits(limits: Readonly<ResourceLimits>): void {
  const names: Array<keyof ResourceLimits> = [
    'maxEntries',
    'maxProjectBytes',
    'maxEntryBytes',
    'maxTotalBytes',
    'maxTotalCompressedBytes',
    'maxInflationRatio',
    'maxPathComponents'
  ];
  for (const name of names) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
