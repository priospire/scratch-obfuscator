import {countBlockEquivalents, isPrimitive, isScratchBlock} from '../model/blocks.js';
import type {JsonValue, ScratchBlock, ScratchBlockValue, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import {ANTI_CHEAT_WATERMARK_NAME} from './anticheat.js';

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
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
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
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
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
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
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
  const monitoredIds = new Set<string>();
  for (const monitor of project.monitors) collectStrings(monitor, monitoredIds);
  const sensedNames = collectSensedPropertyNames(project);
  const opaqueTargets = project.targets.map(hasOpaqueVariableSurface);
  const hasAnyOpaqueTarget = opaqueTargets.some(Boolean);
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const stage = stageIndex < 0 ? undefined : project.targets[stageIndex];
  const stageNames = new Map<string, string[]>();
  if (stage) {
    for (const [id, declaration] of Object.entries(stage.variables)) {
      const name = declaration[0];
      if (typeof name !== 'string') continue;
      const ids = stageNames.get(name) ?? [];
      ids.push(id);
      stageNames.set(name, ids);
    }
  }

  const orderedCandidates: MutableVariableCandidate[] = [];
  const candidatesById = new Map<string, MutableVariableCandidate>();
  const duplicateIds = new Set<string>();

  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [id, declaration] of Object.entries(target.variables)) {
      const name = declaration[0];
      const initialValue = declaration[1];
      if (
        typeof name !== 'string'
        || initialValue === undefined
        || declaration[2] === true
        || monitoredIds.has(id)
        || sensedNames.has(name)
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
      const previous = candidatesById.get(id);
      if (previous) {
        previous.safe = false;
        candidate.safe = false;
        duplicateIds.add(id);
      }
      candidatesById.set(id, candidate);
    }
  }

  const resolveCandidate = (id: unknown, usageTargetIndex: number): MutableVariableCandidate | undefined => {
    if (typeof id !== 'string' || duplicateIds.has(id)) return undefined;
    const candidate = candidatesById.get(id);
    if (!candidate) return undefined;
    const declarationTarget = project.targets[candidate.targetIndex];
    return declarationTarget?.isStage || candidate.targetIndex === usageTargetIndex ? candidate : undefined;
  };

  for (let usageTargetIndex = 0; usageTargetIndex < project.targets.length; usageTargetIndex += 1) {
    const usageTarget = project.targets[usageTargetIndex];
    if (!usageTarget) continue;
    for (const [blockId, value] of Object.entries(usageTarget.blocks)) {
      if (!isScratchBlock(value)) {
        if (isPrimitive(value) && value[0] === 12) {
          const candidate = resolveCandidate(value[2], usageTargetIndex);
          if (candidate) candidate.safe = false;
        }
        continue;
      }

      const variableField = value.fields['VARIABLE'];
      let fieldCandidate = resolveCandidate(variableField?.[1], usageTargetIndex);
      if (!fieldCandidate && variableField && typeof variableField[0] === 'string') {
        const matchingIds = stageNames.get(variableField[0]);
        if (matchingIds?.length === 1) fieldCandidate = resolveCandidate(matchingIds[0], usageTargetIndex);
      }
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
          const candidate = resolveCandidate(active[2], usageTargetIndex);
          if (candidate) {
            candidate.usages.push({kind: 'inline', targetIndex: usageTargetIndex, blockId, inputName});
            candidate.estimatedGrowth += input[2] === undefined ? 2 : 1;
          }
        }
        const fallback = input[2];
        if (isPrimitive(fallback) && fallback[0] === 12) {
          const candidate = resolveCandidate(fallback[2], usageTargetIndex);
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
    if (!isCoreBlock(value.opcode)) return true;
    if (value.mutation !== undefined && !isRecognizedProcedureMutation(value)) return true;
  }
  return false;
}

function isRecognizedProcedureMutation(block: ScratchBlock): boolean {
  if (block.opcode !== 'procedures_call' && block.opcode !== 'procedures_prototype') return false;
  const mutation = block.mutation;
  if (!mutation) return false;
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

function collectStrings(value: JsonValue | Record<string, JsonValue>, into: Set<string>): void {
  if (typeof value === 'string') {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

function collectSensedPropertyNames(project: ScratchProject): Set<string> {
  const result = new Set<string>();
  for (const monitor of project.monitors) {
    if (monitor['opcode'] !== 'sensing_of') continue;
    const params = monitor['params'];
    if (params === null || typeof params !== 'object' || Array.isArray(params)) continue;
    const property = params['PROPERTY'];
    if (typeof property === 'string') result.add(property);
  }
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'sensing_of') continue;
      const property = value.fields['PROPERTY']?.[0];
      if (typeof property === 'string') result.add(property);
    }
  }
  return result;
}
