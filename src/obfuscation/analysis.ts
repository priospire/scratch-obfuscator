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

const YIELDING_OPCODES = new Set([
  'control_for_each',
  'control_forever',
  'control_repeat',
  'control_repeat_until',
  'control_wait',
  'control_wait_until',
  'control_while',
  'event_broadcastandwait',
  'looks_sayforsecs',
  'looks_switchbackdroptoandwait',
  'looks_thinkforsecs',
  'motion_glidesecstoxy',
  'motion_glideto',
  'sensing_askandwait',
  'sound_playuntildone'
]);

const TIMER_OPCODES = new Set([
  'control_wait',
  'looks_sayforsecs',
  'looks_thinkforsecs',
  'motion_glidesecstoxy',
  'motion_glideto',
  'sensing_current',
  'sensing_dayssince2000',
  'sensing_loud',
  'sensing_loudness',
  'sensing_resettimer',
  'sensing_timer'
]);

const LIVE_INPUT_OPCODES = new Set([
  'sensing_answer',
  'sensing_askandwait',
  'sensing_coloristouchingcolor',
  'sensing_distanceto',
  'sensing_keypressed',
  'sensing_loud',
  'sensing_loudness',
  'sensing_mousedown',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_of',
  'sensing_online',
  'sensing_touchingcolor',
  'sensing_touchingobject',
  'sensing_username'
]);

const REDRAW_OPCODES = new Set([
  'control_wait',
  'looks_changeeffectby',
  'looks_changesizeby',
  'looks_cleargraphiceffects',
  'looks_goforwardbackwardlayers',
  'looks_gotofrontback',
  'looks_hide',
  'looks_nextbackdrop',
  'looks_nextcostume',
  'looks_say',
  'looks_sayforsecs',
  'looks_seteffectto',
  'looks_setsizeto',
  'looks_show',
  'looks_switchbackdropto',
  'looks_switchbackdroptoandwait',
  'looks_think',
  'looks_thinkforsecs',
  'motion_changexby',
  'motion_changeyby',
  'motion_glidesecstoxy',
  'motion_glideto',
  'motion_goto',
  'motion_ifonedgebounce',
  'motion_movesteps',
  'motion_pointindirection',
  'motion_pointtowards',
  'motion_setrotationstyle',
  'motion_setx',
  'motion_sety',
  'motion_turnleft',
  'motion_turnright'
]);

const BROADCAST_OPCODES = new Set([
  'event_broadcast',
  'event_broadcastandwait',
  'event_whenbroadcastreceived'
]);

const CLONE_OPCODES = new Set([
  'control_create_clone_of',
  'control_delete_this_clone',
  'control_start_as_clone'
]);

const REENTRY_OPCODES = new Set([
  'control_create_clone_of',
  'event_broadcast',
  'event_broadcastandwait',
  'event_whenbackdropswitchesto',
  'event_whenbroadcastreceived',
  'looks_nextbackdrop',
  'looks_switchbackdropto',
  'looks_switchbackdroptoandwait'
]);

const THREAD_CONTROL_OPCODES = new Set([
  'control_delete_this_clone',
  'control_stop',
  'event_broadcast',
  'event_broadcastandwait',
  'looks_nextbackdrop',
  'looks_switchbackdropto',
  'looks_switchbackdroptoandwait'
]);

const VARIABLE_READ_OPCODES = new Set(['data_changevariableby', 'data_variable']);
const VARIABLE_WRITE_OPCODES = new Set([
  'control_for_each',
  'data_changevariableby',
  'data_setvariableto'
]);
const LIST_READ_OPCODES = new Set([
  'data_addtolist',
  'data_deleteoflist',
  'data_insertatlist',
  'data_itemnumoflist',
  'data_itemoflist',
  'data_lengthoflist',
  'data_listcontainsitem',
  'data_listcontents',
  'data_replaceitemoflist'
]);
const LIST_WRITE_OPCODES = new Set([
  'data_addtolist',
  'data_deletealloflist',
  'data_deleteoflist',
  'data_insertatlist',
  'data_replaceitemoflist'
]);
const LIST_INDEX_OPCODES = new Set([
  'data_deleteoflist',
  'data_insertatlist',
  'data_itemoflist',
  'data_replaceitemoflist'
]);

const OWNER_TARGET_READ_PREFIXES = new Set(['looks', 'motion', 'sensing', 'sound']);
const SOUND_TARGET_WRITE_OPCODES = new Set([
  'sound_changeeffectby',
  'sound_changevolumeby',
  'sound_cleareffects',
  'sound_play',
  'sound_playuntildone',
  'sound_seteffectto',
  'sound_setvolumeto',
  'sound_stopallsounds'
]);
const RUNTIME_STATE_READ_OPCODES = new Map<string, string>([
  ['control_get_counter', 'control-counter'],
  ['sensing_answer', 'answer'],
  ['sensing_timer', 'project-timer']
]);
const RUNTIME_STATE_WRITE_OPCODES = new Map<string, string>([
  ['control_clear_counter', 'control-counter'],
  ['control_incr_counter', 'control-counter'],
  ['sensing_askandwait', 'answer'],
  ['sensing_resettimer', 'project-timer']
]);

export type RegionEligibilityProfile = 'lossy' | 'no-preserve';

export type LinearRunEntryConnector =
  | {readonly kind: 'top-level'; readonly blockId: string}
  | {readonly kind: 'next'; readonly ownerId: string; readonly blockId: string}
  | {
    readonly kind: 'input';
    readonly ownerId: string;
    readonly inputName: 'SUBSTACK' | 'SUBSTACK2';
    readonly blockId: string;
  };

export interface NestedLinearRun extends LinearRun {
  readonly connector: LinearRunEntryConnector;
}

export interface NestedLinearRunOptions {
  readonly minimumLength?: number;
  readonly includeProcedureBodies?: boolean;
}

export interface EffectSite {
  readonly targetIndex: number;
  readonly blockId: string;
  readonly opcode: string;
}

export interface EffectSymbolReference {
  readonly kind: 'variable' | 'list';
  readonly targetIndex: number | null;
  readonly scope: 'stage' | 'target' | 'unresolved';
  readonly id: string;
  readonly name: string;
}

export interface EffectTargetOwnership {
  readonly executionTargetIndex: number;
  readonly readTargetIndexes: readonly number[];
  readonly writeTargetIndexes: readonly number[];
  readonly dynamicTargetRead: boolean;
  readonly unresolvedSymbolOwnership: boolean;
}

export interface ProcedureCallSite extends EffectSite {
  readonly proccode: string | null;
  readonly resolution: 'resolved' | 'missing-code' | 'unresolved' | 'ambiguous';
  readonly calleeProcedureIds: readonly string[];
}

export interface ArgumentEvaluationHazard extends EffectSite {
  readonly inputNames: readonly string[];
  readonly reason: 'malformed-arguments' | 'observable-reporter' | 'shared-reporter';
}

export interface ProcedureCallGraphNode {
  readonly procedureId: string;
  readonly targetIndex: number;
  readonly definitionId: string;
  readonly prototypeId: string | null;
  readonly proccode: string | null;
  readonly warp: boolean | null;
  readonly malformed: boolean;
  readonly recursive: boolean;
  readonly stronglyConnectedComponent: number;
  readonly calls: readonly ProcedureCallSite[];
}

export interface RunnableEntry {
  readonly targetIndex: number;
  readonly blockId: string;
  readonly opcode: string;
  readonly kind: 'hat' | 'manual';
  readonly reentrant: boolean;
}

export interface ProjectEffectAnalysis {
  readonly procedures: readonly ProcedureCallGraphNode[];
  readonly runnableEntries: readonly RunnableEntry[];
  readonly concurrentTargetIndexes: readonly number[];
}

export interface RegionEffectSummary {
  readonly directBlockIds: readonly string[];
  readonly evaluatedBlockIds: readonly string[];
  readonly variableReads: readonly EffectSymbolReference[];
  readonly variableWrites: readonly EffectSymbolReference[];
  readonly listReads: readonly EffectSymbolReference[];
  readonly listWrites: readonly EffectSymbolReference[];
  readonly runtimeStateReads: readonly string[];
  readonly runtimeStateWrites: readonly string[];
  readonly yields: readonly EffectSite[];
  readonly redraws: readonly EffectSite[];
  readonly timers: readonly EffectSite[];
  readonly liveInputs: readonly EffectSite[];
  readonly randomSources: readonly EffectSite[];
  readonly broadcasts: readonly EffectSite[];
  readonly clones: readonly EffectSite[];
  readonly reentries: readonly EffectSite[];
  readonly concurrencyEffects: readonly EffectSite[];
  readonly unsupportedEffects: readonly EffectSite[];
  readonly procedureCalls: readonly ProcedureCallSite[];
  readonly argumentEvaluationHazards: readonly ArgumentEvaluationHazard[];
  readonly ownership: EffectTargetOwnership;
}

export type RegionRejectionCode =
  | 'ambiguous-procedure'
  | 'argument-evaluation'
  | 'block-missing'
  | 'block-not-object'
  | 'broadcast'
  | 'clone'
  | 'concurrent-target-owner'
  | 'dynamic-target-owner'
  | 'empty-region'
  | 'live-input'
  | 'random-source'
  | 'recursive-procedure'
  | 'symbol-owner-unresolved'
  | 'target-missing'
  | 'thread-control'
  | 'thread-reentry'
  | 'timer'
  | 'unsupported-opcode'
  | 'unresolved-procedure'
  | 'warp-procedure'
  | 'yield';

export interface RegionRejectionReason {
  readonly code: RegionRejectionCode;
  readonly message: string;
  readonly targetIndex: number;
  readonly blockId?: string;
  readonly opcode?: string;
  readonly procedureId?: string;
}

