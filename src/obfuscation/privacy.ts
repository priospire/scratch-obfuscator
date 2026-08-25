import type {DeterministicGenerator} from '../deterministic.js';
import {isPrimitive, isScratchBlock, stageOf} from '../model/blocks.js';
import {isRecord} from '../model/json.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import {isOfficialHatOpcode} from './analysis.js';

export const EXTRA_PRIVACY_GENERATOR_DOMAIN = 'extra:v1';
export const EXTRA_PRIVACY_PASS_NAME = 'extra-project-privacy';
export const EXTRA_EDITOR_SHADOW_PASS_NAME = 'extra-editor-shadow-hats';
export const EXTRA_EDITOR_SHADOW_CAVEAT =
  'Extra level 2 marks native event hats as top-level shadows. Official Scratch VM 15.1.0 removes those hats from its runnable script list during load, hides their columns, and can save them back as non-top-level blocks. Affected stacks do not execute. Testing did not reproduce an editor freeze, and this does not prevent saving.';

/** Categories the engine must allow when this pass is moved into its verified pass trace. */
export const EXTRA_PRIVACY_ALLOWED_CHANGES = Object.freeze([
  'target-identity',
  'assets',
  'runtime-metadata',
  'symbols',
  'executable-values',
  'serialized-block-data',
  'monitors'
] as const);

export const EXTRA_EDITOR_SHADOW_ALLOWED_CHANGES = Object.freeze([
  'executable-topology',
  'executable-values',
  'serialized-block-data'
] as const);

export interface ExtraEditorShadowHatSite {
  readonly targetIndex: number;
  readonly hatId: string;
  readonly opcode: string;
  readonly previousShadow: boolean;
}

export interface ExtraEditorShadowManifest {
  readonly version: 1;
  readonly sites: readonly ExtraEditorShadowHatSite[];
  readonly changedHatCount: number;
}

export interface ExtraEditorShadowReport {
  readonly manifest: ExtraEditorShadowManifest;
  readonly coveredHatCount: number;
  readonly changedHatCount: number;
  readonly caveats: readonly string[];
}

const TRUSTED_EXTRA_EDITOR_SHADOW_MANIFESTS = new WeakSet<object>();

export interface ExtraPrivacyOptions {
  readonly canonicalizeMonitorPresentation?: boolean;
  readonly stripOptionalProjectMetadata?: boolean;
}

export interface ExtraPrivacyDynamicReferences {
  readonly targets: number;
  readonly costumes: number;
  readonly backdrops: number;
  readonly sounds: number;
  readonly broadcasts: number;
}

export interface ExtraPrivacyReport {
  readonly targetNamesRenamed: number;
  readonly costumeNamesRenamed: number;
  readonly soundNamesRenamed: number;
  readonly broadcastNamesRenamed: number;
  readonly monitorsCanonicalized: number;
  readonly metadataPropertiesRemoved: number;
  readonly nameReporterObservations: number;
  readonly dynamicReferences: ExtraPrivacyDynamicReferences;
  readonly binaryAssetsPreserved: true;
  readonly caveats: readonly string[];
}

type SelectorKind = 'target' | 'costume' | 'backdrop' | 'sound' | 'broadcast';

interface SelectorPlan {
  readonly input: string;
  readonly kind: SelectorKind;
  readonly menuOpcode: string;
}

interface PrivacyNamePlan {
  readonly targets: ReadonlyMap<string, string>;
  readonly costumes: ReadonlyMap<ScratchTarget, ReadonlyMap<string, string>>;
  readonly sounds: ReadonlyMap<ScratchTarget, ReadonlyMap<string, string>>;
  readonly broadcastsById: ReadonlyMap<string, string>;
  readonly broadcastsByRuntimeName: ReadonlyMap<string, string>;
}

interface MutableDynamicReferences {
  targets: number;
  costumes: number;
  backdrops: number;
  sounds: number;
  broadcasts: number;
}

