import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {Zip, ZipDeflate} from 'fflate';
import {FileSystemError, InputError} from '../errors.js';
import {compareUtf8} from '../deterministic.js';
import type {ArchiveEntry, ArchiveEntryContent, ObfuscationMode, ScratchProject} from '../types.js';

const PROJECT_NAME = 'project.json';
const STREAM_CHUNK_BYTES = 1024 * 1024;
const REGULAR_FILE_ATTRIBUTES = 0o100644 * 0x10000;

interface WritableArchiveEntry {
  readonly name: string;
  readonly content: ArchiveEntryContent;
  readonly contentHash: Uint8Array;
  readonly uncompressedSize: number;
}

export function serializeProject(project: ScratchProject, mode: ObfuscationMode): Uint8Array {
  let json: string;
  try {
    json = serializeJsonValue(project, new Set<object>());
  } catch (error) {
    throw new InputError('transformed project cannot be serialized as JSON', {cause: error});
  }
  const bytes = Buffer.from(json, 'utf8');
  const limit = mode === 'no-preserve' ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
  if (bytes.length > limit) {
    throw new InputError(`transformed project.json is ${bytes.length} bytes; ${mode} limit is ${limit} bytes`);
  }
  return bytes;
}

export async function writeDeterministicArchive(
  filePath: string,
  projectBytes: Uint8Array,
  sourceEntries: readonly ArchiveEntry[],
  signal?: AbortSignal
): Promise<void> {
  const entries = canonicalEntries(projectBytes, sourceEntries);
  const output = createWriteStream(filePath, {flags: 'wx', mode: 0o600});
  const completion = finished(output);
  let zipError: Error | undefined;

  const zip = new Zip((error, chunk, final) => {
    if (error !== null) {
      zipError = error;
      output.destroy(error);
      return;
    }
    if (chunk !== null && chunk.length > 0) {
      output.write(chunk);
    }
    if (final) {
      output.end();
    }
  });

  try {
    for (const entry of entries) {
      throwIfAborted(signal);
      await waitForDrain(output);
      const compressor = new ZipDeflate(entry.name, {level: 9, mem: 12});
      compressor.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
      compressor.os = 3;
      compressor.attrs = REGULAR_FILE_ATTRIBUTES;
      zip.add(compressor);
      await pushEntry(entry, compressor, output, signal);
      if (zipError !== undefined) throw zipError;
    }
    zip.end();
    await completion;
    if (zipError !== undefined) throw zipError;
    await syncFile(filePath);
  } catch (error) {
    zip.terminate();
    output.destroy();
    await completion.catch(() => undefined);
    if (error instanceof FileSystemError || error instanceof InputError) throw error;
    throw new FileSystemError(`cannot write output archive: ${errorMessage(error)}`, error instanceof Error ? {cause: error} : undefined);
  }
}

function canonicalEntries(projectBytes: Uint8Array, sourceEntries: readonly ArchiveEntry[]): WritableArchiveEntry[] {
  let projectCount = 0;
  const others: WritableArchiveEntry[] = [];
  for (const entry of sourceEntries) {
    if (entry.name === PROJECT_NAME) {
      projectCount += 1;
    } else {
      others.push({
        name: entry.name,
        content: entry.content,
        contentHash: entry.contentHash,
        uncompressedSize: entry.uncompressedSize
      });
    }
  }
  if (projectCount !== 1) {
    throw new InputError(`source archive must contain exactly one root ${PROJECT_NAME}`);
  }
  others.sort((left, right) => compareUtf8(left.name, right.name));
  const projectHash = createHash('sha256').update(projectBytes).digest();
  return [{
    name: PROJECT_NAME,
    content: {kind: 'memory', data: projectBytes},
    contentHash: projectHash,
    uncompressedSize: projectBytes.length
  }, ...others];
}

async function pushEntry(
  entry: WritableArchiveEntry,
  compressor: ZipDeflate,
  output: ReturnType<typeof createWriteStream>,
  signal: AbortSignal | undefined
): Promise<void> {
  const hash = createHash('sha256');
  let actualSize = 0;
  let emitted = false;

  if (entry.content.kind === 'memory') {
    const data = entry.content.data;
    for (let offset = 0; offset < data.length; offset += STREAM_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(offset + STREAM_CHUNK_BYTES, data.length);
      const chunk = data.subarray(offset, end);
      actualSize += chunk.length;
      hash.update(chunk);
      compressor.push(chunk, end === data.length);
      emitted = true;
      await waitForDrain(output);
    }
  } else {
    const input = createReadStream(entry.content.path, {highWaterMark: STREAM_CHUNK_BYTES});
    const interrupt = (): void => {
      input.destroy(interruptedError(signal));
    };
    signal?.addEventListener('abort', interrupt, {once: true});
    try {
      for await (const value of input) {
        throwIfAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        actualSize += chunk.length;
        if (actualSize > entry.uncompressedSize) {
          throw new FileSystemError(`spooled asset ${JSON.stringify(entry.name)} changed while writing`);
        }
        hash.update(chunk);
        compressor.push(chunk, actualSize === entry.uncompressedSize);
        emitted = true;
        await waitForDrain(output);
      }
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  }

  if (!emitted) compressor.push(new Uint8Array(0), true);
  if (actualSize !== entry.uncompressedSize || !hash.digest().equals(Buffer.from(entry.contentHash))) {
    throw new FileSystemError(`spooled asset ${JSON.stringify(entry.name)} changed while writing`);
  }
}

function serializeJsonValue(value: unknown, ancestors: Set<object>, inArray = false): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0';
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    if (inArray) return 'null';
    throw new TypeError('unsupported top-level JSON value');
  }
  if (typeof value === 'bigint') throw new TypeError('BigInt is not a JSON value');
  if (typeof value !== 'object') throw new TypeError('unsupported JSON value');
  if (ancestors.has(value)) throw new TypeError('cyclic project value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(serializeJsonValue(value[index], ancestors, true));
      }
      return `[${items.join(',')}]`;
    }
    const members: string[] = [];
    for (const key of Object.keys(value)) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
      members.push(`${JSON.stringify(key)}:${serializeJsonValue(member, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function waitForDrain(output: ReturnType<typeof createWriteStream>): Promise<void> {
  if (output.destroyed) {
    throw new Error('output stream closed unexpectedly');
  }
  if (output.writableNeedDrain) {
    await once(output, 'drain');
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

function interruptedError(signal: AbortSignal | undefined): FileSystemError {
  return new FileSystemError('output operation was interrupted', signal?.reason instanceof Error ? {cause: signal.reason} : undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw interruptedError(signal);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
