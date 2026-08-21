import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync} from 'fflate';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseCliArguments, runCli} from '../src/cli.js';
import {UsageError} from '../src/errors.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('additional argument forms', () => {
  it('supports long output syntax, repeated same mode, and informational precedence', () => {
    expect(parseCliArguments(['--lossy', '--lossy', '--output=out.sb3', 'in.sb3'])).toMatchObject({mode: 'lossy', output: 'out.sb3'});
    expect(parseCliArguments(['--wat', '--help'])).toEqual({kind: 'help'});
    expect(parseCliArguments(['--wat', '--version'])).toEqual({kind: 'version'});
  });

  it('rejects empty/repeated output and options after end-of-options become inputs', () => {
    expect(() => parseCliArguments(['in.sb3', '--output='])).toThrow(UsageError);
    expect(() => parseCliArguments(['in.sb3', '-o', 'a.sb3', '--output=b.sb3'])).toThrow(UsageError);
    expect(() => parseCliArguments(['--', 'in.sb3', '--force'])).toThrow(UsageError);
  });
});

describe('CLI error mapping and output behavior', () => {
  it('maps missing files to 4 and malformed/invalid inputs to 3', async () => {
    const directory = await temporaryDirectory();
    const capture = collectingIo();
    expect(await runCli([join(directory, 'missing.sb3')], capture.io)).toBe(4);
    const malformed = join(directory, 'malformed.sb3');
    await writeFile(malformed, 'not a zip');
    expect(await runCli([malformed], capture.io)).toBe(3);
    const invalidProject = join(directory, 'invalid-project.sb3');
    await writeFile(invalidProject, zipSync({'project.json': Buffer.from('{}')}, zipOptions()));
    expect(await runCli([invalidProject], capture.io)).toBe(3);
    const missingAsset = join(directory, 'missing-asset.sb3');
    await writeFile(missingAsset, zipSync({'project.json': Buffer.from(JSON.stringify(minimalProject()))}, zipOptions()));
    expect(await runCli([missingAsset], capture.io)).toBe(3);
    expect(capture.stderr.join('')).toContain('error:');
  });

  it('uses the default output, refuses it on the next run, and replaces it with force', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'project.sb3');
    const output = join(directory, 'project.obfuscated.sb3');
    await writeFile(input, validArchive());
    const capture = collectingIo();
    expect(await runCli([input], capture.io), capture.stderr.join('')).toBe(0);
    const first = await readFile(output);
    expect(await runCli([input], capture.io)).toBe(2);
    expect(await runCli([input, '--force'], capture.io)).toBe(0);
    expect(await readFile(output)).toEqual(first);
    expect(capture.stdout.join('')).toContain('mode=lossless');
    expect(capture.stdout.join('')).toContain('anticheat=off');
  });

  it('runs a non-default mode and rejects input/output identity', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'project.sb3');
    await writeFile(input, validArchive());
    const capture = collectingIo();
    expect(await runCli([input, '-lossy', '-o', join(directory, 'lossy.sb3')], capture.io), capture.stderr.join('')).toBe(0);
    expect(await runCli([input, '-o', input, '--force'], capture.io)).toBe(2);
  });

  it('maps output directory errors to 4', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'project.sb3');
    const output = join(directory, 'output.sb3');
    await writeFile(input, validArchive());
    await mkdir(output);
    expect(await runCli([input, '-o', output, '--force'], collectingIo().io)).toBe(4);
  });

  it('maps an unexpected presentation failure to 5', async () => {
    const stderr: string[] = [];
    const code = await runCli(['--help'], {
      stdout: () => {
        throw new Error('broken output');
      },
      stderr: text => stderr.push(text)
    });
    expect(code).toBe(5);
    expect(stderr.join('')).toContain('unexpected failure: broken output');
  });

  it('uses the default process streams and maps raw errno failures to 4', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runCli(['--version'])).toBe(0);
    expect(await runCli([])).toBe(2);
    expect(stdout).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();

    const error = new Error('synthetic I/O failure') as NodeJS.ErrnoException;
    error.code = 'EIO';
    const messages: string[] = [];
    expect(await runCli(['--help'], {stdout: () => { throw error; }, stderr: text => messages.push(text)})).toBe(4);
    expect(messages.join('')).toContain('filesystem failure');
  });

  it('prints transformation warnings without exposing rename data', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'warning.sb3');
    const output = join(directory, 'warning-output.sb3');
    const project = minimalProject();
    const targets = project['targets'] as Array<Record<string, unknown>>;
    const stage = targets[0];
    if (stage === undefined) throw new Error('fixture stage is missing');
    stage['variables'] = {variable: ['Score', 0]};
    stage['blocks'] = {
      sensing: {
        opcode: 'sensing_of',
        next: null,
        parent: null,
        inputs: {OBJECT: [1, [10, 'Stage']]},
        fields: {PROPERTY: ['Score']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      }
    };
    const assetName = '00000000000000000000000000000000.svg';
    await writeFile(input, zipSync({
      'project.json': Buffer.from(JSON.stringify(project)),
      [assetName]: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    }, zipOptions()));
    const capture = collectingIo();
    expect(await runCli([input, '-o', output], capture.io), capture.stderr.join('')).toBe(0);
    expect(capture.stderr.join('')).toContain('warning:');
  });
});

function collectingIo(): {stdout: string[]; stderr: string[]; io: {stdout: (text: string) => void; stderr: (text: string) => void}} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {stdout, stderr, io: {stdout: text => stdout.push(text), stderr: text => stderr.push(text)}};
}

function validArchive(): Uint8Array {
  return zipSync({
    'project.json': Buffer.from(JSON.stringify(minimalProject())),
    '00000000000000000000000000000000.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  }, zipOptions());
}

function zipOptions(): {level: 9; mtime: Date} {
  return {level: 9, mtime: new Date(1980, 0, 1)};
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-errors-'));
  directories.push(directory);
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
      costumes: [{assetId: '00000000000000000000000000000000', name: 'backdrop1', dataFormat: 'svg', md5ext: '00000000000000000000000000000000.svg', rotationCenterX: 0, rotationCenterY: 0}],
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
    meta: {semver: '3.0.0', vm: '5.0.0', agent: 'test'}
  };
}
