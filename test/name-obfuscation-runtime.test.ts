import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {ANTI_CHEAT_WATERMARK_NAME} from '../src/obfuscation/anticheat.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ObfuscationMode, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  readonly type: string;
  value: unknown;
}

interface RuntimeTarget {
  readonly isStage: boolean;
  readonly variables: Record<string, RuntimeVariable>;
}

interface RuntimeMonitor {
  get(key: string): unknown;
}

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  saveProjectSb3(): Promise<Blob | Uint8Array>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    readonly targets: RuntimeTarget[];
    readonly threads: unknown[];
    readonly _monitorState: {get(id: string): RuntimeMonitor | undefined};
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

describe('precise name obfuscation against the official Scratch runtime', () => {
  it('preserves static target lookup, missing-target results, native attributes, and duplicate first-match order', async () => {
    const source = staticSensingProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x61));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([11, 12, 0, 0, 70, 21]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);
    expect(transformed.stats.warnings).toEqual([]);

    expectOriginalStringsAbsent(transformed.project, [
      'Static Stage scalar',
      'Static sprite scalar',
      'Duplicate first-match',
      'Hidden sprite scalar',
      'Runtime result list'
    ]);
    const transformedSprite = requireTarget(transformed.project, 1);
    expect(declarationNameForValue(transformedSprite, 999)).not.toBe('x position');
  }, 60_000);

  it('preserves literal selection by an unimplemented official menu shadow', async () => {
    const source = literalShadowSensingProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x63));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([73]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);

    const transformedStage = requireTarget(transformed.project, 0);
    expect(declarationNameForValue(transformedStage, 61)).toMatch(/^x_/u);
    expect(declarationNameForValue(transformedStage, 61)).not.toBe('x position');
    expectOriginalStringsAbsent(transformed.project, ['Literal-shadow runtime results']);
  }, 60_000);

  it('uses broadcast IDs rather than stale menu labels for runtime target selection', async () => {
    const source = staleBroadcastSelectorProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x65));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([82, 82]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);

    const stage = requireTarget(transformed.project, 0);
    const firstSprite = requireTarget(transformed.project, 1);
    const secondSprite = requireTarget(transformed.project, 2);
    expect(Object.values(stage.broadcasts)).toEqual([secondSprite.name]);
    expect(declarationNameForValue(firstSprite, 81)).not.toBe(declarationNameForValue(secondSprite, 82));
    expectOriginalStringsAbsent(transformed.project, [
      'Selected through normalized broadcast',
      'Stale broadcast results'
    ]);
  }, 60_000);

  it('preserves only variable and list names exposed as static reporter values', async () => {
    const source = typedMenuSelectorProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x66));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([92, 92, 92, 92]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);

    const stage = requireTarget(transformed.project, 0);
    const selectedTarget = requireTarget(transformed.project, 2);
    expect(declarationNameForValue(stage, 'variable selector')).toBe(selectedTarget.name);
    expect(declarationNameForListItem(stage, 'list selector')).toBe(selectedTarget.name);
    expect(declarationNameForValue(stage, 'ordinary variable')).toMatch(/^x_/u);
    expect(declarationNameForListItem(stage, 'ordinary list')).toMatch(/^x_/u);
    expect(transformed.stats.caveats).toContain(
      'Display names were preserved because typed menu fields are used as runtime reporter values.'
    );
  }, 60_000);

  it('preserves a dynamic selector switching among Stage and sprites with coupled opaque names', async () => {
    const source = dynamicSensingProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x67));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([31, 32, 33, 51, 70]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);

    const stage = requireTarget(transformed.project, 0);
    const firstSprite = requireTarget(transformed.project, 1);
    const secondSprite = requireTarget(transformed.project, 2);
    const sharedName = declarationNameForValue(stage, 31);
    expect(sharedName).not.toBe('Dynamically selected scalar');
    expect(declarationNameForValue(firstSprite, 32)).toBe(sharedName);
    expect(declarationNameForValue(secondSprite, 33)).toBe(sharedName);
    expect(declarationNameForValue(stage, 51)).toBe('x position');
    expect(declarationNameForValue(firstSprite, 999)).not.toBe('x position');
    expectOriginalStringsAbsent(transformed.project, [
      'Dynamically selected scalar',
      'Runtime target selector',
      'Dynamic runtime results'
    ]);
  }, 60_000);

  it('treats a multi-field object reporter as dynamic instead of its apparent literal field', async () => {
    const source = multiFieldObjectProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x69));
    validateProject(transformed.project);

    const sourceObservation = await execute(source);
    expect(sourceObservation.results).toEqual([0]);
    expect(await execute(transformed.project)).toEqual(sourceObservation);
    expect(await execute(transformed.project, true)).toEqual(sourceObservation);

    const stage = requireTarget(transformed.project, 0);
    const firstSprite = requireTarget(transformed.project, 1);
    const apparentTarget = requireTarget(transformed.project, 2);
    const sharedName = declarationNameForValue(stage, 41);
    expect(sharedName).toMatch(/^x_/u);
    expect(declarationNameForValue(firstSprite, 42)).toBe(sharedName);
    expect(declarationNameForValue(apparentTarget, 43)).toBe(sharedName);
    expectOriginalStringsAbsent(transformed.project, [
      'Multi-field selected scalar',
      'Multi-field runtime results'
    ]);
  }, 60_000);

  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])(
    'keeps a formerly missing Stage watermark-name query equal to zero in %s mode',
    async mode => {
      const source = watermarkSensingCollisionProject();
      validateProject(source);
      const transformed = obfuscateProject(source, mode, new Uint8Array(32).fill(0x6a));
      validateProject(transformed.project);

      const sourceObservation = await execute(source);
      expect(sourceObservation.results).toEqual([0]);
      expect(await execute(transformed.project)).toEqual(sourceObservation);
      expect(await execute(transformed.project, true)).toEqual(sourceObservation);

      const stage = requireTarget(transformed.project, 0);
      const watermarks = Object.values(stage.variables)
        .filter(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME);
      expect(watermarks).toEqual([[ANTI_CHEAT_WATERMARK_NAME, 0]]);
    },
    60_000
  );

  it('preserves a sensing monitor through official load, save, and reload', async () => {
    const source = sensingMonitorProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x6b));
    validateProject(transformed.project);

    const sourceObservation = await execute(source, true, 'sensing-monitor');
    expect(sourceObservation.monitorValue).toBe(77);
    expect(await execute(transformed.project, false, 'sensing-monitor')).toEqual(sourceObservation);
    expect(await execute(transformed.project, true, 'sensing-monitor')).toEqual(sourceObservation);
    expectOriginalStringsAbsent(transformed.project, ['Monitored scalar', 'Unrelated scalar']);
  }, 60_000);
});

function staticSensingProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  sprite.name = 'Sensor Sprite';
  sprite['x'] = 70;
  stage.variables = {
    staticStage: ['Static Stage scalar', 11],
    duplicateFirst: ['Duplicate first-match', 21],
    duplicateSecond: ['Duplicate first-match', 22]
  };
  stage.lists = {results: ['Runtime result list', []]};
  sprite.variables = {
    staticSprite: ['Static sprite scalar', 12],
    hiddenNative: ['x position', 999],
    hiddenMissing: ['Hidden sprite scalar', 88]
  };

  const builder = new ScriptBuilder(sprite, 'results');
  builder.appendSensing('static-stage', 'Static Stage scalar', literal('_stage_'));
  builder.appendSensing('static-sprite', 'Static sprite scalar', literal(sprite.name));
  builder.appendSensing('literal-stage', 'No target property', literal('Stage'));
  builder.appendSensing('missing-target', 'No target property', literal('Missing Sprite'));
  builder.appendSensing('native-x', 'x position', literal(sprite.name));
  builder.appendSensing('duplicate', 'Duplicate first-match', literal('_stage_'));
  return project;
}

function dynamicSensingProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const firstSprite = requireTarget(project, 1);
  firstSprite.name = 'Sensor A';
  firstSprite['x'] = 70;
  const secondSprite = structuredClone(firstSprite);
  secondSprite.name = 'Sensor B';
  secondSprite['x'] = -40;
  project.targets.push(secondSprite);

  stage.variables = {
    dynamicStage: ['Dynamically selected scalar', 31],
    stageX: ['x position', 51]
  };
  stage.lists = {results: ['Dynamic runtime results', []]};
  firstSprite.variables = {
    dynamicLocal: ['Dynamically selected scalar', 32],
    selector: ['Runtime target selector', '_stage_'],
    hiddenNative: ['x position', 999]
  };
  secondSprite.variables = {
    dynamicSecond: ['Dynamically selected scalar', 33],
    hiddenNativeSecond: ['x position', 998]
  };

  const selector = (): ScratchInput => [1, [12, 'Runtime target selector', 'selector']];
  const builder = new ScriptBuilder(firstSprite, 'results');
  builder.setVariable('select-stage', 'selector', 'Runtime target selector', '_stage_');
  builder.appendSensing('dynamic-stage', 'Dynamically selected scalar', selector());
  builder.setVariable('select-a', 'selector', 'Runtime target selector', firstSprite.name);
  builder.appendSensing('dynamic-a', 'Dynamically selected scalar', selector());
  builder.setVariable('select-b', 'selector', 'Runtime target selector', secondSprite.name);
  builder.appendSensing('dynamic-b', 'Dynamically selected scalar', selector());
  builder.setVariable('select-stage-x', 'selector', 'Runtime target selector', '_stage_');
  builder.appendSensing('dynamic-stage-x', 'x position', selector());
  builder.setVariable('select-a-x', 'selector', 'Runtime target selector', firstSprite.name);
  builder.appendSensing('dynamic-a-x', 'x position', selector());
  return project;
}

function literalShadowSensingProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  sprite.name = 'Sprite1';
  sprite['x'] = 73;
  stage.variables = {hiddenBySpriteAttribute: ['x position', 61]};
  stage.lists = {results: ['Literal-shadow runtime results', []]};

  const builder = new ScriptBuilder(sprite, 'results');
  builder.appendSensing('literal-shadow', 'x position', [1, 'goto-menu']);
  sprite.blocks['goto-menu'] = {
    opcode: 'motion_goto_menu',
    next: null,
    parent: 'literal-shadow-reporter',
    inputs: {},
    fields: {TO: [sprite.name]},
    shadow: true,
    topLevel: false
  };
  return project;
}

function staleBroadcastSelectorProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const firstSprite = requireTarget(project, 1);
  firstSprite.name = 'Stale broadcast target';
  const secondSprite = structuredClone(firstSprite);
  secondSprite.name = 'Declared broadcast target';
  project.targets.push(secondSprite);

  stage.lists = {results: ['Stale broadcast results', []]};
  stage.broadcasts = {targetSelector: secondSprite.name};
  firstSprite.variables = {selectedFirst: ['Selected through normalized broadcast', 81]};
  secondSprite.variables = {selectedSecond: ['Selected through normalized broadcast', 82]};

  const builder = new ScriptBuilder(firstSprite, 'results');
  builder.appendSensing(
    'inline-broadcast',
    'Selected through normalized broadcast',
    [1, [11, firstSprite.name, 'targetSelector']]
  );
  builder.appendSensing(
    'object-broadcast',
    'Selected through normalized broadcast',
    [2, 'object-broadcast-menu']
  );
  firstSprite.blocks['object-broadcast-menu'] = {
    opcode: 'event_broadcast_menu',
    next: null,
    parent: 'object-broadcast-reporter',
    inputs: {},
    fields: {BROADCAST_OPTION: [firstSprite.name, 'targetSelector']},
    shadow: false,
    topLevel: false
  };
  return project;
}

function typedMenuSelectorProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const owner = requireTarget(project, 1);
  owner.name = 'Typed menu owner';
  const selectedTarget = structuredClone(owner);
  selectedTarget.name = 'Runtime typed target';
  project.targets.push(selectedTarget);

  stage.variables = {
    selectorVariable: [selectedTarget.name, 'variable selector'],
    ordinaryVariable: ['Ordinary runtime variable', 'ordinary variable']
  };
  stage.lists = {
    results: ['Typed menu runtime results', []],
    selectorList: [selectedTarget.name, ['list selector']],
    ordinaryList: ['Ordinary runtime list', ['ordinary list']]
  };
  owner.variables = {selectedOwner: ['Selected through typed menu', 91]};
  selectedTarget.variables = {selectedTarget: ['Selected through typed menu', 92]};

  const builder = new ScriptBuilder(owner, 'results');
  for (const [fieldName, symbolId, shadow] of [
    ['VARIABLE', 'selectorVariable', true],
    ['VARIABLE', 'selectorVariable', false],
    ['LIST', 'selectorList', true],
    ['LIST', 'selectorList', false]
  ] as const) {
    const id = `${fieldName.toLowerCase()}-${shadow ? 'shadow' : 'active'}`;
    builder.appendSensing(id, 'Selected through typed menu', [shadow ? 1 : 2, `${id}-menu`]);
    owner.blocks[`${id}-menu`] = {
      opcode: 'motion_goto_menu',
      next: null,
      parent: `${id}-reporter`,
      inputs: {},
      fields: {[fieldName]: ['stale typed menu label', symbolId]},
      shadow,
      topLevel: false
    };
  }
  return project;
}

function sensingMonitorProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  stage.variables = {
    monitored: ['Monitored scalar', 77],
    unrelated: ['Unrelated scalar', 88]
  };
  project.monitors = [{
    id: 'sensing-monitor',
    mode: 'default',
    opcode: 'sensing_of',
    params: {PROPERTY: 'Monitored scalar', OBJECT: '_stage_'},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: true,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  }];
  return project;
}

function watermarkSensingCollisionProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.lists = {results: ['Watermark sensing results', []]};
  const builder = new ScriptBuilder(sprite, 'results');
  builder.appendSensing('watermark-name', ANTI_CHEAT_WATERMARK_NAME, literal('_stage_'));
  return project;
}

function multiFieldObjectProject(): ScratchProject {
  const project = resetFixture();
  const stage = requireTarget(project, 0);
  const firstSprite = requireTarget(project, 1);
  firstSprite.name = 'Multi-field owner';
  const apparentTarget = structuredClone(firstSprite);
  apparentTarget.name = 'Apparent literal target';
  project.targets.push(apparentTarget);

  stage.variables = {stageSelected: ['Multi-field selected scalar', 41]};
  stage.lists = {results: ['Multi-field runtime results', []]};
  firstSprite.variables = {firstSelected: ['Multi-field selected scalar', 42]};
  apparentTarget.variables = {apparentSelected: ['Multi-field selected scalar', 43]};

  const builder = new ScriptBuilder(firstSprite, 'results');
  builder.appendSensing('multi-field', 'Multi-field selected scalar', [1, 'multi-field-object']);
  firstSprite.blocks['multi-field-object'] = {
    opcode: 'sensing_of_object_menu',
    next: null,
    parent: 'multi-field-reporter',
    inputs: {},
    fields: {
      OBJECT: [apparentTarget.name],
      EXTRA: ['prevents literal-shadow execution']
    },
    shadow: true,
    topLevel: false
  };
  return project;
}

class ScriptBuilder {
  private previous = 'hat';

