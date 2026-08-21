import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FileSystemError, InputError} from '../src/errors.js';

const mocks = vi.hoisted(() => ({
  fromBuffer: vi.fn(),
  mkdtemp: vi.fn(),
  openFile: vi.fn(),
  openPath: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn()
}));

vi.mock('yauzl', () => ({open: mocks.openPath, fromBuffer: mocks.fromBuffer}));
vi.mock('node:fs/promises', () => ({open: mocks.openFile, mkdtemp: mocks.mkdtemp, rm: mocks.rm, unlink: mocks.unlink}));

const {loadArchive, loadArchiveBuffer} = await import('../src/archive/reader.js');

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
}

class FakeZipFile extends EventEmitter {
  readonly entryCount: number;
  readonly entries: FakeEntry[];
  closed = false;
  localError: Error | undefined;
  streamError: Error | undefined;
  streamErrorName: string | undefined;

  constructor(entries: FakeEntry[]) {
    super();
    this.entries = [...entries];
    this.entryCount = entries.length;
  }

  close(): void {
    this.closed = true;
  }

  readEntry(): void {
    queueMicrotask(() => {
      const entry = this.entries.shift();
      if (entry === undefined) this.emit('end');
      else this.emit('entry', entry);
    });
  }

  readLocalFileHeader(entry: FakeEntry, _options: unknown, callback: (error: Error | null, value?: unknown) => void): void {
    if (this.localError !== undefined) {
      callback(this.localError);
      return;
    }
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
    if (this.streamError !== undefined && (this.streamErrorName === undefined || entry.fileName.toString() === this.streamErrorName)) {
      callback(this.streamError);
      return;
    }
    callback(null, Readable.from([entry.data]));
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdtemp.mockResolvedValue('C:\\isolated-spool');
  mocks.rm.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.openFile.mockImplementation(() => Promise.resolve(fakeFile()));
});

