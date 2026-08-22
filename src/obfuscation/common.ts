import type {DeterministicGenerator} from '../deterministic.js';
import {isPrimitive, isScratchBlock, stageOf} from '../model/blocks.js';
import {isRecord, orderedDictionary} from '../model/json.js';
import type {
  JsonValue,
  ObfuscationStats,
  ScratchBlock,
  ScratchBlockValue,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../types.js';
import {OFFICIAL_CORE_OPCODES, OFFICIAL_LITERAL_SHADOW_OPCODES} from '../validation/extensions.js';
import {ANTI_CHEAT_WATERMARK_NAME} from './anticheat.js';
import {createStaticInputEvaluator} from './optimizer.js';

type SymbolKind = 'variable' | 'list' | 'broadcast';

interface Replacement {
  readonly id: string;
  readonly name: string;
  readonly originalName: string;
}

interface TargetSymbols {
  readonly variable: Map<string, Replacement>;
  readonly list: Map<string, Replacement>;
  readonly broadcast: Map<string, Replacement>;
}

interface SymbolNamePlan {
  readonly preservedVariables: ReadonlyMap<ScratchTarget, ReadonlySet<string>>;
  readonly preservedLists: ReadonlyMap<ScratchTarget, ReadonlySet<string>>;
  readonly variableGroups: ReadonlyMap<ScratchTarget, ReadonlyMap<string, string>>;
  readonly variableGroupOrder: readonly string[];
  readonly sensingSelections: ReadonlyMap<ScratchTarget, ReadonlyMap<string, SensingObjectSelection>>;
  readonly sensingNamesPreserved: boolean;
}

interface BroadcastNamePlan {
  readonly forbiddenLookupNames: ReadonlySet<string>;
  readonly preserveAllStageNames: boolean;
  readonly preservedStageGroups: ReadonlySet<string>;
  readonly computedNamesPreserved: boolean;
}

interface ObservableTypedNamePlan {
  readonly variables: ReadonlyMap<ScratchTarget, ReadonlySet<string>>;
  readonly lists: ReadonlyMap<ScratchTarget, ReadonlySet<string>>;
  readonly broadcastGroups: ReadonlySet<string>;
  readonly hasReferences: boolean;
}

type BroadcastInputClassification =
  | {readonly kind: 'fixed'; readonly name: string}
  | {readonly kind: 'typed'}
  | {readonly kind: 'unknown'};

type SensingObjectSelection =
  | {readonly kind: 'dynamic'}
  | {readonly kind: 'missing'}
  | {readonly kind: 'target'; readonly target: ScratchTarget};

interface VariableReference {
  readonly key: string;
  readonly target: ScratchTarget;
  readonly id: string;
  readonly name: string;
}

interface ProcedurePlan {
  readonly code: Map<string, string>;
  readonly argumentsByCode: Map<string, Map<string, string>>;
  readonly argumentNames: Map<string, string>;
}

const PROCEDURE_PLACEHOLDER = /%[sbn]/g;
const CLOUD_VARIABLE_LIMIT = 10;
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
const CORE_RUNTIME_VALUE_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  control_create_clone_of: ['CLONE_OPTION'],
  control_for_each: ['VALUE'],
  control_if: ['CONDITION'],
  control_if_else: ['CONDITION'],
  control_repeat: ['TIMES'],
  control_repeat_until: ['CONDITION'],
  control_wait: ['DURATION'],
  control_wait_until: ['CONDITION'],
  control_while: ['CONDITION'],
  data_addtolist: ['ITEM'],
  data_changevariableby: ['VALUE'],
  data_deleteoflist: ['INDEX'],
  data_insertatlist: ['ITEM', 'INDEX'],
  data_itemnumoflist: ['ITEM'],
  data_itemoflist: ['INDEX'],
  data_listcontainsitem: ['ITEM'],
  data_replaceitemoflist: ['INDEX', 'ITEM'],
  data_setvariableto: ['VALUE'],
  event_broadcast: ['BROADCAST_INPUT'],
  event_broadcastandwait: ['BROADCAST_INPUT'],
  event_whengreaterthan: ['VALUE'],
  event_whentouchingobject: ['TOUCHINGOBJECTMENU'],
  looks_changeeffectby: ['CHANGE'],
  looks_changesizeby: ['CHANGE'],
  looks_changestretchby: ['CHANGE'],
  looks_goforwardbackwardlayers: ['NUM'],
  looks_say: ['MESSAGE'],
  looks_sayforsecs: ['MESSAGE', 'SECS'],
  looks_seteffectto: ['VALUE'],
  looks_setsizeto: ['SIZE'],
  looks_setstretchto: ['STRETCH'],
  looks_switchbackdropto: ['BACKDROP'],
  looks_switchbackdroptoandwait: ['BACKDROP'],
  looks_switchcostumeto: ['COSTUME'],
  looks_think: ['MESSAGE'],
  looks_thinkforsecs: ['MESSAGE', 'SECS'],
  motion_changexby: ['DX'],
  motion_changeyby: ['DY'],
  motion_glidesecstoxy: ['SECS', 'X', 'Y'],
  motion_glideto: ['SECS', 'TO'],
  motion_goto: ['TO'],
  motion_gotoxy: ['X', 'Y'],
  motion_movesteps: ['STEPS'],
  motion_pointindirection: ['DIRECTION'],
  motion_pointtowards: ['TOWARDS'],
  motion_scroll_right: ['DISTANCE'],
  motion_scroll_up: ['DISTANCE'],
  motion_setx: ['X'],
  motion_sety: ['Y'],
  motion_turnleft: ['DEGREES'],
  motion_turnright: ['DEGREES'],
  operator_add: ['NUM1', 'NUM2'],
  operator_and: ['OPERAND1', 'OPERAND2'],
  operator_contains: ['STRING1', 'STRING2'],
  operator_divide: ['NUM1', 'NUM2'],
  operator_equals: ['OPERAND1', 'OPERAND2'],
  operator_gt: ['OPERAND1', 'OPERAND2'],
  operator_join: ['STRING1', 'STRING2'],
  operator_length: ['STRING'],
  operator_letter_of: ['LETTER', 'STRING'],
  operator_lt: ['OPERAND1', 'OPERAND2'],
  operator_mathop: ['NUM'],
  operator_mod: ['NUM1', 'NUM2'],
  operator_multiply: ['NUM1', 'NUM2'],
  operator_not: ['OPERAND'],
  operator_or: ['OPERAND1', 'OPERAND2'],
  operator_random: ['FROM', 'TO'],
  operator_round: ['NUM'],
  operator_subtract: ['NUM1', 'NUM2'],
  sensing_askandwait: ['QUESTION'],
  sensing_coloristouchingcolor: ['COLOR', 'COLOR2'],
  sensing_distanceto: ['DISTANCETOMENU'],
  sensing_keypressed: ['KEY_OPTION'],
  sensing_of: ['OBJECT'],
  sensing_touchingcolor: ['COLOR'],
  sensing_touchingobject: ['TOUCHINGOBJECTMENU'],
  sound_changeeffectby: ['VALUE'],
  sound_changevolumeby: ['VOLUME'],
  sound_play: ['SOUND_MENU'],
  sound_playuntildone: ['SOUND_MENU'],
  sound_seteffectto: ['VALUE'],
  sound_setvolumeto: ['VOLUME']
});

