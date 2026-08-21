import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Zip, ZipPassThrough, zipSync, type Zippable} from 'fflate';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadArchive, loadArchiveBuffer, parseUniqueJson} from '../src/archive/index.js';
import {FileSystemError} from '../src/errors.js';
import {DEFAULT_LIMITS} from '../src/types.js';

const directories: string[] = [];
const projectBytes = Buffer.from(JSON.stringify(minimalProject()));
const zipOptions = {level: 9 as const, mtime: new Date(1980, 0, 1)};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('strict JSON syntax coverage', () => {
  it('accepts every JSON value and escape form', () => {
    const value = parseUniqueJson(Buffer.from(` \r\n\t {"empty":{},"array":[],"values":[true,false,null,-1,0,1,1.5,1e2,1E+2,1e-2,"\\"\\\\\\/\\b\\f\\n\\r\\t\\u0061"]} `));
    expect(value).toMatchObject({empty: {}, array: []});
  });

  it.each([
    ['trailing input', 'true false', /trailing data/],
    ['missing value', '?', /expected a JSON value/],
    ['missing member name', '{a:1}', /object member name/],
    ['missing colon', '{"a" 1}', /expected a colon/],
    ['missing object comma', '{"a":1 "b":2}', /comma or closing brace/],
    ['missing array comma', '[1 2]', /comma or closing bracket/],
    ['unterminated string', '"abc', /unterminated string/],
    ['bad Unicode escape', '"\\u12x4"', /invalid Unicode escape/],
    ['bad escape', '"\\x"', /invalid string escape/],
    ['control in string', '"\u0001"', /control character/],
    ['bad number', '-', /invalid number/],
    ['bad literal', 'tx', /invalid literal/]
  ])('rejects %s', (_label, source, pattern) => {
    expect(() => parseUniqueJson(Buffer.from(source))).toThrowError(pattern);
  });

  it('wraps native parser failures and key-decoding failures', () => {
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('synthetic key error');
    });
    expect(() => parseUniqueJson(Buffer.from('{"a":1}'), 'fixture.json')).toThrowError(/invalid object member name/);
    vi.restoreAllMocks();
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('synthetic final error');
    });
    expect(() => parseUniqueJson(Buffer.from('true'), 'fixture.json')).toThrowError(/not valid JSON/);
  });
});