const CANONICAL_PROJECT_PROPERTIES = new Set(['targets', 'monitors', 'extensions', 'meta']);
const PRESERVED_META_PROPERTIES = new Set(['semver']);
const STRING_LITERAL_PRIMITIVE = 10;
const BROADCAST_PRIMITIVE = 11;
const DISPLAY_NAME_ALPHABET = 'abcdefghjkmnpqrstuvwxyz';
const TARGET_SENTINELS = new Set(['_mouse_', '_random_', '_stage_', '_myself_']);

const TARGET_MENU_FIELDS: ReadonlyMap<string, string> = new Map([
  ['control_create_clone_of_menu', 'CLONE_OPTION'],
  ['motion_goto_menu', 'TO'],
  ['motion_pointtowards_menu', 'TOWARDS'],
  ['sensing_distancetomenu', 'DISTANCETOMENU'],
  ['sensing_of_object_menu', 'OBJECT'],
  ['sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU']
]);

const COSTUME_MENU_FIELDS: ReadonlyMap<string, string> = new Map([
  ['looks_costume', 'COSTUME']
]);

const BACKDROP_MENU_FIELDS: ReadonlyMap<string, string> = new Map([
  ['looks_backdrops', 'BACKDROP']
]);

const SOUND_MENU_FIELDS: ReadonlyMap<string, string> = new Map([
  ['sound_sounds_menu', 'SOUND_MENU']
]);

const CORE_INPUT_SELECTORS: ReadonlyMap<string, SelectorPlan> = new Map([
  ['control_create_clone_of', {input: 'CLONE_OPTION', kind: 'target', menuOpcode: 'control_create_clone_of_menu'}],
  ['event_broadcast', {input: 'BROADCAST_INPUT', kind: 'broadcast', menuOpcode: 'event_broadcast_menu'}],
  ['event_broadcastandwait', {input: 'BROADCAST_INPUT', kind: 'broadcast', menuOpcode: 'event_broadcast_menu'}],
  ['event_whentouchingobject', {input: 'TOUCHINGOBJECTMENU', kind: 'target', menuOpcode: 'sensing_touchingobjectmenu'}],
  ['looks_switchbackdropto', {input: 'BACKDROP', kind: 'backdrop', menuOpcode: 'looks_backdrops'}],
  ['looks_switchbackdroptoandwait', {input: 'BACKDROP', kind: 'backdrop', menuOpcode: 'looks_backdrops'}],
  ['looks_switchcostumeto', {input: 'COSTUME', kind: 'costume', menuOpcode: 'looks_costume'}],
  ['motion_glideto', {input: 'TO', kind: 'target', menuOpcode: 'motion_goto_menu'}],
  ['motion_goto', {input: 'TO', kind: 'target', menuOpcode: 'motion_goto_menu'}],
  ['motion_pointtowards', {input: 'TOWARDS', kind: 'target', menuOpcode: 'motion_pointtowards_menu'}],
  ['sensing_distanceto', {input: 'DISTANCETOMENU', kind: 'target', menuOpcode: 'sensing_distancetomenu'}],
  ['sensing_of', {input: 'OBJECT', kind: 'target', menuOpcode: 'sensing_of_object_menu'}],
  ['sensing_touchingobject', {input: 'TOUCHINGOBJECTMENU', kind: 'target', menuOpcode: 'sensing_touchingobjectmenu'}],
  ['sound_play', {input: 'SOUND_MENU', kind: 'sound', menuOpcode: 'sound_sounds_menu'}],
  ['sound_playuntildone', {input: 'SOUND_MENU', kind: 'sound', menuOpcode: 'sound_sounds_menu'}]
]);

