import {InputError} from '../errors.js';
import {isPrimitive, isScratchBlock} from '../model/blocks.js';
import {assertJsonTree, hasOwn, isRecord} from '../model/json.js';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../types.js';
import {OFFICIAL_LITERAL_SHADOW_OPCODES, validateOfficialExtensions} from './extensions.js';
import {validateOfficialSchema} from './schema.js';

type SymbolKind = 'variable' | 'list' | 'broadcast';
type RegisterImplicitReference = (kind: SymbolKind, name: string, effectiveId: string, path: string) => void;

export interface ProjectValidationOptions {
  readonly allowRecoverableLocalSymbolIdCollisions?: boolean;
  readonly allowRecoverableInactiveShadowOwnership?: boolean;
  readonly allowRecoverableStaleInvisibleMonitors?: boolean;
}

interface SymbolLocation {
  readonly kind: SymbolKind;
  readonly path: string;
  readonly targetIndex: number;
  readonly isStage: boolean;
}

const PROTOTYPE_COLLIDING_IDS = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'prototype',
  'toLocaleString',
  'toString',
  'valueOf'
]);
const XML_UNSAFE_ID = /[<>&'"]/u;
const PRIMITIVE_OBJECT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  colour_picker: 'COLOUR',
  data_listcontents: 'LIST',
  data_variable: 'VARIABLE',
  event_broadcast_menu: 'BROADCAST_OPTION',
  math_angle: 'NUM',
  math_integer: 'NUM',
  math_number: 'NUM',
  math_positive_number: 'NUM',
  math_whole_number: 'NUM',
  text: 'TEXT'
});

function fail(path: string, message: string): never {
  throw new InputError(`${path}: ${message}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'expected an object');
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

function validateSerializedId(id: string, path: string, kind: string, xmlNormalized: boolean): void {
  if (id.length === 0) {
    fail(path, xmlNormalized ? `invalid ${kind} declaration: ID must not be empty` : `${kind} IDs must not be empty`);
  }
  if (PROTOTYPE_COLLIDING_IDS.has(id)) {
    fail(path, `${kind} ID ${JSON.stringify(id)} collides with the Scratch loader's object prototype`);
  }
  if (xmlNormalized && XML_UNSAFE_ID.test(id)) {
    fail(path, `${kind} ID ${JSON.stringify(id)} contains characters rewritten by the Scratch loader`);
  }
}

function isScalar(value: unknown): value is string | boolean | number {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function validatePrimitive(
  value: unknown,
  path: string,
  resolve: (kind: SymbolKind, id: string) => boolean,
  registerImplicitReference: RegisterImplicitReference
): void {
  if (!Array.isArray(value)) fail(path, 'expected a primitive array');
  const items = value as unknown[];
  const code = items[0];
  if (!Number.isInteger(code) || typeof code !== 'number' || code < 4 || code > 13) {
    fail(`${path}[0]`, 'expected a primitive code from 4 through 13');
  }
  if (code >= 4 && code <= 8) {
    if (items.length !== 2 || !(typeof items[1] === 'string' || typeof items[1] === 'number')) fail(path, 'invalid numeric primitive');
  } else if (code === 9) {
    if (items.length !== 2 || typeof items[1] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(items[1])) fail(path, 'invalid color primitive');
  } else if (code === 10) {
    if (items.length !== 2 || !(typeof items[1] === 'string' || typeof items[1] === 'number')) fail(path, 'invalid text primitive');
  } else {
    if ((code === 11 && items.length !== 3) || ((code === 12 || code === 13) && items.length !== 3 && items.length !== 5)) {
      fail(path, 'invalid symbol primitive length');
    }
    const name = items[1];
    const id = items[2];
    if (typeof name !== 'string') fail(path, 'invalid symbol primitive');
    const kind: SymbolKind = code === 11 ? 'broadcast' : code === 12 ? 'variable' : 'list';
    if (code === 11 && id === null) {
      registerImplicitReference(kind, name, 'null', path);
      return;
    }
    if (typeof id !== 'string' || id.length === 0) fail(path, 'invalid symbol primitive');
    if (!resolve(kind, id)) fail(`${path}[2]`, `dangling ${kind} reference ${JSON.stringify(id)}`);
    if (items.length === 5) {
      requireFiniteNumber(items[3], `${path}[3]`);
      requireFiniteNumber(items[4], `${path}[4]`);
    }
  }
}

function validateInput(
  input: unknown,
  path: string,
  blockIds: ReadonlySet<string>,
  resolve: (kind: SymbolKind, id: string) => boolean,
  registerImplicitReference: RegisterImplicitReference
): void {
  if (!Array.isArray(input) || input.length < 2) fail(path, 'expected an input tuple');
  const items = input as unknown[];
  const shape = items[0];
  const expectedLength = shape === 3 ? 3 : shape === 1 || shape === 2 ? 2 : 0;
  if (items.length !== expectedLength) fail(path, 'invalid input shape or length');
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index];
    if (item === null) continue;
    if (typeof item === 'string') {
      if (!blockIds.has(item)) fail(`${path}[${index}]`, `dangling block reference ${JSON.stringify(item)}`);
    } else if (isPrimitive(item)) {
      validatePrimitive(item, `${path}[${index}]`, resolve, registerImplicitReference);
    } else {
      fail(`${path}[${index}]`, 'expected a block ID, primitive, or null');
    }
  }
}