describe('ZIP metadata and corruption rejection', () => {
  it('loads from a file path and maps path/open failures', async () => {
    const directory = await temporaryDirectory();
    const validPath = join(directory, 'valid.sb3');
    const asset = Buffer.from('file-backed asset');
    await writeFile(validPath, makeZip({'asset.svg': asset}));
    const loaded = await loadArchive(validPath);
    expect(loaded.project).toMatchObject({meta: {semver: '3.0.0'}});
    const loadedAsset = loaded.entries.find(entry => entry.name === 'asset.svg');
    expect(loadedAsset?.content.kind).toBe('file');
    if (loadedAsset?.content.kind !== 'file') throw new Error('expected a file-backed asset');
    const spoolPath = loadedAsset.content.path;
    expect(await readFile(spoolPath)).toEqual(asset);
    await Promise.all([loaded.cleanup(), loaded.cleanup()]);
    await expect(stat(spoolPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(loadArchive(join(directory, 'missing.sb3'))).rejects.toBeInstanceOf(FileSystemError);
    const invalidPath = join(directory, 'invalid.sb3');
    await writeFile(invalidPath, 'not a zip');
    await expect(loadArchive(invalidPath)).rejects.toThrowError(/invalid SB3 ZIP archive/);
    await expect(loadArchiveBuffer(Buffer.from('not a zip'))).rejects.toThrowError(/invalid SB3 ZIP archive/);
  });

  it('rejects entry-count, total-size, project-size, and entry-size limits', async () => {
    const withAsset = makeZip({'a.bin': Buffer.from('asset')});
    await expect(loadArchiveBuffer(withAsset, {...DEFAULT_LIMITS, maxEntries: 1})).rejects.toThrowError(/entries; limit/);
    await expect(loadArchiveBuffer(withAsset, {...DEFAULT_LIMITS, maxTotalBytes: projectBytes.length})).rejects.toThrowError(/uncompressed content exceeds/);
    await expect(loadArchiveBuffer(withAsset, {...DEFAULT_LIMITS, maxTotalCompressedBytes: 1})).rejects.toThrowError(/compressed content exceeds/);
    await expect(loadArchiveBuffer(makeZip(), {...DEFAULT_LIMITS, maxProjectBytes: 1})).rejects.toThrowError(/size limit/);
    await expect(loadArchiveBuffer(withAsset, {...DEFAULT_LIMITS, maxEntryBytes: 1})).rejects.toThrowError(/size limit/);
    await expect(loadArchiveBuffer(makeZip(), {...DEFAULT_LIMITS, maxPathComponents: 0})).rejects.toThrow(RangeError);
  });

  it('rejects missing, duplicate, and non-object project roots', async () => {
    await expect(loadArchiveBuffer(zipSync({'asset.txt': Buffer.from('x')}, zipOptions))).rejects.toThrowError(/exactly one root project.json/);
    await expect(loadArchiveBuffer(await duplicateZip('project.json', projectBytes))).rejects.toThrowError(/duplicate entry/);
    for (const root of ['null', '[]', '"text"']) {
      await expect(loadArchiveBuffer(zipSync({'project.json': Buffer.from(root)}, zipOptions))).rejects.toThrowError(/root must be an object/);
    }
  });

  it('rejects encryption, patching, unknown compression, and Unix symlinks', async () => {
    await expect(loadArchiveBuffer(patchFlags(makeZip(), 0x0001))).rejects.toThrowError(/encrypted archive entry/);
    await expect(loadArchiveBuffer(patchFlags(makeZip(), 0x0020))).rejects.toThrowError(/patched archive entry/);
    await expect(loadArchiveBuffer(patchCompression(makeZip(), 99))).rejects.toThrowError(/unsupported compression method 99/);
    const symlinkInput: Zippable = {
      'project.json': projectBytes,
      'link.txt': [Buffer.from('target'), {os: 3, attrs: 0o120777 * 0x10000}]
    };
    await expect(loadArchiveBuffer(zipSync(symlinkInput, zipOptions))).rejects.toThrowError(/symbolic-link archive entry/);
  });

  it.each([
    ['backslash', 'safe.txt', 'bad\\.txt', /unsafe archive entry name/],
    ['absolute slash', 'safe.txt', '/abs.txt', /absolute archive entry/],
    ['drive path', 'safe.txt', 'C:/x.txt', /absolute archive entry/],
    ['empty component', 'safe.txt', 'a//b.txt', /unsafe archive entry path/],
    ['dot component', 'safe.txt', 'a/./b.tx', /unsafe archive entry path/],
    ['parent component', 'safe.txt', 'a/../b.t', /unsafe archive entry path/]
  ])('rejects a %s name', async (_label, original, replacement, pattern) => {
    const archive = replaceEntryName(makeZip({[original]: Buffer.from('x')}), original, replacement);
    await expect(loadArchiveBuffer(archive)).rejects.toThrowError(pattern);
  });

  it('rejects over-deep paths, invalid UTF-8, and legacy non-ASCII names', async () => {
    const nested = makeZip({'a/b.txt': Buffer.from('x')});
    await expect(loadArchiveBuffer(nested, {...DEFAULT_LIMITS, maxPathComponents: 1})).rejects.toThrowError(/unsafe archive entry path/);

    const unicode = makeZip({'é.txt': Buffer.from('x')});
    await expect(loadArchiveBuffer(replaceRawBytes(unicode, Buffer.from('é.txt'), Buffer.from([0xc3, 0x28, 0x2e, 0x74, 0x78, 0x74])))).rejects.toThrowError(/invalid UTF-8 entry name/);
    await expect(loadArchiveBuffer(clearUtf8Flags(unicode))).rejects.toThrowError(/legacy non-ASCII/);
  });

  it('rejects CRC mismatch and corrupt compressed data', async () => {
    const stored = makeZip({'unique.bin': Buffer.from([0xde, 0xad, 0xbe, 0xef])}, 0);
    const crcMismatch = Buffer.from(stored);
    const location = crcMismatch.indexOf(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(location).toBeGreaterThan(0);
    crcMismatch[location] = (crcMismatch[location] ?? 0) ^ 0xff;
    await expect(loadArchiveBuffer(crcMismatch)).rejects.toThrowError(/CRC-32 check/);

    const deflated = Buffer.from(makeZip({'unique.bin': Buffer.alloc(128, 0xab)}, 9));
    const dataStart = localDataOffset(deflated, 1);
    deflated[dataStart] = (deflated[dataStart] ?? 0) ^ 0xff;
    await expect(loadArchiveBuffer(deflated)).rejects.toThrowError(/cannot decompress|invalid SB3 ZIP archive|CRC-32/);
  });

  it('rejects local-header metadata disagreement and declared-size corruption', async () => {
    const base = makeZip({'asset.bin': Buffer.alloc(64, 7)}, 0);
    await expect(loadArchiveBuffer(patchLocalField(base, 1, 6, 2, 0x0008))).rejects.toThrowError(/headers disagree on flags/);
    await expect(loadArchiveBuffer(patchLocalField(base, 1, 8, 2, 8))).rejects.toThrowError(/headers disagree on compression method/);
    await expect(loadArchiveBuffer(patchLocalField(base, 1, 14, 4, 0))).rejects.toThrowError(/headers disagree on CRC-32/);
    await expect(loadArchiveBuffer(patchLocalField(base, 1, 18, 4, 1))).rejects.toThrowError(/headers disagree on sizes/);
    const localNameMismatch = replaceLocalEntryName(base, 1, 'asset.bin', 'other.bin');
    await expect(loadArchiveBuffer(localNameMismatch)).rejects.toThrowError(/headers disagree on file name/);

    const tooSmall = patchCentralUncompressedSize(makeZip({'asset.bin': Buffer.alloc(64, 7)}, 0), 1, 1);
    await expect(loadArchiveBuffer(tooSmall)).rejects.toThrowError(/headers disagree|expanded beyond|cannot decompress|invalid uncompressed size|size mismatch/);
    const tooLarge = patchCentralUncompressedSize(makeZip({'asset.bin': Buffer.alloc(8, 7)}, 0), 1, 64);
    await expect(loadArchiveBuffer(tooLarge)).rejects.toThrowError(/headers disagree|cannot decompress|invalid uncompressed size|size mismatch/);
  });

  it('validates local ZIP64 sizes, including truncation and unsafe values', async () => {
    const base = makeZip();
    await expect(loadArchiveBuffer(withLocalZip64(base, 0, 'valid'))).resolves.toMatchObject({project: {meta: {semver: '3.0.0'}}});
    await expect(loadArchiveBuffer(patchLocalZip64Sentinels(base, 0))).rejects.toThrowError(/missing ZIP64 sizes/);
    await expect(loadArchiveBuffer(withLocalZip64(base, 0, 'truncated'))).rejects.toThrowError(/truncated ZIP64 size/);
    await expect(loadArchiveBuffer(withLocalZip64(base, 0, 'unsafe'))).rejects.toThrowError(/unsafe ZIP64 size/);
  });

  it('accepts unspecified local sizes and CRC when a data descriptor is declared', async () => {
    let archive = patchFlags(makeZip(), 0x0008);
    archive = patchLocalField(archive, 0, 14, 4, 0);
    archive = patchLocalField(archive, 0, 18, 4, 0xffffffff);
    archive = patchLocalField(archive, 0, 22, 4, 0xffffffff);
    await expect(loadArchiveBuffer(archive)).resolves.toMatchObject({project: {meta: {semver: '3.0.0'}}});
  });

  it('aborts a path load and removes its partial spool', async () => {
    const directory = await temporaryDirectory();
    const isolatedTemp = join(directory, 'spools');
    await import('node:fs/promises').then(module => module.mkdir(isolatedTemp));
    const archivePath = join(directory, 'large.sb3');
    await writeFile(archivePath, makeZip({'large.bin': Buffer.alloc(16 * 1024 * 1024, 0x5a)}, 0));
    const oldEnvironment = {TEMP: process.env['TEMP'], TMP: process.env['TMP'], TMPDIR: process.env['TMPDIR']};
    process.env['TEMP'] = isolatedTemp;
    process.env['TMP'] = isolatedTemp;
    process.env['TMPDIR'] = isolatedTemp;
    const controller = new AbortController();
    try {
      const loading = loadArchive(archivePath, DEFAULT_LIMITS, controller.signal);
      let observedSpool = false;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        if ((await readdir(isolatedTemp)).length > 0) {
          observedSpool = true;
          break;
        }
        await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2));
      }
      expect(observedSpool).toBe(true);
      controller.abort(new Error('test interruption'));
      await expect(loading).rejects.toThrowError(/interrupted/);
      expect(await readdir(isolatedTemp)).toEqual([]);
    } finally {
      restoreEnvironment('TEMP', oldEnvironment.TEMP);
      restoreEnvironment('TMP', oldEnvironment.TMP);
      restoreEnvironment('TMPDIR', oldEnvironment.TMPDIR);
    }
  });
});

