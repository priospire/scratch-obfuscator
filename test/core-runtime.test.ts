import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {ANTI_CHEAT_WATERMARK_NAME} from '../src/obfuscation/anticheat.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  type: string;
  value: unknown;
  isCloud: boolean;
}

interface RuntimeTarget {
  isStage: boolean;
  x: number;
  variables: Record<string, RuntimeVariable>;
}

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  deserializeProject(project: ScratchProject, zip?: unknown): Promise<void>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    _monitorState: {
      readonly size: number;
      get(id: string): {get(key: string): unknown} | undefined;
    };
    _step(): void;
  };
}

const REUSED_LOCAL_ID = 'lAmKD/5@\\~x?|7/01i)[%';

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;
interface JsZipModule {
  loadAsync(data: Uint8Array): Promise<unknown>;
}

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
const jsZipValue: unknown = require('jszip');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
if ((typeof jsZipValue !== 'object' && typeof jsZipValue !== 'function') || jsZipValue === null || typeof (jsZipValue as {loadAsync?: unknown}).loadAsync !== 'function') {
  throw new Error('Scratch ZIP loader is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;
const JsZip = jsZipValue as JsZipModule;

describe('common transforms against the official Scratch VM', () => {
  it('preserves Stage name-only lookup and binds broadcasts through Stage despite sprite decoys', async () => {
    const source = nameOnlyProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(37)).project;
    validateProject(transformed);

    const stage = transformed.targets[0];
    const sprite = transformed.targets[1];
    if (!stage || !sprite) throw new Error('transformed targets missing');
    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    const variableField = blocks.find(block => block.opcode === 'data_changevariableby')?.fields['VARIABLE'];
    const listField = blocks.find(block => block.opcode === 'data_addtolist')?.fields['LIST'];
    const broadcastField = blocks.find(block => block.opcode === 'event_whenbroadcastreceived')?.fields['BROADCAST_OPTION'];
    const stageScalarId = Object.keys(stage.variables).find(id => stage.variables[id]?.[1] === 0);
    const stageListId = Object.keys(stage.lists)[0];
    const stageBroadcastId = Object.keys(stage.broadcasts)[0];
    expect(variableField).toEqual([stage.variables[stageScalarId ?? '']?.[0], stageScalarId]);
    expect(listField).toEqual([stage.lists[stageListId ?? '']?.[0], stageListId]);
    expect(broadcastField).toEqual([stage.broadcasts[stageBroadcastId ?? ''], stageBroadcastId]);
    const dynamicBroadcast = Object.values(stage.blocks)
      .filter(isScratchBlock)
      .find(block => block.opcode === 'event_broadcast')
      ?.inputs['BROADCAST_INPUT']?.[1];
    expect(dynamicBroadcast).toEqual([11, stage.broadcasts[stageBroadcastId ?? ''], stageBroadcastId]);

    expect(await executeSnapshot(transformed)).toEqual(await executeSnapshot(source));
  }, 60_000);

  it('preserves computed broadcast lookup while still obfuscating its selector variable', async () => {
    const source = nameOnlyProject();
    const sourceStage = source.targets[0];
    const broadcast = sourceStage?.blocks['broadcast_message'];
    if (!sourceStage || !isScratchBlock(broadcast)) throw new Error('fixture broadcast block missing');
    sourceStage.variables['broadcast_selector'] = ['Readable broadcast selector', 'go'];
    sourceStage.blocks['broadcast_selector_reporter'] = {
      opcode: 'data_variable', next: null, parent: 'broadcast_message', inputs: {},
      fields: {VARIABLE: ['Readable broadcast selector', 'broadcast_selector']}, shadow: false, topLevel: false
    };
    broadcast.inputs['BROADCAST_INPUT'] = [3, 'broadcast_selector_reporter', [11, 'go', 'broadcast_go']];
    validateProject(source);

    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(38)).project;
    validateProject(transformed);
    const transformedStage = transformed.targets[0];
    expect(Object.values(transformedStage?.broadcasts ?? {})).toContain('go');
    expect(Object.values(transformedStage?.variables ?? {}).some(tuple => tuple[0] === 'Readable broadcast selector')).toBe(false);
    expect(await executeSnapshot(transformed)).toEqual(await executeSnapshot(source));
  }, 60_000);

  it('preserves duplicate serialized local IDs from separate sprites after disambiguation', async () => {
    const source = duplicateLocalIdProject();
    validateProject(source, {allowRecoverableLocalSymbolIdCollisions: true});
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x5e)).project;
    validateProject(transformed);

    const transformedLocalIds = transformed.targets
      .filter(target => !target.isStage)
      .map(target => Object.keys(target.variables)[0]);
    expect(new Set(transformedLocalIds).size).toBe(2);
    expect(await executeSpriteSnapshots(transformed)).toEqual(await executeSpriteSnapshots(source));
  }, 60_000);

  it('preserves monitor coalescing when repeated records resolve to one duplicate-ID owner', async () => {
    const source = duplicateLocalIdProject();
    addShowVariableScript(source, 'Visible Sprite', 'First local');
    source.monitors.push(
      {
        id: REUSED_LOCAL_ID, mode: 'default', opcode: 'data_variable',
        params: {VARIABLE: 'First local'}, spriteName: 'Visible Sprite', value: 3,
        width: 0, height: 0, x: 0, y: 0, visible: true,
        sliderMin: 0, sliderMax: 100, isDiscrete: true
      },
      {
        id: REUSED_LOCAL_ID, mode: 'default', opcode: 'data_variable',
        params: {VARIABLE: 'First local'}, spriteName: 'Visible Sprite', value: 3,
        width: 0, height: 0, x: 0, y: 0, visible: false,
        sliderMin: 0, sliderMax: 100, isDiscrete: true
      }
    );
    validateProject(source, {allowRecoverableLocalSymbolIdCollisions: true});

    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x6d)).project;
    validateProject(transformed);
    const monitorIds = transformed.monitors
      .filter(monitor => monitor['spriteName'] === 'Visible Sprite')
      .map(monitor => monitor['id']);
    expect(monitorIds).toHaveLength(2);
    expect(new Set(monitorIds).size).toBe(1);
    const transformedMonitorId = monitorIds[0];
    if (typeof transformedMonitorId !== 'string') throw new Error('transformed monitor ID missing');
    expect(transformedMonitorId).not.toBe(REUSED_LOCAL_ID);
    expect(await runtimeMonitorCount(transformed)).toBe(await runtimeMonitorCount(source));
    expect(await runtimeMonitorVisibility(source, REUSED_LOCAL_ID)).toBe(true);
    expect(await runtimeMonitorVisibility(transformed, transformedMonitorId)).toBe(true);
  }, 60_000);

  it('rejects cross-owner monitor visibility coupling before duplicate local IDs are split', async () => {
    const source = duplicateLocalIdProject();
    addShowVariableScript(source, 'Second Sprite', 'Second local');
    source.monitors.push({
      id: REUSED_LOCAL_ID, mode: 'default', opcode: 'data_variable',
      params: {VARIABLE: 'First local'}, spriteName: 'Visible Sprite', value: 3,
      width: 0, height: 0, x: 0, y: 0, visible: false,
      sliderMin: 0, sliderMax: 100, isDiscrete: true
    });

    expect(await runtimeMonitorVisibility(source, REUSED_LOCAL_ID)).toBe(true);
    expect(() => validateProject(source, {allowRecoverableLocalSymbolIdCollisions: true}))
      .toThrow(/monitor visibility references for multiple owners and cannot be safely disambiguated/);
    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x71)))
      .toThrow(/monitor visibility references for multiple owners and cannot be safely disambiguated/);
  }, 60_000);

  it('normalizes inactive null-parent shadows and stale hidden monitors without changing execution', async () => {
    const source = serializerArtifactProject();
    validateProject(source, {
      allowRecoverableInactiveShadowOwnership: true,
      allowRecoverableStaleInvisibleMonitors: true
    });
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x73)).project;
    validateProject(transformed);

    expect(transformed.monitors.some(monitor => monitor['spriteName'] === 'Deleted Sprite')).toBe(false);
    expect(Object.values(transformed.targets[0]?.blocks ?? {}).some(block =>
      isScratchBlock(block) && block.shadow && block.fields['NUM']?.[0] === 'hidden')).toBe(false);
    expect(await executeSnapshot(transformed)).toEqual(await executeSnapshot(source));
  }, 60_000);
});

