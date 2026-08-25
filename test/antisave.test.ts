import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strFromU8, unzipSync, zipSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {serializeProject} from '../src/archive/writer.js';
import {parseCliArguments, runCli} from '../src/cli.js';
import {cliCaveats, formatSuccessSummary, formatVerboseReport} from '../src/cli-reporting.js';
import {DeterministicGenerator} from '../src/deterministic.js';
import {countBlockEquivalents, isScratchBlock} from '../src/model/blocks.js';
import {
  ANTI_SAVE_CAVEAT,
  ANTI_SAVE_GENERATOR_DOMAIN,
  ANTI_SAVE_NO_HATS_CAVEAT,
  applyAntiSaveTransform,
  isSafeCanaryText
} from '../src/obfuscation/antisave.js';
import {getAntiCheatReleaseCheckpoint, obfuscateProject} from '../src/obfuscation/index.js';
import type {ObfuscationStats, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject, SVG_BYTES, SVG_NAME} from './support.js';

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  saveProjectSb3(): Promise<Blob | Uint8Array>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    _step(): void;
  };
}

interface RuntimeVariable {
  value: unknown;
}

interface RuntimeTarget {
  isStage: boolean;
  x: number;
  y: number;
  visible: boolean;
  variables: Record<string, RuntimeVariable>;
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object' || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('official Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('antisave resave deterrence', () => {
  it('adds deterministic bounded Unicode declarations and a typed signed-zero guard', () => {
    const first = createFixtureProject();
    const second = createFixtureProject();
    const different = createFixtureProject();
    const originalBlocks = structuredClone(first.targets[0]?.blocks);
    const originalVariables = structuredClone(first.targets[0]?.variables);
    const originalLists = structuredClone(first.targets[0]?.lists);
    const firstResult = applyAntiSaveTransform(first, generator(0x53));
    const secondResult = applyAntiSaveTransform(second, generator(0x53));
    const differentResult = applyAntiSaveTransform(different, generator(0x54));

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).not.toEqual(differentResult);
    expect(firstResult.generatedBlockCount).toBe(16);
    expect(firstResult.canaryCount).toBe(4);
    expect(firstResult.procedureCodes).toHaveLength(2);
    expect(firstResult.guardedHatCount).toBe(2);
    expect(firstResult.inactiveFallbackCanaries).toBe(0);
    expect(firstResult.caveats).toEqual([ANTI_SAVE_CAVEAT]);
    expect(firstResult.manifest.generatedObjectBlockCount).toBe(16);
    expect(firstResult.manifest.generatedBlockEquivalentCount).toBe(22);
    expect(firstResult.manifest.hatGuards).toHaveLength(2);

    const stage = requireStage(first);
    expect(Object.is(stage.variables[firstResult.sentinelVariableId]?.[1], -0)).toBe(true);
    expect(isSafeCanaryText(requiredString(stage.variables[firstResult.sentinelVariableId]?.[0]))).toBe(true);
    expect(isSafeCanaryText(requiredString(stage.lists[firstResult.markerListId]?.[0]))).toBe(true);
    expect(isSafeCanaryText(firstResult.procedureCode)).toBe(true);
    expect(isSafeCanaryText(String((stage.lists[firstResult.markerListId]?.[1] as unknown[] | undefined)?.[0])))
      .toBe(true);
    expect(Object.values(stage.blocks).filter(isScratchBlock).map(block => block.opcode))
      .toEqual(expect.arrayContaining([
        'procedures_definition',
        'procedures_prototype',
        'procedures_call',
        'operator_divide',
        'operator_lt',
        'operator_not',
        'control_if',
        'control_stop'
      ]));
    for (const [targetIndex, hatId, originalSuccessor] of [
      [0, 'start_script', 'set_score'],
      [1, 'receive_script', 'change_local']
    ] as const) {
      const target = first.targets[targetIndex];
      if (target === undefined) {
        throw new Error('fixture target unavailable');
      }
      const hat = target.blocks[hatId];
      const call = isScratchBlock(hat) && typeof hat.next === 'string' ? target.blocks[hat.next] : undefined;
      expect(isScratchBlock(call) && call.opcode).toBe('procedures_call');
      expect(isScratchBlock(call) && call.next).toBe(originalSuccessor);
      expect(isScratchBlock(call) && call.mutation?.['warp']).toBe('true');
    }
    for (const [id, block] of Object.entries(originalBlocks ?? {})) {
      const current = stage.blocks[id];
      expect(isScratchBlock(current)).toBe(isScratchBlock(block));
      if (isScratchBlock(current) && isScratchBlock(block)) {
        expect({
          opcode: current.opcode,
          inputs: current.inputs,
          fields: current.fields,
          shadow: current.shadow,
          topLevel: current.topLevel
        }).toEqual({
          opcode: block.opcode,
          inputs: block.inputs,
          fields: block.fields,
          shadow: block.shadow,
          topLevel: block.topLevel
        });
      }
    }
    for (const [id, declaration] of Object.entries(originalVariables ?? {})) {
      expect(stage.variables[id]).toEqual(declaration);
    }
    for (const [id, declaration] of Object.entries(originalLists ?? {})) expect(stage.lists[id]).toEqual(declaration);
    validateProject(first);
  });

  it('marks only already-inactive inline fallback values when such inputs remain', () => {
    const project = createFixtureProject();
    const stage = requireStage(project);
    stage.blocks['active_reporter'] = {
      opcode: 'operator_add',
      next: null,
      parent: 'set_score',
      inputs: {NUM1: [1, [4, '20']], NUM2: [1, [4, '22']]},
      fields: {},
      shadow: false,
      topLevel: false
    };
    const setter = stage.blocks['set_score'];
    if (!isScratchBlock(setter)) throw new Error('fixture setter is unavailable');
    setter.inputs['VALUE'] = [3, 'active_reporter', [4, '999']];
    const activeBefore = structuredClone(stage.blocks['active_reporter']);

    const result = applyAntiSaveTransform(project, generator(0x61));
    expect(result.inactiveFallbackCanaries).toBe(1);
    expect(result.canaryCount).toBe(5);
    expect(setter.inputs['VALUE']?.[1]).toBe('active_reporter');
    expect((setter.inputs['VALUE']?.[2] as unknown[] | undefined)?.[0]).toBe(10);
    expect(isSafeCanaryText(String((setter.inputs['VALUE']?.[2] as unknown[] | undefined)?.[1]))).toBe(true);
    expect(stage.blocks['active_reporter']).toEqual(activeBefore);
    validateProject(project);
  });

  it('adds no runnable watchdog when the source has no native hats', () => {
    const project = createFixtureProject();
    for (const target of project.targets) {
      target.blocks = {};
      target.comments = {};
    }
    const before = countBlockEquivalents(project);

    const result = applyAntiSaveTransform(project, generator(0x62));

    expect(result.guardedHatCount).toBe(0);
    expect(result.generatedBlockCount).toBe(7);
    expect(result.manifest.procedures).toHaveLength(1);
    expect(result.manifest.generatedBlockEquivalentCount).toBe(10);
    expect(result.caveats).toEqual([ANTI_SAVE_CAVEAT, ANTI_SAVE_NO_HATS_CAVEAT]);
    expect(countBlockEquivalents(project) - before).toBe(10);
    expect(project.targets.flatMap(target => Object.values(target.blocks)).filter(value => (
      isScratchBlock(value) && value.topLevel && value.opcode === 'event_whenflagclicked'
    ))).toEqual([]);
    validateProject(project);
  });

  it('verifies six guarded targets beyond the former fixed growth ceiling', () => {
    const source = projectWithTargetCount(6);
    const direct = structuredClone(source);
    const before = countBlockEquivalents(direct);
    const directResult = applyAntiSaveTransform(direct, generator(0x63));

    expect(directResult.guardedHatCount).toBe(6);
    expect(directResult.manifest.procedures).toHaveLength(6);
    expect(directResult.manifest.generatedBlockEquivalentCount).toBe(66);
    expect(countBlockEquivalents(direct) - before).toBe(66);
    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x63), {
      antiSave: true
    })).not.toThrow();
  });

  it('handles many hats with exact linear growth and deterministic output', () => {
    const first = projectWithAdditionalStageHats(128);
    const second = projectWithAdditionalStageHats(128);
    const before = countBlockEquivalents(first);

    const firstResult = applyAntiSaveTransform(first, generator(0x64));
    const secondResult = applyAntiSaveTransform(second, generator(0x64));

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.guardedHatCount).toBe(130);
    expect(firstResult.manifest.procedures).toHaveLength(2);
    expect(firstResult.manifest.generatedBlockEquivalentCount).toBe(150);
    expect(countBlockEquivalents(first) - before).toBe(150);
    expect(() => obfuscateProject(
      projectWithAdditionalStageHats(128),
      'lossless',
      new Uint8Array(32).fill(0x64),
      {antiSave: true}
    )).not.toThrow();
  });

  it('retains and guards an existing shadow-marked official hat without miscounting growth', () => {
    const source = createFixtureProject();
    const stage = requireStage(source);
    const hat = stage.blocks['start_script'];
    if (!isScratchBlock(hat)) throw new Error('fixture Stage hat is unavailable');
    hat.shadow = true;
    const direct = structuredClone(source);
    const before = countBlockEquivalents(direct);

    const result = applyAntiSaveTransform(direct, generator(0x65));

    expect(result.guardedHatCount).toBe(2);
    expect(result.manifest.generatedBlockEquivalentCount).toBe(22);
    expect(countBlockEquivalents(direct) - before).toBe(22);
    const transformedHat = requireStage(direct).blocks['start_script'];
    expect(isScratchBlock(transformedHat) && transformedHat.shadow).toBe(true);
    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x65), {
      antiSave: true
    })).not.toThrow();
  });

  it.each(['lossless', 'lossy', 'no-preserve'] as const)('integrates with verified %s output', mode => {
    const result = obfuscateProject(
      createFixtureProject(),
      mode,
      new Uint8Array(32).fill(0x29),
      {antiSave: true}
    );
    const stage = requireStage(result.project);
    expect(result.stats.antiSaveCanaries).toBe(4);
    expect(result.stats.caveats?.filter(value => value === ANTI_SAVE_CAVEAT)).toHaveLength(1);
    expect(result.stats.verification?.verdict).toBe('verified-with-caveats');
    expect(Object.values(stage.variables).some(declaration => Object.is(declaration[1], -0))).toBe(true);
    expect(Object.values(stage.blocks).filter(isScratchBlock).some(block => block.opcode === 'control_stop')).toBe(true);
    expect(result.project.targets.every(target => Object.keys(target.comments).length === 0)).toBe(true);
    validateProject(result.project);
  });

  it('pairs with anti-cheat while retaining the final anti-cheat release checkpoint', () => {
    const result = obfuscateProject(
      createFixtureProject(),
      'lossless',
      new Uint8Array(32).fill(0x38),
      {antiCheat: true, antiSave: true}
    );
    expect(result.stats.antiSaveCanaries).toBe(4);
    expect(getAntiCheatReleaseCheckpoint(result)).toBeDefined();
    expect(result.stats.caveats?.filter(value => value === ANTI_SAVE_CAVEAT)).toHaveLength(1);
  });

  it('accepts both CLI spellings and reports branding, mode state, and the save caveat', async () => {
    expect(parseCliArguments(['input.sb3', '-antisave'])).toMatchObject({antiSave: true});
    expect(parseCliArguments(['input.sb3', '--antisave'])).toMatchObject({antiSave: true});
    expect(parseCliArguments(['input.sb3'])).toMatchObject({antiSave: false});

    const stdout: string[] = [];
    expect(await runCli(['--help'], {
      stdout: text => stdout.push(text),
      stderr: () => undefined
    })).toBe(0);
    expect(stdout.join('')).toContain('Scratch Obfuscator — PrioSDK Gen 4');
    expect(stdout.join('')).toContain('-antisave, --antisave');

    expect(cliCaveats('lossless', false, false, false, true)).toEqual(expect.arrayContaining([
      expect.stringContaining('antisave intentionally adds executable guard topology'),
      ANTI_SAVE_CAVEAT
    ]));
    const stats = emptyStats();
    stats.antiSaveCanaries = 3;
    expect(formatSuccessSummary('in.sb3', 'out.sb3', 'lossless', false, stats, 2, false, false, true))
      .toContain('antisave=on');
    expect(formatVerboseReport(stats, {
      archiveEntries: 2,
      assetsVerified: 1,
      assetBytesVerified: 1,
      projectBytesWritten: 1
    }, 'max')).toContain('antisave-canaries=3');
  });

  it('writes a signed-zero sentinel through the packed CLI and reports one caveat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-antisave-'));
    try {
      const input = join(directory, 'input.sb3');
      const output = join(directory, 'output.sb3');
      await writeFile(input, createFixtureArchive());
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await runCli([input, '-antisave', '-o', output], {
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        interactive: false
      }), stderr.join('')).toBe(0);
      const transformed = projectFromArchive(await readFile(output));
      expect(Object.values(requireStage(transformed).variables).some(declaration => Object.is(declaration[1], -0)))
        .toBe(true);
      expect(stdout.join('')).toContain('antisave=on');
      expect(stderr.join('').split(ANTI_SAVE_CAVEAT).length - 1).toBe(1);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('rejects a non-boolean library option', () => {
    expect(() => obfuscateProject(
      createFixtureProject(),
      'lossless',
      new Uint8Array(32),
      {antiSave: 'yes'} as unknown as {antiSave: boolean}
    )).toThrow('antiSave must be a boolean');
  });

  it('runs normally before saving, then trips after official save/reload and remains tripped', async () => {
    const source = createFixtureProject();
    const stageSource = requireStage(source);
    stageSource.blocks['second_green_hat'] = {
      opcode: 'event_whenflagclicked', next: 'second_green_change', parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 240, y: 80
    };
    stageSource.blocks['second_green_change'] = {
      opcode: 'data_setvariableto', next: null, parent: 'second_green_hat',
      inputs: {VALUE: [1, [4, '8']]}, fields: {VARIABLE: ['Readable score', 'global_score']},
      shadow: false, topLevel: false
    };
    const protectedProject = structuredClone(source);
    const result = applyAntiSaveTransform(protectedProject, generator(0x79));
    const sourceTrace = await executeSnapshot(createFixtureArchive(source));
    const protectedBytes = signedZeroArchive(protectedProject);
    expect(await executeSnapshot(protectedBytes)).toEqual(sourceTrace);

    const firstVm = createVm();
    const secondVm = createVm();
    try {
      await firstVm.loadProject(protectedBytes);
      const firstSaved = await blobBytes(await firstVm.saveProjectSb3());
      const firstProject = projectFromArchive(firstSaved);
      validateProject(firstProject);
      expect(Object.is(requireStage(firstProject).variables[result.sentinelVariableId]?.[1], -0)).toBe(false);
      expect(requireStage(firstProject).variables[result.sentinelVariableId]?.[1]).toBe(0);
      expectResaveNames(firstProject, result);
      expect(await executeSnapshot(firstSaved)).toEqual(expect.objectContaining({score: 0}));

      await secondVm.loadProject(firstSaved);
      const secondSaved = await blobBytes(await secondVm.saveProjectSb3());
      const secondProject = projectFromArchive(secondSaved);
      validateProject(secondProject);
      expect(requireStage(secondProject).variables[result.sentinelVariableId]?.[1]).toBe(0);
      expectResaveNames(secondProject, result);
      expect(await executeSnapshot(secondSaved)).toEqual(expect.objectContaining({score: 0}));
    } finally {
      firstVm.quit();
      secondVm.quit();
    }
  }, 60_000);
});

