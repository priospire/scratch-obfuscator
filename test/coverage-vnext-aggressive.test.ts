import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {ObfuscationStats, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('aggressive transform coverage regressions', () => {
  it('packs unambiguous name-only fixed lists and conservatively retains ambiguous, monitored, and dynamic lists', () => {
    const project = emptyProject();
    const [stage, sprite] = requireTargets(project);
    stage.lists = {
      'stage-only': ['stage only', ['s0', 's1']],
      'stage-duplicate': ['duplicate', ['global']],
      'monitored-id': ['monitored id', ['visible']],
      'monitored-params': ['monitored params', ['visible']]
    };
    sprite.lists = {
      'local-only': ['local only', ['l0', 'l1']],
      'sprite-duplicate': ['duplicate', ['local']],
      random: ['random', ['keep']],
      any: ['any', ['keep']],
      unsupported: ['unsupported', ['keep']],
      malformed: ['malformed', ['keep']],
      shadowed: ['shadowed', ['keep']],
      'empty-last': ['empty last', []],
      nan: ['nan', ['n0']],
      range: ['range', ['r0']]
    };
    sprite.blocks = {
      'read-stage': listReporter('stage only', undefined, [1, [10, 'all']]),
      'read-local': listReporter('local only', undefined, [1, [4, '2']]),
      'read-duplicate': listReporter('duplicate', undefined, [1, [4, '1']]),
      'read-random': listReporter('random', 'random', [1, [10, 'random']]),
      'read-any': listReporter('any', 'any', [1, [10, 'any']]),
      'read-unsupported': listReporter('unsupported', 'unsupported', [1, [11, 'message', 'broadcast']]),
      'read-malformed': listReporter('malformed', 'malformed', [1, [4, {unexpected: true}]]),
      'read-shadowed': {...listReporter('shadowed', 'shadowed', [1, [4, '1']]), shadow: true},
      'read-empty-last': listReporter('empty last', 'empty-last', [1, [10, 'last']]),
      'read-nan': listReporter('nan', 'nan', [1, [10, 'not a number']]),
      'read-range': listReporter('range', 'range', [1, [4, '99']]),
      'read-monitored-id': listReporter('monitored id', 'monitored-id', [1, [4, '1']]),
      'read-monitored-params': listReporter('monitored params', 'monitored-params', [1, [4, '1']])
    };
    project.monitors = [
      {id: 'monitored-id', mode: 'list', opcode: 'data_listcontents', params: {}},
      {id: 'different-id', mode: 'default', opcode: 'data_listcontents', params: {LIST: 'monitored-params'}}
    ];
    const resultStats = stats(project);

    applyAggressiveTransforms(project, 'no-preserve', generator(0x41, 'fixed-list-coverage'), resultStats);

    expect(resultStats.listsVirtualized).toBe(5);
    expect(stage.lists['stage-only']).toBeUndefined();
    expect(sprite.lists['local-only']).toBeUndefined();
    expect(sprite.lists['empty-last']).toBeUndefined();
    expect(sprite.lists['nan']).toBeUndefined();
    expect(sprite.lists['range']).toBeUndefined();
    for (const id of [
      'stage-duplicate',
      'monitored-id',
      'monitored-params'
    ]) expect(stage.lists[id]).toBeDefined();
    for (const id of [
      'sprite-duplicate',
      'random',
      'any',
      'unsupported',
      'malformed',
      'shadowed'
    ]) expect(sprite.lists[id]).toBeDefined();

    const stageRead = requireBlock(sprite, 'read-stage');
    const localRead = requireBlock(sprite, 'read-local');
    const emptyLastRead = requireBlock(sprite, 'read-empty-last');
    const nanRead = requireBlock(sprite, 'read-nan');
    const rangeRead = requireBlock(sprite, 'read-range');
    expect(primitiveValue(stageRead.inputs['INDEX'])).toBe('0');
    expect(primitiveValue(emptyLastRead.inputs['INDEX'])).toBe('0');
    expect(primitiveValue(nanRead.inputs['INDEX'])).toBe('0');
    expect(primitiveValue(rangeRead.inputs['INDEX'])).toBe('0');
    const localHeapId = localRead.fields['LIST']?.[1];
    const localSlot = Number(primitiveValue(localRead.inputs['INDEX']));
    expect(typeof localHeapId === 'string' ? (sprite.lists[localHeapId]?.[1] as unknown[])[localSlot - 1] : undefined)
      .toBe('l1');
  });

  it('virtualizes a change block with an omitted value as an exact zero delta', () => {
    const project = emptyProject();
    const [, sprite] = requireTargets(project);
    sprite.variables = {counter: ['counter', 8]};
    sprite.blocks = {
      flag: block('event_whenflagclicked', 'change', null, true),
      change: block('data_changevariableby', null, 'flag', false, {}, {VARIABLE: ['counter', 'counter']})
    };
    const resultStats = stats(project);

    applyAggressiveTransforms(project, 'no-preserve', generator(0x52, 'missing-delta-coverage'), resultStats);

    expect(resultStats.variablesVirtualized).toBe(1);
    expect(sprite.variables['counter']).toBeUndefined();
    const change = requireBlock(sprite, 'change');
    expect(change.opcode).toBe('data_replaceitemoflist');
    const addId = change.inputs['ITEM']?.[1];
    const add = typeof addId === 'string' ? requireBlock(sprite, addId) : undefined;
    expect(add?.opcode).toBe('operator_add');
    expect(primitiveValue(add?.inputs['NUM2'])).toBe('0');
    validateProject(project);
  });

  it('splits a nine-command run around a native separator and gives both regions keyed dispatch', () => {
    const project = emptyProject();
    const [, sprite] = requireTargets(project);
    sprite.blocks = {flag: block('event_whenflagclicked', 'step-0', null, true)};
    for (let index = 0; index < 9; index += 1) {
      sprite.blocks[`step-${index}`] = block(
        'motion_changexby',
        index === 8 ? null : `step-${index + 1}`,
        index === 0 ? 'flag' : `step-${index - 1}`,
        false,
        {DX: [1, [4, String(index + 1)]]}
      );
    }
    const resultStats = stats(project);

    applyAggressiveTransforms(project, 'no-preserve', generator(0x63, 'nine-block-coverage'), resultStats);

    expect(resultStats.virtualizedBlocks).toBe(8);
    const originalIds = new Set(Array.from({length: 9}, (_, index) => `step-${index}`));
    for (const id of originalIds) {
      const transformed = requireBlock(sprite, id);
      expect(transformed.next === null || !originalIds.has(transformed.next)).toBe(true);
    }
    const modulusCounts = new Map<number, number>();
    for (const value of Object.values(sprite.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'operator_mod') continue;
      const modulus = Number(primitiveValue(value.inputs['NUM2']));
      modulusCounts.set(modulus, (modulusCounts.get(modulus) ?? 0) + 1);
    }
    for (const modulus of [17, 19, 23]) expect(modulusCounts.get(modulus)).toBeGreaterThanOrEqual(10);
    validateProject(project);
  });
});

function emptyProject(): ScratchProject {
  const project = createFixtureProject();
  const [stage, sprite] = requireTargets(project);
  for (const target of [stage, sprite]) {
    target.variables = {};
    target.lists = {};
    target.broadcasts = {};
    target.blocks = {};
    target.comments = {};
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function requireTargets(project: ScratchProject): [ScratchTarget, ScratchTarget] {
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  if (!stage || !sprite) throw new Error('fixture targets are unavailable');
  return [stage, sprite];
}

function listReporter(name: string, id: string | undefined, index: ScratchBlock['inputs']['INDEX']): ScratchBlock {
  return block(
    'data_itemoflist',
    null,
    null,
    true,
    {INDEX: index},
    {LIST: id === undefined ? [name] : [name, id]}
  );
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
    ...(topLevel ? {x: 10, y: 10} : {})
  };
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!value || !isScratchBlock(value)) throw new Error(`block ${JSON.stringify(id)} is unavailable`);
  return value;
}

function primitiveValue(input: ScratchBlock['inputs'][string] | undefined): unknown {
  const active = input?.[1];
  return Array.isArray(active) ? active[1] : undefined;
}

function generator(fill: number, domain: string): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(fill), domain);
}

function stats(project: ScratchProject): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode: 'no-preserve',
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
