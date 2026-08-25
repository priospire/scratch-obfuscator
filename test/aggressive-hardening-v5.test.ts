import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import {aggressiveBlockEquivalentCap} from '../src/growth-policy.js';
import type {ObfuscationStats, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('aggressive v5 hardening', () => {
  it('constant-blinds lossy opaque predicates deterministically within the growth cap', () => {
    const first = createFixtureProject();
    const second = createFixtureProject();
    const before = countBlockEquivalents(first);
    const firstStats = stats(first);
    const secondStats = stats(second);

    applyAggressiveTransforms(first, 'lossy', generator(), firstStats);
    applyAggressiveTransforms(second, 'lossy', generator(), secondStats);

    expect(first).toEqual(second);
    expect(firstStats).toEqual(secondStats);
    expect(countBlockEquivalents(first)).toBeLessThanOrEqual(Math.max(before, Math.min(before * 2, 30_000)));
    validateProject(first);

    const primitiveStrings = collectPrimitiveStrings(first);
    const blindedMismatches = new Set<string>();
    for (const target of first.targets) {
      for (const value of Object.values(target.blocks)) {
        if (!isScratchBlock(value) || value.opcode !== 'operator_equals') continue;
        const variable = value.inputs['OPERAND1']?.[1];
        const encodedId = value.inputs['OPERAND2']?.[1];
        if (!isPrimitive(variable) || variable[0] !== 12 || typeof encodedId !== 'string') continue;
        const encoded = target.blocks[encodedId];
        if (!isScratchBlock(encoded) || encoded.opcode !== 'operator_join') continue;
        const left = encoded.inputs['STRING1']?.[1];
        const right = encoded.inputs['STRING2']?.[1];
        if (
          !isPrimitive(left) || left[0] !== 10 || typeof left[1] !== 'string'
          || !isPrimitive(right) || right[0] !== 10 || typeof right[1] !== 'string'
        ) continue;
        const reconstructed = `${left[1]}${right[1]}`;
        if (reconstructed.startsWith('z_')) blindedMismatches.add(reconstructed);
      }
    }

    expect(blindedMismatches.size).toBeGreaterThan(0);
    for (const mismatch of blindedMismatches) expect(primitiveStrings).not.toContain(mismatch);
  });

  it('accounts for every block-equivalent within the bounded growth quota', () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      for (const allowSize of [false, true]) {
        for (const objectCount of [0, 1, 2, 4]) {
          for (let seed = 0; seed < 4; seed += 1) {
            const project = tinyProject(objectCount);
            const before = countBlockEquivalents(project);
            const resultStats = stats(project, mode);
            applyAggressiveTransforms(project, mode, quotaGenerator(seed), resultStats, undefined, allowSize);
            const cap = aggressiveBlockEquivalentCap(before, mode, allowSize);
            expect(countBlockEquivalents(project)).toBeGreaterThanOrEqual(before);
            expect(countBlockEquivalents(project)).toBeLessThanOrEqual(cap);
            expect(resultStats.blocksAfter).toBe(countObjectBlocks(project));
            validateProject(project);
          }
        }
      }
    }
  });

  it('uses expanded quota for more eligible structural output deterministically', () => {
    const compact = eligibleLinearProject();
    const expanded = eligibleLinearProject();
    const expandedRepeat = eligibleLinearProject();
    const compactStats = stats(compact, 'no-preserve');
    const expandedStats = stats(expanded, 'no-preserve');
    const repeatStats = stats(expandedRepeat, 'no-preserve');

    applyAggressiveTransforms(compact, 'no-preserve', quotaGenerator(0x55), compactStats);
    applyAggressiveTransforms(expanded, 'no-preserve', quotaGenerator(0x55), expandedStats, undefined, true);
    applyAggressiveTransforms(expandedRepeat, 'no-preserve', quotaGenerator(0x55), repeatStats, undefined, true);

    expect(expanded).toEqual(expandedRepeat);
    expect(expandedStats).toEqual(repeatStats);
    expect(expandedStats.virtualizedBlocks).toBeGreaterThan(compactStats.virtualizedBlocks);
    expect(countBlockEquivalents(expanded)).toBeGreaterThan(countBlockEquivalents(compact));
    validateProject(compact);
    validateProject(expanded);
  });
});

function generator(): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(0xa7), 'test:aggressive-hardening-v5');
}

function quotaGenerator(seed: number): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(seed), 'test:aggressive-minimum-quotas');
}

function stats(project: ScratchProject, mode: 'lossy' | 'no-preserve' = 'lossy'): ObfuscationStats {
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

function tinyProject(objectCount: number): ScratchProject {
  const project = createFixtureProject();
  project.monitors = [];
  for (const target of project.targets) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  for (let index = 0; index < objectCount; index += 1) {
    const id = `tiny-${index}`;
    stage.blocks[id] = {
      opcode: index % 2 === 0 ? 'looks_show' : 'looks_hide',
      next: index + 1 < objectCount ? `tiny-${index + 1}` : null,
      parent: index === 0 ? null : `tiny-${index - 1}`,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: index === 0,
      ...(index === 0 ? {x: 0, y: 0} : {})
    };
  }
  return project;
}

function eligibleLinearProject(): ScratchProject {
  const project = createFixtureProject();
  project.monitors = [];
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture sprite is unavailable');
  sprite.blocks = {};
  for (let index = 0; index < 30; index += 1) {
    const id = `linear-${index}`;
    sprite.blocks[id] = {
      opcode: 'data_setvariableto',
      next: index === 29 ? null : `linear-${index + 1}`,
      parent: index === 0 ? null : `linear-${index - 1}`,
      inputs: {VALUE: [1, [10, `value-${index}`]]},
      fields: {VARIABLE: ['Readable score', 'local_score']},
      shadow: false,
      topLevel: index === 0,
      ...(index === 0 ? {x: 10, y: 20} : {})
    };
  }
  validateProject(project);
  return project;
}

function collectPrimitiveStrings(project: ScratchProject): string[] {
  const values: string[] = [];
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const input of Object.values(value.inputs)) {
        for (const slot of input.slice(1)) {
          if (isPrimitive(slot) && typeof slot[1] === 'string') values.push(slot[1]);
        }
      }
    }
  }
  return values;
}
