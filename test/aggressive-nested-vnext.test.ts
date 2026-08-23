import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {ObfuscationStats, ScratchBlock, ScratchProject} from '../src/types.js';
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
  it('splices a four-command C-block branch through a dispatcher and preserves its result', async () => {
    const project = nestedBranchProject();
    const resultStats = stats(project);
    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(0x6d), 'nested-vnext'),
      resultStats
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    const stage = project.targets[0];
    const control = stage?.blocks['branch'];
    expect(control && isScratchBlock(control) ? control.opcode : undefined).toBe('control_if_else');
    const branchEntries = control && isScratchBlock(control)
      ? [control.inputs['SUBSTACK']?.[1], control.inputs['SUBSTACK2']?.[1]]
      : [];
    expect(branchEntries.some(value => typeof value === 'string' && !value.startsWith('increment-'))).toBe(true);

    const originalIds = new Set(['increment-1', 'increment-2', 'increment-3', 'increment-4']);
    for (const id of originalIds) {
      const value = stage?.blocks[id];
      expect(value && isScratchBlock(value) && value.next ? originalIds.has(value.next) : false).toBe(false);
      expect(value && isScratchBlock(value) ? value.parent : undefined).not.toBe('branch');
    }
    validateProject(project);

    const vm = new ScratchVm();
    vm.attachStorage(new ScratchStorage());
    try {
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      expect(vm.runtime.targets.find(target => target.isStage)?.variables['counter']?.value).toBe(4);
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
  project.monitors = [{
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
  }];
  project.extensions = [];
  return project;
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