function makeZip(extra: Record<string, Uint8Array> = {}, level: 0 | 9 = 9): Uint8Array {
  return zipSync({'project.json': projectBytes, ...extra}, {...zipOptions, level});
}

async function duplicateZip(name: string, data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const zip = new Zip((error, chunk, final) => {
      if (error !== null) {
        reject(error);
      } else if (chunk !== null) {
        chunks.push(Buffer.from(chunk));
        if (final) resolve(Buffer.concat(chunks));
      }
    });
    for (let index = 0; index < 2; index += 1) {
      const file = new ZipPassThrough(name);
      file.mtime = new Date(1980, 0, 1);
      zip.add(file);
      file.push(data, true);
    }
    zip.end();
  });
}

function patchFlags(input: Uint8Array, flag: number): Uint8Array {
  const output = Buffer.from(input);
  forEachSignature(output, 0x04034b50, offset => output.writeUInt16LE(output.readUInt16LE(offset + 6) | flag, offset + 6));
  forEachSignature(output, 0x02014b50, offset => output.writeUInt16LE(output.readUInt16LE(offset + 8) | flag, offset + 8));
  return output;
}

function clearUtf8Flags(input: Uint8Array): Uint8Array {
  const output = Buffer.from(input);
  forEachSignature(output, 0x04034b50, offset => output.writeUInt16LE(output.readUInt16LE(offset + 6) & ~0x800, offset + 6));
  forEachSignature(output, 0x02014b50, offset => output.writeUInt16LE(output.readUInt16LE(offset + 8) & ~0x800, offset + 8));
  return output;
}