function nameOnlyProject(): ScratchProject {
  const project = createFixtureProject();
  const sprite = project.targets[1];
  if (!sprite) throw new Error('fixture Sprite missing');
  sprite.variables['local_decoy'] = ['Readable score', 100];
  sprite.lists['local_name_only_list'] = ['Readable list', ['local']];
  sprite.broadcasts['sprite_decoy'] = 'GO';
  const change = sprite.blocks['change_local'];
  const move = sprite.blocks['move_sprite'];
  const receiver = sprite.blocks['receive_script'];
  if (!isScratchBlock(change) || !isScratchBlock(move) || !isScratchBlock(receiver)) throw new Error('fixture blocks missing');
  change.fields['VARIABLE'] = ['Readable score', null];
  change.next = 'append_local_list';
  move.parent = 'append_local_list';
  sprite.blocks['append_local_list'] = {
    opcode: 'data_addtolist',
    next: 'move_sprite',
    parent: 'change_local',
    inputs: {ITEM: [1, [10, 'updated']]},
    fields: {LIST: ['Readable list', '']},
    shadow: false,
    topLevel: false
  };
  receiver.fields['BROADCAST_OPTION'] = ['go'];
  const stage = project.targets[0];
  const broadcast = stage?.blocks['broadcast_message'];
  if (!isScratchBlock(broadcast)) throw new Error('fixture broadcast block missing');
  broadcast.inputs['BROADCAST_INPUT'] = [1, [11, 'go', null]];
  return project;
}

