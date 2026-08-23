import {describe, expect, it} from 'vitest';
import {recoverAdversarialStructure} from '../scripts/readability-metrics.mjs';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ScratchBlock, ScratchBlockValue, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {createFixtureProject} from './support.js';

interface ProcedureInfo {
  readonly definitionId: string;
  readonly prototypeId: string;
  readonly bodyId: string;
}

interface NormalizedNode {
  readonly id: string;
  readonly opcode: string;
  readonly next: string | null;
  readonly parent: string | null;
  readonly inputs: Readonly<Record<string, readonly string[]>>;
  readonly fields: readonly string[];
  readonly procedure: string | null;
}

interface NormalizedGraph {
  readonly nodes: readonly NormalizedNode[];
  readonly symbols: readonly string[];
  readonly foldedLiterals: number;
  readonly inlinedProcedures: number;
  readonly prunedBlocks: number;
}

describe('aggressive adversarial normalization', () => {
  it('retains encoded-PC dispatch after names, IDs, layout, dead graphs, literals, and simple helpers are normalized', () => {
    const source = normalizationFixture();
    const originalIdentifiers = [
      'original-variable-id',
      'Readable Original Variable',
      ...Array.from({length: 6}, (_, index) => `original-step-${index}`)
    ];

    const transformed = obfuscateProject(source, 'no-preserve', new Uint8Array(32).fill(61)).project;
    const transformedJson = JSON.stringify(transformed);
    for (const identifier of originalIdentifiers) expect(transformedJson).not.toContain(identifier);

    const recovered = recoverAdversarialStructure(transformed);
    expect(recovered.dispatchers).toHaveLength(1);
    expect(recovered.dispatchers[0]?.stateRailCount).toBe(3);
    expect(recovered.dispatchers[0]?.transitionStoreCount).toBe(3);
    expect(recovered.dispatchers[0]?.transitionCount).toBe(5);
    expect(recovered.dispatchers[0]?.recoveredTransitionEdges).toBe(0);
    expect(recovered.dispatchers[0]?.unresolvedTransitionEdges).toBe(4);
    expect(recovered.dispatchers[0]?.relational).toBe(true);
    expect(recovered.dispatchers[0]?.recoveryStatus).toBe('structural-only');
    expect(recovered.recoveredDispatcherChains).toEqual([]);
    expect(recovered.digest).toBe('d0060e83c7207799438435ea699fd5b2e518e90f488e567a2203aff597082b60');

    const normalized = adversarialNormalize(transformed);
    const normalizedJson = JSON.stringify(normalized);
    for (const identifier of originalIdentifiers) expect(normalizedJson).not.toContain(identifier);
    expect(normalized.foldedLiterals).toBeGreaterThan(0);
    expect(normalized.inlinedProcedures).toBe(0);
    expect(normalized.prunedBlocks).toBe(0);

    const dispatcherBranches = normalized.nodes.filter(node => node.opcode === 'control_if_else' || node.opcode === 'control_if');
    expect(dispatcherBranches.length).toBeGreaterThanOrEqual(7);
    expect(normalized.nodes.filter(node => node.opcode === 'operator_equals').length).toBeGreaterThanOrEqual(7);
    expect(normalized.nodes.filter(node => node.opcode === 'data_itemoflist').length).toBeGreaterThanOrEqual(7);
    expect(normalized.nodes.some(node => node.opcode === 'procedures_call')).toBe(true);

    const operationalIds = new Set(normalized.nodes
      .filter(node => node.opcode === 'data_replaceitemoflist')
      .map(node => node.id));
    expect(operationalIds.size).toBeGreaterThanOrEqual(6);
    for (const node of normalized.nodes.filter(candidate => operationalIds.has(candidate.id))) {
      expect(node.next === null || !operationalIds.has(node.next)).toBe(true);
    }
  });
});

function normalizationFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'original-variable-id': ['Readable Original Variable', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'original-hat': block('event_whenflagclicked', 'original-step-0', null, true)
  };
  for (let index = 0; index < 6; index += 1) {
    sprite.blocks[`original-step-${index}`] = block(
      'data_setvariableto',
      index === 5 ? null : `original-step-${index + 1}`,
      index === 0 ? 'original-hat' : `original-step-${index - 1}`,
      false,
      {VALUE: [1, [10, `Readable value ${index}`]]},
      {VARIABLE: ['Readable Original Variable', 'original-variable-id']}
    );
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function adversarialNormalize(project: ScratchProject): NormalizedGraph {
  const nodes: NormalizedNode[] = [];
  const symbols: string[] = [];
  let foldedLiterals = 0;
  let inlinedProcedures = 0;
  let prunedBlocks = 0;

  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    const procedures = collectProcedures(target);
    const folded = new Map<string, string>();
    const inlined = new Map<string, readonly string[]>();
    const reachable = new Set<string>();

    const visitReference = (id: string): void => {
      const literal = foldableJoin(target, id);
      if (literal !== undefined) {
        if (!folded.has(id)) folded.set(id, literal);
        return;
      }
      visit(id);
    };
    const visit = (id: string): void => {
      if (reachable.has(id)) return;
      const value = target.blocks[id];
      if (!value || !isScratchBlock(value)) return;
      reachable.add(id);
      if (value.next) visitReference(value.next);
      for (const input of Object.values(value.inputs)) {
        for (const slot of input.slice(1)) {
          if (typeof slot === 'string' && target.blocks[slot] !== undefined) visitReference(slot);
        }
      }
      if (value.opcode !== 'procedures_call') return;
      const code = procedureCode(value);
      const procedure = code === undefined ? undefined : procedures.get(code);
      if (!procedure) return;
      const simple = simpleProcedureOpcodes(target, procedure);
      if (simple) {
        inlined.set(id, simple);
        return;
      }
      visit(procedure.definitionId);
    };

    for (const [id, value] of Object.entries(target.blocks)) {
      if (isScratchBlock(value) && value.topLevel && isRunnableHat(value.opcode)) visit(id);
    }

    const objectBlockCount = Object.values(target.blocks).filter(isScratchBlock).length;
    prunedBlocks += objectBlockCount - reachable.size - folded.size;
    foldedLiterals += folded.size;
    inlinedProcedures += inlined.size;

    const blockIds = new Map<string, string>();
    for (const id of reachable) blockIds.set(id, `T${targetIndex}B${blockIds.size}`);
    const variableIds = canonicalSymbols(target.variables, `T${targetIndex}V`, symbols);
    const listIds = canonicalSymbols(target.lists, `T${targetIndex}L`, symbols);
    const broadcastIds = canonicalSymbols(target.broadcasts, `T${targetIndex}R`, symbols);
    const procedureIds = new Map<string, string>();
    const canonicalProcedure = (code: string): string => {
      const present = procedureIds.get(code);
      if (present) return present;
      const canonical = `T${targetIndex}P${procedureIds.size}`;
      procedureIds.set(code, canonical);
      return canonical;
    };

    for (const id of reachable) {
      const value = target.blocks[id];
      if (!value || !isScratchBlock(value)) continue;
      const canonicalId = blockIds.get(id);
      if (!canonicalId) throw new Error('reachable block is missing its canonical ID');
      const inline = inlined.get(id);
      const inputs: Record<string, readonly string[]> = {};
      for (const [name, input] of Object.entries(value.inputs)) {
        inputs[name] = input.slice(1).map(slot => normalizeSlot(
          slot,
          blockIds,
          folded,
          variableIds,
          listIds,
          broadcastIds
        ));
      }
      const code = procedureCode(value);
      nodes.push({
        id: canonicalId,
        opcode: inline ? `inline(${inline.join(',')})` : value.opcode,
        next: value.next ? blockIds.get(value.next) ?? null : null,
        parent: value.parent ? blockIds.get(value.parent) ?? null : null,
        inputs,
        fields: Object.values(value.fields).flatMap(field => field.map(slot => normalizeSymbolValue(
          slot,
          variableIds,
          listIds,
          broadcastIds
        ))),
        procedure: code === undefined ? null : canonicalProcedure(code)
      });
    }
  }

  return {nodes, symbols, foldedLiterals, inlinedProcedures, prunedBlocks};
}

