import type {DeterministicGenerator} from '../deterministic.js';
import {isScratchBlock, stageOf} from '../model/blocks.js';
import {isRecord, orderedDictionary} from '../model/json.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import type {VariableCandidate} from './analysis.js';

export const ANTI_CHEAT_WATERMARK_NAME = 'Obfuscated by PrioSDK Gen 4.';
export const ANTI_CHEAT_DECOY_COUNT = 7;

const MAX_PROTECTED_GAMEPLAY_VARIABLES = 16;
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
  readonly expected: boolean | number | string;
}

export interface GameplayIntegrityPair {
  readonly declarationTargetIndex: number;
  readonly valueId: string;
  readonly valueName: string;
  readonly tagId: string;
  readonly tagName: string;
  readonly secret: string;
  readonly selector: string;
  readonly usageTargetIndex: number;
  readonly groupSize: number;
  readonly groupPosition: number;
  readonly nextValueId?: string;
  readonly nextValueName?: string;
  readonly linkSecret?: string;
}

interface GameplayPairPlan {
  readonly candidate: VariableCandidate;
  readonly originalIndex: number;
  readonly declarationTarget: ScratchTarget;
  readonly usageTarget: ScratchTarget;
  readonly usageTargetIndex: number;
  readonly tagId: string;
  readonly tagName: string;
  readonly secret: string;
  next?: GameplayPairPlan;
  predecessor?: GameplayPairPlan;
  linkSecret?: string;
  groupSize: number;
  groupPosition: number;
  pair?: GameplayIntegrityPair;
}

export interface GameplayStateReservation {
  readonly candidateKeys: ReadonlySet<string>;
  readonly markerMonitors: readonly Record<string, JsonValue>[];
}

export interface GameplayStateProtectionResult {
  readonly protectedVariableIds: readonly string[];
  readonly integrityVariableIds: readonly string[];
  readonly breachVariableId?: string;
  readonly generatedBlockCount: number;
  readonly integrityPairs: readonly GameplayIntegrityPair[];
  readonly guardProcedureCodes: ReadonlyMap<number, string>;
  readonly tripSentinel?: Sentinel;
}

export interface AntiCheatTransformOptions {
  readonly gameplayState?: GameplayStateProtectionResult;
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

function gameplayCandidateKey(targetIndex: number, id: string): string {
  return `${targetIndex}\u0000${id}`;
}

function isSupportedScalar(value: JsonValue): value is boolean | number | string {
  return typeof value === 'boolean'
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function topLevelRoot(target: ScratchTarget, startId: string): string | undefined {
  const visited = new Set<string>();
  let currentId = startId;
  for (;;) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const current = target.blocks[currentId];
    if (!isScratchBlock(current)) return undefined;
    if (current.parent === null) return current.topLevel ? currentId : undefined;
    currentId = current.parent;
  }
}

function statementContaining(target: ScratchTarget, startId: string): string | undefined {
  const visited = new Set<string>();
  let currentId = startId;
  for (;;) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const current = target.blocks[currentId];
    if (!isScratchBlock(current)) return undefined;
    const parentId = current.parent;
    if (parentId === null) return undefined;
    const parent = target.blocks[parentId];
    if (!isScratchBlock(parent)) return undefined;
    if (parent.next === currentId) return currentId;
    const stackInput = Object.entries(parent.inputs).find(([inputName, input]) =>
      inputName.startsWith('SUBSTACK') && input[1] === currentId
    );
    if (stackInput) return currentId;
    currentId = parentId;
  }
}

function projectHasCloneSurface(project: ScratchProject): boolean {
  return project.targets.some(target => Object.values(target.blocks).some(value =>
    isScratchBlock(value) && (
      value.opcode === 'control_create_clone_of'
      || value.opcode === 'control_delete_this_clone'
      || value.opcode === 'control_start_as_clone'
    )
  ));
}

function isGameplayProtectionCandidate(
  project: ScratchProject,
  candidate: VariableCandidate
): boolean {
  const declarationTarget = project.targets[candidate.targetIndex];
  const declaration = declarationTarget?.variables[candidate.id];
  if (
    !declarationTarget
    || !declaration
    || declaration[0] !== candidate.name
    || !isSupportedScalar(candidate.initialValue)
    || candidate.usages.length === 0
  ) return false;

  const usageTargets = new Set<number>();
  const roots = new Set<string>();
  let writes = 0;
  for (const usage of candidate.usages) {
    const target = project.targets[usage.targetIndex];
    const block = target?.blocks[usage.blockId];
    if (!target || !isScratchBlock(block) || statementContaining(target, usage.blockId) === undefined) return false;
    usageTargets.add(usage.targetIndex);
    const rootId = topLevelRoot(target, usage.blockId);
    const root = rootId === undefined ? undefined : target.blocks[rootId];
    if (!rootId || !isScratchBlock(root) || root.opcode === 'procedures_definition') return false;
    if (root.opcode === 'control_start_as_clone' || root.opcode === 'event_whenbroadcastreceived') return false;
    roots.add(`${usage.targetIndex}\u0000${rootId}`);
    if (
      usage.kind === 'field'
      && (block.opcode === 'data_setvariableto' || block.opcode === 'data_changevariableby')
    ) writes += 1;
  }
  if (writes === 0 || usageTargets.size !== 1 || roots.size !== 1) return false;

  const usageTargetIndex = usageTargets.values().next().value;
  const usageTarget = usageTargetIndex === undefined ? undefined : project.targets[usageTargetIndex];
  if (!usageTarget) return false;
  if (!usageTarget.isStage && projectHasCloneSurface(project)) return false;
  if (!declarationTarget.isStage && usageTargetIndex !== candidate.targetIndex) return false;
  if (
    !declarationTarget.isStage
    && project.targets.filter(target => !target.isStage && target.name === declarationTarget.name).length !== 1
  ) return false;
  return true;
}

