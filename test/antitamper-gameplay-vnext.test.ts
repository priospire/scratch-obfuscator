import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock, stageOf} from '../src/model/blocks.js';
import {collectVariableCandidates, isOfficialHatOpcode} from '../src/obfuscation/analysis.js';
import {
  applyAntiCheatTransform,
  applyGameplayStateProtection,
  releaseGameplayStateCandidates,
  reserveGameplayStateCandidates,
  selectReservedGameplayStateCandidates,
  type GameplayStateProtectionResult
} from '../src/obfuscation/anticheat.js';
import {getAntiCheatReleaseCheckpoint, obfuscateProject} from '../src/obfuscation/index.js';
import type {JsonValue, ObfuscationMode, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
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
  runtime: {
    _step(): void;
    targets: RuntimeTarget[];
    threads: unknown[];
  };
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  start(): void;
  greenFlag(): void;
  quit(): void;
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object'
  || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('gameplay-state anti-tamper hardening', () => {
  it('retains eligible control-flow virtualization while gameplay state is reserved', () => {
    const result = obfuscateProject(
      dispatcherGameplayProject(),
      'no-preserve',
      new Uint8Array(32).fill(0x61),
      {antiCheat: true}
    );

    expect(result.stats.virtualizedBlocks).toBe(4);
    expect(result.stats.warnings.some(warning => warning.includes('rolled back'))).toBe(false);
    expect(result.project.monitors).toHaveLength(0);
    validateProject(result.project);
  });

  it('composes gameplay guards with anti-save entry guards in lossless mode', () => {
    const result = obfuscateProject(
      gameplayProject().project,
      'lossless',
      new Uint8Array(32).fill(0x62),
      {antiCheat: true, antiSave: true}
    );

    expect(result.stats.antiSaveCanaries).toBeGreaterThan(0);
    expect(result.stats.antiCheatDecoys).toBeGreaterThan(0);
    expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    expect(getAntiCheatReleaseCheckpoint(result)).toBeDefined();
    validateProject(result.project);
  });

  it('accepts the strongest modifier combination and shadows every final native hat', () => {
    const result = obfuscateProject(
      gameplayProject().project,
      'no-preserve',
      new Uint8Array(32).fill(0x63),
      {antiCheat: true, antiSave: true, extraLevel: 2}
    );
    const nativeHats = result.project.targets.flatMap(target => Object.values(target.blocks))
      .filter(value => isScratchBlock(value) && value.topLevel && isOfficialHatOpcode(value.opcode));

    expect(nativeHats.length).toBeGreaterThan(0);
    expect(nativeHats.every(hat => isScratchBlock(hat) && hat.shadow)).toBe(true);
    expect(result.stats.extraPrivacyLevel).toBe(2);
    expect(result.stats.privacyHatShadowSites).toBe(nativeHats.length);
    expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    expect(getAntiCheatReleaseCheckpoint(result)).toBeDefined();
    validateProject(result.project);
  });

  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])(
    'preserves the gameplay result through the integrated %s pipeline',
    async mode => {
      const source = gameplayProject().project;
      const transformed = obfuscateProject(
        source,
        mode,
        new Uint8Array(32).fill(0x8d),
        {antiCheat: true}
      ).project;
      validateProject(transformed);
      expect(transformed.monitors).toHaveLength(0);
      expect(opcodeCount(transformed, 'sensing_of')).toBeGreaterThan(0);

      const vm = await loadVm(transformed);
      try {
        vm.start();
        vm.greenFlag();
        step(vm, 30);
        const listValues = Object.values(runtimeStage(vm).variables)
          .map(variable => variable.value)
          .filter(Array.isArray);
        expect(listValues).toContainEqual([12]);
      } finally {
        vm.quit();
      }
    },
    30_000
  );

  it('preserves legitimate set, change, and read behavior while refreshing the integrity tag', async () => {
    const {project, scoreId, resultsId} = gameplayProject();
    const state = protect(project);
    const tagId = requireFirst(state.integrityVariableIds, 'integrity variable');
    validateProject(project);

    const vm = await loadVm(project);
    try {
      vm.start();
      vm.greenFlag();
      step(vm, 20);
      const stage = runtimeStage(vm);
      expect(stage.variables[scoreId]?.value).toBe(12);
      expect(stage.variables[tagId]?.value).toBe(
        `${requirePairSecret(state, scoreId)}12`
      );
      expect(runtimeListValue(stage, resultsId)).toEqual([12]);
      expect(stage.variables[state.breachVariableId ?? '']?.value).toBe(
        stageOf(project).variables[state.breachVariableId ?? '']?.[1]
      );
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('preserves a Unicode sprite-local string and verifies it through the sprite name rail', async () => {
    const {project, valueId, resultsId} = spriteStringProject();
    const state = protect(project);
    const pair = state.integrityPairs.find(candidate => candidate.valueId === valueId);
    if (!pair) throw new Error('sprite integrity pair is unavailable');
    expect(pair.selector).toBe('Sprite');
    validateProject(project);

    const vm = await loadVm(project);
    try {
      vm.start();
      vm.greenFlag();
      step(vm, 20);
      const sprite = vm.runtime.targets.find(target => !target.isStage);
      if (!sprite) throw new Error('runtime sprite is unavailable');
      expect(sprite.variables[valueId]?.value).toBe(' MiXeD 🙂 ');
      expect(sprite.variables[pair.tagId]?.value).toBe(`${pair.secret} MiXeD 🙂 `);
      expect(runtimeListValue(sprite, resultsId)).toEqual([' MiXeD 🙂 ']);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it.each(['value', 'tag', 'value-name', 'tag-name'] as const)(
    'trips before gameplay after a %s mutation',
    async mutation => {
      const {project, scoreId, resultsId} = gameplayProject();
      const state = protect(project);
      const stage = stageOf(project);
      const tagId = requireFirst(state.integrityVariableIds, 'integrity variable');
      const breachId = state.breachVariableId;
      if (!breachId) throw new Error('breach variable is unavailable');
      const safeBreach = stage.variables[breachId]?.[1];

      if (mutation === 'value') {
        const declaration = stage.variables[scoreId];
        if (!declaration) throw new Error('score declaration is unavailable');
        declaration[1] = 999;
      } else if (mutation === 'tag') {
        const declaration = stage.variables[tagId];
        if (!declaration || typeof declaration[1] !== 'string') {
          throw new Error('tag declaration is unavailable');
        }
        declaration[1] += '!';
      } else {
        const declaration = stage.variables[mutation === 'value-name' ? scoreId : tagId];
        if (!declaration) throw new Error('protected declaration is unavailable');
        const name = declaration[0];
        if (typeof name !== 'string') throw new Error('protected name is unavailable');
        declaration[0] = `${name}!`;
      }
      validateProject(project);

      const vm = await loadVm(project);
      try {
        vm.start();
        vm.greenFlag();
        step(vm, 20);
        const runtime = runtimeStage(vm);
        expect(runtimeListValue(runtime, resultsId)).toEqual([]);
        expect(runtime.variables[breachId]?.value).not.toBe(safeBreach);
        expect(vm.runtime.threads).toHaveLength(0);
      } finally {
        vm.quit();
      }
    },
    30_000
  );

  it('retains independent hat and statement checks when one guard call is removed', async () => {
    const {project, scoreId, resultsId} = gameplayProject();
    const state = protect(project);
    const guardCode = state.guardProcedureCodes.get(0);
    if (!guardCode) throw new Error('gameplay guard code is unavailable');
    const stage = stageOf(project);
    const removable = Object.entries(stage.blocks).find(([, value]) =>
      isScratchBlock(value)
      && value.opcode === 'procedures_call'
      && value.mutation?.['proccode'] === guardCode
      && isDataSetter(stage, value.next)
    );
    if (!removable || !isScratchBlock(removable[1])) throw new Error('statement guard call is unavailable');
    removeStackBlock(stage, removable[0], removable[1]);
    const score = stage.variables[scoreId];
    if (!score) throw new Error('score declaration is unavailable');
    score[1] = 999;
    validateProject(project);

    const vm = await loadVm(project);
    try {
      vm.start();
      vm.greenFlag();
      step(vm, 20);
      expect(runtimeListValue(runtimeStage(vm), resultsId)).toEqual([]);
      expect(vm.runtime.threads).toHaveLength(0);
    } finally {
      vm.quit();
    }
  }, 30_000);

  it('rejects a declaration-ID edit that leaves typed references behind', () => {
    const {project} = gameplayProject();
    const state = protect(project);
    const stage = stageOf(project);
    const tagId = requireFirst(state.integrityVariableIds, 'integrity variable');
    const declaration = stage.variables[tagId];
    if (!declaration) throw new Error('tag declaration is unavailable');
    delete stage.variables[tagId];
    stage.variables[`${tagId}!`] = declaration;

    expect(() => validateProject(project)).toThrow(/variable|reference|missing/u);
  });

  it('falls back for cloud, monitored, dynamically sensed, clone-reachable, and multi-owner state', () => {
    const project = fallbackProject();
    const candidates = collectVariableCandidates(project);
    const reservation = reserveGameplayStateCandidates(project, candidates, generator('fallback'));
    try {
      expect(reservation.candidateKeys.size).toBe(0);
    } finally {
      releaseGameplayStateCandidates(project, reservation);
    }
    expect(project.monitors).toHaveLength(2);
  });
});

function protect(project: ScratchProject): GameplayStateProtectionResult {
  const reservation = reserveGameplayStateCandidates(
    project,
    collectVariableCandidates(project),
    generator('reservation')
  );
  releaseGameplayStateCandidates(project, reservation);
  const selected = selectReservedGameplayStateCandidates(collectVariableCandidates(project), reservation);
  const state = applyGameplayStateProtection(project, generator('state'), selected);
  applyAntiCheatTransform(project, generator('watchdog'), {gameplayState: state});
  return state;
}

function generator(domain: string): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => (index * 29) & 0xff),
    `test:gameplay:${domain}`
  );
}

function gameplayProject(): {project: ScratchProject; scoreId: string; resultsId: string} {
  const project = createFixtureProject();
  const stage = stageOf(project);
  project.targets = [stage];
  project.monitors = [];
  stage.variables = {score: ['score', 0]};
  stage.lists = {results: ['results', []]};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: block('event_whenflagclicked', 'set', null, true),
    set: block(
      'data_setvariableto',
      'change',
      'hat',
      false,
      {VALUE: [1, [4, '7']]},
      {VARIABLE: ['score', 'score']}
    ),
    change: block(
      'data_changevariableby',
      'observe',
      'set',
      false,
      {VALUE: [1, [4, '5']]},
      {VARIABLE: ['score', 'score']}
    ),
    observe: block(
      'data_addtolist',
      null,
      'change',
      false,
      {ITEM: [1, [12, 'score', 'score']]},
      {LIST: ['results', 'results']}
    )
  };
  validateProject(project);
  return {project, scoreId: 'score', resultsId: 'results'};
}

function dispatcherGameplayProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = stageOf(project);
  project.targets = [stage];
  project.monitors = [];
  stage.variables = {score: ['score', 0]};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: block('event_whenflagclicked', 'set-1', null, true),
    'set-1': block(
      'data_setvariableto',
      'set-2',
      'hat',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['score', 'score']}
    ),
    'set-2': block(
      'data_setvariableto',
      'set-3',
      'set-1',
      false,
      {VALUE: [1, [4, '2']]},
      {VARIABLE: ['score', 'score']}
    ),
    'set-3': block(
      'data_setvariableto',
      'set-4',
      'set-2',
      false,
      {VALUE: [1, [4, '3']]},
      {VARIABLE: ['score', 'score']}
    ),
    'set-4': block(
      'data_setvariableto',
      null,
      'set-3',
      false,
      {VALUE: [1, [4, '4']]},
      {VARIABLE: ['score', 'score']}
    )
  };
  validateProject(project);
  return project;
}

