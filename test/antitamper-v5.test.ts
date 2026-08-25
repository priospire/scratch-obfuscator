import {createRequire} from 'node:module';
import {strFromU8, unzipSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {countBlockEquivalents} from '../src/obfuscation/analysis.js';
import {applyAntiCheatTransform} from '../src/obfuscation/anticheat.js';
import type {ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  saveProjectSb3(): Promise<Blob | Uint8Array>;
  quit(): void;
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object' || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('anti-tamper v5 hardening', () => {
  it('blinds every sentinel expectation without increasing the fixed object-block bound', () => {
    const first = createFixtureProject();
    const second = createFixtureProject();
    const firstEquivalents = countBlockEquivalents(first);
    const secondEquivalents = countBlockEquivalents(second);
    const firstResult = applyAntiCheatTransform(first, generator(19));
    const secondResult = applyAntiCheatTransform(second, generator(19));

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.generatedBlockCount).toBe(110);
    expect(countBlockEquivalents(first) - firstEquivalents).toBe(185);
    expect(countBlockEquivalents(second) - secondEquivalents).toBe(185);
    validateProject(first);

    const stage = requireStage(first);
    const sentinelIds = [
      ...firstResult.decoyVariableIds,
      firstResult.latchVariableId
    ];
    const expectations = new Map(sentinelIds.map(id => [id, stage.variables[id]?.[1]]));
    const stringExpectations = new Set(
      [...expectations.values()].filter((value): value is string => typeof value === 'string')
    );
    const observed = new Map<string, number>();

    for (const target of first.targets) {
      for (const value of Object.values(target.blocks)) {
        if (!isScratchBlock(value)) continue;
        for (const input of Object.values(value.inputs)) {
          for (const slot of input.slice(1)) {
            if (isPrimitive(slot) && slot[0] === 10 && typeof slot[1] === 'string') {
              expect(stringExpectations.has(slot[1])).toBe(false);
            }
          }
        }
        if (value.opcode !== 'operator_equals') continue;
        const reporter = value.inputs['OPERAND1']?.[1];
        const sentinelId = isPrimitive(reporter) && reporter[0] === 12 && typeof reporter[2] === 'string'
          ? reporter[2]
          : undefined;
        if (!sentinelId || !expectations.has(sentinelId)) continue;
        const encodedId = value.inputs['OPERAND2']?.[1];
        expect(typeof encodedId).toBe('string');
        if (typeof encodedId !== 'string') continue;
        const encoded = target.blocks[encodedId];
        const expected = expectations.get(sentinelId);
        expect(isScratchBlock(encoded)).toBe(true);
        if (!isScratchBlock(encoded)) continue;
        if (typeof expected === 'string') {
          expect(encoded.opcode).toBe('operator_join');
          const left = encoded.inputs['STRING1']?.[1];
          const right = encoded.inputs['STRING2']?.[1];
          const leftValue = isPrimitive(left) && left[0] === 10 && typeof left[1] === 'string'
            ? left[1]
            : undefined;
          const rightValue = isPrimitive(right) && right[0] === 10 && typeof right[1] === 'string'
            ? right[1]
            : undefined;
          expect(typeof leftValue).toBe('string');
          expect(typeof rightValue).toBe('string');
          if (leftValue !== undefined && rightValue !== undefined) {
            expect(leftValue + rightValue).toBe(expected);
          }
        } else {
          expect(encoded.opcode).toBe('operator_subtract');
        }
        observed.set(sentinelId, (observed.get(sentinelId) ?? 0) + 1);
      }
    }

    for (const id of sentinelIds) expect(observed.get(id)).toBe(3);
    expect(countInlineSentinelReads(first, new Set([firstResult.watermarkVariableId]))).toBe(0);
  });

  it('selects deterministic balanced and folded integrity-tree shapes across seeds', () => {
    const depths = new Set<number>();
    for (let seed = 0; seed < 18; seed += 1) {
      const first = createFixtureProject();
      const second = createFixtureProject();
      const firstResult = applyAntiCheatTransform(first, generator(seed));
      const secondResult = applyAntiCheatTransform(second, generator(seed));
      expect(first).toEqual(second);
      expect(firstResult).toEqual(secondResult);
      depths.add(watchdogOrDepth(first, firstResult.watchdogHatId));
    }
    expect(depths.size).toBeGreaterThanOrEqual(2);
    expect(Math.min(...depths)).toBeLessThan(Math.max(...depths));
  });

  it('retains typed inline sentinel reads through VM load, save, reload, and resave', async () => {
    const project = createFixtureProject();
    const result = applyAntiCheatTransform(project, generator(41));
    const sentinelIds = new Set([
      ...result.decoyVariableIds,
      result.latchVariableId
    ]);
    const watermarkIds = new Set([result.watermarkVariableId]);
    const expectedInlineReads = countInlineSentinelReads(project, sentinelIds);
    expect(expectedInlineReads).toBeGreaterThan(0);
    expect(countInlineSentinelReads(project, watermarkIds)).toBe(0);
    const firstVm = createVm();
    const secondVm = createVm();
    try {
      await firstVm.loadProject(createFixtureArchive(project));
      const firstSaved = await blobBytes(await firstVm.saveProjectSb3());
      const firstRoundTrip = projectFromArchive(firstSaved);
      validateProject(firstRoundTrip);
      expect(countInlineSentinelReads(firstRoundTrip, sentinelIds)).toBe(expectedInlineReads);
      expect(countInlineSentinelReads(firstRoundTrip, watermarkIds)).toBe(0);
      expect(countObjectSentinelReads(firstRoundTrip, sentinelIds)).toBe(0);

      await secondVm.loadProject(firstSaved);
      const secondSaved = await blobBytes(await secondVm.saveProjectSb3());
      const secondRoundTrip = projectFromArchive(secondSaved);
      validateProject(secondRoundTrip);
      expect(countInlineSentinelReads(secondRoundTrip, sentinelIds)).toBe(expectedInlineReads);
      expect(countInlineSentinelReads(secondRoundTrip, watermarkIds)).toBe(0);
      expect(countObjectSentinelReads(secondRoundTrip, sentinelIds)).toBe(0);
    } finally {
      firstVm.quit();
      secondVm.quit();
    }
  }, 30_000);
});