function inputMayExposeRuntimeValue(opcode: string, inputName: string): boolean {
  if (opcode === 'procedures_call') return true;
  if (OFFICIAL_CORE_OPCODES.has(opcode)) return CORE_RUNTIME_VALUE_INPUTS[opcode]?.includes(inputName) === true;
  if (OFFICIAL_LITERAL_SHADOW_OPCODES.has(opcode)) return false;
  return true;
}
function uniqueId(generator: DeterministicGenerator, prefix: string, occupied: Set<string>): string {
  for (;;) {
    const candidate = generator.id(prefix);
    if (!occupied.has(candidate) && candidate !== '__proto__' && candidate !== 'constructor' && candidate !== 'prototype') {
      occupied.add(candidate);
      return candidate;
    }
  }
}

function uniqueName(generator: DeterministicGenerator, occupied: Set<string>): string {
  for (;;) {
    const candidate = generator.id('x_', 28);
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
}

function uniqueBroadcastName(
  generator: DeterministicGenerator,
  occupiedNames: Set<string>,
  occupiedLowerNames: Set<string>,
  occupiedUpperNames: Set<string>
): string {
  for (;;) {
    const candidate = uniqueName(generator, occupiedNames);
    const lower = candidate.toLowerCase();
    const upper = candidate.toUpperCase();
    if (occupiedLowerNames.has(lower) || occupiedUpperNames.has(upper)) continue;
    occupiedLowerNames.add(lower);
    occupiedUpperNames.add(upper);
    return candidate;
  }
}

function targetSet(map: Map<ScratchTarget, Set<string>>, target: ScratchTarget): Set<string> {
  const existing = map.get(target);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(target, created);
  return created;
}

function targetMap(map: Map<ScratchTarget, Map<string, string>>, target: ScratchTarget): Map<string, string> {
  const existing = map.get(target);
  if (existing) return existing;
  const created = new Map<string, string>();
  map.set(target, created);
  return created;
}

function isNativeSensingAttribute(target: ScratchTarget, property: string): boolean {
  return (target.isStage ? STAGE_SENSING_ATTRIBUTES : SPRITE_SENSING_ATTRIBUTES).has(property);
}

function selectionForLiteral(project: ScratchProject, value: string): SensingObjectSelection {
  if (value === '_stage_') return {kind: 'target', target: stageOf(project)};
  const target = project.targets.find(candidate => !candidate.isStage && candidate.name === value);
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

function literalReporterField(reporter: ScratchBlock): readonly [string, JsonValue[]] | undefined {
  if (!OFFICIAL_LITERAL_SHADOW_OPCODES.has(reporter.opcode) || Object.keys(reporter.fields).length !== 1 || Object.keys(reporter.inputs).length > 0) {
    return undefined;
  }
  const entry = Object.entries(reporter.fields)[0];
  if (!entry) return undefined;
  const implementedField = IMPLEMENTED_LITERAL_MENU_FIELDS.get(reporter.opcode);
  return implementedField === undefined || entry[0] === implementedField ? entry : undefined;
}

function literalReporterValue(
  project: ScratchProject,
  target: ScratchTarget,
  id: string
): string | undefined {
  const reporter = target.blocks[id];
  if (isPrimitive(reporter)) return runtimePrimitiveLiteral(project, target, reporter);
  if (!isScratchBlock(reporter)) return undefined;
  const entry = literalReporterField(reporter);
  if (!entry) return undefined;
  const [fieldName, field] = entry;
  const kind = typedFieldKind(fieldName);
  const value = kind === undefined
    ? field[0]
    : originalTypedReference(project, target, kind, field[0], field[1])?.name;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function typedFieldKind(fieldName: string): SymbolKind | undefined {
  return fieldName === 'VARIABLE'
    ? 'variable'
    : fieldName === 'LIST' ? 'list' : fieldName === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
}

function originalSymbolById(
  project: ScratchProject,
  target: ScratchTarget,
  kind: SymbolKind,
  id: string
): {readonly target: ScratchTarget; readonly id: string; readonly name: string} | undefined {
  const stage = stageOf(project);
  const scopes = kind === 'broadcast' || target === stage ? [stage] : [target, stage];
  for (const scope of scopes) {
    if (kind === 'broadcast') {
      const name = scope.broadcasts[id];
      if (typeof name === 'string') return {target: scope, id, name};
      continue;
    }
    const declaration = (kind === 'variable' ? scope.variables : scope.lists)[id];
    const name = declaration?.[0];
    if (typeof name === 'string') return {target: scope, id, name};
  }
  return undefined;
}

function originalSymbolByName(
  project: ScratchProject,
  kind: SymbolKind,
  name: string
): {readonly target: ScratchTarget; readonly id: string; readonly name: string} | undefined {
  const stage = stageOf(project);
  const entries = kind === 'broadcast'
    ? Object.entries(stage.broadcasts).map(([id, value]) => [id, value] as const)
    : Object.entries(kind === 'variable' ? stage.variables : stage.lists)
      .flatMap(([id, declaration]) => typeof declaration[0] === 'string' ? [[id, declaration[0]] as const] : []);
  const match = entries.find(([, candidate]) => candidate === name);
  return match ? {target: stage, id: match[0], name: match[1]} : undefined;
}

function originalTypedReference(
  project: ScratchProject,
  target: ScratchTarget,
  kind: SymbolKind,
  name: JsonValue | undefined,
  id: JsonValue | undefined
): {readonly target: ScratchTarget; readonly id: string; readonly name: string} | undefined {
  if (typeof id === 'string' && id.length > 0) return originalSymbolById(project, target, kind, id);
  return typeof name === 'string' ? originalSymbolByName(project, kind, name) : undefined;
}

function runtimePrimitiveLiteral(
  project: ScratchProject,
  target: ScratchTarget,
  primitive: ScratchInput
): string | undefined {
  if (primitive[0] !== 11) return literalPrimitiveValue(primitive);
  return originalTypedReference(project, target, 'broadcast', primitive[1], primitive[2])?.name;
}

function projectStaticInputEvaluator(
  project: ScratchProject,
  target: ScratchTarget
): (ownerId: string, input: ScratchInput) => boolean | number | string | undefined {
  return createStaticInputEvaluator(target, value => (
    typeof value === 'string'
      ? literalReporterValue(project, target, value)
      : runtimePrimitiveLiteral(project, target, value)
  ));
}

function buildObservableTypedNamePlan(project: ScratchProject): ObservableTypedNamePlan {
  const variables = new Map<ScratchTarget, Set<string>>();
  const lists = new Map<ScratchTarget, Set<string>>();
  const broadcastGroups = new Set<string>();
  let hasReferences = false;
  const preserve = (
    target: ScratchTarget,
    kind: SymbolKind,
    name: JsonValue | undefined,
    id: JsonValue | undefined
  ): void => {
    const reference = originalTypedReference(project, target, kind, name, id);
    if (!reference) return;
    hasReferences = true;
    if (kind === 'broadcast') broadcastGroups.add(reference.name.toUpperCase());
    else targetSet(kind === 'variable' ? variables : lists, reference.target).add(reference.id);
  };

  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const [inputName, input] of Object.entries(value.inputs)) {
        if (!inputMayExposeRuntimeValue(value.opcode, inputName)) continue;
        const active = input[1];
        const typedBroadcastMenu = inputName === 'BROADCAST_INPUT'
          && (value.opcode === 'event_broadcast' || value.opcode === 'event_broadcastandwait');
        if (isPrimitive(active)) {
          if (active[0] === 11 && !typedBroadcastMenu) preserve(target, 'broadcast', active[1], active[2]);
          continue;
        }
        if (typeof active !== 'string' || typedBroadcastMenu) continue;
        const reporter = target.blocks[active];
        if (isPrimitive(reporter)) {
          if (reporter[0] === 11) preserve(target, 'broadcast', reporter[1], reporter[2]);
          continue;
        }
        if (!isScratchBlock(reporter)) continue;
        const entry = literalReporterField(reporter);
        if (!entry) continue;
        const [fieldName, field] = entry;
        const kind = typedFieldKind(fieldName);
        if (kind) preserve(target, kind, field[0], field[1]);
      }
    }
  }
  return {variables, lists, broadcastGroups, hasReferences};
}

