import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {ObfuscationMode, ObfuscationStats, ScratchBlock, ScratchProject} from '../src/types.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  value: unknown;
}

interface RuntimeTarget {
  isStage: boolean;
  variables: Record<string, RuntimeVariable>;
  x: number;
  y: number;
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

describe('aggressive dispatcher runtime regressions', () => {
  it('executes every command in a 26-block run exactly once across shuffled chunk orders', async () => {
    const dispatcherTemplates = new Set<string>();
    for (const seedByte of [0, 1, 2, 3, 4, 5, 17, 255]) {
      const project = makeIncrementProject(26);
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'dispatcher-runtime'),
        resultStats
      );
      expect(resultStats.virtualizedBlocks).toBe(20);
      for (const template of collectDispatcherTemplates(project)) dispatcherTemplates.add(template);
      expect(countIndirectTransitions(project)).toBeGreaterThan(resultStats.virtualizedBlocks);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `seed ${seedByte} did not terminate`).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['counter-id']?.value, `seed ${seedByte} executed a chunk out of order`).toBe(26);
      } finally {
        vm.quit();
      }
    }
    expect(dispatcherTemplates).toEqual(new Set(['control_if', 'control_if_else']));
  }, 60_000);

  for (const [tokenKind, seedByte] of [['state', 73], ['tag', 74]] as const) {
    it(`rejects encrypted transition ${tokenKind} store tampering`, async () => {
      const project = makeIncrementProject(5);
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), `dispatcher-${tokenKind}-tamper-runtime`),
        resultStats
      );

      expect(resultStats.virtualizedBlocks).toBe(5);
      expect(countAuthenticatedRoutes(project)).toBeGreaterThan(resultStats.virtualizedBlocks);
      const tamper = corruptTransitionToken(project, tokenKind);
      expect(tamper).toBeDefined();
      if (!tamper) throw new Error(`transition ${tokenKind} is unavailable`);
      expect(tamper.after - tamper.before).toBe(1);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['counter-id']?.value).toBe(0);
      } finally {
        vm.quit();
      }
    }, 60_000);
  }

  it('removes a virtualized scalar declaration while preserving clone-local list state', async () => {
    const project = makeCloneProject();
    const spriteProject = project.targets.find(target => !target.isStage);
    if (!spriteProject) throw new Error('fixture sprite is unavailable');

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(23), 'clone-runtime'),
      stats(project)
    );

    expect(spriteProject.variables['local-value']).toBeUndefined();
    expect(Object.values(spriteProject.lists).some(declaration => Array.isArray(declaration[1]) && declaration[1].includes(0))).toBe(true);

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      const stage = vm.runtime.targets.find(target => target.isStage);
      expect(stage?.variables['results-id']?.value).toEqual([6]);
    } finally {
      vm.quit();
    }
  }, 60_000);

  it('preserves fixed-list item and replacement semantics after heap permutation', async () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      const project = makeFixedListHeapProject();
      const spriteProject = project.targets.find(target => !target.isStage);
      if (!spriteProject) throw new Error('fixture sprite is unavailable');
      const resultStats = stats(project, mode);
      applyAggressiveTransforms(
        project,
        mode,
        new DeterministicGenerator(new Uint8Array(32).fill(37), `fixed-list-${mode}`),
        resultStats
      );
      expect(resultStats.listsVirtualized).toBe(2);
      expect(spriteProject.lists['fixed-a']).toBeUndefined();
      expect(spriteProject.lists['fixed-b']).toBeUndefined();

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `${mode} fixed-list program did not terminate`).toHaveLength(0);
        const stage = vm.runtime.targets.find(target => target.isStage);
        expect(stage?.variables['results-id']?.value).toEqual(['changed', 'a1']);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('preserves effects through lossy non-warp outlining and condition inversion', async () => {
    const project = makeLossyOutlineProject();
    applyAggressiveTransforms(
      project,
      'lossy',
      new DeterministicGenerator(new Uint8Array(32).fill(41), 'lossy-runtime'),
      stats(project, 'lossy')
    );
    const spriteProject = project.targets.find(target => !target.isStage);
    const prototype = Object.values(spriteProject?.blocks ?? {}).find(
      value => isScratchBlock(value) && value.opcode === 'procedures_prototype'
    );
    expect(prototype && isScratchBlock(prototype) ? prototype.mutation : undefined).toMatchObject({warp: 'false'});

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      const sprite = vm.runtime.targets.find(target => !target.isStage);
      expect(sprite?.variables['counter-id']?.value).toBe(14);
    } finally {
      vm.quit();
    }
  }, 60_000);

  it('preserves signed zero, subnormal motion, and raw numeric-shadow storage through numeric equations', async () => {
    for (const seedByte of [0, 1, 2, 3]) {
      const project = makeNumericEquationProject();
      applyAggressiveTransforms(
        project,
        'lossy',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'numeric-runtime'),
        stats(project, 'lossy')
      );
      const spriteProject = project.targets.find(target => !target.isStage);
      const rawStore = spriteProject?.blocks['store'];
      const backingListId = rawStore && isScratchBlock(rawStore) ? rawStore.fields['LIST']?.[1] : undefined;
      expect(backingListId, `seed ${seedByte} did not pack the scalar`).toBeTypeOf('string');
      if (typeof backingListId !== 'string') throw new Error(`seed ${seedByte} did not pack the scalar`);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `seed ${seedByte} did not terminate`).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(Object.is(sprite?.x, -0), `seed ${seedByte} lost negative zero`).toBe(true);
        expect(sprite?.y, `seed ${seedByte} changed the minimum subnormal`).toBe(Number.MIN_VALUE);
        const packedValues = sprite?.variables[backingListId]?.value;
        expect(Array.isArray(packedValues) && packedValues.includes('01'), `seed ${seedByte} changed raw shadow storage`).toBe(true);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('loads and evaluates split fixed-slot string pools exactly', async () => {
    const expected = 'A😀B';
    for (const seedByte of [0, 1, 2]) {
      const project = makeStringPoolProject(expected);
      const duplicate = makeStringPoolProject(expected);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'string-pool-runtime'),
        stats(project)
      );
      applyAggressiveTransforms(
        duplicate,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'string-pool-runtime'),
        stats(duplicate)
      );
      expect(JSON.stringify(project)).toBe(JSON.stringify(duplicate));
      expect(readPooledString(project, 'store', 'VALUE')).toBe(expected);
      expect(project.targets.flatMap(target => Object.values(target.lists)).some(declaration => (
        Array.isArray(declaration[1]) && declaration[1].includes(expected)
      ))).toBe(false);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `seed ${seedByte} did not terminate`).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['raw-id']?.value).toBe(expected);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('virtualizes self-referential scalar updates before deleting their declaration', async () => {
    const project = makeSelfReferenceProject();
    const spriteProject = project.targets.find(target => !target.isStage);
    if (!spriteProject) throw new Error('fixture sprite is unavailable');
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(51), 'self-reference-runtime'),
      stats(project)
    );
    expect(spriteProject.variables['local-value']).toBeUndefined();

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      const stage = vm.runtime.targets.find(target => target.isStage);
      expect(stage?.variables['results-id']?.value).toEqual([4]);
    } finally {
      vm.quit();
    }
  }, 60_000);

  it('virtualizes cross-variable reads independently of deterministic candidate order', async () => {
    for (const seedByte of [0, 1, 2, 3, 4, 5]) {
      const project = makeCrossVariableProject();
      const spriteProject = project.targets.find(target => !target.isStage);
      if (!spriteProject) throw new Error('fixture sprite is unavailable');
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'cross-variable-runtime'),
        stats(project)
      );
      expect(spriteProject.variables['left-id']).toBeUndefined();
      expect(spriteProject.variables['right-id']).toBeUndefined();

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `seed ${seedByte} did not terminate`).toHaveLength(0);
        const stage = vm.runtime.targets.find(target => target.isStage);
        expect(stage?.variables['results-id']?.value, `seed ${seedByte} rewrote usages in the wrong order`).toEqual([2]);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);
});