function fallbackProject(): ScratchProject {
  const project = gameplayProject().project;
  const stage = stageOf(project);
  stage.variables = {
    cloud: ['cloud', 0, true],
    monitored: ['monitored', 0],
    sensed: ['sensed', 0],
    shared: ['shared', 0],
    cloned: ['cloned', 0]
  };
  project.monitors = [monitor('monitored', 'monitored'), sensingMonitor('sensed')];
  const sprite = structuredClone(stage);
  sprite.isStage = false;
  sprite.name = 'Sprite';
  sprite.variables = {};
  sprite.lists = {};
  sprite.blocks = {
    first: block('event_whenflagclicked', 'shared-one', null, true),
    'shared-one': block(
      'data_setvariableto',
      null,
      'first',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['shared', 'shared']}
    ),
    second: block('event_whenkeypressed', 'shared-two', null, true, {}, {KEY_OPTION: ['space', null]}),
    'shared-two': block(
      'data_changevariableby',
      null,
      'second',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['shared', 'shared']}
    ),
    clone: block('control_start_as_clone', 'clone-write', null, true),
    'clone-write': block(
      'data_setvariableto',
      null,
      'clone',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['cloned', 'cloned']}
    )
  };
  stage.blocks = {
    sensed: block(
      'sensing_of',
      null,
      null,
      true,
      {OBJECT: [1, [10, '_stage_']]},
      {PROPERTY: ['sensed']}
    )
  };
  project.targets.push(sprite);
  return project;
}