export function applyExtraPrivacyTransform(
  project: ScratchProject,
  generator: DeterministicGenerator,
  options: ExtraPrivacyOptions = {}
): ExtraPrivacyReport {
  const occupied = collectProjectStrings(project);
  const plan = buildPrivacyNamePlan(project, generator, occupied);
  const dynamic: MutableDynamicReferences = {targets: 0, costumes: 0, backdrops: 0, sounds: 0, broadcasts: 0};
  let nameReporterObservations = 0;

  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (isPrimitive(value)) {
        rewriteBroadcastPrimitive(value, plan);
        continue;
      }
      if (!isScratchBlock(value)) continue;
      rewriteTypedMenuField(value, target, project, plan);
      rewriteBackdropHat(value, project, plan);
      rewriteBroadcastField(value, plan);
      for (const input of Object.values(value.inputs)) {
        for (let slot = 1; slot < input.length; slot += 1) {
          const item = input[slot];
          if (isPrimitive(item)) rewriteBroadcastPrimitive(item, plan);
        }
      }
      const selector = CORE_INPUT_SELECTORS.get(value.opcode);
      if (selector) rewriteSelectorInput(target, value, selector, plan, dynamic);
      if (isDisplayNameReporter(value)) nameReporterObservations += 1;
    }
  }

  const monitorsCanonicalized = rewriteMonitors(
    project,
    plan,
    options.canonicalizeMonitorPresentation !== false
  );
  const counts = commitDisplayNames(project, plan);
  const metadataPropertiesRemoved = options.stripOptionalProjectMetadata === false
    ? 0
    : stripOptionalProjectMetadata(project);
  const caveats = privacyCaveats(dynamic, nameReporterObservations, monitorsCanonicalized, metadataPropertiesRemoved);

  return {
    ...counts,
    monitorsCanonicalized,
    metadataPropertiesRemoved,
    nameReporterObservations,
    dynamicReferences: {...dynamic},
    binaryAssetsPreserved: true,
    caveats
  };
}

/** Mark every serialized native event root as a top-level shadow for explicit editor disruption. */
export function applyExtraEditorShadowTransform(project: ScratchProject): ExtraEditorShadowReport {
  const sites: ExtraEditorShadowHatSite[] = [];
  let changedHatCount = 0;
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [hatId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || !value.topLevel || !isOfficialHatOpcode(value.opcode)) continue;
      const previousShadow = value.shadow;
      sites.push(Object.freeze({targetIndex, hatId, opcode: value.opcode, previousShadow}));
      if (!previousShadow) {
        value.shadow = true;
        changedHatCount += 1;
      }
    }
  }
  const manifest = Object.freeze<ExtraEditorShadowManifest>({
    version: 1,
    sites: Object.freeze(sites),
    changedHatCount
  });
  TRUSTED_EXTRA_EDITOR_SHADOW_MANIFESTS.add(manifest);
  const caveats = sites.length === 0
    ? Object.freeze(['Extra level 2 found no native event hats to hide.'])
    : Object.freeze([EXTRA_EDITOR_SHADOW_CAVEAT]);
  return Object.freeze({
    manifest,
    coveredHatCount: sites.length,
    changedHatCount,
    caveats
  });
}

export function isTrustedExtraEditorShadowManifest(
  value: ExtraEditorShadowManifest | undefined
): value is ExtraEditorShadowManifest {
  return value !== undefined && TRUSTED_EXTRA_EDITOR_SHADOW_MANIFESTS.has(value);
}

function buildPrivacyNamePlan(
  project: ScratchProject,
  generator: DeterministicGenerator,
  occupied: Set<string>
): PrivacyNamePlan {
  const targetNames = planExactNames(
    project.targets.filter(target => !target.isStage).map(target => target.name),
    generator.fork('targets'),
    't_',
    occupied
  );
  const costumes = new Map<ScratchTarget, ReadonlyMap<string, string>>();
  const sounds = new Map<ScratchTarget, ReadonlyMap<string, string>>();
  for (const [targetIndex, target] of project.targets.entries()) {
    const costumeNames = target.costumes.flatMap(costume => typeof costume['name'] === 'string' ? [costume['name']] : []);
    costumes.set(target, target.isStage
      ? planCaseFoldedExactNames(costumeNames, generator.fork(`target:${targetIndex}:backdrops`), occupied)
      : planExactNames(costumeNames, generator.fork(`target:${targetIndex}:costumes`), 'k_', occupied));
    const soundNames = target.sounds.flatMap(sound => typeof sound['name'] === 'string' ? [sound['name']] : []);
    sounds.set(target, planExactNames(soundNames, generator.fork(`target:${targetIndex}:sounds`), 's_', occupied));
  }

  const broadcastsById = new Map<string, string>();
  const broadcastsByRuntimeName = new Map<string, string>();
  const broadcastGenerator = generator.fork('broadcasts');
  let broadcastGroup = 0;
  for (const target of project.targets) {
    for (const [id, name] of Object.entries(target.broadcasts)) {
      const runtimeName = name.toLowerCase();
      let replacement = broadcastsByRuntimeName.get(runtimeName);
      if (replacement === undefined) {
        replacement = uniqueOpaqueName(broadcastGenerator.fork(`group:${broadcastGroup}`), 'm_', occupied, true);
        broadcastGroup += 1;
        broadcastsByRuntimeName.set(runtimeName, replacement);
      }
      broadcastsById.set(id, replacement);
    }
  }
  return {targets: targetNames, costumes, sounds, broadcastsById, broadcastsByRuntimeName};
}