export interface RegionEffectRequest {
  readonly targetIndex: number;
  readonly blockIds: readonly string[];
  readonly connector?: LinearRunEntryConnector;
  readonly inputNamesByBlock?: Readonly<Record<string, readonly string[]>>;
}

export interface RegionEligibilityCertificate {
  readonly profile: RegionEligibilityProfile;
  readonly targetIndex: number;
  readonly blockIds: readonly string[];
  readonly connector?: LinearRunEntryConnector;
  readonly inputNamesByBlock?: Readonly<Record<string, readonly string[]>>;
  readonly eligible: boolean;
  readonly reasons: readonly RegionRejectionReason[];
  readonly effects: RegionEffectSummary;
  readonly owningEntry: RunnableEntry | null;
  readonly owningProcedureId: string | null;
  readonly sameTargetConcurrentEntries: readonly RunnableEntry[];
}

export interface CertifiedNestedLinearRun {
  readonly run: NestedLinearRun;
  readonly certificate: RegionEligibilityCertificate;
}

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

/** Discover straight-line runs inside top-level stacks and C-block branches. */
export function collectNestedLinearRuns(
  project: ScratchProject,
  options: NestedLinearRunOptions = {}
): NestedLinearRun[] {
  const requestedMinimum = options.minimumLength ?? 4;
  const minimumLength = Number.isFinite(requestedMinimum) ? Math.max(1, Math.trunc(requestedMinimum)) : 4;
  const runs: NestedLinearRun[] = [];

  for (const [targetIndex, target] of project.targets.entries()) {
    const claimed = new Set<string>();
    const visitedStackEntries = new Set<string>();

    const visitStack = (entryId: string, entryConnector: LinearRunEntryConnector): void => {
      if (visitedStackEntries.has(entryId)) return;
      visitedStackEntries.add(entryId);
      const visited = new Set<string>();
      let currentId: string | null = entryId;
      let predecessorId: string | null = null;
      let pending: string[] = [];
      let pendingConnector: LinearRunEntryConnector | null = null;

      const flush = (successorId: string | null): void => {
        if (pending.length >= minimumLength && pending.every(id => !claimed.has(id)) && pendingConnector) {
          const first = blockAt(target, pending[0] ?? '');
          if (first) {
            runs.push({
              targetIndex,
              blockIds: [...pending],
              predecessorId: pendingConnector.kind === 'top-level' ? null : pendingConnector.ownerId,
              successorId,
              wasTopLevel: pendingConnector.kind === 'top-level' && first.topLevel,
              connector: pendingConnector,
              ...(first.x === undefined ? {} : {x: first.x}),
              ...(first.y === undefined ? {} : {y: first.y})
            });
            for (const id of pending) claimed.add(id);
          }
        }
        pending = [];
        pendingConnector = null;
      };

      while (currentId !== null && !visited.has(currentId)) {
        visited.add(currentId);
        const current = blockAt(target, currentId);
        if (!current) {
          flush(currentId);
          break;
        }

        for (const inputName of ['SUBSTACK', 'SUBSTACK2'] as const) {
          const branchId = activeBlockId(current.inputs[inputName]);
          if (branchId) {
            visitStack(branchId, {kind: 'input', ownerId: currentId, inputName, blockId: branchId});
          }
        }

        if (isVirtualizableStackBlock(current)) {
          if (pending.length === 0) {
            pendingConnector = predecessorId === null
              ? entryConnector
              : {kind: 'next', ownerId: predecessorId, blockId: currentId};
          }
          pending.push(currentId);
        } else {
          flush(currentId);
        }
        predecessorId = currentId;
        currentId = current.next;
      }
      flush(currentId);
    };

    for (const [topId, topValue] of Object.entries(target.blocks)) {
      if (!isScratchBlock(topValue) || !topValue.topLevel) continue;
      if (topValue.opcode === 'procedures_definition') {
        if (options.includeProcedureBodies === true && topValue.next !== null) {
          visitStack(topValue.next, {kind: 'next', ownerId: topId, blockId: topValue.next});
        }
        continue;
      }
      visitStack(topId, {kind: 'top-level', blockId: topId});
    }
  }

  return runs;
}

/** Build a stable custom-procedure call graph and project entry inventory. */
export function analyzeProjectEffects(project: ScratchProject): ProjectEffectAnalysis {
  return buildProjectEffectAnalysis(project).publicAnalysis;
}

/**
 * Certify one region for a live rewrite. Lossy certificates require sampling and
 * scheduler transparency; no-preserve certificates waive sampling time but not
 * unknown calls, asynchronous anchors, or shared per-target dispatcher state.
 */
export function certifyRegionEffects(
  project: ScratchProject,
  request: RegionEffectRequest,
  profile: RegionEligibilityProfile,
  analysis?: ProjectEffectAnalysis
): RegionEligibilityCertificate {
  const internalAnalysis = buildProjectEffectAnalysis(project, analysis);
  return certifyRegionWithAnalysis(project, request, profile, internalAnalysis);
}

export function certifyRegionsEffects(
  project: ScratchProject,
  requests: readonly RegionEffectRequest[],
  profile: RegionEligibilityProfile
): RegionEligibilityCertificate[] {
  const internalAnalysis = buildProjectEffectAnalysis(project);
  return requests.map(request => certifyRegionWithAnalysis(project, request, profile, internalAnalysis));
}

export function collectCertifiedNestedLinearRuns(
  project: ScratchProject,
  profile: RegionEligibilityProfile,
  options: NestedLinearRunOptions = {}
): CertifiedNestedLinearRun[] {
  const internalAnalysis = buildProjectEffectAnalysis(project);
  return collectNestedLinearRuns(project, options).map(run => ({
    run,
    certificate: certifyRegionWithAnalysis(project, run, profile, internalAnalysis)
  }));
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

interface InternalProcedureNode {
  readonly procedureId: string;
  readonly targetIndex: number;
  readonly definitionId: string;
  readonly prototypeId: string | null;
  readonly proccode: string | null;
  readonly warp: boolean | null;
  malformed: boolean;
  calls: ProcedureCallSite[];
  recursive: boolean;
  stronglyConnectedComponent: number;
}

interface InternalProjectEffectAnalysis {
  readonly project: ScratchProject;
  readonly projectSignature: string;
  readonly publicAnalysis: ProjectEffectAnalysis;
  readonly procedures: readonly InternalProcedureNode[];
  readonly proceduresById: ReadonlyMap<string, InternalProcedureNode>;
  readonly proceduresByTargetAndCode: readonly ReadonlyMap<string, readonly InternalProcedureNode[]>[];
}

const PROJECT_EFFECT_INTERNALS = new WeakMap<ProjectEffectAnalysis, InternalProjectEffectAnalysis>();

interface MutableEffectAccumulator {
  readonly targetIndex: number;
  readonly directBlockIds: readonly string[];
  readonly evaluatedBlockIds: string[];
  readonly visitedBlocks: Set<string>;
  readonly visitedProcedures: Set<string>;
  readonly variableReads: Map<string, EffectSymbolReference>;
  readonly variableWrites: Map<string, EffectSymbolReference>;
  readonly listReads: Map<string, EffectSymbolReference>;
  readonly listWrites: Map<string, EffectSymbolReference>;
  readonly runtimeStateReads: Set<string>;
  readonly runtimeStateWrites: Set<string>;
  readonly yields: Map<string, EffectSite>;
  readonly redraws: Map<string, EffectSite>;
  readonly timers: Map<string, EffectSite>;
  readonly liveInputs: Map<string, EffectSite>;
  readonly randomSources: Map<string, EffectSite>;
  readonly broadcasts: Map<string, EffectSite>;
  readonly clones: Map<string, EffectSite>;
  readonly reentries: Map<string, EffectSite>;
  readonly concurrencyEffects: Map<string, EffectSite>;
  readonly unsupportedEffects: Map<string, EffectSite>;
  readonly procedureCalls: Map<string, ProcedureCallSite>;
  readonly argumentEvaluationHazards: Map<string, ArgumentEvaluationHazard>;
  readonly readTargetIndexes: Set<number>;
  readonly writeTargetIndexes: Set<number>;
  dynamicTargetRead: boolean;
  unresolvedSymbolOwnership: boolean;
}

interface MutableTemporalInfluence {
  readonly timers: Map<string, EffectSite>;
  readonly liveInputs: Map<string, EffectSite>;
  readonly randomSources: Map<string, EffectSite>;
  readonly unsupportedEffects: Map<string, EffectSite>;
  readonly procedureReasons: RegionRejectionReason[];
}

function buildProjectEffectAnalysis(
  project: ScratchProject,
  supplied?: ProjectEffectAnalysis
): InternalProjectEffectAnalysis {
  const projectSignature = effectGraphSignature(project);
  if (supplied) {
    const cached = PROJECT_EFFECT_INTERNALS.get(supplied);
    if (cached?.project === project && cached.projectSignature === projectSignature) return cached;
  }
  const procedures: InternalProcedureNode[] = [];
  const proceduresByTargetAndCode: Array<Map<string, InternalProcedureNode[]>> = project.targets.map(
    () => new Map<string, InternalProcedureNode[]>()
  );

  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [definitionId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_definition') continue;
      const prototypeId = activeBlockId(value.inputs['custom_block']);
      const prototype = prototypeId === undefined ? undefined : blockAt(target, prototypeId);
      const proccodeValue = prototype?.mutation?.['proccode'];
      const proccode = typeof proccodeValue === 'string' ? proccodeValue : null;
      const warp = parseWarp(prototype?.mutation?.['warp']);
      const argumentIds = parseStringArray(prototype?.mutation?.['argumentids']);
      const argumentNames = parseStringArray(prototype?.mutation?.['argumentnames']);
      const argumentDefaultsLength = parsedArrayLength(prototype?.mutation?.['argumentdefaults']);
      const procedureId = JSON.stringify([targetIndex, definitionId]);
      const malformed = prototype?.opcode !== 'procedures_prototype'
        || proccode === null
        || warp === null
        || argumentIds === undefined
        || argumentNames === undefined
        || argumentDefaultsLength === undefined
        || argumentIds.length !== argumentNames.length
        || argumentIds.length !== argumentDefaultsLength;
      const node: InternalProcedureNode = {
        procedureId,
        targetIndex,
        definitionId,
        prototypeId: prototype?.opcode === 'procedures_prototype' && prototypeId !== undefined ? prototypeId : null,
        proccode,
        warp,
        malformed,
        calls: [],
        recursive: false,
        stronglyConnectedComponent: -1
      };
      procedures.push(node);
      if (proccode !== null) {
        const byCode = proceduresByTargetAndCode[targetIndex];
        const sameCode = byCode?.get(proccode);
        if (sameCode) sameCode.push(node);
        else byCode?.set(proccode, [node]);
      }
    }
  }

  for (const byCode of proceduresByTargetAndCode) {
    for (const sameCode of byCode.values()) {
      if (sameCode.length > 1) {
        for (const node of sameCode) node.malformed = true;
      }
    }
  }

  for (const node of procedures) {
    const target = project.targets[node.targetIndex];
    const definition = target ? blockAt(target, node.definitionId) : undefined;
    if (!target || !definition || definition.next === null) continue;
    const calls = collectProcedureCallsInStack(target, node.targetIndex, definition.next, proceduresByTargetAndCode);
    node.calls = calls;
  }

  assignStronglyConnectedComponents(procedures);
  const runnableEntries = collectRunnableEntries(project);
  const counts = new Map<number, number>();
  for (const entry of runnableEntries) {
    if (entry.kind !== 'hat') continue;
    counts.set(entry.targetIndex, (counts.get(entry.targetIndex) ?? 0) + 1);
  }
  const concurrentTargetIndexes = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([targetIndex]) => targetIndex)
    .sort((left, right) => left - right);
  const generated: ProjectEffectAnalysis = {
    procedures: procedures.map(node => ({
      procedureId: node.procedureId,
      targetIndex: node.targetIndex,
      definitionId: node.definitionId,
      prototypeId: node.prototypeId,
      proccode: node.proccode,
      warp: node.warp,
      malformed: node.malformed,
      recursive: node.recursive,
      stronglyConnectedComponent: node.stronglyConnectedComponent,
      calls: [...node.calls]
    })),
    runnableEntries,
    concurrentTargetIndexes
  };
  const result: InternalProjectEffectAnalysis = {
    project,
    projectSignature,
    publicAnalysis: generated,
    procedures,
    proceduresById: new Map(procedures.map(node => [node.procedureId, node])),
    proceduresByTargetAndCode
  };
  PROJECT_EFFECT_INTERNALS.set(generated, result);
  return result;
}