function validateField(
  key: string,
  value: unknown,
  path: string,
  resolve: (kind: SymbolKind, id: string) => boolean,
  registerImplicitReference: RegisterImplicitReference
): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || !isScalar(value[0])) fail(path, 'invalid field tuple');
  if (value.length === 2 && value[1] !== null && typeof value[1] !== 'string') fail(`${path}[1]`, 'expected an ID string or null');
  const kind: SymbolKind | undefined = key === 'VARIABLE' ? 'variable' : key === 'LIST' ? 'list' : key === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
  if (!kind) return;
  if (typeof value[1] === 'string' && value[1].length > 0) {
    if (!resolve(kind, value[1])) fail(`${path}[1]`, `dangling ${kind} reference ${JSON.stringify(value[1])}`);
    return;
  }
  if (typeof value[0] !== 'string') fail(`${path}[0]`, `expected a string for a name-only ${kind} reference`);
  const effectiveId = value.length === 1 ? 'undefined' : value[1] === null ? 'null' : '';
  registerImplicitReference(kind, value[0], effectiveId, path);
}

function isBroadcastMenuItem(item: unknown, blocks: ScratchTarget['blocks']): boolean {
  if (isPrimitive(item)) return item[0] === 11;
  if (typeof item !== 'string') return false;
  const referenced = blocks[item];
  return isPrimitive(referenced)
    ? referenced[0] === 11
    : isScratchBlock(referenced) && referenced.opcode === 'event_broadcast_menu';
}

function isActiveBroadcastReporter(item: unknown, blocks: ScratchTarget['blocks']): boolean {
  if (isPrimitive(item)) return item[0] === 12 || item[0] === 13;
  if (typeof item !== 'string') return false;
  const referenced = blocks[item];
  if (isPrimitive(referenced)) return referenced[0] === 12 || referenced[0] === 13;
  return isScratchBlock(referenced) && !referenced.shadow && !OFFICIAL_LITERAL_SHADOW_OPCODES.has(referenced.opcode);
}

function validateBroadcastInputShape(
  block: ScratchBlock,
  blocks: ScratchTarget['blocks'],
  path: string
): void {
  if (block.opcode !== 'event_broadcast' && block.opcode !== 'event_broadcastandwait') return;
  const input = block.inputs['BROADCAST_INPUT'];
  if (!input) fail(`${path}.inputs.BROADCAST_INPUT`, 'broadcast command requires a broadcast input');
  if (input[0] === 1 && !isBroadcastMenuItem(input[1], blocks)) {
    fail(`${path}.inputs.BROADCAST_INPUT`, 'shadow-only broadcast input must be a broadcast menu');
  }
  if ((input[0] === 2 || input[0] === 3) && !isActiveBroadcastReporter(input[1], blocks)) {
    fail(`${path}.inputs.BROADCAST_INPUT`, 'computed broadcast input must have an executable active reporter');
  }
  if (input[0] === 3 && !isBroadcastMenuItem(input[2], blocks)) {
    fail(`${path}.inputs.BROADCAST_INPUT`, 'obscured broadcast input must retain a broadcast menu shadow');
  }
}