function planExactNames(
  names: readonly string[],
  generator: DeterministicGenerator,
  prefix: string,
  occupied: Set<string>
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const name of names) {
    if (result.has(name)) continue;
    result.set(name, uniqueOpaqueName(generator.fork(`group:${result.size}`), prefix, occupied, false));
  }
  return result;
}

function planCaseFoldedExactNames(
  names: readonly string[],
  generator: DeterministicGenerator,
  occupied: Set<string>
): ReadonlyMap<string, string> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const folded = name.toUpperCase();
    const group = groups.get(folded) ?? [];
    if (!group.includes(name)) group.push(name);
    groups.set(folded, group);
  }
  const occupiedFolded = new Set([...occupied].map(name => name.toUpperCase()));
  const result = new Map<string, string>();
  let groupIndex = 0;
  for (const exactNames of groups.values()) {
    const local = generator.fork(`case-group:${groupIndex}`);
    groupIndex += 1;
    const letterCount = Math.max(24, Math.ceil(Math.log2(Math.max(2, exactNames.length))));
    let variants: string[];
    for (;;) {
      const base = `d_${randomLowerLetters(local, letterCount)}`;
      variants = exactNames.map((_, index) => applyAsciiCaseBits(base, BigInt(index)));
      if (occupiedFolded.has(base.toUpperCase()) || variants.some(candidate => occupied.has(candidate))) continue;
      occupiedFolded.add(base.toUpperCase());
      for (const candidate of variants) occupied.add(candidate);
      break;
    }
    for (const [index, name] of exactNames.entries()) result.set(name, variants[index] as string);
  }
  return result;
}

function uniqueOpaqueName(
  generator: DeterministicGenerator,
  prefix: string,
  occupied: Set<string>,
  caseInsensitive: boolean
): string {
  const occupiedFolded = caseInsensitive ? new Set([...occupied].map(name => name.toLowerCase())) : undefined;
  for (;;) {
    const candidate = `${prefix}${randomLowerLetters(generator, 24)}`;
    if (occupied.has(candidate) || occupiedFolded?.has(candidate.toLowerCase()) === true) continue;
    occupied.add(candidate);
    return candidate;
  }
}

function randomLowerLetters(generator: DeterministicGenerator, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += DISPLAY_NAME_ALPHABET[generator.integer(DISPLAY_NAME_ALPHABET.length)];
  }
  return result;
}

function applyAsciiCaseBits(value: string, index: bigint): string {
  let bits = index;
  let output = '';
  for (const [characterIndex, character] of [...value].entries()) {
    if (characterIndex >= 2 && character >= 'a' && character <= 'z') {
      output += (bits & 1n) === 1n ? character.toUpperCase() : character;
      bits >>= 1n;
    } else {
      output += character;
    }
  }
  return output;
}

function rewriteTypedMenuField(
  block: ScratchBlock,
  target: ScratchTarget,
  project: ScratchProject,
  plan: PrivacyNamePlan
): void {
  const targetField = TARGET_MENU_FIELDS.get(block.opcode);
  if (targetField) rewriteFieldValue(block, targetField, plan.targets, TARGET_SENTINELS);
  const costumeField = COSTUME_MENU_FIELDS.get(block.opcode);
  if (costumeField) rewriteFieldValue(block, costumeField, requiredTargetMap(plan.costumes, target));
  const backdropField = BACKDROP_MENU_FIELDS.get(block.opcode);
  if (backdropField) rewriteFieldValue(block, backdropField, requiredTargetMap(plan.costumes, stageOf(project)));
  const soundField = SOUND_MENU_FIELDS.get(block.opcode);
  if (soundField) rewriteFieldValue(block, soundField, requiredTargetMap(plan.sounds, target));
}