function spriteStringProject(): {project: ScratchProject; valueId: string; resultsId: string} {
  const project = createFixtureProject();
  const stage = stageOf(project);
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture sprite is unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.blocks = {};
  stage.broadcasts = {};
  stage.comments = {};
  sprite.name = 'Sprite';
  sprite.variables = {value: ['value', 'Å🙂']};
  sprite.lists = {results: ['results', []]};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: block('event_whenflagclicked', 'set', null, true),
    set: block(
      'data_setvariableto',
      'observe',
      'hat',
      false,
      {VALUE: [1, [10, ' MiXeD 🙂 ']]},
      {VARIABLE: ['value', 'value']}
    ),
    observe: block(
      'data_addtolist',
      null,
      'set',
      false,
      {ITEM: [1, [12, 'value', 'value']]},
      {LIST: ['results', 'results']}
    )
  };
  project.monitors = [];
  validateProject(project);
  return {project, valueId: 'value', resultsId: 'results'};
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

function monitor(id: string, name: string): Record<string, JsonValue> {
  return {
    id,
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: name},
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
  };
}

function sensingMonitor(property: string): Record<string, JsonValue> {
  return {
    ...monitor('sensing-monitor', property),
    opcode: 'sensing_of',
    params: {PROPERTY: property, OBJECT: '_stage_'}
  };
}

