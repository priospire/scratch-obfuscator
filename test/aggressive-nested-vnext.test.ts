import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {JsonValue, ObfuscationStats, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
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
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {targets: RuntimeTarget[]; threads: unknown[]; _step(): void};
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

describe('nested no-preserve virtualization', () => {
  it('uses the centralized official-hat inventory for extension-hat entry edges', () => {
    const project = extensionHatProject();
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x37), 'extension-hat-edge-vnext'),
      stats(project)
    );

    const stage = requireTarget(project, 0);
    const hat = requireObjectBlock(stage, 'extension-hat');
    expect(hat.next).not.toBe('increment-1');
    expect(requireObjectBlock(stage, 'increment-1').parent).not.toBe('extension-hat');
    validateProject(project);
  });

  it('splices a four-command C-block branch through a dispatcher and preserves its result', async () => {
    const project = nestedBranchProject();
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x6d), 'nested-vnext'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      }
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    if (!virtualizationSnapshot) throw new Error('nested dispatcher snapshot is unavailable');
    const stage = virtualizationSnapshot.targets[0];
    const control = stage?.blocks['branch'];
    expect(control && isScratchBlock(control) ? control.opcode : undefined).toBe('control_if');
    const branchEntries = control && isScratchBlock(control)
      ? [control.inputs['SUBSTACK']?.[1]]
      : [];
    expect(branchEntries.some(value => typeof value === 'string' && !value.startsWith('increment-'))).toBe(true);

    const originalIds = new Set(['increment-1', 'increment-2', 'increment-3', 'increment-4']);
    for (const id of originalIds) {
      const value = stage?.blocks[id];
      expect(value && isScratchBlock(value) && value.next ? originalIds.has(value.next) : false).toBe(false);
      expect(value && isScratchBlock(value) ? value.parent : undefined).not.toBe('branch');
    }
    validateProject(virtualizationSnapshot);

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(virtualizationSnapshot));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      expect(vm.runtime.targets.find(target => target.isStage)?.variables['counter']?.value).toBe(4);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('virtualizes an argument-free non-warp procedure body without changing its result', async () => {
    const project = procedureBodyProject();
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x7a), 'procedure-vnext'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      }
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    if (!virtualizationSnapshot) throw new Error('procedure dispatcher snapshot is unavailable');
    const stage = virtualizationSnapshot.targets[0];
    const originalIds = new Set(['increment-1', 'increment-2', 'increment-3', 'increment-4']);
    for (const id of originalIds) {
      const value = stage?.blocks[id];
      expect(value && isScratchBlock(value) && value.next ? originalIds.has(value.next) : false).toBe(false);
    }
    validateProject(virtualizationSnapshot);

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(virtualizationSnapshot));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      expect(vm.runtime.targets.find(target => target.isStage)?.variables['counter']?.value).toBe(4);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('rejects a procedure body owned by a reentrant hat', () => {
    const project = procedureBodyProject();
    const stage = requireTarget(project, 0);
    stage.blocks['flag'] = block(
      'event_whenkeypressed',
      'call',
      null,
      true,
      {},
      {KEY_OPTION: ['space', null]}
    );
    const resultStats = stats(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x43), 'reentrant-procedure-owner-vnext'),
      resultStats
    );

    expect(resultStats.virtualizedBlocks).toBe(0);
    expect(requireObjectBlock(stage, 'increment-1').next).toBe('increment-2');
    validateProject(project);
  });

  it('rejects a Stage write observed through sensing-of from another target', () => {
    const project = witnessFamilyProject();
    const sprite = requireTarget(project, 1);
    sprite.blocks = {
      observer: block('event_whenflagclicked', 'say', null, true),
      say: block(
        'looks_say',
        null,
        'observer',
        false,
        {MESSAGE: [2, 'score-reader']}
      ),
      'score-reader': block(
        'sensing_of',
        null,
        'say',
        false,
        {OBJECT: [1, [10, '_stage_']]},
        {PROPERTY: ['visible counter', null]}
      )
    };
    const resultStats = stats(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x44), 'stage-sensing-owner-vnext'),
      resultStats
    );

    expect(resultStats.virtualizedBlocks).toBe(0);
    validateProject(project);
  });

  it('keeps real monitors blocking while explicit reservation keys only skip scalar packing', () => {
    const realMonitorProject = witnessFamilyProject();
    const realMonitor = hiddenVariableMonitor();
    realMonitorProject.monitors = [realMonitor];
    const realMonitorStats = stats(realMonitorProject);
    applyAggressiveTransforms(
      realMonitorProject,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x45), 'real-monitor-vnext'),
      realMonitorStats
    );
    expect(realMonitorStats.virtualizedBlocks).toBe(0);

    const reservationProject = witnessFamilyProject();
    const reservationStats = stats(reservationProject);
    applyAggressiveTransforms(
      reservationProject,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x45), 'reservation-monitor-vnext'),
      reservationStats,
      undefined,
      false,
      new Set(['0\u0000counter'])
    );
    expect(reservationStats.virtualizedBlocks).toBe(4);
    validateProject(reservationProject);
  });

  it('treats a named-sprite monitor without a local declaration as a Stage monitor', () => {
    const project = witnessFamilyProject();
    const sprite = requireTarget(project, 1);
    const monitor = hiddenVariableMonitor();
    monitor['spriteName'] = sprite.name;
    project.monitors = [monitor];
    const resultStats = stats(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x46), 'stage-fallback-monitor-vnext'),
      resultStats
    );

    expect(resultStats.virtualizedBlocks).toBe(0);
    validateProject(project);
  });

  it('executes three budgeted dispatcher sites in source order', async () => {
    const project = longIncrementProject(26);
    const beforeEquivalents = countBlockEquivalents(project);
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x58), 'multi-site-vnext'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(24);
    if (!virtualizationSnapshot) throw new Error('multi-site dispatcher snapshot is unavailable');
    expect(countBlockEquivalents(virtualizationSnapshot) - beforeEquivalents).toBe(948);
    validateProject(virtualizationSnapshot);
    expect(await runCounter(virtualizationSnapshot)).toBe(26);
  }, 30_000);

  it('builds a compact result-bound dispatcher and resets stale generated state', async () => {
    const project = witnessFamilyProject();
    const beforeEquivalents = countBlockEquivalents(project);
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x45), 'witness-family-vnext'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      }
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    if (!virtualizationSnapshot) throw new Error('virtualization snapshot was not emitted');
    const growth = countBlockEquivalents(virtualizationSnapshot) - beforeEquivalents;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThanOrEqual(256);
    const virtualizedStage = requireTarget(virtualizationSnapshot, 0);
    const latchedRouteIds = new Set<string>();
    ['set-1', 'set-2', 'set-3', 'set-4'].forEach(blockId => {
      const original = requireObjectBlock(virtualizedStage, blockId);
      const suffix = collectLinearSuffix(virtualizedStage, original.next);
      expect(suffix.map(([, block]) => block.opcode)).toEqual([
        'data_setvariableto',
        'data_setvariableto'
      ]);
      const witnessTree = collectInputTree(virtualizedStage, suffix[0]?.[0] ?? '');
      expect(witnessTree.filter(([, block]) => block.opcode === 'sensing_timer')).toHaveLength(0);
      expect(witnessTree.filter(([, block]) => block.opcode === 'operator_length')).toHaveLength(1);
      expect(witnessTree.some(([, block]) => (
        block.opcode === 'operator_mod'
        && [251, 257, 263, 269].includes(primitiveNumber(block.inputs['NUM2']) ?? -1)
      ))).toBe(true);
      const armedSetter = suffix[1]?.[1];
      const routeValue = armedSetter?.inputs['VALUE']?.[1];
      expect(isPrimitive(routeValue) && routeValue[0] === 12 && typeof routeValue[2] === 'string').toBe(true);
      if (isPrimitive(routeValue) && routeValue[0] === 12 && typeof routeValue[2] === 'string') {
        latchedRouteIds.add(routeValue[2]);
        expect(routeValue[2]).not.toBe(armedSetter?.fields['VARIABLE']?.[1]);
      }
      expect(armedSetter?.next).toBeNull();
    });
    expect(latchedRouteIds.size).toBe(1);
    const boundedStoreIds = new Set(Object.keys(virtualizedStage.lists));
    expect(boundedStoreIds.size).toBe(2);
    expect(Object.values(virtualizedStage.lists).filter(declaration => (
      Array.isArray(declaration[1]) && declaration[1].length === 10
    ))).toHaveLength(2);
    expect(Object.values(virtualizedStage.lists).some(declaration => (
      Array.isArray(declaration[1]) && declaration[1].length !== 10
    ))).toBe(false);
    const generatedListCells = Object.values(virtualizedStage.lists).reduce((total, declaration) => (
      total + (Array.isArray(declaration[1]) ? declaration[1].length : 0)
    ), 0);
    expect(generatedListCells).toBe(20);
    expect(generatedListCells).toBeLessThan(2_057);

    const callsByCode = new Map<string, ScratchBlock[]>();
    for (const value of Object.values(virtualizedStage.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
      const code = value.mutation?.['proccode'];
      if (typeof code !== 'string') continue;
      const calls = callsByCode.get(code) ?? [];
      calls.push(value);
      callsByCode.set(code, calls);
    }
    const dispatcherCalls = [...callsByCode.values()].find(calls => calls.length === 5);
    expect(dispatcherCalls).toHaveLength(5);
    if (!dispatcherCalls) throw new Error('dispatcher calls are unavailable');
    const terminalCall = dispatcherCalls.find(call => {
      const parent = call.parent === null ? undefined : virtualizedStage.blocks[call.parent];
      return isScratchBlock(parent)
        && parent.opcode === 'data_changevariableby'
        && primitiveNumber(parent.inputs['VALUE']) === 2;
    });
    if (!isScratchBlock(terminalCall)) throw new Error('dispatcher terminal call is unavailable');
    const driverCalls = dispatcherCalls.filter(call => call !== terminalCall);
    expect(driverCalls).toHaveLength(4);
    const driverIds = new Set(driverCalls.map(call => Object.entries(virtualizedStage.blocks).find(([, value]) => value === call)?.[0]));
    const firstDriver = driverCalls.find(call => call.parent === null || !driverIds.has(call.parent));
    if (!isScratchBlock(firstDriver)) throw new Error('dispatcher driver call is unavailable');
    const driverCode = firstDriver.mutation?.['proccode'];
    if (typeof driverCode !== 'string') throw new Error('dispatcher procedure code is unavailable');
    expect(dispatcherCalls.every(call => call.mutation?.['warp'] === 'true')).toBe(true);
    let current: ScratchBlock | undefined = firstDriver;
    const orderedDriverCalls: ScratchBlock[] = [];
    while (current && orderedDriverCalls.length < 5) {
      orderedDriverCalls.push(current);
      const nextValue: unknown = current.next === null ? undefined : virtualizedStage.blocks[current.next];
      current = isScratchBlock(nextValue) && nextValue.opcode === 'procedures_call' ? nextValue : undefined;
    }
    expect(orderedDriverCalls).toHaveLength(4);
    expect(new Set(orderedDriverCalls)).toEqual(new Set(driverCalls));
    expect(terminalCall.mutation?.['proccode']).toBe(driverCode);
    const terminalPhase = terminalCall.parent !== null
      ? virtualizedStage.blocks[terminalCall.parent]
      : undefined;
    expect(terminalPhase && isScratchBlock(terminalPhase) ? primitiveNumber(terminalPhase.inputs['VALUE']) : undefined).toBe(2);
    const dispatcherPrototype = Object.values(virtualizedStage.blocks).find(value => (
      isScratchBlock(value)
      && value.opcode === 'procedures_prototype'
      && value.mutation?.['proccode'] === driverCode
    ));
    expect(dispatcherPrototype && isScratchBlock(dispatcherPrototype)
      ? dispatcherPrototype.mutation?.['warp']
      : undefined).toBe('true');
    validateProject(virtualizationSnapshot);

    expect(await runCounter(virtualizationSnapshot)).toBe('terminal');
    const restartProject = structuredClone(virtualizationSnapshot);
    const restartStage = requireTarget(restartProject, 0);
    for (const [variableId, declaration] of Object.entries(restartStage.variables)) {
      if (variableId !== 'counter') declaration[1] = 'stale-restart-state';
    }
    validateProject(restartProject);

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(restartProject));
      vm.start();
      const runtimeStage = vm.runtime.targets.find(target => target.isStage);
      if (!runtimeStage) throw new Error('runtime Stage is unavailable');
      const initialStoreLengths = runtimeListLengths(runtimeStage, boundedStoreIds);
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      expect(vm.runtime.targets.find(target => target.isStage)?.variables['counter']?.value).toBe('terminal');
      expect(runtimeListLengths(runtimeStage, boundedStoreIds)).toEqual(initialStoreLengths);
      expect(new Set(Object.values(initialStoreLengths))).toEqual(new Set([10]));
      const runtimeCounter = vm.runtime.targets.find(target => target.isStage)?.variables['counter'];
      if (!runtimeCounter) throw new Error('runtime counter is unavailable');
      runtimeCounter.value = 'restart-sentinel';
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      expect(runtimeCounter.value).toBe('terminal');
      expect(runtimeListLengths(runtimeStage, boundedStoreIds)).toEqual(initialStoreLengths);
    } finally {
      vm.quit();
    }
  }, 30_000);
});

function nestedBranchProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  const sprite = project.targets[1];
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {counter: ['visible counter', 0]};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    flag: block('event_whenflagclicked', 'branch', null, true),
    branch: block(
      'control_if',
      null,
      'flag',
      false,
      {CONDITION: [2, 'condition'], SUBSTACK: [2, 'increment-1']}
    ),
    condition: block(
      'operator_equals',
      null,
      'branch',
      false,
      {OPERAND1: [1, [4, '1']], OPERAND2: [1, [4, '1']]}
    ),
    'increment-1': increment('increment-2', 'branch'),
    'increment-2': increment('increment-3', 'increment-1'),
    'increment-3': increment('increment-4', 'increment-2'),
    'increment-4': increment(null, 'increment-3')
  };
  sprite.variables = {};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.blocks = {};
  sprite.comments = {};
  project.monitors = [];
  project.extensions = [];
  return project;
}

function extensionHatProject(): ScratchProject {
  const project = nestedBranchProject();
  const stage = requireTarget(project, 0);
  stage.blocks = {
    'extension-hat': block(
      'microbit_whenButtonPressed',
      'increment-1',
      null,
      true,
      {},
      {BTN: ['A', null]}
    ),
    'increment-1': increment(null, 'extension-hat')
  };
  project.extensions = ['microbit'];
  return project;
}

