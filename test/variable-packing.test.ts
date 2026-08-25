import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms, type AggressiveMode} from '../src/obfuscation/aggressive.js';
import {
  collectVariableCandidates,
  countBlockEquivalents,
  countObjectBlocks,
  isLossyLiveTransformSafe
} from '../src/obfuscation/analysis.js';
import {ANTI_CHEAT_WATERMARK_NAME} from '../src/obfuscation/anticheat.js';
import {aggressiveBlockEquivalentCap} from '../src/growth-policy.js';
import type {ObfuscationStats, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  value: unknown;
}

interface RuntimeTarget {
  isStage: boolean;
  variables: Record<string, RuntimeVariable>;
}

interface RuntimeMonitor {
  value: unknown;
}

interface RuntimeMonitorState {
  get(id: string): RuntimeMonitor | undefined;
}

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    _step(): void;
    getMonitorState(): RuntimeMonitorState;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('scalar variable packing', () => {
  it('collects Stage globals across targets and unused declarations with exact usage ownership', () => {
    const project = packingProject();
    const candidates = new Map(collectVariableCandidates(project).map(candidate => [candidate.id, candidate]));

    expect([...candidates.keys()].sort()).toEqual(['global-unused', 'global-value', 'local-unused', 'local-value']);
    expect(candidates.get('global-unused')?.usages).toEqual([]);
    expect(candidates.get('local-unused')?.usages).toEqual([]);
    expect(candidates.get('global-value')?.targetIndex).toBe(0);
    expect(candidates.get('global-value')?.usages.map(usage => usage.targetIndex)).toEqual([1, 1, 1, 1]);
    expect(candidates.get('local-value')?.targetIndex).toBe(1);
    expect(candidates.get('local-value')?.usages.map(usage => usage.targetIndex)).toEqual([1, 1, 1]);
  });

  it('uses one global and one sprite-local backing list while rewriting fields and inline primitives', () => {
    const project = packingProject();
    const resultStats = stats(project, 'lossy');
    expect(isLossyLiveTransformSafe(project)).toBe(true);

    applyAggressiveTransforms(
      project,
      'lossy',
      new DeterministicGenerator(new Uint8Array(32).fill(67), 'packing-structure'),
      resultStats,
      undefined,
      true
    );

    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    expect(resultStats.variablesVirtualized).toBe(4);
    expect(Object.keys(stage.variables)).not.toContain('global-value');
    expect(Object.keys(stage.variables)).not.toContain('global-unused');
    expect(Object.keys(sprite.variables)).not.toContain('local-value');
    expect(Object.keys(sprite.variables)).not.toContain('local-unused');

    const stageStore = onlyBackingList(stage, 'results');
    const localStore = onlyBackingList(sprite);
    expect(stageStore.values).toEqual(expect.arrayContaining([5, 'unused-global']));
    expect(localStore.values).toEqual(expect.arrayContaining([2, true]));
    expect(listField(sprite, 'set-global')).toBe(stageStore.id);
    expect(listField(sprite, 'set-local')).toBe(localStore.id);
    expect(inlineListField(sprite, 'set-global', 'ITEM')).toBe(localStore.id);
    expect(inlineListField(sprite, 'set-local', 'ITEM')).toBe(stageStore.id);
    validateProject(project);
  });

  it('reserves staged quota for scalar packing beside an expanded four-command dispatcher', () => {
    const project = expandedPackingProject();
    const before = countBlockEquivalents(project);
    const resultStats = stats(project, 'no-preserve');

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(113), 'packing-expanded-budget-reservation'),
      resultStats,
      undefined,
      true
    );

    expect(resultStats.virtualizedBlocks, resultStats.warnings.join(';')).toBe(4);
    expect(resultStats.variablesVirtualized, resultStats.warnings.join(';')).toBe(4);
    const sprite = requireTarget(project, 1);
    expect(['motion_changexby', 'motion_changeyby', 'looks_changesizeby', 'sound_changevolumeby'].map(opcode => (
      Object.values(sprite.blocks).filter(value => isScratchBlock(value) && value.opcode === opcode).length
    ))).toEqual([4, 4, 4, 4]);
    expect(requireTarget(project, 0).variables['global-value']).toBeUndefined();
    expect(requireTarget(project, 0).variables['global-unused']).toBeUndefined();
    expect(sprite.variables['local-value']).toBeUndefined();
    expect(sprite.variables['local-unused']).toBeUndefined();
    const storedValues = project.targets.flatMap(target => Object.values(target.lists).flatMap(declaration => (
      Array.isArray(declaration[1]) ? declaration[1] : []
    )));
    for (const expected of [5, 'unused-global', 2, true]) {
      expect(storedValues.filter(value => value === expected), `packed value ${String(expected)}`).toHaveLength(1);
    }
    expect(countBlockEquivalents(project)).toBeLessThanOrEqual(
      aggressiveBlockEquivalentCap(before, 'no-preserve', true)
    );
    validateProject(project);
  }, 30_000);

  it('preserves global and local values in the official VM for both aggressive modes', async () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      const project = packingProject();
      const resultStats = stats(project, mode);
      applyAggressiveTransforms(
        project,
        mode,
        new DeterministicGenerator(new Uint8Array(32).fill(mode === 'lossy' ? 71 : 73), `packing-runtime-${mode}`),
        resultStats,
        undefined,
        true
      );
      expect(resultStats.variablesVirtualized, `${mode} left an eligible scalar native`).toBe(4);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 2_000 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `${mode} did not terminate`).toHaveLength(0);
        const stage = vm.runtime.targets.find(target => target.isStage);
        expect(stage?.variables['results']?.value, `${mode} changed packed values`).toEqual([5, 5]);
        expect(Object.values(stage?.variables ?? {}).some(variable => (
          Array.isArray(variable.value) && variable.value.includes('unused-global')
        )), `${mode} changed a packed string`).toBe(true);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(Object.values(sprite?.variables ?? {}).some(variable => (
          Array.isArray(variable.value) && variable.value.includes(true)
        )), `${mode} changed a packed boolean`).toBe(true);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('packs name-only fields with the loader Stage-resolution rule in both aggressive modes', async () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      const project = nameOnlyPackingProject();
      const resultStats = stats(project, mode);
      const candidates = collectVariableCandidates(project);
      expect(candidates.find(candidate => candidate.id === 'stage-shared')?.usages).toHaveLength(4);
      expect(candidates.find(candidate => candidate.id === 'local-shared')?.usages).toHaveLength(0);

      applyAggressiveTransforms(
        project,
        mode,
        new DeterministicGenerator(new Uint8Array(32).fill(mode === 'lossy' ? 107 : 109), `packing-name-only-${mode}`),
        resultStats,
        undefined,
        true
      );
      expect(resultStats.variablesVirtualized, `${mode} did not pack both eligible same-name scalars`).toBe(2);
      validateProject(project);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 2_000 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `${mode} name-only script did not terminate`).toHaveLength(0);
        const stage = vm.runtime.targets.find(target => target.isStage);
        expect(stage?.variables['results']?.value, `${mode} changed loader-reconciled name-only lookup`).toEqual([100, 8]);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('rejects global packing for observable or opaque references in any target', () => {
    const shown = packingProject();
    const shownSprite = requireTarget(shown, 1);
    shownSprite.blocks['show-global'] = block(
      'data_showvariable',
      null,
      null,
      true,
      {},
      {VARIABLE: ['global', 'global-value']}
    );
    expect(candidateIds(shown)).not.toContain('global-value');

    const extension = packingProject();
    requireTarget(extension, 1).blocks['extension'] = block('pen_clear', null, null, true);
    expect(candidateIds(extension)).toContain('global-value');

    const inventedExtension = packingProject();
    requireTarget(inventedExtension, 1).blocks['extension'] = block('pen_readVariableByName', null, null, true);
    expect(candidateIds(inventedExtension)).not.toContain('global-value');

    const mutation = packingProject();
    const setGlobal = requireTarget(mutation, 1).blocks['set-global'];
    if (!setGlobal || !isScratchBlock(setGlobal)) throw new Error('fixture is missing set-global');
    setGlobal.mutation = {tagName: 'mutation', hidden: 'global-value'};
    expect(candidateIds(mutation)).not.toContain('global-value');

    const extraInput = packingProject();
    const extraInputSet = requireTarget(extraInput, 1).blocks['set-global'];
    if (!extraInputSet || !isScratchBlock(extraInputSet)) throw new Error('fixture is missing set-global');
    extraInputSet.inputs['EXTRA'] = [1, [10, 'executed input']];
    expect(candidateIds(extraInput)).not.toContain('global-value');

    const extraField = packingProject();
    const extraFieldChange = requireTarget(extraField, 1).blocks['change-global'];
    if (!extraFieldChange || !isScratchBlock(extraFieldChange)) throw new Error('fixture is missing change-global');
    extraFieldChange.fields['EXTRA'] = ['preserved field'];
    expect(candidateIds(extraField)).not.toContain('global-value');

    const monitored = packingProject();
    monitored.monitors = [{id: 'global-value', opcode: 'data_variable', params: {VARIABLE: 'global'}, spriteName: null}];
    expect(candidateIds(monitored)).not.toContain('global-value');

    const cloud = packingProject();
    requireTarget(cloud, 0).variables['global-value'] = ['global', 5, true];
    expect(candidateIds(cloud)).not.toContain('global-value');
  });

  it('accepts only the canonical official stop mutation during packing analysis', () => {
    const canonical = packingProject();
    const canonicalSprite = requireTarget(canonical, 1);
    canonicalSprite.blocks['stop'] = {
      ...block('control_stop', null, null, true, {}, {STOP_OPTION: ['this script', null]}),
      mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
    };
    expect(candidateIds(canonical).sort()).toEqual([
      'global-unused',
      'global-value',
      'local-unused',
      'local-value'
    ]);

    const malformed = structuredClone(canonical);
    const malformedStop = requireTarget(malformed, 1).blocks['stop'];
    if (!malformedStop || !isScratchBlock(malformedStop) || !malformedStop.mutation) {
      throw new Error('canonical stop fixture is unavailable');
    }
    malformedStop.mutation['unexpected'] = 'opaque';
    expect(candidateIds(malformed)).toEqual([]);
  });

  it('excludes a Stage variable selected by a sensing-of monitor from packing candidates', () => {
    const project = packingProject();
    project.monitors = [stageSensingMonitor()];
    validateProject(project);

    expect(candidateIds(project)).not.toContain('global-value');
    expect(candidateIds(project)).toContain('global-unused');
  });

  it('keeps a sensing-of monitored Stage variable native and observable in both aggressive modes', async () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      const project = packingProject();
      const stageProject = requireTarget(project, 0);
      project.monitors = [stageSensingMonitor()];
      validateProject(project);

      applyAggressiveTransforms(
        project,
        mode,
        new DeterministicGenerator(new Uint8Array(32).fill(mode === 'lossy' ? 97 : 101), `packing-monitor-${mode}`),
        stats(project, mode)
      );

      expect(stageProject.variables['global-value'], `${mode} packed a name-observed Stage variable`).toEqual(['global', 5]);
      validateProject(project);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        expect(vm.runtime.getMonitorState().get('sense-global')?.value).toBe(0);
        for (let step = 0; step < 20; step += 1) vm.runtime._step();
        expect(vm.runtime.getMonitorState().get('sense-global')?.value, `${mode} broke sensing-of monitor lookup`).toBe(5);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('preserves exactly one pre-existing Stage watermark scalar in both aggressive modes', () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      const project = packingProject();
      const stage = requireTarget(project, 0);
      stage.variables['existing-watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'project-owned-value'];
      expect(candidateIds(project)).not.toContain('existing-watermark');

      const resultStats = stats(project, mode);
      applyAggressiveTransforms(
        project,
        mode,
        new DeterministicGenerator(new Uint8Array(32).fill(mode === 'lossy' ? 83 : 89), `packing-watermark-${mode}`),
        resultStats,
        undefined,
        true
      );

      expect(stage.variables['existing-watermark']).toEqual([ANTI_CHEAT_WATERMARK_NAME, 'project-owned-value']);
      expect(Object.values(stage.variables).filter(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(1);
      expect(resultStats.variablesVirtualized).toBe(4);
      validateProject(project);
    }
  });

  it('keeps a missing-value setter native and preserves its undefined runtime result', async () => {
    const project = packingProject();
    const sprite = requireTarget(project, 1);
    sprite.blocks = {
      flag: block('event_whenflagclicked', 'set-missing', null, true),
      'set-missing': block(
        'data_setvariableto',
        'change-missing',
        'flag',
        false,
        {},
        {VARIABLE: ['local', 'local-value']}
      ),
      'change-missing': block(
        'data_changevariableby',
        'append-changed',
        'set-missing',
        false,
        {},
        {VARIABLE: ['local unused', 'local-unused']}
      ),
      'append-changed': block(
        'data_addtolist',
        null,
        'change-missing',
        false,
        {ITEM: [1, [12, 'local unused', 'local-unused']]},
        {LIST: ['results', 'results']}
      )
    };
    expect(candidateIds(project)).not.toContain('local-value');
    expect(candidateIds(project)).toContain('local-unused');
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(79), 'packing-missing-input'),
      stats(project, 'no-preserve')
    );
    expect(sprite.variables['local-value']).toBeDefined();
    expect(sprite.variables['local-unused']).toBeUndefined();

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      const runtimeSprite = vm.runtime.targets.find(target => !target.isStage);
      expect(runtimeSprite?.variables['local-value']?.value).toBeUndefined();
      const runtimeStage = vm.runtime.targets.find(target => target.isStage);
      expect(runtimeStage?.variables['results']?.value).toEqual([1]);
    } finally {
      vm.quit();
    }
  }, 60_000);
});

function packingProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.variables = {
    'global-value': ['global', 5],
    'global-unused': ['global unused', 'unused-global']
  };
  stage.lists = {results: ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {
    'local-value': ['local', 2],
    'local-unused': ['local unused', true]
  };
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'set-x', null, true),
    'set-x': block('motion_setx', 'set-y', 'flag', false, {X: [1, [4, '12']]}),
    'set-y': block('motion_sety', 'set-global', 'set-x', false, {Y: [1, [4, '-7']]}),
    'set-global': block(
      'data_setvariableto',
      'change-global',
      'set-y',
      false,
      {VALUE: [1, [12, 'local', 'local-value']]},
      {VARIABLE: ['global', 'global-value']}
    ),
    'change-global': block(
      'data_changevariableby',
      'set-local',
      'set-global',
      false,
      {VALUE: [1, [4, '3']]},
      {VARIABLE: ['global', 'global-value']}
    ),
    'set-local': block(
      'data_setvariableto',
      'append-global',
      'change-global',
      false,
      {VALUE: [1, [12, 'global', 'global-value']]},
      {VARIABLE: ['local', 'local-value']}
    ),
    'append-global': block(
      'data_addtolist',
      'append-local',
      'set-local',
      false,
      {ITEM: [1, [12, 'global', 'global-value']]},
      {LIST: ['results', 'results']}
    ),
    'append-local': block(
      'data_addtolist',
      null,
      'append-global',
      false,
      {ITEM: [1, [12, 'local', 'local-value']]},
      {LIST: ['results', 'results']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function expandedPackingProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.variables = {
    global_score: ['Readable score', 0],
    'global-value': ['global', 5],
    'global-unused': ['global unused', 'unused-global']
  };
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {
    'local-value': ['local', 2],
    'local-unused': ['local unused', true]
  };
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'blocked-0', null, true),
    'dispatch-separator': block(
      'motion_setrotationstyle',
      'dispatch-x',
      'blocked-7',
      false,
      {},
      {STYLE: ['left-right', null]}
    ),
    'dispatch-x': block('motion_changexby', 'dispatch-y', 'dispatch-separator', false, {DX: [1, [4, '11']]}),
    'dispatch-y': block('motion_changeyby', 'dispatch-size', 'dispatch-x', false, {DY: [1, [4, '-7']]}),
    'dispatch-size': block(
      'looks_changesizeby',
      'dispatch-volume',
      'dispatch-y',
      false,
      {CHANGE: [1, [4, '13']]}
    ),
    'dispatch-volume': block('sound_changevolumeby', null, 'dispatch-size', false, {VOLUME: [1, [4, '-9']]})
  };
  for (let index = 0; index < 8; index += 1) {
    const id = `blocked-${index}`;
    sprite.blocks[id] = block(
      'data_setvariableto',
      index === 7 ? 'dispatch-separator' : `blocked-${index + 1}`,
      index === 0 ? 'flag' : `blocked-${index - 1}`,
      false,
      {VALUE: [1, [4, String(index)]]},
      {VARIABLE: ['Readable score', 'global_score']}
    );
  }
  project.monitors = [{
    id: 'global_score',
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: 'Readable score'},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 5,
    y: 5,
    visible: true,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  }];
  project.extensions = [];
  validateProject(project);
  return project;
}

function nameOnlyPackingProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.variables = {'stage-shared': ['shared', 100]};
  stage.lists = {results: ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'local-shared': ['shared', 2]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'append-before', null, true),
    'append-before': block(
      'data_addtolist',
      'set-local',
      'flag',
      false,
      {ITEM: [1, 'read-before']},
      {LIST: ['results', 'results']}
    ),
    'read-before': block(
      'data_variable',
      null,
      'append-before',
      false,
      {},
      {VARIABLE: ['shared']}
    ),
    'set-local': block(
      'data_setvariableto',
      'change-local',
      'append-before',
      false,
      {VALUE: [1, [4, '5']]},
      {VARIABLE: ['shared']}
    ),
    'change-local': block(
      'data_changevariableby',
      'append-local',
      'set-local',
      false,
      {VALUE: [1, [4, '3']]},
      {VARIABLE: ['shared', null]}
    ),
    'append-local': block(
      'data_addtolist',
      null,
      'change-local',
      false,
      {ITEM: [1, 'read-after']},
      {LIST: ['results', 'results']}
    ),
    'read-after': block(
      'data_variable',
      null,
      'append-local',
      false,
      {},
      {VARIABLE: ['shared', '']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function onlyBackingList(target: ScratchTarget, excludedId?: string): {id: string; values: unknown[]} {
  const entries = Object.entries(target.lists).filter(([id]) => id !== excludedId);
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry || !Array.isArray(entry[1][1])) throw new Error('backing list is unavailable');
  return {id: entry[0], values: entry[1][1]};
}

function listField(target: ScratchTarget, blockId: string): unknown {
  const value = target.blocks[blockId];
  return value && isScratchBlock(value) ? value.fields['LIST']?.[1] : undefined;
}

function inlineListField(target: ScratchTarget, blockId: string, inputName: string): unknown {
  const owner = target.blocks[blockId];
  const reporterId = owner && isScratchBlock(owner) ? owner.inputs[inputName]?.[1] : undefined;
  const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
  return reporter && isScratchBlock(reporter) ? reporter.fields['LIST']?.[1] : undefined;
}

function candidateIds(project: ScratchProject): string[] {
  return collectVariableCandidates(project).map(candidate => candidate.id);
}

function stageSensingMonitor(): ScratchProject['monitors'][number] {
  return {
    id: 'sense-global',
    mode: 'default',
    opcode: 'sensing_of',
    params: {PROPERTY: 'global', OBJECT: '_stage_'},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: true,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`fixture is missing target ${index}`);
  return target;
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  topLevel: boolean,
  inputs: Record<string, ScratchInput> = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {
    opcode,
    next,
    parent,
    inputs,
    fields,
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function stats(project: ScratchProject, mode: AggressiveMode): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode,
    blocksBefore: blocks,
    blocksAfter: blocks,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    variablesVirtualized: 0,
    constantsFolded: 0,
    inactiveFallbacksRemoved: 0,
    antiCheatDecoys: 0,
    warnings: []
  };
}