function effectGraphSignature(project: ScratchProject): string {
  return JSON.stringify(project.targets.map(target => ({
    isStage: target.isStage,
    name: target.name,
    variables: Object.entries(target.variables).map(([id, declaration]) => [id, declaration[0]]),
    lists: Object.entries(target.lists).map(([id, declaration]) => [id, declaration[0]]),
    blocks: target.blocks
  })));
}

function parseWarp(value: JsonValue | undefined): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function activeBlockId(input: ScratchInput | undefined): string | undefined {
  const active = input?.[1];
  return typeof active === 'string' && active.length > 0 ? active : undefined;
}

function collectProcedureCallsInStack(
  target: ScratchTarget,
  targetIndex: number,
  entryId: string,
  proceduresByTargetAndCode: readonly ReadonlyMap<string, readonly InternalProcedureNode[]>[]
): ProcedureCallSite[] {
  const calls: ProcedureCallSite[] = [];
  const visited = new Set<string>();
  const visit = (blockId: string, followNext: boolean): void => {
    if (visited.has(blockId)) return;
    visited.add(blockId);
    const value = blockAt(target, blockId);
    if (!value) return;
    if (value.opcode === 'procedures_call') {
      calls.push(resolveProcedureCall(targetIndex, blockId, value, proceduresByTargetAndCode));
    }
    for (const input of Object.values(value.inputs)) {
      const childId = activeBlockId(input);
      if (childId) visit(childId, isSubstackInput(value, childId));
    }
    if (followNext && value.next !== null) visit(value.next, true);
  };
  visit(entryId, true);
  return calls;
}

function isSubstackInput(owner: ScratchBlock, childId: string): boolean {
  return activeBlockId(owner.inputs['SUBSTACK']) === childId || activeBlockId(owner.inputs['SUBSTACK2']) === childId;
}

function resolveProcedureCall(
  targetIndex: number,
  blockId: string,
  block: ScratchBlock,
  proceduresByTargetAndCode: readonly ReadonlyMap<string, readonly InternalProcedureNode[]>[]
): ProcedureCallSite {
  const code = block.mutation?.['proccode'];
  const proccode = typeof code === 'string' ? code : null;
  const matches = proccode === null ? [] : [...(proceduresByTargetAndCode[targetIndex]?.get(proccode) ?? [])];
  return {
    targetIndex,
    blockId,
    opcode: block.opcode,
    proccode,
    resolution: proccode === null ? 'missing-code' : matches.length === 0 ? 'unresolved' : matches.length === 1 ? 'resolved' : 'ambiguous',
    calleeProcedureIds: matches.map(node => node.procedureId)
  };
}

