import {InputError} from '../errors.js';
import {isPrimitive, isScratchBlock} from '../model/blocks.js';
import {assertJsonTree, hasOwn, isRecord} from '../model/json.js';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../types.js';
import {validateOfficialExtensions} from './extensions.js';
import {validateOfficialSchema} from './schema.js';

type SymbolKind = 'variable' | 'list' | 'broadcast';
type NameResolution = 'unique' | 'missing' | 'ambiguous';
type RegisterImplicitReference = (kind: SymbolKind, name: string, effectiveId: string, path: string, isDynamicPrimitive: boolean) => void;

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
      registerImplicitReference(kind, name, 'null', path, true);
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
  resolveName: (kind: SymbolKind, name: string) => NameResolution,
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
  registerImplicitReference(kind, value[0], effectiveId, path, false);
  const resolution = resolveName(kind, value[0]);
  if (resolution === 'missing') fail(`${path}[0]`, `dangling name-only ${kind} reference ${JSON.stringify(value[0])}`);
  if (resolution === 'ambiguous') fail(`${path}[0]`, `ambiguous name-only ${kind} reference ${JSON.stringify(value[0])}`);
}

function validateBlock(
  block: ScratchBlock,
  path: string,
  blockIds: ReadonlySet<string>,
  commentIds: ReadonlySet<string>,
  resolve: (kind: SymbolKind, id: string) => boolean,
  resolveName: (kind: SymbolKind, name: string) => NameResolution,
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
  for (const [name, field] of Object.entries(block.fields)) validateField(name, field, `${path}.fields.${name}`, resolve, resolveName, registerImplicitReference);
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

function validateGraphOwnership(target: ScratchTarget, targetIndex: number): void {
  const path = `$.targets[${targetIndex}].blocks`;
  const owners = new Map<string, Array<{id: string; edge: string}>>();
  const registerOwner = (childId: string, ownerId: string, edge: string): void => {
    const child = target.blocks[childId];
    if (!child) fail(`${path}.${ownerId}.${edge}`, `dangling block reference ${JSON.stringify(childId)}`);
    if (!isScratchBlock(child)) {
      if (edge === 'next') fail(`${path}.${ownerId}.${edge}`, `next edge must reference an object block, not ${JSON.stringify(childId)}`);
      return;
    }
    const present = owners.get(childId) ?? [];
    present.push({id: ownerId, edge});
    owners.set(childId, present);
  };

  for (const [ownerId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    if (value.next !== null) registerOwner(value.next, ownerId, 'next');
    for (const [inputName, input] of Object.entries(value.inputs)) {
      for (let slot = 1; slot < input.length; slot += 1) {
        const childId = input[slot];
        if (typeof childId === 'string') registerOwner(childId, ownerId, `inputs.${inputName}[${slot}]`);
      }
    }
  }

  for (const [blockId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    const incoming = owners.get(blockId) ?? [];
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
    if (id.length === 0 || !Array.isArray(tuple) || (tuple.length !== 2 && tuple.length !== 3) || typeof tuple[0] !== 'string' || !isScalar(tuple[1]) || (tuple.length === 3 && tuple[2] !== true)) {
      fail(`${path}.variables.${id}`, 'invalid variable declaration');
    }
  }
  for (const [id, tuple] of Object.entries(lists)) {
    if (id.length === 0 || !Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || !Array.isArray(tuple[1]) || !tuple[1].every(isScalar)) {
      fail(`${path}.lists.${id}`, 'invalid list declaration');
    }
  }
  for (const [id, name] of Object.entries(broadcasts)) {
    if (id.length === 0 || typeof name !== 'string') fail(`${path}.broadcasts.${id}`, 'invalid broadcast declaration');
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

function validateMonitor(monitorValue: unknown, index: number, project: ScratchProject): void {
  const path = `$.monitors[${index}]`;
  const monitor = requireRecord(monitorValue, path);
  const opcode = requireString(monitor['opcode'], `${path}.opcode`);
  const id = requireString(monitor['id'], `${path}.id`);
  const params = requireRecord(monitor['params'], `${path}.params`);
  let target = project.targets.find(item => item.name === monitor['spriteName']);
  target ??= project.targets.find(item => item.isStage);
  if (!target) fail(path, 'cannot resolve monitor target');
  if (opcode === 'data_variable' || opcode === 'data_listcontents') {
    const declarations = opcode === 'data_variable' ? target.variables : target.lists;
    const stage = project.targets.find(item => item.isStage);
    if (!hasOwn(declarations, id) && (!stage || !hasOwn(opcode === 'data_variable' ? stage.variables : stage.lists, id))) {
      fail(`${path}.id`, `dangling monitored ${opcode === 'data_variable' ? 'variable' : 'list'} ${JSON.stringify(id)}`);
    }
    const parameter = opcode === 'data_variable' ? 'VARIABLE' : 'LIST';
    if (hasOwn(params, parameter) && typeof params[parameter] !== 'string') fail(`${path}.params.${parameter}`, 'expected a string');
  }
}

export function validateProject(value: unknown): asserts value is ScratchProject {
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

  const symbolIds = new Map<string, string>();
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    if (!target) continue;
    for (const kind of ['variable', 'list', 'broadcast'] as const) {
      for (const [id] of symbolEntries(target, kind)) {
        const path = `$.targets[${targetIndex}].${kind === 'variable' ? 'variables' : `${kind}s`}.${id}`;
        const previous = symbolIds.get(id);
        if (previous) fail(path, `duplicate project-wide symbol ID ${JSON.stringify(id)}; first declared at ${previous}`);
        symbolIds.set(id, path);
      }
    }
  }

  const project = value as ScratchProject;
  const stage = targets[0];
  if (!stage) fail('$.targets[0]', 'missing Stage');
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
    const resolveName = (kind: SymbolKind, name: string): NameResolution => {
      const matches = matchingSymbolNames(stage, kind, name);
      return matches.length === 1 ? 'unique' : matches.length === 0 ? 'missing' : 'ambiguous';
    };
    const runtimeSymbolIds = new Set<string>();
    for (const scope of target === stage ? [stage] : [target, stage]) {
      for (const kind of ['variable', 'list', 'broadcast'] as const) {
        for (const [id] of symbolEntries(scope, kind)) runtimeSymbolIds.add(id);
      }
    }
    const implicitReferences = new Map<string, {kind: SymbolKind; name: string; hasField: boolean; divergentDynamic: boolean}>();
    const registerImplicitReference: RegisterImplicitReference = (kind, name, effectiveId, referencePath, isDynamicPrimitive) => {
      if (runtimeSymbolIds.has(effectiveId)) {
        fail(referencePath, `implicit symbol ID ${JSON.stringify(effectiveId)} collides with a declaration visible to the Scratch loader`);
      }
      const previous = implicitReferences.get(effectiveId);
      if (!previous) {
        implicitReferences.set(effectiveId, {kind, name, hasField: !isDynamicPrimitive, divergentDynamic: false});
        return;
      }
      if (previous.kind !== kind || previous.name !== name) {
        if (isDynamicPrimitive && !previous.hasField) {
          previous.divergentDynamic = true;
          return;
        }
        fail(referencePath, `implicit symbol ID ${JSON.stringify(effectiveId)} would coalesce distinct references during Scratch loading`);
      }
      if (!isDynamicPrimitive && previous.divergentDynamic) {
        fail(referencePath, `implicit symbol ID ${JSON.stringify(effectiveId)} would coalesce distinct references during Scratch loading`);
      }
      if (!isDynamicPrimitive) previous.hasField = true;
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
      if (blockId.length === 0) fail(`${path}.blocks`, 'block IDs must not be empty');
      if (isScratchBlock(block)) validateBlock(block, `${path}.blocks.${blockId}`, blockIds, commentIds, resolve, resolveName, registerImplicitReference);
      else validatePrimitive(block, `${path}.blocks.${blockId}`, resolve, registerImplicitReference);
    }
    validateNoExecutableCycles(target, index);
    validateGraphOwnership(target, index);
    validateCommentLinks(target, index);
  }
  for (let index = 0; index < project.monitors.length; index += 1) validateMonitor(project.monitors[index], index, project);
  validateOfficialExtensions(project);
  if (officialSchemaError) throw officialSchemaError;
}
