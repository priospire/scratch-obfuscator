import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
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
  it('executes every command in a 26-block run exactly once across deterministic dispatcher permutations', async () => {
    for (const seedByte of [0, 1, 2, 3, 4, 5, 17, 255]) {
      const project = makeIncrementProject(26);
      const resultStats = stats(project);
      let virtualizationSnapshot: ScratchProject | undefined;
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), 'dispatcher-runtime'),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        },
        true
      );
      expect(resultStats.virtualizedBlocks, `seed ${seedByte} did not retain expanded cohorts`).toBe(24);
      if (!virtualizationSnapshot) throw new Error('expanded dispatcher snapshot is unavailable');
      expect(countPacketRoutes(virtualizationSnapshot)).toBe(24);
      expect(virtualizationSnapshot.targets.flatMap(target => Object.values(target.blocks)).filter(value => (
        isScratchBlock(value)
        && value.opcode === 'data_changevariableby'
        && value.fields['VARIABLE']?.[1] === 'counter-id'
      ))).toHaveLength(26);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(virtualizationSnapshot));
        vm.start();
        vm.greenFlag();
        let schedulerSteps = 0;
        for (; schedulerSteps < 500 && vm.runtime.threads.length > 0; schedulerSteps += 1) vm.runtime._step();
        expect(vm.runtime.threads, `seed ${seedByte} did not terminate`).toHaveLength(0);
        expect(schedulerSteps, `seed ${seedByte} introduced a native yield`).toBe(1);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['counter-id']?.value, `seed ${seedByte} executed a chunk out of order`).toBe(26);
      } finally {
        vm.quit();
      }
    }
  }, 120_000);

  it('binds packet state to full same-parity post-command witnesses without changing the result', async () => {
    expect([String(11).length, String(1001).length]).toEqual([2, 4]);
    expect(String(11).length % 2).toBe(String(1001).length % 2);

    const states: Record<string, unknown>[] = [];
    for (const initialValue of [10, 1000]) {
      const project = makeSameParityWitnessProject(initialValue);
      let virtualizationSnapshot: ScratchProject | undefined;
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(63), 'dispatcher-full-witness-runtime'),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        }
      );
      expect(resultStats.virtualizedBlocks).toBe(4);
      if (!virtualizationSnapshot) throw new Error('full-witness virtualization snapshot is unavailable');

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(virtualizationSnapshot));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['counter-id']?.value).toBe('0');
        states.push(Object.fromEntries(Object.entries(sprite?.variables ?? {}).flatMap(([id, variable]) => (
          id === 'counter-id' || Array.isArray(variable.value) ? [] : [[id, variable.value]]
        ))));
      } finally {
        vm.quit();
      }
    }

    const first = states[0];
    const second = states[1];
    if (!first || !second) throw new Error('full-witness runtime state is unavailable');
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    expect(Object.keys(first).some(id => !Object.is(first[id], second[id]))).toBe(true);
  }, 60_000);

  for (const [tokenKind, label, seedByte] of [
    ['x', 'encoded state', 74],
    ['x-fraction', 'fractional encoded state', 77],
    ['y', 'authenticated rail', 81],
    ['y-fraction', 'fractional authenticated rail', 82],
    ['key', 'dispatcher key', 73],
    ['key-fraction', 'fractional dispatcher key', 80],
    ['witness', 'dispatcher witness', 79],
    ['witness-fraction', 'fractional dispatcher witness', 83],
    ['step', 'dispatcher step', 84],
    ['descriptor-0', 'descriptor word', 85],
    ['packet-0', 'packet word', 87],
    ['route-selector', 'dynamic route selector', 91],
    ['leaf-armed', 'handler armed state', 92],
    ['checksum-count', 'checksum loop count', 93],
    ['terminal-phase', 'terminal phase', 94],
    ['repeat-count', 'missing driver call', 90],
    ['repeat-count-plus', 'extra driver call', 95]
  ] as const) {
    it(`rejects ${label} tampering`, async () => {
      const project = makeIncrementProject(5);
      const resultStats = stats(project);
      let virtualizationSnapshot: ScratchProject | undefined;
      applyAggressiveTransforms(
        project,
        'no-preserve',
        new DeterministicGenerator(new Uint8Array(32).fill(seedByte), `dispatcher-${tokenKind}-tamper-runtime`),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        }
      );

      expect(resultStats.virtualizedBlocks).toBe(4);
      if (!virtualizationSnapshot) throw new Error('dispatcher virtualization snapshot is unavailable');
      expect(countPacketRoutes(virtualizationSnapshot)).toBe(resultStats.virtualizedBlocks);
      insertDispatcherTamper(virtualizationSnapshot, tokenKind);

      const vm = new ScratchVm();
      vm.attachStorage(new ScratchStorage());
      try {
        await vm.loadProject(createFixtureArchive(virtualizationSnapshot));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads).toHaveLength(0);
        const sprite = vm.runtime.targets.find(target => !target.isStage);
        expect(sprite?.variables['counter-id']?.value).not.toBe(5);
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

function countPacketRoutes(project: ScratchProject): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'control_if') continue;
      const commandId = value.inputs['SUBSTACK']?.[1];
      const command = typeof commandId === 'string' ? target.blocks[commandId] : undefined;
      const conditionId = value.inputs['CONDITION']?.[1];
      const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
      if (!isScratchBlock(command) || command.next === null) continue;
      const witnessSetter = target.blocks[command.next];
      const armedSetter = isScratchBlock(witnessSetter) && witnessSetter.next !== null
        ? target.blocks[witnessSetter.next]
        : undefined;
      if (
        !isScratchBlock(witnessSetter)
        || witnessSetter.opcode !== 'data_setvariableto'
        || !isScratchBlock(armedSetter)
        || armedSetter.opcode !== 'data_setvariableto'
        || armedSetter.next !== null
      ) continue;
      if (!isScratchBlock(condition) || condition.opcode !== 'operator_equals') continue;
      count += 1;
    }
  }
  return count;
}