function validatePrimitiveObjectShape(block: ScratchBlock, path: string): void {
  const expectedField = PRIMITIVE_OBJECT_FIELDS[block.opcode];
  if (expectedField === undefined) return;
  const fieldNames = Object.keys(block.fields);
  if (fieldNames.length !== 1 || fieldNames[0] !== expectedField) {
    fail(`${path}.fields`, `${block.opcode} must contain only its ${expectedField} field`);
  }
  const field = block.fields[expectedField];
  if (!Array.isArray(field)) fail(`${path}.fields.${expectedField}`, 'invalid primitive field tuple');
  const value = field[0];
  if (block.opcode === 'colour_picker') {
    if (field.length !== 1 || typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(value)) {
      fail(`${path}.fields.${expectedField}`, 'color primitives require one #RRGGBB string');
    }
  } else if (block.opcode === 'data_variable' || block.opcode === 'data_listcontents' || block.opcode === 'event_broadcast_menu') {
    if (typeof value !== 'string') fail(`${path}.fields.${expectedField}[0]`, 'typed primitives require a string name');
  } else if (field.length !== 1 || (typeof value !== 'string' && typeof value !== 'number')) {
    fail(`${path}.fields.${expectedField}`, 'numeric and text primitives require one string or number');
  }
  if (Object.keys(block.inputs).length > 0) {
    fail(path, `${block.opcode} contains data discarded by the Scratch primitive serializer`);
  }
}

function validateBlock(
  block: ScratchBlock,
  path: string,
  blocks: ScratchTarget['blocks'],
  blockIds: ReadonlySet<string>,
  commentIds: ReadonlySet<string>,
  resolve: (kind: SymbolKind, id: string) => boolean,
  registerImplicitReference: RegisterImplicitReference
): void {
  if (block.opcode.length === 0) fail(`${path}.opcode`, 'must not be empty');
  for (const key of ['next', 'parent'] as const) {
    const reference = block[key];
    if (reference !== null && typeof reference !== 'string') fail(`${path}.${key}`, 'expected a block ID or null');
    if (typeof reference === 'string' && !blockIds.has(reference)) fail(`${path}.${key}`, `dangling block reference ${JSON.stringify(reference)}`);
  }
  requireRecord(block.inputs, `${path}.inputs`);
  requireRecord(block.fields, `${path}.fields`);
  const typedFields = ['VARIABLE', 'LIST', 'BROADCAST_OPTION'].filter(name => block.fields[name] !== undefined);
  if (typedFields.length > 1) fail(`${path}.fields`, 'multiple typed symbol fields have loader-dependent precedence');
  requireBoolean(block.shadow, `${path}.shadow`);
  requireBoolean(block.topLevel, `${path}.topLevel`);
  if (block.x !== undefined) requireFiniteNumber(block.x, `${path}.x`);
  if (block.y !== undefined) requireFiniteNumber(block.y, `${path}.y`);
  if (block.comment !== undefined && block.comment !== null) {
    const comment = requireString(block.comment, `${path}.comment`);
    if (!commentIds.has(comment)) fail(`${path}.comment`, `dangling comment reference ${JSON.stringify(comment)}`);
  }
  if (block.mutation !== undefined) requireRecord(block.mutation, `${path}.mutation`);
  for (const [name, input] of Object.entries(block.inputs)) validateInput(input, `${path}.inputs.${name}`, blockIds, resolve, registerImplicitReference);
  validateBroadcastInputShape(block, blocks, path);
  for (const [name, field] of Object.entries(block.fields)) {
    validateField(name, field, `${path}.fields.${name}`, resolve, registerImplicitReference);
  }
  validatePrimitiveObjectShape(block, path);
}

