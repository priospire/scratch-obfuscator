import {countBlockEquivalents, isPrimitive, isScratchBlock} from '../model/blocks.js';
import {isRecord} from '../model/json.js';
import type {JsonValue, ScratchBlock, ScratchBlockValue, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import {
  OFFICIAL_CORE_OPCODES,
  OFFICIAL_EXTENSION_OPCODES,
  OFFICIAL_LITERAL_SHADOW_OPCODES
} from '../validation/extensions.js';
import {ANTI_CHEAT_WATERMARK_NAME} from './anticheat.js';
import {createStaticInputEvaluator} from './optimizer.js';

/** Straight-line commands which can be isolated without moving a yield or C-shaped stack. */
const VIRTUALIZABLE_STACK_OPCODES = new Set([
  'data_addtolist',
  'data_changevariableby',
  'data_deletealloflist',
  'data_deleteoflist',
  'data_insertatlist',
  'data_replaceitemoflist',
  'data_setvariableto',
  'looks_changeeffectby',
  'looks_changesizeby',
  'looks_cleargraphiceffects',
  'looks_goforwardbackwardlayers',
  'looks_gotofrontback',
  'looks_hide',
  'looks_nextbackdrop',
  'looks_nextcostume',
  'looks_seteffectto',
  'looks_setsizeto',
  'looks_show',
  'looks_switchbackdropto',
  'looks_switchcostumeto',
  'motion_changexby',
  'motion_changeyby',
  'motion_ifonedgebounce',
  'motion_movesteps',
  'motion_pointindirection',
  'motion_setrotationstyle',
  'motion_setx',
  'motion_sety',
  'motion_turnleft',
  'motion_turnright',
  'sensing_resettimer',
  'sound_changeeffectby',
  'sound_changevolumeby',
  'sound_cleareffects',
  'sound_seteffectto',
  'sound_setvolumeto',
  'sound_stopallsounds'
]);

const SAFE_STRING_INPUTS = new Set([
  'ANSWER',
  'ITEM',
  'LETTER',
  'MESSAGE',
  'OPERAND1',
  'OPERAND2',
  'STRING1',
  'STRING2',
  'TEXT',
  'VALUE'
]);

/** Inputs whose core implementation immediately applies Scratch numeric coercion. */
const SAFE_NUMERIC_INPUTS = new Map<string, ReadonlySet<string>>([
  ['control_repeat', new Set(['TIMES'])],
  ['control_wait', new Set(['DURATION'])],
  ['data_changevariableby', new Set(['VALUE'])],
  ['event_whengreaterthan', new Set(['VALUE'])],
  ['looks_changeeffectby', new Set(['CHANGE'])],
  ['looks_changesizeby', new Set(['CHANGE'])],
  ['looks_goforwardbackwardlayers', new Set(['NUM'])],
  ['looks_seteffectto', new Set(['VALUE'])],
  ['looks_setsizeto', new Set(['SIZE'])],
  ['motion_changexby', new Set(['DX'])],
  ['motion_changeyby', new Set(['DY'])],
  ['motion_glidesecstoxy', new Set(['SECS', 'X', 'Y'])],
  ['motion_glideto', new Set(['SECS'])],
  ['motion_gotoxy', new Set(['X', 'Y'])],
  ['motion_movesteps', new Set(['STEPS'])],
  ['motion_pointindirection', new Set(['DIRECTION'])],
  ['motion_setx', new Set(['X'])],
  ['motion_sety', new Set(['Y'])],
  ['motion_turnleft', new Set(['DEGREES'])],
  ['motion_turnright', new Set(['DEGREES'])],
  ['operator_add', new Set(['NUM1', 'NUM2'])],
  ['operator_divide', new Set(['NUM1', 'NUM2'])],
  ['operator_mathop', new Set(['NUM'])],
  ['operator_letter_of', new Set(['LETTER'])],
  ['operator_mod', new Set(['NUM1', 'NUM2'])],
  ['operator_multiply', new Set(['NUM1', 'NUM2'])],
  ['operator_round', new Set(['NUM'])],
  ['operator_subtract', new Set(['NUM1', 'NUM2'])],
  ['sound_changeeffectby', new Set(['VALUE'])],
  ['sound_changevolumeby', new Set(['VOLUME'])],
  ['sound_seteffectto', new Set(['VALUE'])],
  ['sound_setvolumeto', new Set(['VOLUME'])]
]);

const CANONICAL_FINITE_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

const STAGE_SENSING_ATTRIBUTES = new Set(['background #', 'backdrop #', 'backdrop name', 'volume']);
const SPRITE_SENSING_ATTRIBUTES = new Set([
  'x position',
  'y position',
  'direction',
  'costume #',
  'costume name',
  'size',
  'volume'
]);
const IMPLEMENTED_LITERAL_MENU_FIELDS = new Map<string, string>([
  ['sound_beats_menu', 'BEATS'],
  ['sound_effects_menu', 'EFFECT'],
  ['sound_sounds_menu', 'SOUND_MENU']
]);
const LOSSY_OBSERVABILITY_HAZARDS = new Set([
  'control_create_clone_of',
  'control_delete_this_clone',
  'control_forever',
  'control_repeat',
  'control_repeat_until',
  'control_stop',
  'control_wait',
  'control_wait_until',
  'event_broadcast',
  'event_broadcastandwait',
  'looks_sayforsecs',
  'looks_switchbackdroptoandwait',
  'looks_thinkforsecs',
  'motion_glidesecstoxy',
  'motion_glideto',
  'motion_goto',
  'motion_pointtowards',
  'operator_random',
  'procedures_call',
  'procedures_definition',
  'procedures_prototype',
  'sensing_answer',
  'sensing_askandwait',
  'sensing_coloristouchingcolor',
  'sensing_current',
  'sensing_dayssince2000',
  'sensing_distanceto',
  'sensing_keypressed',
  'sensing_loudness',
  'sensing_mousedown',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_of',
  'sensing_resettimer',
  'sensing_timer',
  'sensing_touchingcolor',
  'sensing_touchingobject',
  'sensing_username',
  'sound_play',
  'sound_playuntildone'
]);

export interface LinearRun {
  readonly targetIndex: number;
  readonly blockIds: readonly string[];
  readonly predecessorId: string | null;
  readonly successorId: string | null;
  readonly wasTopLevel: boolean;
  readonly x?: number;
  readonly y?: number;
}

export interface StringLiteralSite {
  readonly targetIndex: number;
  readonly ownerId: string;
  readonly inputName: string;
  readonly value: string;
}

export interface NumericLiteralSite {
  readonly targetIndex: number;
  readonly ownerId: string;
  readonly inputName: string;
  readonly primitiveCode: 4 | 5 | 6 | 7 | 8;
  readonly value: string;
  readonly growth: 2 | 3;
}

export type VariableUsage =
  | {readonly kind: 'field'; readonly targetIndex: number; readonly blockId: string}
  | {readonly kind: 'inline'; readonly targetIndex: number; readonly blockId: string; readonly inputName: string};

export interface VariableCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly initialValue: JsonValue;
  readonly usages: readonly VariableUsage[];
  readonly estimatedGrowth: number;
}

