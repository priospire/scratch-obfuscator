import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {aggressiveBlockEquivalentCap} from '../src/growth-policy.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../src/types.js';
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
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    sequencer: {
      timer: {
        nowObj: {now(): number};
      };
    };
    _step(): void;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object'
  || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('official Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('aggressive v7 public-path coverage', () => {
  it('independently clones nested arithmetic reporter graphs into all expanded aliases', async () => {
    const source = nestedReporterProject();
    const expected = await runValue(source, 'result');
    const transformed = structuredClone(source);
    const resultStats = stats(transformed);
    let virtualizationSnapshot: ScratchProject | undefined;

    applyAggressiveTransforms(
      transformed,
      'no-preserve',
      generator(0x81, 'nested-expanded-aliases'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(transformed);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    if (!virtualizationSnapshot) throw new Error('nested reporter virtualization snapshot is unavailable');
    const stage = requireStage(virtualizationSnapshot);
    for (let index = 0; index < 4; index += 1) {
      expect(stage.blocks[`command-${index}`]).toBeUndefined();
      expect(stage.blocks[`add-${index}`]).toBeUndefined();
      expect(stage.blocks[`multiply-${index}`]).toBeUndefined();
      expect(stage.blocks[`fallback-${index}`]).toBeUndefined();
    }
    expect(requireBlock(stage, 'hat').next).not.toBe('command-0');

    const aliases = Object.entries(stage.blocks).flatMap(([id, value]) => (
      isScratchBlock(value)
      && value.opcode === 'data_setvariableto'
      && value.fields['VARIABLE']?.[1] === 'result'
        ? [{id, block: value}]
        : []
    ));
    expect(aliases).toHaveLength(16);
    const reporterIds = new Set<string>();
    const fallbackIds = new Set<string>();
    const values: number[] = [];
    for (const alias of aliases) {
      const addId = referencedBlockId(alias.block.inputs['VALUE']);
      const add = requireBlock(stage, addId);
      expect(add.opcode).toBe('operator_add');
      expect(add.parent).toBe(alias.id);
      const multiplyId = referencedBlockId(add.inputs['NUM2']);
      const multiply = requireBlock(stage, multiplyId);
      expect(multiply.opcode).toBe('operator_multiply');
      expect(multiply.parent).toBe(addId);
      const fallbackId = add.inputs['NUM2']?.[2];
      expect(typeof fallbackId).toBe('string');
      if (typeof fallbackId !== 'string') throw new Error('cloned inactive fallback is unavailable');
      expect(isPrimitive(stage.blocks[fallbackId])).toBe(true);
      reporterIds.add(addId);
      reporterIds.add(multiplyId);
      fallbackIds.add(fallbackId);
      values.push(evaluateArithmetic(stage, addId));
    }
    expect(reporterIds).toHaveLength(32);
    expect(fallbackIds).toHaveLength(16);
    expect(values.sort((left, right) => left - right)).toEqual(
      [6, 13, 22, 33].flatMap(value => Array.from({length: 4}, () => value))
    );
    validateProject(virtualizationSnapshot);
    expect(await runValue(virtualizationSnapshot, 'result')).toBe(expected);
    expect(expected).toBe(33);
  }, 30_000);

  it('dispatches four private fixed-list replacements while retaining the original list', async () => {
    const source = privateListProject();
    const expected = await runValue(source, 'private-list');
    const transformed = structuredClone(source);
    const resultStats = stats(transformed);
    let virtualizationSnapshot: ScratchProject | undefined;

    applyAggressiveTransforms(
      transformed,
      'no-preserve',
      generator(0x82, 'private-list-expanded-aliases'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(transformed);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
    if (!virtualizationSnapshot) throw new Error('private-list virtualization snapshot is unavailable');
    const stage = requireStage(virtualizationSnapshot);
    expect(stage.lists['private-list']).toEqual(['private list', [0, 0, 0, 0]]);
    expect(requireStage(transformed).lists['private-list']).toBeDefined();
    for (let index = 0; index < 4; index += 1) {
      expect(stage.blocks[`replace-${index}`]).toBeUndefined();
    }

    const aliases = Object.values(stage.blocks).filter((value): value is ScratchBlock => (
      isScratchBlock(value)
      && value.opcode === 'data_replaceitemoflist'
      && value.fields['LIST']?.[1] === 'private-list'
    ));
    expect(aliases).toHaveLength(16);
    const writes = aliases.map(alias => ({
      index: Number(primitiveValue(alias.inputs['INDEX'])),
      item: Number(primitiveValue(alias.inputs['ITEM']))
    }));
    expect(writes.sort((left, right) => left.index - right.index || left.item - right.item)).toEqual(
      [11, 22, 33, 44].flatMap((item, index) => (
        Array.from({length: 4}, () => ({index: index + 1, item}))
      ))
    );
    validateProject(virtualizationSnapshot);
    expect(await runValue(virtualizationSnapshot, 'private-list')).toEqual(expected);
    expect(expected).toEqual(['11', '22', '33', '44']);
  }, 30_000);

  it('binds direction and costume writes to their distinct live property witnesses', () => {
    const cases: readonly {
      readonly opcode: string;
      readonly stage: boolean;
      readonly inputs: ScratchBlock['inputs'];
    }[] = [
      {opcode: 'motion_turnright', stage: false, inputs: {DEGREES: [1, [4, '15']]}},
      {opcode: 'looks_nextcostume', stage: false, inputs: {}}
    ];
    for (const [caseIndex, fixture] of cases.entries()) {
      const transformed = propertyWitnessProject(fixture.opcode, fixture.stage, fixture.inputs);
      const resultStats = stats(transformed);
      let virtualizationSnapshot: ScratchProject | undefined;
      applyAggressiveTransforms(
        transformed,
        'no-preserve',
        generator(0x83 + caseIndex, `property-witness-${fixture.opcode}`),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(transformed);
        },
        true
      );

      expect(resultStats.virtualizedBlocks, fixture.opcode).toBe(4);
      if (!virtualizationSnapshot) throw new Error('property witness virtualization snapshot is unavailable');
      const target = fixture.stage ? requireStage(virtualizationSnapshot) : requireSprite(virtualizationSnapshot);
      expect(Object.values(target.blocks).filter(value => isScratchBlock(value) && value.opcode === fixture.opcode))
        .toHaveLength(16);
      validateProject(virtualizationSnapshot);
    }
  });

  it('keeps Stage writes native when another target directly reads the same global symbol', () => {
    const project = stageVariableProject();
    const sprite = requireSprite(project);
    sprite.blocks = {
      observer: block('looks_say', null, null, true, {MESSAGE: [2, 'global-reader']}),
      'global-reader': block(
        'data_variable',
        null,
        'observer',
        false,
        {},
        {VARIABLE: ['shared', 'shared']}
      )
    };
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;

    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x84, 'cross-target-global-read'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(0);
    if (!virtualizationSnapshot) throw new Error('cross-target fallback snapshot is unavailable');
    const stage = requireStage(virtualizationSnapshot);
    for (let index = 0; index < 4; index += 1) {
      expect(requireBlock(stage, `change-${index}`).opcode).toBe('data_changevariableby');
    }
  });

  it('does not treat a same-id target-local declaration as a read of the Stage symbol', () => {
    const project = stageVariableProject();
    const sprite = requireSprite(project);
    sprite.variables = {shared: ['local shared', 99]};
    sprite.blocks = {
      observer: block('looks_say', null, null, true, {MESSAGE: [2, 'local-reader']}),
      'local-reader': block(
        'data_variable',
        null,
        'observer',
        false,
        {},
        {VARIABLE: ['local shared', 'shared']}
      )
    };
    const resultStats = stats(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x88, 'cross-target-local-shadow'),
      resultStats,
      undefined,
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(4);
  });

  it('resolves Stage monitor fallbacks and primitive block-map references before dispatching writes', () => {
    const monitored = stageVariableProject();
    monitored.monitors = [
      {id: 'other', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'other'}, spriteName: null},
      {id: 'shared', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'shared'}, spriteName: 'missing'}
    ];
    const monitoredStats = stats(monitored);
    applyAggressiveTransforms(
      monitored,
      'no-preserve',
      generator(0x85, 'missing-monitor-target'),
      monitoredStats,
      undefined,
      true
    );
    expect(monitoredStats.virtualizedBlocks).toBe(0);

    const primitiveReference = stageVariableProject();
    requireSprite(primitiveReference).blocks = {
      'primitive-reader': [12, 'shared', 'shared']
    };
    const primitiveStats = stats(primitiveReference);
    applyAggressiveTransforms(
      primitiveReference,
      'no-preserve',
      generator(0x86, 'primitive-global-read'),
      primitiveStats,
      undefined,
      true
    );
    expect(primitiveStats.virtualizedBlocks).toBe(0);
  });

  it('ignores malformed fixed-list declarations and unresolved legacy list fields', () => {
    const project = emptyStageProject();
    const stage = requireStage(project);
    stage.lists = {
      'invalid-values': ['invalid values', 'not an array'],
      valid: ['valid', ['value']]
    };
    stage.blocks = {
      unresolved: block(
        'data_itemoflist',
        null,
        null,
        true,
        {INDEX: [1, [4, '1']]},
        {LIST: [7, null]}
      )
    };
    const resultStats = stats(project);

    applyAggressiveTransforms(project, 'no-preserve', generator(0x87, 'malformed-fixed-list'), resultStats);

    expect(stage.lists['invalid-values']).toBeDefined();
    expect(stage.lists['valid']).toBeDefined();
    expect(resultStats.listsVirtualized ?? 0).toBe(0);
  });

  it('rejects later expanded cohorts when their aggregate growth would exceed the allow-size cap', () => {
    const project = budgetConstrainedProject(80);
    const before = countBlockEquivalents(project);
    const cap = aggressiveBlockEquivalentCap(before, 'no-preserve', true);
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;

    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x89, 'expanded-total-budget'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBeGreaterThan(0);
    expect(resultStats.virtualizedBlocks).toBeLessThan(72);
    expect(countBlockEquivalents(project)).toBeLessThanOrEqual(cap);
    if (!virtualizationSnapshot) throw new Error('budget-limited virtualization snapshot is unavailable');
    validateProject(virtualizationSnapshot);
  }, 30_000);
});