function primitiveBroadcastClassification(primitive: ScratchInput): BroadcastInputClassification {
  if (primitive[0] === 11) return {kind: 'typed'};
  const literal = literalPrimitiveValue(primitive);
  if (literal === undefined) return {kind: 'unknown'};
  return {kind: 'fixed', name: literal};
}

function classifyBroadcastInput(
  project: ScratchProject,
  target: ScratchTarget,
  ownerId: string,
  input: ScratchInput | undefined,
  evaluateStaticInput: (ownerId: string, input: ScratchInput) => boolean | number | string | undefined
): BroadcastInputClassification {
  if (!input) return {kind: 'unknown'};
  const active = input[1];
  if (isPrimitive(active)) return primitiveBroadcastClassification(active);
  if (typeof active !== 'string') return {kind: 'unknown'};
  const reporter = target.blocks[active];
  if (isPrimitive(reporter)) return primitiveBroadcastClassification(reporter);
  if (isScratchBlock(reporter)) {
    if (reporter.opcode === 'event_broadcast_menu') return {kind: 'typed'};
    const literal = literalReporterValue(project, target, active);
    if (literal !== undefined) return {kind: 'fixed', name: literal};
  }
  const fixed = evaluateStaticInput(ownerId, input);
  return fixed === undefined ? {kind: 'unknown'} : {kind: 'fixed', name: String(fixed)};
}

function originalStageBroadcastByRuntimeName(project: ScratchProject, name: string): string | undefined {
  if (name.length === 0) return undefined;
  const expected = name.toLowerCase();
  for (const candidate of Object.values(stageOf(project).broadcasts)) {
    if (candidate.toLowerCase() === expected) return candidate;
  }
  return undefined;
}

