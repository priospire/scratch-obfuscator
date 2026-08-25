import {createRequire} from 'node:module';
import {afterEach, describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {
  ANTI_CHEAT_DECOY_COUNT,
  ANTI_CHEAT_WATERMARK_NAME,
  applyAntiCheatTransform,
  applyWatermarkTransform
} from '../src/obfuscation/anticheat.js';
import type {ScratchBlock, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  value: unknown;
  type: string;
  isCloud: boolean;
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
  stopAll(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    _step(): void;
    startHats(opcode: string, matchFields?: Record<string, string>): unknown[] | undefined;
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

const activeVms: ScratchVmInstance[] = [];
afterEach(() => {
  for (const vm of activeVms.splice(0)) vm.quit();
});

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  activeVms.push(vm);
  return vm;
}

function generator(): DeterministicGenerator {
  return new DeterministicGenerator(Uint8Array.from({length: 32}, (_, index) => index), 'test:anti-cheat');
}

function stageOf(project: ScratchProject) {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function runtimeStage(vm: ScratchVmInstance): RuntimeTarget {
  const stage = vm.runtime.targets.find(target => target.isStage);
  if (!stage) throw new Error('runtime Stage is unavailable');
  return stage;
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

function stepUntilStopped(vm: ScratchVmInstance, maximumSteps = 20): void {
  for (let index = 0; index < maximumSteps && vm.runtime.threads.length > 0; index += 1) {
    vm.runtime._step();
  }
}

function makeBlock(
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

function installKeyEffect(project: ScratchProject, prefix: string): string {
  const stage = stageOf(project);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture Sprite is unavailable');
  const variableId = `${prefix}-effect`;
  const variableName = `${prefix} effect`;
  const hatId = `${prefix}-key-hat`;
  const effectId = `${prefix}-key-effect`;
  stage.variables[variableId] = [variableName, 0];
  sprite.blocks[hatId] = makeBlock(
    'event_whenkeypressed',
    effectId,
    null,
    true,
    {},
    {KEY_OPTION: ['space', null]}
  );
  sprite.blocks[effectId] = makeBlock(
    'data_changevariableby',
    null,
    hatId,
    false,
    {VALUE: [1, [4, '1']]},
    {VARIABLE: [variableName, variableId]}
  );
  return variableId;
}

function prioritizeStartedThreads(vm: ScratchVmInstance, started: readonly unknown[]): void {
  for (let index = started.length - 1; index >= 0; index -= 1) {
    const thread = started[index];
    const currentIndex = vm.runtime.threads.indexOf(thread);
    if (currentIndex < 0) throw new Error('started event thread is unavailable');
    vm.runtime.threads.splice(currentIndex, 1);
    vm.runtime.threads.unshift(thread);
  }
}

describe('anti-cheat transform', () => {
  it('adds the standalone watermark deterministically and idempotently without reordering existing data', () => {
    const first = createFixtureProject();
    const second = createFixtureProject();
    const originalVariables = Object.keys(stageOf(first).variables);
    const originalBlocks = Object.keys(stageOf(first).blocks);

    const firstResult = applyWatermarkTransform(first, generator().fork('standalone-watermark'));
    const secondResult = applyWatermarkTransform(second, generator().fork('standalone-watermark'));

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.watermarkCreated).toBe(true);
    expect(Object.keys(stageOf(first).variables).slice(0, originalVariables.length)).toEqual(originalVariables);
    expect(Object.keys(stageOf(first).blocks)).toEqual(originalBlocks);
    expect(stageOf(first).variables[firstResult.watermarkVariableId]?.[0]).toBe(ANTI_CHEAT_WATERMARK_NAME);
    expect(stageOf(first).variables[firstResult.watermarkVariableId]?.[1]).toBe(0);
    expect(stageOf(first).variables[firstResult.watermarkVariableId]).toHaveLength(2);
    validateProject(first);

    const snapshot = JSON.stringify(first);
    const repeated = applyWatermarkTransform(first, generator().fork('different-domain'));
    expect(repeated).toEqual({
      watermarkVariableId: firstResult.watermarkVariableId,
      watermarkCreated: false
    });
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it('adds a deterministic bounded watchdog without disturbing existing declaration or block order', () => {
    const first = createFixtureProject();
    const second = createFixtureProject();
    const originalStage = stageOf(first);
    const originalVariableIds = Object.keys(originalStage.variables);
    const originalBlockIds = Object.keys(originalStage.blocks);

    const firstResult = applyAntiCheatTransform(first, generator());
    const secondResult = applyAntiCheatTransform(second, generator());

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.decoyVariableIds).toHaveLength(ANTI_CHEAT_DECOY_COUNT);
    expect(firstResult.guardedHatCount).toBe(2);
    expect(firstResult.guardProcedureCount).toBe(2);
    expect(firstResult.generatedBlockCount).toBe(110);
    expect(firstResult.watermarkCreated).toBe(true);
    validateProject(first);

    const stage = stageOf(first);
    const watermark = stage.variables[firstResult.watermarkVariableId];
    expect(watermark?.[0]).toBe(ANTI_CHEAT_WATERMARK_NAME);
    expect(watermark?.[1]).toBe(0);
    expect(watermark).toHaveLength(2);
    expect(Object.values(stage.variables).filter(value => value[0] === ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(1);
    expect(JSON.stringify(first).split(ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(2);
    expect(Object.keys(stage.variables).slice(0, originalVariableIds.length)).toEqual(originalVariableIds);
    expect(Object.keys(stage.blocks).filter(id => originalBlockIds.includes(id))).toEqual(originalBlockIds);
    expect(Object.keys(stage.blocks)[0]).toBe(firstResult.watchdogHatId);

    const generatedVariableIds = [
      firstResult.watermarkVariableId,
      ...firstResult.decoyVariableIds,
      firstResult.latchVariableId
    ];
    expect(new Set(generatedVariableIds).size).toBe(generatedVariableIds.length);
    for (const id of generatedVariableIds) {
      expect(stage.variables[id]).toHaveLength(2);
      expect(stage.variables[id]?.[2]).toBeUndefined();
    }
    const decoyNames = firstResult.decoyVariableIds.map(id => stage.variables[id]?.[0]);
    expect(new Set(decoyNames).size).toBe(ANTI_CHEAT_DECOY_COUNT);
    expect(decoyNames.every(name => typeof name === 'string' && /^x_[A-Za-z0-9]{36}$/.test(name))).toBe(true);

    for (const target of first.targets) {
      for (const block of Object.values(target.blocks)) {
        expect(isScratchBlock(block)).toBe(true);
        if (!isScratchBlock(block)) continue;
        for (const input of Object.values(block.inputs)) {
          if (typeof input[1] === 'string') expect(input).toHaveLength(2);
        }
      }
    }
  });

  it('keeps generated Stage sentinel names away from missing sensing properties', () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    const predictor = generator().fork('variable-names');
    const blockProperty = predictor.id('x_', 36);
    const monitorProperty = predictor.id('x_', 36);
    stage.blocks['missing-sensing-property'] = {
      opcode: 'sensing_of',
      next: null,
      parent: null,
      inputs: {OBJECT: [1, [10, '_stage_']]},
      fields: {PROPERTY: [blockProperty]},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0
    };
    project.monitors.push({
      id: 'missing-sensing-monitor',
      mode: 'default',
      opcode: 'sensing_of',
      params: {PROPERTY: monitorProperty, OBJECT: '_stage_'},
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
    });

    const result = applyAntiCheatTransform(project, generator());
    validateProject(project);

    const generatedNames = [...result.decoyVariableIds, result.latchVariableId]
      .map(id => stage.variables[id]?.[0]);
    expect(generatedNames).not.toContain(blockProperty);
    expect(generatedNames).not.toContain(monitorProperty);
  });

  it('reuses and leaves an existing Stage watermark inert without changing its value', () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    stage.variables['existing-watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'project-owned-value'];

    const result = applyAntiCheatTransform(project, generator());

    expect(result.watermarkCreated).toBe(false);
    expect(result.watermarkVariableId).toBe('existing-watermark');
    expect(stage.variables['existing-watermark']).toEqual([ANTI_CHEAT_WATERMARK_NAME, 'project-owned-value']);
    expect(Object.values(stage.variables).filter(value => value[0] === ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(1);
    expect(result.generatedBlockCount).toBe(110);

    let protectedReadCount = 0;
    for (const target of project.targets) {
      for (const value of Object.values(target.blocks)) {
        if (!isScratchBlock(value) || value.opcode !== 'operator_equals') continue;
        const reporter = value.inputs['OPERAND1']?.[1];
        if (!isPrimitive(reporter) || reporter[0] !== 12 || reporter[2] !== 'existing-watermark') continue;
        protectedReadCount += 1;
        const encodedId = value.inputs['OPERAND2']?.[1];
        const encoded = typeof encodedId === 'string' ? target.blocks[encodedId] : undefined;
        expect(isScratchBlock(encoded) && encoded.opcode === 'operator_join').toBe(true);
        if (!isScratchBlock(encoded)) continue;
        const left = encoded.inputs['STRING1']?.[1];
        const right = encoded.inputs['STRING2']?.[1];
        expect(isPrimitive(left) && left[0] === 10 && typeof left[1] === 'string'
          && isPrimitive(right) && right[0] === 10 && typeof right[1] === 'string'
          ? left[1] + right[1]
          : undefined).toBe('project-owned-value');
      }
    }
    expect(protectedReadCount).toBe(0);
    validateProject(project);
  });

  it('leaves a reused watermark inert with every schema-valid scalar value', async () => {
    const cases: ReadonlyArray<readonly [boolean | number | string, boolean | number | string]> = [
      ['', '!'],
      ['x', 'x!'],
      ['project-owned-value', 'project-owned-value!'],
      [0, 1],
      [72.5, 73.5],
      [true, false],
      [false, true]
    ];

    for (const [index, [initialValue, tamperedValue]] of cases.entries()) {
      const project = createFixtureProject();
      const stage = stageOf(project);
      stage.variables['existing-watermark'] = [ANTI_CHEAT_WATERMARK_NAME, initialValue];
      const effectId = installKeyEffect(project, `watermark-reuse-${index}`);
      const result = applyAntiCheatTransform(project, generator());

      expect(stage.variables['existing-watermark']).toEqual([ANTI_CHEAT_WATERMARK_NAME, initialValue]);
      expect(Object.values(stage.variables).filter(value => value[0] === ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(1);

      const vm = createVm();
      await vm.loadProject(createFixtureArchive(project));
      vm.start();
      const runtime = runtimeStage(vm);
      const watermark = runtime.variables['existing-watermark'];
      const latch = runtime.variables[result.latchVariableId];
      const effect = runtime.variables[effectId];
      if (!watermark || !latch || !effect) throw new Error('runtime watermark fixture variables are unavailable');
      const safeLatchValue = latch.value;

      vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
      stepUntilStopped(vm);
      expect(effect.value).toBe(1);
      expect(latch.value).toBe(safeLatchValue);

      watermark.value = tamperedValue;
      vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
      stepUntilStopped(vm);
      expect(effect.value).toBe(2);
      expect(latch.value).toBe(safeLatchValue);
    }
  }, 30_000);

  it('guards a bundled extension hat without changing its top-level position', () => {
    const project = createFixtureProject();
    const sprite = project.targets.find(target => !target.isStage);
    if (!sprite) throw new Error('fixture Sprite is unavailable');
    project.extensions = ['videoSensing'];
    sprite.blocks['extension-hat'] = makeBlock(
      'videoSensing_whenMotionGreaterThan',
      null,
      null,
      true,
      {REFERENCE: [1, [4, '10']]}
    );
    const originalOrder = Object.keys(sprite.blocks);

    const result = applyAntiCheatTransform(project, generator());

    const extensionHat = sprite.blocks['extension-hat'];
    const call = extensionHat && isScratchBlock(extensionHat) && extensionHat.next
      ? sprite.blocks[extensionHat.next]
      : undefined;
    expect(result.guardedHatCount).toBe(3);
    expect(result.guardProcedureCount).toBe(2);
    expect(extensionHat && isScratchBlock(extensionHat) ? extensionHat.parent : undefined).toBeNull();
    expect(call && isScratchBlock(call) ? call.opcode : undefined).toBe('procedures_call');
    expect(Object.keys(sprite.blocks).filter(id => originalOrder.includes(id))).toEqual(originalOrder);
    validateProject(project);
  });

  it('loads, saves, and reloads through the official VM', async () => {
    const project = createFixtureProject();
    const result = applyAntiCheatTransform(project, generator());
    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    const saved = await blobBytes(await vm.saveProjectSb3());

    const reloaded = createVm();
    await reloaded.loadProject(saved);
    const stage = runtimeStage(reloaded);
    expect(stage.variables[result.watermarkVariableId]?.isCloud).toBe(false);
    expect(stage.variables[result.decoyVariableIds[0] ?? '']?.isCloud).toBe(false);
    expect(stage.variables[result.latchVariableId]?.isCloud).toBe(false);
  }, 30_000);

  it('latches an external decoy edit and stops every running thread', async () => {
    const project = createFixtureProject();
    const result = applyAntiCheatTransform(project, generator());
    const declarations = stageOf(project).variables;
    const decoyId = result.decoyVariableIds[0];
    if (!decoyId) throw new Error('decoy fixture is unavailable');
    const expected = declarations[decoyId]?.[1];
    if (typeof expected !== 'string') throw new Error('decoy fixture value is unavailable');

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    vm.runtime._step();
    expect(vm.runtime.threads.length).toBeGreaterThan(0);

    const stage = runtimeStage(vm);
    const latch = stage.variables[result.latchVariableId];
    const decoy = stage.variables[decoyId];
    if (!latch || !decoy) throw new Error('runtime anti-cheat variables are unavailable');
    const safeLatchValue = latch.value;
    decoy.value = `${expected}!`;
    stepUntilStopped(vm);

    expect(latch.value).not.toBe(safeLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);

    const trippedLatchValue = latch.value;
    decoy.value = expected;
    latch.value = 'arbitrary-reset-value';
    vm.greenFlag();
    stepUntilStopped(vm);
    expect(latch.value).toBe(trippedLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);

  it('blocks a tampered project event before the first green flag', async () => {
    const project = createFixtureProject();
    const effectId = installKeyEffect(project, 'pre-green');
    const result = applyAntiCheatTransform(project, generator());
    const decoyId = result.decoyVariableIds[0];
    const expected = decoyId ? stageOf(project).variables[decoyId]?.[1] : undefined;
    if (!decoyId || typeof expected !== 'string') throw new Error('decoy fixture is unavailable');

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    const stage = runtimeStage(vm);
    const decoy = stage.variables[decoyId];
    const latch = stage.variables[result.latchVariableId];
    const effect = stage.variables[effectId];
    if (!decoy || !latch || !effect) throw new Error('runtime guard variables are unavailable');
    const safeLatchValue = latch.value;
    decoy.value = `${expected}!`;

    const started = vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
    expect(started?.length).toBeGreaterThan(0);
    stepUntilStopped(vm);

    expect(effect.value).toBe(0);
    expect(latch.value).not.toBe(safeLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);

  it('blocks a tampered project event while the green-flag watchdog is stopped', async () => {
    const project = createFixtureProject();
    const effectId = installKeyEffect(project, 'stopped-watchdog');
    const result = applyAntiCheatTransform(project, generator());
    const decoyId = result.decoyVariableIds[0];
    const expected = decoyId ? stageOf(project).variables[decoyId]?.[1] : undefined;
    if (!decoyId || typeof expected !== 'string') throw new Error('decoy fixture is unavailable');

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    vm.runtime._step();
    vm.stopAll();
    expect(vm.runtime.threads).toHaveLength(0);
    const stage = runtimeStage(vm);
    const decoy = stage.variables[decoyId];
    const latch = stage.variables[result.latchVariableId];
    const effect = stage.variables[effectId];
    if (!decoy || !latch || !effect) throw new Error('runtime guard variables are unavailable');
    const safeLatchValue = latch.value;
    decoy.value = `${expected}!`;

    const started = vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
    expect(started?.length).toBeGreaterThan(0);
    stepUntilStopped(vm);

    expect(effect.value).toBe(0);
    expect(latch.value).not.toBe(safeLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);

  it('blocks a tampered event even when it runs before the watchdog thread', async () => {
    const project = createFixtureProject();
    const effectId = installKeyEffect(project, 'watchdog-race');
    const result = applyAntiCheatTransform(project, generator());
    const decoyId = result.decoyVariableIds[0];
    const expected = decoyId ? stageOf(project).variables[decoyId]?.[1] : undefined;
    if (!decoyId || typeof expected !== 'string') throw new Error('decoy fixture is unavailable');

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    vm.runtime._step();
    const stage = runtimeStage(vm);
    const decoy = stage.variables[decoyId];
    const latch = stage.variables[result.latchVariableId];
    const effect = stage.variables[effectId];
    if (!decoy || !latch || !effect) throw new Error('runtime guard variables are unavailable');
    const safeLatchValue = latch.value;
    decoy.value = `${expected}!`;

    const started = vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
    if (!started || started.length === 0) throw new Error('key event thread was not started');
    prioritizeStartedThreads(vm, started);
    stepUntilStopped(vm);

    expect(effect.value).toBe(0);
    expect(latch.value).not.toBe(safeLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);

  it('detects a clone changing a Stage decoy', async () => {
    const project = createFixtureProject();
    const result = applyAntiCheatTransform(project, generator());
    const stage = stageOf(project);
    const sprite = project.targets.find(target => !target.isStage);
    const decoyId = result.decoyVariableIds[1];
    const decoyName = decoyId ? stage.variables[decoyId]?.[0] : undefined;
    if (!sprite || !decoyId || typeof decoyName !== 'string') throw new Error('clone fixture is unavailable');

    sprite.blocks['anti-clone-create-hat'] = makeBlock('event_whenflagclicked', 'anti-clone-create', null, true);
    sprite.blocks['anti-clone-create'] = makeBlock(
      'control_create_clone_of',
      null,
      'anti-clone-create-hat',
      false,
      {CLONE_OPTION: [1, 'anti-clone-menu']}
    );
    sprite.blocks['anti-clone-menu'] = {
      ...makeBlock('control_create_clone_of_menu', null, 'anti-clone-create', false, {}, {CLONE_OPTION: ['_myself_', null]}),
      shadow: true
    };
    sprite.blocks['anti-clone-start'] = makeBlock('control_start_as_clone', 'anti-clone-edit', null, true);
    sprite.blocks['anti-clone-edit'] = makeBlock(
      'data_setvariableto',
      null,
      'anti-clone-start',
      false,
      {VALUE: [1, [10, 'tampered']]},
      {VARIABLE: [decoyName, decoyId]}
    );
    validateProject(project);

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    const runtime = runtimeStage(vm);
    const latch = runtime.variables[result.latchVariableId];
    if (!latch) throw new Error('runtime latch is unavailable');
    const safeLatchValue = latch.value;
    vm.start();
    vm.greenFlag();
    stepUntilStopped(vm, 50);

    expect(latch.value).not.toBe(safeLatchValue);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);

  it('blocks key and broadcast hats that start after a latched trip', async () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    const sprite = project.targets.find(target => !target.isStage);
    if (!sprite) throw new Error('fixture Sprite is unavailable');
    stage.variables['post-trip-effect'] = ['post trip effect', 0];
    sprite.blocks['post-trip-key-hat'] = makeBlock(
      'event_whenkeypressed',
      'post-trip-key-effect',
      null,
      true,
      {},
      {KEY_OPTION: ['space', null]}
    );
    sprite.blocks['post-trip-key-effect'] = makeBlock(
      'data_changevariableby',
      null,
      'post-trip-key-hat',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['post trip effect', 'post-trip-effect']}
    );

    const result = applyAntiCheatTransform(project, generator());
    const decoyId = result.decoyVariableIds[0];
    const expected = decoyId ? stage.variables[decoyId]?.[1] : undefined;
    if (!decoyId || typeof expected !== 'string') throw new Error('decoy fixture is unavailable');

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    vm.runtime._step();
    const runtime = runtimeStage(vm);
    const decoy = runtime.variables[decoyId];
    const effect = runtime.variables['post-trip-effect'];
    const runtimeSprite = vm.runtime.targets.find(target => !target.isStage);
    const localScore = runtimeSprite?.variables['local_score'];
    if (!decoy || !effect || !localScore) throw new Error('runtime guard variables are unavailable');
    decoy.value = `${expected}!`;
    stepUntilStopped(vm);
    decoy.value = expected;
    const effectBefore = effect.value;
    const localBefore = localScore.value;

    vm.runtime.startHats('event_whenkeypressed', {KEY_OPTION: 'space'});
    stepUntilStopped(vm);
    expect(effect.value).toBe(effectBefore);
    expect(vm.runtime.threads).toHaveLength(0);

    vm.runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: 'go'});
    stepUntilStopped(vm);
    expect(localScore.value).toBe(localBefore);
    expect(vm.runtime.threads).toHaveLength(0);
  }, 30_000);
});
