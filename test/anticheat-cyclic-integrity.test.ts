import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock, stageOf} from '../src/model/blocks.js';
import {collectVariableCandidates, countObjectBlocks} from '../src/obfuscation/analysis.js';
import {
  applyAntiCheatTransform,
  applyGameplayStateProtection,
  type GameplayIntegrityPair,
  type GameplayStateProtectionResult
} from '../src/obfuscation/anticheat.js';
import type {JsonValue, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  value: unknown;
}

interface RuntimeTarget {
  isStage: boolean;
  variables: Record<string, RuntimeVariable>;
}

interface ScratchVmInstance {
  runtime: {
    _step(): void;
    targets: RuntimeTarget[];
    threads: unknown[];
  };
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  start(): void;
  greenFlag(): void;
  quit(): void;
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object'
  || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('cyclic gameplay integrity groups', () => {
  it('forms deterministic bounded cycles per compatible scope and refreshes the two affected tags in original order', () => {
    const first = scopedProject(9, 5);
    const second = structuredClone(first);
    const initialValues = declarationValues(first);
    const blocksBefore = countObjectBlocks(first);
    const firstState = protectGameplay(first, 'structure');
    const secondState = protectGameplay(second, 'structure');

    expect(first).toEqual(second);
    expect(firstState).toEqual(secondState);
    expect(firstState.protectedVariableIds).toHaveLength(14);
    expect(firstState.integrityPairs).toHaveLength(14);
    expect(countObjectBlocks(first) - blocksBefore).toBe(firstState.generatedBlockCount);
    expect(firstState.generatedBlockCount).toBeLessThan(14 * 100);

    const stagePairs = firstState.integrityPairs.filter(pair => pair.declarationTargetIndex === 0);
    const spritePairs = firstState.integrityPairs.filter(pair => pair.declarationTargetIndex === 1);
    expect(groupSizeHistogram(stagePairs)).toEqual({2: 2, 3: 3, 4: 4});
    expect(groupSizeHistogram(spritePairs)).toEqual({2: 2, 3: 3});
    for (const pair of firstState.integrityPairs) {
      expect(pair.groupSize).toBeGreaterThanOrEqual(2);
      expect(pair.groupSize).toBeLessThanOrEqual(4);
      expect(pair.nextValueId).toBeDefined();
      expect(pair.linkSecret).toHaveLength(32);
      expectCycleCloses(pair, firstState.integrityPairs);
      const own = requiredInitialValue(initialValues, pair.declarationTargetIndex, pair.valueId);
      const next = requiredInitialValue(initialValues, pair.declarationTargetIndex, requiredString(pair.nextValueId));
      const declaration = first.targets[pair.declarationTargetIndex]?.variables[pair.tagId];
      expect(declaration?.[1]).toBe(expectedTag(pair, own, next));
    }

    const pairOrder = new Map(firstState.integrityPairs.map((pair, index) => [pair.valueId, index]));
    for (const pair of firstState.integrityPairs) {
      const target = requiredTarget(first, pair.usageTargetIndex);
      const actual = refreshTagIds(target, `write-${pair.valueId}`, 2);
      const predecessor = firstState.integrityPairs.find(candidate => (
        candidate.declarationTargetIndex === pair.declarationTargetIndex
        && candidate.nextValueId === pair.valueId
      ));
      if (!predecessor) throw new Error('cyclic predecessor is unavailable');
      const expected = [pair, predecessor]
        .sort((left, right) => requiredOrder(pairOrder, left.valueId) - requiredOrder(pairOrder, right.valueId))
        .map(candidate => candidate.tagId);
      expect(actual).toEqual(expected);
    }
    validateProject(first);
  });

  it('keeps a singleton in the independent fallback shape', () => {
    const project = scopedProject(1, 0);
    const initial = declarationValues(project);
    const state = protectGameplay(project, 'singleton');
    const pair = requiredPair(state, 'stage-0');
    expect(pair).toMatchObject({groupSize: 1, groupPosition: 0});
    expect(pair.nextValueId).toBeUndefined();
    expect(pair.linkSecret).toBeUndefined();
    expect(stageOf(project).variables[pair.tagId]?.[1]).toBe(
      expectedTag(pair, requiredInitialValue(initial, 0, pair.valueId))
    );
    expect(refreshTagIds(stageOf(project), 'write-stage-0', 1)).toEqual([pair.tagId]);
    validateProject(project);
  });

  it('matches the official runtime for legal numeric, Unicode string, and boolean-like writes', async () => {
    const source = cyclicRuntimeProject();
    const transformed = structuredClone(source);
    const state = protectGameplay(transformed, 'legal-runtime');
    applyAntiCheatTransform(transformed, generator('legal-watchdog'), {gameplayState: state});
    validateProject(transformed);

    const sourceVm = await loadVm(source);
    const transformedVm = await loadVm(transformed);
    try {
      run(sourceVm, 80);
      run(transformedVm, 80);
      const sourceStage = runtimeStage(sourceVm);
      const transformedStage = runtimeStage(transformedVm);
      expect(transformedStage.variables['results']?.value).toEqual(sourceStage.variables['results']?.value);
      for (const id of ['a', 'b', 'c']) {
        expect(transformedStage.variables[id]?.value).toEqual(sourceStage.variables[id]?.value);
      }
      for (const pair of state.integrityPairs) {
        const own = requiredRuntimeScalar(transformedStage, pair.valueId);
        const next = pair.nextValueId === undefined
          ? undefined
          : requiredRuntimeScalar(transformedStage, pair.nextValueId);
        expect(transformedStage.variables[pair.tagId]?.value).toBe(expectedTag(pair, own, next));
      }
      const breachId = requiredString(state.breachVariableId);
      expect(transformedStage.variables[breachId]?.value).toBe(stageOf(transformed).variables[breachId]?.[1]);
    } finally {
      sourceVm.quit();
      transformedVm.quit();
    }
  }, 30_000);

  it.each(['value', 'tag'] as const)('trips before gameplay after a linked %s edit', async mutation => {
    const project = cyclicRuntimeProject();
    const state = protectGameplay(project, `tamper-${mutation}`);
    const stage = stageOf(project);
    const pair = requiredPair(state, 'b');
    if (mutation === 'value') {
      const declaration = stage.variables[pair.valueId];
      if (!declaration) throw new Error('protected value declaration is unavailable');
      declaration[1] = 'edited';
    } else {
      const declaration = stage.variables[pair.tagId];
      if (!declaration || typeof declaration[1] !== 'string') throw new Error('integrity tag is unavailable');
      declaration[1] += '!';
    }
    applyAntiCheatTransform(project, generator(`tamper-watchdog-${mutation}`), {gameplayState: state});
    validateProject(project);

    const vm = await loadVm(project);
    try {
      run(vm, 80);
      expect(runtimeStage(vm).variables['results']?.value).toEqual([]);
      expectBreachTripped(vm, project, state);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('trips when a legal write omits its predecessor-tag refresh', async () => {
    const project = cyclicRuntimeProject();
    const state = protectGameplay(project, 'missing-refresh');
    const stage = stageOf(project);
    const own = requiredPair(state, 'a');
    const predecessor = state.integrityPairs.find(pair => pair.nextValueId === own.valueId);
    if (!predecessor) throw new Error('predecessor integrity pair is unavailable');
    const refreshIds = refreshSetterIds(stage, 'set-a', 2);
    const predecessorRefreshId = refreshIds.find(id => requiredBlock(stage, id).fields['VARIABLE']?.[1] === predecessor.tagId);
    if (!predecessorRefreshId) throw new Error('predecessor refresh is unavailable');
    requiredBlock(stage, predecessorRefreshId).fields['VARIABLE'] = [own.tagName, own.tagId];

    applyAntiCheatTransform(project, generator('missing-refresh-watchdog'), {gameplayState: state});
    validateProject(project);
    const vm = await loadVm(project);
    try {
      run(vm, 80);
      expect(runtimeStage(vm).variables['results']?.value).toEqual([]);
      expectBreachTripped(vm, project, state);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('length-prefixes linked Unicode values so link-token relocation cannot preserve a tag', async () => {
    const project = cyclicRuntimeProject();
    const state = protectGameplay(project, 'injective-linked-tag');
    const stage = stageOf(project);
    const pair = requiredPair(state, 'a');
    const nextValueId = requiredString(pair.nextValueId);
    const linkSecret = requiredString(pair.linkSecret);
    const originalOwn = `\u03a9\u{1f642}:${linkSecret}:\u7d42`;
    const suffix = '\u27e6\u5c3e\u{1f642}\u27e7';
    const originalNext = linkSecret + suffix;
    const relocatedOwn = originalOwn + linkSecret;
    const relocatedNext = suffix;

    expect(pair.secret + originalOwn + linkSecret + originalNext).toBe(
      pair.secret + relocatedOwn + linkSecret + relocatedNext
    );
    expect(expectedTag(pair, originalOwn, originalNext)).not.toBe(
      expectedTag(pair, relocatedOwn, relocatedNext)
    );

    setDeclaredScalar(stage, pair.valueId, originalOwn);
    setDeclaredScalar(stage, nextValueId, originalNext);
    refreshInitialTags(project, state);
    expect(stage.variables[pair.tagId]?.[1]).toBe(expectedTag(pair, originalOwn, originalNext));

    const validProject = structuredClone(project);
    applyAntiCheatTransform(validProject, generator('injective-valid-watchdog'), {gameplayState: state});
    validateProject(validProject);
    const validVm = await loadVm(validProject);
    try {
      run(validVm, 80);
      expect(runtimeStage(validVm).variables['results']?.value).not.toEqual([]);
      const breachId = requiredString(state.breachVariableId);
      expect(runtimeStage(validVm).variables[breachId]?.value).toBe(
        stageOf(validProject).variables[breachId]?.[1]
      );
    } finally {
      validVm.quit();
    }

    setDeclaredScalar(stage, pair.valueId, relocatedOwn);
    setDeclaredScalar(stage, nextValueId, relocatedNext);
    applyAntiCheatTransform(project, generator('injective-tamper-watchdog'), {gameplayState: state});
    validateProject(project);
    const tamperedVm = await loadVm(project);
    try {
      run(tamperedVm, 80);
      expect(runtimeStage(tamperedVm).variables['results']?.value).toEqual([]);
      expectBreachTripped(tamperedVm, project, state);
    } finally {
      tamperedVm.quit();
    }
  }, 30_000);
});

function protectGameplay(project: ScratchProject, domain: string): GameplayStateProtectionResult {
  return applyGameplayStateProtection(project, generator(domain), collectVariableCandidates(project));
}

function generator(domain: string): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => ((index * 43) + 7) & 0xff),
    `test:cyclic-integrity:${domain}`
  );
}

function scopedProject(stageCount: number, spriteCount: number): ScratchProject {
  const project = createFixtureProject();
  const stage = stageOf(project);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture sprite is unavailable');
  configureScope(stage, 'stage', stageCount);
  configureScope(sprite, 'sprite', spriteCount);
  project.targets = spriteCount === 0 ? [stage] : [stage, sprite];
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function configureScope(target: ScratchTarget, prefix: string, count: number): void {
  target.variables = {};
  target.lists = {};
  target.broadcasts = {};
  target.comments = {};
  target.blocks = {};
  if (count === 0) return;
  target.blocks['hat'] = block('event_whenflagclicked', `write-${prefix}-0`, null, true);
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${index}`;
    const previous = index === 0 ? 'hat' : `write-${prefix}-${index - 1}`;
    const next = index + 1 < count ? `write-${prefix}-${index + 1}` : null;
    target.variables[id] = [`${prefix} value ${index}`, index];
    target.blocks[`write-${id}`] = block(
      'data_setvariableto',
      next,
      previous,
      false,
      {VALUE: [1, [4, index + 10]]},
      {VARIABLE: [`${prefix} value ${index}`, id]}
    );
  }
}

function cyclicRuntimeProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = stageOf(project);
  project.targets = [stage];
  project.monitors = [];
  project.extensions = [];
  stage.variables = {
    a: ['a', 1.5],
    b: ['b', ' initial '],
    c: ['c', true]
  };
  stage.lists = {results: ['results', []]};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: block('event_whenflagclicked', 'set-a', null, true),
    'set-a': block('data_setvariableto', 'change-a', 'hat', false, {VALUE: [1, [10, '7']]}, {VARIABLE: ['a', 'a']}),
    'change-a': block('data_changevariableby', 'set-b', 'set-a', false, {VALUE: [1, [4, '5']]}, {VARIABLE: ['a', 'a']}),
    'set-b': block('data_setvariableto', 'set-c', 'change-a', false, {VALUE: [1, [10, ' MiXeD 🙂 ']]}, {VARIABLE: ['b', 'b']}),
    'set-c': block('data_setvariableto', 'read-a', 'set-b', false, {VALUE: [1, [10, 'false']]}, {VARIABLE: ['c', 'c']}),
    'read-a': block('data_addtolist', 'read-b', 'set-c', false, {ITEM: [1, [12, 'a', 'a']]}, {LIST: ['results', 'results']}),
    'read-b': block('data_addtolist', 'read-c', 'read-a', false, {ITEM: [1, [12, 'b', 'b']]}, {LIST: ['results', 'results']}),
    'read-c': block('data_addtolist', null, 'read-b', false, {ITEM: [1, [12, 'c', 'c']]}, {LIST: ['results', 'results']})
  };
  validateProject(project);
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
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function declarationValues(project: ScratchProject): Map<string, boolean | number | string> {
  const values = new Map<string, boolean | number | string>();
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [id, declaration] of Object.entries(target.variables)) {
      const value = declaration[1];
      if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
        values.set(`${targetIndex}\u0000${id}`, value);
      }
    }
  }
  return values;
}

function requiredInitialValue(
  values: ReadonlyMap<string, boolean | number | string>,
  targetIndex: number,
  id: string
): boolean | number | string {
  const value = values.get(`${targetIndex}\u0000${id}`);
  if (value === undefined) throw new Error('initial scalar is unavailable');
  return value;
}

function expectedTag(
  pair: GameplayIntegrityPair,
  own: boolean | number | string,
  next?: boolean | number | string
): string {
  const ownString = String(own);
  if (pair.nextValueId === undefined) return pair.secret + ownString;
  if (pair.linkSecret === undefined || next === undefined) throw new Error('linked tag expectation is unavailable');
  return pair.secret + String(ownString.length) + ':' + ownString + pair.linkSecret + String(next);
}

function setDeclaredScalar(target: ScratchTarget, id: string, value: boolean | number | string): void {
  const declaration = target.variables[id];
  if (!declaration) throw new Error(`scalar declaration ${id} is unavailable`);
  declaration[1] = value;
}

function refreshInitialTags(project: ScratchProject, state: GameplayStateProtectionResult): void {
  for (const pair of state.integrityPairs) {
    const target = requiredTarget(project, pair.declarationTargetIndex);
    const own = requiredDeclaredScalar(target, pair.valueId);
    const next = pair.nextValueId === undefined
      ? undefined
      : requiredDeclaredScalar(target, pair.nextValueId);
    setDeclaredScalar(target, pair.tagId, expectedTag(pair, own, next));
  }
}

function requiredDeclaredScalar(target: ScratchTarget, id: string): boolean | number | string {
  const value = target.variables[id]?.[1];
  if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`declared scalar ${id} is unavailable`);
  }
  return value;
}

function groupSizeHistogram(pairs: readonly GameplayIntegrityPair[]): Record<number, number> {
  const result: Record<number, number> = {};
  for (const pair of pairs) result[pair.groupSize] = (result[pair.groupSize] ?? 0) + 1;
  return result;
}

function expectCycleCloses(start: GameplayIntegrityPair, pairs: readonly GameplayIntegrityPair[]): void {
  let current = start;
  const visited = new Set<string>();
  for (let index = 0; index < start.groupSize; index += 1) {
    expect(visited.has(current.valueId)).toBe(false);
    visited.add(current.valueId);
    const nextId = requiredString(current.nextValueId);
    const next = pairs.find(pair => (
      pair.declarationTargetIndex === current.declarationTargetIndex
      && pair.valueId === nextId
    ));
    if (!next) throw new Error('cycle member is unavailable');
    current = next;
  }
  expect(current.valueId).toBe(start.valueId);
  expect(visited).toHaveLength(start.groupSize);
}

function refreshTagIds(target: ScratchTarget, writerId: string, count: number): string[] {
  return refreshSetterIds(target, writerId, count).map(id => {
    const tagId = requiredBlock(target, id).fields['VARIABLE']?.[1];
    return requiredString(tagId);
  });
}

function refreshSetterIds(target: ScratchTarget, writerId: string, count: number): string[] {
  const ids: string[] = [];
  let current = requiredBlock(target, writerId).next;
  for (let index = 0; index < count; index += 1) {
    const id = requiredString(current);
    const setter = requiredBlock(target, id);
    if (setter.opcode !== 'data_setvariableto') throw new Error('integrity refresh setter is unavailable');
    ids.push(id);
    current = setter.next;
  }
  return ids;
}

function requiredOrder(order: ReadonlyMap<string, number>, id: string): number {
  const value = order.get(id);
  if (value === undefined) throw new Error('integrity order is unavailable');
  return value;
}

function requiredPair(state: GameplayStateProtectionResult, id: string): GameplayIntegrityPair {
  const pair = state.integrityPairs.find(candidate => candidate.valueId === id);
  if (!pair) throw new Error(`integrity pair ${id} is unavailable`);
  return pair;
}

function requiredTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`target ${index} is unavailable`);
  return target;
}

function requiredBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!isScratchBlock(value)) throw new Error(`block ${id} is unavailable`);
  return value;
}

function requiredString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('required string is unavailable');
  return value;
}

async function loadVm(project: ScratchProject): Promise<ScratchVmInstance> {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  await vm.loadProject(createFixtureArchive(project));
  return vm;
}

function run(vm: ScratchVmInstance, steps: number): void {
  vm.start();
  vm.greenFlag();
  for (let index = 0; index < steps && vm.runtime.threads.length > 0; index += 1) vm.runtime._step();
}

function runtimeStage(vm: ScratchVmInstance): RuntimeTarget {
  const stage = vm.runtime.targets.find(target => target.isStage);
  if (!stage) throw new Error('runtime Stage is unavailable');
  return stage;
}

function requiredRuntimeScalar(target: RuntimeTarget, id: string): boolean | number | string {
  const value = target.variables[id]?.value;
  if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`runtime scalar ${id} is unavailable`);
  }
  return value;
}

function expectBreachTripped(
  vm: ScratchVmInstance,
  project: ScratchProject,
  state: GameplayStateProtectionResult
): void {
  const breachId = requiredString(state.breachVariableId);
  const safeValue = stageOf(project).variables[breachId]?.[1];
  expect(runtimeStage(vm).variables[breachId]?.value).not.toBe(safeValue);
  expect(vm.runtime.threads).toHaveLength(0);
}
