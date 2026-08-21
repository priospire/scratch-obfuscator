import {isPrimitive, isScratchBlock} from '../model/blocks.js';
import {cloneProject} from '../model/json.js';
import type {ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../types.js';
import {validateProject} from '../validation/index.js';

type StaticValue = boolean | number | string;

interface OperatorSpec {
  readonly inputs: readonly string[];
  readonly fields: readonly string[];
  evaluate(
    args: Readonly<Record<string, StaticValue>>,
    fields: Readonly<Record<string, StaticValue>>
  ): StaticValue | undefined;
}

export interface OptimizationStats {
  reporterTreesFolded: number;
  reporterBlocksRemoved: number;
  inactiveFallbacksRemoved: number;
  inactiveFallbackBlocksRemoved: number;
  commentsRemoved: number;
}

export interface OptimizationResult {
  project: ScratchProject;
  stats: OptimizationStats;
}

export interface OptimizationOptions {
  readonly foldConstants?: boolean;
}

const numericBinary = (evaluate: (left: number, right: number) => number): OperatorSpec => ({
  inputs: ['NUM1', 'NUM2'],
  fields: [],
  evaluate: args => {
    const left = toNumber(requiredValue(args, 'NUM1'));
    const right = toNumber(requiredValue(args, 'NUM2'));
    return left === undefined || right === undefined ? undefined : evaluate(left, right);
  }
});

const comparison = (evaluate: (comparisonResult: number) => boolean): OperatorSpec => ({
  inputs: ['OPERAND1', 'OPERAND2'],
  fields: [],
  evaluate: args => {
    const result = compare(requiredValue(args, 'OPERAND1'), requiredValue(args, 'OPERAND2'));
    return result === undefined ? undefined : evaluate(result);
  }
});

const OPERATOR_SPECS: Readonly<Record<string, OperatorSpec>> = Object.freeze({
  operator_add: numericBinary((left, right) => left + right),
  operator_subtract: numericBinary((left, right) => left - right),
  operator_multiply: numericBinary((left, right) => left * right),
  operator_divide: numericBinary((left, right) => left / right),
  operator_lt: comparison(result => result < 0),
  operator_equals: comparison(result => result === 0),
  operator_gt: comparison(result => result > 0),
  operator_and: {
    inputs: ['OPERAND1', 'OPERAND2'],
    fields: [],
    evaluate: args => toBoolean(requiredValue(args, 'OPERAND1')) && toBoolean(requiredValue(args, 'OPERAND2'))
  },
  operator_or: {
    inputs: ['OPERAND1', 'OPERAND2'],
    fields: [],
    evaluate: args => toBoolean(requiredValue(args, 'OPERAND1')) || toBoolean(requiredValue(args, 'OPERAND2'))
  },
  operator_not: {
    inputs: ['OPERAND'],
    fields: [],
    evaluate: args => !toBoolean(requiredValue(args, 'OPERAND'))
  },
  operator_join: {
    inputs: ['STRING1', 'STRING2'],
    fields: [],
    evaluate: args => String(requiredValue(args, 'STRING1')) + String(requiredValue(args, 'STRING2'))
  },
  operator_letter_of: {
    inputs: ['LETTER', 'STRING'],
    fields: [],
    evaluate: args => {
      const number = toNumber(requiredValue(args, 'LETTER'));
      if (number === undefined) return undefined;
      const index = number - 1;
      const value = String(requiredValue(args, 'STRING'));
      return index < 0 || index >= value.length ? '' : value.charAt(index);
    }
  },
  operator_length: {
    inputs: ['STRING'],
    fields: [],
    evaluate: args => String(requiredValue(args, 'STRING')).length
  },
  operator_contains: {
    inputs: ['STRING1', 'STRING2'],
    fields: [],
    evaluate: args => {
      const haystack = String(requiredValue(args, 'STRING1'));
      const needle = String(requiredValue(args, 'STRING2'));
      if (!isAscii(haystack) || !isAscii(needle)) return undefined;
      return asciiLowerCase(haystack).includes(asciiLowerCase(needle));
    }
  },
  operator_mod: {
    inputs: ['NUM1', 'NUM2'],
    fields: [],
    evaluate: args => {
      const dividend = toNumber(requiredValue(args, 'NUM1'));
      const modulus = toNumber(requiredValue(args, 'NUM2'));
      if (dividend === undefined || modulus === undefined) return undefined;
      let result = dividend % modulus;
      if (result / modulus < 0) result += modulus;
      return result;
    }
  },
  operator_round: {
    inputs: ['NUM'],
    fields: [],
    evaluate: args => {
      const value = toNumber(requiredValue(args, 'NUM'));
      return value === undefined ? undefined : Math.round(value);
    }
  },
  operator_mathop: {
    inputs: ['NUM'],
    fields: ['OPERATOR'],
    evaluate: (args, fields) => {
      const value = toNumber(requiredValue(args, 'NUM'));
      return value === undefined
        ? undefined
        : portableMathOperation(asciiLowerCase(String(requiredValue(fields, 'OPERATOR'))), value);
    }
  }
});

/**
 * Optimize a validated project without mutating the caller's value.
 */
export function optimizeProject(project: ScratchProject, options: OptimizationOptions = {}): OptimizationResult {
  validateProject(project);
  const output = cloneProject(project);
  const stats = createStats();
  optimizeValidatedProject(output, options, stats);
  validateOptimizedProject(output);
  return {project: output, stats};
}

/**
 * Apply the optimizer atomically: the caller is changed only after the complete
 * candidate passes project validation.
 */
export function applySafeOptimizations(
  project: ScratchProject,
  options: OptimizationOptions = {}
): OptimizationStats {
  const result = optimizeProject(project, options);
  project.targets = result.project.targets;
  return result.stats;
}

function createStats(): OptimizationStats {
  return {
    reporterTreesFolded: 0,
    reporterBlocksRemoved: 0,
    inactiveFallbacksRemoved: 0,
    inactiveFallbackBlocksRemoved: 0,
    commentsRemoved: 0
  };
}

function optimizeValidatedProject(
  project: ScratchProject,
  options: OptimizationOptions,
  stats: OptimizationStats
): void {
  for (const target of project.targets) {
    const incoming = collectIncomingReferences(target);
    removeInactiveFallbacks(target, incoming, stats);
    if (options.foldConstants !== false) foldStaticReporterInputs(target, incoming, stats);
  }
}

function collectIncomingReferences(target: ScratchTarget): Map<string, number> {
  const incoming = new Map<string, number>();
  const add = (id: string): void => {
    incoming.set(id, (incoming.get(id) ?? 0) + 1);
  };
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    if (value.next !== null) add(value.next);
    for (const input of Object.values(value.inputs)) {
      for (let index = 1; index < input.length; index += 1) {
        const item = input[index];
        if (typeof item === 'string') add(item);
      }
    }
  }
  return incoming;
}