function buildBroadcastNamePlan(
  project: ScratchProject,
  observableNames: ObservableTypedNamePlan
): BroadcastNamePlan {
  const forbiddenLookupNames = new Set<string>();
  const preservedStageGroups = new Set(observableNames.broadcastGroups);
  let preserveAllStageNames = false;
  let computedNamesPreserved = false;
  for (const target of project.targets) {
    const evaluateStaticInput = projectStaticInputEvaluator(project, target);
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || (value.opcode !== 'event_broadcast' && value.opcode !== 'event_broadcastandwait')) {
        continue;
      }
      const classification = classifyBroadcastInput(
        project,
        target,
        blockId,
        value.inputs['BROADCAST_INPUT'],
        evaluateStaticInput
      );
      if (classification.kind === 'typed') continue;
      if (classification.kind === 'unknown') {
        preserveAllStageNames = true;
        computedNamesPreserved = true;
        continue;
      }
      const selected = originalStageBroadcastByRuntimeName(project, classification.name);
      if (!selected) {
        forbiddenLookupNames.add(classification.name.toLowerCase());
      } else if (classification.kind === 'fixed') {
        preservedStageGroups.add(selected.toUpperCase());
        computedNamesPreserved = true;
      }
    }
  }
  return {forbiddenLookupNames, preserveAllStageNames, preservedStageGroups, computedNamesPreserved};
}

function sensingObjectSelection(
  project: ScratchProject,
  owner: ScratchTarget,
  ownerId: string,
  input: ScratchInput | undefined,
  evaluateStaticInput: (ownerId: string, input: ScratchInput) => boolean | number | string | undefined
): SensingObjectSelection {
  const active = input?.[1];
  if (active === null || active === undefined) return selectionForLiteral(project, 'undefined');
  if (isPrimitive(active)) {
    const literal = runtimePrimitiveLiteral(project, owner, active);
    return literal === undefined ? {kind: 'dynamic'} : selectionForLiteral(project, literal);
  }
  if (typeof active !== 'string') return {kind: 'dynamic'};
  const literal = literalReporterValue(project, owner, active);
  if (literal !== undefined) return selectionForLiteral(project, literal);
  if (!input) return {kind: 'dynamic'};
  const fixed = evaluateStaticInput(ownerId, input);
  return fixed === undefined ? {kind: 'dynamic'} : selectionForLiteral(project, String(fixed));
}

function sensingMonitorObjectSelection(
  project: ScratchProject,
  params: Readonly<Record<string, JsonValue>>
): SensingObjectSelection {
  return selectionForLiteral(project, scratchString(params['OBJECT']));
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

function firstVariableReference(
  references: ReadonlyMap<ScratchTarget, ReadonlyMap<string, VariableReference>>,
  target: ScratchTarget,
  name: string
): VariableReference | undefined {
  for (const reference of references.get(target)?.values() ?? []) {
    if (reference.name === name) return reference;
  }
  return undefined;
}

function buildSymbolNamePlan(
  project: ScratchProject,
  observableNames: ObservableTypedNamePlan
): SymbolNamePlan {
  const preservedVariables = new Map<ScratchTarget, Set<string>>(
    [...observableNames.variables].map(([target, ids]) => [target, new Set(ids)])
  );
  const preservedLists = new Map<ScratchTarget, Set<string>>(
    [...observableNames.lists].map(([target, ids]) => [target, new Set(ids)])
  );
  const hardPreservedKeys = new Set<string>();
  const nativeSensingKeys = new Set<string>();
  const references = new Map<ScratchTarget, Map<string, VariableReference>>();
  const sensingSelections = new Map<ScratchTarget, Map<string, SensingObjectSelection>>();
  let cloudVariables = 0;
  let watermarkFound = false;

  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    const local = new Map<string, VariableReference>();
    references.set(target, local);
    for (const [id, declaration] of Object.entries(target.variables)) {
      const name = typeof declaration[0] === 'string' ? declaration[0] : '';
      const key = JSON.stringify([targetIndex, id]);
      local.set(id, {key, target, id, name});
      const genuineCloud =
        target.isStage && declaration.length === 3 && declaration[2] === true && cloudVariables < CLOUD_VARIABLE_LIMIT;
      const watermark = target.isStage && name === ANTI_CHEAT_WATERMARK_NAME && !watermarkFound;
      const observable = observableNames.variables.get(target)?.has(id) === true;
      if (genuineCloud) cloudVariables += 1;
      if (watermark) watermarkFound = true;
      if (genuineCloud || watermark || observable) {
        targetSet(preservedVariables, target).add(id);
        hardPreservedKeys.add(key);
      }
    }
  }

  const parents = new Map<string, string>();
  const byKey = new Map<string, VariableReference>();
  for (const local of references.values()) {
    for (const reference of local.values()) byKey.set(reference.key, reference);
  }
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (!parent || parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  const registerDynamicSite = (property: string): void => {
    const selected = project.targets.flatMap(target => {
      if (isNativeSensingAttribute(target, property)) return [];
      const reference = firstVariableReference(references, target, property);
      return reference ? [reference] : [];
    });
    if (selected.length === 0) return;
    if (project.targets.some(target => isNativeSensingAttribute(target, property))) {
      for (const reference of selected) {
        targetSet(preservedVariables, reference.target).add(reference.id);
        nativeSensingKeys.add(reference.key);
      }
      return;
    }
    for (const reference of selected) parents.set(reference.key, find(reference.key));
    const first = selected[0];
    if (!first) return;
    for (let index = 1; index < selected.length; index += 1) {
      const reference = selected[index];
      if (reference) union(first.key, reference.key);
    }
  };

  for (const target of project.targets) {
    const evaluateStaticInput = projectStaticInputEvaluator(project, target);
    const selections = new Map<string, SensingObjectSelection>();
    sensingSelections.set(target, selections);
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'sensing_of') continue;
      const property = value.fields['PROPERTY']?.[0];
      if (typeof property !== 'string') continue;
      const selection = sensingObjectSelection(
        project,
        target,
        blockId,
        value.inputs['OBJECT'],
        evaluateStaticInput
      );
      selections.set(blockId, selection);
      if (selection.kind === 'dynamic') registerDynamicSite(property);
    }
  }
  const membersByRoot = new Map<string, VariableReference[]>();
  for (const key of parents.keys()) {
    const reference = byKey.get(key);
    if (!reference) continue;
    const root = find(key);
    const members = membersByRoot.get(root) ?? [];
    members.push(reference);
    membersByRoot.set(root, members);
  }
  const variableGroups = new Map<ScratchTarget, Map<string, string>>();
  const variableGroupOrder: string[] = [];
  for (const [root, members] of membersByRoot) {
    const mustPreserve = members.some(reference => preservedVariables.get(reference.target)?.has(reference.id) === true);
    if (mustPreserve) {
      for (const reference of members) targetSet(preservedVariables, reference.target).add(reference.id);
      continue;
    }
    variableGroupOrder.push(root);
    for (const reference of members) targetMap(variableGroups, reference.target).set(reference.id, root);
  }

  const isOrdinarilyRenamable = (key: string): boolean => !hardPreservedKeys.has(key);
  const sensingNamesPreserved = [...nativeSensingKeys].some(isOrdinarilyRenamable)
    || [...membersByRoot.values()].some(members => (
      members.some(reference => preservedVariables.get(reference.target)?.has(reference.id) === true)
      && members.some(reference => isOrdinarilyRenamable(reference.key))
    ));
  return {
    preservedVariables,
    preservedLists,
    variableGroups,
    variableGroupOrder,
    sensingSelections,
    sensingNamesPreserved
  };
}

