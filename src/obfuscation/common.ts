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

interface ProcedurePlan {
  readonly code: Map<string, string>;
  readonly argumentsByCode: Map<string, Map<string, string>>;
  readonly argumentNames: Map<string, string>;
}

const PROCEDURE_PLACEHOLDER = /%[sbn]/g;

function uniqueId(generator: DeterministicGenerator, prefix: string, occupied: Set<string>): string {
  for (;;) {
    const candidate = generator.id(prefix);
    if (!occupied.has(candidate) && candidate !== '__proto__' && candidate !== 'constructor' && candidate !== 'prototype') {
      occupied.add(candidate);
      return candidate;
    }
  }
}

function uniqueName(generator: DeterministicGenerator, prefix: string, occupied: Set<string>): string {
  for (;;) {
    const candidate = generator.id(prefix, 14);
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
}

function targetSymbolMaps(
  project: ScratchProject,
  generator: DeterministicGenerator,
  stats: ObfuscationStats,
  frozenNameKinds: ReadonlySet<SymbolKind>
): Map<ScratchTarget, TargetSymbols> {
  const occupiedIds = new Set<string>();
  const occupiedNames = new Set<string>(['Stage']);
  for (const target of project.targets) {
    for (const dictionary of [target.variables, target.lists, target.broadcasts]) {
      for (const id of Object.keys(dictionary)) occupiedIds.add(id);
    }
    for (const tuple of Object.values(target.variables)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const tuple of Object.values(target.lists)) if (typeof tuple[0] === 'string') occupiedNames.add(tuple[0]);
    for (const name of Object.values(target.broadcasts)) occupiedNames.add(name);
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
      const cloud = tuple[2] === true;
      const oldName = typeof tuple[0] === 'string' ? tuple[0] : '';
      variables.set(id, {
        id: uniqueId(local, 'v_', occupiedIds),
        name: cloud || frozenNameKinds.has('variable') ? oldName : uniqueName(local, 'n_', occupiedNames),
        originalName: oldName
      });
      stats.identifiersRenamed += 1;
      if (!cloud && !frozenNameKinds.has('variable')) stats.symbolsRenamed += 1;
    }
    for (const [id, tuple] of Object.entries(target.lists)) {
      const oldName = typeof tuple[0] === 'string' ? tuple[0] : '';
      lists.set(id, {
        id: uniqueId(local, 'l_', occupiedIds),
        name: frozenNameKinds.has('list') ? oldName : uniqueName(local, 'n_', occupiedNames),
        originalName: oldName
      });
      stats.identifiersRenamed += 1;
      if (!frozenNameKinds.has('list')) stats.symbolsRenamed += 1;
    }
    for (const [id, name] of Object.entries(target.broadcasts)) {
      broadcasts.set(id, {id: uniqueId(local, 'c_', occupiedIds), name, originalName: name});
      stats.identifiersRenamed += 1;
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
  name: string,
  caseInsensitive: boolean
): Replacement[] {
  if (!symbols) return [];
  const expected = caseInsensitive ? name.toLowerCase() : name;
  const matches: Replacement[] = [];
  for (const replacement of symbols.values()) {
    const candidate = caseInsensitive ? replacement.originalName.toLowerCase() : replacement.originalName;
    if (candidate !== expected) continue;
    matches.push(replacement);
  }
  return matches;
}

function resolveSymbolByName(
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  kind: SymbolKind,
  name: string
): Replacement | undefined {
  const stage = stageOf(project);
  const matches = matchingName(maps.get(stage)?.[kind], name, false);
  return matches.length === 1 ? matches[0] : undefined;
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
      const label = uniqueName(generator, 'p_', occupiedNames);
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
        argumentNames.set(oldName, uniqueName(generator, 'n_', occupiedNames));
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
  if (!kind || typeof primitive[2] !== 'string') return;
  const replacement = resolveSymbol(project, maps, target, kind, primitive[2]);
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
  key: string,
  field: JsonValue[],
  project: ScratchProject,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  target: ScratchTarget,
  procedures: ProcedurePlan | undefined
): void {
  if ((key === 'VALUE') && typeof field[0] === 'string' && procedures?.argumentNames.has(field[0])) {
    field[0] = procedures.argumentNames.get(field[0]) ?? field[0];
  }
  const kind: SymbolKind | undefined = key === 'VARIABLE' ? 'variable' : key === 'LIST' ? 'list' : key === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
  if (!kind) return;
  const replacement = typeof field[1] === 'string' && field[1].length > 0
    ? resolveSymbol(project, maps, target, kind, field[1])
    : typeof field[0] === 'string'
      ? resolveSymbolByName(project, maps, kind, field[0])
      : undefined;
  if (!replacement) return;
  field[0] = replacement.name;
  if (field.length === 1) field.push(replacement.id);
  else field[1] = replacement.id;
}

function ambiguousNameOnlyKinds(project: ScratchProject): Set<SymbolKind> {
  const kinds = new Set<SymbolKind>();
  const originalMaps = new Map<ScratchTarget, TargetSymbols>();
  for (const target of project.targets) {
    const make = (entries: Array<[string, string]>): Map<string, Replacement> => new Map(entries.map(([id, name]) => [id, {id, name, originalName: name}]));
    originalMaps.set(target, {
      variable: make(Object.entries(target.variables).map(([id, tuple]) => [id, typeof tuple[0] === 'string' ? tuple[0] : ''])),
      list: make(Object.entries(target.lists).map(([id, tuple]) => [id, typeof tuple[0] === 'string' ? tuple[0] : ''])),
      broadcast: make(Object.entries(target.broadcasts))
    });
  }
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const [key, field] of Object.entries(value.fields)) {
        const kind: SymbolKind | undefined = key === 'VARIABLE' ? 'variable' : key === 'LIST' ? 'list' : key === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
        if (!kind || (typeof field[1] === 'string' && field[1].length > 0) || typeof field[0] !== 'string') continue;
        if (!resolveSymbolByName(project, originalMaps, kind, field[0])) kinds.add(kind);
      }
    }
  }
  return kinds;
}