function procedureBodyProject(): ScratchProject {
  const project = nestedBranchProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is unavailable');
  stage.blocks = {
    flag: block('event_whenflagclicked', 'call', null, true),
    call: {
      ...block('procedures_call', null, 'flag', false),
      mutation: {proccode: 'work', argumentids: '[]', warp: 'false'}
    },
    definition: block('procedures_definition', 'increment-1', null, true, {custom_block: [1, 'proc-prototype']}),
    'proc-prototype': {
      ...block('procedures_prototype', null, 'definition', false),
      shadow: true,
      mutation: {
        proccode: 'work',
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        warp: 'false'
      }
    },
    'increment-1': increment('increment-2', 'definition'),
    'increment-2': increment('increment-3', 'increment-1'),
    'increment-3': increment('increment-4', 'increment-2'),
    'increment-4': increment(null, 'increment-3')
  };
  return project;
}

function witnessFamilyProject(): ScratchProject {
  const project = nestedBranchProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is unavailable');
  stage.blocks = {
    flag: block('event_whenflagclicked', 'set-1', null, true),
    'set-1': setValue('set-2', 'flag', '0123456789'),
    'set-2': setValue('set-3', 'set-1', 'letters'),
    'set-3': setValue('set-4', 'set-2', '0123456789'),
    'set-4': setValue(null, 'set-3', 'terminal')
  };
  return project;
}