function removeInactiveFallbacks(
  target: ScratchTarget,
  incoming: Map<string, number>,
  stats: OptimizationStats
): void {
  for (const [ownerId, snapshot] of Object.entries(target.blocks)) {
    if (!isScratchBlock(snapshot) || target.blocks[ownerId] !== snapshot) continue;
    for (const [inputName, input] of Object.entries(snapshot.inputs)) {
      if (input[0] !== 3 || input[1] === null || input[1] === undefined) continue;
      const active = input[1];
      const fallback = input[2] ?? null;
      snapshot.inputs[inputName] = [2, active];
      if (fallback === null) continue;
      stats.inactiveFallbacksRemoved += 1;
      if (typeof fallback === 'string') {
        removeIncomingReference(target, fallback, incoming, stats, 'fallback');
      }
    }
  }
}

function foldStaticReporterInputs(
  target: ScratchTarget,
  incoming: Map<string, number>,
  stats: OptimizationStats
): void {
  for (const [ownerId, snapshot] of Object.entries(target.blocks)) {
    if (!isScratchBlock(snapshot) || target.blocks[ownerId] !== snapshot) continue;
    for (const [inputName, input] of Object.entries(snapshot.inputs)) {
      const reporterId = input[1];
      if (typeof reporterId !== 'string') continue;
      const value = evaluateReporter(target, reporterId, ownerId, incoming, new Set());
      const primitive = value === undefined ? undefined : encodedPrimitive(value);
      if (!primitive) continue;
      snapshot.inputs[inputName] = [1, primitive];
      stats.reporterTreesFolded += 1;
      removeIncomingReference(target, reporterId, incoming, stats, 'fold');
    }
  }
}

function evaluateReporter(
  target: ScratchTarget,
  id: string,
  ownerId: string,
  incoming: ReadonlyMap<string, number>,
  visiting: Set<string>
): StaticValue | undefined {
  if (visiting.has(id) || incoming.get(id) !== 1) return undefined;
  const block = target.blocks[id];
  if (!block || !isScratchBlock(block)) return undefined;
  const spec = OPERATOR_SPECS[block.opcode];
  if (!spec || block.parent !== ownerId || block.topLevel || block.shadow || block.next !== null || block.mutation !== undefined) {
    return undefined;
  }
  if (!sameKeys(block.inputs, spec.inputs) || !sameKeys(block.fields, spec.fields)) return undefined;

  visiting.add(id);
  try {
    const args: Record<string, StaticValue> = Object.create(null) as Record<string, StaticValue>;
    for (const inputName of spec.inputs) {
      const input = block.inputs[inputName];
      if (!input) return undefined;
      const value = evaluateInput(target, input, id, incoming, visiting);
      if (value === undefined) return undefined;
      args[inputName] = value;
    }
    const fields: Record<string, StaticValue> = Object.create(null) as Record<string, StaticValue>;
    for (const fieldName of spec.fields) {
      const tuple = block.fields[fieldName];
      const value = tuple?.[0];
      if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') return undefined;
      fields[fieldName] = value;
    }
    return spec.evaluate(args, fields);
  } finally {
    visiting.delete(id);
  }
}