function duplicateLocalIdProject(): ScratchProject {
  const project = createFixtureProject();
  const first = project.targets[1];
  if (!first) throw new Error('fixture Sprite missing');
  first.variables = {[REUSED_LOCAL_ID]: ['First local', 3]};
  const firstChange = first.blocks['change_local'];
  if (!isScratchBlock(firstChange)) throw new Error('fixture change block missing');
  firstChange.fields['VARIABLE'] = ['First local', REUSED_LOCAL_ID];

  const second = structuredClone(first);
  second.name = 'Second Sprite';
  second.variables = {[REUSED_LOCAL_ID]: ['Second local', 30]};
  const secondChange = second.blocks['change_local'];
  if (!isScratchBlock(secondChange)) throw new Error('cloned change block missing');
  secondChange.fields['VARIABLE'] = ['Second local', REUSED_LOCAL_ID];
  project.targets.push(second);
  return project;
}

function addShowVariableScript(project: ScratchProject, targetName: string, variableName: string): void {
  const target = project.targets.find(candidate => candidate.name === targetName);
  if (!target) throw new Error('fixture sprite missing');
  target.blocks['show_duplicate_hat'] = {
    opcode: 'event_whenflagclicked', next: 'show_duplicate_value', parent: null,
    inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0
  };
  target.blocks['show_duplicate_value'] = {
    opcode: 'data_showvariable', next: null, parent: 'show_duplicate_hat',
    inputs: {}, fields: {VARIABLE: [variableName, REUSED_LOCAL_ID]},
    shadow: false, topLevel: false
  };
}

function serializerArtifactProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  const setter = stage?.blocks['set_score'];
  if (!stage || !isScratchBlock(setter)) throw new Error('fixture setter missing');
  setter.inputs['VALUE'] = [3, 'fixedValue', 'hiddenFallback'];
  stage.blocks['fixedValue'] = {
    opcode: 'operator_add', next: null, parent: 'set_score',
    inputs: {NUM1: [1, [4, 40]], NUM2: [1, [4, 2]]}, fields: {},
    shadow: false, topLevel: false
  };
  stage.blocks['hiddenFallback'] = {
    opcode: 'math_number', next: null, parent: null,
    inputs: {}, fields: {NUM: ['hidden']}, shadow: true, topLevel: false
  };
  project.monitors.push({
    opcode: 'data_variable', id: 'old-local-id', params: {VARIABLE: 'i'},
    spriteName: 'Deleted Sprite', value: 0, visible: false,
    mode: 'default', width: 0, height: 0, x: 0, y: 0,
    sliderMin: 0, sliderMax: 100, isDiscrete: true
  });
  return project;
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function executeSnapshot(project: ScratchProject): Promise<Record<string, unknown>> {
  const vm = createVm();
  try {
    const loadable = structuredClone(project);
    loadable['projectVersion'] = 3;
    const zip = await JsZip.loadAsync(createFixtureArchive(project));
    await vm.deserializeProject(loadable, zip);
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    const stage = vm.runtime.targets.find(target => target.isStage);
    const sprite = vm.runtime.targets.find(target => !target.isStage);
    if (!stage || !sprite) throw new Error('runtime targets missing');
    const watermarkIds = new Set(Object.entries(project.targets.find(target => target.isStage)?.variables ?? {})
      .filter(([, declaration]) => declaration[0] === ANTI_CHEAT_WATERMARK_NAME)
      .map(([id]) => id));
    return {
      stage: normalizedVariables(stage.variables, watermarkIds),
      sprite: normalizedVariables(sprite.variables),
      spriteX: sprite.x
    };
  } finally {
    vm.quit();
  }
}

async function executeSpriteSnapshots(project: ScratchProject): Promise<Array<Record<string, unknown>>> {
  const vm = createVm();
  try {
    const loadable = structuredClone(project);
    loadable['projectVersion'] = 3;
    const zip = await JsZip.loadAsync(createFixtureArchive(project));
    await vm.deserializeProject(loadable, zip);
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    return vm.runtime.targets
      .filter(target => !target.isStage)
      .map(target => ({variables: normalizedVariables(target.variables), x: target.x}));
  } finally {
    vm.quit();
  }
}

async function runtimeMonitorCount(project: ScratchProject): Promise<number> {
  const vm = createVm();
  try {
    const loadable = structuredClone(project);
    loadable['projectVersion'] = 3;
    const zip = await JsZip.loadAsync(createFixtureArchive(project));
    await vm.deserializeProject(loadable, zip);
    return vm.runtime._monitorState.size;
  } finally {
    vm.quit();
  }
}

async function runtimeMonitorVisibility(project: ScratchProject, id: string): Promise<unknown> {
  const vm = createVm();
  try {
    const loadable = structuredClone(project);
    loadable['projectVersion'] = 3;
    const zip = await JsZip.loadAsync(createFixtureArchive(project));
    await vm.deserializeProject(loadable, zip);
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    return vm.runtime._monitorState.get(id)?.get('visible');
  } finally {
    vm.quit();
  }
}

function normalizedVariables(
  variables: Readonly<Record<string, RuntimeVariable>>,
  excludedIds: ReadonlySet<string> = new Set()
): Array<Record<string, unknown>> {
  return Object.entries(variables)
    .filter(([id, variable]) => variable.type !== 'broadcast_msg' && !excludedIds.has(id))
    .map(([, variable]) => variable)
    .map(variable => ({type: variable.type, value: variable.value, isCloud: variable.isCloud}))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
