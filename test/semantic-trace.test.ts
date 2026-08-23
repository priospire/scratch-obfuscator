import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import type {ScratchBlock, ScratchField, ScratchInput, ScratchProject} from '../src/types.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeBlock {
  readonly opcode?: unknown;
}

interface RuntimeBlocks {
  getBlock(id: string): RuntimeBlock | undefined;
}

interface RuntimeTarget {
  readonly isStage: boolean;
  readonly name: string;
  readonly variables: Record<string, {type: string; value: unknown}>;
  readonly blocks: RuntimeBlocks;
}

interface RuntimeThread {
  readonly topBlock: string;
  readonly stack: string[];
  readonly status: number;
  readonly target: RuntimeTarget;
}

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  postIOData(device: string, data: Record<string, unknown>): void;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: RuntimeThread[];
    _lastStepDoneThreads: RuntimeThread[];
    redrawRequested: boolean;
    _step(): void;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

interface ThreadTrace {
  readonly target: string;
  readonly topOpcode: string;
  readonly activeOpcode: string | null;
  readonly status: number;
  readonly depth: number;
}

interface StepTrace {
  readonly step: number;
  readonly randomCalls: number;
  readonly redraw: boolean;
  readonly values: unknown[];
  readonly live: ThreadTrace[];
  readonly done: ThreadTrace[];
}

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('deterministic semantic trace', () => {
  it.each(['lossless', 'lossy'] as const)('%s preserves VM steps, thread order, yields, input sampling, and runtime randomness', async mode => {
    const original = createTraceProject();
    const transformed = obfuscateProject(original, mode, new Uint8Array(32).fill(0x5a)).project;
    const expected = await executeTrace(createFixtureArchive(original));
    const actual = await executeTrace(createFixtureArchive(transformed));
    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(1);
    expect(actual.some(frame => frame.live.length > 0 && frame.done.length > 0)).toBe(true);
    expect(actual.at(-1)?.live).toEqual([]);
    expect(actual.at(-1)?.randomCalls).toBe(1);
    expect(actual.at(-1)?.values[1]).toBe(100);
  }, 60_000);

  it('lossy live rewrites preserve the complete step trace for an eligible single-thread project', async () => {
    const original = createSafeLossyProject();
    const transformed = obfuscateProject(original, 'lossy', new Uint8Array(32).fill(0xa7)).project;
    const expected = await executeTrace(createFixtureArchive(original), 1);
    const actual = await executeTrace(createFixtureArchive(transformed), 1);
    expect(actual).toEqual(expected);
    expect(actual.at(-1)?.values).toEqual([107]);
    expect(actual.at(-1)?.randomCalls).toBe(0);
  }, 60_000);

  it('no-preserve conservatively falls back and remains deterministic for a race-sensitive project', async () => {
    const original = createRaceProject();
    const result = obfuscateProject(original, 'no-preserve', new Uint8Array(32).fill(0x3c));
    expect(result.stats.virtualizedBlocks).toBe(0);
    const originalTrace = await executeTrace(createFixtureArchive(original), 2);
    const first = await executeTrace(createFixtureArchive(result.project), 2);
    const second = await executeTrace(createFixtureArchive(result.project), 2);
    expect(first).toEqual(second);
    expect(first.at(-1)?.live).toEqual([]);
    expect(first.at(-1)?.values).toEqual(originalTrace.at(-1)?.values);
  }, 60_000);
});

function createTraceProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  stage.variables = {
    trace_random: ['trace random', 0],
    trace_key: ['trace key', 0],
    trace_timer: ['trace timer', 0],
    trace_parallel: ['trace parallel', 0]
  };
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat_random: block('event_whenflagclicked', 'set_random', null, {}, {}, true),
    set_random: block('data_setvariableto', 'wait_clock', 'hat_random', {
      VALUE: [3, 'random_reporter', [4, '0']]
    }, {VARIABLE: ['trace random', 'trace_random']}),
    random_reporter: block('operator_random', null, 'set_random', {
      FROM: [1, [4, '1']],
      TO: [1, [4, '10']]
    }),
    wait_clock: block('control_wait', 'sample_key', 'set_random', {
      DURATION: [1, [4, '0.032']]
    }),
    sample_key: block('control_if', 'sample_timer', 'wait_clock', {
      CONDITION: [2, 'key_reporter'],
      SUBSTACK: [2, 'change_key']
    }),
    key_reporter: block('sensing_keypressed', null, 'sample_key', {
      KEY_OPTION: [1, [10, 'space']]
    }),
    change_key: block('data_changevariableby', null, 'sample_key', {
      VALUE: [1, [4, '100']]
    }, {VARIABLE: ['trace key', 'trace_key']}),
    sample_timer: block('data_setvariableto', null, 'sample_key', {
      VALUE: [2, 'timer_reporter']
    }, {VARIABLE: ['trace timer', 'trace_timer']}),
    timer_reporter: block('sensing_timer', null, 'sample_timer'),
    hat_parallel: block('event_whenflagclicked', 'change_parallel_one', null, {}, {}, true),
    change_parallel_one: block('data_changevariableby', 'wait_parallel', 'hat_parallel', {
      VALUE: [1, [4, '1']]
    }, {VARIABLE: ['trace parallel', 'trace_parallel']}),
    wait_parallel: block('control_wait', 'change_parallel_two', 'change_parallel_one', {
      DURATION: [1, [4, '0.016']]
    }),
    change_parallel_two: block('data_changevariableby', null, 'wait_parallel', {
      VALUE: [1, [4, '10']]
    }, {VARIABLE: ['trace parallel', 'trace_parallel']})
  };
  project.targets = [stage];
  project.monitors = [];
  return project;
}

function createSafeLossyProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  stage.variables = {safe_value: ['safe value', 0]};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    safe_hat: block('event_whenflagclicked', 'safe_first', null, {}, {}, true),
    safe_first: block('data_changevariableby', 'safe_if', 'safe_hat', {
      VALUE: [1, [4, '1']]
    }, {VARIABLE: ['safe value', 'safe_value']}),
    safe_if: block('control_if', 'safe_change_1', 'safe_first', {
      CONDITION: [2, 'safe_equals'],
      SUBSTACK: [2, 'safe_branch']
    }),
    safe_equals: block('operator_equals', null, 'safe_if', {
      OPERAND1: [1, [4, '7']],
      OPERAND2: [1, [4, '7']]
    }),
    safe_branch: block('data_changevariableby', null, 'safe_if', {
      VALUE: [1, [4, '100']]
    }, {VARIABLE: ['safe value', 'safe_value']}),
    safe_change_1: changeBlock('safe_change_2', 'safe_if'),
    safe_change_2: changeBlock('safe_change_3', 'safe_change_1'),
    safe_change_3: changeBlock('safe_change_4', 'safe_change_2'),
    safe_change_4: changeBlock('safe_change_5', 'safe_change_3'),
    safe_change_5: changeBlock('safe_change_6', 'safe_change_4'),
    safe_change_6: changeBlock(null, 'safe_change_5')
  };
  project.targets = [stage];
  project.monitors = [];
  return project;
}

function createRaceProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  stage.variables = {
    race_value: ['race value', 0],
    delay_value: ['delay value', 0]
  };
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    race_hat_a: block('event_whenflagclicked', 'race_a_set_1', null, {}, {}, true),
    race_a_set_1: setVariableBlock('race_a_delay_1', 'race_hat_a', 'race value', 'race_value', 0),
    race_a_delay_1: changeNamedBlock('race_a_delay_2', 'race_a_set_1', 'delay value', 'delay_value', 1),
    race_a_delay_2: changeNamedBlock('race_a_delay_3', 'race_a_delay_1', 'delay value', 'delay_value', 1),
    race_a_delay_3: changeNamedBlock('race_a_set_2', 'race_a_delay_2', 'delay value', 'delay_value', 1),
    race_a_set_2: setVariableBlock(null, 'race_a_delay_3', 'race value', 'race_value', 0),
    race_hat_b: block('event_whenflagclicked', 'race_b_1', null, {}, {}, true),
    race_b_1: changeNamedBlock('race_b_2', 'race_hat_b', 'race value', 'race_value', 10),
    race_b_2: changeNamedBlock('race_b_3', 'race_b_1', 'race value', 'race_value', 10),
    race_b_3: changeNamedBlock('race_b_4', 'race_b_2', 'race value', 'race_value', 10),
    race_b_4: changeNamedBlock('race_b_5', 'race_b_3', 'race value', 'race_value', 10),
    race_b_5: changeNamedBlock(null, 'race_b_4', 'race value', 'race_value', 10)
  };
  const monitorTemplate = project.monitors[0];
  if (!monitorTemplate) throw new Error('fixture monitor is missing');
  project.monitors = [
    {...monitorTemplate, id: 'race_value', params: {VARIABLE: 'race value'}},
    {...monitorTemplate, id: 'delay_value', params: {VARIABLE: 'delay value'}, x: 10, y: 30}
  ];
  project.targets = [stage];
  return project;
}

function changeBlock(next: string | null, parent: string): ScratchBlock {
  return block('data_changevariableby', next, parent, {
    VALUE: [1, [4, '1']]
  }, {VARIABLE: ['safe value', 'safe_value']});
}

function changeNamedBlock(next: string | null, parent: string, name: string, id: string, amount: number): ScratchBlock {
  return block('data_changevariableby', next, parent, {
    VALUE: [1, [4, String(amount)]]
  }, {VARIABLE: [name, id]});
}

function setVariableBlock(next: string | null, parent: string, name: string, id: string, value: number): ScratchBlock {
  return block('data_setvariableto', next, parent, {
    VALUE: [1, [4, String(value)]]
  }, {VARIABLE: [name, id]});
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, ScratchField> = {},
  topLevel = false
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

async function executeTrace(archive: Uint8Array, variableCount = 4): Promise<StepTrace[]> {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  let now = 1_000_000;
  let randomState = 0x1234_5678;
  let randomCalls = 0;
  Date.now = () => {
    now += 1;
    return now;
  };
  Math.random = () => {
    randomCalls += 1;
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
  };

  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  try {
    await vm.loadProject(archive);
    vm.start();
    now = 1_000_000;
    randomState = 0x1234_5678;
    vm.greenFlag();
    randomCalls = 0;
    const traces: StepTrace[] = [];
    for (let step = 0; step < 12; step += 1) {
      vm.postIOData('keyboard', {key: ' ', isDown: step >= 1 && step <= 4});
      vm.runtime._step();
      traces.push({
        step,
        randomCalls,
        redraw: vm.runtime.redrawRequested,
        values: originalVariableValues(vm.runtime.targets, variableCount),
        live: vm.runtime.threads.map(threadTrace),
        done: (vm.runtime._lastStepDoneThreads ?? []).map(threadTrace)
      });
      now += 16;
      if (vm.runtime.threads.length === 0) break;
    }
    expect(vm.runtime.threads).toHaveLength(0);
    return traces;
  } finally {
    vm.quit();
    Date.now = originalNow;
    Math.random = originalRandom;
  }
}

function originalVariableValues(targets: readonly RuntimeTarget[], variableCount: number): unknown[] {
  const stage = targets.find(target => target.isStage);
  if (!stage) throw new Error('runtime Stage is missing');
  return Object.values(stage.variables).slice(0, variableCount).map(variable => structuredClone(variable.value));
}

function threadTrace(thread: RuntimeThread): ThreadTrace {
  const activeId = thread.stack.at(-1);
  return {
    target: thread.target.name,
    topOpcode: opcodeAt(thread, thread.topBlock),
    activeOpcode: activeId === undefined ? null : opcodeAt(thread, activeId),
    status: thread.status,
    depth: thread.stack.length
  };
}

function opcodeAt(thread: RuntimeThread, blockId: string): string {
  const opcode = thread.target.blocks.getBlock(blockId)?.opcode;
  return typeof opcode === 'string' ? opcode : '<missing>';
}
