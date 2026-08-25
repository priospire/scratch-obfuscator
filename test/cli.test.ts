import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync, zipSync} from 'fflate';
import {afterEach, describe, expect, it} from 'vitest';
import {parseCliArguments, runCli} from '../src/cli.js';
import {UsageError} from '../src/errors.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject, readProjectFromArchive} from './support.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('CLI argument contract', () => {
  it('defaults to lossless and accepts requested single-hyphen flags', () => {
    expect(parseCliArguments(['input.sb3'])).toMatchObject({
      kind: 'run', input: 'input.sb3', mode: 'lossless', antiCheat: false, allowSize: false,
      extra: false, extraLevel: 0, force: false
    });
    expect(parseCliArguments(['input.sb3', '-lossy', '--force'])).toMatchObject({mode: 'lossy', force: true});
    expect(parseCliArguments(['-no-preserve', '-o', 'out.sb3', 'input.sb3'])).toMatchObject({mode: 'no-preserve', output: 'out.sb3'});
  });

  it('accepts anti-cheat independently of every mode', () => {
    expect(parseCliArguments(['input.sb3', '-anticheat'])).toMatchObject({mode: 'lossless', antiCheat: true});
    expect(parseCliArguments(['input.sb3', '--lossy', '--anticheat'])).toMatchObject({mode: 'lossy', antiCheat: true});
    expect(parseCliArguments(['--no-preserve', '-anticheat', 'input.sb3'])).toMatchObject({mode: 'no-preserve', antiCheat: true});
    expect(parseCliArguments(['input.sb3', '--anticheat', '-anticheat'])).toMatchObject({antiCheat: true});
  });

  it('accepts expanded growth independently of every mode and modifier', () => {
    expect(parseCliArguments(['input.sb3', '-allowsize'])).toMatchObject({mode: 'lossless', allowSize: true});
    expect(parseCliArguments(['input.sb3', '--lossy', '--allowsize'])).toMatchObject({
      mode: 'lossy', allowSize: true
    });
    expect(parseCliArguments([
      '--no-preserve', '-anticheat', '-extra', '-allowsize', 'input.sb3'
    ])).toMatchObject({mode: 'no-preserve', antiCheat: true, extra: true, allowSize: true});
    expect(parseCliArguments(['input.sb3', '--allowsize', '-allowsize'])).toMatchObject({allowSize: true});
    expect(() => parseCliArguments(['input.sb3', '--allowsize=max'])).toThrow(UsageError);
  });

  it('accepts extra level 2 only as a separate exact token and repeated flags take the maximum', () => {
    expect(parseCliArguments(['input.sb3', '-extra'])).toMatchObject({extra: true, extraLevel: 1});
    expect(parseCliArguments(['--extra', '2', 'input.sb3'])).toMatchObject({extra: true, extraLevel: 2});
    expect(parseCliArguments(['input.sb3', '-extra', '2'])).toMatchObject({extra: true, extraLevel: 2});
    expect(parseCliArguments(['-extra', '2', '--extra', 'input.sb3'])).toMatchObject({
      extra: true,
      extraLevel: 2
    });
    expect(parseCliArguments(['--extra', '-extra', '2', 'input.sb3'])).toMatchObject({
      extra: true,
      extraLevel: 2
    });
    expect(() => parseCliArguments(['input.sb3', '--extra=2'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '-extra=2'])).toThrow(UsageError);
    expect(() => parseCliArguments(['input.sb3', '-extra', '1'])).toThrow(UsageError);
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
    for (const input of ['-lossy', '-no-preserve', '-anticheat', '-allowsize', '-extra', '-verbose=max', '--help']) {
      expect(parseCliArguments(['--', input])).toMatchObject({input, mode: 'lossless'});
    }
    expect(parseCliArguments(['-extra', '--', '2'])).toMatchObject({
      input: '2',
      extra: true,
      extraLevel: 1
    });
  });

  it('prints help/version and maps usage failures to exit code 2', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text)};
    expect(await runCli(['--help'], io)).toBe(0);
    expect(stdout.join('')).toContain('Usage: scratch-obfuscator');
    expect(stdout.join('')).toContain('-anticheat, --anticheat');
    expect(stdout.join('')).toContain('-allowsize, --allowsize');
    expect(stdout.join('')).toContain('-extra, --extra [2]');
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
    const expandedFirst = join(directory, 'expanded-first.sb3');
    const expandedSecond = join(directory, 'expanded-second.sb3');
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
    expect(await runCli([input, '-allowsize', '-o', expandedFirst], io)).toBe(0);
    expect(await runCli([input, '--lossless', '--allowsize', '-o', expandedSecond], io)).toBe(0);
    expect(await readFile(expandedFirst)).toEqual(await readFile(expandedSecond));
    expect(await readFile(expandedFirst)).toEqual(await readFile(first));
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
    expect(output.join('')).toContain('allowsize=on');
    expect(output.join('')).toMatch(/packed=\d+, folded=\d+, fallbacks=\d+/u);
    expect(await runCli([input, '-o', first], io)).toBe(2);
    expect(errors.join('')).toContain('output already exists');
  });

  it('emits byte-identical expanded lossy output for both flag spellings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-allowsize-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    const first = join(directory, 'first.sb3');
    const second = join(directory, 'second.sb3');
    await writeFile(input, createFixtureArchive(createFixtureProject()));
    const firstIo = {stdout: () => undefined, stderr: () => undefined};
    const secondIo = {stdout: () => undefined, stderr: () => undefined};

    expect(await runCli([input, '-lossy', '-allowsize', '-o', first], firstIo)).toBe(0);
    expect(await runCli([input, '--lossy', '--allowsize', '-o', second], secondIo)).toBe(0);
    expect(await readFile(first)).toEqual(await readFile(second));
  });

  it('wires extra level 2 through both spellings and reports its disruptive contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-extra2-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    const first = join(directory, 'first.sb3');
    const second = join(directory, 'second.sb3');
    await writeFile(input, createFixtureArchive(createFixtureProject()));
    const firstOutput: string[] = [];
    const firstDiagnostics: string[] = [];
    const secondDiagnostics: string[] = [];

    expect(await runCli([input, '-extra', '2', '-o', first], {
      stdout: text => firstOutput.push(text),
      stderr: text => firstDiagnostics.push(text)
    }), firstDiagnostics.join('')).toBe(0);
    expect(await runCli([input, '--extra', '2', '-o', second], {
      stdout: () => undefined,
      stderr: text => secondDiagnostics.push(text)
    }), secondDiagnostics.join('')).toBe(0);

    expect(await readFile(first)).toEqual(await readFile(second));
    expect(firstOutput.join('')).toContain('extra=2');
    expect(firstDiagnostics.join('')).toContain('Affected stacks do not execute');
    expect(firstDiagnostics.join('')).toContain('does not prevent saving');
    const transformed = readProjectFromArchive(await readFile(first));
    const eventHats = transformed.targets.flatMap(target => Object.values(target.blocks))
      .filter(isScratchBlock)
      .filter(block => block.topLevel && block.opcode.startsWith('event_'));
    expect(eventHats.length).toBeGreaterThan(0);
    expect(eventHats.every(block => block.shadow)).toBe(true);
  });

  it('normalizes recoverable editor artifacts before strict no-preserve output validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-cli-compat-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'editor-artifacts.sb3');
    const output = join(directory, 'output.sb3');
    const project = createFixtureProject();
    const stage = project.targets[0];
    const firstSprite = project.targets[1];
    const setter = stage?.blocks['set_score'];
    if (!stage || !firstSprite || !isScratchBlock(setter)) throw new Error('fixture blocks missing');

    setter.inputs['VALUE'] = [3, 'activeValue', 'inactiveShadow'];
    stage.blocks['activeValue'] = {
      opcode: 'operator_add', next: null, parent: 'set_score',
      inputs: {NUM1: [1, [4, 40]], NUM2: [1, [4, 2]]}, fields: {},
      shadow: false, topLevel: false
    };
    stage.blocks['inactiveShadow'] = {
      opcode: 'math_number', next: null, parent: null,
      inputs: {}, fields: {NUM: ['hidden']}, shadow: true, topLevel: false
    };
    const secondSprite = structuredClone(firstSprite);
    secondSprite.name = 'Second Sprite';
    secondSprite.variables = {local_score: ['Second local', 30]};
    project.targets.push(secondSprite);
    project.monitors.push({
      opcode: 'data_variable', id: 'old-local-id', params: {VARIABLE: 'i'},
      spriteName: 'Deleted Sprite', value: 0, visible: false,
      mode: 'default', width: 0, height: 0, x: 0, y: 0,
      sliderMin: 0, sliderMax: 100, isDiscrete: true
    });
    await writeFile(input, createFixtureArchive(project));

    const diagnostics: string[] = [];
    const code = await runCli([input, '-no-preserve', '-o', output], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    });

    expect(code, diagnostics.join('')).toBe(0);
    expect(diagnostics.join('')).toContain('Removed 1 stale invisible data monitor for a missing sprite.');
    const transformed = readProjectFromArchive(await readFile(output));
    expect(transformed.monitors.some(monitor => monitor['spriteName'] === 'Deleted Sprite')).toBe(false);
    validateProject(transformed);
  });
});