function rewriteBlocks(
  project: ScratchProject,
  target: ScratchTarget,
  targetIndex: number,
  maps: ReadonlyMap<ScratchTarget, TargetSymbols>,
  generator: DeterministicGenerator,
  procedures: ProcedurePlan | undefined,
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
    for (const [fieldName, field] of Object.entries(value.fields)) rewriteField(fieldName, field, project, maps, target, procedures);
    rewritten[nextId] = value;
  }
  target.blocks = rewritten;
}

function rewriteMonitors(project: ScratchProject, maps: ReadonlyMap<ScratchTarget, TargetSymbols>): void {
  const stage = stageOf(project);
  for (const monitor of project.monitors) {
    const opcode = monitor['opcode'];
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
  const freezeVariableNames = project.monitors.some(monitor => monitor['opcode'] === 'sensing_of') || project.targets.some(target =>
    Object.values(target.blocks).some(block => isScratchBlock(block) && block.opcode === 'sensing_of')
  );
  const frozenNameKinds = ambiguousNameOnlyKinds(project);
  if (freezeVariableNames) frozenNameKinds.add('variable');
  if (freezeVariableNames) stats.warnings.push('Variable display names were preserved because the project uses name-based sensing.');
  if (frozenNameKinds.has('variable') && !freezeVariableNames) {
    stats.warnings.push('Variable display names were preserved because a name-only reference could not be resolved unambiguously.');
  }
  if (frozenNameKinds.has('list')) {
    stats.warnings.push('List display names were preserved because a name-only reference could not be resolved unambiguously.');
  }
  const maps = targetSymbolMaps(project, generator.fork('symbols'), stats, frozenNameKinds);

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
    rewriteBlocks(project, target, targetIndex, maps, generator.fork(`target:${targetIndex}:blocks`), procedures, stats);
    rebuildDeclarations(target, symbols);
    stats.commentsRemoved += Object.keys(target.comments).length;
    target.comments = orderedDictionary();
  }
  rewriteMonitors(project, maps);
}
