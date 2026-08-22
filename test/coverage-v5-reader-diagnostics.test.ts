import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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
  data: Buffer;
  externalFileAttributes: number;
  fileName: Buffer;
  generalPurposeBitFlag: number;
  uncompressedSize: number;
  versionMadeBy: number;
  isEncrypted(): boolean;
}

class DiagnosticZip extends EventEmitter {
  readonly entryCount: number;
  readonly entries: FakeEntry[];
  localFailure: unknown;
  streamFailure: unknown;
  chunks: readonly Uint8Array[] | undefined;

  constructor(entries: readonly FakeEntry[]) {
    super();
    this.entries = [...entries];
    this.entryCount = entries.length;
  }

  close(): void {}

  readEntry(): void {
    queueMicrotask(() => {
      const entry = this.entries.shift();
      if (entry === undefined) this.emit('end');
      else this.emit('entry', entry);
    });
  }

  readLocalFileHeader(entry: FakeEntry, _options: unknown, callback: (error: unknown, value?: unknown) => void): void {
    if (this.localFailure !== undefined) {
      callback(this.localFailure);
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

  openReadStream(entry: FakeEntry, callback: (error: unknown, stream?: Readable) => void): void {
    if (this.streamFailure !== undefined) {
      callback(this.streamFailure);
      return;
    }
    callback(null, Readable.from(this.chunks ?? [entry.data]));
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdtemp.mockResolvedValue('C:\\diagnostic-spool');
  mocks.rm.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
});

describe('v5 archive diagnostic coverage', () => {
  it('reads generic Uint8Array stream chunks without Buffer-only assumptions', async () => {
    const entry = projectEntry();
    const zip = new DiagnosticZip([entry]);
    zip.chunks = [new Uint8Array(entry.data)];
    installBufferZip(zip);

    const loaded = await loadArchiveBuffer(new Uint8Array());
    expect(loaded.project).toEqual({format: 'uint8-array-stream'});
    expect(loaded.entries[0]?.content.kind).toBe('memory');
  });

  it('normalizes non-Error local-header and decompressor callback failures', async () => {
    const local = new DiagnosticZip([projectEntry()]);
    local.localFailure = 'header token';
    installBufferZip(local);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(
      'invalid local ZIP header for "project.json": header token'
    );

    const stream = new DiagnosticZip([projectEntry()]);
    stream.streamFailure = 'stream token';
    installBufferZip(stream);
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError(
      'cannot decompress archive entry "project.json"'
    );
  });

  it('normalizes non-Error ZIP-open and spool-directory failures', async () => {
    mocks.fromBuffer.mockImplementation(
      (_buffer: Buffer, _options: unknown, callback: (error: unknown) => void) => callback('not a zip')
    );
    await expect(loadArchiveBuffer(new Uint8Array())).rejects.toThrowError('invalid SB3 ZIP archive');

    installPathZip(new DiagnosticZip([projectEntry()]));
    mocks.mkdtemp.mockRejectedValue('spool denied');
    await expect(loadArchive('input.sb3')).rejects.toThrowError(
      'cannot create the input asset spool: spool denied'
    );
  });

  it('reports a non-Error cleanup rejection after a successful path-backed read', async () => {
    installPathZip(new DiagnosticZip([projectEntry()]));
    const loaded = await loadArchive('input.sb3');
    mocks.rm.mockRejectedValue('cleanup denied');

    await expect(loaded.cleanup()).rejects.toThrowError(
      'cannot remove the input asset spool: cleanup denied'
    );
  });
});

function installBufferZip(zip: DiagnosticZip): void {
  mocks.fromBuffer.mockImplementation(
    (_buffer: Buffer, _options: unknown, callback: (error: null, value: DiagnosticZip) => void) => callback(null, zip)
  );
}

function installPathZip(zip: DiagnosticZip): void {
  mocks.openPath.mockImplementation(
    (_path: string, _options: unknown, callback: (error: null, value: DiagnosticZip) => void) => callback(null, zip)
  );
}

function projectEntry(): FakeEntry {
  const data = Buffer.from(JSON.stringify({format: 'uint8-array-stream'}));
  return {
    compressedSize: data.length,
    compressionMethod: 0,
    crc32: crc32(data),
    data,
    externalFileAttributes: 0,
    fileName: Buffer.from('project.json'),
    generalPurposeBitFlag: 0,
    uncompressedSize: data.length,
    versionMadeBy: 0,
    isEncrypted: () => false
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