function nestedReporterProject(): ScratchProject {
  const project = emptyStageProject();
  const stage = requireStage(project);
  stage.variables = {result: ['result', 0]};
  stage.blocks = {hat: block('event_whenflagclicked', 'command-0', null, true)};
  for (let index = 0; index < 4; index += 1) {
    stage.blocks[`command-${index}`] = block(
      'data_setvariableto',
      index === 3 ? null : `command-${index + 1}`,
      index === 0 ? 'hat' : `command-${index - 1}`,
      false,
      {VALUE: [2, `add-${index}`]},
      {VARIABLE: ['result', 'result']}
    );
    stage.blocks[`add-${index}`] = block(
      'operator_add',
      null,
      `command-${index}`,
      false,
      {NUM1: [1, [4, String(index + 2)]], NUM2: [3, `multiply-${index}`, `fallback-${index}`]}
    );
    stage.blocks[`multiply-${index}`] = block(
      'operator_multiply',
      null,
      `add-${index}`,
      false,
      {NUM1: [1, [4, String(index + 1)]], NUM2: [1, [4, String(index + 4)]]}
    );
    stage.blocks[`fallback-${index}`] = [12, 'result', 'result'];
  }
  return project;
}

function privateListProject(): ScratchProject {
  const project = emptyStageProject();
  const stage = requireStage(project);
  stage.lists = {'private-list': ['private list', [0, 0, 0, 0]]};
  stage.blocks = {hat: block('event_whenflagclicked', 'replace-0', null, true)};
  for (let index = 0; index < 4; index += 1) {
    stage.blocks[`replace-${index}`] = block(
      'data_replaceitemoflist',
      index === 3 ? null : `replace-${index + 1}`,
      index === 0 ? 'hat' : `replace-${index - 1}`,
      false,
      {INDEX: [1, [4, String(index + 1)]], ITEM: [1, [4, String((index + 1) * 11)]]},
      {LIST: ['private list', 'private-list']}
    );
  }
  return project;
}

