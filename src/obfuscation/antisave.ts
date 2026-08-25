import type {DeterministicGenerator} from '../deterministic.js';
import {countBlockEquivalents, isPrimitive, isScratchBlock, stageOf} from '../model/blocks.js';
import {orderedDictionary} from '../model/json.js';
import type {
  JsonValue,
  ScratchBlock,
  ScratchInput,
  ScratchProject
} from '../types.js';
import {isOfficialHatOpcode} from './analysis.js';

export const ANTI_SAVE_GENERATOR_DOMAIN = 'editor-resave-canaries:v2';
export const ANTI_SAVE_PASS_NAME = 'editor-resave-canaries';
export const ANTI_SAVE_CAVEAT =
  'antisave adds bounded native-hat guards and editor canaries, so it adds nonzero startup work and can shift timer or input sampling. The official Scratch editor can complete a save, but its signed-zero normalization makes a resaved copy trip each guarded stack when started; this is a deterrent, not guaranteed save prevention or protection against archive editing.';
export const ANTI_SAVE_NO_HATS_CAVEAT =
  'antisave found no official native hats, so the signed-zero canary has no automatic event entry to guard; manually started stacks remain outside its coverage.';

const MAX_FALLBACK_CANARIES = 32;
const MAX_GUARDED_NATIVE_HATS = 10_000;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_COUNT = 0x1900;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_FORMAT_CHARACTERS = Object.freeze([
  '\u200b',
  '\u2060',
  '\u2063',
  '\ufe00',
  '\ufe01',
  '\ufe02'
]);
const TRUSTED_ANTI_SAVE_MANIFESTS = new WeakSet<object>();

export interface AntiSaveProcedureManifest {
  readonly targetIndex: number;
  readonly procedureCode: string;
  readonly definitionId: string;
  readonly prototypeId: string;
  readonly guardId: string;
  readonly notId: string;
  readonly lessThanId: string;
  readonly divideId: string;
  readonly stopId: string;
}

export interface AntiSaveHatGuardManifest {
  readonly targetIndex: number;
  readonly hatId: string;
  readonly hatOpcode: string;
  readonly callId: string;
  readonly procedureCode: string;
  readonly originalNext: string | null;
}

export interface AntiSaveFallbackCanaryManifest {
  readonly targetIndex: number;
  readonly blockId: string;
  readonly inputName: string;
  readonly value: string;
}

export interface AntiSaveVerificationManifest {
  readonly stageTargetIndex: number;
  readonly sentinelVariableId: string;
  readonly sentinelName: string;
  readonly markerListId: string;
  readonly markerListName: string;
  readonly markerListValue: string;
  readonly procedures: readonly AntiSaveProcedureManifest[];
  readonly hatGuards: readonly AntiSaveHatGuardManifest[];
  readonly fallbackCanaries: readonly AntiSaveFallbackCanaryManifest[];
  readonly inactiveFallbackCanaries: number;
  readonly canaryCount: number;
  readonly generatedObjectBlockCount: number;
  readonly generatedBlockEquivalentCount: number;
}

export interface AntiSaveTransformResult {
  readonly sentinelVariableId: string;
  readonly markerListId: string;
  readonly procedureCode: string;
  readonly procedureCodes: readonly string[];
  readonly guardedHatCount: number;
  readonly inactiveFallbackCanaries: number;
  readonly canaryCount: number;
  readonly generatedBlockCount: number;
  readonly manifest: AntiSaveVerificationManifest;
  readonly caveats: readonly string[];
}

/**
 * Install a bounded signed-zero resave guard plus inert Unicode metadata markers.
 * Scratch's official save path canonicalizes the sentinel from -0 to +0; the
 * generated calls then trip before the original successor of each native hat.
 */