function rewriteFieldValue(
  block: ScratchBlock,
  fieldName: string,
  names: ReadonlyMap<string, string>,
  sentinels: ReadonlySet<string> = new Set()
): void {
  const field = block.fields[fieldName];
  const value = field?.[0];
  if (!field || typeof value !== 'string' || sentinels.has(value)) return;
  const replacement = names.get(value);
  if (replacement !== undefined) field[0] = replacement;
}

function rewriteBackdropHat(block: ScratchBlock, project: ScratchProject, plan: PrivacyNamePlan): void {
  if (block.opcode !== 'event_whenbackdropswitchesto') return;
  rewriteFieldValue(block, 'BACKDROP', requiredTargetMap(plan.costumes, stageOf(project)));
}

function rewriteBroadcastField(block: ScratchBlock, plan: PrivacyNamePlan): void {
  if (block.opcode !== 'event_whenbroadcastreceived' && block.opcode !== 'event_broadcast_menu') return;
  const field = block.fields['BROADCAST_OPTION'];
  if (!field) return;
  const replacement = broadcastReplacement(field[1], field[0], plan);
  if (replacement !== undefined) field[0] = replacement;
}

function rewriteBroadcastPrimitive(primitive: ScratchInput, plan: PrivacyNamePlan): void {
  if (primitive[0] !== BROADCAST_PRIMITIVE) return;
  const replacement = broadcastReplacement(primitive[2], primitive[1], plan);
  if (replacement !== undefined) primitive[1] = replacement;
}

function broadcastReplacement(
  id: JsonValue | undefined,
  name: JsonValue | undefined,
  plan: PrivacyNamePlan
): string | undefined {
  if (typeof id === 'string') {
    const byId = plan.broadcastsById.get(id);
    if (byId !== undefined) return byId;
  }
  return typeof name === 'string' ? plan.broadcastsByRuntimeName.get(name.toLowerCase()) : undefined;
}

function rewriteSelectorInput(
  target: ScratchTarget,
  block: ScratchBlock,
  selector: SelectorPlan,
  plan: PrivacyNamePlan,
  dynamic: MutableDynamicReferences
): void {
  const input = block.inputs[selector.input];
  if (!input) return;
  const active = input[1];
  const names = selectorNames(target, selector.kind, plan);
  if (isPrimitive(active)) {
    if (selector.kind === 'broadcast' && active[0] === BROADCAST_PRIMITIVE) return;
    const literal = scratchCoercibleScalarLiteral(active);
    if (literal === undefined) {
      dynamic[dynamicKey(selector.kind)] += 1;
      return;
    }
    if (!selectorValueUsesNameLookup(selector.kind, active[1])) return;
    const replacement = selectorReplacement(selector.kind, literal, names, plan);
    if (replacement !== undefined) active[1] = replacement;
    return;
  }
  if (typeof active !== 'string') return;
  const reporter = target.blocks[active];
  if (isPrimitive(reporter)) {
    if (selector.kind === 'broadcast' && reporter[0] === BROADCAST_PRIMITIVE) return;
    const literal = scratchCoercibleScalarLiteral(reporter);
    if (literal === undefined) {
      dynamic[dynamicKey(selector.kind)] += 1;
      return;
    }
    if (!selectorValueUsesNameLookup(selector.kind, reporter[1])) return;
    const replacement = selectorReplacement(selector.kind, literal, names, plan);
    if (replacement !== undefined) reporter[1] = replacement;
    return;
  }
  if (isScratchBlock(reporter) && reporter.opcode === selector.menuOpcode) return;
  dynamic[dynamicKey(selector.kind)] += 1;
}

function scratchCoercibleScalarLiteral(primitive: ScratchInput): string | undefined {
  const type = primitive[0];
  if (typeof type !== 'number' || type < 4 || type > STRING_LITERAL_PRIMITIVE) return undefined;
  const value = primitive[1];
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : undefined;
}

