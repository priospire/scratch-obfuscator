import type {DeterministicGenerator} from '../deterministic.js';
import {isScratchBlock, stageOf} from '../model/blocks.js';
import {isRecord, orderedDictionary} from '../model/json.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject} from '../types.js';

export const ANTI_CHEAT_WATERMARK_NAME = 'Obfuscated by PrioSDK Gen 4.';
export const ANTI_CHEAT_DECOY_COUNT = 6;

const TOKEN_ALPHABET = '!#$%*+-./:;=?@^_~';
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXTENSION_HAT_OPCODES = new Set([
  'boost_whenColor',
  'boost_whenTilted',
  'ev3_whenBrightnessLessThan',
  'ev3_whenButtonPressed',
  'ev3_whenDistanceLessThan',
  'faceSensing_whenFaceDetected',
  'faceSensing_whenSpriteTouchesPart',
  'faceSensing_whenTilted',
  'gdxfor_whenForcePushedOrPulled',
  'gdxfor_whenGesture',
  'gdxfor_whenTilted',
  'makeymakey_whenCodePressed',
  'makeymakey_whenMakeyKeyPressed',
  'microbit_whenButtonPressed',
  'microbit_whenGesture',
  'microbit_whenPinConnected',
  'microbit_whenTilted',
  'videoSensing_whenMotionGreaterThan',
  'wedo2_whenDistance',
  'wedo2_whenTilted'
]);

interface Sentinel {
  readonly id: string;
  readonly name: string;
  readonly expected: string | 0;
}

interface GuardedHatSite {
  readonly targetIndex: number;
  readonly hatId: string;
}

interface MismatchConditionGraph {
  readonly blocks: ReadonlyMap<string, ScratchBlock>;
  readonly rootId: string;
}

export interface WatermarkTransformResult {
  readonly watermarkVariableId: string;
  readonly watermarkCreated: boolean;
}

export interface AntiCheatTransformResult {
  readonly watermarkVariableId: string;
  readonly watermarkCreated: boolean;
  readonly decoyVariableIds: readonly string[];
  readonly latchVariableId: string;
  readonly watchdogHatId: string;
  readonly guardedHatCount: number;
  readonly guardProcedureCount: number;
  readonly generatedBlockCount: number;
}

function uniqueId(
  generator: DeterministicGenerator,
  prefix: string,
  occupied: Set<string>
): string {
  for (;;) {
    const candidate = generator.id(prefix, 24);
    if (occupied.has(candidate) || RESERVED_KEYS.has(candidate)) continue;
    occupied.add(candidate);
    return candidate;
  }
}

function uniqueName(generator: DeterministicGenerator, occupied: Set<string>): string {
  for (;;) {
    const candidate = generator.id('x_', 36);
    if (occupied.has(candidate)) continue;
    occupied.add(candidate);
    return candidate;
  }
}

function uniqueToken(generator: DeterministicGenerator, occupied: Set<string>): string {
  for (;;) {
    let candidate = '';
    for (let index = 0; index < 32; index += 1) {
      candidate += TOKEN_ALPHABET[generator.integer(TOKEN_ALPHABET.length)];
    }
    if (occupied.has(candidate)) continue;
    occupied.add(candidate);
    return candidate;
  }
}

function collectOccupiedIds(project: ScratchProject): Set<string> {
  const occupied = new Set<string>();
  for (const target of project.targets) {
    for (const dictionary of [target.variables, target.lists, target.broadcasts, target.blocks]) {
      for (const id of Object.keys(dictionary)) occupied.add(id);
    }
  }
  return occupied;
}