function targetSymbolMaps(
  project: ScratchProject,
  generator: DeterministicGenerator,
  stats: ObfuscationStats,
  namePlan: SymbolNamePlan,
  broadcastPlan: BroadcastNamePlan
): Map<ScratchTarget, TargetSymbols> {
  const occupiedIds = new Set<string>();
  const occupiedNames = new Set<string>(['Stage']);
  const occupiedBroadcastLowerNames = new Set(broadcastPlan.forbiddenLookupNames);
  const occupiedBroadcastUpperNames = new Set<string>();
  for (const target of project.targets) {
    for (const dictionary of [target.variables, target.lists, target.broadcasts]) {
      for (const id of Object.keys(dictionary)) occupiedIds.add(id);
    }
    for (const tuple of Object.values(target.variables)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const tuple of Object.values(target.lists)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const name of Object.values(target.broadcasts)) {
      occupiedNames.add(name);
      occupiedBroadcastLowerNames.add(name.toLowerCase());
      occupiedBroadcastUpperNames.add(name.toUpperCase());
    }
  }
  const variableGroupNames = new Map<string, string>();
  for (let index = 0; index < namePlan.variableGroupOrder.length; index += 1) {
    const group = namePlan.variableGroupOrder[index];
    if (!group) continue;
    variableGroupNames.set(group, uniqueName(generator.fork(`sensing-group:${index}`), occupiedNames));
  }
  const broadcastGroupNames = new Map<string, string>();
  const broadcastGenerator = generator.fork('broadcast-groups');
  for (const name of Object.values(stageOf(project).broadcasts)) {
    const group = name.toUpperCase();
    if (
      broadcastPlan.preserveAllStageNames
      || broadcastPlan.preservedStageGroups.has(group)
      || broadcastGroupNames.has(group)
    ) {
      continue;
    }
    broadcastGroupNames.set(group, uniqueBroadcastName(
      broadcastGenerator,
      occupiedNames,
      occupiedBroadcastLowerNames,
      occupiedBroadcastUpperNames
    ));
  }

  const maps = new Map<ScratchTarget, TargetSymbols>();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    const local = generator.fork(`target:${targetIndex}:symbols`);
    const variables = new Map<string, Replacement>();
    const lists = new Map<string, Replacement>();
    const broadcasts = new Map<string, Replacement>();
    for (const [id, tuple] of Object.entries(target.variables)) {
      const oldName = typeof tuple[0] === 'string' ? tuple[0] : '';
      const preserveName = namePlan.preservedVariables.get(target)?.has(id) === true;
      const group = namePlan.variableGroups.get(target)?.get(id);
      const groupedName = group === undefined ? undefined : variableGroupNames.get(group);
      if (group !== undefined && groupedName === undefined) throw new Error('missing planned sensing name group');
      const replacementName = preserveName
        ? oldName
        : groupedName ?? uniqueName(local, occupiedNames);
      variables.set(id, {
        id: uniqueId(local, 'v_', occupiedIds),
        name: replacementName,
        originalName: oldName
      });
      stats.identifiersRenamed += 1;
      if (replacementName !== oldName) stats.symbolsRenamed += 1;
    }
    for (const [id, tuple] of Object.entries(target.lists)) {
      const oldName = typeof tuple[0] === 'string' ? tuple[0] : '';
      const replacementName = namePlan.preservedLists.get(target)?.has(id) === true
        ? oldName
        : uniqueName(local, occupiedNames);
      lists.set(id, {
        id: uniqueId(local, 'l_', occupiedIds),
        name: replacementName,
        originalName: oldName
      });
      stats.identifiersRenamed += 1;
      if (replacementName !== oldName) stats.symbolsRenamed += 1;
    }
    for (const [id, name] of Object.entries(target.broadcasts)) {
      const group = name.toUpperCase();
      const replacementName = target.isStage
        ? broadcastPlan.preserveAllStageNames || broadcastPlan.preservedStageGroups.has(group)
          ? name
          : broadcastGroupNames.get(group)
        : uniqueBroadcastName(
            local,
            occupiedNames,
            occupiedBroadcastLowerNames,
            occupiedBroadcastUpperNames
          );
      if (replacementName === undefined) throw new Error('missing planned Stage broadcast name group');
      broadcasts.set(id, {id: uniqueId(local, 'c_', occupiedIds), name: replacementName, originalName: name});
      stats.identifiersRenamed += 1;
      if (replacementName !== name) stats.symbolsRenamed += 1;
    }
    maps.set(target, {variable: variables, list: lists, broadcast: broadcasts});
  }
  return maps;
}