export function applyAntiSaveTransform(
  project: ScratchProject,
  generator: DeterministicGenerator
): AntiSaveTransformResult {
  if (project.targets.length === 0) throw new Error('antisave requires at least one Scratch target');
  const blockEquivalentsBefore = countBlockEquivalents(project);
  const stage = stageOf(project);
  const occupiedIds = collectOccupiedIds(project);
  const occupiedNames = collectOccupiedNames(project);
  const ids = generator.fork('ids');
  const names = generator.fork('names');
  const sentinelVariableId = uniqueId(ids.fork('sentinel'), 'v_as_', occupiedIds);
  const markerListId = uniqueId(ids.fork('list'), 'l_as_', occupiedIds);
  const sentinelName = uniqueUnicodeName(names.fork('sentinel'), occupiedNames, 0);
  const listName = uniqueUnicodeName(names.fork('list'), occupiedNames, 1);
  const procedureCode = uniqueUnicodeName(names.fork('procedure'), occupiedNames, 2);
  const listMarker = unicodeCanary(3, generator.fork('list-value'));

  const variables = orderedDictionary<JsonValue[]>();
  for (const [id, declaration] of Object.entries(stage.variables)) variables[id] = declaration;
  variables[sentinelVariableId] = [sentinelName, -0];
  stage.variables = variables;

  const lists = orderedDictionary<JsonValue[]>();
  for (const [id, declaration] of Object.entries(stage.lists)) lists[id] = declaration;
  lists[markerListId] = [listName, [listMarker]];
  stage.lists = lists;

  const guard = installSignedZeroGuards(
    project,
    sentinelVariableId,
    sentinelName,
    procedureCode,
    names.fork('target-procedures'),
    occupiedNames,
    ids.fork('blocks'),
    occupiedIds
  );
  const fallbackCanaries = markInactiveFallbacks(project, generator.fork('fallbacks'));
  const inactiveFallbackCanaries = fallbackCanaries.length;
  const canaryCount = 2 + guard.procedureCodes.length + inactiveFallbackCanaries;
  const generatedBlockEquivalentCount = countBlockEquivalents(project) - blockEquivalentsBefore;
  const expectedBlockEquivalentCount = (guard.procedures.length * 10) + guard.hatGuards.length;
  if (generatedBlockEquivalentCount !== expectedBlockEquivalentCount) {
    throw new Error(
      `antisave growth accounting mismatch (${generatedBlockEquivalentCount} !== ${expectedBlockEquivalentCount})`
    );
  }
  const manifest = registerManifest(Object.freeze({
    stageTargetIndex: guard.stageTargetIndex,
    sentinelVariableId,
    sentinelName,
    markerListId,
    markerListName: listName,
    markerListValue: listMarker,
    procedures: guard.procedures,
    hatGuards: guard.hatGuards,
    fallbackCanaries,
    inactiveFallbackCanaries,
    canaryCount,
    generatedObjectBlockCount: guard.generatedBlockCount,
    generatedBlockEquivalentCount
  }));

  return Object.freeze({
    sentinelVariableId,
    markerListId,
    procedureCode,
    procedureCodes: guard.procedureCodes,
    guardedHatCount: guard.guardedHatCount,
    inactiveFallbackCanaries,
    canaryCount,
    generatedBlockCount: guard.generatedBlockCount,
    manifest,
    caveats: Object.freeze(guard.guardedHatCount === 0
      ? [ANTI_SAVE_CAVEAT, ANTI_SAVE_NO_HATS_CAVEAT]
      : [ANTI_SAVE_CAVEAT])
  });
}

export function isTrustedAntiSaveVerificationManifest(
  value: unknown
): value is AntiSaveVerificationManifest {
  return typeof value === 'object' && value !== null && TRUSTED_ANTI_SAVE_MANIFESTS.has(value);
}

function registerManifest<T extends AntiSaveVerificationManifest>(manifest: T): T {
  TRUSTED_ANTI_SAVE_MANIFESTS.add(manifest);
  return manifest;
}

function collectOccupiedIds(project: ScratchProject): Set<string> {
  const occupied = new Set<string>();
  for (const target of project.targets) {
    for (const dictionary of [target.variables, target.lists, target.broadcasts, target.blocks, target.comments]) {
      for (const id of Object.keys(dictionary)) occupied.add(id);
    }
  }
  return occupied;
}

function collectOccupiedNames(project: ScratchProject): Set<string> {
  const occupied = new Set<string>();
  for (const target of project.targets) {
    occupied.add(target.name);
    for (const declaration of Object.values(target.variables)) {
      if (typeof declaration[0] === 'string') occupied.add(declaration[0]);
    }
    for (const declaration of Object.values(target.lists)) {
      if (typeof declaration[0] === 'string') occupied.add(declaration[0]);
    }
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      const proccode = value.mutation?.['proccode'];
      if (typeof proccode === 'string') occupied.add(proccode);
    }
  }
  return occupied;
}

function uniqueId(generator: DeterministicGenerator, prefix: string, occupied: Set<string>): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const candidate = generator.id(prefix, 24);
    if (!occupied.has(candidate) && !RESERVED_KEYS.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new Error('could not allocate a collision-free antisave ID');
}

function uniqueUnicodeName(
  generator: DeterministicGenerator,
  occupied: Set<string>,
  ordinal: number
): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const candidate = unicodeCanary(ordinal + (attempt * 17), generator.fork(`attempt:${attempt}`));
    if (!occupied.has(candidate) && !RESERVED_KEYS.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
  throw new Error('could not allocate a collision-free antisave name');
}