function collectOccupiedNames(project: ScratchProject): Set<string> {
  const occupied = new Set<string>([ANTI_CHEAT_WATERMARK_NAME]);
  for (const target of project.targets) {
    occupied.add(target.name);
    for (const declaration of Object.values(target.variables)) {
      if (typeof declaration[0] === 'string') occupied.add(declaration[0]);
    }
    for (const declaration of Object.values(target.lists)) {
      if (typeof declaration[0] === 'string') occupied.add(declaration[0]);
    }
    for (const name of Object.values(target.broadcasts)) occupied.add(name);
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      const sensingProperty = value.opcode === 'sensing_of' ? value.fields['PROPERTY']?.[0] : undefined;
      if (typeof sensingProperty === 'string') occupied.add(sensingProperty);
      const proccode = value.mutation?.['proccode'];
      if (typeof proccode === 'string') occupied.add(proccode);
    }
  }
  for (const monitor of project.monitors) {
    if (monitor['opcode'] !== 'sensing_of') continue;
    const params = monitor['params'];
    if (isRecord(params) && typeof params['PROPERTY'] === 'string') occupied.add(params['PROPERTY']);
  }
  return occupied;
}

function collectGuardedHatSites(project: ScratchProject): GuardedHatSite[] {
  const sites: GuardedHatSite[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [hatId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || !value.topLevel) continue;
      if (value.opcode.startsWith('event_when') || value.opcode === 'control_start_as_clone' ||
          EXTENSION_HAT_OPCODES.has(value.opcode)) {
        sites.push({targetIndex, hatId});
      }
    }
  }
  return sites;
}

function existingStageWatermark(project: ScratchProject): string | undefined {
  const stage = stageOf(project);
  for (const [id, declaration] of Object.entries(stage.variables)) {
    if (declaration[0] === ANTI_CHEAT_WATERMARK_NAME) return id;
  }
  return undefined;
}

/** Add or reuse the exact Stage watermark without changing existing declarations. */
export function applyWatermarkTransform(
  project: ScratchProject,
  generator: DeterministicGenerator
): WatermarkTransformResult {
  const stage = stageOf(project);
  const existing = existingStageWatermark(project);
  if (existing) {
    return Object.freeze({watermarkVariableId: existing, watermarkCreated: false});
  }

  const watermarkVariableId = uniqueId(generator.fork('variable-id'), 'v_', collectOccupiedIds(project));
  const variables = orderedDictionary<JsonValue[]>();
  for (const [id, declaration] of Object.entries(stage.variables)) variables[id] = declaration;
  variables[watermarkVariableId] = [ANTI_CHEAT_WATERMARK_NAME, 0];
  stage.variables = variables;
  return Object.freeze({watermarkVariableId, watermarkCreated: true});
}

function textInput(value: string): JsonValue[] {
  return [1, [10, value]];
}

function sentinelReporterInput(sentinel: Pick<Sentinel, 'id' | 'name'>): ScratchInput {
  return [1, [12, sentinel.name, sentinel.id]];
}

