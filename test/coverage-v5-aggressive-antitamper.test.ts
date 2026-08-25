import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import {
  ANTI_CHEAT_DECOY_COUNT,
  ANTI_CHEAT_WATERMARK_NAME,
  applyAntiCheatTransform
} from '../src/obfuscation/anticheat.js';
import type {ObfuscationMode, ObfuscationStats, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('aggressive and anti-tamper validated edge coverage', () => {
  it('builds a bounded watchdog without event guards and blinds every expectation', () => {
    const project = emptyExecutableProject();
    validateProject(project);

    const result = applyAntiCheatTransform(project, generator(7, 'anti-empty'));

    expect(result.guardedHatCount).toBe(0);
    expect(result.guardProcedureCount).toBe(0);
    expect(result.generatedBlockCount).toBe(36);
    expect(countBlockEquivalents(project)).toBe(61);
    const stage = requireStage(project);
    const joins: ScratchBlock[] = [];
    const subtractions: ScratchBlock[] = [];
    const encodedExpectationIds = new Set<string>();
    const encodedExpectationBlocks = new Set<ScratchBlock>();
    for (const value of Object.values(stage.blocks)) {
      if (!isScratchBlock(value)) continue;
      if (value.opcode === 'operator_join') joins.push(value);
      if (value.opcode === 'operator_subtract') subtractions.push(value);
      if (value.opcode !== 'operator_equals') continue;
      const sentinel = value.inputs['OPERAND1']?.[1];
      const expectedId = value.inputs['OPERAND2']?.[1];
      if (!isPrimitive(sentinel) || sentinel[0] !== 12 || typeof sentinel[2] !== 'string' || typeof expectedId !== 'string') {
        continue;
      }
      const expected = stage.blocks[expectedId];
      if (!isScratchBlock(expected)) throw new Error('encoded anti-cheat expectation is unavailable');
      encodedExpectationIds.add(sentinel[2]);
      encodedExpectationBlocks.add(expected);
    }
    const expectedSentinelIds = new Set([...result.decoyVariableIds, result.latchVariableId]);
    expect(result.decoyVariableIds).toHaveLength(ANTI_CHEAT_DECOY_COUNT);
    expect(encodedExpectationIds).toEqual(expectedSentinelIds);
    expect(encodedExpectationBlocks).toEqual(new Set(joins));
    expect(joins).toHaveLength(ANTI_CHEAT_DECOY_COUNT + 1);
    expect(subtractions).toHaveLength(0);
    expect(stage.variables[result.watermarkVariableId]).toEqual([ANTI_CHEAT_WATERMARK_NAME, 0]);
    expect(encodedExpectationIds.has(result.watermarkVariableId)).toBe(false);
    for (const join of joins) {
      const left = join.inputs['STRING1']?.[1];
      const right = join.inputs['STRING2']?.[1];
      expect(isPrimitive(left) && left[0] === 10 && typeof left[1] === 'string' && left[1].length > 0).toBe(true);
      expect(isPrimitive(right) && right[0] === 10 && typeof right[1] === 'string' && right[1].length > 0).toBe(true);
    }
    expect(project.targets.filter(target => !target.isStage).every(target => Object.keys(target.blocks).length === 0)).toBe(true);
    validateProject(project);
  });

  it('preserves Scratch defaults while inverting conditions with absent inputs and branches', () => {
    const first = conditionalDefaultsProject();
    const second = conditionalDefaultsProject();
    const compact = conditionalDefaultsProject();
    validateProject(first);
    const before = countBlockEquivalents(first);
    const firstStats = stats(first, 'lossy');
    const secondStats = stats(second, 'lossy');

    applyAggressiveTransforms(compact, 'lossy', generator(13, 'condition-defaults'), stats(compact, 'lossy'));
    applyAggressiveTransforms(first, 'lossy', generator(13, 'condition-defaults'), firstStats, undefined, true);
    applyAggressiveTransforms(second, 'lossy', generator(13, 'condition-defaults'), secondStats, undefined, true);

    expect(countBlockEquivalents(compact)).toBe(Math.min(before * 2, 30_000));
    expect(first).toEqual(second);
    expect(firstStats).toEqual(secondStats);
    expect(countBlockEquivalents(first)).toBe(Math.min(
      Math.max(before * 4, before + 256),
      50_000
    ));
    const stage = requireStage(first);
    for (const id of ['missing-if', 'missing-if-else']) {
      const block = stage.blocks[id];
      if (!isScratchBlock(block)) throw new Error(`conditional ${id} is unavailable`);
      expect(block.opcode).toBe('control_if_else');
      expect(block.inputs['SUBSTACK']).toEqual([2, null]);
      expect(block.inputs['SUBSTACK2']).toEqual([2, null]);
      const notId = block.inputs['CONDITION']?.[1];
      const not = typeof notId === 'string' ? stage.blocks[notId] : undefined;
      expect(isScratchBlock(not) ? not.opcode : undefined).toBe('operator_not');
      expect(isScratchBlock(not) ? not.inputs['OPERAND'] : undefined).toEqual([1, [10, '']]);
    }
    validateProject(first);
  });

  it('virtualizes a missing change-variable input as Scratch numeric zero', () => {
    const project = missingChangeInputProject();
    validateProject(project);
    const resultStats = stats(project, 'no-preserve');

    applyAggressiveTransforms(project, 'no-preserve', generator(29, 'change-default'), resultStats);

    const stage = requireStage(project);
    expect(stage.variables['score']).toBeUndefined();
    expect(Object.values(stage.lists).some(declaration => (
      Array.isArray(declaration[1]) && declaration[1].some(value => value === 5)
    ))).toBe(true);
    const change = stage.blocks['change'];
    if (!isScratchBlock(change)) throw new Error('virtualized change block is unavailable');
    expect(change.opcode).toBe('data_replaceitemoflist');
    const addId = change.inputs['ITEM']?.[1];
    const add = typeof addId === 'string' ? stage.blocks[addId] : undefined;
    if (!isScratchBlock(add)) throw new Error('virtualized addition is unavailable');
    expect(add.opcode).toBe('operator_add');
    expect(evaluateNumericInput(stage, add.inputs['NUM2'])).toBe(0);
    expect(resultStats.variablesVirtualized).toBe(1);
    validateProject(project);
  });
});

function generator(seed: number, domain: string): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => (seed + (index * 31)) & 0xff),
    `test:coverage-v5:${domain}`
  );
}