interface MutableVariableCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly initialValue: JsonValue;
  readonly usages: VariableUsage[];
  estimatedGrowth: number;
  safe: boolean;
}

export {countBlockEquivalents};

export function countObjectBlocks(project: ScratchProject): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (isScratchBlock(value)) count += 1;
    }
  }
  return count;
}

export function isVirtualizableStackBlock(block: ScratchBlock): boolean {
  return !block.shadow && VIRTUALIZABLE_STACK_OPCODES.has(block.opcode);
}

/**
 * A deliberately conservative gate for additions on an executing lossy stack.
 * Inert top-level decoys remain available when this returns false.
 */
export function isLossyLiveTransformSafe(project: ScratchProject): boolean {
  let runnableHats = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      if (!isCoreBlock(value.opcode)) return false;
      if (value.opcode.startsWith('sensing_')) return false;
      if (value.opcode.startsWith('control_') && value.opcode !== 'control_if' && value.opcode !== 'control_if_else' && value.opcode !== 'control_start_as_clone') return false;
      if (value.topLevel && isRunnableHat(value.opcode)) runnableHats += 1;
      if (LOSSY_OBSERVABILITY_HAZARDS.has(value.opcode)) return false;
      if (value.opcode.startsWith('event_when') && value.opcode !== 'event_whenflagclicked') return false;
    }
  }
  return runnableHats <= 1;
}

/**
 * Find maximal eligible runs on user-startable top-level stacks. Procedure bodies
 * are deliberately excluded: recursion and warp ownership cannot be proven from
 * the serialized graph alone.
 */
