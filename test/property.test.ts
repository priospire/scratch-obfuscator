import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ObfuscationMode, ScratchBlock, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';

const opcodeArbitrary = fc.constantFrom(
  'data_setvariableto',
  'data_changevariableby',
  'looks_say',
  'looks_show',
  'looks_hide',
  'motion_setx',
  'motion_sety'
);

const projectArbitrary = fc.record({
  opcodes: fc.array(opcodeArbitrary, {minLength: 0, maxLength: 12}),
  variableName: fc.string({maxLength: 16}),
  literal: fc.string({maxLength: 24}),
  initial: fc.integer({min: -10_000, max: 10_000}),
  seed: fc.uint8Array({minLength: 32, maxLength: 32})
}).map(({opcodes, variableName, literal, initial, seed}) => ({
  project: linearProject(opcodes, variableName, literal, initial),
  seed
}));

const extendedFuzz = process.env['SCRATCH_OBFUSCATOR_EXTENDED_FUZZ'] === '1';
const propertyTimeout = extendedFuzz ? 120_000 : 40_000;

describe('deterministic valid-project properties', () => {
  it('keeps every generated lossless graph isomorphic and deterministic', () => {
    fc.assert(fc.property(projectArbitrary, ({project, seed}) => {
      const before = orderedOpcodes(project);
      const first = obfuscateProject(project, 'lossless', seed);
      const second = obfuscateProject(project, 'lossless', seed);
      validateProject(first.project);
      expect(JSON.stringify(first.project)).toBe(JSON.stringify(second.project));
      expect(orderedOpcodes(first.project)).toEqual(before);
      expect(first.stats.blocksAfter).toBe(first.stats.blocksBefore);
    }), {
      seed: 0x5b33_0001,
      numRuns: extendedFuzz ? 3_000 : 150
    });
  }, propertyTimeout);

  it.each<ObfuscationMode>(['lossy', 'no-preserve'])('keeps %s output valid, bounded, and deterministic', mode => {
    fc.assert(fc.property(projectArbitrary, ({project, seed}) => {
      const first = obfuscateProject(project, mode, seed);
      const second = obfuscateProject(project, mode, seed);
      validateProject(first.project);
      expect(JSON.stringify(first.project)).toBe(JSON.stringify(second.project));
      const cap = mode === 'lossy'
        ? Math.max(first.stats.blocksBefore, Math.min(first.stats.blocksBefore * 4, 50_000))
        : Math.max(first.stats.blocksBefore, Math.min((first.stats.blocksBefore * 25) + 512, 100_000));
      expect(first.stats.blocksAfter).toBeLessThanOrEqual(cap);
    }), {
      seed: mode === 'lossy' ? 0x5b33_0002 : 0x5b33_0003,
      numRuns: extendedFuzz ? (mode === 'lossy' ? 2_000 : 700) : (mode === 'lossy' ? 100 : 35)
    });
  }, propertyTimeout);
});

function linearProject(opcodes: readonly string[], variableName: string, literal: string, initial: number): ScratchProject {
  const blocks: Record<string, ScratchBlock> = Object.create(null) as Record<string, ScratchBlock>;
  const ids = ['hat', ...opcodes.map((_, index) => `block_${index}`)];
  blocks['hat'] = {
    opcode: 'event_whenflagclicked',
    next: ids[1] ?? null,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 123,
    y: -45
  };
  for (let index = 0; index < opcodes.length; index += 1) {
    const id = ids[index + 1];
    if (!id) continue;
    const opcode = opcodes[index] ?? 'looks_show';
    blocks[id] = blockForOpcode(opcode, ids[index] ?? 'hat', ids[index + 2] ?? null, variableName, literal, index);
  }
  return {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {variable: [variableName, initial]},
      lists: {},
      broadcasts: {},
      blocks,
      comments: {},
      currentCostume: 0,
      costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: 'backdrop1'}],
      sounds: []
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'}
  };
}

function blockForOpcode(
  opcode: string,
  parent: string,
  next: string | null,
  variableName: string,
  literal: string,
  ordinal: number
): ScratchBlock {
  const base = {opcode, next, parent, shadow: false, topLevel: false};
  if (opcode === 'data_setvariableto' || opcode === 'data_changevariableby') {
    return {...base, inputs: {VALUE: [1, [opcode === 'data_setvariableto' ? 10 : 4, opcode === 'data_setvariableto' ? literal : String(ordinal + 1)]]}, fields: {VARIABLE: [variableName, 'variable']}};
  }
  if (opcode === 'looks_say') return {...base, inputs: {MESSAGE: [1, [10, literal]]}, fields: {}};
  if (opcode === 'motion_setx') return {...base, inputs: {X: [1, [4, String(ordinal)]]}, fields: {}};
  if (opcode === 'motion_sety') return {...base, inputs: {Y: [1, [4, String(-ordinal)]]}, fields: {}};
  return {...base, inputs: {}, fields: {}};
}

function orderedOpcodes(project: ScratchProject): Array<Array<string | number>> {
  return project.targets.map(target => Object.values(target.blocks).map(value => isScratchBlock(value) ? value.opcode : Number(value[0])));
}
