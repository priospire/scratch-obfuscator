import {mkdtemp, readFile, rm, writeFile, link as makeHardlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it} from 'vitest';
import {zipSync} from 'fflate';
import {
  commitOutput,
  deriveArchiveSeed,
  deriveModeSeed,
  loadArchiveBuffer,
  parseUniqueJson,
  prepareOutput,
  validateReferencedAssets,
  writeDeterministicArchive
} from '../src/archive/index.js';
import {InputError, UsageError} from '../src/errors.js';
import type {ArchiveEntry} from '../src/types.js';

const temporaryDirectories: string[] = [];
const fixedZipOptions = {level: 9 as const, mtime: new Date(1980, 0, 1)};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('duplicate-safe JSON parser', () => {
  it('accepts ordinary nested JSON', () => {
    expect(parseUniqueJson(Buffer.from('{"a":[1,{"b":true}],"c":null}'))).toEqual({a: [1, {b: true}], c: null});
  });

  it('rejects duplicate decoded member names', () => {
    expect(() => parseUniqueJson(Buffer.from('{"a":1,"\\u0061":2}'))).toThrowError(/duplicate object member "a"/);
  });

  it('rejects malformed UTF-8 and malformed JSON', () => {
    expect(() => parseUniqueJson(Uint8Array.of(0xc3, 0x28))).toThrowError(/not valid UTF-8/);
    expect(() => parseUniqueJson(Buffer.from('{"a":01}'))).toThrowError(/not valid JSON/);
    expect(() => parseUniqueJson(Buffer.from('{"a":1e400}'))).toThrowError(/finite JavaScript range/);
  });
});

describe('bounded SB3 reading', () => {
  it('loads project.json and preserves asset bytes', async () => {
    const asset = Uint8Array.of(0, 1, 2, 127, 128, 255);
    const archive = zipSync({
      'project.json': Buffer.from(JSON.stringify(minimalProject())),
      'asset.svg': asset
    }, fixedZipOptions);
    const loaded = await loadArchiveBuffer(archive);
    expect(loaded.project.meta['semver']).toBe('3.0.0');
    const loadedAsset = loaded.entries.find(entry => entry.name === 'asset.svg');
    expect(loadedAsset).toBeDefined();
    expect(loadedAsset?.content.kind).toBe('memory');
    expect(Buffer.from(loadedAsset?.content.kind === 'memory' ? loadedAsset.content.data : [])).toEqual(Buffer.from(asset));
  });

  it('requires every costume and sound descriptor to resolve to an entry', async () => {
    const project = minimalProject();
    const archive = zipSync({
      'project.json': Buffer.from(JSON.stringify(project)),
      'asset.svg': Buffer.from('<svg/>')
    }, fixedZipOptions);
    const loaded = await loadArchiveBuffer(archive);
    expect(() => validateReferencedAssets(loaded.project, loaded.entries)).not.toThrow();
    const withoutAsset = loaded.entries.filter(value => value.name !== 'asset.svg');
    expect(() => validateReferencedAssets(loaded.project, withoutAsset)).toThrowError(/missing archive entry "asset.svg"/);
  });

  it('rejects duplicate/case-colliding and traversal names', async () => {
    const project = Buffer.from(JSON.stringify(minimalProject()));
    const collision = zipSync({'project.json': project, 'PROJECT.JSON': project}, fixedZipOptions);
    await expect(loadArchiveBuffer(collision)).rejects.toThrowError(/collide by case or normalization/);

    const traversal = zipSync({'project.json': project, '../asset.svg': Uint8Array.of(1)}, fixedZipOptions);
    await expect(loadArchiveBuffer(traversal)).rejects.toThrowError(/unsafe archive entry path/);
  });

  it('rejects duplicate JSON members and configured inflation excess', async () => {
    const duplicate = zipSync({'project.json': Buffer.from('{"targets":[],"targets":[]}')}, fixedZipOptions);
    await expect(loadArchiveBuffer(duplicate)).rejects.toThrowError(/duplicate object member/);

    const compressed = zipSync({
      'project.json': Buffer.from(JSON.stringify(minimalProject())),
      'asset.txt': Buffer.alloc(4096, 65)
    }, fixedZipOptions);
    await expect(loadArchiveBuffer(compressed, {
      maxEntries: 10,
      maxProjectBytes: 1024 * 1024,
      maxEntryBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
      maxTotalCompressedBytes: 2 * 1024 * 1024,
      maxInflationRatio: 2,
      maxPathComponents: 4
    })).rejects.toThrowError(/inflation limit/);
  });
});