function resolveSymbol(
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget,
  kind: SymbolKind,
  id: string
): Replacement | undefined {
  if (kind === 'broadcast') return maps.get(stageOf(project))?.broadcast.get(id);
  const local = maps.get(target)?.[kind].get(id);
  if (local) return local;
  return maps.get(stageOf(project))?.[kind].get(id);
}

function matchingName(
  symbols: ReadonlyMap<string, Replacement> | undefined,
  name: string
): Replacement[] {
  if (!symbols) return [];
  const matches: Replacement[] = [];
  for (const replacement of symbols.values()) {
    if (replacement.originalName !== name) continue;
    matches.push(replacement);
  }
  return matches;
}

function resolveSymbolByName(
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget,
  kind: SymbolKind,
  name: string
): Replacement | undefined {
  const stage = stageOf(project);
  if (kind === 'broadcast') return matchingName(maps.get(stage)?.broadcast, name)[0];
  return matchingName(maps.get(stage)?.[kind], name)[0];
}

function rebuildDeclarations(target: ScratchTarget, symbols: TargetSymbols): void {
  const variables = orderedDictionary<JsonValue[]>();
  for (const [oldId, tuple] of Object.entries(target.variables)) {
    const replacement = symbols.variable.get(oldId);
    if (!replacement) continue;
    tuple[0] = replacement.name;
    variables[replacement.id] = tuple;
  }
  target.variables = variables;

  const lists = orderedDictionary<JsonValue[]>();
  for (const [oldId, tuple] of Object.entries(target.lists)) {
    const replacement = symbols.list.get(oldId);
    if (!replacement) continue;
    tuple[0] = replacement.name;
    lists[replacement.id] = tuple;
  }
  target.lists = lists;

  const broadcasts = orderedDictionary<string>();
  for (const [oldId] of Object.entries(target.broadcasts)) {
    const replacement = symbols.broadcast.get(oldId);
    if (!replacement) continue;
    broadcasts[replacement.id] = replacement.name;
  }
  target.broadcasts = broadcasts;
}

function parsedStringArray(value: JsonValue | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsedScalarArray(value: JsonValue | undefined): Array<string | number | boolean> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item =>
      typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
    ) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function procedurePlan(
  target: ScratchTarget,
  generator: DeterministicGenerator,
  occupiedIds: Set<string>,
  occupiedNames: Set<string>,
  stats: ObfuscationStats,
  warnings: string[]
): ProcedurePlan | undefined {
  const prototypes: Array<{code: string; ids: string[]; names: string[]}> = [];
  const prototypeIds = new Map<string, readonly string[]>();
  const seenCodes = new Set<string>();
  let hasProcedureBlock = false;
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    if (value.opcode === 'procedures_prototype') {
      hasProcedureBlock = true;
      const mutation = value.mutation;
      const code = mutation?.['proccode'];
      const ids = parsedStringArray(mutation?.['argumentids']);
      const names = parsedStringArray(mutation?.['argumentnames']);
      const defaults = parsedScalarArray(mutation?.['argumentdefaults']);
      const placeholders = typeof code === 'string' ? code.match(PROCEDURE_PLACEHOLDER) ?? [] : [];
      if (typeof code !== 'string' || seenCodes.has(code) || !ids || !names || !defaults || new Set(ids).size !== ids.length || ids.length !== names.length || ids.length !== defaults.length || ids.length !== placeholders.length) {
        warnings.push(`Skipped procedure renaming in ${JSON.stringify(target.name)} because its prototype metadata is ambiguous.`);
        return undefined;
      }
      seenCodes.add(code);
      prototypes.push({code, ids, names});
      prototypeIds.set(code, ids);
    } else if (value.opcode === 'procedures_call') {
      hasProcedureBlock = true;
    }
  }
  if (!hasProcedureBlock) return {code: new Map(), argumentsByCode: new Map(), argumentNames: new Map()};
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
    const code = value.mutation?.['proccode'];
    const ids = parsedStringArray(value.mutation?.['argumentids']);
    const expectedIds = typeof code === 'string' ? prototypeIds.get(code) : undefined;
    if (typeof code !== 'string' || !expectedIds || !ids || ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
      warnings.push(`Skipped procedure renaming in ${JSON.stringify(target.name)} because it contains an unresolved call.`);
      return undefined;
    }
  }

  const codeMap = new Map<string, string>();
  const argumentsByCode = new Map<string, Map<string, string>>();
  const argumentNames = new Map<string, string>();
  for (const prototype of prototypes) {
    const placeholders = prototype.code.match(PROCEDURE_PLACEHOLDER) ?? [];
    let code: string;
    do {
      const label = uniqueName(generator, occupiedNames);
      code = placeholders.length === 0 ? label : `${label} ${placeholders.join(' ')}`;
    } while (seenCodes.has(code) || [...codeMap.values()].includes(code));
    codeMap.set(prototype.code, code);
    stats.symbolsRenamed += 1;
    const ids = new Map<string, string>();
    for (const oldId of prototype.ids) {
      let next = ids.get(oldId);
      if (!next) {
        next = uniqueId(generator, 'a_', occupiedIds);
        ids.set(oldId, next);
        stats.identifiersRenamed += 1;
      }
    }
    argumentsByCode.set(prototype.code, ids);
    for (const oldName of prototype.names) {
      if (!argumentNames.has(oldName)) {
        argumentNames.set(oldName, uniqueName(generator, occupiedNames));
        stats.symbolsRenamed += 1;
      }
    }
  }
  return {code: codeMap, argumentsByCode, argumentNames};
}