function projectWithTargetCount(targetCount: number): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const spriteTemplate = project.targets.find(target => !target.isStage);
  if (!spriteTemplate || targetCount < 1) throw new Error('sprite template or target count is unavailable');
  stage.blocks = singleHatBlocks(0);
  stage.comments = {};
  const sprites = Array.from({length: targetCount - 1}, (_, index) => {
    const sprite = structuredClone(spriteTemplate);
    sprite.name = `Guard target ${index + 1}`;
    sprite['layerOrder'] = index + 1;
    sprite.variables = {};
    sprite.lists = {};
    sprite.broadcasts = {};
    sprite.comments = {};
    sprite.blocks = singleHatBlocks(index + 1);
    return sprite;
  });
  project.targets = [stage, ...sprites];
  return project;
}

function singleHatBlocks(index: number): ScratchProject['targets'][number]['blocks'] {
  const hatId = `guard_hat_${index}`;
  const bodyId = `guard_body_${index}`;
  return {
    [hatId]: {
      opcode: 'event_whenflagclicked', next: bodyId, parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: index * 20, y: index * 20
    },
    [bodyId]: {
      opcode: 'looks_show', next: null, parent: hatId,
      inputs: {}, fields: {}, shadow: false, topLevel: false
    }
  };
}

function projectWithAdditionalStageHats(count: number): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  for (let index = 0; index < count; index += 1) {
    stage.blocks[`many_hat_${index}`] = {
      opcode: 'event_whenflagclicked', next: null, parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true,
      x: 400 + (index * 4), y: 100 + (index * 4)
    };
  }
  return project;
}

