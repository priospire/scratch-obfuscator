import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {ANTI_CHEAT_DECOY_COUNT, ANTI_CHEAT_WATERMARK_NAME} from '../src/obfuscation/anticheat.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ObfuscationMode, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureProject} from './support.js';

const MODES: readonly ObfuscationMode[] = ['lossless', 'lossy', 'no-preserve'];

describe('integrated optimization and protection pipeline', () => {
  it.each(MODES)('adds a deterministic anti-cheat layer after %s transforms', mode => {
    const source = arithmeticProject();
    const snapshot = JSON.stringify(source);
    const seed = new Uint8Array(32).fill(0xa4);
    const first = obfuscateProject(source, mode, seed, {antiCheat: true});
    const second = obfuscateProject(source, mode, seed, {antiCheat: true});

    expect(first.project).toEqual(second.project);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(first.stats.antiCheatDecoys).toBe(ANTI_CHEAT_DECOY_COUNT);
    expect(first.stats.decoysAdded).toBeGreaterThanOrEqual(ANTI_CHEAT_DECOY_COUNT);
    expect(watermarkCount(first.project)).toBe(1);
    expect(watermarkCount(obfuscateProject(source, mode, seed).project)).toBe(1);
    expect(hasInactiveFallback(first.project)).toBe(false);
    validateProject(first.project);
  });

  it.each(MODES)('preserves one pre-existing watermark through %s mode', mode => {
    const source = arithmeticProject();
    const stage = source.targets[0];
    if (!stage) throw new Error('fixture Stage is missing');
    stage.variables['existing-watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'existing value'];

    const plain = obfuscateProject(source, mode, new Uint8Array(32).fill(0x71));
    const protectedProject = obfuscateProject(source, mode, new Uint8Array(32).fill(0x71), {antiCheat: true});

    expect(watermarkCount(plain.project)).toBe(1);
    expect(watermarkCount(protectedProject.project)).toBe(1);
    expect(watermarkValue(plain.project)).toBe('existing value');
    expect(watermarkValue(protectedProject.project)).toBe('existing value');
  });

  it('keeps lossless executable reporters while removing hidden fallback payloads', () => {
    const result = obfuscateProject(arithmeticProject(), 'lossless', new Uint8Array(32).fill(0x31));

    expect(result.stats.constantsFolded).toBe(0);
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    expect(opcodeCount(result.project, 'operator_add')).toBe(1);
    expect(opcodeCount(result.project, 'operator_multiply')).toBe(1);
    expect(hasInactiveFallback(result.project)).toBe(false);
  });

  it.each<ObfuscationMode>(['lossy', 'no-preserve'])('precomputes static reporter trees in %s mode', mode => {
    const result = obfuscateProject(arithmeticProject(), mode, new Uint8Array(32).fill(0x52));

    expect(result.stats.constantsFolded).toBe(1);
    expect(result.stats.inactiveFallbacksRemoved).toBeGreaterThanOrEqual(1);
    expect(hasInactiveFallback(result.project)).toBe(false);
    validateProject(result.project);
  });

  it('rejects an invalid anti-cheat option type', () => {
    expect(() => obfuscateProject(
      arithmeticProject(),
      'lossless',
      new Uint8Array(32),
      {antiCheat: 'yes'} as unknown as {antiCheat: boolean}
    )).toThrow(/antiCheat must be a boolean/u);
  });
});

function arithmeticProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  project.targets = [stage];
  project.monitors = [];
  stage.variables = {result: ['Readable result', 0]};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'set',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0
    },
    set: {
      opcode: 'data_setvariableto',
      next: null,
      parent: 'hat',
      inputs: {VALUE: [3, 'multiply', [4, '999']]},
      fields: {VARIABLE: ['Readable result', 'result']},
      shadow: false,
      topLevel: false
    },
    multiply: {
      opcode: 'operator_multiply',
      next: null,
      parent: 'set',
      inputs: {NUM1: [2, 'add'], NUM2: [1, [4, '8']]},
      fields: {},
      shadow: false,
      topLevel: false
    },
    add: {
      opcode: 'operator_add',
      next: null,
      parent: 'multiply',
      inputs: {NUM1: [1, [4, '5']], NUM2: [1, [4, '4']]},
      fields: {},
      shadow: false,
      topLevel: false
    }
  };
  return project;
}

function watermarkCount(project: ScratchProject): number {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) return 0;
  return Object.values(stage.variables).filter(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME).length;
}

function watermarkValue(project: ScratchProject): unknown {
  const stage = project.targets.find(target => target.isStage);
  return Object.values(stage?.variables ?? {}).find(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME)?.[1];
}

function opcodeCount(project: ScratchProject, opcode: string): number {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (isScratchBlock(value) && value.opcode === opcode) count += 1;
    }
  }
  return count;
}

function hasInactiveFallback(project: ScratchProject): boolean {
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      if (Object.values(value.inputs).some(input => input[0] === 3 && input.length > 2)) return true;
    }
  }
  return false;
}