function selectorValueUsesNameLookup(kind: SelectorKind, value: JsonValue | undefined): boolean {
  if (kind === 'target' || kind === 'broadcast') return true;
  if (kind === 'sound') return typeof value === 'string';
  return typeof value !== 'number';
}

function selectorReplacement(
  kind: SelectorKind,
  literal: string,
  names: ReadonlyMap<string, string>,
  plan: PrivacyNamePlan
): string | undefined {
  return kind === 'broadcast'
    ? plan.broadcastsByRuntimeName.get(literal.toLowerCase())
    : names.get(literal);
}

function selectorNames(
  target: ScratchTarget,
  kind: SelectorKind,
  plan: PrivacyNamePlan
): ReadonlyMap<string, string> {
  if (kind === 'target') return plan.targets;
  if (kind === 'costume') return requiredTargetMap(plan.costumes, target);
  if (kind === 'sound') return requiredTargetMap(plan.sounds, target);
  if (kind === 'broadcast') return plan.broadcastsByRuntimeName;
  const stage = [...plan.costumes.keys()].find(candidate => candidate.isStage);
  if (!stage) throw new Error('validated project has no Stage privacy plan');
  return requiredTargetMap(plan.costumes, stage);
}

function dynamicKey(kind: SelectorKind): keyof MutableDynamicReferences {
  return kind === 'target' ? 'targets' : kind === 'costume' ? 'costumes' : kind === 'backdrop' ? 'backdrops' : kind === 'sound' ? 'sounds' : 'broadcasts';
}

function rewriteMonitors(
  project: ScratchProject,
  plan: PrivacyNamePlan,
  canonicalizePresentation: boolean
): number {
  let canonicalized = 0;
  for (const monitor of project.monitors) {
    const spriteName = monitor['spriteName'];
    if (typeof spriteName === 'string') {
      const replacement = plan.targets.get(spriteName);
      if (replacement !== undefined) monitor['spriteName'] = replacement;
    }
    if (monitor['opcode'] === 'sensing_of') {
      const params = monitor['params'];
      if (isRecord(params)) {
        const replacement = plan.targets.get(scratchMonitorSelector(params['OBJECT']));
        if (replacement !== undefined) params['OBJECT'] = replacement;
      }
    }
    if (canonicalizePresentation && canonicalizeMonitor(monitor)) canonicalized += 1;
  }
  return canonicalized;
}

function scratchMonitorSelector(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.map(item => item === null ? '' : scratchMonitorSelector(item)).join(',');
  }
  if (typeof value === 'object') return '[object Object]';
  return String(value);
}

function canonicalizeMonitor(monitor: Record<string, JsonValue>): boolean {
  const desired: Readonly<Record<string, JsonValue>> = {
    visible: false,
    mode: monitor['opcode'] === 'data_listcontents' ? 'list' : 'default',
    value: monitor['opcode'] === 'data_listcontents' ? [] : 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
  let changed = false;
  for (const [key, value] of Object.entries(desired)) {
    if (!jsonScalarOrEmptyArrayEqual(monitor[key], value)) {
      monitor[key] = value;
      changed = true;
    }
  }
  return changed;
}

function jsonScalarOrEmptyArrayEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  if (Array.isArray(right)) return Array.isArray(left) && left.length === 0;
  return left === right;
}

