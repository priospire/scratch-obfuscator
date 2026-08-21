import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {optimizeProject} from '../src/obfuscation/optimizer.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject} from '../src/types.js';
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

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null ||
    typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('optimizer against the official Scratch runtime', () => {
  it('preserves exact observable values through load, execute, save, and reload', async () => {
    const source = runtimeProject();
    const optimized = optimizeProject(source);

    const sourceValues = await execute(source);
    const optimizedValues = await execute(optimized.project, true);

    expect(optimizedValues).toEqual(sourceValues);
    expect(optimizedValues.slice(0, 5)).toEqual([72, 'NaN:true', 9, 0.5, true]);
    expect(Object.is(optimizedValues[5], -0)).toBe(true);
    expect(optimizedValues[6]).toBe(1);
    expect(optimized.stats.reporterTreesFolded).toBe(4);
    expect(optimized.stats.reporterBlocksRemoved).toBe(8);
    const remaining = Object.values(optimized.project.targets[0]?.blocks ?? {})
      .filter(isScratchBlock)
      .map(block => block.opcode);
    expect(remaining).toContain('operator_contains');
    expect(remaining).toContain('operator_multiply');
    expect(remaining).toContain('operator_mathop');
    expect(remaining).not.toContain('operator_random');
  }, 60_000);
});

async function execute(project: ScratchProject, roundTrip = false): Promise<unknown[]> {
  const vm = createVm();
  let reloaded: ScratchVmInstance | undefined;
  try {
    await vm.loadProject(createFixtureArchive(project));
    if (roundTrip) {
      const saved = await vm.saveProjectSb3();
      reloaded = createVm();
      await reloaded.loadProject(await blobBytes(saved));
    }
    const active = reloaded ?? vm;
    active.start();
    active.greenFlag();
    for (let step = 0; step < 300 && active.runtime.threads.length > 0; step += 1) active.runtime._step();
    expect(active.runtime.threads).toHaveLength(0);
    const stage = active.runtime.targets.find(target => target.isStage);
    const value = stage?.variables['results']?.value;
    if (!Array.isArray(value)) throw new Error('runtime results list is unavailable');
    const values: unknown[] = [];
    for (const item of value as unknown[]) values.push(item);
    return values;
  } finally {
    reloaded?.quit();
    vm.quit();
  }
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

function runtimeProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  project.targets = [stage];
  project.monitors = [];
  project.extensions = [];
  stage.variables = {};
  stage.lists = {results: ['results', []]};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: command('event_whenflagclicked', 'append-number', null),
    'append-number': append('append-string', 'hat', 'multiply'),
    multiply: reporter('operator_multiply', 'append-number', {NUM1: [2, 'add'], NUM2: literal(8)}),
    add: reporter('operator_add', 'multiply', {NUM1: literal(5), NUM2: literal(4)}),

    'append-string': append('append-mod', 'append-number', 'join-outer'),
    'join-outer': reporter('operator_join', 'append-string', {STRING1: [2, 'nan'], STRING2: [2, 'join-inner']}),
    nan: reporter('operator_divide', 'join-outer', {NUM1: literal(0), NUM2: literal(0)}),
    'join-inner': reporter('operator_join', 'join-outer', {STRING1: literal(':'), STRING2: [2, 'equals']}),
    equals: reporter('operator_equals', 'join-inner', {OPERAND1: literal('Alpha'), OPERAND2: literal('aLPHA')}),

    'append-mod': append('append-sin', 'append-string', 'mod'),
    mod: reporter('operator_mod', 'append-mod', {NUM1: literal(-1), NUM2: literal(10)}),

    'append-sin': append('append-boolean', 'append-mod', 'sin'),
    sin: reporter('operator_mathop', 'append-sin', {NUM: literal(30)}, {OPERATOR: ['sin']}),

    'append-boolean': append('append-negative-zero', 'append-sin', 'contains'),
    contains: reporter('operator_contains', 'append-boolean', {STRING1: literal('Alpha'), STRING2: literal('PH')}),

    'append-negative-zero': append('append-coercion', 'append-boolean', 'negative-zero'),
    'negative-zero': reporter('operator_multiply', 'append-negative-zero', {NUM1: literal(0), NUM2: literal(-1)}),

    'append-coercion': append(null, 'append-negative-zero', 'coercion'),
    coercion: reporter('operator_add', 'append-coercion', {NUM1: literal('   '), NUM2: literal(1)})
  };
  const hat = stage.blocks['hat'];
  if (!hat || !isScratchBlock(hat)) throw new Error('fixture hat is unavailable');
  hat.topLevel = true;
  hat.x = 0;
  hat.y = 0;
  return project;
}

function append(next: string | null, parent: string, reporterId: string): ScratchBlock {
  return command('data_addtolist', next, parent, {
    ITEM: [3, reporterId, [10, 'hidden default']]
  }, {LIST: ['results', 'results']});
}

function command(
  opcode: string,
  next: string | null,
  parent: string | null,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, JsonValue[]> = {}
): ScratchBlock {
  return {opcode, next, parent, inputs, fields, shadow: false, topLevel: false};
}

function reporter(
  opcode: string,
  parent: string,
  inputs: Record<string, ScratchInput>,
  fields: Record<string, JsonValue[]> = {}
): ScratchBlock {
  return command(opcode, null, parent, inputs, fields);
}

function literal(value: string | number): ScratchInput {
  return [1, [typeof value === 'number' ? 4 : 10, value]];
}
