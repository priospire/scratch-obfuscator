import type {ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import {isRecord} from './json.js';

export const CORE_OPCODE_PREFIXES = new Set([
  'argument',
  'colour',
  'control',
  'data',
  'event',
  'looks',
  'math',
  'motion',
  'operator',
  'procedures',
  'sensing',
  'sound'
]);

export function isScratchBlock(value: unknown): value is ScratchBlock {
  return isRecord(value) && typeof value['opcode'] === 'string';
}

export function isPrimitive(value: unknown): value is ScratchInput {
  return Array.isArray(value) && typeof value[0] === 'number' && value[0] >= 4 && value[0] <= 13;
}

export function opcodePrefix(opcode: string): string {
  const separator = opcode.indexOf('_');
  return separator === -1 ? '' : opcode.slice(0, separator);
}

export function stageOf(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) {
    throw new Error('validated project has no Stage');
  }
  return stage;
}

export function countBlockEquivalents(project: ScratchProject): number {
  let count = 0;
  const visitPrimitive = (value: unknown): void => {
    if (isPrimitive(value)) count += 1;
  };
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      count += 1;
      if (!isScratchBlock(block)) continue;
      for (const input of Object.values(block.inputs)) {
        visitPrimitive(input[1]);
        visitPrimitive(input[2]);
      }
    }
  }
  return count;
}