function generator(seed: number): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => (seed + (index * 17)) & 0xff),
    'test:anti-tamper-v5'
  );
}

function requireStage(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture Stage is unavailable');
  return stage;
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

function projectFromArchive(archive: Uint8Array): ScratchProject {
  const projectJson = unzipSync(archive)['project.json'];
  if (!projectJson) throw new Error('saved project has no project.json');
  return JSON.parse(strFromU8(projectJson)) as ScratchProject;
}

function countInlineSentinelReads(project: ScratchProject, sentinelIds: ReadonlySet<string>): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const input of Object.values(value.inputs)) {
        const active = input[1];
        if (isPrimitive(active) && active[0] === 12 && typeof active[2] === 'string' && sentinelIds.has(active[2])) {
          count += 1;
        }
      }
    }
  }
  return count;
}

function countObjectSentinelReads(project: ScratchProject, sentinelIds: ReadonlySet<string>): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'data_variable') continue;
      const variableId = value.fields['VARIABLE']?.[1];
      if (typeof variableId === 'string' && sentinelIds.has(variableId)) count += 1;
    }
  }
  return count;
}

function watchdogOrDepth(project: ScratchProject, hatId: string): number {
  const stage = requireStage(project);
  const hat = stage.blocks[hatId];
  const forever = isScratchBlock(hat) && hat.next ? stage.blocks[hat.next] : undefined;
  const guardId = isScratchBlock(forever) ? forever.inputs['SUBSTACK']?.[1] : undefined;
  const guard = typeof guardId === 'string' ? stage.blocks[guardId] : undefined;
  const rootId = isScratchBlock(guard) ? guard.inputs['CONDITION']?.[1] : undefined;
  if (typeof rootId !== 'string') throw new Error('watchdog condition is unavailable');
  return orDepth(stage, rootId, new Set());
}

function orDepth(target: ScratchTarget, blockId: string, visited: Set<string>): number {
  if (visited.has(blockId)) throw new Error('watchdog condition contains a cycle');
  visited.add(blockId);
  const block = target.blocks[blockId];
  if (!isScratchBlock(block) || block.opcode !== 'operator_or') return 0;
  const left = block.inputs['OPERAND1']?.[1];
  const right = block.inputs['OPERAND2']?.[1];
  if (typeof left !== 'string' || typeof right !== 'string') {
    throw new Error('watchdog disjunction is malformed');
  }
  return 1 + Math.max(orDepth(target, left, new Set(visited)), orDepth(target, right, new Set(visited)));
}