function buildGuardProcedure(
  sentinelVariableId: string,
  sentinelName: string,
  procedureCode: string,
  allocate: () => string
): {
  readonly blocks: ReadonlyMap<string, ScratchBlock>;
  readonly ids: Omit<AntiSaveProcedureManifest, 'targetIndex' | 'procedureCode'>;
} {
  const definitionId = allocate();
  const prototypeId = allocate();
  const guardId = allocate();
  const notId = allocate();
  const lessThanId = allocate();
  const divideId = allocate();
  const stopId = allocate();
  const blocks = new Map<string, ScratchBlock>();
  const mutation = procedureMutation(procedureCode);

  blocks.set(definitionId, {
    opcode: 'procedures_definition', next: guardId, parent: null,
    inputs: {custom_block: [1, prototypeId]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0
  });
  blocks.set(prototypeId, {
    opcode: 'procedures_prototype', next: null, parent: definitionId, inputs: {}, fields: {},
    shadow: true, topLevel: false, mutation
  });
  blocks.set(guardId, {
    opcode: 'control_if', next: null, parent: definitionId,
    inputs: {CONDITION: [2, notId], SUBSTACK: [2, stopId]}, fields: {}, shadow: false, topLevel: false
  });
  blocks.set(notId, {
    opcode: 'operator_not', next: null, parent: guardId, inputs: {OPERAND: [2, lessThanId]},
    fields: {}, shadow: false, topLevel: false
  });
  blocks.set(lessThanId, {
    opcode: 'operator_lt', next: null, parent: notId,
    inputs: {OPERAND1: [2, divideId], OPERAND2: numericInput(0)}, fields: {}, shadow: false, topLevel: false
  });
  blocks.set(divideId, {
    opcode: 'operator_divide', next: null, parent: lessThanId,
    inputs: {NUM1: numericInput(1), NUM2: [1, [12, sentinelName, sentinelVariableId]]},
    fields: {}, shadow: false, topLevel: false
  });
  blocks.set(stopId, {
    opcode: 'control_stop', next: null, parent: guardId, inputs: {},
    fields: {STOP_OPTION: ['all', null]}, shadow: false, topLevel: false,
    mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
  });
  return {
    blocks,
    ids: Object.freeze({
      definitionId,
      prototypeId,
      guardId,
      notId,
      lessThanId,
      divideId,
      stopId
    })
  };
}

function procedureMutation(proccode: string): Record<string, JsonValue> {
  return {
    tagName: 'mutation', children: [], proccode,
    argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true'
  };
}

function numericInput(value: number): ScratchInput {
  return [1, [4, String(value)]];
}

function prependBlocks(
  target: ScratchProject['targets'][number],
  generated: ReadonlyMap<string, ScratchBlock>
): void {
  const blocks = orderedDictionary<typeof target.blocks[string]>();
  for (const [id, block] of generated) blocks[id] = block;
  for (const [id, block] of Object.entries(target.blocks)) blocks[id] = block;
  target.blocks = blocks;
}

function installSignedZeroGuards(
  project: ScratchProject,
  sentinelVariableId: string,
  sentinelName: string,
  stageProcedureCode: string,
  procedureNames: DeterministicGenerator,
  occupiedNames: Set<string>,
  blockIds: DeterministicGenerator,
  occupiedIds: Set<string>
): {
  readonly stageTargetIndex: number;
  readonly guardedHatCount: number;
  readonly generatedBlockCount: number;
  readonly procedureCodes: readonly string[];
  readonly procedures: readonly AntiSaveProcedureManifest[];
  readonly hatGuards: readonly AntiSaveHatGuardManifest[];
} {
  const allocate = (): string => uniqueId(blockIds, 'b_as_', occupiedIds);
  const sites = project.targets.flatMap((target, targetIndex) => Object.entries(target.blocks)
    .filter(([, value]) => isScratchBlock(value) && value.topLevel && isOfficialHatOpcode(value.opcode))
    .map(([hatId, value]) => {
      if (!isScratchBlock(value)) throw new Error('antisave native hat is unavailable');
      return Object.freeze({
        targetIndex,
        hatId,
        hatOpcode: value.opcode,
        originalNext: value.next
      });
    }));
  if (sites.length > MAX_GUARDED_NATIVE_HATS) {
    throw new Error(`antisave native-hat limit exceeded (${sites.length} > ${MAX_GUARDED_NATIVE_HATS})`);
  }
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const targetIndexes = new Set(sites.map(site => site.targetIndex));
  targetIndexes.add(stageIndex);
  const generatedByTarget = new Map<number, Map<string, ScratchBlock>>();
  const procedureByTarget = new Map<number, string>();
  const procedures: AntiSaveProcedureManifest[] = [];

  for (const targetIndex of targetIndexes) {
    const target = project.targets[targetIndex];
    if (!target) throw new Error('antisave guard target is unavailable');
    const procedureCode = targetIndex === stageIndex
      ? stageProcedureCode
      : uniqueUnicodeName(
          procedureNames.fork(`target:${targetIndex}`),
          occupiedNames,
          targetIndex + 101
        );
    procedureByTarget.set(targetIndex, procedureCode);
    const built = buildGuardProcedure(
      sentinelVariableId,
      sentinelName,
      procedureCode,
      allocate
    );
    generatedByTarget.set(targetIndex, new Map(built.blocks));
    procedures.push(Object.freeze({targetIndex, procedureCode, ...built.ids}));
  }

  if (!procedureByTarget.has(stageIndex)) throw new Error('antisave Stage guard procedure is unavailable');

  const hatGuards: AntiSaveHatGuardManifest[] = [];
  for (const site of sites) {
    const target = project.targets[site.targetIndex];
    const generated = generatedByTarget.get(site.targetIndex);
    const code = procedureByTarget.get(site.targetIndex);
    const hat = target?.blocks[site.hatId];
    if (!target || !generated || !code || !isScratchBlock(hat)) {
      throw new Error('antisave guarded native hat is unavailable');
    }
    if (hat.opcode !== site.hatOpcode || hat.next !== site.originalNext) {
      throw new Error('antisave guarded native hat changed during guard planning');
    }
    const callId = allocate();
    generated.set(callId, procedureCall(site.hatId, site.originalNext, code));
    if (site.originalNext !== null) {
      const successor = target.blocks[site.originalNext];
      if (!isScratchBlock(successor)) throw new Error('antisave guarded continuation is unavailable');
      successor.parent = callId;
    }
    hat.next = callId;
    hatGuards.push(Object.freeze({
      targetIndex: site.targetIndex,
      hatId: site.hatId,
      hatOpcode: site.hatOpcode,
      callId,
      procedureCode: code,
      originalNext: site.originalNext
    }));
  }

  let generatedBlockCount = 0;
  for (const [targetIndex, generated] of generatedByTarget) {
    const target = project.targets[targetIndex];
    if (!target) throw new Error('antisave generated target is unavailable');
    prependBlocks(target, generated);
    generatedBlockCount += generated.size;
  }
  return {
    stageTargetIndex: stageIndex,
    guardedHatCount: sites.length,
    generatedBlockCount,
    procedureCodes: Object.freeze([...procedureByTarget.values()]),
    procedures: Object.freeze(procedures),
    hatGuards: Object.freeze(hatGuards)
  };
}

function procedureCall(parent: string, next: string | null, proccode: string): ScratchBlock {
  return {
    opcode: 'procedures_call', next, parent, inputs: {}, fields: {}, shadow: false, topLevel: false,
    mutation: procedureMutation(proccode)
  };
}

function markInactiveFallbacks(
  project: ScratchProject,
  generator: DeterministicGenerator
): readonly AntiSaveFallbackCanaryManifest[] {
  const canaries: AntiSaveFallbackCanaryManifest[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const [inputName, input] of Object.entries(value.inputs)) {
        if (canaries.length >= MAX_FALLBACK_CANARIES) return Object.freeze(canaries);
        if (input[0] !== 3 || input[1] === null || input[1] === undefined || !isPrimitive(input[2])) continue;
        const canary = unicodeCanary(
          canaries.length + 23,
          generator.fork(`${targetIndex}:${blockId}:${inputName}`)
        );
        input[2] = [10, canary];
        canaries.push(Object.freeze({targetIndex, blockId, inputName, value: canary}));
      }
    }
  }
  return Object.freeze(canaries);
}

function unicodeCanary(ordinal: number, generator: DeterministicGenerator): string {
  const bytes = generator.bytes(18);
  let value = `\u2063\u200b\u2060${String.fromCharCode(PRIVATE_USE_START + (ordinal % PRIVATE_USE_COUNT))}`;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    value += SAFE_FORMAT_CHARACTERS[(byte + index + ordinal) % SAFE_FORMAT_CHARACTERS.length];
    value += String.fromCharCode(
      PRIVATE_USE_START + ((byte + (ordinal * 257) + (index * 17)) % PRIVATE_USE_COUNT)
    );
  }
  const normalized = value.normalize('NFC');
  if (!isSafeCanaryText(normalized)) throw new Error('antisave generated an unsafe Unicode canary');
  return normalized;
}

export function isSafeCanaryText(value: string): boolean {
  if (value !== value.normalize('NFC')) return false;
  if (value.includes('\u0000') || /\uffff|\ufeff|\u200c|\u200d|[\r\n]/u.test(value)) return false;
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return value.length > 0;
}