function longIncrementProject(length: number): ScratchProject {
  const project = nestedBranchProject();
  const stage = requireTarget(project, 0);
  stage.blocks = {
    flag: block('event_whenflagclicked', length === 0 ? null : 'increment-0', null, true)
  };
  for (let index = 0; index < length; index += 1) {
    stage.blocks[`increment-${index}`] = increment(
      index + 1 < length ? `increment-${index + 1}` : null,
      index === 0 ? 'flag' : `increment-${index - 1}`
    );
  }
  return project;
}

function setValue(next: string | null, parent: string, value: string): ScratchBlock {
  return block(
    'data_setvariableto',
    next,
    parent,
    false,
    {VALUE: [1, [10, value]]},
    {VARIABLE: ['visible counter', 'counter']}
  );
}

function increment(next: string | null, parent: string): ScratchBlock {
  return block(
    'data_changevariableby',
    next,
    parent,
    false,
    {VALUE: [1, [4, '1']]},
    {VARIABLE: ['visible counter', 'counter']}
  );
}

function hiddenVariableMonitor(): Record<string, JsonValue> {
  return {
    id: 'counter',
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: 'visible counter'},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
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
    ...(topLevel ? {x: 10, y: 10} : {})
  };
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`fixture target ${index} is unavailable`);
  return target;
}