/** Select real variables that aggressive packing must leave for anti-tamper protection. */
export function reserveGameplayStateCandidates(
  project: ScratchProject,
  candidates: readonly VariableCandidate[],
  generator: DeterministicGenerator
): GameplayStateReservation {
  const eligible = generator.fork('candidate-order').shuffle(
    candidates.filter(candidate => isGameplayProtectionCandidate(project, candidate))
  );
  eligible.sort((left, right) => right.usages.length - left.usages.length);
  const selected = eligible.slice(0, MAX_PROTECTED_GAMEPLAY_VARIABLES);
  const candidateKeys = new Set(selected.map(candidate => gameplayCandidateKey(candidate.targetIndex, candidate.id)));
  return Object.freeze({candidateKeys, markerMonitors: Object.freeze([])});
}

/** Remove markers emitted by pre-v0.7 reservation objects retained for API compatibility. */
export function releaseGameplayStateCandidates(
  project: ScratchProject,
  reservation: GameplayStateReservation
): void {
  if (reservation.markerMonitors.length === 0) return;
  const markers = new Set(reservation.markerMonitors);
  project.monitors = project.monitors.filter(monitor => !markers.has(monitor));
}

export function selectReservedGameplayStateCandidates(
  candidates: readonly VariableCandidate[],
  reservation: GameplayStateReservation
): VariableCandidate[] {
  return candidates.filter(candidate => reservation.candidateKeys.has(
    gameplayCandidateKey(candidate.targetIndex, candidate.id)
  ));
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

function scratchScalarString(value: boolean | number | string): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

function integrityTagValue(
  pair: GameplayIntegrityPair,
  ownValue: boolean | number | string,
  nextValue?: boolean | number | string
): string {
  if (pair.nextValueId === undefined) return pair.secret + scratchScalarString(ownValue);
  if (pair.linkSecret === undefined || nextValue === undefined) {
    throw new Error('anti-cheat linked gameplay integrity metadata is unavailable');
  }
  const own = scratchScalarString(ownValue);
  return pair.secret
    + String(own.length)
    + ':'
    + own
    + pair.linkSecret
    + scratchScalarString(nextValue);
}

function procedureMutation(proccode: string): Record<string, JsonValue> {
  return {
    tagName: 'mutation',
    children: [],
    proccode,
    argumentids: '[]',
    argumentnames: '[]',
    argumentdefaults: '[]',
    warp: 'true'
  };
}

function procedureCall(
  parent: string,
  next: string | null,
  proccode: string
): ScratchBlock {
  return {
    opcode: 'procedures_call',
    next,
    parent,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: false,
    mutation: procedureMutation(proccode)
  };
}

function makeVariableSetter(
  parent: string,
  next: string | null,
  id: string,
  name: string,
  value: ScratchInput
): ScratchBlock {
  return {
    opcode: 'data_setvariableto',
    next,
    parent,
    inputs: {VALUE: value},
    fields: {VARIABLE: [name, id]},
    shadow: false,
    topLevel: false
  };
}

function makeSensingOf(parent: string, property: string, selector: string): ScratchBlock {
  return {
    opcode: 'sensing_of',
    next: null,
    parent,
    inputs: {OBJECT: [1, [10, selector]]},
    fields: {PROPERTY: [property]},
    shadow: false,
    topLevel: false
  };
}

function buildIntegrityMismatchCondition(
  pair: GameplayIntegrityPair,
  allocateBlock: () => string,
  generator: DeterministicGenerator,
  useSensing: boolean
): MismatchConditionGraph {
  const blocks = new Map<string, ScratchBlock>();
  const notId = allocateBlock();
  const equalsId = allocateBlock();
  const expectedId = allocateBlock();
  const secretId = allocateBlock();
  const linked = pair.nextValueId !== undefined;
  if (linked && (pair.nextValueName === undefined || pair.linkSecret === undefined)) {
    throw new Error('anti-cheat linked gameplay integrity metadata is unavailable');
  }
  const ownJoinId = linked ? allocateBlock() : undefined;
  const linkJoinId = linked ? allocateBlock() : undefined;
  const linkSecretId = linked ? allocateBlock() : undefined;
  const valueSenseId = useSensing ? allocateBlock() : undefined;
  const nextValueSenseId = useSensing && linked ? allocateBlock() : undefined;
  const tagSenseId = useSensing ? allocateBlock() : undefined;
  const bodyId = linked ? allocateBlock() : undefined;
  const lengthPrefixId = linked ? allocateBlock() : undefined;
  const lengthId = linked ? allocateBlock() : undefined;
  const valueLengthSenseId = useSensing && linked ? allocateBlock() : undefined;
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
    inputs: {
      OPERAND1: useSensing && tagSenseId
        ? [2, tagSenseId]
        : sentinelReporterInput({id: pair.tagId, name: pair.tagName}),
      OPERAND2: [2, expectedId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  });
  blocks.set(expectedId, {
    opcode: 'operator_join',
    next: null,
    parent: equalsId,
    inputs: {
      STRING1: [2, secretId],
      STRING2: bodyId
        ? [2, bodyId]
        : useSensing && valueSenseId
          ? [2, valueSenseId]
          : sentinelReporterInput({id: pair.valueId, name: pair.valueName})
    },
    fields: {},
    shadow: false,
    topLevel: false
  });
  blocks.set(
    secretId,
    makeEncodedExpectedValue(expectedId, pair.secret, generator.fork('secret'))
  );
  if (
    bodyId
    && lengthPrefixId
    && lengthId
    && ownJoinId
    && linkJoinId
    && linkSecretId
    && pair.nextValueId
    && pair.nextValueName
    && pair.linkSecret
  ) {
    blocks.set(bodyId, {
      opcode: 'operator_join',
      next: null,
      parent: expectedId,
      inputs: {STRING1: [2, lengthPrefixId], STRING2: [2, ownJoinId]},
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(lengthPrefixId, {
      opcode: 'operator_join',
      next: null,
      parent: bodyId,
      inputs: {STRING1: [2, lengthId], STRING2: textInput(':')},
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(lengthId, {
      opcode: 'operator_length',
      next: null,
      parent: lengthPrefixId,
      inputs: {
        STRING: useSensing && valueLengthSenseId
          ? [2, valueLengthSenseId]
          : sentinelReporterInput({id: pair.valueId, name: pair.valueName})
      },
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(ownJoinId, {
      opcode: 'operator_join',
      next: null,
      parent: bodyId,
      inputs: {
        STRING1: useSensing && valueSenseId
          ? [2, valueSenseId]
          : sentinelReporterInput({id: pair.valueId, name: pair.valueName}),
        STRING2: [2, linkJoinId]
      },
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(linkJoinId, {
      opcode: 'operator_join',
      next: null,
      parent: ownJoinId,
      inputs: {
        STRING1: [2, linkSecretId],
        STRING2: useSensing && nextValueSenseId
          ? [2, nextValueSenseId]
          : sentinelReporterInput({id: pair.nextValueId, name: pair.nextValueName})
      },
      fields: {},
      shadow: false,
      topLevel: false
    });
    blocks.set(
      linkSecretId,
      makeEncodedExpectedValue(linkJoinId, pair.linkSecret, generator.fork('link-secret'))
    );
  }
  if (valueSenseId && tagSenseId) {
    blocks.set(valueSenseId, makeSensingOf(ownJoinId ?? expectedId, pair.valueName, pair.selector));
    if (valueLengthSenseId && lengthId) {
      blocks.set(valueLengthSenseId, makeSensingOf(lengthId, pair.valueName, pair.selector));
    }
    if (nextValueSenseId && linkJoinId && pair.nextValueName) {
      blocks.set(nextValueSenseId, makeSensingOf(linkJoinId, pair.nextValueName, pair.selector));
    }
    blocks.set(tagSenseId, makeSensingOf(equalsId, pair.tagName, pair.selector));
  }
  return {blocks, rootId: notId};
}

function buildNameProbeMismatchCondition(
  property: string,
  selector: string,
  probe: string,
  allocateBlock: () => string,
  generator: DeterministicGenerator
): MismatchConditionGraph {
  const blocks = new Map<string, ScratchBlock>();
  const notId = allocateBlock();
  const equalsId = allocateBlock();
  const sensingId = allocateBlock();
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
    inputs: {OPERAND1: [2, sensingId], OPERAND2: [2, expectedId]},
    fields: {},
    shadow: false,
    topLevel: false
  });
  blocks.set(sensingId, makeSensingOf(equalsId, property, selector));
  blocks.set(expectedId, makeEncodedExpectedValue(equalsId, probe, generator.fork('expectation')));
  return {blocks, rootId: notId};
}

function appendProcedureCommand(
  blocks: Map<string, ScratchBlock>,
  tailId: string,
  commandId: string,
  command: ScratchBlock
): string {
  const tail = blocks.get(tailId);
  if (!tail) throw new Error('anti-cheat procedure tail is unavailable');
  tail.next = commandId;
  command.parent = tailId;
  blocks.set(commandId, command);
  return commandId;
}

function addProcedureShell(
  blocks: Map<string, ScratchBlock>,
  allocateBlock: () => string,
  proccode: string
): {readonly definitionId: string; readonly prototypeId: string} {
  const definitionId = allocateBlock();
  const prototypeId = allocateBlock();
  blocks.set(definitionId, {
    opcode: 'procedures_definition',
    next: null,
    parent: null,
    inputs: {custom_block: [1, prototypeId]},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  });
  blocks.set(prototypeId, {
    opcode: 'procedures_prototype',
    next: null,
    parent: definitionId,
    inputs: {},
    fields: {},
    shadow: true,
    topLevel: false,
    mutation: procedureMutation(proccode)
  });
  return {definitionId, prototypeId};
}

function tripCallBlock(parent: string, proccode: string): ScratchBlock {
  return procedureCall(parent, null, proccode);
}

function appendMismatchGuard(
  blocks: Map<string, ScratchBlock>,
  tailId: string,
  condition: MismatchConditionGraph,
  allocateBlock: () => string,
  tripProccode: string
): string {
  const ifId = allocateBlock();
  const tripCallId = allocateBlock();
  const conditionRoot = condition.blocks.get(condition.rootId);
  if (!conditionRoot) throw new Error('anti-cheat gameplay condition is unavailable');
  conditionRoot.parent = ifId;
  for (const [id, block] of condition.blocks) blocks.set(id, block);
  blocks.set(tripCallId, tripCallBlock(ifId, tripProccode));
  return appendProcedureCommand(blocks, tailId, ifId, {
    opcode: 'control_if',
    next: null,
    parent: tailId,
    inputs: {CONDITION: [2, condition.rootId], SUBSTACK: [2, tripCallId]},
    fields: {},
    shadow: false,
    topLevel: false
  });
}

function insertGuardBeforeStatement(
  target: ScratchTarget,
  statementId: string,
  callId: string,
  proccode: string
): void {
  const statement = target.blocks[statementId];
  if (!isScratchBlock(statement) || statement.parent === null || statement.topLevel) {
    throw new Error('anti-cheat guarded statement is unavailable');
  }
  const parentId = statement.parent;
  const parent = target.blocks[parentId];
  if (!isScratchBlock(parent)) throw new Error('anti-cheat guarded statement parent is unavailable');
  let replaced = false;
  if (parent.next === statementId) {
    parent.next = callId;
    replaced = true;
  } else {
    for (const [inputName, input] of Object.entries(parent.inputs)) {
      if (!inputName.startsWith('SUBSTACK') || input[1] !== statementId) continue;
      input[1] = callId;
      replaced = true;
      break;
    }
  }
  if (!replaced) throw new Error('anti-cheat guarded statement edge is unavailable');
  target.blocks[callId] = procedureCall(parentId, statementId, proccode);
  statement.parent = callId;
}

function makeEncodedExpectedValue(
  parent: string,
  expected: boolean | number | string,
  generator: DeterministicGenerator
): ScratchBlock {
  if (typeof expected === 'string') {
    const split = expected.length < 2 ? expected.length : 1 + generator.integer(expected.length - 1);
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

  if (typeof expected === 'boolean') {
    return {
      opcode: 'operator_equals',
      next: null,
      parent,
      inputs: {
        OPERAND1: textInput(expected ? '1' : '0'),
        OPERAND2: textInput('1')
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
  }

  if (expected !== 0) {
    return {
      opcode: 'operator_multiply',
      next: null,
      parent,
      inputs: {NUM1: [1, [4, expected]], NUM2: [1, [4, 1]]},
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

function emptyGameplayStateProtection(): GameplayStateProtectionResult {
  return Object.freeze({
    protectedVariableIds: Object.freeze([]),
    integrityVariableIds: Object.freeze([]),
    generatedBlockCount: 0,
    integrityPairs: Object.freeze([]),
    guardProcedureCodes: new Map<number, string>()
  });
}

function appendEncodedSetter(
  blocks: Map<string, ScratchBlock>,
  tailId: string,
  setterId: string,
  expectedId: string,
  variableId: string,
  variableName: string,
  value: string,
  generator: DeterministicGenerator
): string {
  blocks.set(expectedId, makeEncodedExpectedValue(setterId, value, generator));
  return appendProcedureCommand(
    blocks,
    tailId,
    setterId,
    makeVariableSetter(tailId, null, variableId, variableName, [2, expectedId])
  );
}

function appendNameProbe(
  blocks: Map<string, ScratchBlock>,
  tailId: string,
  pair: GameplayIntegrityPair,
  probeId: string,
  probeName: string,
  guardedId: string,
  guardedName: string,
  probeValue: string,
  allocateBlock: () => string,
  generator: DeterministicGenerator,
  tripProccode: string
): string {
  const saveId = allocateBlock();
  const setProbeId = allocateBlock();
  const encodedProbeId = allocateBlock();
  const restoreId = allocateBlock();
  let tail = appendProcedureCommand(
    blocks,
    tailId,
    saveId,
    makeVariableSetter(
      tailId,
      null,
      probeId,
      probeName,
      sentinelReporterInput({id: guardedId, name: guardedName})
    )
  );
  tail = appendEncodedSetter(
    blocks,
    tail,
    setProbeId,
    encodedProbeId,
    guardedId,
    guardedName,
    probeValue,
    generator.fork('probe-value')
  );
  const mismatch = buildNameProbeMismatchCondition(
    guardedName,
    pair.selector,
    probeValue,
    allocateBlock,
    generator.fork('name-check')
  );
  tail = appendMismatchGuard(blocks, tail, mismatch, allocateBlock, tripProccode);
  return appendProcedureCommand(
    blocks,
    tail,
    restoreId,
    makeVariableSetter(
      tail,
      null,
      guardedId,
      guardedName,
      sentinelReporterInput({id: probeId, name: probeName})
    )
  );
}

function addGameplayGuardProcedures(
  project: ScratchProject,
  pairs: readonly GameplayIntegrityPair[],
  breach: Sentinel,
  trippedBreachValue: string,
  allocateBlock: () => string,
  allocateVariable: () => string,
  names: DeterministicGenerator,
  conditions: DeterministicGenerator,
  occupiedNames: Set<string>,
  occupiedTokens: Set<string>
): {readonly guardCodes: ReadonlyMap<number, string>; readonly generatedBlocks: number} {
  const byUsageTarget = new Map<number, GameplayIntegrityPair[]>();
  for (const pair of pairs) {
    const targetPairs = byUsageTarget.get(pair.usageTargetIndex) ?? [];
    targetPairs.push(pair);
    byUsageTarget.set(pair.usageTargetIndex, targetPairs);
  }

  const guardCodes = new Map<number, string>();
  let generatedBlocks = 0;
  for (const [targetIndex, targetPairs] of byUsageTarget) {
    const target = project.targets[targetIndex];
    if (!target) throw new Error('anti-cheat gameplay usage target is unavailable');
    const blocks = new Map<string, ScratchBlock>();
    const guardProccode = uniqueName(names.fork(`guard:${targetIndex}`), occupiedNames);
    const tripProccode = uniqueName(names.fork(`trip:${targetIndex}`), occupiedNames);
    const backupId = allocateVariable();
    const backupName = uniqueName(names.fork(`backup:${targetIndex}`), occupiedNames);
    target.variables[backupId] = [backupName, 0];

    const tripShell = addProcedureShell(blocks, allocateBlock, tripProccode);
    const setBreachId = allocateBlock();
    const encodedBreachId = allocateBlock();
    const stopId = allocateBlock();
    let tripTail = appendEncodedSetter(
      blocks,
      tripShell.definitionId,
      setBreachId,
      encodedBreachId,
      breach.id,
      breach.name,
      trippedBreachValue,
      conditions.fork(`trip:${targetIndex}:breach`)
    );
    tripTail = appendProcedureCommand(blocks, tripTail, stopId, {
      opcode: 'control_stop',
      next: null,
      parent: tripTail,
      inputs: {},
      fields: {STOP_OPTION: ['all', null]},
      shadow: false,
      topLevel: false,
      mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
    });
    if (tripTail !== stopId) throw new Error('anti-cheat gameplay trip procedure is malformed');

    const guardShell = addProcedureShell(blocks, allocateBlock, guardProccode);
    let guardTail = guardShell.definitionId;
    for (const [pairIndex, pair] of targetPairs.entries()) {
      guardTail = appendMismatchGuard(
        blocks,
        guardTail,
        buildIntegrityMismatchCondition(
          pair,
          allocateBlock,
          conditions.fork(`pair:${targetIndex}:${pairIndex}:integrity`),
          false
        ),
        allocateBlock,
        tripProccode
      );
      const valueProbe = uniqueToken(
        conditions.fork(`pair:${targetIndex}:${pairIndex}:value-probe`),
        occupiedTokens
      );
      guardTail = appendNameProbe(
        blocks,
        guardTail,
        pair,
        backupId,
        backupName,
        pair.valueId,
        pair.valueName,
        valueProbe,
        allocateBlock,
        conditions.fork(`pair:${targetIndex}:${pairIndex}:value-name`),
        tripProccode
      );
      const tagProbe = uniqueToken(
        conditions.fork(`pair:${targetIndex}:${pairIndex}:tag-probe`),
        occupiedTokens
      );
      guardTail = appendNameProbe(
        blocks,
        guardTail,
        pair,
        backupId,
        backupName,
        pair.tagId,
        pair.tagName,
        tagProbe,
        allocateBlock,
        conditions.fork(`pair:${targetIndex}:${pairIndex}:tag-name`),
        tripProccode
      );
      guardTail = appendMismatchGuard(
        blocks,
        guardTail,
        buildIntegrityMismatchCondition(
          pair,
          allocateBlock,
          conditions.fork(`pair:${targetIndex}:${pairIndex}:final-integrity`),
          false
        ),
        allocateBlock,
        tripProccode
      );
    }
    if (!blocks.has(guardTail)) throw new Error('anti-cheat gameplay guard procedure is malformed');
    for (const [id, block] of blocks) target.blocks[id] = block;
    generatedBlocks += blocks.size;
    guardCodes.set(targetIndex, guardProccode);
  }
  return {guardCodes, generatedBlocks};
}

function cyclicGroupSizes(count: number): number[] {
  const sizes: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    if (remaining === 5) {
      sizes.push(3, 2);
      break;
    }
    const size = remaining > 5 ? 4 : remaining;
    sizes.push(size);
    remaining -= size;
  }
  return sizes;
}

function assignCyclicGameplayGroups(
  plans: readonly GameplayPairPlan[],
  generator: DeterministicGenerator,
  occupiedTokens: Set<string>
): void {
  const scopes = new Map<string, GameplayPairPlan[]>();
  for (const plan of plans) {
    const key = `${plan.candidate.targetIndex}\u0000${plan.usageTargetIndex}`;
    const members = scopes.get(key) ?? [];
    members.push(plan);
    scopes.set(key, members);
  }

  let scopeIndex = 0;
  for (const members of scopes.values()) {
    let offset = 0;
    for (const [groupIndex, size] of cyclicGroupSizes(members.length).entries()) {
      const group = members.slice(offset, offset + size);
      offset += size;
      for (const [position, plan] of group.entries()) {
        plan.groupSize = group.length;
        plan.groupPosition = position;
        if (group.length === 1) continue;
        const next = group[(position + 1) % group.length];
        const predecessor = group[(position + group.length - 1) % group.length];
        if (!next || !predecessor) throw new Error('anti-cheat gameplay integrity group is unavailable');
        plan.next = next;
        plan.predecessor = predecessor;
        plan.linkSecret = uniqueToken(
          generator.fork(`scope:${scopeIndex}:group:${groupIndex}:link:${plan.originalIndex}`),
          occupiedTokens
        );
      }
    }
    scopeIndex += 1;
  }
}

function finalizeGameplayIntegrityPair(plan: GameplayPairPlan): GameplayIntegrityPair {
  const linked = plan.next !== undefined;
  if (linked && plan.linkSecret === undefined) {
    throw new Error('anti-cheat gameplay integrity link is unavailable');
  }
  const pair: GameplayIntegrityPair = Object.freeze({
    declarationTargetIndex: plan.candidate.targetIndex,
    valueId: plan.candidate.id,
    valueName: plan.candidate.name,
    tagId: plan.tagId,
    tagName: plan.tagName,
    secret: plan.secret,
    selector: plan.declarationTarget.isStage ? '_stage_' : plan.declarationTarget.name,
    usageTargetIndex: plan.usageTargetIndex,
    groupSize: plan.groupSize,
    groupPosition: plan.groupPosition,
    ...(plan.next === undefined ? {} : {
      nextValueId: plan.next.candidate.id,
      nextValueName: plan.next.candidate.name,
      linkSecret: plan.linkSecret as string
    })
  });
  plan.pair = pair;
  return pair;
}

function appendIntegrityTagRefresh(
  target: ScratchTarget,
  parentId: string,
  pair: GameplayIntegrityPair,
  allocateBlock: () => string,
  generator: DeterministicGenerator
): {readonly tailId: string; readonly generatedBlocks: number} {
  const parent = target.blocks[parentId];
  if (!isScratchBlock(parent)) throw new Error('anti-cheat gameplay refresh parent is unavailable');
  const setterId = allocateBlock();
  const expectedId = allocateBlock();
  const secretId = allocateBlock();
  const linked = pair.nextValueId !== undefined;
  if (linked && (pair.nextValueName === undefined || pair.linkSecret === undefined)) {
    throw new Error('anti-cheat linked gameplay integrity metadata is unavailable');
  }
  const ownJoinId = linked ? allocateBlock() : undefined;
  const linkJoinId = linked ? allocateBlock() : undefined;
  const linkSecretId = linked ? allocateBlock() : undefined;
  const bodyId = linked ? allocateBlock() : undefined;
  const lengthPrefixId = linked ? allocateBlock() : undefined;
  const lengthId = linked ? allocateBlock() : undefined;
  parent.next = setterId;
  target.blocks[setterId] = makeVariableSetter(parentId, null, pair.tagId, pair.tagName, [2, expectedId]);
  target.blocks[expectedId] = {
    opcode: 'operator_join',
    next: null,
    parent: setterId,
    inputs: {
      STRING1: [2, secretId],
      STRING2: bodyId
        ? [2, bodyId]
        : sentinelReporterInput({id: pair.valueId, name: pair.valueName})
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[secretId] = makeEncodedExpectedValue(expectedId, pair.secret, generator.fork('secret'));
  if (
    bodyId
    && lengthPrefixId
    && lengthId
    && ownJoinId
    && linkJoinId
    && linkSecretId
    && pair.nextValueId
    && pair.nextValueName
    && pair.linkSecret
  ) {
    target.blocks[bodyId] = {
      opcode: 'operator_join',
      next: null,
      parent: expectedId,
      inputs: {STRING1: [2, lengthPrefixId], STRING2: [2, ownJoinId]},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[lengthPrefixId] = {
      opcode: 'operator_join',
      next: null,
      parent: bodyId,
      inputs: {STRING1: [2, lengthId], STRING2: textInput(':')},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[lengthId] = {
      opcode: 'operator_length',
      next: null,
      parent: lengthPrefixId,
      inputs: {STRING: sentinelReporterInput({id: pair.valueId, name: pair.valueName})},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[ownJoinId] = {
      opcode: 'operator_join',
      next: null,
      parent: bodyId,
      inputs: {
        STRING1: sentinelReporterInput({id: pair.valueId, name: pair.valueName}),
        STRING2: [2, linkJoinId]
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[linkJoinId] = {
      opcode: 'operator_join',
      next: null,
      parent: ownJoinId,
      inputs: {
        STRING1: [2, linkSecretId],
        STRING2: sentinelReporterInput({id: pair.nextValueId, name: pair.nextValueName})
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[linkSecretId] = makeEncodedExpectedValue(
      linkJoinId,
      pair.linkSecret,
      generator.fork('link-secret')
    );
  }
  return {tailId: setterId, generatedBlocks: linked ? 9 : 3};
}

/**
 * Protect conservative, single-owner gameplay scalars with a dynamic integrity tag.
 * Legal writes refresh the tag; reads and writes call a warp guard which also probes
 * declaration-name resolution without sampling timers, input, or randomness.
 */
export function applyGameplayStateProtection(
  project: ScratchProject,
  generator: DeterministicGenerator,
  candidates: readonly VariableCandidate[]
): GameplayStateProtectionResult {
  const usable = candidates.filter(candidate => {
    const target = project.targets[candidate.targetIndex];
    const declaration = target?.variables[candidate.id];
    const usageTargets = new Set(candidate.usages.map(usage => usage.targetIndex));
    return target !== undefined
      && declaration?.[0] === candidate.name
      && isSupportedScalar(candidate.initialValue)
      && candidate.usages.length > 0
      && usageTargets.size === 1;
  });
  if (usable.length === 0) return emptyGameplayStateProtection();

  const prepared = usable.flatMap((candidate, originalIndex) => {
    const declarationTarget = project.targets[candidate.targetIndex];
    const usageTargetIndex = candidate.usages[0]?.targetIndex;
    const usageTarget = usageTargetIndex === undefined ? undefined : project.targets[usageTargetIndex];
    return declarationTarget && usageTargetIndex !== undefined && usageTarget && isSupportedScalar(candidate.initialValue)
      ? [{candidate, originalIndex, declarationTarget, usageTarget, usageTargetIndex}]
      : [];
  });
  if (prepared.length === 0) return emptyGameplayStateProtection();

  const stage = stageOf(project);
  const occupiedIds = collectOccupiedIds(project);
  const occupiedNames = collectOccupiedNames(project);
  const occupiedTokens = new Set<string>();
  const variableIds = generator.fork('variable-ids');
  const blockIds = generator.fork('block-ids');
  const allocateVariable = (): string => uniqueId(variableIds, 'v_ac_', occupiedIds);
  const allocateBlock = (): string => uniqueId(blockIds, 'b_ac_', occupiedIds);
  const names = generator.fork('names');

  const breachVariableId = allocateVariable();
  const breachName = uniqueName(names.fork('breach'), occupiedNames);
  const safeBreachValue = uniqueToken(generator.fork('breach-safe'), occupiedTokens);
  const trippedBreachValue = uniqueToken(generator.fork('breach-tripped'), occupiedTokens);
  stage.variables[breachVariableId] = [breachName, safeBreachValue];
  const breach: Sentinel = {id: breachVariableId, name: breachName, expected: safeBreachValue};

  const plans: GameplayPairPlan[] = prepared.map(item => ({
    ...item,
    tagId: allocateVariable(),
    tagName: uniqueName(names.fork(`tag:${item.originalIndex}`), occupiedNames),
    secret: uniqueToken(generator.fork(`tag-secret:${item.originalIndex}`), occupiedTokens),
    groupSize: 1,
    groupPosition: 0
  }));
  assignCyclicGameplayGroups(plans, generator.fork('integrity-links'), occupiedTokens);
  const pairs = plans.map(finalizeGameplayIntegrityPair);
  for (const plan of plans) {
    const pair = plan.pair;
    if (!pair || !isSupportedScalar(plan.candidate.initialValue)) {
      throw new Error('anti-cheat gameplay integrity pair is unavailable');
    }
    const nextInitialValue = plan.next?.candidate.initialValue;
    if (nextInitialValue !== undefined && !isSupportedScalar(nextInitialValue)) {
      throw new Error('anti-cheat linked gameplay initial value is unavailable');
    }
    plan.declarationTarget.variables[plan.tagId] = [
      plan.tagName,
      integrityTagValue(pair, plan.candidate.initialValue, nextInitialValue)
    ];
  }

  const protectedVariableIds = plans.map(plan => plan.candidate.id);
  const integrityVariableIds = plans.map(plan => plan.tagId);
  const statementSites = new Map<number, Set<string>>();
  let generatedBlockCount = 0;
  for (const plan of plans) {
    const targetStatements = statementSites.get(plan.usageTargetIndex) ?? new Set<string>();
    statementSites.set(plan.usageTargetIndex, targetStatements);
    for (const [usageIndex, usage] of plan.candidate.usages.entries()) {
      const statementId = statementContaining(plan.usageTarget, usage.blockId);
      if (!statementId) throw new Error('anti-cheat gameplay statement is unavailable');
      targetStatements.add(statementId);
      if (usage.kind !== 'field') continue;
      const writer = plan.usageTarget.blocks[usage.blockId];
      if (
        !isScratchBlock(writer)
        || (writer.opcode !== 'data_setvariableto' && writer.opcode !== 'data_changevariableby')
      ) continue;
      const originalNext = writer.next;
      const affected = plan.predecessor && plan.predecessor !== plan
        ? [plan, plan.predecessor].sort((left, right) => left.originalIndex - right.originalIndex)
        : [plan];
      let refreshTail = usage.blockId;
      for (const refreshPlan of affected) {
        const refreshPair = refreshPlan.pair;
        if (!refreshPair) throw new Error('anti-cheat gameplay refresh pair is unavailable');
        const domain = affected.length === 1
          ? `tag-update:${plan.originalIndex}:${usageIndex}`
          : `tag-update:${plan.originalIndex}:${usageIndex}:authenticator:${refreshPlan.originalIndex}`;
        const refresh = appendIntegrityTagRefresh(
          plan.usageTarget,
          refreshTail,
          refreshPair,
          allocateBlock,
          generator.fork(domain)
        );
        refreshTail = refresh.tailId;
        generatedBlockCount += refresh.generatedBlocks;
      }
      const refreshTailBlock = plan.usageTarget.blocks[refreshTail];
      if (!isScratchBlock(refreshTailBlock)) throw new Error('anti-cheat gameplay refresh tail is unavailable');
      refreshTailBlock.next = originalNext;
      if (originalNext) {
        const successor = plan.usageTarget.blocks[originalNext];
        if (!isScratchBlock(successor)) throw new Error('anti-cheat gameplay write successor is unavailable');
        successor.parent = refreshTail;
      }
    }
  }

  const procedures = addGameplayGuardProcedures(
    project,
    pairs,
    breach,
    trippedBreachValue,
    allocateBlock,
    allocateVariable,
    names.fork('procedures'),
    generator.fork('conditions'),
    occupiedNames,
    occupiedTokens
  );
  generatedBlockCount += procedures.generatedBlocks;
  for (const [targetIndex, statements] of statementSites) {
    const target = project.targets[targetIndex];
    const proccode = procedures.guardCodes.get(targetIndex);
    if (!target || !proccode) throw new Error('anti-cheat gameplay guard is unavailable');
    for (const statementId of statements) {
      insertGuardBeforeStatement(target, statementId, allocateBlock(), proccode);
      generatedBlockCount += 1;
    }
  }

  return Object.freeze({
    protectedVariableIds: Object.freeze(protectedVariableIds),
    integrityVariableIds: Object.freeze(integrityVariableIds),
    breachVariableId,
    generatedBlockCount,
    integrityPairs: Object.freeze(pairs),
    guardProcedureCodes: procedures.guardCodes,
    tripSentinel: breach
  });
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
  occupiedNames: Set<string>,
  gameplayGuardCodes: ReadonlyMap<number, string>
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
    const gameplayGuardCode = gameplayGuardCodes.get(targetIndex);
    const gameplayCallId = gameplayGuardCode === undefined ? undefined : allocateBlock();
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
      next: gameplayCallId ?? guardId,
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
    if (gameplayCallId && gameplayGuardCode) {
      target.blocks[gameplayCallId] = procedureCall(definitionId, guardId, gameplayGuardCode);
    }
    target.blocks[guardId] = {
      opcode: 'control_if',
      next: null,
      parent: gameplayCallId ?? definitionId,
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
    generatedBlocks += 5 + condition.blocks.size + (gameplayCallId === undefined ? 0 : 1);

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
  generator: DeterministicGenerator,
  options: AntiCheatTransformOptions = {}
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
  const watermarkDeclaration = stage.variables[watermark.watermarkVariableId];
  if (
    !watermarkDeclaration
    || watermarkDeclaration[0] !== ANTI_CHEAT_WATERMARK_NAME
    || watermarkDeclaration[1] === undefined
    || !isSupportedScalar(watermarkDeclaration[1])
  ) throw new Error('anti-cheat watermark declaration is unavailable');

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
  const additionalSentinels = options.gameplayState?.tripSentinel
    ? [options.gameplayState.tripSentinel]
    : [];
  const mismatchSentinels = [...decoys, ...additionalSentinels, latchSentinel];
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
  for (const [pairIndex, pair] of (options.gameplayState?.integrityPairs ?? []).entries()) {
    const condition = buildIntegrityMismatchCondition(
      pair,
      allocateBlock,
      generator.fork(`watchdog-gameplay:${pairIndex}`),
      true
    );
    for (const [id, block] of condition.blocks) generated.set(id, block);
    conditionRoots.push(condition.rootId);
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
    occupiedNames,
    options.gameplayState?.guardProcedureCodes ?? new Map<number, string>()
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
