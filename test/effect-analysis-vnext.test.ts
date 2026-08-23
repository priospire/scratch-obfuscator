import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  analyzeProjectEffects,
  certifyRegionEffects,
  certifyRegionsEffects,
  collectCertifiedNestedLinearRuns,
  collectNestedLinearRuns
} from '../src/obfuscation/analysis.js';
import type {ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';

describe('per-region effect analysis', () => {
  it('discovers deterministic branch and procedure-body runs with exact entry connectors', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'choose', null, true),
      choose: block('control_if_else', 'tail', 'hat', false, {
        CONDITION: [1, [10, 'true']],
        SUBSTACK: [2, 'left-a'],
        SUBSTACK2: [2, 'right-a']
      }),
      'left-a': block('motion_setx', 'left-b', 'choose'),
      'left-b': block('looks_show', null, 'left-a'),
      'right-a': block('motion_sety', 'right-b', 'choose'),
      'right-b': block('looks_hide', null, 'right-a'),
      tail: block('looks_show', null, 'choose'),
      definition: block('procedures_definition', 'proc-a', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('safe', false, 'definition'),
      'proc-a': block('motion_changexby', 'proc-b', 'definition'),
      'proc-b': block('motion_changeyby', null, 'proc-a')
    };

    expect(collectNestedLinearRuns(project, {minimumLength: 2})).toEqual([
      expect.objectContaining({
        blockIds: ['left-a', 'left-b'],
        connector: {kind: 'input', ownerId: 'choose', inputName: 'SUBSTACK', blockId: 'left-a'}
      }),
      expect.objectContaining({
        blockIds: ['right-a', 'right-b'],
        connector: {kind: 'input', ownerId: 'choose', inputName: 'SUBSTACK2', blockId: 'right-a'}
      })
    ]);
    expect(collectNestedLinearRuns(project, {minimumLength: 2, includeProcedureBodies: true})).toEqual([
      expect.objectContaining({blockIds: ['left-a', 'left-b']}),
      expect.objectContaining({blockIds: ['right-a', 'right-b']}),
      expect.objectContaining({
        blockIds: ['proc-a', 'proc-b'],
        connector: {kind: 'next', ownerId: 'definition', blockId: 'proc-a'}
      })
    ]);
  });

  it('collects symbol, scheduler, redraw, timer, input, and RNG effects without losing owners', () => {
    const project = baseProject(true);
    const sprite = requireTarget(project, 1);
    sprite.variables = {local: ['local value', 0]};
    sprite.lists = {items: ['items', []]};
    sprite.blocks = {
      hat: block('event_whenflagclicked', 'set', null, true),
      set: command('data_setvariableto', 'append', 'hat', {VALUE: [2, 'sum']}, {VARIABLE: ['local value', 'local']}),
      sum: reporter('operator_add', 'set', {
        NUM1: [1, [12, 'global value', 'global']],
        NUM2: [2, 'random']
      }),
      random: reporter('operator_random', 'sum', {FROM: [1, [4, '1']], TO: [1, [4, '10']]}),
      append: command('data_addtolist', 'wait', 'set', {ITEM: [1, [10, 'x']]}, {LIST: ['items', 'items']}),
      wait: command('control_wait', null, 'append', {DURATION: [1, [4, '0.1']]})
    };

    const lossy = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['set', 'append', 'wait']}, 'lossy');
    expect(lossy.effects.variableReads).toEqual([
      {kind: 'variable', targetIndex: 0, scope: 'stage', id: 'global', name: 'global value'}
    ]);
    expect(lossy.effects.variableWrites).toEqual([
      {kind: 'variable', targetIndex: 1, scope: 'target', id: 'local', name: 'local value'}
    ]);
    expect(lossy.effects.listReads).toEqual([
      {kind: 'list', targetIndex: 1, scope: 'target', id: 'items', name: 'items'}
    ]);
    expect(lossy.effects.listWrites).toEqual(lossy.effects.listReads);
    expect(lossy.effects.randomSources.map(site => site.blockId)).toEqual(['random']);
    expect(lossy.effects.yields.map(site => site.blockId)).toEqual(['wait']);
    expect(lossy.effects.timers.map(site => site.blockId)).toEqual(['wait']);
    expect(lossy.effects.redraws.map(site => site.blockId)).toEqual(['wait']);
    expect(lossy.effects.ownership).toEqual({
      executionTargetIndex: 1,
      readTargetIndexes: [0, 1],
      writeTargetIndexes: [1],
      dynamicTargetRead: false,
      unresolvedSymbolOwnership: false
    });
    expect(lossy.reasons.map(reason => reason.code)).toEqual(['yield', 'timer', 'random-source']);

    const strongest = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['set', 'append', 'wait']}, 'no-preserve');
    expect(strongest.reasons.map(reason => reason.code)).toEqual(['yield']);
  });

  it('reports recursive SCCs, warp reachability, and exact call-resolution failures', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'call-a', null, true),
      'call-a': procedureCall('A', null, 'hat'),
      'definition-a': block('procedures_definition', 'body-a', null, true, {custom_block: [1, 'prototype-a']}),
      'prototype-a': procedurePrototype('A', false, 'definition-a'),
      'body-a': procedureCall('B', null, 'definition-a'),
      'definition-b': block('procedures_definition', 'body-b', null, true, {custom_block: [1, 'prototype-b']}),
      'prototype-b': procedurePrototype('B', true, 'definition-b'),
      'body-b': procedureCall('A', null, 'definition-b'),
      unresolved: procedureCall('missing', null, null, true)
    };

    const analysis = analyzeProjectEffects(project);
    expect(analysis.procedures).toHaveLength(2);
    expect(new Set(analysis.procedures.map(node => node.stronglyConnectedComponent)).size).toBe(1);
    expect(analysis.procedures.every(node => node.recursive)).toBe(true);
    expect(analysis.procedures.find(node => node.proccode === 'B')?.warp).toBe(true);

    const recursive = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['call-a']}, 'lossy', analysis);
    expect(recursive.reasons.map(reason => reason.code)).toEqual(['warp-procedure', 'recursive-procedure', 'recursive-procedure']);
    const unresolved = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['unresolved']}, 'lossy', analysis);
    expect(unresolved.reasons).toEqual([{
      code: 'unresolved-procedure',
      message: 'block "unresolved" (procedures_call) does not resolve to one well-formed custom procedure',
      targetIndex: 0,
      blockId: 'unresolved',
      opcode: 'procedures_call'
    }]);
  });

  it('rejects observable argument evaluation, dynamic target ownership, and shared dispatcher owners precisely', () => {
    const project = baseProject(true);
    const sprite = requireTarget(project, 1);
    sprite.blocks = {
      first: block('event_whenflagclicked', 'call', null, true),
      call: {
        ...procedureCall('safe %s', null, 'first'),
        inputs: {argument: [2, 'mouse']},
        mutation: {proccode: 'safe %s', argumentids: '["argument"]', warp: 'false'}
      },
      mouse: reporter('sensing_mousex', 'call'),
      second: block('event_whenflagclicked', 'goto', null, true),
      goto: command('motion_goto', null, 'second', {TO: [2, 'selector']}),
      selector: reporter('data_variable', 'goto', {}, {VARIABLE: ['local', 'local']}),
      definition: block('procedures_definition', 'show', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('safe %s', false, 'definition', ['argument']),
      show: block('looks_show', null, 'definition')
    };
    sprite.variables = {local: ['local', '_mouse_']};

    const call = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['call']}, 'lossy');
    expect(call.reasons.map(reason => reason.code)).toEqual(['argument-evaluation', 'live-input']);
    expect(call.effects.argumentEvaluationHazards[0]?.reason).toBe('observable-reporter');

    const dynamic = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['goto']}, 'no-preserve');
    expect(dynamic.effects.ownership.dynamicTargetRead).toBe(true);
    expect(dynamic.reasons.map(reason => reason.code)).toEqual(['dynamic-target-owner', 'concurrent-target-owner']);
    expect(dynamic.sameTargetConcurrentEntries.map(entry => entry.blockId)).toEqual(['first']);

    const lossyDynamic = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['goto']}, 'lossy');
    expect(lossyDynamic.reasons.map(reason => reason.code)).toEqual([
      'live-input',
      'random-source',
      'dynamic-target-owner'
    ]);
  });

  it('separates broadcast, clone, re-entry, and thread-control effects', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'broadcast', null, true),
      broadcast: command('event_broadcast', 'clone', 'hat', {BROADCAST_INPUT: [1, [11, 'go', 'broadcast']]}),
      clone: command('control_create_clone_of', 'stop', 'broadcast', {CLONE_OPTION: [1, [11, '_myself_', null]]}),
      stop: command('control_stop', null, 'clone', {}, {STOP_OPTION: ['other scripts in stage', null]})
    };

    const certificate = certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['broadcast', 'clone', 'stop']},
      'no-preserve'
    );
    expect(certificate.effects.broadcasts.map(site => site.blockId)).toEqual(['broadcast']);
    expect(certificate.effects.clones.map(site => site.blockId)).toEqual(['clone']);
    expect(certificate.effects.reentries.map(site => site.blockId)).toEqual(['broadcast', 'clone']);
    expect(certificate.effects.concurrencyEffects.map(site => site.blockId)).toEqual(['broadcast', 'clone', 'stop']);
    expect(certificate.reasons.map(reason => reason.code)).toEqual([
      'broadcast',
      'clone',
      'thread-control',
      'thread-reentry',
      'thread-reentry'
    ]);
  });

  it('batches certificates and invalidates a supplied analysis after graph mutation', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'show', null, true),
      show: block('looks_show', null, 'hat')
    };
    const analysis = analyzeProjectEffects(project);
    expect(certifyRegionsEffects(project, [
      {targetIndex: 0, blockIds: ['show']},
      {targetIndex: 0, blockIds: ['missing']}
    ], 'lossy').map(certificate => certificate.eligible)).toEqual([true, false]);

    stage.blocks['show'] = reporter('sensing_timer', 'hat');
    const recertified = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['show']}, 'lossy', analysis);
    expect(recertified.reasons.map(reason => reason.code)).toEqual(['timer']);
  });

  it('can certify one rewritten input without treating untouched C-block branches as rewritten', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'condition', null, true),
      condition: block('control_if', null, 'hat', false, {
        CONDITION: [2, 'random'],
        SUBSTACK: [2, 'wait']
      }),
      random: reporter('operator_random', 'condition', {FROM: [1, [4, '0']], TO: [1, [4, '1']]}),
      wait: command('control_wait', null, 'condition', {DURATION: [1, [4, '1']]})
    };

    const whole = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['condition']}, 'lossy');
    expect(whole.reasons.map(reason => reason.code)).toEqual(['yield', 'timer', 'random-source']);
    const conditionOnly = certifyRegionEffects(project, {
      targetIndex: 0,
      blockIds: ['condition'],
      inputNamesByBlock: {condition: ['CONDITION']}
    }, 'lossy');
    expect(conditionOnly.reasons.map(reason => reason.code)).toEqual(['random-source']);
    expect(conditionOnly.inputNamesByBlock).toEqual({condition: ['CONDITION']});
  });

  it('is deterministic and never claims a block in two nested runs', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({min: 0, max: 8}), {minLength: 2, maxLength: 16}),
      lengths => {
        const project = nestedProject(lengths);
        const first = collectCertifiedNestedLinearRuns(project, 'lossy', {minimumLength: 2});
        const second = collectCertifiedNestedLinearRuns(project, 'lossy', {minimumLength: 2});
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        const claimed = first.flatMap(item => item.run.blockIds);
        expect(new Set(claimed).size).toBe(claimed.length);
      }
    ), {seed: 0x5b33_1001, numRuns: 100});
  });
});