function propertyWitnessProject(
  opcode: string,
  useStage: boolean,
  inputs: ScratchBlock['inputs']
): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  for (const target of [stage, sprite]) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  const target = useStage ? stage : sprite;
  target.blocks = {hat: block('event_whenflagclicked', 'command-0', null, true)};
  for (let index = 0; index < 4; index += 1) {
    target.blocks[`command-${index}`] = block(
      opcode,
      index === 3 ? null : `command-${index + 1}`,
      index === 0 ? 'hat' : `command-${index - 1}`,
      false,
      structuredClone(inputs)
    );
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function stageVariableProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  for (const target of [stage, sprite]) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  stage.variables = {shared: ['shared', 0]};
  stage.blocks = {hat: block('event_whenflagclicked', 'change-0', null, true)};
  for (let index = 0; index < 4; index += 1) {
    stage.blocks[`change-${index}`] = block(
      'data_changevariableby',
      index === 3 ? null : `change-${index + 1}`,
      index === 0 ? 'hat' : `change-${index - 1}`,
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['shared', 'shared']}
    );
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function budgetConstrainedProject(length: number): ScratchProject {
  const project = emptyStageProject();
  const stage = requireStage(project);
  stage.variables = {counter: ['counter', 0]};
  stage.blocks = {hat: block('event_whenflagclicked', 'change-0', null, true)};
  for (let index = 0; index < length; index += 1) {
    stage.blocks[`change-${index}`] = block(
      'data_changevariableby',
      index + 1 < length ? `change-${index + 1}` : null,
      index === 0 ? 'hat' : `change-${index - 1}`,
      false,
      {},
      {VARIABLE: ['counter', 'counter']}
    );
  }
  return project;
}

function emptyStageProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  project.targets = [stage];
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  project.monitors = [];
  project.extensions = [];
  return project;
}