function patchCompression(input: Uint8Array, method: number): Uint8Array {
  const output = Buffer.from(input);
  forEachSignature(output, 0x04034b50, offset => output.writeUInt16LE(method, offset + 8));
  forEachSignature(output, 0x02014b50, offset => output.writeUInt16LE(method, offset + 10));
  return output;
}

function patchCentralUncompressedSize(input: Uint8Array, entryIndex: number, size: number): Uint8Array {
  const output = Buffer.from(input);
  const offset = nthSignature(output, 0x02014b50, entryIndex);
  output.writeUInt32LE(size, offset + 24);
  return output;
}

function patchLocalField(input: Uint8Array, entryIndex: number, fieldOffset: number, byteLength: 2 | 4, value: number): Uint8Array {
  const output = Buffer.from(input);
  const offset = nthSignature(output, 0x04034b50, entryIndex) + fieldOffset;
  if (byteLength === 2) output.writeUInt16LE(value, offset);
  else output.writeUInt32LE(value, offset);
  return output;
}

function replaceLocalEntryName(input: Uint8Array, entryIndex: number, original: string, replacement: string): Uint8Array {
  if (original.length !== replacement.length) throw new Error('replacement must preserve byte length');
  const output = Buffer.from(input);
  const offset = nthSignature(output, 0x04034b50, entryIndex);
  const nameOffset = offset + 30;
  if (output.subarray(nameOffset, nameOffset + original.length).toString() !== original) throw new Error('unexpected local entry name');
  output.write(replacement, nameOffset, 'utf8');
  return output;
}

