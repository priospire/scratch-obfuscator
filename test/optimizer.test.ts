import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {applySafeOptimizations, optimizeProject} from '../src/obfuscation/optimizer.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureProject} from './support.js';

interface OfficialOperators {
  getPrimitives(): Record<string, (args: Record<string, unknown>) => unknown>;
}

type OfficialOperatorsConstructor = new (runtime: unknown) => OfficialOperators;

const require = createRequire(import.meta.url);
const operatorsValue: unknown = require('../node_modules/@scratch/scratch-vm/src/blocks/scratch3_operators.js');
if (typeof operatorsValue !== 'function') throw new Error('official Scratch operators are unavailable');
const officialOperators = new (operatorsValue as OfficialOperatorsConstructor)({}).getPrimitives();

interface OperatorCase {
  readonly opcode: string;
  readonly inputs: Readonly<Record<string, string | number>>;
  readonly fields?: Readonly<Record<string, string | number>>;
  readonly booleanResult?: boolean;
}

const OPERATOR_CASES: readonly OperatorCase[] = [
  {opcode: 'operator_add', inputs: {NUM1: '5', NUM2: 4}},
  {opcode: 'operator_add', inputs: {NUM1: 'not numeric', NUM2: 4}},
  {opcode: 'operator_subtract', inputs: {NUM1: '5', NUM2: 9}},
  {opcode: 'operator_multiply', inputs: {NUM1: '5', NUM2: 8}},
  {opcode: 'operator_divide', inputs: {NUM1: 7, NUM2: 2}},
  {opcode: 'operator_lt', inputs: {OPERAND1: '2', OPERAND2: 10}, booleanResult: true},
  {opcode: 'operator_lt', inputs: {OPERAND1: 'alpha', OPERAND2: 'beta'}, booleanResult: true},
  {opcode: 'operator_lt', inputs: {OPERAND1: 'beta', OPERAND2: 'alpha'}, booleanResult: true},
  {opcode: 'operator_equals', inputs: {OPERAND1: 'Alpha', OPERAND2: 'aLPHA'}, booleanResult: true},
  {opcode: 'operator_equals', inputs: {OPERAND1: '', OPERAND2: ' '}, booleanResult: true},
  {opcode: 'operator_equals', inputs: {OPERAND1: 0, OPERAND2: ' '}, booleanResult: true},
  {opcode: 'operator_gt', inputs: {OPERAND1: 11, OPERAND2: '2'}, booleanResult: true},
  {opcode: 'operator_and', inputs: {OPERAND1: 'yes', OPERAND2: 'false'}, booleanResult: true},
  {opcode: 'operator_and', inputs: {OPERAND1: 1, OPERAND2: 0}, booleanResult: true},
  {opcode: 'operator_or', inputs: {OPERAND1: '0', OPERAND2: 'yes'}, booleanResult: true},
  {opcode: 'operator_not', inputs: {OPERAND: ''}, booleanResult: true},
  {opcode: 'operator_join', inputs: {STRING1: 'left', STRING2: 7}},
  {opcode: 'operator_letter_of', inputs: {LETTER: 2, STRING: 'abc'}},
  {opcode: 'operator_letter_of', inputs: {LETTER: 0, STRING: 'abc'}},
  {opcode: 'operator_letter_of', inputs: {LETTER: 20, STRING: 'abc'}},
  {opcode: 'operator_length', inputs: {STRING: 'AðŸ˜€B'}},
  {opcode: 'operator_contains', inputs: {STRING1: 'Alpha', STRING2: 'PH'}, booleanResult: true},
  {opcode: 'operator_contains', inputs: {STRING1: 'Alpha', STRING2: 'ZZ'}, booleanResult: true},
  {opcode: 'operator_mod', inputs: {NUM1: -1, NUM2: 10}},
  {opcode: 'operator_mod', inputs: {NUM1: 11, NUM2: 10}},
  {opcode: 'operator_round', inputs: {NUM: 3.5}}
];

const MATH_CASES = [
  ['abs', -3], ['floor', 3.9], ['ceiling', 3.1], ['sqrt', 9]
] as const;