function assignStronglyConnectedComponents(procedures: readonly InternalProcedureNode[]): void {
  const nodesById = new Map(procedures.map(node => [node.procedureId, node]));
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (procedureId: string): void => {
    indexById.set(procedureId, nextIndex);
    lowLinkById.set(procedureId, nextIndex);
    nextIndex += 1;
    stack.push(procedureId);
    onStack.add(procedureId);
    const node = nodesById.get(procedureId);
    const callees = node?.calls.flatMap(call => call.resolution === 'resolved' ? call.calleeProcedureIds : []) ?? [];
    for (const calleeId of callees) {
      if (!indexById.has(calleeId)) {
        visit(calleeId);
        lowLinkById.set(procedureId, Math.min(requiredNumber(lowLinkById, procedureId), requiredNumber(lowLinkById, calleeId)));
      } else if (onStack.has(calleeId)) {
        lowLinkById.set(procedureId, Math.min(requiredNumber(lowLinkById, procedureId), requiredNumber(indexById, calleeId)));
      }
    }
    if (requiredNumber(lowLinkById, procedureId) !== requiredNumber(indexById, procedureId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      component.push(popped);
      if (popped === procedureId) break;
    }
    components.push(component);
  };

  for (const node of procedures) {
    if (!indexById.has(node.procedureId)) visit(node.procedureId);
  }
  const order = new Map(procedures.map((node, index) => [node.procedureId, index]));
  components.sort((left, right) => minimumProcedureOrder(left, order) - minimumProcedureOrder(right, order));
  for (const [componentIndex, component] of components.entries()) {
    const members = new Set(component);
    for (const procedureId of component) {
      const node = nodesById.get(procedureId);
      if (!node) continue;
      node.stronglyConnectedComponent = componentIndex;
      node.recursive = component.length > 1 || node.calls.some(call => call.calleeProcedureIds.some(id => members.has(id)));
    }
  }
}

function requiredNumber(map: ReadonlyMap<string, number>, key: string): number {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing call-graph number for ${key}`);
  return value;
}

function minimumProcedureOrder(component: readonly string[], order: ReadonlyMap<string, number>): number {
  let minimum = Number.MAX_SAFE_INTEGER;
  for (const procedureId of component) minimum = Math.min(minimum, order.get(procedureId) ?? minimum);
  return minimum;
}

function collectRunnableEntries(project: ScratchProject): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || !value.topLevel || value.opcode === 'procedures_definition' || value.opcode === 'procedures_prototype') continue;
      const hat = isRunnableHat(value.opcode);
      entries.push({
        targetIndex,
        blockId,
        opcode: value.opcode,
        kind: hat ? 'hat' : 'manual',
        reentrant: hat && value.opcode !== 'event_whenflagclicked'
      });
    }
  }
  return entries;
}

function certifyRegionWithAnalysis(
  project: ScratchProject,
  request: RegionEffectRequest,
  profile: RegionEligibilityProfile,
  analysis: InternalProjectEffectAnalysis
): RegionEligibilityCertificate {
  const reasons: RegionRejectionReason[] = [];
  const target = project.targets[request.targetIndex];
  const accumulator = createEffectAccumulator(request.targetIndex, request.blockIds);
  if (!target) {
    reasons.push(makeReason('target-missing', request.targetIndex));
  } else if (request.blockIds.length === 0) {
    reasons.push(makeReason('empty-region', request.targetIndex));
  } else {
    collectEffectsInto(project, target, request, accumulator, analysis, reasons);
  }

  const effects = finishEffects(accumulator);
  const owningEntry = target ? findOwningEntry(target, request.targetIndex, request.blockIds[0], analysis.publicAnalysis) : null;
  const owningProcedure = target ? findOwningProcedure(target, request.targetIndex, request.blockIds[0], analysis) : undefined;
  const sameTargetConcurrentEntries = analysis.publicAnalysis.runnableEntries.filter(entry => (
    entry.kind === 'hat'
    && entry.targetIndex === request.targetIndex
    && entry.blockId !== owningEntry?.blockId
  ));

  addEffectReasons(reasons, effects, profile);
  addProcedureReasons(reasons, effects.procedureCalls, analysis);
  if (owningProcedure) addProcedureNodeReasons(reasons, owningProcedure, request.targetIndex);
  if (profile === 'lossy' && reasons.length === 0 && target) {
    addForwardTemporalInfluenceReasons(project, target, request, analysis, reasons);
  }
  if (profile === 'no-preserve' && owningEntry?.reentrant === true) {
    reasons.push(makeReason('thread-reentry', request.targetIndex, owningEntry, undefined, 'the owning hat can be entered again while generated target-local state is live'));
  }
  if (profile === 'no-preserve' && sameTargetConcurrentEntries.length > 0) {
    const first = sameTargetConcurrentEntries[0];
    reasons.push(makeReason(
      'concurrent-target-owner',
      request.targetIndex,
      first,
      undefined,
      `target ${request.targetIndex} has another runnable hat ${quoted(first?.blockId ?? '')}`
    ));
  }

  const sortedReasons = dedupeAndSortReasons(reasons);
  return {
    profile,
    targetIndex: request.targetIndex,
    blockIds: [...request.blockIds],
    ...(request.connector === undefined ? {} : {connector: request.connector}),
    ...(request.inputNamesByBlock === undefined ? {} : {inputNamesByBlock: copyInputFilter(request.inputNamesByBlock)}),
    eligible: sortedReasons.length === 0,
    reasons: sortedReasons,
    effects,
    owningEntry,
    owningProcedureId: owningProcedure?.procedureId ?? null,
    sameTargetConcurrentEntries
  };
}

function copyInputFilter(
  inputNamesByBlock: Readonly<Record<string, readonly string[]>>
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(inputNamesByBlock).map(([blockId, inputNames]) => [blockId, [...inputNames]]));
}

function createEffectAccumulator(targetIndex: number, directBlockIds: readonly string[]): MutableEffectAccumulator {
  return {
    targetIndex,
    directBlockIds: [...directBlockIds],
    evaluatedBlockIds: [],
    visitedBlocks: new Set(),
    visitedProcedures: new Set(),
    variableReads: new Map(),
    variableWrites: new Map(),
    listReads: new Map(),
    listWrites: new Map(),
    runtimeStateReads: new Set(),
    runtimeStateWrites: new Set(),
    yields: new Map(),
    redraws: new Map(),
    timers: new Map(),
    liveInputs: new Map(),
    randomSources: new Map(),
    broadcasts: new Map(),
    clones: new Map(),
    reentries: new Map(),
    concurrencyEffects: new Map(),
    unsupportedEffects: new Map(),
    procedureCalls: new Map(),
    argumentEvaluationHazards: new Map(),
    readTargetIndexes: new Set(),
    writeTargetIndexes: new Set(),
    dynamicTargetRead: false,
    unresolvedSymbolOwnership: false
  };
}

function collectEffectsInto(
  project: ScratchProject,
  target: ScratchTarget,
  request: RegionEffectRequest,
  accumulator: MutableEffectAccumulator,
  analysis: InternalProjectEffectAnalysis,
  reasons: RegionRejectionReason[]
): void {
  const targetIndex = request.targetIndex;
  const visitInput = (ownerId: string, inputName: string, input: ScratchInput): void => {
    const active = input[1];
    if (isPrimitive(active)) {
      collectPrimitiveSymbol(project, targetIndex, active, accumulator, ownerId);
    } else if (typeof active === 'string') {
      visitBlock(active, inputName === 'SUBSTACK' || inputName === 'SUBSTACK2');
    }
  };

  const visitProcedure = (procedureId: string): void => {
    if (accumulator.visitedProcedures.has(procedureId)) return;
    accumulator.visitedProcedures.add(procedureId);
    const procedure = analysis.proceduresById.get(procedureId);
    if (!procedure || procedure.recursive) return;
    const procedureTarget = project.targets[procedure.targetIndex];
    const definition = procedureTarget ? blockAt(procedureTarget, procedure.definitionId) : undefined;
    if (!procedureTarget || !definition || definition.next === null || procedure.targetIndex !== targetIndex) return;
    visitBlock(definition.next, true);
  };

  const visitBlock = (blockId: string, followNext: boolean): void => {
    if (accumulator.visitedBlocks.has(blockId)) return;
    accumulator.visitedBlocks.add(blockId);
    const value = target.blocks[blockId];
    if (value === undefined) {
      reasons.push(makeReason('block-missing', targetIndex, {blockId, opcode: ''}));
      return;
    }
    if (!isScratchBlock(value)) {
      reasons.push(makeReason('block-not-object', targetIndex, {blockId, opcode: ''}));
      if (isPrimitive(value)) collectPrimitiveSymbol(project, targetIndex, value, accumulator, blockId);
      return;
    }
    accumulator.evaluatedBlockIds.push(blockId);
    collectBlockEffects(project, target, targetIndex, blockId, value, accumulator);
    const selectedInputNames = request.inputNamesByBlock?.[blockId];
    for (const [inputName, input] of Object.entries(value.inputs)) {
      if (selectedInputNames === undefined || selectedInputNames.includes(inputName)) visitInput(blockId, inputName, input);
    }

    if (value.opcode === 'procedures_call') {
      const call = resolveProcedureCall(targetIndex, blockId, value, analysis.proceduresByTargetAndCode);
      accumulator.procedureCalls.set(siteKey(call), call);
      const hazard = inspectArgumentEvaluationHazard(target, targetIndex, blockId, value);
      if (hazard) accumulator.argumentEvaluationHazards.set(siteKey(hazard), hazard);
      if (call.resolution === 'resolved') {
        const calleeId = call.calleeProcedureIds[0];
        if (calleeId !== undefined) visitProcedure(calleeId);
      }
    }
    if (followNext && value.next !== null) visitBlock(value.next, true);
  };

  for (const blockId of request.blockIds) visitBlock(blockId, false);
}

function collectBlockEffects(
  project: ScratchProject,
  target: ScratchTarget,
  targetIndex: number,
  blockId: string,
  block: ScratchBlock,
  accumulator: MutableEffectAccumulator
): void {
  const site: EffectSite = {targetIndex, blockId, opcode: block.opcode};
  const prefix = opcodePrefixOf(block.opcode);
  if (!OFFICIAL_CORE_OPCODES.has(block.opcode) && !OFFICIAL_LITERAL_SHADOW_OPCODES.has(block.opcode)) {
    accumulator.unsupportedEffects.set(siteKey(site), site);
  }
  if (YIELDING_OPCODES.has(block.opcode)) accumulator.yields.set(siteKey(site), site);
  if (REDRAW_OPCODES.has(block.opcode)) accumulator.redraws.set(siteKey(site), site);
  if (TIMER_OPCODES.has(block.opcode)) accumulator.timers.set(siteKey(site), site);
  if (LIVE_INPUT_OPCODES.has(block.opcode)) accumulator.liveInputs.set(siteKey(site), site);
  if (block.opcode === 'event_whengreaterthan') {
    const source = block.fields['WHENGREATERTHANMENU']?.[0];
    const normalizedSource = typeof source === 'string' ? source.toLowerCase() : '';
    if (normalizedSource === 'timer') accumulator.timers.set(siteKey(site), site);
    else if (normalizedSource === 'loudness') accumulator.liveInputs.set(siteKey(site), site);
    else {
      accumulator.timers.set(siteKey(site), site);
      accumulator.liveInputs.set(siteKey(site), site);
    }
  }
  if (block.opcode === 'operator_random') accumulator.randomSources.set(siteKey(site), site);
  if (BROADCAST_OPCODES.has(block.opcode)) accumulator.broadcasts.set(siteKey(site), site);
  if (CLONE_OPCODES.has(block.opcode)) accumulator.clones.set(siteKey(site), site);
  if (REENTRY_OPCODES.has(block.opcode)) accumulator.reentries.set(siteKey(site), site);
  if (THREAD_CONTROL_OPCODES.has(block.opcode) || BROADCAST_OPCODES.has(block.opcode) || CLONE_OPCODES.has(block.opcode)) {
    accumulator.concurrencyEffects.set(siteKey(site), site);
  }
  const runtimeRead = RUNTIME_STATE_READ_OPCODES.get(block.opcode);
  if (runtimeRead) accumulator.runtimeStateReads.add(runtimeRead);
  const runtimeWrite = RUNTIME_STATE_WRITE_OPCODES.get(block.opcode);
  if (runtimeWrite) accumulator.runtimeStateWrites.add(runtimeWrite);

  const variableField = block.fields['VARIABLE'];
  if (variableField && VARIABLE_READ_OPCODES.has(block.opcode)) {
    addResolvedSymbol(project, targetIndex, 'variable', variableField, accumulator.variableReads, accumulator);
  }
  if (variableField && VARIABLE_WRITE_OPCODES.has(block.opcode)) {
    addResolvedSymbol(project, targetIndex, 'variable', variableField, accumulator.variableWrites, accumulator);
  }
  const listField = block.fields['LIST'];
  if (listField && LIST_READ_OPCODES.has(block.opcode)) {
    addResolvedSymbol(project, targetIndex, 'list', listField, accumulator.listReads, accumulator);
  }
  if (listField && LIST_WRITE_OPCODES.has(block.opcode)) {
    addResolvedSymbol(project, targetIndex, 'list', listField, accumulator.listWrites, accumulator);
  }

  if (OWNER_TARGET_READ_PREFIXES.has(prefix)) accumulator.readTargetIndexes.add(targetIndex);
  if (REDRAW_OPCODES.has(block.opcode) || SOUND_TARGET_WRITE_OPCODES.has(block.opcode) || block.opcode === 'sensing_setdragmode') {
    accumulator.writeTargetIndexes.add(targetIndex);
  }
  if (block.opcode === 'looks_nextbackdrop' || block.opcode === 'looks_switchbackdropto' || block.opcode === 'looks_switchbackdroptoandwait') {
    const stageIndex = project.targets.findIndex(candidate => candidate.isStage);
    if (stageIndex >= 0) accumulator.writeTargetIndexes.add(stageIndex);
  }

  collectSelectorEffects(project, target, targetIndex, blockId, block, site, accumulator);
  if (LIST_INDEX_OPCODES.has(block.opcode)) collectListIndexRandomness(target, blockId, block, site, accumulator);
  if (block.opcode === 'sensing_of') collectSensingOfOwnership(project, target, targetIndex, blockId, block, accumulator);
}

function finishEffects(accumulator: MutableEffectAccumulator): RegionEffectSummary {
  const sortSymbols = (values: Iterable<EffectSymbolReference>): EffectSymbolReference[] => [...values].sort(compareSymbols);
  return {
    directBlockIds: [...accumulator.directBlockIds],
    evaluatedBlockIds: [...accumulator.evaluatedBlockIds],
    variableReads: sortSymbols(accumulator.variableReads.values()),
    variableWrites: sortSymbols(accumulator.variableWrites.values()),
    listReads: sortSymbols(accumulator.listReads.values()),
    listWrites: sortSymbols(accumulator.listWrites.values()),
    runtimeStateReads: [...accumulator.runtimeStateReads].sort(compareText),
    runtimeStateWrites: [...accumulator.runtimeStateWrites].sort(compareText),
    yields: sortSites(accumulator.yields.values()),
    redraws: sortSites(accumulator.redraws.values()),
    timers: sortSites(accumulator.timers.values()),
    liveInputs: sortSites(accumulator.liveInputs.values()),
    randomSources: sortSites(accumulator.randomSources.values()),
    broadcasts: sortSites(accumulator.broadcasts.values()),
    clones: sortSites(accumulator.clones.values()),
    reentries: sortSites(accumulator.reentries.values()),
    concurrencyEffects: sortSites(accumulator.concurrencyEffects.values()),
    unsupportedEffects: sortSites(accumulator.unsupportedEffects.values()),
    procedureCalls: [...accumulator.procedureCalls.values()].sort(compareSites),
    argumentEvaluationHazards: [...accumulator.argumentEvaluationHazards.values()].sort(compareSites),
    ownership: {
      executionTargetIndex: accumulator.targetIndex,
      readTargetIndexes: [...accumulator.readTargetIndexes].sort((left, right) => left - right),
      writeTargetIndexes: [...accumulator.writeTargetIndexes].sort((left, right) => left - right),
      dynamicTargetRead: accumulator.dynamicTargetRead,
      unresolvedSymbolOwnership: accumulator.unresolvedSymbolOwnership
    }
  };
}

function collectPrimitiveSymbol(
  project: ScratchProject,
  targetIndex: number,
  primitive: ScratchInput,
  accumulator: MutableEffectAccumulator,
  ownerId: string
): void {
  if (primitive[0] !== 12 && primitive[0] !== 13) return;
  const kind = primitive[0] === 12 ? 'variable' : 'list';
  const field: JsonValue[] = [primitive[1] ?? '', primitive[2] ?? ''];
  const destination = kind === 'variable' ? accumulator.variableReads : accumulator.listReads;
  addResolvedSymbol(project, targetIndex, kind, field, destination, accumulator);
  if (primitive[2] === undefined) {
    accumulator.unsupportedEffects.set(
      `${targetIndex}\u0000${ownerId}\u0000inline-${kind}`,
      {targetIndex, blockId: ownerId, opcode: `inline-${kind}`}
    );
  }
}

function addResolvedSymbol(
  project: ScratchProject,
  usageTargetIndex: number,
  kind: 'variable' | 'list',
  field: readonly JsonValue[],
  destination: Map<string, EffectSymbolReference>,
  accumulator: MutableEffectAccumulator
): void {
  const name = field[0] === undefined ? '' : typeof field[0] === 'string' ? field[0] : scratchString(field[0]);
  const id = typeof field[1] === 'string' ? field[1] : '';
  const symbol = resolveEffectSymbol(project, usageTargetIndex, kind, id, name);
  destination.set(symbolKey(symbol), symbol);
  if (symbol.targetIndex === null) {
    accumulator.unresolvedSymbolOwnership = true;
  } else {
    if (destination === accumulator.variableWrites || destination === accumulator.listWrites) {
      accumulator.writeTargetIndexes.add(symbol.targetIndex);
    } else {
      accumulator.readTargetIndexes.add(symbol.targetIndex);
    }
  }
}

function resolveEffectSymbol(
  project: ScratchProject,
  usageTargetIndex: number,
  kind: 'variable' | 'list',
  id: string,
  name: string
): EffectSymbolReference {
  const usageTarget = project.targets[usageTargetIndex];
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const declarationsFor = (targetIndex: number): Record<string, JsonValue[]> | undefined => {
    const target = project.targets[targetIndex];
    return target ? (kind === 'variable' ? target.variables : target.lists) : undefined;
  };
  const candidates: number[] = [];
  if (usageTarget) candidates.push(usageTargetIndex);
  if (stageIndex >= 0 && stageIndex !== usageTargetIndex) candidates.push(stageIndex);
  for (const targetIndex of candidates) {
    const declarations = declarationsFor(targetIndex);
    if (declarations && id.length > 0 && Object.prototype.hasOwnProperty.call(declarations, id)) {
      const declaredName = declarations[id]?.[0];
      return {
        kind,
        targetIndex,
        scope: project.targets[targetIndex]?.isStage === true ? 'stage' : 'target',
        id,
        name: typeof declaredName === 'string' ? declaredName : name
      };
    }
  }
  if (name.length > 0) {
    for (const targetIndex of candidates) {
      const declarations = declarationsFor(targetIndex);
      if (!declarations) continue;
      const matches = Object.entries(declarations).filter(([, declaration]) => declaration[0] === name);
      if (matches.length === 1) {
        return {
          kind,
          targetIndex,
          scope: project.targets[targetIndex]?.isStage === true ? 'stage' : 'target',
          id: matches[0]?.[0] ?? id,
          name
        };
      }
      if (matches.length > 1) break;
    }
  }
  return {kind, targetIndex: null, scope: 'unresolved', id, name};
}

function collectSelectorEffects(
  project: ScratchProject,
  target: ScratchTarget,
  targetIndex: number,
  blockId: string,
  block: ScratchBlock,
  site: EffectSite,
  accumulator: MutableEffectAccumulator
): void {
  const selector = selectorInput(block);
  if (!selector) return;
  const input = block.inputs[selector.inputName];
  if (!input) return;
  const evaluate = staticInputEvaluator(target);
  const selected = evaluate(blockId, input);
  if (selected === undefined) {
    accumulator.dynamicTargetRead = true;
    for (const index of project.targets.keys()) accumulator.readTargetIndexes.add(index);
    if (selector.mouse) accumulator.liveInputs.set(siteKey(site), site);
    if (selector.random) accumulator.randomSources.set(siteKey(site), site);
    return;
  }
  const value = String(selected);
  if (selector.mouse && value === '_mouse_') accumulator.liveInputs.set(siteKey(site), site);
  if (selector.random && (value === '_random_' || value === 'random backdrop')) {
    accumulator.randomSources.set(siteKey(site), site);
  }
  if (value === '_mouse_' || value === '_random_' || value === '_myself_' || value === 'random backdrop') return;
  const selectedTarget = value === '_stage_'
    ? project.targets.find(candidate => candidate.isStage)
    : project.targets.find(candidate => !candidate.isStage && candidate.name === value);
  if (selectedTarget) accumulator.readTargetIndexes.add(project.targets.indexOf(selectedTarget));
  if (selector.clone && !selectedTarget) accumulator.dynamicTargetRead = true;
  if (selector.clone && selectedTarget) accumulator.writeTargetIndexes.add(project.targets.indexOf(selectedTarget));
  if (selector.clone && value === '_myself_') accumulator.writeTargetIndexes.add(targetIndex);
}

function selectorInput(block: ScratchBlock): {
  readonly inputName: string;
  readonly mouse: boolean;
  readonly random: boolean;
  readonly clone: boolean;
} | undefined {
  switch (block.opcode) {
    case 'control_create_clone_of': return {inputName: 'CLONE_OPTION', mouse: false, random: false, clone: true};
    case 'looks_switchbackdropto':
    case 'looks_switchbackdroptoandwait': return {inputName: 'BACKDROP', mouse: false, random: true, clone: false};
    case 'motion_glideto':
    case 'motion_goto': return {inputName: 'TO', mouse: true, random: true, clone: false};
    case 'motion_pointtowards': return {inputName: 'TOWARDS', mouse: true, random: true, clone: false};
    case 'sensing_distanceto': return {inputName: 'DISTANCETOMENU', mouse: true, random: false, clone: false};
    default: return undefined;
  }
}

function collectListIndexRandomness(
  target: ScratchTarget,
  blockId: string,
  block: ScratchBlock,
  site: EffectSite,
  accumulator: MutableEffectAccumulator
): void {
  const index = block.inputs['INDEX'];
  if (!index) return;
  const value = staticInputEvaluator(target)(blockId, index);
  if (value === undefined || value === 'random' || value === 'any') {
    accumulator.randomSources.set(siteKey(site), site);
  }
}

function collectSensingOfOwnership(
  project: ScratchProject,
  target: ScratchTarget,
  targetIndex: number,
  blockId: string,
  block: ScratchBlock,
  accumulator: MutableEffectAccumulator
): void {
  const selection = sensingBlockSelection(project, target, blockId, block.inputs['OBJECT'], staticInputEvaluator(target));
  const property = block.fields['PROPERTY']?.[0];
  if (selection.kind === 'dynamic') {
    accumulator.dynamicTargetRead = true;
    for (const index of project.targets.keys()) accumulator.readTargetIndexes.add(index);
    return;
  }
  if (selection.kind !== 'target') return;
  const selectedIndex = project.targets.indexOf(selection.target);
  if (selectedIndex >= 0) accumulator.readTargetIndexes.add(selectedIndex);
  if (typeof property !== 'string' || isNativeSensingAttribute(selection.target, property)) return;
  const matches = Object.entries(selection.target.variables).filter(([, declaration]) => declaration[0] === property);
  if (matches.length !== 1 || selectedIndex < 0) {
    accumulator.unresolvedSymbolOwnership = true;
    return;
  }
  const entry = matches[0];
  if (!entry) return;
  const symbol: EffectSymbolReference = {
    kind: 'variable',
    targetIndex: selectedIndex,
    scope: selection.target.isStage ? 'stage' : 'target',
    id: entry[0],
    name: property
  };
  accumulator.variableReads.set(symbolKey(symbol), symbol);
}

function inspectArgumentEvaluationHazard(
  target: ScratchTarget,
  targetIndex: number,
  blockId: string,
  block: ScratchBlock
): ArgumentEvaluationHazard | undefined {
  const inputNames = Object.keys(block.inputs);
  const argumentIds = parseStringArray(block.mutation?.['argumentids']);
  if (
    argumentIds === undefined
    || argumentIds.length !== inputNames.length
    || argumentIds.some((id, index) => id !== inputNames[index])
  ) {
    return {targetIndex, blockId, opcode: block.opcode, inputNames, reason: 'malformed-arguments'};
  }
  const reporterIds = inputNames.flatMap(inputName => {
    const active = block.inputs[inputName]?.[1];
    return typeof active === 'string' ? [active] : [];
  });
  if (new Set(reporterIds).size !== reporterIds.length) {
    return {targetIndex, blockId, opcode: block.opcode, inputNames, reason: 'shared-reporter'};
  }
  for (const inputName of inputNames) {
    const active = block.inputs[inputName]?.[1];
    if (typeof active === 'string' && reporterHasObservableEvaluation(target, active, new Set())) {
      return {targetIndex, blockId, opcode: block.opcode, inputNames, reason: 'observable-reporter'};
    }
  }
  return undefined;
}

function parseStringArray(value: JsonValue | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return undefined;
    const strings = parsed as string[];
    return new Set(strings).size === strings.length ? strings : undefined;
  } catch {
    return undefined;
  }
}

function parsedArrayLength(value: JsonValue | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

function reporterHasObservableEvaluation(target: ScratchTarget, blockId: string, visited: Set<string>): boolean {
  if (visited.has(blockId)) return true;
  visited.add(blockId);
  const block = blockAt(target, blockId);
  if (!block || block.next !== null) return true;
  if (
    !OFFICIAL_CORE_OPCODES.has(block.opcode)
    || YIELDING_OPCODES.has(block.opcode)
    || TIMER_OPCODES.has(block.opcode)
    || LIVE_INPUT_OPCODES.has(block.opcode)
    || block.opcode === 'operator_random'
    || BROADCAST_OPCODES.has(block.opcode)
    || CLONE_OPCODES.has(block.opcode)
    || THREAD_CONTROL_OPCODES.has(block.opcode)
    || block.opcode === 'procedures_call'
  ) return true;
  if (LIST_INDEX_OPCODES.has(block.opcode)) {
    const index = block.inputs['INDEX'];
    const value = index ? staticInputEvaluator(target)(blockId, index) : undefined;
    if (index && (value === undefined || value === 'random' || value === 'any')) return true;
  }
  for (const input of Object.values(block.inputs)) {
    const childId = activeBlockId(input);
    if (childId && reporterHasObservableEvaluation(target, childId, visited)) return true;
  }
  return false;
}

function addForwardTemporalInfluenceReasons(
  project: ScratchProject,
  target: ScratchTarget,
  request: RegionEffectRequest,
  analysis: InternalProjectEffectAnalysis,
  reasons: RegionRejectionReason[]
): void {
  const influence = collectForwardTemporalInfluence(project, target, request, analysis);
  for (const site of influence.unsupportedEffects.values()) {
    reasons.push(makeReason('unsupported-opcode', site.targetIndex, site));
  }
  for (const site of influence.timers.values()) reasons.push(makeReason('timer', site.targetIndex, site));
  for (const site of influence.liveInputs.values()) reasons.push(makeReason('live-input', site.targetIndex, site));
  for (const site of influence.randomSources.values()) reasons.push(makeReason('random-source', site.targetIndex, site));
  reasons.push(...influence.procedureReasons);
}

function collectForwardTemporalInfluence(
  project: ScratchProject,
  target: ScratchTarget,
  request: RegionEffectRequest,
  analysis: InternalProjectEffectAnalysis
): MutableTemporalInfluence {
  const targetIndex = request.targetIndex;
  const directIds = new Set(request.blockIds);
  const influence: MutableTemporalInfluence = {
    timers: new Map(),
    liveInputs: new Map(),
    randomSources: new Map(),
    unsupportedEffects: new Map(),
    procedureReasons: []
  };
  const reporterVisited = new Set<string>();
  const stackMemo = new Map<string, boolean>();
  const stackVisiting = new Set<string>();
  const structuralVisiting = new Set<string>();
  const procedureReachabilityMemo = new Map<string, boolean>();
  const procedureReachabilityVisiting = new Set<string>();
  const evaluateStaticInput = staticInputEvaluator(target);

  const mergeSites = (destination: Map<string, EffectSite>, source: ReadonlyMap<string, EffectSite>): void => {
    for (const [key, site] of source) destination.set(key, site);
  };

  const recordBlock = (blockId: string, block: ScratchBlock): void => {
    if (directIds.has(blockId)) return;
    const accumulator = createEffectAccumulator(targetIndex, [blockId]);
    collectBlockEffects(project, target, targetIndex, blockId, block, accumulator);
    mergeSites(influence.timers, accumulator.timers);
    mergeSites(influence.liveInputs, accumulator.liveInputs);
    mergeSites(influence.randomSources, accumulator.randomSources);
    mergeSites(influence.unsupportedEffects, accumulator.unsupportedEffects);
  };

  const scanReporter = (blockId: string): void => {
    if (reporterVisited.has(blockId) || directIds.has(blockId)) return;
    reporterVisited.add(blockId);
    const block = blockAt(target, blockId);
    if (!block) return;
    recordBlock(blockId, block);
    for (const [inputName, input] of Object.entries(block.inputs)) {
      if (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2') continue;
      const childId = activeBlockId(input);
      if (childId) scanReporter(childId);
    }
  };

  const scanReporterInputs = (block: ScratchBlock, skippedInputNames: ReadonlySet<string> = new Set()): void => {
    for (const [inputName, input] of Object.entries(block.inputs)) {
      if (skippedInputNames.has(inputName) || inputName === 'SUBSTACK' || inputName === 'SUBSTACK2') continue;
      const childId = activeBlockId(input);
      if (childId) scanReporter(childId);
    }
  };

  const scanProcedureCall = (blockId: string, block: ScratchBlock): boolean => {
    const call = resolveProcedureCall(targetIndex, blockId, block, analysis.proceduresByTargetAndCode);
    if (call.resolution === 'ambiguous') {
      influence.procedureReasons.push(makeReason('ambiguous-procedure', targetIndex, call));
      return false;
    }
    if (call.resolution !== 'resolved') {
      influence.procedureReasons.push(makeReason('unresolved-procedure', targetIndex, call));
      return false;
    }
    const procedureId = call.calleeProcedureIds[0];
    const procedure = procedureId === undefined ? undefined : analysis.proceduresById.get(procedureId);
    if (!procedure || procedure.malformed) {
      influence.procedureReasons.push(makeReason('unresolved-procedure', targetIndex, call, procedureId));
      return false;
    }
    if (procedure.recursive) {
      influence.procedureReasons.push(makeReason('recursive-procedure', targetIndex, call, procedure.procedureId));
      return false;
    }
    const definition = blockAt(target, procedure.definitionId);
    return definition?.next === null || definition?.next === undefined ? true : scanStack(definition.next);
  };

  const scanBranch = (block: ScratchBlock, inputName: 'SUBSTACK' | 'SUBSTACK2'): boolean => {
    const branchId = activeBlockId(block.inputs[inputName]);
    return branchId === undefined ? true : scanStack(branchId);
  };

  const staticControlValue = (blockId: string, block: ScratchBlock, inputName: string): boolean | number | string | undefined => {
    const input = block.inputs[inputName];
    return input === undefined ? undefined : evaluateStaticInput(blockId, input);
  };

  const loopPathsBeforeYield = (
    blockId: string,
    block: ScratchBlock
  ): {readonly entersBranch: boolean; readonly reachesContinuation: boolean} => {
    if (block.opcode === 'control_forever') return {entersBranch: true, reachesContinuation: false};
    if (block.opcode === 'control_repeat') {
      const value = staticControlValue(blockId, block, 'TIMES');
      if (value === undefined) return {entersBranch: true, reachesContinuation: true};
      const entersBranch = Math.round(scratchNumber(value)) > 0;
      return {entersBranch, reachesContinuation: !entersBranch};
    }
    if (block.opcode === 'control_for_each') {
      const value = staticControlValue(blockId, block, 'VALUE');
      if (value === undefined) return {entersBranch: true, reachesContinuation: true};
      const entersBranch = scratchNumber(value) > 0;
      return {entersBranch, reachesContinuation: !entersBranch};
    }
    if (block.opcode === 'control_repeat_until') {
      const value = staticControlValue(blockId, block, 'CONDITION');
      if (value === undefined) return {entersBranch: true, reachesContinuation: true};
      const reachesContinuation = scratchBoolean(value);
      return {entersBranch: !reachesContinuation, reachesContinuation};
    }
    if (block.opcode === 'control_while') {
      const value = staticControlValue(blockId, block, 'CONDITION');
      if (value === undefined) return {entersBranch: true, reachesContinuation: true};
      const entersBranch = scratchBoolean(value);
      return {entersBranch, reachesContinuation: !entersBranch};
    }
    return {entersBranch: true, reachesContinuation: false};
  };

  const executeBlock = (blockId: string, block: ScratchBlock, after: () => boolean): boolean => {
    if (block.opcode === 'procedures_call') {
      return scanProcedureCall(blockId, block) ? after() : false;
    }
    if (block.opcode === 'control_if') {
      const condition = staticControlValue(blockId, block, 'CONDITION');
      if (condition !== undefined && scratchBoolean(condition)) {
        return scanBranch(block, 'SUBSTACK') ? after() : false;
      }
      if (condition === undefined) scanBranch(block, 'SUBSTACK');
      return after();
    }
    if (block.opcode === 'control_if_else') {
      const condition = staticControlValue(blockId, block, 'CONDITION');
      if (condition !== undefined) {
        return scanBranch(block, scratchBoolean(condition) ? 'SUBSTACK' : 'SUBSTACK2') ? after() : false;
      }
      const leftFallsThrough = scanBranch(block, 'SUBSTACK');
      const rightFallsThrough = scanBranch(block, 'SUBSTACK2');
      return leftFallsThrough || rightFallsThrough ? after() : false;
    }
    if (block.opcode === 'control_all_at_once') {
      return scanBranch(block, 'SUBSTACK') ? after() : false;
    }
    if (
      block.opcode === 'control_for_each'
      || block.opcode === 'control_forever'
      || block.opcode === 'control_repeat'
      || block.opcode === 'control_repeat_until'
      || block.opcode === 'control_while'
    ) {
      const paths = loopPathsBeforeYield(blockId, block);
      if (paths.entersBranch) scanBranch(block, 'SUBSTACK');
      return paths.reachesContinuation ? after() : false;
    }
    if (block.opcode === 'control_wait_until') {
      const condition = staticControlValue(blockId, block, 'CONDITION');
      return condition === undefined || scratchBoolean(condition) ? after() : false;
    }
    if (YIELDING_OPCODES.has(block.opcode)) return false;
    if (
      BROADCAST_OPCODES.has(block.opcode)
      || CLONE_OPCODES.has(block.opcode)
      || REENTRY_OPCODES.has(block.opcode)
      || THREAD_CONTROL_OPCODES.has(block.opcode)
    ) return false;
    return after();
  };

  function scanStack(blockId: string): boolean {
    const memoized = stackMemo.get(blockId);
    if (memoized !== undefined) return memoized;
    if (stackVisiting.has(blockId)) return false;
    stackVisiting.add(blockId);
    const block = blockAt(target, blockId);
    if (!block) {
      stackVisiting.delete(blockId);
      stackMemo.set(blockId, false);
      return false;
    }
    if (!directIds.has(blockId)) {
      recordBlock(blockId, block);
      scanReporterInputs(block);
    }
    const result = directIds.has(blockId)
      ? block.next === null ? true : scanStack(block.next)
      : executeBlock(blockId, block, () => block.next === null ? true : scanStack(block.next));
    stackVisiting.delete(blockId);
    stackMemo.set(blockId, result);
    return result;
  }

  const scanParentAfterInput = (parentId: string, parent: ScratchBlock, completedInputName: string): boolean => {
    recordBlock(parentId, parent);
    scanReporterInputs(parent, new Set([completedInputName]));
    return executeBlock(parentId, parent, () => scanAfterCompletedBlock(parentId));
  };

  const callSitesForProcedure = (procedureId: string): string[] => {
    const result: string[] = [];
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
      const call = resolveProcedureCall(targetIndex, blockId, value, analysis.proceduresByTargetAndCode);
      if (call.resolution === 'resolved' && call.calleeProcedureIds[0] === procedureId) result.push(blockId);
    }
    return result;
  };

  const procedureIsRunnable = (procedureId: string): boolean => {
    const memoized = procedureReachabilityMemo.get(procedureId);
    if (memoized !== undefined) return memoized;
    if (procedureReachabilityVisiting.has(procedureId)) return false;
    procedureReachabilityVisiting.add(procedureId);
    let runnable = false;
    for (const callSiteId of callSitesForProcedure(procedureId)) {
      if (findOwningEntry(target, targetIndex, callSiteId, analysis.publicAnalysis)) {
        runnable = true;
        break;
      }
      const owner = findOwningProcedure(target, targetIndex, callSiteId, analysis);
      if (owner && procedureIsRunnable(owner.procedureId)) {
        runnable = true;
        break;
      }
    }
    procedureReachabilityVisiting.delete(procedureId);
    procedureReachabilityMemo.set(procedureId, runnable);
    return runnable;
  };

  const scanProcedureReturnContinuations = (definitionId: string): boolean => {
    const procedure = analysis.procedures.find(candidate => (
      candidate.targetIndex === targetIndex && candidate.definitionId === definitionId
    ));
    if (!procedure || !procedureIsRunnable(procedure.procedureId)) return true;
    let reachesBoundaryFreeEnd = false;
    for (const callSiteId of callSitesForProcedure(procedure.procedureId)) {
      const owningEntry = findOwningEntry(target, targetIndex, callSiteId, analysis.publicAnalysis);
      const owningProcedure = findOwningProcedure(target, targetIndex, callSiteId, analysis);
      if (!owningEntry && (!owningProcedure || !procedureIsRunnable(owningProcedure.procedureId))) continue;
      if (scanAfterCompletedBlock(callSiteId)) reachesBoundaryFreeEnd = true;
    }
    return reachesBoundaryFreeEnd;
  };

  function scanAfterCompletedBlock(blockId: string): boolean {
    if (structuralVisiting.has(blockId)) return false;
    structuralVisiting.add(blockId);
    const block = blockAt(target, blockId);
    if (!block) {
      structuralVisiting.delete(blockId);
      return false;
    }
    if (block.next !== null && !directIds.has(block.next)) {
      const result = scanStack(block.next);
      structuralVisiting.delete(blockId);
      return result;
    }

    let childId = blockId;
    let parentId = block.parent;
    while (parentId !== null) {
      const parent = blockAt(target, parentId);
      if (!parent) {
        structuralVisiting.delete(blockId);
        return false;
      }
      if (parent.next === childId) {
        childId = parentId;
        parentId = parent.parent;
        continue;
      }
      const attachment = Object.entries(parent.inputs).find(([, input]) => activeBlockId(input) === childId);
      if (!attachment) {
        structuralVisiting.delete(blockId);
        return false;
      }
      const [inputName] = attachment;
      if (inputName === 'SUBSTACK' || inputName === 'SUBSTACK2') {
        const result = parent.next === null ? scanAfterCompletedBlock(parentId) : scanStack(parent.next);
        structuralVisiting.delete(blockId);
        return result;
      }
      const result = scanParentAfterInput(parentId, parent, inputName);
      structuralVisiting.delete(blockId);
      return result;
    }
    const root = blockAt(target, childId);
    if (root?.opcode === 'procedures_definition') {
      const result = scanProcedureReturnContinuations(childId);
      structuralVisiting.delete(blockId);
      return result;
    }
    structuralVisiting.delete(blockId);
    return true;
  }

  const owningProcedure = findOwningProcedure(target, targetIndex, request.blockIds[0], analysis);
  if (owningProcedure && !procedureIsRunnable(owningProcedure.procedureId)) return influence;

  for (const blockId of request.blockIds) {
    const block = blockAt(target, blockId);
    if (!block) continue;
    const selectedInputNames = request.inputNamesByBlock?.[blockId];
    if (selectedInputNames !== undefined) {
      scanReporterInputs(block, new Set(selectedInputNames));
      executeBlock(blockId, block, () => scanAfterCompletedBlock(blockId));
      continue;
    }
    if (block.next === null || !directIds.has(block.next)) scanAfterCompletedBlock(blockId);
  }

  return influence;
}

function scratchNumber(value: boolean | number | string): number {
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
  const result = Number(value);
  return Number.isNaN(result) ? 0 : result;
}

function scratchBoolean(value: boolean | number | string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  return Boolean(value);
}

function addEffectReasons(
  reasons: RegionRejectionReason[],
  effects: RegionEffectSummary,
  profile: RegionEligibilityProfile
): void {
  for (const site of effects.unsupportedEffects) reasons.push(makeReason('unsupported-opcode', site.targetIndex, site));
  for (const site of effects.yields) reasons.push(makeReason('yield', site.targetIndex, site));
  for (const site of effects.broadcasts) reasons.push(makeReason('broadcast', site.targetIndex, site));
  for (const site of effects.clones) reasons.push(makeReason('clone', site.targetIndex, site));
  for (const site of effects.reentries) reasons.push(makeReason('thread-reentry', site.targetIndex, site));
  for (const site of effects.concurrencyEffects) {
    if (
      effects.broadcasts.some(candidate => siteKey(candidate) === siteKey(site))
      || effects.clones.some(candidate => siteKey(candidate) === siteKey(site))
      || effects.reentries.some(candidate => siteKey(candidate) === siteKey(site))
    ) continue;
    reasons.push(makeReason('thread-control', site.targetIndex, site));
  }
  if (profile === 'lossy') {
    for (const site of effects.timers) reasons.push(makeReason('timer', site.targetIndex, site));
    for (const site of effects.liveInputs) reasons.push(makeReason('live-input', site.targetIndex, site));
    for (const site of effects.randomSources) reasons.push(makeReason('random-source', site.targetIndex, site));
  }
  for (const hazard of effects.argumentEvaluationHazards) {
    reasons.push(makeReason(
      'argument-evaluation',
      hazard.targetIndex,
      hazard,
      undefined,
      `procedure arguments at ${quoted(hazard.blockId)} have a ${hazard.reason} hazard`
    ));
  }
  if (effects.ownership.dynamicTargetRead) reasons.push(makeReason('dynamic-target-owner', effects.ownership.executionTargetIndex));
  if (effects.ownership.unresolvedSymbolOwnership) reasons.push(makeReason('symbol-owner-unresolved', effects.ownership.executionTargetIndex));
}

function addProcedureReasons(
  reasons: RegionRejectionReason[],
  calls: readonly ProcedureCallSite[],
  analysis: InternalProjectEffectAnalysis
): void {
  const visitedProcedures = new Set<string>();
  const inspectProcedure = (
    procedure: InternalProcedureNode,
    callSite: {readonly blockId: string; readonly opcode: string}
  ): void => {
    if (visitedProcedures.has(procedure.procedureId)) return;
    visitedProcedures.add(procedure.procedureId);
    addProcedureNodeReasons(reasons, procedure, procedure.targetIndex, callSite);
    for (const nestedCall of procedure.calls) {
      if (nestedCall.resolution === 'ambiguous') {
        reasons.push(makeReason('ambiguous-procedure', nestedCall.targetIndex, nestedCall));
        continue;
      }
      if (nestedCall.resolution !== 'resolved') {
        reasons.push(makeReason('unresolved-procedure', nestedCall.targetIndex, nestedCall));
        continue;
      }
      const nestedId = nestedCall.calleeProcedureIds[0];
      const nested = nestedId === undefined ? undefined : analysis.proceduresById.get(nestedId);
      if (!nested) reasons.push(makeReason('unresolved-procedure', nestedCall.targetIndex, nestedCall, nestedId));
      else inspectProcedure(nested, nestedCall);
    }
  };

  for (const call of calls) {
    if (call.resolution === 'ambiguous') {
      reasons.push(makeReason('ambiguous-procedure', call.targetIndex, call));
      continue;
    }
    if (call.resolution !== 'resolved') {
      reasons.push(makeReason('unresolved-procedure', call.targetIndex, call));
      continue;
    }
    const calleeId = call.calleeProcedureIds[0];
    const callee = calleeId === undefined ? undefined : analysis.proceduresById.get(calleeId);
    if (!callee || callee.malformed) {
      reasons.push(makeReason('unresolved-procedure', call.targetIndex, call, calleeId));
      continue;
    }
    inspectProcedure(callee, call);
  }
}

function addProcedureNodeReasons(
  reasons: RegionRejectionReason[],
  procedure: InternalProcedureNode,
  targetIndex: number,
  site?: {readonly blockId: string; readonly opcode: string}
): void {
  const procedureSite = site ?? {blockId: procedure.definitionId, opcode: 'procedures_definition'};
  if (procedure.malformed) reasons.push(makeReason('unresolved-procedure', targetIndex, procedureSite, procedure.procedureId));
  if (procedure.warp === true) reasons.push(makeReason('warp-procedure', targetIndex, procedureSite, procedure.procedureId));
  if (procedure.recursive) reasons.push(makeReason('recursive-procedure', targetIndex, procedureSite, procedure.procedureId));
}

function findOwningEntry(
  target: ScratchTarget,
  targetIndex: number,
  blockId: string | undefined,
  analysis: ProjectEffectAnalysis
): RunnableEntry | null {
  const rootId = findTopLevelAncestor(target, blockId);
  if (rootId === undefined) return null;
  return analysis.runnableEntries.find(entry => entry.targetIndex === targetIndex && entry.blockId === rootId) ?? null;
}

function findOwningProcedure(
  target: ScratchTarget,
  targetIndex: number,
  blockId: string | undefined,
  analysis: InternalProjectEffectAnalysis
): InternalProcedureNode | undefined {
  const rootId = findTopLevelAncestor(target, blockId);
  if (rootId === undefined) return undefined;
  return analysis.procedures.find(procedure => procedure.targetIndex === targetIndex && procedure.definitionId === rootId);
}

function findTopLevelAncestor(target: ScratchTarget, blockId: string | undefined): string | undefined {
  if (blockId === undefined) return undefined;
  const visited = new Set<string>();
  let currentId: string | null = blockId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const current = blockAt(target, currentId);
    if (!current) return undefined;
    if (current.topLevel || current.parent === null) return currentId;
    currentId = current.parent;
  }
  return undefined;
}

function makeReason(
  code: RegionRejectionCode,
  targetIndex: number,
  site?: {readonly blockId: string; readonly opcode: string},
  procedureId?: string,
  detail?: string
): RegionRejectionReason {
  const at = site ? `block ${quoted(site.blockId)}${site.opcode.length > 0 ? ` (${site.opcode})` : ''}` : `target ${targetIndex}`;
  const message = detail ?? (() => {
    switch (code) {
      case 'ambiguous-procedure': return `${at} resolves to more than one custom procedure`;
      case 'argument-evaluation': return `${at} has order-sensitive procedure arguments`;
      case 'block-missing': return `${at} does not exist`;
      case 'block-not-object': return `${at} is not an executable object block`;
      case 'broadcast': return `${at} starts broadcast receivers`;
      case 'clone': return `${at} creates, starts, or deletes a clone`;
      case 'concurrent-target-owner': return `${at} shares generated target-local state with another runnable hat`;
      case 'dynamic-target-owner': return `${at} contains a dynamically selected target`;
      case 'empty-region': return `${at} has no blocks to certify`;
      case 'live-input': return `${at} samples live input or mutable sensed state`;
      case 'random-source': return `${at} may consume Scratch runtime randomness`;
      case 'recursive-procedure': return `${at} reaches a recursive custom-procedure component`;
      case 'symbol-owner-unresolved': return `${at} contains a symbol whose owning target cannot be proven`;
      case 'target-missing': return `${at} does not exist`;
      case 'thread-control': return `${at} changes thread scheduling or termination`;
      case 'thread-reentry': return `${at} starts or can re-enter another script`;
      case 'timer': return `${at} reads, resets, or depends on a clock`;
      case 'unsupported-opcode': return `${at} has effects that are not implemented by the analyzer`;
      case 'unresolved-procedure': return `${at} does not resolve to one well-formed custom procedure`;
      case 'warp-procedure': return `${at} reaches a warp custom procedure`;
      case 'yield': return `${at} can yield or wait`;
    }
  })();
  return {
    code,
    message,
    targetIndex,
    ...(site === undefined ? {} : {blockId: site.blockId, opcode: site.opcode}),
    ...(procedureId === undefined ? {} : {procedureId})
  };
}

const REASON_ORDER: readonly RegionRejectionCode[] = [
  'target-missing',
  'empty-region',
  'block-missing',
  'block-not-object',
  'unsupported-opcode',
  'unresolved-procedure',
  'ambiguous-procedure',
  'warp-procedure',
  'recursive-procedure',
  'argument-evaluation',
  'yield',
  'timer',
  'live-input',
  'random-source',
  'broadcast',
  'clone',
  'thread-control',
  'thread-reentry',
  'dynamic-target-owner',
  'symbol-owner-unresolved',
  'concurrent-target-owner'
];

function dedupeAndSortReasons(reasons: readonly RegionRejectionReason[]): RegionRejectionReason[] {
  const unique = new Map<string, RegionRejectionReason>();
  for (const reason of reasons) {
    const key = `${reason.code}\u0000${reason.targetIndex}\u0000${reason.blockId ?? ''}\u0000${reason.procedureId ?? ''}\u0000${reason.message}`;
    unique.set(key, reason);
  }
  return [...unique.values()].sort((left, right) => {
    const codeOrder = REASON_ORDER.indexOf(left.code) - REASON_ORDER.indexOf(right.code);
    if (codeOrder !== 0) return codeOrder;
    if (left.targetIndex !== right.targetIndex) return left.targetIndex - right.targetIndex;
    const blockOrder = compareText(left.blockId ?? '', right.blockId ?? '');
    if (blockOrder !== 0) return blockOrder;
    return compareText(left.message, right.message);
  });
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function opcodePrefixOf(opcode: string): string {
  const separator = opcode.indexOf('_');
  return separator < 0 ? opcode : opcode.slice(0, separator);
}

function siteKey(site: {readonly targetIndex: number; readonly blockId: string; readonly opcode: string}): string {
  return `${site.targetIndex}\u0000${site.blockId}\u0000${site.opcode}`;
}

function symbolKey(symbol: EffectSymbolReference): string {
  return `${symbol.kind}\u0000${symbol.targetIndex ?? -1}\u0000${symbol.id}\u0000${symbol.name}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSites(
  left: {readonly targetIndex: number; readonly blockId: string; readonly opcode: string},
  right: {readonly targetIndex: number; readonly blockId: string; readonly opcode: string}
): number {
  if (left.targetIndex !== right.targetIndex) return left.targetIndex - right.targetIndex;
  const idOrder = compareText(left.blockId, right.blockId);
  return idOrder === 0 ? compareText(left.opcode, right.opcode) : idOrder;
}

function sortSites<T extends EffectSite>(sites: Iterable<T>): T[] {
  return [...sites].sort(compareSites);
}

function compareSymbols(left: EffectSymbolReference, right: EffectSymbolReference): number {
  const kindOrder = compareText(left.kind, right.kind);
  if (kindOrder !== 0) return kindOrder;
  const leftTarget = left.targetIndex ?? Number.MAX_SAFE_INTEGER;
  const rightTarget = right.targetIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftTarget !== rightTarget) return leftTarget - rightTarget;
  const idOrder = compareText(left.id, right.id);
  return idOrder === 0 ? compareText(left.name, right.name) : idOrder;
}