export function collectLinearRuns(project: ScratchProject, minimumLength = 4): LinearRun[] {
  const runs: LinearRun[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    const claimed = new Set<string>();
    for (const [topId, topValue] of Object.entries(target.blocks)) {
      if (!isScratchBlock(topValue) || !topValue.topLevel || topValue.opcode === 'procedures_definition') continue;
      const visited = new Set<string>();
      let currentId: string | null = topId;
      let predecessorId: string | null = null;
      let pending: string[] = [];
      let pendingPredecessor: string | null = null;

      const flush = (successorId: string | null): void => {
        if (pending.length >= minimumLength && pending.every(id => !claimed.has(id))) {
          const first = target.blocks[pending[0] ?? ''];
          if (first && isScratchBlock(first)) {
            const run: LinearRun = {
              targetIndex,
              blockIds: [...pending],
              predecessorId: pendingPredecessor,
              successorId,
              wasTopLevel: first.topLevel,
              ...(first.x === undefined ? {} : {x: first.x}),
              ...(first.y === undefined ? {} : {y: first.y})
            };
            runs.push(run);
            for (const id of pending) claimed.add(id);
          }
        }
        pending = [];
        pendingPredecessor = null;
      };

      while (currentId !== null && !visited.has(currentId)) {
        visited.add(currentId);
        const value: ScratchBlockValue | undefined = target.blocks[currentId];
        if (!value || !isScratchBlock(value)) {
          flush(currentId);
          break;
        }
        if (isVirtualizableStackBlock(value)) {
          if (pending.length === 0) pendingPredecessor = predecessorId;
          pending.push(currentId);
        } else {
          flush(currentId);
        }
        predecessorId = currentId;
        currentId = value.next;
      }
      flush(currentId);
    }
  }
  return runs;
}

export function collectStringLiteralSites(project: ScratchProject): StringLiteralSite[] {
  const sites: StringLiteralSite[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [ownerId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || !isCoreBlock(value.opcode)) continue;
      for (const [inputName, input] of Object.entries(value.inputs)) {
        if (!SAFE_STRING_INPUTS.has(inputName)) continue;
        const active = input[1];
        if (isPrimitive(active) && active[0] === 10 && typeof active[1] === 'string') {
          sites.push({targetIndex, ownerId, inputName, value: active[1]});
        }
      }
    }
  }
  return sites;
}

/**
 * Collect only canonical finite decimal shadows at sites whose official core
 * primitive performs numeric coercion before observing the value. This avoids
 * changing string/number identity at polymorphic data and comparison inputs.
 */
export function collectNumericLiteralSites(project: ScratchProject): NumericLiteralSite[] {
  const sites: NumericLiteralSite[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [ownerId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      const safeInputs = SAFE_NUMERIC_INPUTS.get(value.opcode);
      if (!safeInputs) continue;
      for (const inputName of safeInputs) {
        const input = value.inputs[inputName];
        if (!input) continue;
        const active = input[1];
        if (!isPrimitive(active)) continue;
        if (input[2] !== undefined && !isPrimitive(input[2])) continue;
        const primitiveCode = active[0];
        const literal = active[1];
        if (
          typeof primitiveCode !== 'number'
          || primitiveCode < 4
          || primitiveCode > 8
          || typeof literal !== 'string'
          || !CANONICAL_FINITE_DECIMAL.test(literal)
          || !Number.isFinite(Number(literal))
        ) continue;
        sites.push({
          targetIndex,
          ownerId,
          inputName,
          primitiveCode: primitiveCode as 4 | 5 | 6 | 7 | 8,
          value: literal,
          growth: input[2] === undefined ? 3 : 2
        });
      }
    }
  }
  return sites;
}

