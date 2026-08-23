import {describe, expect, it} from 'vitest';
import {certifyRegionEffects} from '../src/obfuscation/analysis.js';
import type {ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';

describe('lossy forward temporal-influence certification', () => {
  it.each([
    ['timer', 'sensing_timer', 'timer'],
    ['live input', 'sensing_mousex', 'live-input'],
    ['runtime randomness', 'operator_random', 'random-source']
  ] as const)('rejects an otherwise-safe region before a same-thread %s sample', (_label, opcode, reasonCode) => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'store', 'hat'),
      store: block('data_setvariableto', null, 'safe', false, {VALUE: [2, 'sample']}, {VARIABLE: ['value', 'value']}),
      sample: opcode === 'operator_random'
        ? reporter(opcode, 'store', {FROM: [1, [4, '1']], TO: [1, [4, '10']]})
        : reporter(opcode, 'store')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.effects.timers).toEqual([]);
    expect(certificate.effects.liveInputs).toEqual([]);
    expect(certificate.effects.randomSources).toEqual([]);
    expect(certificate.eligible).toBe(false);
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: reasonCode, blockId: 'sample', opcode})
    ]);
  });

  it('follows both feasible C-block paths before the next scheduler boundary', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('motion_setx', 'choose', 'hat', false, {X: [1, [4, '0']]}),
      choose: block('control_if_else', null, 'safe', false, {
        CONDITION: [2, 'condition'],
        SUBSTACK: [2, 'left'],
        SUBSTACK2: [2, 'right']
      }),
      condition: block('data_variable', null, 'choose', false, {}, {VARIABLE: ['value', 'value']}),
      left: block('looks_show', null, 'choose'),
      right: block('data_setvariableto', null, 'choose', false, {VALUE: [2, 'mouse']}, {VARIABLE: ['value', 'value']}),
      mouse: reporter('sensing_mousex', 'right')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'live-input', blockId: 'mouse'})
    ]);
  });

  it('does not reject for a sample on a statically unreachable branch', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'choose', 'hat'),
      choose: block('control_if', null, 'safe', false, {
        CONDITION: [1, [10, 'false']],
        SUBSTACK: [2, 'store']
      }),
      store: block('data_setvariableto', null, 'choose', false, {VALUE: [2, 'clock']}, {VARIABLE: ['value', 'value']}),
      clock: reporter('sensing_timer', 'store')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.eligible).toBe(true);
    expect(certificate.reasons).toEqual([]);
  });

  it('follows a non-recursive custom procedure reached before a boundary', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'call', 'hat'),
      call: procedureCall('sample', null, 'safe'),
      definition: block('procedures_definition', 'store', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('sample', 'definition'),
      store: block('data_setvariableto', null, 'definition', false, {VALUE: [2, 'clock']}, {VARIABLE: ['value', 'value']}),
      clock: reporter('sensing_timer', 'store')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'timer', blockId: 'clock'})
    ]);
  });

  it('follows returns from a rewritten procedure body to each runnable caller', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'call', null, true),
      call: procedureCall('safe body', 'store', 'hat'),
      store: block('data_setvariableto', null, 'call', false, {VALUE: [2, 'clock']}, {VARIABLE: ['value', 'value']}),
      clock: reporter('sensing_timer', 'store'),
      definition: block('procedures_definition', 'inside', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('safe body', 'definition'),
      inside: block('looks_show', null, 'definition')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['inside']}, 'lossy');
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'timer', blockId: 'clock'})
    ]);
  });

  it('applies the forward check to a selected input rewrite and a nested branch continuation', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'choose', null, true),
      choose: block('control_if', 'store', 'hat', false, {
        CONDITION: [1, [10, 'true']],
        SUBSTACK: [2, 'inside']
      }),
      inside: block('motion_setx', null, 'choose', false, {X: [1, [4, '10']]}),
      store: block('data_setvariableto', null, 'choose', false, {VALUE: [2, 'random']}, {VARIABLE: ['value', 'value']}),
      random: reporter('operator_random', 'store', {FROM: [1, [4, '1']], TO: [1, [4, '10']]})
    };

    const certificate = certifyRegionEffects(project, {
      targetIndex: 0,
      blockIds: ['inside'],
      inputNamesByBlock: {inside: ['X']}
    }, 'lossy');
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'random-source', blockId: 'random'})
    ]);
  });

  it('stops at the first guaranteed yield and does not inspect the resumed continuation', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'yield', 'hat'),
      yield: block('control_repeat', 'store', 'safe', false, {
        TIMES: [1, [4, '1']],
        SUBSTACK: [2, 'body']
      }),
      body: block('looks_show', null, 'yield'),
      store: block('data_setvariableto', null, 'yield', false, {VALUE: [2, 'random']}, {VARIABLE: ['value', 'value']}),
      random: reporter('operator_random', 'store', {FROM: [1, [4, '1']], TO: [1, [4, '10']]})
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.eligible).toBe(true);
    expect(certificate.reasons).toEqual([]);
  });

  it('does not reject because an unreachable procedure on another target contains a sample', () => {
    const project = projectWithStage(true);
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', null, 'hat')
    };
    sprite.blocks = {
      definition: block('procedures_definition', 'store', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('unused sample', 'definition'),
      store: block('data_setvariableto', null, 'definition', false, {VALUE: [2, 'mouse']}, {VARIABLE: ['local', 'local']}),
      mouse: reporter('sensing_mousex', 'store')
    };

    const first = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    const second = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(first.eligible).toBe(true);
    expect(first.reasons).toEqual([]);
    expect(second).toEqual(first);
  });

  it('does not apply downstream timing restrictions inside an unused procedure', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      definition: block('procedures_definition', 'safe', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('unused', 'definition'),
      safe: block('looks_show', 'store', 'definition'),
      store: block('data_setvariableto', null, 'safe', false, {VALUE: [2, 'timer']}, {VARIABLE: ['value', 'value']}),
      timer: reporter('sensing_timer', 'store')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.eligible).toBe(true);
    expect(certificate.reasons).toEqual([]);
  });

  it('keeps the no-preserve timing and sampling waiver', () => {
    const project = projectWithStage();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'store', 'hat'),
      store: block('data_setvariableto', null, 'safe', false, {VALUE: [2, 'timer']}, {VARIABLE: ['value', 'value']}),
      timer: reporter('sensing_timer', 'store')
    };

    const certificate = certifyRegionEffects(project, {targetIndex: 0, blockIds: ['safe']}, 'no-preserve');
    expect(certificate.eligible).toBe(true);
    expect(certificate.reasons).toEqual([]);
  });
});

function projectWithStage(withSprite = false): ScratchProject {
  const targets: ScratchTarget[] = [{
    isStage: true,
    name: 'Stage',
    variables: {value: ['value', 0]},
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
      variables: {local: ['local', 0]},
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

function reporter(opcode: string, parent: string, inputs: Record<string, ScratchInput> = {}): ScratchBlock {
  return block(opcode, null, parent, false, inputs);
}

function procedureCall(proccode: string, next: string | null, parent: string): ScratchBlock {
  return {
    ...block('procedures_call', next, parent),
    mutation: {proccode, argumentids: '[]', warp: 'false'}
  };
}

function procedurePrototype(proccode: string, parent: string): ScratchBlock {
  return {
    ...block('procedures_prototype', null, parent),
    shadow: true,
    mutation: {
      proccode,
      argumentids: '[]',
      argumentnames: '[]',
      argumentdefaults: '[]',
      warp: 'false'
    }
  };
}