describe('reader filesystem and stream fault normalization', () => {
  it('maps spool creation failures to filesystem errors', async () => {
    const zip = new FakeZipFile([projectEntry()]);
    installPathZip(zip);
    mocks.mkdtemp.mockRejectedValue(errno('EIO'));
    await expect(loadArchive('input.sb3')).rejects.toBeInstanceOf(FileSystemError);
    expect(zip.closed).toBe(true);
  });

  it('rejects impossible central sizes before reading data', async () => {
    const entry = projectEntry();
    entry.compressedSize = -1;
    installBufferZip(new FakeZipFile([entry]));
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(/invalid entry size/);
  });

  it('distinguishes malformed local headers from local-header I/O failures', async () => {
    const malformed = new FakeZipFile([projectEntry()]);
    malformed.localError = new Error('bad local header');
    installBufferZip(malformed);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toBeInstanceOf(InputError);

    const ioFailure = new FakeZipFile([projectEntry()]);
    ioFailure.localError = errno('EIO');
    installBufferZip(ioFailure);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toBeInstanceOf(FileSystemError);
  });

  it('distinguishes decompressor setup errors from entry I/O failures', async () => {
    const malformed = new FakeZipFile([projectEntry()]);
    malformed.streamError = new Error('synthetic decompressor error');
    installBufferZip(malformed);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(/cannot decompress/);

    const ioFailure = new FakeZipFile([projectEntry()]);
    ioFailure.streamError = errno('EIO');
    installBufferZip(ioFailure);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toBeInstanceOf(FileSystemError);
  });

  it('rejects streams larger or shorter than their central declarations', async () => {
    const expandedEntry = projectEntry();
    expandedEntry.uncompressedSize = expandedEntry.data.length - 1;
    expandedEntry.compressedSize = expandedEntry.uncompressedSize;
    const expanded = new FakeZipFile([expandedEntry]);
    installBufferZip(expanded);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(/expanded beyond/);

    const shortEntry = projectEntry();
    shortEntry.uncompressedSize += 1;
    shortEntry.compressedSize = shortEntry.uncompressedSize;
    const short = new FakeZipFile([shortEntry]);
    installBufferZip(short);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(/invalid uncompressed size/);
  });

  it('normalizes spool open, write, close, and partial-cleanup failures', async () => {
    const entries = [projectEntry(), assetEntry()];
    installPathZip(new FakeZipFile(entries));
    mocks.openFile.mockRejectedValueOnce(errno('EACCES'));
    await expect(loadArchive('input.sb3')).rejects.toThrowError(/cannot spool archive entry/);

    installPathZip(new FakeZipFile([projectEntry(), assetEntry()]));
    mocks.openFile.mockResolvedValueOnce(fakeFile({bytesWritten: 0}));
    await expect(loadArchive('input.sb3')).rejects.toThrowError(/spool write made no progress/);

    installPathZip(new FakeZipFile([projectEntry(), assetEntry()]));
    mocks.openFile.mockResolvedValueOnce(fakeFile({closeError: errno('EIO')}));
    await expect(loadArchive('input.sb3')).rejects.toThrowError(/cannot close spooled archive entry/);

    const streamFailure = new FakeZipFile([projectEntry(), assetEntry()]);
    streamFailure.streamError = errno('EIO');
    streamFailure.streamErrorName = 'asset.bin';
    installPathZip(streamFailure);
    mocks.openFile.mockResolvedValueOnce(fakeFile({closeError: errno('EIO')}));
    mocks.unlink.mockRejectedValueOnce(errno('EACCES'));
    await expect(loadArchive('input.sb3')).rejects.toThrowError(/cannot clean up a partial asset spool/);
  });

  it('reports idempotent archive cleanup failures with and without a preceding input error', async () => {
    installPathZip(new FakeZipFile([projectEntry(), assetEntry()]));
    const loaded = await loadArchive('input.sb3');
    mocks.rm.mockRejectedValueOnce(errno('EIO'));
    await expect(loaded.cleanup()).rejects.toThrowError(/cannot remove the input asset spool/);
    await expect(loaded.cleanup()).rejects.toThrowError(/cannot remove the input asset spool/);

    const malformed = new FakeZipFile([projectEntry()]);
    malformed.localError = new Error('bad header');
    installPathZip(malformed);
    mocks.rm.mockRejectedValueOnce(errno('EIO'));
    await expect(loadArchive('input.sb3')).rejects.toThrowError(/after invalid local ZIP header/);
  });
});

function installPathZip(zip: FakeZipFile): void {
  mocks.openPath.mockImplementation((_path: string, _options: unknown, callback: (error: Error | null, value?: FakeZipFile) => void) => callback(null, zip));
}

function installBufferZip(zip: FakeZipFile): void {
  mocks.fromBuffer.mockImplementation((_buffer: Buffer, _options: unknown, callback: (error: Error | null, value?: FakeZipFile) => void) => callback(null, zip));
}

function projectEntry(): FakeEntry {
  return entry('project.json', Buffer.from(JSON.stringify({targets: [], monitors: [], extensions: [], meta: {}})));
}

function assetEntry(): FakeEntry {
  return entry('asset.bin', Buffer.from('asset bytes'));
}

function entry(name: string, data: Buffer): FakeEntry {
  return {
    compressedSize: data.length,
    compressionMethod: 0,
    crc32: crc32(data),
    externalFileAttributes: 0,
    fileName: Buffer.from(name),
    generalPurposeBitFlag: 0,
    uncompressedSize: data.length,
    versionMadeBy: 0,
    data,
    isEncrypted: () => false
  };
}

function fakeFile(options: {bytesWritten?: number; closeError?: Error} = {}): {
  write: (bytes: Uint8Array, offset: number, length: number) => Promise<{bytesWritten: number}>;
  close: () => Promise<void>;
} {
  return {
    write: (_bytes, _offset, length) => Promise.resolve({bytesWritten: options.bytesWritten ?? length}),
    close: () => options.closeError === undefined ? Promise.resolve() : Promise.reject(options.closeError)
  };
}

function errno(code: string): NodeJS.ErrnoException & Error {
  const error = new Error(code) as NodeJS.ErrnoException & Error;
  error.code = code;
  return error;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