function symbolEntries(target: ScratchTarget, kind: SymbolKind): Array<[string, string]> {
  if (kind === 'broadcast') return Object.entries(target.broadcasts);
  const declarations = kind === 'variable' ? target.variables : target.lists;
  return Object.entries(declarations).flatMap(([id, tuple]) => typeof tuple[0] === 'string' ? [[id, tuple[0]]] : []);
}

function matchingSymbolNames(target: ScratchTarget, kind: SymbolKind, name: string): string[] {
  return symbolEntries(target, kind)
    .filter(([, candidate]) => candidate === name)
    .map(([id]) => id);
}

function validateNoExecutableCycles(target: ScratchTarget, targetIndex: number): void {
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (active.has(id)) fail(`$.targets[${targetIndex}].blocks.${id}`, 'executable graph contains a cycle');
    const block = target.blocks[id];
    if (!block || !isScratchBlock(block)) return;
    active.add(id);
    if (block.next) visit(block.next);
    for (const input of Object.values(block.inputs)) {
      for (let slot = 1; slot < input.length; slot += 1) {
        const reference = input[slot];
        if (typeof reference === 'string') visit(reference);
      }
    }
    active.delete(id);
    done.add(id);
  };
  for (const id of Object.keys(target.blocks)) visit(id);
}

