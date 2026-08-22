import {createRequire} from 'node:module';
import {afterEach, describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {
  applyAggressiveTransforms,
  makeInvisibleDisplayName
} from '../src/obfuscation/aggressive.js';
import {countObjectBlocks} from '../src/obfuscation/analysis.js';
import {
  ANTI_CHEAT_WATERMARK_NAME,
  applyAntiCheatTransform,
  applyWatermarkTransform
} from '../src/obfuscation/anticheat.js';
import {applySafeOptimizations, optimizeProject} from '../src/obfuscation/optimizer.js';
import type {
  JsonValue,
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchProject,
  ScratchTarget
} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
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
) {
  throw new Error('official Scratch storage constructor is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;
const activeVms: ScratchVmInstance[] = [];

afterEach(() => {
  for (const vm of activeVms.splice(0)) vm.quit();
});

describe('aggressive transform coverage regressions', () => {
  it('retries predicted lossy block and display-name collisions and disambiguates the procedure code', () => {
    const seed = new Uint8Array(32).fill(11);
    const domain = 'coverage:lossy-collisions';
    const factoryRng = new DeterministicGenerator(seed, domain).fork('aggressive-ids');
    const outlineDomain = 'outline-0-command-0';
    const nameRng = factoryRng.fork(`name\u0000${outlineDomain}`);
    const occupiedDisplayName = nameRng.id('x_', 28);
    const occupiedProcedureCode = nameRng.id('x_', 28);
    const blockRng = factoryRng.fork('block\u0000outline-def-0-command-0');
    const occupiedBlockId = blockRng.id('b_', 20);
    const replacementBlockId = blockRng.id('b_', 20);
    const project = blankProject();
    const stage = requireStage(project);
    stage.variables['counter'] = [occupiedDisplayName, 0];
    stage.blocks['hat'] = block('event_whenflagclicked', 'command-0', null, true);
    for (let index = 0; index < 4; index += 1) {
      stage.blocks[`command-${index}`] = block(
        'data_changevariableby',
        index === 3 ? null : `command-${index + 1}`,
        index === 0 ? 'hat' : `command-${index - 1}`,
        false,
        {VALUE: [1, [4, '1']]},
        {VARIABLE: [occupiedDisplayName, 'counter']}
      );
    }
    const last = stage.blocks['command-3'];
    if (!last || !isScratchBlock(last)) throw new Error('fixture command is unavailable');
    last.mutation = {tagName: 'mutation', children: [], proccode: occupiedProcedureCode};
    stage.blocks[occupiedBlockId] = [12, occupiedDisplayName, 'counter'];

    applyAggressiveTransforms(
      project,
      'lossy',
      new DeterministicGenerator(seed, domain),
      stats(project, 'lossy')
    );

    expect(stage.blocks[occupiedBlockId]).toEqual([12, occupiedDisplayName, 'counter']);
    const generatedPrototype = Object.values(stage.blocks).find(value => (
      isScratchBlock(value)
      && value.opcode === 'procedures_prototype'
      && value.mutation?.['proccode'] === `${occupiedProcedureCode}_`
    ));
    expect(generatedPrototype).toBeDefined();
    expect(requireBlock(stage, replacementBlockId).opcode).toBe('procedures_definition');
    validateProject(project);
  });

  it('retries predicted symbol, block, and invisible-name collisions without replacing source entries', () => {
    const seed = new Uint8Array(32).fill(12);
    const domain = 'coverage:no-preserve-collisions';
    const factoryRng = new DeterministicGenerator(seed, domain).fork('aggressive-ids');
    const symbolRng = factoryRng.fork('symbol\u0000decoy-state-0');
    const occupiedSymbolId = symbolRng.id('v_', 20);
    const replacementSymbolId = symbolRng.id('v_', 20);
    const nameRng = factoryRng.fork('name\u0000decoy-state-0');
    const occupiedDisplayName = makeInvisibleDisplayName(nameRng, 0);
    const replacementDisplayName = makeInvisibleDisplayName(nameRng, 1);
    const blockRng = factoryRng.fork('block\u0000guard-driver-hat-top-level');
    const occupiedBlockId = blockRng.id('b_', 20);
    const replacementBlockId = blockRng.id('b_', 20);
    const project = blankProject();
    const stage = requireStage(project);
    stage.lists[occupiedSymbolId] = [occupiedDisplayName, ['source-value']];
    stage.blocks[occupiedBlockId] = [13, occupiedDisplayName, occupiedSymbolId];

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(seed, domain),
      stats(project)
    );

    expect(stage.lists[occupiedSymbolId]).toEqual([occupiedDisplayName, ['source-value']]);
    expect(stage.blocks[occupiedBlockId]).toEqual([13, occupiedDisplayName, occupiedSymbolId]);
    expect(stage.variables[replacementSymbolId]?.[0]).toBe(replacementDisplayName);
    expect(requireBlock(stage, replacementBlockId).opcode).toBe('event_whenflagclicked');
    validateProject(project);
  });

  it('retries a predicted coherent-procedure code collision with a new deterministic domain', () => {
    const seed = new Uint8Array(32).fill(13);
    const domain = 'coverage:coherent-procedure-collision';
    const factoryRng = new DeterministicGenerator(seed, domain).fork('aggressive-ids');
    const occupiedCode = makeInvisibleDisplayName(
      factoryRng.fork('name\u0000coherent-procedure-0-0'),
      4
    );
    const replacementCode = makeInvisibleDisplayName(
      factoryRng.fork('name\u0000coherent-procedure-0-0-0'),
      5
    );
    const project = blankProject();
    const stage = requireStage(project);
    stage.blocks['existing-definition'] = {
      ...block('procedures_definition', null, null, true, {custom_block: [1, 'existing-prototype']}),
      x: 25,
      y: 40
    };
    stage.blocks['existing-prototype'] = {
      ...block('procedures_prototype', null, 'existing-definition', false),
      shadow: true,
      mutation: procedureMutation(occupiedCode, true)
    };
    validateProject(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(seed, domain),
      stats(project)
    );

    expect(requireBlock(stage, 'existing-prototype').mutation?.['proccode']).toBe(occupiedCode);
    expect(Object.values(stage.blocks).some(value => (
      isScratchBlock(value)
      && value.opcode === 'procedures_prototype'
      && value.mutation?.['proccode'] === replacementCode
    ))).toBe(true);
    validateProject(project);
  });

  it('retries both deterministic dispatcher procedure suffixes before allocating a code', () => {
    const seed = new Uint8Array(32).fill(131);
    const domain = 'coverage:dispatcher-procedure-collision';
    const runRng = new DeterministicGenerator(seed, domain).fork('run-0');
    const occupiedCode = makeInvisibleDisplayName(runRng.fork('dispatcher-code'), 5);
    const occupiedFirstSuffix = `${occupiedCode}\u200b`;
    const replacementCode = `${occupiedFirstSuffix}\u2060`;
    const project = incrementProject(4);
    const sprite = project.targets.find(target => !target.isStage);
    if (!sprite) throw new Error('fixture Sprite is unavailable');
    requireBlock(sprite, 'increment-2').mutation = {tagName: 'mutation', proccode: occupiedCode};
    requireBlock(sprite, 'increment-3').mutation = {tagName: 'mutation', proccode: occupiedFirstSuffix};

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(seed, domain),
      stats(project)
    );

    expect(Object.values(sprite.blocks).some(value => (
      isScratchBlock(value)
      && value.opcode === 'procedures_prototype'
      && value.mutation?.['proccode'] === replacementCode
    ))).toBe(true);
    validateProject(project);
  });

  it('splits an exact 16-command run around one native separator and preserves execution', async () => {
    const project = incrementProject(16);
    const sprite = project.targets.find(target => !target.isStage);
    if (!sprite) throw new Error('fixture Sprite is unavailable');
    const resultStats = stats(project);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(14), 'coverage:dispatcher-sixteen'),
      resultStats
    );

    expect(resultStats.virtualizedBlocks).toBe(15);
    const separator = requireBlock(sprite, 'increment-11');
    expect(separator.opcode).toBe('data_changevariableby');
    expect(separator.next).not.toBe('increment-12');
    validateProject(project);

    const vm = createVm();
    await vm.loadProject(createFixtureArchive(project));
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 500 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    const runtimeSprite = vm.runtime.targets.find(target => !target.isStage);
    expect(runtimeSprite?.variables['counter-id']?.value).toBe(16);
  }, 30_000);

  it('preserves default condition, branch, and variable-delta behavior while obscuring their forms', () => {
    const project = blankProject();
    const stage = requireStage(project);
    stage.variables['local'] = ['local', 0];
    stage.blocks['hat'] = block('event_whenflagclicked', 'change', null, true);
    stage.blocks['change'] = block(
      'data_changevariableby',
      null,
      'hat',
      false,
      {},
      {VARIABLE: ['local', 'local']}
    );
    stage.blocks['empty-if'] = block('control_if', null, null, true);

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(15), 'coverage:default-inputs'),
      stats(project)
    );

    const changed = requireBlock(stage, 'change');
    expect(changed.opcode).toBe('data_replaceitemoflist');
    const addId = changed.inputs['ITEM']?.[1];
    const add = typeof addId === 'string' ? requireBlock(stage, addId) : undefined;
    expect(add?.opcode).toBe('operator_add');
    expect(add ? readNumericInput(stage, add.inputs['NUM2']) : undefined).toBe(0);
    const conditional = requireBlock(stage, 'empty-if');
    expect(conditional.opcode).toBe('control_if_else');
    expect(conditional.inputs['SUBSTACK']).toEqual([2, null]);
    expect(conditional.inputs['SUBSTACK2']).toEqual([2, null]);
    const notId = conditional.inputs['CONDITION']?.[1];
    const not = typeof notId === 'string' ? requireBlock(stage, notId) : undefined;
    expect(not?.inputs['OPERAND']).toEqual([1, [10, '']]);
    validateProject(project);
  });

  it('uses every present decoy mutation family and all three coherent procedure templates', () => {
    const project = vocabularyProject();
    const stage = requireStage(project);
    const originalIds = new Set(Object.keys(stage.blocks));

    applyAggressiveTransforms(
      project,
      'no-preserve',
      new DeterministicGenerator(new Uint8Array(32).fill(16), 'coverage:decoy-vocabulary'),
      stats(project)
    );

    const generatedOpcodes = new Set(Object.entries(stage.blocks).flatMap(([id, value]) => (
      !originalIds.has(id) && isScratchBlock(value) ? [value.opcode] : []
    )));
    expect([...generatedOpcodes]).toEqual(expect.arrayContaining([
      'data_deletealloflist',
      'data_addtolist',
      'data_changevariableby',
      'data_deleteoflist',
      'data_setvariableto',
      'data_insertatlist',
      'data_replaceitemoflist'
    ]));

    const templateKinds = new Set<string>();
    for (const value of Object.values(stage.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_definition' || !value.next) continue;
      const prototypeId = value.inputs['custom_block']?.[1];
      const prototype = typeof prototypeId === 'string' ? stage.blocks[prototypeId] : undefined;
      const body = stage.blocks[value.next];
      if (!prototype || !isScratchBlock(prototype) || !body || !isScratchBlock(body)) continue;
      if (body.opcode !== 'data_addtolist' && body.opcode !== 'control_if') continue;
      const warp = prototype.mutation?.['warp'];
      if (typeof warp !== 'string') continue;
      templateKinds.add(`${body.opcode}:${warp}`);
    }
    expect(templateKinds).toEqual(new Set([
      'data_addtolist:true',
      'control_if:true',
      'data_addtolist:false'
    ]));

    const sentBroadcastIds = new Set<string>();
    const receivedBroadcastIds = new Set<string>();
    for (const value of Object.values(stage.blocks)) {
      if (!isScratchBlock(value)) continue;
      const sentId = value.opcode === 'event_broadcast' ? value.inputs['BROADCAST_INPUT']?.[1] : undefined;
      if (Array.isArray(sentId) && typeof sentId[2] === 'string') sentBroadcastIds.add(sentId[2]);
      const receivedId = value.opcode === 'event_whenbroadcastreceived'
        ? value.fields['BROADCAST_OPTION']?.[1]
        : undefined;
      if (typeof receivedId === 'string') receivedBroadcastIds.add(receivedId);
    }
    expect(receivedBroadcastIds.size).toBeGreaterThanOrEqual(3);
    expect([...receivedBroadcastIds].every(id => sentBroadcastIds.has(id))).toBe(true);
    validateProject(project);
  });
});