function emptyExecutableProject(): ScratchProject {
  const project = createFixtureProject();
  project.monitors = [];
  for (const target of project.targets) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  return project;
}

function conditionalDefaultsProject(): ScratchProject {
  const project = emptyExecutableProject();
  const stage = requireStage(project);
  stage.blocks['missing-if'] = block('control_if');
  stage.blocks['missing-if-else'] = block('control_if_else');
  return project;
}

function missingChangeInputProject(): ScratchProject {
  const project = emptyExecutableProject();
  const stage = requireStage(project);
  stage.variables['score'] = ['score', 5];
  stage.blocks['change'] = {
    ...block('data_changevariableby'),
    fields: {VARIABLE: ['score', 'score']}
  };
  return project;
}

function block(opcode: string): ScratchBlock {
  return {
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
}

function requireStage(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function stats(project: ScratchProject, mode: Extract<ObfuscationMode, 'lossy' | 'no-preserve'>): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode,
    blocksBefore: blocks,
    blocksAfter: blocks,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function evaluateNumericInput(target: ScratchTarget, input: ScratchInput | undefined): number {
  const active = input?.[1];
  if (isPrimitive(active)) return Number(active[1]);
  const blockValue = typeof active === 'string' ? target.blocks[active] : undefined;
  if (!isScratchBlock(blockValue) || blockValue.opcode !== 'operator_multiply') {
    throw new Error('numeric input is outside the exact equation subset');
  }
  return evaluateNumericInput(target, blockValue.inputs['NUM1'])
    * evaluateNumericInput(target, blockValue.inputs['NUM2']);
}