function collectProcedures(target: ScratchTarget): Map<string, ProcedureInfo> {
  const procedures = new Map<string, ProcedureInfo>();
  for (const [definitionId, value] of Object.entries(target.blocks)) {
    if (!isScratchBlock(value) || value.opcode !== 'procedures_definition' || !value.next) continue;
    const prototypeId = value.inputs['custom_block']?.[1];
    if (typeof prototypeId !== 'string') continue;
    const prototype = target.blocks[prototypeId];
    if (!prototype || !isScratchBlock(prototype)) continue;
    const code = procedureCode(prototype);
    if (code !== undefined) procedures.set(code, {definitionId, prototypeId, bodyId: value.next});
  }
  return procedures;
}

function simpleProcedureOpcodes(target: ScratchTarget, procedure: ProcedureInfo): readonly string[] | undefined {
  const opcodes: string[] = [];
  const visited = new Set<string>();
  let id: string | null = procedure.bodyId;
  while (id !== null && opcodes.length < 3 && !visited.has(id)) {
    visited.add(id);
    const value: ScratchBlockValue | undefined = target.blocks[id];
    if (!value || !isScratchBlock(value) || /^(?:control|event|procedures)_/.test(value.opcode)) return undefined;
    for (const input of Object.values(value.inputs)) {
      for (const slot of input.slice(1)) {
        if (typeof slot === 'string' && target.blocks[slot] !== undefined && foldableJoin(target, slot) === undefined) return undefined;
      }
    }
    opcodes.push(value.opcode);
    id = value.next;
  }
  return id === null && opcodes.length > 0 && opcodes.length <= 2 ? opcodes : undefined;
}

function foldableJoin(target: ScratchTarget, id: string): string | undefined {
  const value = target.blocks[id];
  if (!value || !isScratchBlock(value) || value.opcode !== 'operator_join') return undefined;
  const left = value.inputs['STRING1']?.[1];
  const right = value.inputs['STRING2']?.[1];
  if (!isPrimitive(left) || left[0] !== 10 || typeof left[1] !== 'string') return undefined;
  if (!isPrimitive(right) || right[0] !== 10 || typeof right[1] !== 'string') return undefined;
  return left[1] + right[1];
}

function canonicalSymbols(
  declarations: Readonly<Record<string, unknown>>,
  prefix: string,
  output: string[]
): Map<string, string> {
  const result = new Map<string, string>();
  let ordinal = 0;
  for (const [id, declaration] of Object.entries(declarations)) {
    const canonical = `${prefix}${ordinal}`;
    ordinal += 1;
    result.set(id, canonical);
    const displayName = isUnknownArray(declaration) ? declaration[0] : declaration;
    if (typeof displayName === 'string') result.set(displayName, `${canonical}N`);
    output.push(`${canonical}:${canonical.toLowerCase()}`);
  }
  return result;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function normalizeSlot(
  value: ScratchInput[number],
  blockIds: ReadonlyMap<string, string>,
  folded: ReadonlyMap<string, string>,
  variableIds: ReadonlyMap<string, string>,
  listIds: ReadonlyMap<string, string>,
  broadcastIds: ReadonlyMap<string, string>
): string {
  if (typeof value === 'string') {
    const literal = folded.get(value);
    if (literal !== undefined) return `literal:${JSON.stringify(literal)}`;
    return blockIds.get(value) ?? `value:${JSON.stringify(value)}`;
  }
  if (isPrimitive(value)) {
    return `primitive:${value.map(slot => normalizeSymbolValue(slot, variableIds, listIds, broadcastIds)).join('|')}`;
  }
  return `value:${JSON.stringify(value)}`;
}

function normalizeSymbolValue(
  value: ScratchInput[number],
  variableIds: ReadonlyMap<string, string>,
  listIds: ReadonlyMap<string, string>,
  broadcastIds: ReadonlyMap<string, string>
): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  return variableIds.get(value) ?? listIds.get(value) ?? broadcastIds.get(value) ?? value;
}

function procedureCode(blockValue: ScratchBlock): string | undefined {
  const code = blockValue.mutation?.['proccode'];
  return typeof code === 'string' ? code : undefined;
}

function isRunnableHat(opcode: string): boolean {
  return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  topLevel: boolean,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {
    opcode,
    next,
    parent,
    inputs,
    fields,
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 40, y: 60} : {})
  };
}