describe('anti-cheat coverage regressions', () => {
  it('retries predicted watermark, decoy ID, name, and watchdog block collisions deterministically', () => {
    const seed = new Uint8Array(32).fill(21);
    const domain = 'coverage:anti-cheat-collisions';
    const predictor = new DeterministicGenerator(seed, domain);
    const watermarkIds = predictor.fork('watermark').fork('variable-id');
    const watermarkId = watermarkIds.id('v_', 24);
    const replacementWatermarkId = watermarkIds.id('v_', 24);
    const variableIds = predictor.fork('variable-ids');
    const decoyId = variableIds.id('v_ac_', 24);
    const replacementDecoyId = variableIds.id('v_ac_', 24);
    const variableNames = predictor.fork('variable-names');
    const decoyName = variableNames.id('x_', 36);
    const replacementDecoyName = variableNames.id('x_', 36);
    const blockIds = predictor.fork('block-ids');
    const watchdogId = blockIds.id('b_ac_', 24);
    const replacementWatchdogId = blockIds.id('b_ac_', 24);
    const makeProject = (): ScratchProject => {
      const project = createFixtureProject();
      const stage = requireStage(project);
      stage.variables[watermarkId] = ['occupied watermark ID', 1];
      stage.variables[decoyId] = ['occupied decoy ID', 2];
      stage.lists['occupied-name'] = [decoyName, []];
      stage.blocks[watchdogId] = [12, 'occupied decoy ID', decoyId];
      return project;
    };
    const first = makeProject();
    const second = makeProject();

    const firstResult = applyAntiCheatTransform(first, new DeterministicGenerator(seed, domain));
    const secondResult = applyAntiCheatTransform(second, new DeterministicGenerator(seed, domain));

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.watermarkVariableId).toBe(replacementWatermarkId);
    expect(firstResult.decoyVariableIds[0]).toBe(replacementDecoyId);
    expect(firstResult.watchdogHatId).toBe(replacementWatchdogId);
    const stage = requireStage(first);
    expect(stage.variables[watermarkId]).toEqual(['occupied watermark ID', 1]);
    expect(stage.variables[decoyId]).toEqual(['occupied decoy ID', 2]);
    expect(stage.blocks[watchdogId]).toEqual([12, 'occupied decoy ID', decoyId]);
    expect(stage.variables[replacementDecoyId]?.[0]).toBe(replacementDecoyName);
    validateProject(first);
  });

  it('handles zero original hats and groups guarded procedures by all owning targets', () => {
    const noHats = blankProject();
    const noHatResult = applyAntiCheatTransform(
      noHats,
      new DeterministicGenerator(new Uint8Array(32).fill(22), 'coverage:anti-cheat-no-hats')
    );
    expect(noHatResult.guardedHatCount).toBe(0);
    expect(noHatResult.guardProcedureCount).toBe(0);
    validateProject(noHats);

    const grouped = createFixtureProject();
    const stage = requireStage(grouped);
    stage.variables['existing-watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'project-owned'];
    const sourceSprite = grouped.targets.find(target => !target.isStage);
    if (!sourceSprite) throw new Error('fixture Sprite is unavailable');
    const secondSprite = structuredClone(sourceSprite);
    secondSprite.name = 'Second Sprite';
    secondSprite.variables = {};
    secondSprite.lists = {};
    secondSprite.broadcasts = {};
    secondSprite.comments = {};
    secondSprite.blocks = {
      'clone-hat': block('control_start_as_clone', null, null, true)
    };
    grouped.targets.push(secondSprite);

    const groupedResult = applyAntiCheatTransform(
      grouped,
      new DeterministicGenerator(new Uint8Array(32).fill(23), 'coverage:anti-cheat-grouping')
    );

    expect(groupedResult.watermarkCreated).toBe(false);
    expect(groupedResult.guardedHatCount).toBe(3);
    expect(groupedResult.guardProcedureCount).toBe(3);
    for (const [target, hatId] of [
      [grouped.targets[0], 'start_script'],
      [grouped.targets[1], 'receive_script'],
      [grouped.targets[2], 'clone-hat']
    ] as const) {
      if (!target) throw new Error('guarded target is unavailable');
      const hat = requireBlock(target, hatId);
      const call = hat.next ? requireBlock(target, hat.next) : undefined;
      expect(call?.opcode).toBe('procedures_call');
    }
    validateProject(grouped);
  });

  it('rejects a project without a Stage before either public transform can mutate it', () => {
    const project: ScratchProject = {
      targets: [],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const snapshot = structuredClone(project);
    const watermarkGenerator = new DeterministicGenerator(new Uint8Array(32).fill(24), 'coverage:no-stage-watermark');
    const antiCheatGenerator = new DeterministicGenerator(new Uint8Array(32).fill(25), 'coverage:no-stage-anti-cheat');

    expect(() => applyWatermarkTransform(project, watermarkGenerator)).toThrow(/Stage/);
    expect(project).toEqual(snapshot);
    expect(() => applyAntiCheatTransform(project, antiCheatGenerator)).toThrow(/Stage/);
    expect(project).toEqual(snapshot);
  });
});

describe('optimizer coverage regressions', () => {
  it('distinguishes stale sprite list monitors from Stage-owned and visible monitors', () => {
    const project = blankProject();
    const stage = requireStage(project);
    stage.lists['global-list'] = ['global list', ['kept']];
    project.monitors = [
      monitor('data_listcontents', 'missing-list', 'Deleted Sprite', false),
      monitor('data_listcontents', 'global-list', 'Deleted Sprite', false),
      monitor('data_listcontents', 'global-list', 'Deleted Sprite', true),
      monitor('looks_costumenumbername', 'unrelated', 'Deleted Sprite', false)
    ];

    const result = optimizeProject(project, {foldConstants: false});

    expect(result.stats.staleInvisibleMonitorsRemoved).toBe(1);
    expect(result.project.monitors).toEqual(project.monitors.slice(1));
    expect(project.monitors).toHaveLength(4);
    validateProject(result.project);
  });

  it('folds finite boundary arithmetic but retains signed-zero and overflowing roots atomically', () => {
    const exact = expressionProject('operator_add', [4, Number.MAX_SAFE_INTEGER], [4, 0]);
    const exactTargets = exact.targets;
    const exactStats = applySafeOptimizations(exact);
    expect(exact.targets).not.toBe(exactTargets);
    expect(requireBlock(requireStage(exact), 'set').inputs['VALUE']).toEqual([1, [4, Number.MAX_SAFE_INTEGER]]);
    expect(exactStats.reporterTreesFolded).toBe(1);

    const signedZero = expressionProject('operator_multiply', [4, 0], [4, -1]);
    const overflow = expressionProject('operator_multiply', [4, Number.MAX_VALUE], [4, 2]);
    const signedResult = optimizeProject(signedZero);
    const overflowResult = optimizeProject(overflow);
    expect(signedResult.stats.reporterTreesFolded).toBe(0);
    expect(overflowResult.stats.reporterTreesFolded).toBe(0);
    expect(requireStage(signedResult.project).blocks['root']).toBeDefined();
    expect(requireStage(overflowResult.project).blocks['root']).toBeDefined();
    validateProject(signedResult.project);
    validateProject(overflowResult.project);
  });
});

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  activeVms.push(vm);
  return vm;
}

function blankProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  project.targets = [stage];
  project.monitors = [];
  project.extensions = [];
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  return project;
}

function incrementProject(length: number): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture Sprite is unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'counter-id': ['counter', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.blocks = {hat: block('event_whenflagclicked', length > 0 ? 'increment-0' : null, null, true)};
  sprite.comments = {};
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
  project.monitors = [monitor('data_variable', 'counter-id', sprite.name, false)];
  project.extensions = [];
  return project;
}

function vocabularyProject(): ScratchProject {
  const project = blankProject();
  const stage = requireStage(project);
  stage.variables['counter'] = ['counter', 0];
  stage.lists['data'] = ['data', ['a', 'b']];
  const commands: Array<readonly [string, ScratchBlock]> = [
    ['clear', block('data_deletealloflist', null, null, true, {}, {LIST: ['data', 'data']})],
    ['add', block('data_addtolist', null, null, true, {ITEM: [1, [10, 'x']]}, {LIST: ['data', 'data']})],
    ['change', block('data_changevariableby', null, null, true, {VALUE: [1, [4, '1']]}, {VARIABLE: ['counter', 'counter']})],
    ['delete', block('data_deleteoflist', null, null, true, {INDEX: [1, [4, '1']]}, {LIST: ['data', 'data']})],
    ['set', block('data_setvariableto', null, null, true, {VALUE: [1, [10, 'x']]}, {VARIABLE: ['counter', 'counter']})],
    ['insert', block('data_insertatlist', null, null, true, {
      INDEX: [1, [4, '1']],
      ITEM: [1, [10, 'x']]
    }, {LIST: ['data', 'data']})],
    ['replace', block('data_replaceitemoflist', null, null, true, {
      INDEX: [1, [4, '1']],
      ITEM: [1, [10, 'x']]
    }, {LIST: ['data', 'data']})]
  ];
  for (const [id, value] of commands) stage.blocks[id] = value;
  validateProject(project);
  return project;
}