function requireObjectBlock(target: ScratchTarget, id: string): ScratchBlock {
  const blockValue = target.blocks[id];
  if (!isScratchBlock(blockValue)) throw new Error(`fixture block ${id} is unavailable`);
  return blockValue;
}

function collectLinearSuffix(
  target: ScratchTarget,
  firstId: string | null
): Array<readonly [string, ScratchBlock]> {
  const suffix: Array<readonly [string, ScratchBlock]> = [];
  const visited = new Set<string>();
  let currentId = firstId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const current = requireObjectBlock(target, currentId);
    suffix.push([currentId, current]);
    currentId = current.next;
  }
  return suffix;
}

function collectInputTree(
  target: ScratchTarget,
  rootId: string
): Array<readonly [string, ScratchBlock]> {
  const collected: Array<readonly [string, ScratchBlock]> = [];
  const pending = [rootId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const value = target.blocks[id];
    if (!isScratchBlock(value)) continue;
    collected.push([id, value]);
    for (const input of Object.values(value.inputs)) {
      for (let index = 1; index < input.length; index += 1) {
        const reference = input[index];
        if (typeof reference === 'string') pending.push(reference);
      }
    }
  }
  return collected;
}

function primitiveNumber(input: ScratchInput | undefined): number {
  const primitive = input?.[1];
  if (!Array.isArray(primitive)) return Number.NaN;
  return Number(primitive[1]);
}

function runtimeListLengths(
  target: RuntimeTarget,
  ids: ReadonlySet<string>
): Record<string, number> {
  return Object.fromEntries([...ids].sort().map(id => {
    const value = target.variables[id]?.value;
    if (!Array.isArray(value)) throw new Error(`runtime list ${id} is unavailable`);
    return [id, value.length];
  }));
}

async function runCounter(project: ScratchProject): Promise<unknown> {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  try {
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    return vm.runtime.targets.find(target => target.isStage)?.variables['counter']?.value;
  } finally {
    vm.quit();
  }
}

function stats(project: ScratchProject): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode: 'no-preserve',
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