function collectDispatcherTemplates(project: ScratchProject): Set<string> {
  const templates = new Set<string>();
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_definition' || !value.next) continue;
      const body = target.blocks[value.next];
      if (body && isScratchBlock(body) && (body.opcode === 'control_if' || body.opcode === 'control_if_else')) {
        templates.add(body.opcode);
      }
    }
  }
  return templates;
}

function countIndirectTransitions(project: ScratchProject): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') continue;
      const reporterId = value.inputs['VALUE']?.[1];
      const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
      const indexId = reporter && isScratchBlock(reporter) ? reporter.inputs['INDEX']?.[1] : undefined;
      const index = typeof indexId === 'string' ? target.blocks[indexId] : undefined;
      if (reporter && isScratchBlock(reporter) && reporter.opcode === 'data_itemoflist'
        && index && isScratchBlock(index) && index.opcode === 'operator_mod') count += 1;
    }
  }
  return count;
}

function countAuthenticatedRoutes(project: ScratchProject): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'operator_and') continue;
      const equalityIds = ['OPERAND1', 'OPERAND2'].map(name => value.inputs[name]?.[1]);
      const variableIds = equalityIds.flatMap(equalityId => {
        const equality = typeof equalityId === 'string' ? target.blocks[equalityId] : undefined;
        if (!equality || !isScratchBlock(equality) || equality.opcode !== 'operator_equals') return [];
        const reporterId = equality.inputs['OPERAND1']?.[1];
        const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
        const variableId = reporter && isScratchBlock(reporter) && reporter.opcode === 'data_variable'
          ? reporter.fields['VARIABLE']?.[1]
          : undefined;
        return typeof variableId === 'string' ? [variableId] : [];
      });
      if (variableIds.length === 2 && variableIds[0] !== variableIds[1]) count += 1;
    }
  }
  return count;
}