function validateGraphOwnership(
  target: ScratchTarget,
  targetIndex: number,
  options: Readonly<ProjectValidationOptions>
): void {
  const path = `$.targets[${targetIndex}].blocks`;
  const owners = new Map<string, Array<{id: string; edge: string; inactiveShadow: boolean}>>();
  const registerOwner = (childId: string, ownerId: string, edge: string, inactiveShadow = false): void => {
    const child = target.blocks[childId];
    if (!child) fail(`${path}.${ownerId}.${edge}`, `dangling block reference ${JSON.stringify(childId)}`);
    if (!isScratchBlock(child)) {
      if (edge === 'next') fail(`${path}.${ownerId}.${edge}`, `next edge must reference an object block, not ${JSON.stringify(childId)}`);
      return;
    }
    const present = owners.get(childId) ?? [];
    present.push({id: ownerId, edge, inactiveShadow});
    owners.set(childId, present);
  };

  for (const [ownerId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    if (value.next !== null) registerOwner(value.next, ownerId, 'next');
    for (const [inputName, input] of Object.entries(value.inputs)) {
      for (let slot = 1; slot < input.length; slot += 1) {
        const childId = input[slot];
        if (typeof childId === 'string') {
          const inactiveShadow = input[0] === 3
            && slot === 2
            && input[1] !== null
            && input[1] !== undefined;
          registerOwner(childId, ownerId, `inputs.${inputName}[${slot}]`, inactiveShadow);
        }
      }
    }
  }

  for (const [blockId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    const incoming = owners.get(blockId) ?? [];
    const recoverableInactiveShadow = options.allowRecoverableInactiveShadowOwnership === true
      && value.shadow
      && value.next === null
      && incoming.length === 1
      && incoming[0]?.inactiveShadow === true
      && (!value.topLevel || OFFICIAL_LITERAL_SHADOW_OPCODES.has(value.opcode));
    if (recoverableInactiveShadow) continue;
    if (value.topLevel) {
      if (value.parent !== null) fail(`${path}.${blockId}.parent`, 'top-level block must have a null parent');
      if (incoming.length > 0) fail(`${path}.${blockId}`, 'top-level block must not have an incoming block edge');
      continue;
    }
    if (typeof value.parent !== 'string') fail(`${path}.${blockId}.parent`, 'non-top-level block must have an owning parent');
    if (incoming.length === 0) fail(`${path}.${blockId}`, 'non-top-level block is orphaned');
    if (incoming.length > 1) {
      fail(`${path}.${blockId}`, `block has multiple owners: ${incoming.map(owner => JSON.stringify(owner.id)).join(', ')}`);
    }
    const owner = incoming[0];
    if (!owner || owner.id !== value.parent) {
      fail(`${path}.${blockId}.parent`, `parent does not match incoming owner ${JSON.stringify(owner?.id)}`);
    }
  }
}

function validateCommentLinks(target: ScratchTarget, targetIndex: number): void {
  const targetPath = `$.targets[${targetIndex}]`;
  for (const [commentId, commentValue] of Object.entries(target.comments)) {
    const comment = requireRecord(commentValue, `${targetPath}.comments.${commentId}`);
    const blockId = comment['blockId'];
    if (blockId === null || blockId === undefined) continue;
    if (typeof blockId !== 'string') continue;
    const block = target.blocks[blockId];
    if (!block || !isScratchBlock(block)) {
      fail(`${targetPath}.comments.${commentId}.blockId`, 'linked comment must reference an object block');
    }
    if (block.comment !== commentId) {
      fail(`${targetPath}.comments.${commentId}.blockId`, `comment link is not reciprocated by block ${JSON.stringify(blockId)}`);
    }
  }
  for (const [blockId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value) || value.comment === null || value.comment === undefined) continue;
    const comment = requireRecord(target.comments[value.comment], `${targetPath}.comments.${value.comment}`);
    if (comment['blockId'] !== blockId) {
      fail(`${targetPath}.blocks.${blockId}.comment`, `block comment link is not reciprocated by comment ${JSON.stringify(value.comment)}`);
    }
  }
}

function validateTargetShape(targetValue: unknown, index: number): ScratchTarget {
  const path = `$.targets[${index}]`;
  const target = requireRecord(targetValue, path);
  requireBoolean(target['isStage'], `${path}.isStage`);
  requireString(target['name'], `${path}.name`);
  const variables = requireRecord(target['variables'], `${path}.variables`);
  const lists = requireRecord(target['lists'], `${path}.lists`);
  const broadcasts = requireRecord(target['broadcasts'], `${path}.broadcasts`);
  requireRecord(target['blocks'], `${path}.blocks`);
  requireRecord(target['comments'], `${path}.comments`);
  const currentCostume = requireFiniteNumber(target['currentCostume'], `${path}.currentCostume`);
  if (!Number.isInteger(currentCostume)) fail(`${path}.currentCostume`, 'expected an integer');
  const costumes = target['costumes'];
  const sounds = target['sounds'];
  if (!Array.isArray(costumes) || costumes.length < 1) fail(`${path}.costumes`, 'expected at least one costume');
  if (!Array.isArray(sounds)) fail(`${path}.sounds`, 'expected an array');

  for (const [id, tuple] of Object.entries(variables)) {
    validateSerializedId(id, `${path}.variables.${id}`, 'variable', true);
    if (!Array.isArray(tuple) || (tuple.length !== 2 && tuple.length !== 3) || typeof tuple[0] !== 'string' || !isScalar(tuple[1]) || (tuple.length === 3 && tuple[2] !== true)) {
      fail(`${path}.variables.${id}`, 'invalid variable declaration');
    }
  }
  for (const [id, tuple] of Object.entries(lists)) {
    validateSerializedId(id, `${path}.lists.${id}`, 'list', true);
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || !Array.isArray(tuple[1]) || !tuple[1].every(isScalar)) {
      fail(`${path}.lists.${id}`, 'invalid list declaration');
    }
  }
  for (const [id, name] of Object.entries(broadcasts)) {
    validateSerializedId(id, `${path}.broadcasts.${id}`, 'broadcast', true);
    if (typeof name !== 'string') fail(`${path}.broadcasts.${id}`, 'invalid broadcast declaration');
  }
  for (let costumeIndex = 0; costumeIndex < costumes.length; costumeIndex += 1) {
    const costume = requireRecord(costumes[costumeIndex], `${path}.costumes[${costumeIndex}]`);
    for (const property of ['assetId', 'dataFormat', 'name'] as const) requireString(costume[property], `${path}.costumes[${costumeIndex}].${property}`);
  }
  if (currentCostume >= costumes.length) fail(`${path}.currentCostume`, 'costume index is out of range');
  for (let soundIndex = 0; soundIndex < sounds.length; soundIndex += 1) {
    const sound = requireRecord(sounds[soundIndex], `${path}.sounds[${soundIndex}]`);
    for (const property of ['assetId', 'dataFormat', 'name'] as const) requireString(sound[property], `${path}.sounds[${soundIndex}].${property}`);
  }
  return target as unknown as ScratchTarget;
}