const NONPORTABLE_MATH_CASES = [
  ['sqrt', 2], ['sqrt', -1], ['sqrt', 2.5], ['sin', 30], ['cos', 60], ['tan', 45],
  ['asin', 0.5], ['acos', 0.5], ['atan', 1],
  ['ln', Math.E], ['log', 100], ['e ^', 1], ['10 ^', 2], ['unrecognized', 77]
] as const;

describe('safe deterministic optimizer', () => {
  it('folds a nested fixed reporter tree and removes its obscured fallback', () => {
    const project = expressionProject({
      outer: operatorBlock('operator_multiply', 'set', {NUM1: [2, 'inner'], NUM2: literal(8)}),
      inner: operatorBlock('operator_add', 'outer', {NUM1: literal(5), NUM2: literal(4)})
    }, 'outer');
    const source = JSON.stringify(project);

    const result = optimizeProject(project);

    expect(JSON.stringify(project)).toBe(source);
    expect(activeValue(result.project)).toEqual([4, 72]);
    expect(result.project.targets[0]?.blocks['outer']).toBeUndefined();
    expect(result.project.targets[0]?.blocks['inner']).toBeUndefined();
    expect(result.stats).toMatchObject({
      reporterTreesFolded: 1,
      reporterBlocksRemoved: 2,
      inactiveFallbacksRemoved: 1
    });
    validateProject(result.project);
  });

  it.each(OPERATOR_CASES)('matches the pinned operator result for $opcode', testCase => {
    const official = officialOperators[testCase.opcode];
    if (!official) throw new Error(`missing official primitive ${testCase.opcode}`);
    const expected = official({...testCase.inputs, ...testCase.fields});
    const project = operatorCaseProject(testCase);

    const result = optimizeProject(project);

    expect(activeValue(result.project)).toEqual(testCase.booleanResult ? [10, String(expected)] : primitiveFor(expected));
    expect(result.stats.reporterTreesFolded).toBe(1);
  });

  it.each(MATH_CASES)('matches the pinned %s math operation', (operator, number) => {
    const official = officialOperators['operator_mathop'];
    if (!official) throw new Error('missing official math primitive');
    const expected = official({OPERATOR: operator, NUM: number});
    const project = operatorCaseProject({
      opcode: 'operator_mathop',
      inputs: {NUM: number},
      fields: {OPERATOR: operator}
    });

    expect(activeValue(optimizeProject(project).project)).toEqual(primitiveFor(expected));
  });

  it.each(NONPORTABLE_MATH_CASES)('retains implementation-sensitive %s math operations', (operator, number) => {
    const project = operatorCaseProject({
      opcode: 'operator_mathop',
      inputs: {NUM: number},
      fields: {OPERATOR: operator}
    });

    const result = optimizeProject(project);

    expect(result.project.targets[0]?.blocks['inner']).toBeDefined();
    expect(result.stats.reporterTreesFolded).toBe(0);
  });

  it.each([
    {opcode: 'operator_equals', inputs: {OPERAND1: 'Ä', OPERAND2: 'ä'}},
    {opcode: 'operator_equals', inputs: {OPERAND1: 'plain', OPERAND2: 'Ä'}},
    {opcode: 'operator_contains', inputs: {STRING1: 'CAFÉ', STRING2: 'é'}},
    {opcode: 'operator_contains', inputs: {STRING1: 'plain', STRING2: 'é'}},
    {opcode: 'operator_add', inputs: {NUM1: '\u00a0', NUM2: 1}},
    {opcode: 'operator_add', inputs: {NUM1: 1, NUM2: '\u00a0'}},
    {opcode: 'operator_letter_of', inputs: {LETTER: '\u00a0', STRING: 'abc'}},
    {opcode: 'operator_mod', inputs: {NUM1: 1, NUM2: '\u00a0'}},
    {opcode: 'operator_round', inputs: {NUM: '\u00a0'}},
    {opcode: 'operator_mathop', inputs: {NUM: '\u00a0'}, fields: {OPERATOR: 'abs'}}
  ])('retains $opcode when host Unicode tables could affect its result', testCase => {
    const project = operatorCaseProject({...testCase, booleanResult: true});

    const result = optimizeProject(project);

    expect(result.project.targets[0]?.blocks['wrapper']).toBeDefined();
    expect(result.project.targets[0]?.blocks['inner']).toBeDefined();
    expect(result.stats.reporterTreesFolded).toBe(0);
  });

  it('removes an inline fallback without touching a dynamic active reporter', () => {
    const project = expressionProject({
      read: operatorBlock('data_variable', 'set', {}, {VARIABLE: ['result', 'result']})
    }, 'read');

    const result = optimizeProject(project);
    const set = requireBlock(result.project, 'set');

    expect(set.inputs['VALUE']).toEqual([2, 'read']);
    expect(result.project.targets[0]?.blocks['read']).toBeDefined();
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    expect(result.stats.reporterTreesFolded).toBe(0);
  });

  it('retains a visible shadow when an obscured-shadow tuple has no active reporter', () => {
    const project = expressionProject({}, 'unused');
    requireBlock(project, 'set').inputs['VALUE'] = [3, null, [10, 'visible default']];

    const result = optimizeProject(project);

    expect(requireBlock(result.project, 'set').inputs['VALUE']).toEqual([3, null, [10, 'visible default']]);
    expect(result.stats.inactiveFallbacksRemoved).toBe(0);
    validateProject(result.project);
  });

  it('can clean hidden fallbacks while retaining every executable reporter', () => {
    const project = expressionProject({
      outer: operatorBlock('operator_multiply', 'set', {NUM1: [2, 'inner'], NUM2: literal(8)}),
      inner: operatorBlock('operator_add', 'outer', {NUM1: literal(5), NUM2: literal(4)})
    }, 'outer');

    const result = optimizeProject(project, {foldConstants: false});

    expect(requireBlock(result.project, 'set').inputs['VALUE']).toEqual([2, 'outer']);
    expect(result.project.targets[0]?.blocks['outer']).toBeDefined();
    expect(result.project.targets[0]?.blocks['inner']).toBeDefined();
    expect(result.stats.reporterTreesFolded).toBe(0);
    expect(result.stats.reporterBlocksRemoved).toBe(0);
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
  });

  it('prunes an owned object-shadow fallback and its linked comment', () => {
    const project = expressionProject({
      read: operatorBlock('data_variable', 'set', {}, {VARIABLE: ['result', 'result']}),
      shadow: {
        ...operatorBlock('text', 'set', {}, {TEXT: ['hidden']}),
        shadow: true,
        comment: 'shadow-comment'
      }
    }, 'read', 'shadow');
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage is missing');
    stage.comments['shadow-comment'] = {
      blockId: 'shadow', x: 0, y: 0, width: 100, height: 40, minimized: false, text: 'hidden'
    };

    const result = optimizeProject(project);

    expect(result.project.targets[0]?.blocks['shadow']).toBeUndefined();
    expect(result.project.targets[0]?.comments['shadow-comment']).toBeUndefined();
    expect(result.stats.inactiveFallbackBlocksRemoved).toBe(1);
    expect(result.stats.commentsRemoved).toBe(1);
  });

  it('removes null and chained object fallbacks with valid reference accounting', () => {
    const nullFallback = expressionProject({
      read: operatorBlock('data_variable', 'set', {}, {VARIABLE: ['result', 'result']})
    }, 'read', null);
    const nullSet = requireBlock(nullFallback, 'set');
    nullSet.inputs['VALUE'] = [3, 'read', null];
    expect(requireBlock(optimizeProject(nullFallback).project, 'set').inputs['VALUE']).toEqual([2, 'read']);

    const chained = expressionProject({
      read: operatorBlock('data_variable', 'set', {}, {VARIABLE: ['result', 'result']}),
      fallback: {
        ...operatorBlock('text', 'set', {}, {TEXT: ['hidden']}),
        next: 'fallback-child',
        shadow: true
      },
      'fallback-child': operatorBlock('looks_show', 'fallback', {})
    }, 'read', 'fallback');

    const result = optimizeProject(chained);

    expect(result.project.targets[0]?.blocks['fallback']).toBeUndefined();
    expect(result.project.targets[0]?.blocks['fallback-child']).toBeUndefined();
    expect(result.stats.inactiveFallbackBlocksRemoved).toBe(2);
  });

  it('retains a block-map primitive shared by the active input and removed fallback', () => {
    const project = expressionProject({}, 'shared', 'shared');
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage is missing');
    stage.variables['shared-variable'] = ['shared', 7];
    stage.blocks['shared'] = [12, 'shared', 'shared-variable'];

    const result = optimizeProject(project);

    expect(requireBlock(result.project, 'set').inputs['VALUE']).toEqual([2, 'shared']);
    expect(result.project.targets[0]?.blocks['shared']).toEqual([12, 'shared', 'shared-variable']);
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    validateProject(result.project);
  });

  it('removes an unshared block-map primitive used only as an inactive fallback', () => {
    const project = expressionProject({
      read: operatorBlock('data_variable', 'set', {}, {VARIABLE: ['result', 'result']})
    }, 'read', 'fallback');
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage is missing');
    stage.variables['fallback-variable'] = ['fallback', 3];
    stage.blocks['fallback'] = [12, 'fallback', 'fallback-variable'];

    const result = optimizeProject(project);

    expect(result.project.targets[0]?.blocks['fallback']).toBeUndefined();
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    validateProject(result.project);
  });

  it('folds safe descendants but leaves random, Boolean, signed-zero, non-finite, and malformed roots intact', () => {
    const projects = [
      expressionProject({
        root: operatorBlock('operator_add', 'set', {NUM1: [2, 'random'], NUM2: literal(1)}),
        random: operatorBlock('operator_random', 'root', {FROM: [2, 'fixed'], TO: literal(10)}),
        fixed: operatorBlock('operator_add', 'random', {NUM1: literal(2), NUM2: literal(3)})
      }, 'root'),
      expressionProject({
        root: operatorBlock('operator_equals', 'set', {OPERAND1: [2, 'fixed'], OPERAND2: literal(3)}),
        fixed: operatorBlock('operator_add', 'root', {NUM1: literal(1), NUM2: literal(2)})
      }, 'root'),
      expressionProject({root: operatorBlock('operator_multiply', 'set', {NUM1: literal(0), NUM2: literal(-1)})}, 'root'),
      expressionProject({root: operatorBlock('operator_divide', 'set', {NUM1: literal(0), NUM2: literal(0)})}, 'root'),
      expressionProject({
        root: operatorBlock('operator_add', 'set', {NUM1: literal(1), NUM2: literal(2), UNUSED: [2, 'random']}),
        random: operatorBlock('operator_random', 'root', {FROM: literal(1), TO: literal(2)})
      }, 'root')
    ];

    const results = projects.map(project => optimizeProject(project));

    expect(results[0]?.project.targets[0]?.blocks['root']).toBeDefined();
    expect(results[0]?.project.targets[0]?.blocks['random']).toBeDefined();
    expect(results[0]?.project.targets[0]?.blocks['fixed']).toBeUndefined();
    expect(results[1]?.project.targets[0]?.blocks['root']).toBeDefined();
    expect(results[1]?.project.targets[0]?.blocks['fixed']).toBeUndefined();
    expect(results.slice(2).every(result => result.project.targets[0]?.blocks['root'] !== undefined)).toBe(true);
    expect(Object.is(activeValue(results[2]?.project as ScratchProject), -0)).toBe(false);
  });

  it('keeps every conservative eligibility boundary intact', () => {
    const variants: ScratchProject[] = [];
    const add = (root: ScratchBlock, extra: Record<string, ScratchBlock> = {}): void => {
      variants.push(expressionProject({root, ...extra}, 'root'));
    };
    add({...operatorBlock('operator_add', 'set', {NUM1: literal(1), NUM2: literal(2)}), mutation: {tagName: 'mutation', children: []}});
    add({...operatorBlock('operator_add', 'set', {NUM1: literal(1), NUM2: literal(2)}), shadow: true});
    add({...operatorBlock('operator_add', 'set', {NUM1: literal(1), NUM2: literal(2)}), next: 'tail'}, {
      tail: operatorBlock('looks_show', 'root', {})
    });
    add(operatorBlock('operator_add', 'set', {NUM1: [2, null], NUM2: literal(2)}));
    add(operatorBlock('operator_add', 'set', {NUM1: [1, [12, 'result', 'result']], NUM2: literal(2)}));
    add(operatorBlock('operator_add', 'set', {NUM1: literal(1)}));
    add(operatorBlock('operator_add', 'set', {NUM1: literal(1), NUM2: literal(2)}, {EXTRA: ['field']}));

    for (const project of variants) {
      const result = optimizeProject(project);
      expect(result.project.targets[0]?.blocks['root']).toBeDefined();
      expect(result.stats.reporterTreesFolded).toBe(0);
    }
  });

  it('handles intermediate Boolean, NaN, infinity, and tangent edge values exactly', () => {
    const booleanProject = expressionProject({
      wrapper: operatorBlock('operator_join', 'set', {STRING1: [2, 'and'], STRING2: literal('')}),
      and: operatorBlock('operator_and', 'wrapper', {OPERAND1: [2, 'equals'], OPERAND2: literal(1)}),
      equals: operatorBlock('operator_equals', 'and', {OPERAND1: literal('A'), OPERAND2: literal('a')})
    }, 'wrapper');
    expect(activeValue(optimizeProject(booleanProject).project)).toEqual([10, 'true']);

    const nanProject = expressionProject({
      root: operatorBlock('operator_add', 'set', {NUM1: [2, 'nan'], NUM2: literal(2)}),
      nan: operatorBlock('operator_divide', 'root', {NUM1: literal(0), NUM2: literal(0)})
    }, 'root');
    expect(activeValue(optimizeProject(nanProject).project)).toEqual([4, 2]);

    const infinityProject = expressionProject({
      wrapper: operatorBlock('operator_join', 'set', {STRING1: [2, 'equals'], STRING2: literal('')}),
      equals: operatorBlock('operator_equals', 'wrapper', {OPERAND1: [2, 'left'], OPERAND2: [2, 'right']}),
      left: operatorBlock('operator_divide', 'equals', {NUM1: literal(1), NUM2: literal(0)}),
      right: operatorBlock('operator_divide', 'equals', {NUM1: literal(1), NUM2: literal(0)})
    }, 'wrapper');
    expect(activeValue(optimizeProject(infinityProject).project)).toEqual([10, 'true']);

    const negativeInfinityProject = expressionProject({
      wrapper: operatorBlock('operator_join', 'set', {STRING1: [2, 'equals'], STRING2: literal('')}),
      equals: operatorBlock('operator_equals', 'wrapper', {OPERAND1: [2, 'left'], OPERAND2: [2, 'right']}),
      left: operatorBlock('operator_divide', 'equals', {NUM1: literal(-1), NUM2: literal(0)}),
      right: operatorBlock('operator_divide', 'equals', {NUM1: literal(-1), NUM2: literal(0)})
    }, 'wrapper');
    expect(activeValue(optimizeProject(negativeInfinityProject).project)).toEqual([10, 'true']);

    for (const [id, angle] of [['positive', 90], ['negative', 270]] as const) {
      const tangent = expressionProject({
        root: operatorBlock('operator_mathop', 'set', {NUM: literal(angle)}, {OPERATOR: ['tan']})
      }, 'root');
      const result = optimizeProject(tangent);
      expect(result.project.targets[0]?.blocks['root'], id).toBeDefined();
    }
  });

  it('commits through the mutating API only after successful validation', () => {
    const project = expressionProject({
      root: operatorBlock('operator_add', 'set', {NUM1: literal(20), NUM2: literal(22)})
    }, 'root');
    const targets = project.targets;

    const stats = applySafeOptimizations(project);

    expect(project.targets).not.toBe(targets);
    expect(activeValue(project)).toEqual([4, 42]);
    expect(stats.reporterTreesFolded).toBe(1);

    const invalid = expressionProject({}, 'missing');
    const snapshot = JSON.stringify(invalid);
    expect(() => applySafeOptimizations(invalid)).toThrow(/dangling block reference/);
    expect(JSON.stringify(invalid)).toBe(snapshot);
  });

  it('removes stale invisible data monitors for sprites that no longer exist', () => {
    const project = expressionProject({}, 'unused');
    const set = requireBlock(project, 'set');
    set.inputs['VALUE'] = [1, [4, 0]];
    project.monitors = [
      {
        opcode: 'data_variable', id: 'deleted-local-id', params: {VARIABLE: 'i'},
        spriteName: 'Deleted Sprite', value: 0, visible: false
      },
      {
        opcode: 'data_variable', id: 'result', params: {VARIABLE: 'result'},
        spriteName: '', value: 0, visible: false
      },
      {
        opcode: 'data_variable', id: 'result', params: {VARIABLE: 'result'},
        spriteName: 'Deleted Sprite', value: 0, visible: false
      }
    ];

    const result = optimizeProject(project, {foldConstants: false});

    expect(result.project.monitors).toEqual([project.monitors[1], project.monitors[2]]);
    expect(result.stats.staleInvisibleMonitorsRemoved).toBe(1);
    validateProject(result.project);

    const mutable = structuredClone(project);
    applySafeOptimizations(mutable, {foldConstants: false});
    expect(mutable.monitors).toEqual([project.monitors[1], project.monitors[2]]);
    validateProject(mutable);
  });
});