function expressionProject(opcode: string, left: JsonValue[], right: JsonValue[]): ScratchProject {
  const project = blankProject();
  const stage = requireStage(project);
  stage.variables['result'] = ['result', 0];
  stage.blocks['hat'] = block('event_whenflagclicked', 'set', null, true);
  stage.blocks['set'] = block(
    'data_setvariableto',
    null,
    'hat',
    false,
    {VALUE: [3, 'root', [10, 'hidden']]},
    {VARIABLE: ['result', 'result']}
  );
  stage.blocks['root'] = block(
    opcode,
    null,
    'set',
    false,
    {NUM1: [1, left], NUM2: [1, right]}
  );
  return project;
}

function monitor(
  opcode: string,
  id: string,
  spriteName: string,
  visible: boolean
): Record<string, JsonValue> {
  return {
    id,
    mode: opcode === 'data_listcontents' ? 'list' : 'default',
    opcode,
    params: opcode === 'data_listcontents' ? {LIST: id} : {VARIABLE: id},
    spriteName,
    value: opcode === 'data_listcontents' ? [] : 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible,
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
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function procedureMutation(proccode: string, warp: boolean): Record<string, JsonValue> {
  return {
    tagName: 'mutation',
    children: [],
    proccode,
    argumentids: '[]',
    argumentnames: '[]',
    argumentdefaults: '[]',
    warp: String(warp)
  };
}

function requireStage(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!value || !isScratchBlock(value)) throw new Error(`fixture block ${id} is unavailable`);
  return value;
}

function readNumericInput(target: ScratchTarget, input: JsonValue[] | undefined): number | undefined {
  const active = input?.[1];
  if (Array.isArray(active)) return Number(active[1]);
  if (typeof active !== 'string') return undefined;
  const reporter = requireBlock(target, active);
  if (reporter.opcode !== 'operator_multiply') return undefined;
  const left = readNumericInput(target, reporter.inputs['NUM1']);
  const right = readNumericInput(target, reporter.inputs['NUM2']);
  return left === undefined || right === undefined ? undefined : left * right;
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