function isDataSetter(target: ScratchTarget, id: string | null): boolean {
  const value = id === null ? undefined : target.blocks[id];
  return isScratchBlock(value) && value.opcode === 'data_setvariableto';
}

function removeStackBlock(target: ScratchTarget, id: string, value: ScratchBlock): void {
  const parent = value.parent ? target.blocks[value.parent] : undefined;
  if (!isScratchBlock(parent)) throw new Error('removable guard parent is unavailable');
  if (parent.next === id) parent.next = value.next;
  else {
    const input = Object.values(parent.inputs).find(candidate => candidate[1] === id);
    if (!input) throw new Error('removable guard edge is unavailable');
    input[1] = value.next;
  }
  if (value.next) {
    const successor = target.blocks[value.next];
    if (!isScratchBlock(successor)) throw new Error('removable guard successor is unavailable');
    successor.parent = value.parent;
  }
  delete target.blocks[id];
}

async function loadVm(project: ScratchProject): Promise<ScratchVmInstance> {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  await vm.loadProject(createFixtureArchive(project));
  return vm;
}

function runtimeStage(vm: ScratchVmInstance): RuntimeTarget {
  const stage = vm.runtime.targets.find(target => target.isStage);
  if (!stage) throw new Error('runtime Stage is unavailable');
  return stage;
}

function runtimeListValue(stage: RuntimeTarget, id: string): unknown {
  return stage.variables[id]?.value;
}

function step(vm: ScratchVmInstance, count: number): void {
  for (let index = 0; index < count && vm.runtime.threads.length > 0; index += 1) vm.runtime._step();
}

function requireFirst(values: readonly string[], label: string): string {
  const value = values[0];
  if (!value) throw new Error(`${label} is unavailable`);
  return value;
}

function requirePairSecret(state: GameplayStateProtectionResult, valueId: string): string {
  const pair = state.integrityPairs.find(candidate => candidate.valueId === valueId);
  if (!pair) throw new Error('integrity pair is unavailable');
  return pair.secret;
}

function opcodeCount(project: ScratchProject, opcode: string): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (isScratchBlock(value) && value.opcode === opcode) count += 1;
    }
  }
  return count;
}