function patchLocalZip64Sentinels(input: Uint8Array, entryIndex: number): Uint8Array {
  const output = Buffer.from(input);
  const offset = nthSignature(output, 0x04034b50, entryIndex);
  output.writeUInt32LE(0xffffffff, offset + 18);
  output.writeUInt32LE(0xffffffff, offset + 22);
  return output;
}

function withLocalZip64(input: Uint8Array, entryIndex: number, variant: 'valid' | 'truncated' | 'unsafe'): Uint8Array {
  const original = Buffer.from(input);
  const localOffset = nthSignature(original, 0x04034b50, entryIndex);
  const nameLength = original.readUInt16LE(localOffset + 26);
  const oldExtraLength = original.readUInt16LE(localOffset + 28);
  const insertionOffset = localOffset + 30 + nameLength + oldExtraLength;
  const centralOffset = nthSignature(original, 0x02014b50, 0);
  const compressedSize = original.readUInt32LE(localOffset + 18);
  const uncompressedSize = original.readUInt32LE(localOffset + 22);
  const payloadLength = variant === 'truncated' ? 8 : 16;
  const extra = Buffer.alloc(4 + payloadLength);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(payloadLength, 2);
  extra.writeBigUInt64LE(variant === 'unsafe' ? 1n << 53n : BigInt(uncompressedSize), 4);
  if (payloadLength === 16) extra.writeBigUInt64LE(BigInt(compressedSize), 12);

  const output = Buffer.concat([original.subarray(0, insertionOffset), extra, original.subarray(insertionOffset)]);
  output.writeUInt16LE(oldExtraLength + extra.length, localOffset + 28);
  output.writeUInt32LE(0xffffffff, localOffset + 18);
  output.writeUInt32LE(0xffffffff, localOffset + 22);
  const endOffset = nthSignature(output, 0x06054b50, 0);
  output.writeUInt32LE(centralOffset + extra.length, endOffset + 16);
  return output;
}

function replaceEntryName(input: Uint8Array, original: string, replacement: string): Uint8Array {
  return replaceRawBytes(input, Buffer.from(original), Buffer.from(replacement));
}

function replaceRawBytes(input: Uint8Array, original: Buffer, replacement: Buffer): Uint8Array {
  if (original.length !== replacement.length) throw new Error('replacement must preserve byte length');
  const output = Buffer.from(input);
  let position = 0;
  let replacements = 0;
  while ((position = output.indexOf(original, position)) >= 0) {
    replacement.copy(output, position);
    position += replacement.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error('expected local and central filenames');
  return output;
}

function forEachSignature(buffer: Buffer, signature: number, callback: (offset: number) => void): void {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(signature);
  let position = 0;
  while ((position = buffer.indexOf(marker, position)) >= 0) {
    callback(position);
    position += marker.length;
  }
}

function nthSignature(buffer: Buffer, signature: number, index: number): number {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(signature);
  let offset = -1;
  for (let current = 0; current <= index; current += 1) offset = buffer.indexOf(marker, offset + 1);
  if (offset < 0) throw new Error('ZIP signature not found');
  return offset;
}

function localDataOffset(buffer: Buffer, localIndex: number): number {
  const marker = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = -1;
  for (let index = 0; index <= localIndex; index += 1) offset = buffer.indexOf(marker, offset + 1);
  if (offset < 0) throw new Error('local header not found');
  return offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-security-'));
  directories.push(directory);
  return directory;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function minimalProject(): Record<string, unknown> {
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