function makeEncodedExpectedValue(
  parent: string,
  expected: string | 0,
  generator: DeterministicGenerator
): ScratchBlock {
  if (typeof expected === 'string') {
    const split = 1 + generator.integer(expected.length - 1);
    return {
      opcode: 'operator_join',
      next: null,
      parent,
      inputs: {
        STRING1: [1, [10, expected.slice(0, split)]],
        STRING2: [1, [10, expected.slice(split)]]
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
  }

  const mask = 1 + generator.integer(0x00ff_ffff);
  return {
    opcode: 'operator_subtract',
    next: null,
    parent,
    inputs: {NUM1: [1, [4, mask]], NUM2: [1, [4, mask]]},
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function combineMismatchRoots(
  blocks: Map<string, ScratchBlock>,
  roots: readonly string[],
  allocateBlock: () => string,
  generator: DeterministicGenerator
): string {
  const ordered = generator.fork('leaf-order').shuffle(roots);
  if (ordered.length === 0) throw new Error('anti-cheat condition construction failed');
  const connect = (left: string, right: string): string => {
    const orId = allocateBlock();
    const leftBlock = blocks.get(left);
    const rightBlock = blocks.get(right);
    if (!leftBlock || !rightBlock) throw new Error('anti-cheat condition construction failed');
    leftBlock.parent = orId;
    rightBlock.parent = orId;
    blocks.set(orId, {
      opcode: 'operator_or',
      next: null,
      parent: null,
      inputs: {OPERAND1: [2, left], OPERAND2: [2, right]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    return orId;
  };

  const template = generator.fork('tree-template').integer(3);
  if (template === 1) {
    const first = ordered[0];
    if (!first) throw new Error('anti-cheat condition construction failed');
    let root = first;
    for (const next of ordered.slice(1)) root = connect(root, next);
    return root;
  }
  if (template === 2) {
    const last = ordered[ordered.length - 1];
    if (!last) throw new Error('anti-cheat condition construction failed');
    let root = last;
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      const next = ordered[index];
      if (!next) throw new Error('anti-cheat condition construction failed');
      root = connect(next, root);
    }
    return root;
  }

  let level = ordered;
  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!left) continue;
      nextLevel.push(right ? connect(left, right) : left);
    }
    level = nextLevel;
  }
  const root = level[0];
  if (!root) throw new Error('anti-cheat condition construction failed');
  return root;
}

function buildMismatchCondition(
  sentinels: readonly Sentinel[],
  allocateBlock: () => string,
  generator: DeterministicGenerator
): MismatchConditionGraph {
  const blocks = new Map<string, ScratchBlock>();
  const conditionRoots: string[] = [];
  for (const sentinel of sentinels) {
    const notId = allocateBlock();
    const equalsId = allocateBlock();
    const expectedId = allocateBlock();
    blocks.set(notId, {
      opcode: 'operator_not',
      next: null,
      parent: null,
      inputs: {OPERAND: [2, equalsId]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(equalsId, {
      opcode: 'operator_equals',
      next: null,
      parent: notId,
      inputs: {OPERAND1: sentinelReporterInput(sentinel), OPERAND2: [2, expectedId]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(
      expectedId,
      makeEncodedExpectedValue(equalsId, sentinel.expected, generator.fork(`expectation:${sentinel.id}`))
    );
    conditionRoots.push(notId);
  }
  const rootId = combineMismatchRoots(blocks, conditionRoots, allocateBlock, generator);
  if (!rootId || !blocks.has(rootId)) throw new Error('anti-cheat condition construction failed');
  return {blocks, rootId};
}

function prependGeneratedBlocks(
  project: ScratchProject,
  generated: ReadonlyMap<string, ScratchBlock>
): void {
  const stage = stageOf(project);
  const blocks = orderedDictionary<typeof stage.blocks[string]>();
  for (const [id, block] of generated) blocks[id] = block;
  for (const [id, block] of Object.entries(stage.blocks)) blocks[id] = block;
  stage.blocks = blocks;
}

function instrumentGuardedHats(
  project: ScratchProject,
  sites: readonly GuardedHatSite[],
  sentinels: readonly Sentinel[],
  latch: Sentinel,
  trippedLatchValue: string,
  allocateBlock: () => string,
  names: DeterministicGenerator,
  conditions: DeterministicGenerator,
  occupiedNames: Set<string>
): {readonly generatedBlocks: number; readonly procedures: number} {
  const byTarget = new Map<number, GuardedHatSite[]>();
  for (const site of sites) {
    const targetSites = byTarget.get(site.targetIndex) ?? [];
    targetSites.push(site);
    byTarget.set(site.targetIndex, targetSites);
  }

  let generatedBlocks = 0;
  for (const [targetIndex, targetSites] of byTarget) {
    const target = project.targets[targetIndex];
    if (!target) throw new Error('anti-cheat guarded target is unavailable');
    const proccode = uniqueName(names, occupiedNames);
    const definitionId = allocateBlock();
    const prototypeId = allocateBlock();
    const guardId = allocateBlock();
    const setLatchId = allocateBlock();
    const stopId = allocateBlock();
    const condition = buildMismatchCondition(
      sentinels,
      allocateBlock,
      conditions.fork(`target:${targetIndex}`)
    );
    const conditionRoot = condition.blocks.get(condition.rootId);
    if (!conditionRoot) throw new Error('anti-cheat condition construction failed');
    conditionRoot.parent = guardId;

    target.blocks[definitionId] = {
      opcode: 'procedures_definition',
      next: guardId,
      parent: null,
      inputs: {custom_block: [1, prototypeId]},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0
    };
    target.blocks[prototypeId] = {
      opcode: 'procedures_prototype',
      next: null,
      parent: definitionId,
      inputs: {},
      fields: {},
      shadow: true,
      topLevel: false,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode,
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        warp: 'true'
      }
    };
    target.blocks[guardId] = {
      opcode: 'control_if',
      next: null,
      parent: definitionId,
      inputs: {CONDITION: [2, condition.rootId], SUBSTACK: [2, setLatchId]},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[setLatchId] = {
      opcode: 'data_setvariableto',
      next: stopId,
      parent: guardId,
      inputs: {VALUE: textInput(trippedLatchValue)},
      fields: {VARIABLE: [latch.name, latch.id]},
      shadow: false,
      topLevel: false
    };
    target.blocks[stopId] = {
      opcode: 'control_stop',
      next: null,
      parent: setLatchId,
      inputs: {},
      fields: {STOP_OPTION: ['all', null]},
      shadow: false,
      topLevel: false,
      mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
    };
    for (const [id, block] of condition.blocks) target.blocks[id] = block;
    generatedBlocks += 5 + condition.blocks.size;

    for (const site of targetSites) {
      const hat = target.blocks[site.hatId];
      if (!hat || !isScratchBlock(hat)) throw new Error('anti-cheat guarded hat is unavailable');
      const originalNext = hat.next;
      const callId = allocateBlock();
      target.blocks[callId] = {
        opcode: 'procedures_call',
        next: originalNext,
        parent: site.hatId,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: false,
        mutation: {
          tagName: 'mutation',
          children: [],
          proccode,
          argumentids: '[]',
          warp: 'true'
        }
      };
      if (originalNext) {
        const successor = target.blocks[originalNext];
        if (!successor || !isScratchBlock(successor)) throw new Error('anti-cheat guarded continuation is unavailable');
        successor.parent = callId;
      }
      hat.next = callId;
      generatedBlocks += 1;
    }
  }
  return {generatedBlocks, procedures: byTarget.size};
}

/**
 * Add a Stage-scoped, non-cloud tamper watchdog. The caller supplies a dedicated
 * deterministic generator domain and invokes this after the selected mode's passes.
 */
export function applyAntiCheatTransform(
  project: ScratchProject,
  generator: DeterministicGenerator
): AntiCheatTransformResult {
  const guardedHatSites = collectGuardedHatSites(project);
  const stage = stageOf(project);
  const watermark = applyWatermarkTransform(project, generator.fork('watermark'));
  const occupiedIds = collectOccupiedIds(project);
  const occupiedNames = collectOccupiedNames(project);
  const occupiedTokens = new Set<string>();
  const variableIds = generator.fork('variable-ids');
  const blockIds = generator.fork('block-ids');
  const names = generator.fork('variable-names');

  const additions: Array<readonly [string, JsonValue[]]> = [];
  let watermarkSentinel: Sentinel | undefined;
  if (watermark.watermarkCreated) {
    watermarkSentinel = {
      id: watermark.watermarkVariableId,
      name: ANTI_CHEAT_WATERMARK_NAME,
      expected: 0
    };
  }

  const decoys: Sentinel[] = [];
  for (let index = 0; index < ANTI_CHEAT_DECOY_COUNT; index += 1) {
    const id = uniqueId(variableIds, 'v_ac_', occupiedIds);
    const name = uniqueName(names, occupiedNames);
    const expected = uniqueToken(generator.fork(`decoy-value:${index}`), occupiedTokens);
    decoys.push({id, name, expected});
    additions.push([id, [name, expected]]);
  }

  const latchVariableId = uniqueId(variableIds, 'v_ac_', occupiedIds);
  const latchName = uniqueName(names, occupiedNames);
  const safeLatchValue = uniqueToken(generator.fork('latch-safe-value'), occupiedTokens);
  const trippedLatchValue = uniqueToken(generator.fork('latch-tripped-value'), occupiedTokens);
  const latchSentinel: Sentinel = {id: latchVariableId, name: latchName, expected: safeLatchValue};
  additions.push([latchVariableId, [latchName, safeLatchValue]]);

  const nextVariables = orderedDictionary<JsonValue[]>();
  for (const [id, declaration] of Object.entries(stage.variables)) nextVariables[id] = declaration;
  for (const [id, declaration] of additions) nextVariables[id] = declaration;

  const generated = new Map<string, ScratchBlock>();
  const allocateBlock = (): string => uniqueId(blockIds, 'b_ac_', occupiedIds);
  const hatId = allocateBlock();
  const foreverId = allocateBlock();
  const guardId = allocateBlock();
  const setLatchId = allocateBlock();
  const stopId = allocateBlock();

  generated.set(hatId, {
    opcode: 'event_whenflagclicked',
    next: foreverId,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  });
  generated.set(foreverId, {
    opcode: 'control_forever',
    next: null,
    parent: hatId,
    inputs: {SUBSTACK: [2, guardId]},
    fields: {},
    shadow: false,
    topLevel: false
  });
  generated.set(guardId, {
    opcode: 'control_if',
    next: null,
    parent: foreverId,
    inputs: {CONDITION: [2, null], SUBSTACK: [2, setLatchId]},
    fields: {},
    shadow: false,
    topLevel: false
  });
  generated.set(setLatchId, {
    opcode: 'data_setvariableto',
    next: stopId,
    parent: guardId,
    inputs: {VALUE: textInput(trippedLatchValue)},
    fields: {VARIABLE: [latchName, latchVariableId]},
    shadow: false,
    topLevel: false
  });
  generated.set(stopId, {
    opcode: 'control_stop',
    next: null,
    parent: setLatchId,
    inputs: {},
    fields: {STOP_OPTION: ['all', null]},
    shadow: false,
    topLevel: false,
    mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
  });

  const conditionRoots: string[] = [];
  const mismatchSentinels = watermarkSentinel
    ? [watermarkSentinel, ...decoys, latchSentinel]
    : [...decoys, latchSentinel];
  for (const sentinel of mismatchSentinels) {
    const notId = allocateBlock();
    const equalsId = allocateBlock();
    const expectedId = allocateBlock();
    generated.set(notId, {
      opcode: 'operator_not',
      next: null,
      parent: null,
      inputs: {OPERAND: [2, equalsId]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    generated.set(equalsId, {
      opcode: 'operator_equals',
      next: null,
      parent: notId,
      inputs: {OPERAND1: sentinelReporterInput(sentinel), OPERAND2: [2, expectedId]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    generated.set(
      expectedId,
      makeEncodedExpectedValue(
        equalsId,
        sentinel.expected,
        generator.fork(`watchdog-expectation:${sentinel.id}`)
      )
    );
    conditionRoots.push(notId);
  }
  const conditionRoot = combineMismatchRoots(
    generated,
    conditionRoots,
    allocateBlock,
    generator.fork('condition-order')
  );
  const conditionBlock = conditionRoot ? generated.get(conditionRoot) : undefined;
  const guard = generated.get(guardId);
  if (!conditionRoot || !conditionBlock || !guard) throw new Error('anti-cheat condition construction failed');
  conditionBlock.parent = guardId;
  guard.inputs['CONDITION'] = [2, conditionRoot];

  stage.variables = nextVariables;
  const guarded = instrumentGuardedHats(
    project,
    guardedHatSites,
    mismatchSentinels,
    latchSentinel,
    trippedLatchValue,
    allocateBlock,
    generator.fork('event-guard-names'),
    generator.fork('event-guard-conditions'),
    occupiedNames
  );
  prependGeneratedBlocks(project, generated);

  return Object.freeze({
    watermarkVariableId: watermark.watermarkVariableId,
    watermarkCreated: watermark.watermarkCreated,
    decoyVariableIds: Object.freeze(decoys.map(decoy => decoy.id)),
    latchVariableId,
    watchdogHatId: hatId,
    guardedHatCount: guardedHatSites.length,
    guardProcedureCount: guarded.procedures,
    generatedBlockCount: generated.size + guarded.generatedBlocks
  });
}