/** Return non-cloud, non-monitored variables whose every runtime-visible use is understood. */
export function collectVariableCandidates(project: ScratchProject): VariableCandidate[] {
  const monitoredVariables = collectMonitoredVariables(project);
  const sensedVariables = collectSensedVariables(project);
  const opaqueTargets = project.targets.map(hasOpaqueVariableSurface);
  const hasAnyOpaqueTarget = opaqueTargets.some(Boolean);
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const stage = stageIndex < 0 ? undefined : project.targets[stageIndex];
  const cloudVariableIds = new Set<string>();
  if (stage) {
    for (const [id, declaration] of Object.entries(stage.variables)) {
      if (declaration.length === 3 && declaration[2] === true && cloudVariableIds.size < 10) {
        cloudVariableIds.add(id);
      }
    }
  }

  const declarationIdsByName = project.targets.map(target => {
    const ids = new Map<string, string>();
    for (const [id, declaration] of Object.entries(target.variables)) {
      const name = declaration[0];
      if (typeof name === 'string' && !ids.has(name)) ids.set(name, id);
    }
    return ids;
  });

  const orderedCandidates: MutableVariableCandidate[] = [];
  const candidatesByTarget = project.targets.map(() => new Map<string, MutableVariableCandidate>());

  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [id, declaration] of Object.entries(target.variables)) {
      const name = declaration[0];
      const initialValue = declaration[1];
      if (
        typeof name !== 'string'
        || initialValue === undefined
        || (target.isStage && cloudVariableIds.has(id))
        || monitoredVariables.get(target)?.has(id) === true
        || sensedVariables.get(target)?.has(id) === true
        || (target.isStage && name === ANTI_CHEAT_WATERMARK_NAME)
      ) continue;
      const candidate: MutableVariableCandidate = {
        targetIndex,
        id,
        name,
        initialValue,
        usages: [],
        estimatedGrowth: 0,
        safe: target.isStage ? !hasAnyOpaqueTarget : opaqueTargets[targetIndex] !== true
      };
      orderedCandidates.push(candidate);
      candidatesByTarget[targetIndex]?.set(id, candidate);
    }
  }

  const resolveCandidate = (
    id: unknown,
    name: unknown,
    usageTargetIndex: number,
    usageTarget: ScratchTarget
  ): MutableVariableCandidate | undefined => {
    if (typeof id === 'string' && id.length > 0) {
      if (Object.prototype.hasOwnProperty.call(usageTarget.variables, id)) {
        return candidatesByTarget[usageTargetIndex]?.get(id);
      }
      if (stage && usageTarget !== stage && Object.prototype.hasOwnProperty.call(stage.variables, id)) {
        return candidatesByTarget[stageIndex]?.get(id);
      }
      return undefined;
    }
    if (typeof name !== 'string') return undefined;
    if (!stage) return undefined;
    const globalId = declarationIdsByName[stageIndex]?.get(name);
    return globalId === undefined ? undefined : candidatesByTarget[stageIndex]?.get(globalId);
  };

  for (const [usageTargetIndex, usageTarget] of project.targets.entries()) {
    for (const [blockId, value] of Object.entries(usageTarget.blocks)) {
      if (!isScratchBlock(value)) {
        if (isPrimitive(value) && value[0] === 12) {
          const candidate = resolveCandidate(value[2], value[1], usageTargetIndex, usageTarget);
          if (candidate) candidate.safe = false;
        }
        continue;
      }

      const variableField = value.fields['VARIABLE'];
      const fieldCandidate = resolveCandidate(variableField?.[1], variableField?.[0], usageTargetIndex, usageTarget);
      if (fieldCandidate) {
        if (!hasExactVariableBlockShape(value)) {
          fieldCandidate.safe = false;
        } else {
          fieldCandidate.usages.push({kind: 'field', targetIndex: usageTargetIndex, blockId});
          if (value.opcode === 'data_changevariableby') {
            fieldCandidate.estimatedGrowth += value.inputs['VALUE'] === undefined ? 6 : 5;
          } else {
            fieldCandidate.estimatedGrowth += 1;
          }
        }
      }

      for (const [inputName, input] of Object.entries(value.inputs)) {
        const active = input[1];
        if (isPrimitive(active) && active[0] === 12) {
          const candidate = resolveCandidate(active[2], active[1], usageTargetIndex, usageTarget);
          if (candidate) {
            candidate.usages.push({kind: 'inline', targetIndex: usageTargetIndex, blockId, inputName});
            candidate.estimatedGrowth += input[2] === undefined ? 2 : 1;
          }
        }
        const fallback = input[2];
        if (isPrimitive(fallback) && fallback[0] === 12) {
          const candidate = resolveCandidate(fallback[2], fallback[1], usageTargetIndex, usageTarget);
          if (candidate) candidate.safe = false;
        }
      }
    }
  }

  return orderedCandidates.flatMap(candidate => candidate.safe ? [{
    targetIndex: candidate.targetIndex,
    id: candidate.id,
    name: candidate.name,
    initialValue: candidate.initialValue,
    usages: candidate.usages,
    estimatedGrowth: candidate.estimatedGrowth
  }] : []);
}