function operatorCaseProject(testCase: OperatorCase): ScratchProject {
  const inputs = Object.fromEntries(Object.entries(testCase.inputs).map(([name, value]) => [name, literal(value)]));
  const fields = Object.fromEntries(Object.entries(testCase.fields ?? {}).map(([name, value]) => [name, [value]]));
  const inner = operatorBlock(testCase.opcode, testCase.booleanResult ? 'wrapper' : 'set', inputs, fields);
  if (!testCase.booleanResult) return expressionProject({inner}, 'inner');
  return expressionProject({
    wrapper: operatorBlock('operator_join', 'set', {STRING1: [2, 'inner'], STRING2: literal('')}),
    inner
  }, 'wrapper');
}

function expressionProject(
  reporters: Record<string, ScratchBlock>,
  rootId: string,
  fallback: ScratchInput | string | null = [10, 'hidden default']
): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  project.targets = [stage];
  project.monitors = [];
  project.extensions = [];
  stage.variables = {result: ['result', 'unset']};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: operatorBlock('event_whenflagclicked', null, {}),
    set: operatorBlock('data_setvariableto', 'hat', {VALUE: [3, rootId, fallback]}, {VARIABLE: ['result', 'result']}),
    ...reporters
  };
  const hat = requireBlock(project, 'hat');
  hat.next = 'set';
  hat.topLevel = true;
  hat.x = 0;
  hat.y = 0;
  return project;
}

function operatorBlock(
  opcode: string,
  parent: string | null,
  inputs: Record<string, ScratchInput>,
  fields: Record<string, JsonValue[]> = {}
): ScratchBlock {
  return {opcode, next: null, parent, inputs, fields, shadow: false, topLevel: false};
}

function literal(value: string | number): ScratchInput {
  return [1, [typeof value === 'number' ? 4 : 10, value]];
}

function requireBlock(project: ScratchProject, id: string): ScratchBlock {
  const value = project.targets[0]?.blocks[id];
  if (!value || !isScratchBlock(value)) throw new Error(`fixture block ${id} is missing`);
  return value;
}

function activeValue(project: ScratchProject): JsonValue | undefined {
  return requireBlock(project, 'set').inputs['VALUE']?.[1];
}

function primitiveFor(value: unknown): ScratchInput {
  if (typeof value === 'string') return [10, value];
  if (typeof value === 'number') return [4, value];
  throw new Error(`official operator produced an unsupported value: ${String(value)}`);
}