function evaluateInput(
  target: ScratchTarget,
  input: ScratchInput,
  ownerId: string,
  incoming: ReadonlyMap<string, number>,
  visiting: Set<string>
): StaticValue | undefined {
  const active = input[1];
  if (isPrimitive(active)) return primitiveValue(active);
  if (typeof active === 'string') {
    return evaluateReporter(target, active, ownerId, incoming, visiting);
  }
  return undefined;
}

function primitiveValue(primitive: ScratchInput): StaticValue | undefined {
  const code = primitive[0];
  const value = primitive[1];
  if (typeof code !== 'number' || code < 4 || code > 10) return undefined;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

function encodedPrimitive(value: StaticValue): ScratchInput | undefined {
  if (typeof value === 'string') return [10, value];
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) return undefined;
  return [4, value];
}

function removeIncomingReference(
  target: ScratchTarget,
  id: string,
  incoming: Map<string, number>,
  stats: OptimizationStats,
  reason: 'fallback' | 'fold'
): void {
  const remaining = (incoming.get(id) ?? 0) - 1;
  if (remaining > 0) {
    incoming.set(id, remaining);
    return;
  }
  incoming.delete(id);
  pruneUnreferencedSubtree(target, id, incoming, stats, reason);
}

function pruneUnreferencedSubtree(
  target: ScratchTarget,
  id: string,
  incoming: Map<string, number>,
  stats: OptimizationStats,
  reason: 'fallback' | 'fold'
): void {
  if ((incoming.get(id) ?? 0) > 0) return;
  const value = target.blocks[id];
  if (!value) return;
  delete target.blocks[id];

  if (!isScratchBlock(value)) return;
  if (reason === 'fallback') stats.inactiveFallbackBlocksRemoved += 1;
  else stats.reporterBlocksRemoved += 1;
  removeLinkedComment(target, value, stats);

  if (value.next !== null) removeIncomingReference(target, value.next, incoming, stats, reason);
  for (const input of Object.values(value.inputs)) {
    for (let index = 1; index < input.length; index += 1) {
      const child = input[index];
      if (typeof child === 'string') removeIncomingReference(target, child, incoming, stats, reason);
    }
  }
}

function removeLinkedComment(target: ScratchTarget, block: ScratchBlock, stats: OptimizationStats): void {
  if (typeof block.comment !== 'string') return;
  if (target.comments[block.comment]) {
    delete target.comments[block.comment];
    stats.commentsRemoved += 1;
  }
}

function requiredValue(values: Readonly<Record<string, StaticValue>>, key: string): StaticValue {
  const value = values[key];
  if (value === undefined) throw new Error(`static operator is missing ${key}`);
  return value;
}

function sameKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function toNumber(value: StaticValue): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
  if (typeof value === 'string' && !isAscii(value)) return undefined;
  const number = Number(value);
  return Number.isNaN(number) ? 0 : number;
}

function toBoolean(value: StaticValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== '' && value !== '0' && asciiLowerCase(value) !== 'false';
  return Boolean(value);
}

function compare(left: StaticValue, right: StaticValue): number | undefined {
  if ((typeof left === 'string' && !isAscii(left)) || (typeof right === 'string' && !isAscii(right))) {
    return undefined;
  }
  let leftNumber = Number(left);
  let rightNumber = Number(right);
  if (leftNumber === 0 && isWhiteSpace(left)) leftNumber = Number.NaN;
  else if (rightNumber === 0 && isWhiteSpace(right)) rightNumber = Number.NaN;
  if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
    const leftString = asciiLowerCase(String(left));
    const rightString = asciiLowerCase(String(right));
    if (leftString < rightString) return -1;
    if (leftString > rightString) return 1;
    return 0;
  }
  if ((leftNumber === Infinity && rightNumber === Infinity) ||
      (leftNumber === -Infinity && rightNumber === -Infinity)) return 0;
  return leftNumber - rightNumber;
}

function isWhiteSpace(value: StaticValue): boolean {
  return typeof value === 'string' && value.trim().length === 0;
}

function portableMathOperation(operator: string, value: number): number | undefined {
  switch (operator) {
    case 'abs': return Math.abs(value);
    case 'floor': return Math.floor(value);
    case 'ceiling': return Math.ceil(value);
    case 'sqrt': {
      if (!Number.isSafeInteger(value) || value < 0) return undefined;
      const root = Math.sqrt(value);
      return Number.isSafeInteger(root) && root * root === value ? root : undefined;
    }
    default: return undefined;
  }
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32));
}

function validateOptimizedProject(project: ScratchProject): void {
  try {
    validateProject(project);
  } catch (error) {
    throw new Error('internal validation rejected the optimized project', {cause: error});
  }
}