function hasExactVariableBlockShape(block: ScratchBlock): boolean {
  if (block.shadow || Object.keys(block.fields).length !== 1 || block.fields['VARIABLE'] === undefined) return false;
  const inputNames = Object.keys(block.inputs);
  if (block.opcode === 'data_variable') return block.next === null && inputNames.length === 0;
  if (block.opcode === 'data_setvariableto') return inputNames.length === 1 && inputNames[0] === 'VALUE';
  return block.opcode === 'data_changevariableby'
    && (inputNames.length === 0 || (inputNames.length === 1 && inputNames[0] === 'VALUE'));
}

function hasOpaqueVariableSurface(target: ScratchTarget): boolean {
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    if (isOfficialExtensionOpcode(value.opcode)) continue;
    if (!OFFICIAL_CORE_OPCODES.has(value.opcode)) return true;
    if (value.mutation !== undefined && !isRecognizedProcedureMutation(value.opcode, value.mutation)) return true;
  }
  return false;
}

function isOfficialExtensionOpcode(opcode: string): boolean {
  const separator = opcode.indexOf('_');
  if (separator < 1) return false;
  return OFFICIAL_EXTENSION_OPCODES.get(opcode.slice(0, separator))?.has(opcode) === true;
}

function isRecognizedProcedureMutation(opcode: string, mutation: Readonly<Record<string, JsonValue>>): boolean {
  if (opcode !== 'procedures_call' && opcode !== 'procedures_prototype') return false;
  const allowedKeys = new Set([
    'argumentdefaults',
    'argumentids',
    'argumentnames',
    'children',
    'proccode',
    'tagName',
    'warp'
  ]);
  return Object.keys(mutation).every(key => allowedKeys.has(key));
}

export function hardenInactiveShadows(project: ScratchProject, poison: (primitive: ScratchInput) => ScratchInput): number {
  let changed = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const input of Object.values(value.inputs)) {
        if (input[0] !== 3 || typeof input[1] !== 'string' || !isPrimitive(input[2])) continue;
        input[2] = poison(input[2]);
        changed += 1;
      }
    }
  }
  return changed;
}

export function blockAt(target: ScratchTarget, id: string): ScratchBlock | undefined {
  const value = target.blocks[id];
  return value && isScratchBlock(value) ? value : undefined;
}

function isCoreBlock(opcode: string): boolean {
  const separator = opcode.indexOf('_');
  const prefix = separator < 0 ? opcode : opcode.slice(0, separator);
  return prefix === 'argument' || prefix === 'colour' || prefix === 'control' || prefix === 'data' || prefix === 'event' || prefix === 'looks' || prefix === 'math' || prefix === 'motion' || prefix === 'operator' || prefix === 'procedures' || prefix === 'sensing' || prefix === 'sound';
}

function isRunnableHat(opcode: string): boolean {
  return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
}

type VariablesByTarget = Map<ScratchTarget, Set<string>>;

type SensingObjectSelection =
  | {readonly kind: 'dynamic'}
  | {readonly kind: 'missing'}
  | {readonly kind: 'target'; readonly target: ScratchTarget};

function targetVariableSet(map: VariablesByTarget, target: ScratchTarget): Set<string> {
  const existing = map.get(target);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(target, created);
  return created;
}

function collectMonitoredVariables(project: ScratchProject): VariablesByTarget {
  const result: VariablesByTarget = new Map();
  const stage = project.targets.find(target => target.isStage);
  if (!stage) return result;
  for (const monitor of project.monitors) {
    if (monitor['opcode'] !== 'data_variable' || typeof monitor['id'] !== 'string') continue;
    const spriteName = monitor['spriteName'];
    const requestedTarget = typeof spriteName === 'string' && spriteName.length > 0
      ? project.targets.find(target => !target.isStage && target.name === spriteName) ?? stage
      : stage;
    const declarationTarget = Object.prototype.hasOwnProperty.call(requestedTarget.variables, monitor['id'])
      ? requestedTarget
      : Object.prototype.hasOwnProperty.call(stage.variables, monitor['id']) ? stage : undefined;
    if (declarationTarget) targetVariableSet(result, declarationTarget).add(monitor['id']);
  }
  return result;
}

function isNativeSensingAttribute(target: ScratchTarget, property: string): boolean {
  return (target.isStage ? STAGE_SENSING_ATTRIBUTES : SPRITE_SENSING_ATTRIBUTES).has(property);
}

function selectionForSensingLiteral(project: ScratchProject, literal: string): SensingObjectSelection {
  if (literal === '_stage_') {
    const stage = project.targets.find(target => target.isStage);
    return stage ? {kind: 'target', target: stage} : {kind: 'missing'};
  }
  const target = project.targets.find(candidate => !candidate.isStage && candidate.name === literal);
  return target ? {kind: 'target', target} : {kind: 'missing'};
}

