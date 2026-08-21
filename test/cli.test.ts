import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync, zipSync} from 'fflate';
import {afterEach, describe, expect, it} from 'vitest';
import {parseCliArguments, runCli} from '../src/cli.js';
import {UsageError} from '../src/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('CLI argument contract', () => {
  it('defaults to lossless and accepts requested single-hyphen flags', () => {
    expect(parseCliArguments(['input.sb3'])).toMatchObject({kind: 'run', input: 'input.sb3', mode: 'lossless', antiCheat: false, force: false});
    expect(parseCliArguments(['input.sb3', '-lossy', '--force'])).toMatchObject({mode: 'lossy', force: true});
    expect(parseCliArguments(['-no-preserve', '-o', 'out.sb3', 'input.sb3'])).toMatchObject({mode: 'no-preserve', output: 'out.sb3'});
  });

  it('accepts anti-cheat independently of every mode', () => {
    expect(parseCliArguments(['input.sb3', '-anticheat'])).toMatchObject({mode: 'lossless', antiCheat: true});
    expect(parseCliArguments(['input.sb3', '--lossy', '--anticheat'])).toMatchObject({mode: 'lossy', antiCheat: true});
    expect(parseCliArguments(['--no-preserve', '-anticheat', 'input.sb3'])).toMatchObject({mode: 'no-preserve', antiCheat: true});
    expect(parseCliArguments(['input.sb3', '--anticheat', '-anticheat'])).toMatchObject({antiCheat: true});
  });

  it('rejects mode conflicts, missing values, unknown options, and extra inputs', () => {
    expect(() => parseCliArguments(['--lossless', '--lossy', 'input.sb3'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '-o'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '-o', '--lossy'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '--wat'])).toThrow(UsageError);
    expect(() => parseCliArguments(['a.sb3', 'b.sb3'])).toThrow(UsageError);
  });

  it('supports end-of-options for input names beginning with a hyphen', () => {
    expect(parseCliArguments(['--', '-project.sb3'])).toMatchObject({input: '-project.sb3'});
  });

  it('prints help/version and maps usage failures to exit code 2', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text)};
    expect(await runCli(['--help'], io)).toBe(0);
    expect(stdout.join('')).toContain('Usage: scratch-obfuscator');
    expect(stdout.join('')).toContain('-anticheat, --anticheat');
    stdout.length = 0;
    expect(await runCli(['--version'], io)).toBe(0);
    const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {version: string};
    expect(stdout.join('')).toBe(`${packageMetadata.version}\n`);
    expect(await runCli([], io)).toBe(2);
    expect(stderr.join('')).toContain('exactly one input');
  });
});

describe('CLI archive integration', () => {
  it('obfuscates deterministically and refuses replacement without --force', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    const first = join(directory, 'first.sb3');
    const second = join(directory, 'second.sb3');
    const protectedOutput = join(directory, 'protected.sb3');
    const project = {
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
    await writeFile(input, zipSync({
      'project.json': Buffer.from(JSON.stringify(project)),
      '00000000000000000000000000000000.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    }, {level: 9, mtime: new Date(1980, 0, 1)}));
    const output: string[] = [];
    const errors: string[] = [];
    const io = {stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text)};

    expect(await runCli([input, '-o', first], io), errors.join('')).toBe(0);
    expect(await runCli([input, '--lossless', '-o', second], io)).toBe(0);
    expect(await readFile(first)).toEqual(await readFile(second));
    const plainArchive = unzipSync(await readFile(first));
    const plainProjectBytes = plainArchive['project.json'];
    if (plainProjectBytes === undefined) throw new Error('plain output is missing project.json');
    const plainProject = JSON.parse(Buffer.from(plainProjectBytes).toString('utf8')) as {
      targets: Array<{variables: Record<string, [string, unknown]>}>;
    };
    expect(Object.values(plainProject.targets[0]?.variables ?? {})
      .filter(([name]) => name === 'Obfuscated by PrioSDK Gen 4.')).toHaveLength(1);
    expect(await runCli([input, '-anticheat', '-o', protectedOutput], io)).toBe(0);
    const protectedArchive = unzipSync(await readFile(protectedOutput));
    const projectBytes = protectedArchive['project.json'];
    if (projectBytes === undefined) throw new Error('protected output is missing project.json');
    const protectedProject = JSON.parse(Buffer.from(projectBytes).toString('utf8')) as {
      targets: Array<{variables: Record<string, [string, unknown]>}>;
    };
    const protectedStage = protectedProject.targets[0];
    expect(protectedStage).toBeDefined();
    expect(Object.values(protectedStage?.variables ?? {})
      .filter(([name]) => name === 'Obfuscated by PrioSDK Gen 4.')).toHaveLength(1);
    expect(output.join('')).toContain('anticheat=on');
    expect(output.join('')).toMatch(/packed=\d+, folded=\d+, fallbacks=\d+/u);
    expect(await runCli([input, '-o', first], io)).toBe(2);
    expect(errors.join('')).toContain('output already exists');
  });
});
