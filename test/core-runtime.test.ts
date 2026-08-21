import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
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
    _step(): void;
  };
}

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
  it('preserves name-only local lookup and binds broadcasts through Stage despite sprite decoys', async () => {
    const source = nameOnlyProject();
    validateProject(source);
    const transformed = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(37)).project;
    validateProject(transformed);

    const stage = transformed.targets[0];
    const sprite = transformed.targets[1];
    if (!stage || !sprite) throw new Error('transformed targets missing');
    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    const variableField = blocks.find(block => block.opcode === 'data_changevariableby')?.fields['VARIABLE'];
    const broadcastField = blocks.find(block => block.opcode === 'event_whenbroadcastreceived')?.fields['BROADCAST_OPTION'];
    const stageScalarId = Object.keys(stage.variables).find(id => stage.variables[id]?.[2] !== true);
    expect(variableField?.[1]).toBe(stageScalarId);
    expect(variableField?.[1]).not.toBe(Object.keys(sprite.variables)[0]);
    expect(broadcastField?.[1]).toBe(Object.keys(stage.broadcasts)[0]);
    expect(broadcastField?.[1]).not.toBe(Object.keys(sprite.broadcasts)[0]);
    const dynamicBroadcast = Object.values(stage.blocks)
      .filter(isScratchBlock)
      .find(block => block.opcode === 'event_broadcast')
      ?.inputs['BROADCAST_INPUT']?.[1];
    expect(dynamicBroadcast).toEqual([11, 'go', null]);

    expect(await executeSnapshot(transformed)).toEqual(await executeSnapshot(source));
  }, 60_000);
});

function nameOnlyProject(): ScratchProject {
  const project = createFixtureProject();
  const sprite = project.targets[1];
  if (!sprite) throw new Error('fixture Sprite missing');
  sprite.broadcasts['sprite_decoy'] = 'GO';
  const change = sprite.blocks['change_local'];
  const receiver = sprite.blocks['receive_script'];
  if (!isScratchBlock(change) || !isScratchBlock(receiver)) throw new Error('fixture blocks missing');
  change.fields['VARIABLE'] = ['Readable score', null];
  receiver.fields['BROADCAST_OPTION'] = ['go'];
  const stage = project.targets[0];
  const broadcast = stage?.blocks['broadcast_message'];
  if (!isScratchBlock(broadcast)) throw new Error('fixture broadcast block missing');
  broadcast.inputs['BROADCAST_INPUT'] = [1, [11, 'go', null]];
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
    return {
      stage: normalizedVariables(stage.variables),
      sprite: normalizedVariables(sprite.variables),
      spriteX: sprite.x
    };
  } finally {
    vm.quit();
  }
}

function normalizedVariables(variables: Readonly<Record<string, RuntimeVariable>>): Array<Record<string, unknown>> {
  return Object.values(variables)
    .filter(variable => variable.type !== 'broadcast_msg')
    .map(variable => ({type: variable.type, value: variable.value, isCloud: variable.isCloud}))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