function commitDisplayNames(project: ScratchProject, plan: PrivacyNamePlan): {
  targetNamesRenamed: number;
  costumeNamesRenamed: number;
  soundNamesRenamed: number;
  broadcastNamesRenamed: number;
} {
  let targetNamesRenamed = 0;
  let costumeNamesRenamed = 0;
  let soundNamesRenamed = 0;
  let broadcastNamesRenamed = 0;
  for (const target of project.targets) {
    if (!target.isStage) {
      const replacement = plan.targets.get(target.name);
      if (replacement !== undefined && replacement !== target.name) {
        target.name = replacement;
        targetNamesRenamed += 1;
      }
    }
    const costumeNames = requiredTargetMap(plan.costumes, target);
    for (const costume of target.costumes) {
      const name = costume['name'];
      if (typeof name !== 'string') continue;
      const replacement = costumeNames.get(name);
      if (replacement !== undefined && replacement !== name) {
        costume['name'] = replacement;
        costumeNamesRenamed += 1;
      }
    }
    const soundNames = requiredTargetMap(plan.sounds, target);
    for (const sound of target.sounds) {
      const name = sound['name'];
      if (typeof name !== 'string') continue;
      const replacement = soundNames.get(name);
      if (replacement !== undefined && replacement !== name) {
        sound['name'] = replacement;
        soundNamesRenamed += 1;
      }
    }
    for (const [id, name] of Object.entries(target.broadcasts)) {
      const replacement = plan.broadcastsById.get(id);
      if (replacement !== undefined && replacement !== name) {
        target.broadcasts[id] = replacement;
        broadcastNamesRenamed += 1;
      }
    }
  }
  return {targetNamesRenamed, costumeNamesRenamed, soundNamesRenamed, broadcastNamesRenamed};
}

function stripOptionalProjectMetadata(project: ScratchProject): number {
  let removed = 0;
  for (const key of Object.keys(project)) {
    if (CANONICAL_PROJECT_PROPERTIES.has(key)) continue;
    delete project[key];
    removed += 1;
  }
  for (const key of Object.keys(project.meta)) {
    if (PRESERVED_META_PROPERTIES.has(key)) continue;
    delete project.meta[key];
    removed += 1;
  }
  return removed;
}

function isDisplayNameReporter(block: ScratchBlock): boolean {
  if (block.opcode !== 'looks_costumenumbername' && block.opcode !== 'looks_backdropnumbername') return false;
  return block.fields['NUMBER_NAME']?.[0] === 'name';
}

function privacyCaveats(
  dynamic: Readonly<MutableDynamicReferences>,
  nameReporterObservations: number,
  monitorsCanonicalized: number,
  metadataPropertiesRemoved: number
): string[] {
  const caveats = [
    'Extra privacy preserves binary asset bytes and embedded media metadata; standard SB3 assets remain directly extractable.'
  ];
  for (const [kind, count] of Object.entries(dynamic) as Array<[keyof MutableDynamicReferences, number]>) {
    if (count === 0) continue;
    const label = kind === 'targets' ? 'target'
      : kind === 'costumes' ? 'costume'
        : kind === 'backdrops' ? 'backdrop'
          : kind === 'sounds' ? 'sound' : 'broadcast';
    caveats.push(
      `Extra privacy renamed ${kind} despite ${count} computed ${label} selector${count === 1 ? '' : 's'}; those selectors may no longer resolve.`
    );
  }
  if (nameReporterObservations > 0) {
    caveats.push(
      `Extra privacy changes the value exposed by ${nameReporterObservations} built-in display-name reporter${nameReporterObservations === 1 ? '' : 's'}.`
    );
  }
  if (monitorsCanonicalized > 0) {
    caveats.push(
      `Extra privacy hid and canonicalized ${monitorsCanonicalized} monitor presentation record${monitorsCanonicalized === 1 ? '' : 's'}.`
    );
  }
  if (metadataPropertiesRemoved > 0) {
    caveats.push(
      `Extra privacy removed ${metadataPropertiesRemoved} optional provenance or noncanonical root metadata propert${metadataPropertiesRemoved === 1 ? 'y' : 'ies'} ignored by the pinned official serializer.`
    );
  }
  return caveats;
}

function collectProjectStrings(project: ScratchProject): Set<string> {
  const strings = new Set<string>(TARGET_SENTINELS);
  const pending: unknown[] = [project];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      strings.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value as readonly unknown[]) pending.push(item);
    } else if (isRecord(value)) {
      pending.push(...Object.values(value));
    }
  }
  return strings;
}

function requiredTargetMap(
  maps: ReadonlyMap<ScratchTarget, ReadonlyMap<string, string>>,
  target: ScratchTarget
): ReadonlyMap<string, string> {
  const value = maps.get(target);
  if (!value) throw new Error('missing validated target privacy plan');
  return value;
}