function evaluateArithmetic(target: ScratchTarget, blockId: string): number {
  const value = requireBlock(target, blockId);
  if (value.opcode === 'operator_add') {
    return evaluateNumericInput(target, value.inputs['NUM1']) + evaluateNumericInput(target, value.inputs['NUM2']);
  }
  if (value.opcode === 'operator_multiply') {
    return evaluateNumericInput(target, value.inputs['NUM1']) * evaluateNumericInput(target, value.inputs['NUM2']);
  }
  throw new Error(`unsupported arithmetic reporter ${value.opcode}`);
}

function evaluateNumericInput(target: ScratchTarget, input: ScratchInput | undefined): number {
  const value = input?.[1];
  if (typeof value === 'string') return evaluateArithmetic(target, value);
  if (isPrimitive(value)) return Number(value[1]);
  throw new Error('numeric reporter input is unavailable');
}

function referencedBlockId(input: ScratchInput | undefined): string {
  const value = input?.[1];
  if (typeof value !== 'string') throw new Error('referenced reporter block is unavailable');
  return value;
}

function primitiveValue(input: ScratchInput | undefined): unknown {
  const value = input?.[1];
  return isPrimitive(value) ? value[1] : undefined;
}

async function runValue(project: ScratchProject, id: string): Promise<unknown> {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  await vm.loadProject(createFixtureArchive(project));
  vm.start();
  const budgetTimer = vm.runtime.sequencer.timer;
  const originalNow = budgetTimer.nowObj;
  budgetTimer.nowObj = {now: () => 0};
  try {
    vm.greenFlag();
    for (let step = 0; step < 1_000 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    const stage = vm.runtime.targets.find(target => target.isStage);
    if (!stage) throw new Error('runtime Stage is unavailable');
    return structuredClone(stage.variables[id]?.value);
  } finally {
    budgetTimer.nowObj = originalNow;
    vm.quit();
  }
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

function generator(byte: number, domain: string): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(byte), domain);
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

function requireStage(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function requireSprite(project: ScratchProject): ScratchTarget {
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture Sprite is unavailable');
  return sprite;
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!isScratchBlock(value)) throw new Error(`fixture block ${id} is unavailable`);
  return value;
}