describe('deterministic archive encoding and seed derivation', () => {
  it('derives a seed independent of ZIP metadata and source entry ordering', () => {
    const projectBytes = Buffer.from(JSON.stringify(minimalProject()));
    const first = entry('project.json', projectBytes, 1);
    const asset = entry('asset.svg', Uint8Array.of(4, 5, 6), 2);
    const changedMetadata = {...asset, compressedSize: 999};
    expect(Buffer.from(deriveArchiveSeed(projectBytes, [first, asset]))).toEqual(
      Buffer.from(deriveArchiveSeed(projectBytes, [changedMetadata, {...first, compressedSize: 123}]))
    );
    expect(Buffer.from(deriveModeSeed(deriveArchiveSeed(projectBytes, [first, asset]), 'lossless'))).not.toEqual(
      Buffer.from(deriveModeSeed(deriveArchiveSeed(projectBytes, [first, asset]), 'lossy'))
    );
    expect(() => deriveArchiveSeed({length: -1} as unknown as Uint8Array, [])).toThrow(RangeError);
  });

  it('writes byte-identical archives and preserves uncompressed assets', async () => {
    const directory = await temporaryDirectory();
    const projectBytes = Buffer.from(JSON.stringify(minimalProject()));
    const source = [
      entry('z.bin', Uint8Array.of(255, 0, 17), 3),
      entry('project.json', projectBytes, projectBytes.length),
      entry('a.svg', Buffer.from('<svg/>'), 6)
    ];
    const firstPath = join(directory, 'first.sb3');
    const secondPath = join(directory, 'second.sb3');
    await writeDeterministicArchive(firstPath, projectBytes, source);
    await writeDeterministicArchive(secondPath, projectBytes, [...source].reverse());
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    const reopened = await loadArchiveBuffer(await readFile(firstPath));
    const loadedAsset = reopened.entries.find(value => value.name === 'z.bin');
    expect(loadedAsset).toBeDefined();
    expect(Buffer.from(loadedAsset?.content.kind === 'memory' ? loadedAsset.content.data : [])).toEqual(Buffer.from([255, 0, 17]));
  });
});

describe('output safety and transactions', () => {
  it('uses the default name and rejects an existing output without force', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'demo.sb3');
    const output = join(directory, 'demo.obfuscated.sb3');
    await writeFile(input, 'source');
    await writeFile(output, 'old');
    await expect(prepareOutput(input, undefined, false)).rejects.toBeInstanceOf(UsageError);
    const prepared = await prepareOutput(input, undefined, true);
    expect(prepared.outputPath).toBe(output);
  });

  it('rejects hardlinked input/output identity', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await writeFile(input, 'source');
    await makeHardlink(input, output);
    await expect(prepareOutput(input, output, true)).rejects.toBeInstanceOf(UsageError);
  });

  it('commits a new output and leaves an old output untouched when verification fails', async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, 'output.sb3');
    await commitOutput(output, false, path => writeFile(path, 'new'), async path => {
      expect(await readFile(path, 'utf8')).toBe('new');
    });
    expect(await readFile(output, 'utf8')).toBe('new');

    await expect(commitOutput(output, true, path => writeFile(path, 'replacement'), () => {
      throw new InputError('verification failed');
    })).rejects.toThrowError(/verification failed/);
    expect(await readFile(output, 'utf8')).toBe('new');
  });
});

function entry(name: string, data: Uint8Array, compressedSize: number): ArchiveEntry {
  return {
    name,
    content: {kind: 'memory', data},
    contentHash: createHash('sha256').update(data).digest(),
    compressedSize,
    uncompressedSize: data.length
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-archive-'));
  temporaryDirectories.push(directory);
  return directory;
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
      costumes: [{assetId: 'asset', name: 'backdrop1', dataFormat: 'svg', md5ext: 'asset.svg', rotationCenterX: 0, rotationCenterY: 0}],
      sounds: [],
      volume: 100,
      layerOrder: 0,
      tempo: 60,
      videoTransparency: 50,
      videoState: 'on',
      textToSpeechLanguage: null
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: 'test', agent: ''}
  };
}