function rewriteMutation(block: ScratchBlock, plan: ProcedurePlan | undefined): Map<string, string> | undefined {
  if (!plan || !block.mutation || (block.opcode !== 'procedures_prototype' && block.opcode !== 'procedures_call')) return undefined;
  const oldCode = block.mutation['proccode'];
  if (typeof oldCode !== 'string') return undefined;
  const nextCode = plan.code.get(oldCode);
  const idMap = plan.argumentsByCode.get(oldCode);
  if (!nextCode || !idMap) return undefined;
  block.mutation['proccode'] = nextCode;
  const ids = parsedStringArray(block.mutation['argumentids']);
  if (ids) block.mutation['argumentids'] = JSON.stringify(ids.map(id => idMap.get(id) ?? id));
  if (block.opcode === 'procedures_prototype') {
    const names = parsedStringArray(block.mutation['argumentnames']);
    if (names) block.mutation['argumentnames'] = JSON.stringify(names.map(name => plan.argumentNames.get(name) ?? name));
  }
  return idMap;
}

function rewritePrimitive(
  primitive: ScratchInput,
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget
): void {
  const code = primitive[0];
  const kind: SymbolKind | undefined = code === 11 ? 'broadcast' : code === 12 ? 'variable' : code === 13 ? 'list' : undefined;
  if (!kind) return;
  const explicitId = typeof primitive[2] === 'string' ? primitive[2] : undefined;
  const replacement = explicitId
    ? resolveSymbol(project, maps, target, kind, explicitId)
    : code === 11 && primitive[2] === null && typeof primitive[1] === 'string'
      ? resolveSymbolByName(project, maps, target, 'broadcast', primitive[1])
      : undefined;
  if (!replacement) return;
  primitive[1] = replacement.name;
  primitive[2] = replacement.id;
  if ((code === 12 || code === 13) && primitive.length === 5) {
    primitive[3] = 0;
    primitive[4] = 0;
  }
}

function poisonShadow(primitive: unknown, generator: DeterministicGenerator): void {
  if (!isPrimitive(primitive)) return;
  const code = primitive[0];
  if (typeof code !== 'number' || code < 4 || code > 10) return;
  if (code === 9) {
    primitive[1] = `#${Buffer.from(generator.bytes(3)).toString('hex')}`;
  } else if (code === 10) {
    primitive[1] = generator.id('s_', 20);
  } else {
    primitive[1] = `-${generator.integer(2_000_000_000) + 1}.${generator.integer(1_000_000)}`;
  }
}

function rewriteField(
  opcode: string,
  key: string,
  field: JsonValue[],
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget,
  procedures: ProcedurePlan | undefined
): void {
  if (
    key === 'VALUE'
    && (opcode === 'argument_reporter_string_number' || opcode === 'argument_reporter_boolean')
    && typeof field[0] === 'string'
    && procedures?.argumentNames.has(field[0])
  ) {
    field[0] = procedures.argumentNames.get(field[0]) ?? field[0];
  }
  const kind: SymbolKind | undefined = key === 'VARIABLE' ? 'variable' : key === 'LIST' ? 'list' : key === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
  if (!kind) return;
  const explicitId = typeof field[1] === 'string' && field[1].length > 0 ? field[1] : undefined;
  const replacement = explicitId
    ? resolveSymbol(project, maps, target, kind, explicitId)
    : typeof field[0] === 'string'
      ? resolveSymbolByName(project, maps, target, kind, field[0])
      : undefined;
  if (!replacement) return;
  field[0] = replacement.name;
  field[1] = replacement.id;
}

function firstReplacementByOriginalName(
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget,
  name: string
): Replacement | undefined {
  for (const replacement of maps.get(target)?.variable.values() ?? []) {
    if (replacement.originalName === name) return replacement;
  }
  return undefined;
}

function rewrittenSensingProperty(
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  selection: SensingObjectSelection,
  property: string
): string | undefined {
  const targets = selection.kind === 'dynamic'
    ? project.targets
    : selection.kind === 'target' ? [selection.target] : [];
  if (selection.kind === 'dynamic' && targets.some(target => isNativeSensingAttribute(target, property))) return undefined;
  const replacements: Replacement[] = [];
  for (const target of targets) {
    if (isNativeSensingAttribute(target, property)) continue;
    const replacement = firstReplacementByOriginalName(maps, target, property);
    if (replacement) replacements.push(replacement);
  }
  if (replacements.length === 0) return undefined;
  const names = new Set(replacements.map(replacement => replacement.name));
  return names.size === 1 ? replacements[0]?.name : undefined;
}

function rewriteSensingBlockProperty(
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  selection: SensingObjectSelection | undefined,
  block: ScratchBlock
): void {
  if (block.opcode !== 'sensing_of' || !selection) return;
  const field = block.fields['PROPERTY'];
  const property = field?.[0];
  if (!field || typeof property !== 'string') return;
  const replacement = rewrittenSensingProperty(
    project,
    maps,
    selection,
    property
  );
  if (replacement !== undefined) field[0] = replacement;
}