function nestedProject(lengths: readonly number[]): ScratchProject {
  const project = baseProject();
  const stage = requireTarget(project, 0);
  stage.blocks = {hat: block('event_whenflagclicked', 'outer', null, true)};
  let owner = 'hat';
  for (const [branch, length] of lengths.entries()) {
    const controlId = branch === 0 ? 'outer' : `control-${branch}`;
    const nextControl = branch + 1 < lengths.length ? `control-${branch + 1}` : null;
    stage.blocks[controlId] = block('control_if', nextControl, owner, false, {
      CONDITION: [1, [10, 'true']],
      SUBSTACK: [2, length === 0 ? null : `branch-${branch}-0`]
    });
    for (let index = 0; index < length; index += 1) {
      const id = `branch-${branch}-${index}`;
      stage.blocks[id] = block(
        index % 2 === 0 ? 'motion_setx' : 'looks_show',
        index + 1 < length ? `branch-${branch}-${index + 1}` : null,
        index === 0 ? controlId : `branch-${branch}-${index - 1}`
      );
    }
    owner = controlId;
  }
  return project;
}

function baseProject(withSprite = false): ScratchProject {
  const targets: ScratchTarget[] = [{
    isStage: true,
    name: 'Stage',
    variables: {global: ['global value', 1]},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: []
  }];
  if (withSprite) {
    targets.push({
      isStage: false,
      name: 'Sprite',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [],
      sounds: []
    });
  }
  return {targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}};
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing target ${index}`);
  return target;
}

function block(
  opcode: string,
  next: string | null = null,
  parent: string | null = null,
  topLevel = false,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, ScratchInput> = {}
): ScratchBlock {
  return {opcode, next, parent, inputs, fields, shadow: false, topLevel};
}

function command(
  opcode: string,
  next: string | null,
  parent: string | null,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, ScratchInput> = {}
): ScratchBlock {
  return block(opcode, next, parent, false, inputs, fields);
}

function reporter(
  opcode: string,
  parent: string,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, ScratchInput> = {}
): ScratchBlock {
  return block(opcode, null, parent, false, inputs, fields);
}

function procedurePrototype(
  proccode: string,
  warp: boolean,
  parent: string,
  argumentIds: readonly string[] = []
): ScratchBlock {
  return {
    ...block('procedures_prototype', null, parent),
    shadow: true,
    mutation: {
      proccode,
      argumentids: JSON.stringify(argumentIds),
      argumentnames: JSON.stringify(argumentIds),
      argumentdefaults: JSON.stringify(argumentIds.map(() => '')),
      warp: String(warp)
    }
  };
}

function procedureCall(proccode: string, next: string | null, parent: string | null, topLevel = false): ScratchBlock {
  return {
    ...block('procedures_call', next, parent, topLevel),
    mutation: {proccode, argumentids: '[]', warp: 'false'}
  };
}