function literalPrimitiveValue(primitive: ScratchInput): string | undefined {
  const code = primitive[0];
  if (typeof code !== 'number' || code < 4 || code > 11) return undefined;
  const value = primitive[1];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function literalReporterValue(target: ScratchTarget, id: string): string | undefined {
  const reporter = target.blocks[id];
  if (isPrimitive(reporter)) return literalPrimitiveValue(reporter);
  if (!isScratchBlock(reporter)) return undefined;
  if (!OFFICIAL_LITERAL_SHADOW_OPCODES.has(reporter.opcode) || Object.keys(reporter.fields).length !== 1 || Object.keys(reporter.inputs).length > 0) {
    return undefined;
  }
  const entry = Object.entries(reporter.fields)[0];
  if (entry === undefined) return undefined;
  const implementedField = IMPLEMENTED_LITERAL_MENU_FIELDS.get(reporter.opcode);
  if (implementedField !== undefined && entry[0] !== implementedField) return undefined;
  const value = entry[1][0];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function staticInputEvaluator(
  target: ScratchTarget
): (ownerId: string, input: ScratchInput) => boolean | number | string | undefined {
  return createStaticInputEvaluator(target, value => (
    typeof value === 'string' ? literalReporterValue(target, value) : literalPrimitiveValue(value)
  ));
}

function sensingBlockSelection(
  project: ScratchProject,
  owner: ScratchTarget,
  ownerId: string,
  input: ScratchInput | undefined,
  evaluateStaticInput: (ownerId: string, input: ScratchInput) => boolean | number | string | undefined
): SensingObjectSelection {
  if (input === undefined) return selectionForSensingLiteral(project, 'undefined');
  const active = input[1];
  if (active === null || active === undefined) return selectionForSensingLiteral(project, 'undefined');
  if (isPrimitive(active)) {
    const literal = literalPrimitiveValue(active);
    return literal === undefined ? {kind: 'dynamic'} : selectionForSensingLiteral(project, literal);
  }
  if (typeof active !== 'string') return {kind: 'dynamic'};
  const literal = literalReporterValue(owner, active);
  if (literal !== undefined) return selectionForSensingLiteral(project, literal);
  const fixed = evaluateStaticInput(ownerId, input);
  return fixed === undefined ? {kind: 'dynamic'} : selectionForSensingLiteral(project, String(fixed));
}

function scratchString(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.map(item => item === null ? '' : scratchString(item)).join(',');
  }
  if (typeof value === 'object') return '[object Object]';
  return String(value);
}

function sensingMonitorSelection(
  project: ScratchProject,
  params: Readonly<Record<string, JsonValue>>
): SensingObjectSelection {
  const object = params['OBJECT'];
  if (object === '_stage_') return selectionForSensingLiteral(project, object);
  const literal = scratchString(object);
  const target = project.targets.find(candidate => !candidate.isStage && candidate.name === literal);
  return target ? {kind: 'target', target} : {kind: 'missing'};
}

function addSensedVariable(
  result: VariablesByTarget,
  targets: readonly ScratchTarget[],
  property: string
): void {
  for (const target of targets) {
    if (isNativeSensingAttribute(target, property)) continue;
    for (const [id, declaration] of Object.entries(target.variables)) {
      if (declaration[0] !== property) continue;
      targetVariableSet(result, target).add(id);
      break;
    }
  }
}

function collectSensedVariables(project: ScratchProject): VariablesByTarget {
  const result: VariablesByTarget = new Map();
  const register = (selection: SensingObjectSelection, property: unknown): void => {
    if (typeof property !== 'string') return;
    const targets = selection.kind === 'dynamic'
      ? project.targets
      : selection.kind === 'target' ? [selection.target] : [];
    addSensedVariable(result, targets, property);
  };
  for (const target of project.targets) {
    const evaluateStaticInput = staticInputEvaluator(target);
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'sensing_of') continue;
      register(
        sensingBlockSelection(project, target, blockId, value.inputs['OBJECT'], evaluateStaticInput),
        value.fields['PROPERTY']?.[0]
      );
    }
  }
  for (const monitor of project.monitors) {
    if (monitor['opcode'] !== 'sensing_of' || !isRecord(monitor['params'])) continue;
    register(
      sensingMonitorSelection(project, monitor['params']),
      monitor['params']['PROPERTY']
    );
  }
  return result;
}