function rewriteBlocks(
  project: ScratchProject,
  target: ScratchTarget,
  targetIndex: number,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  generator: DeterministicGenerator,
  procedures: ProcedurePlan | undefined,
  sensingSelections: ReadonlyMap<string, SensingObjectSelection> | undefined,
  stats: ObfuscationStats
): void {
  const occupied = new Set(Object.keys(target.blocks));
  const blockIds = new Map<string, string>();
  for (const oldId of Object.keys(target.blocks)) {
    blockIds.set(oldId, uniqueId(generator, 'b_', occupied));
    stats.identifiersRenamed += 1;
  }
  const rewritten = orderedDictionary<ScratchBlockValue>();
  for (const [oldId, value] of Object.entries(target.blocks)) {
    const nextId = blockIds.get(oldId);
    if (!nextId) continue;
    if (isPrimitive(value)) {
      rewritePrimitive(value, project, maps, target);
      rewritten[nextId] = value;
      continue;
    }
    if (!isScratchBlock(value)) continue;
    if (typeof value.next === 'string') value.next = blockIds.get(value.next) ?? value.next;
    if (typeof value.parent === 'string') value.parent = blockIds.get(value.parent) ?? value.parent;
    delete value.comment;
    if (value.topLevel) {
      value.x = 0;
      value.y = 0;
    }
    rewriteSensingBlockProperty(project, maps, sensingSelections?.get(oldId), value);
    const argumentIds = rewriteMutation(value, procedures);
    if (argumentIds) {
      const inputs = orderedDictionary<ScratchInput>();
      for (const [inputName, input] of Object.entries(value.inputs)) inputs[argumentIds.get(inputName) ?? inputName] = input;
      value.inputs = inputs;
    }
    for (const [inputName, input] of Object.entries(value.inputs)) {
      for (let slot = 1; slot < input.length; slot += 1) {
        const item = input[slot];
        if (typeof item === 'string') input[slot] = blockIds.get(item) ?? item;
        else if (isPrimitive(item)) rewritePrimitive(item, project, maps, target);
      }
      if (input[0] === 3) poisonShadow(input[2], generator.fork(`shadow:${targetIndex}:${oldId}:${inputName}`));
    }
    for (const [fieldName, field] of Object.entries(value.fields)) {
      rewriteField(
        value.opcode,
        fieldName,
        field,
        project,
        maps,
        target,
        procedures
      );
    }
    rewritten[nextId] = value;
  }
  target.blocks = rewritten;
}

function rewriteMonitors(project: ScratchProject, maps: ReadonlyMap<ScratchTarget, TargetSymbols>): void {
  const stage = stageOf(project);
  for (const monitor of project.monitors) {
    const opcode = monitor['opcode'];
    if (opcode === 'sensing_of') {
      const params = monitor['params'];
      if (!isRecord(params) || typeof params['PROPERTY'] !== 'string') continue;
      const replacement = rewrittenSensingProperty(
        project,
        maps,
        sensingMonitorObjectSelection(project, params),
        params['PROPERTY']
      );
      if (replacement !== undefined) params['PROPERTY'] = replacement;
      continue;
    }
    const id = monitor['id'];
    if ((opcode !== 'data_variable' && opcode !== 'data_listcontents') || typeof id !== 'string') continue;
    const target = typeof monitor['spriteName'] === 'string'
      ? project.targets.find(candidate => candidate.name === monitor['spriteName']) ?? stage
      : stage;
    const kind: SymbolKind = opcode === 'data_variable' ? 'variable' : 'list';
    const replacement = resolveSymbol(project, maps, target, kind, id);
    if (!replacement) continue;
    monitor['id'] = replacement.id;
    const params = monitor['params'];
    if (isRecord(params)) params[opcode === 'data_variable' ? 'VARIABLE' : 'LIST'] = replacement.name;
  }
}

export function applyCommonTransforms(
  project: ScratchProject,
  generator: DeterministicGenerator,
  stats: ObfuscationStats
): void {
  const observableNames = buildObservableTypedNamePlan(project);
  const namePlan = buildSymbolNamePlan(project, observableNames);
  const broadcastPlan = buildBroadcastNamePlan(project, observableNames);
  if (namePlan.sensingNamesPreserved) {
    stats.warnings.push('Variable display names were preserved because the project uses name-based sensing.');
  }
  if (observableNames.hasReferences) {
    stats.warnings.push('Display names were preserved because typed menu fields are used as runtime reporter values.');
  }
  if (broadcastPlan.computedNamesPreserved && Object.keys(stageOf(project).broadcasts).length > 0) {
    stats.warnings.push('Broadcast display names were preserved because the project computes broadcast names at runtime.');
  }
  const maps = targetSymbolMaps(
    project,
    generator.fork('symbols'),
    stats,
    namePlan,
    broadcastPlan
  );

  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    const symbols = maps.get(target);
    if (!symbols) continue;
    const occupiedIds = new Set<string>([
      ...Object.keys(target.blocks),
      ...Object.keys(target.variables),
      ...Object.keys(target.lists),
      ...Object.keys(target.broadcasts),
      ...[...symbols.variable.values()].map(replacement => replacement.id),
      ...[...symbols.list.values()].map(replacement => replacement.id),
      ...[...symbols.broadcast.values()].map(replacement => replacement.id)
    ]);
    const occupiedNames = new Set<string>([target.name, ...Object.values(target.broadcasts)]);
    for (const tuple of Object.values(target.variables)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const tuple of Object.values(target.lists)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const replacement of symbols.variable.values()) occupiedNames.add(replacement.name);
    for (const replacement of symbols.list.values()) occupiedNames.add(replacement.name);
    const procedures = procedurePlan(
      target,
      generator.fork(`target:${targetIndex}:procedures`),
      occupiedIds,
      occupiedNames,
      stats,
      stats.warnings
    );
    rewriteBlocks(
      project,
      target,
      targetIndex,
      maps,
      generator.fork(`target:${targetIndex}:blocks`),
      procedures,
      namePlan.sensingSelections.get(target),
      stats
    );
    rebuildDeclarations(target, symbols);
    stats.commentsRemoved += Object.keys(target.comments).length;
    target.comments = orderedDictionary();
  }
  rewriteMonitors(project, maps);
}