  public constructor(private readonly target: ScratchTarget, private readonly listId: string) {
    target.blocks['hat'] = command('event_whenflagclicked', null, null);
  }

  public appendSensing(id: string, property: string, object: ScratchInput): void {
    const reporterId = `${id}-reporter`;
    this.appendCommand(id, command(
      'data_addtolist',
      null,
      this.previous,
      {ITEM: [2, reporterId]},
      {LIST: ['results', this.listId]}
    ));
    this.target.blocks[reporterId] = {
      opcode: 'sensing_of',
      next: null,
      parent: id,
      inputs: {OBJECT: object},
      fields: {PROPERTY: [property]},
      shadow: false,
      topLevel: false
    };
  }

  public setVariable(id: string, variableId: string, variableName: string, value: string): void {
    this.appendCommand(id, command(
      'data_setvariableto',
      null,
      this.previous,
      {VALUE: literal(value)},
      {VARIABLE: [variableName, variableId]}
    ));
  }

  private appendCommand(id: string, value: ScratchBlock): void {
    const previous = this.target.blocks[this.previous];
    if (!previous || !isScratchBlock(previous)) throw new Error('script builder lost its command chain');
    previous.next = id;
    this.target.blocks[id] = value;
    this.previous = id;
  }
}

function command(
  opcode: string,
  next: string | null,
  parent: string | null,
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
    topLevel: parent === null,
    ...(parent === null ? {x: 0, y: 0} : {})
  };
}

function literal(value: string | number): ScratchInput {
  return [1, [typeof value === 'number' ? 4 : 10, value]];
}

function resetFixture(): ScratchProject {
  const project = createFixtureProject();
  for (const target of project.targets) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function execute(
  project: ScratchProject,
  roundTrip = false,
  monitorId?: string
): Promise<{results?: unknown[]; monitorValue?: unknown}> {
  const vm = createVm();
  let reloaded: ScratchVmInstance | undefined;
  try {
    await vm.loadProject(createFixtureArchive(project));
    if (roundTrip) {
      reloaded = createVm();
      await reloaded.loadProject(await blobBytes(await vm.saveProjectSb3()));
    }
    const active = reloaded ?? vm;
    active.start();
    active.greenFlag();
    for (let step = 0; step < 1_000 && active.runtime.threads.length > 0; step += 1) active.runtime._step();
    expect(active.runtime.threads).toHaveLength(0);
    for (let step = 0; step < 20; step += 1) active.runtime._step();

    const stage = active.runtime.targets.find(target => target.isStage);
    if (!stage) throw new Error('runtime Stage is unavailable');
    const list = Object.values(stage.variables).find(variable => variable.type === 'list');
    const results: unknown[] | undefined = Array.isArray(list?.value)
      ? (list.value as unknown[]).map(value => value)
      : undefined;
    const monitorValue = monitorId === undefined
      ? undefined
      : active.runtime._monitorState.get(monitorId)?.get('value');
    return {
      ...(results === undefined ? {} : {results}),
      ...(monitorId === undefined ? {} : {monitorValue})
    };
  } finally {
    reloaded?.quit();
    vm.quit();
  }
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

function expectOriginalStringsAbsent(project: ScratchProject, names: readonly string[]): void {
  const serialized = JSON.stringify(project);
  for (const name of names) expect(serialized).not.toContain(JSON.stringify(name));
}

function declarationNameForValue(target: ScratchTarget, value: unknown): string | undefined {
  const declaration = Object.values(target.variables).find(candidate => candidate[1] === value);
  return typeof declaration?.[0] === 'string' ? declaration[0] : undefined;
}

function declarationNameForListItem(target: ScratchTarget, value: unknown): string | undefined {
  const declaration = Object.values(target.lists).find(candidate => (
    Array.isArray(candidate[1]) && candidate[1][0] === value
  ));
  return typeof declaration?.[0] === 'string' ? declaration[0] : undefined;
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing target ${index}`);
  return target;
}