function validateMonitor(
  monitorValue: unknown,
  index: number,
  project: ScratchProject,
  options: Readonly<ProjectValidationOptions>
): void {
  const path = `$.monitors[${index}]`;
  const monitor = requireRecord(monitorValue, path);
  const opcode = requireString(monitor['opcode'], `${path}.opcode`);
  const id = requireString(monitor['id'], `${path}.id`);
  const params = requireRecord(monitor['params'], `${path}.params`);
  const hasNamedTarget = typeof monitor['spriteName'] === 'string' && monitor['spriteName'].length > 0;
  const namedTarget = hasNamedTarget
    ? project.targets.find(item => item.name === monitor['spriteName'])
    : undefined;
  let target = namedTarget;
  target ??= project.targets.find(item => item.isStage);
  if (!target) fail(path, 'cannot resolve monitor target');
  if (opcode === 'data_variable' || opcode === 'data_listcontents') {
    const declarations = opcode === 'data_variable' ? target.variables : target.lists;
    const stage = project.targets.find(item => item.isStage);
    const parameter = opcode === 'data_variable' ? 'VARIABLE' : 'LIST';
    if (hasOwn(params, parameter) && typeof params[parameter] !== 'string') {
      fail(`${path}.params.${parameter}`, 'expected a string');
    }
    if (!hasOwn(declarations, id) && (!stage || !hasOwn(opcode === 'data_variable' ? stage.variables : stage.lists, id))) {
      const recoverableStaleMonitor = options.allowRecoverableStaleInvisibleMonitors === true
        && hasNamedTarget
        && namedTarget === undefined
        && monitor['visible'] === false;
      if (recoverableStaleMonitor) return;
      fail(`${path}.id`, `dangling monitored ${opcode === 'data_variable' ? 'variable' : 'list'} ${JSON.stringify(id)}`);
    }
  }
}

