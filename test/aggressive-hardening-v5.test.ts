import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
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
    expect(countBlockEquivalents(first)).toBeLessThanOrEqual(Math.min(before * 4, 50_000));
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

  it('accounts for every block-equivalent at zero and minimum live-site quotas', () => {
    for (const mode of ['lossy', 'no-preserve'] as const) {
      for (const objectCount of [0, 1, 2, 4]) {
        for (let seed = 0; seed < 4; seed += 1) {
          const project = tinyProject(objectCount);
          const before = countBlockEquivalents(project);
          const resultStats = stats(project, mode);
          applyAggressiveTransforms(project, mode, quotaGenerator(seed), resultStats);
          const cap = mode === 'lossy'
            ? Math.max(before, Math.min(before * 4, 50_000))
            : Math.max(before, Math.min((before * 25) + 512, 100_000));
          expect(countBlockEquivalents(project)).toBe(cap);
          expect(resultStats.blocksAfter).toBe(countObjectBlocks(project));
          validateProject(project);
        }
      }
    }
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