function generator(seed: number): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(seed), ANTI_SAVE_GENERATOR_DOMAIN);
}

function requireStage(project: ScratchProject) {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function emptyStats(): ObfuscationStats {
  return {
    mode: 'lossless', blocksBefore: 1, blocksAfter: 1, identifiersRenamed: 0,
    symbolsRenamed: 0, commentsRemoved: 0, decoysAdded: 0, virtualizedBlocks: 0,
    warnings: [], caveats: []
  };
}

function signedZeroArchive(project: ScratchProject): Uint8Array {
  return zipSync({'project.json': serializeProject(project, 'lossless'), [SVG_NAME]: SVG_BYTES});
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

function projectFromArchive(archive: Uint8Array): ScratchProject {
  const projectJson = unzipSync(archive)['project.json'];
  if (!projectJson) throw new Error('saved project has no project.json');
  return JSON.parse(strFromU8(projectJson)) as ScratchProject;
}

function expectResaveNames(
  project: ScratchProject,
  result: ReturnType<typeof applyAntiSaveTransform>
): void {
  const stage = requireStage(project);
  expect(stage.variables[result.sentinelVariableId]?.[0]).toBe(result.manifest.sentinelName);
  expect(stage.lists[result.markerListId]).toEqual([
    result.manifest.markerListName,
    [result.manifest.markerListValue]
  ]);
  for (const procedure of result.manifest.procedures) {
    const target = project.targets[procedure.targetIndex];
    expect(target).toBeDefined();
    expect(Object.values(target?.blocks ?? {}).filter(isScratchBlock).some(block =>
      block.mutation?.['proccode'] === procedure.procedureCode
    )).toBe(true);
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a string canary');
  return value;
}

async function executeSnapshot(project: Uint8Array): Promise<Record<string, unknown>> {
  const vm = createVm();
  try {
    await vm.loadProject(project);
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    const stage = vm.runtime.targets.find(target => target.isStage);
    const sprite = vm.runtime.targets.find(target => !target.isStage);
    if (!stage || !sprite) throw new Error('fixture targets did not load');
    return {
      score: stage.variables['global_score']?.value,
      list: stage.variables['global_list']?.value,
      spriteX: sprite.x,
      spriteY: sprite.y,
      spriteVisible: sprite.visible
    };
  } finally {
    vm.quit();
  }
}