function corruptTransitionToken(
  project: ScratchProject,
  kind: 'state' | 'tag'
): {readonly before: number; readonly after: number} | undefined {
  for (const target of project.targets) {
    const railIds = new Set<string>();
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'operator_equals') continue;
      const reporterId = value.inputs['OPERAND1']?.[1];
      const expectedId = value.inputs['OPERAND2']?.[1];
      const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
      const expected = typeof expectedId === 'string' ? target.blocks[expectedId] : undefined;
      const expectedOpcode = kind === 'state' ? 'operator_add' : 'operator_subtract';
      const variableId = reporter && isScratchBlock(reporter) && reporter.opcode === 'data_variable'
        ? reporter.fields['VARIABLE']?.[1]
        : undefined;
      if (typeof variableId === 'string' && expected && isScratchBlock(expected) && expected.opcode === expectedOpcode) {
        railIds.add(variableId);
      }
    }
    const storeIds = new Set<string>();
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') continue;
      const variableId = value.fields['VARIABLE']?.[1];
      if (typeof variableId !== 'string' || !railIds.has(variableId)) continue;
      const reporterId = value.inputs['VALUE']?.[1];
      const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
      const listId = reporter && isScratchBlock(reporter) && reporter.opcode === 'data_itemoflist'
        ? reporter.fields['LIST']?.[1]
        : undefined;
      if (typeof listId === 'string') storeIds.add(listId);
    }
    for (const storeId of storeIds) {
      const values = target.lists[storeId]?.[1];
      if (!Array.isArray(values)) continue;
      let changed: {readonly before: number; readonly after: number} | undefined;
      for (const [index, value] of values.entries()) {
        if (typeof value !== 'number') continue;
        const after = value + 1;
        values[index] = after;
        changed ??= {before: value, after};
      }
      if (changed) return changed;
    }
  }
  return undefined;
}

function makeNumericEquationProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'raw-id': ['raw', 'initial']};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: block('event_whenflagclicked', 'set-x', null, true),
    'set-x': block('motion_setx', 'set-y', 'hat', false, {X: [1, [4, '-0']]}),
    'set-y': block('motion_sety', 'store', 'set-x', false, {Y: [1, [4, '5e-324']]}),
    store: block(
      'data_setvariableto',
      null,
      'set-y',
      false,
      {VALUE: [1, [4, '01']]},
      {VARIABLE: ['raw', 'raw-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function makeStringPoolProject(value: string): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'raw-id': ['raw', 'initial']};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: block('event_whenflagclicked', 'store', null, true),
    store: block(
      'data_setvariableto',
      null,
      'hat',
      false,
      {VALUE: [1, [10, value]]},
      {VARIABLE: ['raw', 'raw-id']}
    )
  };
  project.monitors = [{
    id: 'raw-id',
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: 'raw'},
    spriteName: sprite.name,
    value: 'initial',
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  }];
  project.extensions = [];
  return project;
}

function makeFixedListHeapProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {'results-id': ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {};
  sprite.lists = {
    'fixed-a': ['fixed a', ['a0', 'a1']],
    'fixed-b': ['fixed b', [17, 'b1', 'b2']]
  };
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: block('event_whenflagclicked', 'replace', null, true),
    replace: block(
      'data_replaceitemoflist',
      'record-b',
      'hat',
      false,
      {INDEX: [1, [4, '2']], ITEM: [1, [10, 'changed']]},
      {LIST: ['fixed b', 'fixed-b']}
    ),
    'record-b': block(
      'data_addtolist',
      'record-a',
      'replace',
      false,
      {ITEM: [2, 'read-b']},
      {LIST: ['results', 'results-id']}
    ),
    'read-b': block(
      'data_itemoflist',
      null,
      'record-b',
      false,
      {INDEX: [1, [10, '2']]},
      {LIST: ['fixed b', 'fixed-b']}
    ),
    'record-a': block(
      'data_addtolist',
      null,
      'record-b',
      false,
      {ITEM: [2, 'read-a']},
      {LIST: ['results', 'results-id']}
    ),
    'read-a': block(
      'data_itemoflist',
      null,
      'record-a',
      false,
      {INDEX: [1, [10, 'last']]},
      {LIST: ['fixed a', 'fixed-a']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function readPooledString(project: ScratchProject, ownerId: string, inputName: string): string | undefined {
  const target = project.targets.find(candidate => candidate.blocks[ownerId] !== undefined);
  const owner = target?.blocks[ownerId];
  if (!target || !owner || !isScratchBlock(owner)) return undefined;
  const joinId = owner.inputs[inputName]?.[1];
  const join = typeof joinId === 'string' ? target.blocks[joinId] : undefined;
  if (!join || !isScratchBlock(join) || join.opcode !== 'operator_join') return undefined;
  const parts: string[] = [];
  for (const name of ['STRING1', 'STRING2']) {
    const reporterId = join.inputs[name]?.[1];
    const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
    if (!reporter || !isScratchBlock(reporter) || reporter.opcode !== 'data_itemoflist') return undefined;
    const listId = reporter.fields['LIST']?.[1];
    const index = reporter.inputs['INDEX']?.[1];
    if (typeof listId !== 'string' || !Array.isArray(index)) return undefined;
    const declaration = target.lists[listId];
    const values = declaration?.[1];
    const slot = Number(index[1]);
    const part = Array.isArray(values) ? values[slot - 1] : undefined;
    if (typeof part !== 'string') return undefined;
    parts.push(part);
  }
  return parts.join('');
}

function makeIncrementProject(length: number): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'counter-id': ['counter', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: block('event_whenflagclicked', length === 0 ? null : 'increment-0', null, true)
  };
  for (let index = 0; index < length; index += 1) {
    sprite.blocks[`increment-${index}`] = block(
      'data_changevariableby',
      index + 1 < length ? `increment-${index + 1}` : null,
      index === 0 ? 'hat' : `increment-${index - 1}`,
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['counter', 'counter-id']}
    );
  }
  project.monitors = [{
    id: 'counter-id',
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: 'counter'},
    spriteName: sprite.name,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  }];
  project.extensions = [];
  return project;
}

function makeCloneProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {'results-id': ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'local-value': ['value', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'set-five', null, true),
    'set-five': block(
      'data_setvariableto',
      'create-clone',
      'flag',
      false,
      {VALUE: [1, [4, '5']]},
      {VARIABLE: ['value', 'local-value']}
    ),
    'create-clone': block(
      'control_create_clone_of',
      'set-nine',
      'set-five',
      false,
      {CLONE_OPTION: [1, 'clone-menu']}
    ),
    'clone-menu': {
      ...block('control_create_clone_of_menu', null, 'create-clone', false, {}, {CLONE_OPTION: ['_myself_', null]}),
      shadow: true
    },
    'set-nine': block(
      'data_setvariableto',
      null,
      'create-clone',
      false,
      {VALUE: [1, [4, '9']]},
      {VARIABLE: ['value', 'local-value']}
    ),
    'clone-hat': block('control_start_as_clone', 'change-clone', null, true),
    'change-clone': block(
      'data_changevariableby',
      'record-clone',
      'clone-hat',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['value', 'local-value']}
    ),
    'record-clone': block(
      'data_addtolist',
      'delete-clone',
      'change-clone',
      false,
      {ITEM: [1, [12, 'value', 'local-value']]},
      {LIST: ['results', 'results-id']}
    ),
    'delete-clone': block('control_delete_this_clone', null, 'record-clone', false)
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function makeLossyOutlineProject(): ScratchProject {
  const project = makeIncrementProject(4);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture sprite is unavailable');
  const last = sprite.blocks['increment-3'];
  if (!last || !isScratchBlock(last)) throw new Error('fixture increment is unavailable');
  last.next = 'choice';
  sprite.blocks['choice'] = block(
    'control_if_else',
    null,
    'increment-3',
    false,
    {CONDITION: [2, 'equals'], SUBSTACK: [2, 'add-ten'], SUBSTACK2: [2, 'add-hundred']}
  );
  sprite.blocks['equals'] = block(
    'operator_equals',
    null,
    'choice',
    false,
    {OPERAND1: [1, [4, '1']], OPERAND2: [1, [4, '1']]}
  );
  sprite.blocks['add-ten'] = block(
    'data_changevariableby',
    null,
    'choice',
    false,
    {VALUE: [1, [4, '10']]},
    {VARIABLE: ['counter', 'counter-id']}
  );
  sprite.blocks['add-hundred'] = block(
    'data_changevariableby',
    null,
    'choice',
    false,
    {VALUE: [1, [4, '100']]},
    {VARIABLE: ['counter', 'counter-id']}
  );
  return project;
}

function makeSelfReferenceProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {'results-id': ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'local-value': ['value', 2]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'double', null, true),
    double: block(
      'data_changevariableby',
      'record',
      'flag',
      false,
      {VALUE: [3, [12, 'value', 'local-value'], [4, '1']]},
      {VARIABLE: ['value', 'local-value']}
    ),
    record: block(
      'data_addtolist',
      null,
      'double',
      false,
      {ITEM: [3, [12, 'value', 'local-value'], [10, '']]},
      {LIST: ['results', 'results-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function makeCrossVariableProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {'results-id': ['results', []]};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'left-id': ['left', 1], 'right-id': ['right', 2]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    flag: block('event_whenflagclicked', 'copy', null, true),
    copy: block(
      'data_setvariableto',
      'record',
      'flag',
      false,
      {VALUE: [3, [12, 'right', 'right-id'], [10, '']]},
      {VARIABLE: ['left', 'left-id']}
    ),
    record: block(
      'data_addtolist',
      null,
      'copy',
      false,
      {ITEM: [3, [12, 'left', 'left-id'], [10, '']]},
      {LIST: ['results', 'results-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  topLevel: boolean,
  inputs: ScratchBlock['inputs'] = {},
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
    ...(topLevel ? {x: 10, y: 20} : {})
  };
}

function stats(project: ScratchProject, mode: ObfuscationMode = 'no-preserve'): ObfuscationStats {
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
    warnings: []
  };
}