export function validateProject(
  value: unknown,
  options: Readonly<ProjectValidationOptions> = {}
): asserts value is ScratchProject {
  try {
    assertJsonTree(value);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : 'project is not JSON', {cause: error});
  }
  let officialSchemaError: InputError | undefined;
  try {
    validateOfficialSchema(value);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    officialSchemaError = error;
  }
  const root = requireRecord(value, '$');
  const meta = requireRecord(root['meta'], '$.meta');
  const semver = requireString(meta['semver'], '$.meta.semver');
  if (!/^3\.[0-9]+\.[0-9]+$/.test(semver)) fail('$.meta.semver', 'expected Scratch 3 semver');
  if (!Array.isArray(root['targets']) || root['targets'].length === 0) fail('$.targets', 'expected a non-empty array');
  if (!Array.isArray(root['monitors'])) fail('$.monitors', 'expected an array');
  if (!Array.isArray(root['extensions']) || !root['extensions'].every(extension => typeof extension === 'string')) fail('$.extensions', 'expected an array of strings');

  const targets = root['targets'].map((target, index) => validateTargetShape(target, index));
  if (!targets[0]?.isStage || targets[0].name !== 'Stage') fail('$.targets[0]', 'the first target must be Stage');
  if (targets.slice(1).some(target => target.isStage)) fail('$.targets', 'only the first target may be Stage');
  const targetNames = new Set<string>();
  for (const target of targets) {
    if (targetNames.has(target.name)) fail('$.targets', `duplicate target name ${JSON.stringify(target.name)}`);
    targetNames.add(target.name);
  }

  const stage = targets[0];
  if (!stage) fail('$.targets[0]', 'missing Stage');
  const targetIndices = new Map(targets.map((target, index) => [target.name, index]));
  const dataMonitorOwners = new Map<string, Set<string>>();
  for (const monitorValue of root['monitors']) {
    if (!isRecord(monitorValue)) continue;
    const opcode = monitorValue['opcode'];
    const id = monitorValue['id'];
    if ((opcode !== 'data_variable' && opcode !== 'data_listcontents') || typeof id !== 'string') continue;
    const spriteName = monitorValue['spriteName'];
    const removedBeforeRemapping = options.allowRecoverableStaleInvisibleMonitors === true
      && typeof spriteName === 'string'
      && spriteName.length > 0
      && !targetNames.has(spriteName)
      && monitorValue['visible'] === false;
    if (removedBeforeRemapping) continue;
    const hasNamedTarget = typeof spriteName === 'string' && spriteName.length > 0;
    const targetIndex = hasNamedTarget ? targetIndices.get(spriteName) : 0;
    const target = targetIndex === undefined ? stage : targets[targetIndex];
    if (!target) continue;
    const kind: Exclude<SymbolKind, 'broadcast'> = opcode === 'data_variable' ? 'variable' : 'list';
    const localDeclarations = kind === 'variable' ? target.variables : target.lists;
    const stageDeclarations = kind === 'variable' ? stage.variables : stage.lists;
    const ownerIndex = hasOwn(localDeclarations, id)
      ? targetIndex ?? 0
      : hasOwn(stageDeclarations, id) ? 0 : undefined;
    if (ownerIndex === undefined) continue;
    const owners = dataMonitorOwners.get(id) ?? new Set<string>();
    owners.add(`${ownerIndex}:${kind}`);
    dataMonitorOwners.set(id, owners);
  }

  const visibilityMutatorOwners = new Map<string, Set<string>>();
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (!target) continue;
    for (const blockValue of Object.values(target.blocks)) {
      if (!isScratchBlock(blockValue) || !isRecord(blockValue.fields)) continue;
      const variableMutator = blockValue.opcode === 'data_showvariable' || blockValue.opcode === 'data_hidevariable';
      const listMutator = blockValue.opcode === 'data_showlist' || blockValue.opcode === 'data_hidelist';
      if (!variableMutator && !listMutator) continue;
      const kind: Exclude<SymbolKind, 'broadcast'> = variableMutator ? 'variable' : 'list';
      const field = blockValue.fields[kind === 'variable' ? 'VARIABLE' : 'LIST'];
      const id = Array.isArray(field) ? field[1] : undefined;
      if (typeof id !== 'string' || id.length === 0) continue;
      const localDeclarations = kind === 'variable' ? target.variables : target.lists;
      const stageDeclarations = kind === 'variable' ? stage.variables : stage.lists;
      const ownerIndex = hasOwn(localDeclarations, id)
        ? targetIndex
        : hasOwn(stageDeclarations, id) ? 0 : undefined;
      if (ownerIndex === undefined) continue;
      const owners = visibilityMutatorOwners.get(id) ?? new Set<string>();
      owners.add(`${ownerIndex}:${kind}`);
      visibilityMutatorOwners.set(id, owners);
    }
  }

  const symbolIds = new Map<string, SymbolLocation>();
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (!target) continue;
    for (const kind of ['variable', 'list', 'broadcast'] as const) {
      for (const [id] of symbolEntries(target, kind)) {
        const path = `$.targets[${targetIndex}].${kind === 'variable' ? 'variables' : `${kind}s`}.${id}`;
        const previous = symbolIds.get(id);
        if (previous) {
          const recoverableLocalCollision = options.allowRecoverableLocalSymbolIdCollisions === true
            && !previous.isStage
            && !target.isStage
            && previous.targetIndex !== targetIndex;
          if (recoverableLocalCollision && (dataMonitorOwners.get(id)?.size ?? 0) > 1) {
            fail(
              path,
              `duplicate local symbol ID ${JSON.stringify(id)} is referenced by data monitors for multiple owners and cannot be safely disambiguated`
            );
          }
          if (recoverableLocalCollision) {
            const monitorOwners = dataMonitorOwners.get(id) ?? new Set<string>();
            const mutatorOwners = visibilityMutatorOwners.get(id) ?? new Set<string>();
            const visibilityOwners = new Set([...monitorOwners, ...mutatorOwners]);
            if ((monitorOwners.size > 0 && visibilityOwners.size > 1) || mutatorOwners.size > 1) {
              fail(
                path,
                `duplicate local symbol ID ${JSON.stringify(id)} has monitor visibility references for multiple owners and cannot be safely disambiguated`
              );
            }
          }
          if (!recoverableLocalCollision) {
            fail(path, `duplicate project-wide symbol ID ${JSON.stringify(id)}; first declared at ${previous.path}`);
          }
        } else {
          symbolIds.set(id, {kind, path, targetIndex, isStage: target.isStage});
        }
      }
    }
  }

  const project = value as ScratchProject;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    const path = `$.targets[${index}]`;
    const blockIds = new Set(Object.keys(target.blocks));
    const commentIds = new Set(Object.keys(target.comments));
    const resolve = (kind: SymbolKind, id: string): boolean => {
      if (kind === 'broadcast') return hasOwn(stage.broadcasts, id);
      const local = kind === 'variable' ? target.variables : kind === 'list' ? target.lists : target.broadcasts;
      const global = kind === 'variable' ? stage.variables : kind === 'list' ? stage.lists : stage.broadcasts;
      return hasOwn(local, id) || hasOwn(global, id);
    };
    const resolveName = (kind: SymbolKind, name: string): boolean => {
      return matchingSymbolNames(stage, kind, name).length > 0;
    };
    const runtimeSymbolIds = new Set<string>();
    for (const scope of target === stage ? [stage] : [target, stage]) {
      for (const kind of ['variable', 'list', 'broadcast'] as const) {
        for (const [id] of symbolEntries(scope, kind)) runtimeSymbolIds.add(id);
      }
    }
    const implicitReferences = new Map<string, {kind: SymbolKind; name: string; path: string}>();
    const registerImplicitReference: RegisterImplicitReference = (kind, name, effectiveId, referencePath) => {
      if (runtimeSymbolIds.has(effectiveId)) {
        fail(referencePath, `implicit symbol ID ${JSON.stringify(effectiveId)} collides with a declaration visible to the Scratch loader`);
      }
      if (!resolveName(kind, name)) {
        fail(referencePath, `dangling name-only ${kind} reference ${JSON.stringify(name)}`);
      }
      const previous = implicitReferences.get(effectiveId);
      if (previous && (previous.kind !== kind || previous.name !== name)) {
        fail(
          referencePath,
          `implicit symbol ID ${JSON.stringify(effectiveId)} would coalesce with a distinct reference first seen at ${previous.path}`
        );
      }
      if (!previous) implicitReferences.set(effectiveId, {kind, name, path: referencePath});
    };
    for (const [commentId, commentValue] of Object.entries(target.comments)) {
      const comment = requireRecord(commentValue, `${path}.comments.${commentId}`);
      if (comment['blockId'] !== null && comment['blockId'] !== undefined) {
        const id = requireString(comment['blockId'], `${path}.comments.${commentId}.blockId`);
        if (!blockIds.has(id)) fail(`${path}.comments.${commentId}.blockId`, `dangling block reference ${JSON.stringify(id)}`);
      }
      requireString(comment['text'], `${path}.comments.${commentId}.text`);
    }
    for (const [blockId, block] of Object.entries(target.blocks)) {
      const blockPath = blockId.length === 0 ? `${path}.blocks` : `${path}.blocks.${blockId}`;
      validateSerializedId(blockId, blockPath, 'block', false);
      if (isScratchBlock(block)) validateBlock(block, `${path}.blocks.${blockId}`, target.blocks, blockIds, commentIds, resolve, registerImplicitReference);
      else validatePrimitive(block, `${path}.blocks.${blockId}`, resolve, registerImplicitReference);
    }
    validateNoExecutableCycles(target, index);
    validateGraphOwnership(target, index, options);
    validateCommentLinks(target, index);
  }
  for (let index = 0; index < project.monitors.length; index += 1) {
    validateMonitor(project.monitors[index], index, project, options);
  }
  validateOfficialExtensions(project);
  if (officialSchemaError) throw officialSchemaError;
}