function insertDispatcherTamper(project: ScratchProject, kind: string): void {
  const target = project.targets.find(candidate => candidate.variables['counter-id'] !== undefined);
  if (!target) throw new Error('dispatcher tamper target is unavailable');
  const callsByCode = new Map<string, Array<[string, ScratchBlock]>>();
  for (const [id, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
    const code = value.mutation?.['proccode'];
    if (typeof code !== 'string') continue;
    const calls = callsByCode.get(code) ?? [];
    calls.push([id, value]);
    callsByCode.set(code, calls);
  }
  const calls = [...callsByCode.values()].find(group => group.length === 5);
  if (!calls) throw new Error('dispatcher call chain is unavailable');
  const terminalEntry = calls.find(([, call]) => {
    const parent = call.parent === null ? undefined : target.blocks[call.parent];
    return isScratchBlock(parent)
      && parent.opcode === 'data_changevariableby'
      && isPrimitive(parent.inputs['VALUE']?.[1])
      && Number(parent.inputs['VALUE']?.[1]?.[1]) === 2;
  });
  if (!terminalEntry) throw new Error('dispatcher terminal call is unavailable');
  const driverEntries = calls.filter(entry => entry !== terminalEntry);
  const driverIds = new Set(driverEntries.map(([id]) => id));
  const orderedDrivers: Array<[string, ScratchBlock]> = [];
  let current = driverEntries.find(([, call]) => call.parent === null || !driverIds.has(call.parent));
  while (current) {
    orderedDrivers.push(current);
    const nextId = current[1].next;
    current = nextId === null ? undefined : driverEntries.find(([id]) => id === nextId);
  }
  if (orderedDrivers.length !== 4) throw new Error('dispatcher driver chain is incomplete');
  const firstDriver = orderedDrivers[0];
  const lastDriver = orderedDrivers.at(-1);
  if (!firstDriver || !lastDriver) throw new Error('dispatcher driver endpoints are unavailable');
  if (kind === 'repeat-count' || kind === 'repeat-count-plus') {
    const [lastId, lastCall] = lastDriver;
    const previous = orderedDrivers.at(-2);
    const terminalPhaseId = lastCall.next;
    const terminalPhase = terminalPhaseId === null ? undefined : target.blocks[terminalPhaseId];
    if (!previous || !isScratchBlock(terminalPhase)) throw new Error('dispatcher driver splice is unavailable');
    if (kind === 'repeat-count') {
      previous[1].next = terminalPhaseId;
      terminalPhase.parent = previous[0];
      delete target.blocks[lastId];
    } else {
      const extraId = 'test-extra-driver-call';
      lastCall.next = extraId;
      target.blocks[extraId] = {...structuredClone(lastCall), parent: lastId, next: terminalPhaseId};
      terminalPhase.parent = extraId;
    }
    return;
  }
  if (kind === 'terminal-phase') {
    const phase = terminalEntry[1].parent === null ? undefined : target.blocks[terminalEntry[1].parent];
    if (!isScratchBlock(phase) || phase.opcode !== 'data_changevariableby') {
      throw new Error('dispatcher terminal phase setter is unavailable');
    }
    phase.inputs['VALUE'] = [1, [4, '1']];
    return;
  }
  if (kind === 'checksum-count') {
    const checksumRepeat = Object.values(target.blocks).find(value => {
      if (!isScratchBlock(value) || value.opcode !== 'control_repeat') return false;
      const times = value.inputs['TIMES']?.[1];
      const lengthReporter = typeof times === 'string' ? target.blocks[times] : undefined;
      return isScratchBlock(lengthReporter) && lengthReporter.opcode === 'data_lengthoflist';
    });
    if (!isScratchBlock(checksumRepeat)) throw new Error('dispatcher checksum loop is unavailable');
    checksumRepeat.inputs['TIMES'] = [1, [4, '9']];
    return;
  }
  if (kind === 'leaf-armed') {
    const command = target.blocks['increment-0'];
    const witnessSetter = isScratchBlock(command) && command.next !== null ? target.blocks[command.next] : undefined;
    const armedSetter = isScratchBlock(witnessSetter) && witnessSetter.next !== null
      ? target.blocks[witnessSetter.next]
      : undefined;
    if (!isScratchBlock(armedSetter) || armedSetter.opcode !== 'data_setvariableto') {
      throw new Error('dispatcher leaf armed setter is unavailable');
    }
    armedSetter.inputs['VALUE'] = [1, [4, '0']];
    return;
  }
  if (kind === 'route-selector') {
    const command = target.blocks['increment-0'];
    const route = isScratchBlock(command) && command.parent !== null ? target.blocks[command.parent] : undefined;
    const conditionId = isScratchBlock(route) ? route.inputs['CONDITION']?.[1] : undefined;
    const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
    if (!isScratchBlock(condition) || condition.opcode !== 'operator_equals') {
      throw new Error('dispatcher route selector condition is unavailable');
    }
    condition.inputs['OPERAND2'] = [1, [4, '0']];
    return;
  }
  const tableKinds = ['descriptor-0', 'packet-0'];
  const tableOrdinal = tableKinds.indexOf(kind);
  if (tableOrdinal >= 0) {
    const tables = Object.entries(target.lists)
      .filter(([, declaration]) => Array.isArray(declaration[1]) && declaration[1].length === 10)
      .sort(([left], [right]) => left.localeCompare(right));
    const table = tables[tableOrdinal];
    const values = table?.[1][1];
    if (!Array.isArray(values) || values.length !== 10) throw new Error('dispatcher packet table is unavailable');
    values[0] = Number(values[0]) + 1;
    return;
  }

  const armedSetterId = firstDriver[1].parent;
  const armedSetter = armedSetterId === null ? undefined : target.blocks[armedSetterId];
  if (!isScratchBlock(armedSetter) || armedSetter.opcode !== 'data_setvariableto') {
    throw new Error('dispatcher entry chain is unavailable');
  }
  const entrySetters: ScratchBlock[] = [armedSetter];
  let predecessor = armedSetter;
  while (entrySetters.length < 6 && predecessor.parent !== null) {
    const candidate = target.blocks[predecessor.parent];
    if (!isScratchBlock(candidate) || candidate.opcode !== 'data_setvariableto') break;
    entrySetters.unshift(candidate);
    predecessor = candidate;
  }
  if (entrySetters.length !== 6) throw new Error('dispatcher entry setter chain is incomplete');
  const setterIndex = kind.startsWith('step')
    ? 0
    : kind.startsWith('witness')
      ? 1
      : kind.startsWith('key')
        ? 2
        : kind.startsWith('x')
          ? 3
          : kind.startsWith('y')
            ? 4
            : -1;
  const selected = entrySetters[setterIndex];
  const variableId = selected?.fields['VARIABLE']?.[1];
  const variableName = typeof variableId === 'string' ? target.variables[variableId]?.[0] : undefined;
  if (typeof variableId !== 'string' || typeof variableName !== 'string') {
    throw new Error(`dispatcher ${kind} variable is unavailable`);
  }
  const tamperId = `test-${kind}-tamper`;
  armedSetter.next = tamperId;
  firstDriver[1].parent = tamperId;
  target.blocks[tamperId] = block(
    'data_changevariableby',
    firstDriver[0],
    armedSetterId,
    false,
    {VALUE: [1, [4, kind.endsWith('fraction') ? '0.5' : '1']]},
    {VARIABLE: [variableName, variableId]}
  );
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
  project.monitors = [];
  project.extensions = [];
  return project;
}

function makeSameParityWitnessProject(initialValue: number): ScratchProject {
  const project = makeIncrementProject(5);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('full-witness fixture sprite is unavailable');
  sprite.variables['counter-id'] = ['counter', initialValue];
  sprite.blocks['increment-4'] = block(
    'data_setvariableto',
    null,
    'increment-3',
    false,
    {VALUE: [1, [4, '0']]},
    {VARIABLE: ['counter', 'counter-id']}
  );
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
