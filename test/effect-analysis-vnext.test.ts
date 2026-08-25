import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {isScratchBlock} from '../src/model/blocks.js';
import {
  analyzeProjectEffects,
  certifyRegionEffects,
  certifyRegionsEffects,
  collectCertifiedNestedLinearRuns,
  collectNestedLinearRuns,
  isOfficialHatOpcode
} from '../src/obfuscation/analysis.js';
import type {ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {OFFICIAL_CORE_OPCODES, OFFICIAL_EXTENSION_OPCODES} from '../src/validation/extensions.js';

describe('per-region effect analysis', () => {
  it('classifies the complete official core and extension hat surface centrally', () => {
    for (const opcode of OFFICIAL_CORE_OPCODES) {
      const expected = opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
      expect(isOfficialHatOpcode(opcode), opcode).toBe(expected);
    }
    for (const opcodes of OFFICIAL_EXTENSION_OPCODES.values()) {
      for (const opcode of opcodes) {
        const separator = opcode.indexOf('_');
        const expected = separator > 0 && opcode.slice(separator + 1).startsWith('when');
        expect(isOfficialHatOpcode(opcode), opcode).toBe(expected);
      }
    }
    expect(isOfficialHatOpcode('event_wheninvented')).toBe(false);
    expect(isOfficialHatOpcode('custom_whenButtonPressed')).toBe(false);
    expect(isOfficialHatOpcode('microbit_isButtonPressed')).toBe(false);
  });

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
    expect(dynamic.reasons.map(reason => reason.code)).toEqual(['dynamic-target-owner']);
    expect(dynamic.sameTargetConcurrentEntries.map(entry => entry.blockId)).toEqual(['first']);

    const lossyDynamic = certifyRegionEffects(project, {targetIndex: 1, blockIds: ['goto']}, 'lossy');
    expect(lossyDynamic.reasons.map(reason => reason.code)).toEqual([
      'live-input',
      'random-source',
      'dynamic-target-owner'
    ]);
  });

  it('uses synchronous hat ownership while distinguishing frame-moving parameter references and inherited warp', () => {
    const direct = baseProject();
    const directStage = requireTarget(direct, 0);
    directStage.blocks = {
      first: block('event_whenflagclicked', 'show', null, true),
      show: block('looks_show', null, 'first'),
      second: block('event_whenkeypressed', 'hide', null, true),
      hide: block('looks_hide', null, 'second')
    };
    expect(certifyRegionEffects(direct, {targetIndex: 0, blockIds: ['show']}, 'no-preserve').eligible).toBe(true);
    expect(certifyRegionEffects(direct, {targetIndex: 0, blockIds: ['hide']}, 'no-preserve').eligible).toBe(true);

    const ownedProcedure = baseProject();
    const ownedStage = requireTarget(ownedProcedure, 0);
    ownedStage.blocks = {
      owner: block('event_whenflagclicked', 'owner-call', null, true),
      'owner-call': procedureCall('work', null, 'owner'),
      unrelated: block('event_whenkeypressed', 'unrelated-body', null, true),
      'unrelated-body': block('looks_hide', null, 'unrelated'),
      definition: block('procedures_definition', 'procedure-body', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('work', false, 'definition'),
      'procedure-body': block('looks_show', null, 'definition')
    };
    expect(certifyRegionEffects(
      ownedProcedure,
      {targetIndex: 0, blockIds: ['procedure-body']},
      'no-preserve'
    ).eligible).toBe(true);
    ownedStage.blocks['unrelated-body'] = procedureCall('work', null, 'unrelated');
    expect(certifyRegionEffects(
      ownedProcedure,
      {targetIndex: 0, blockIds: ['procedure-body']},
      'no-preserve'
    ).reasons.map(reason => reason.code)).toEqual(['concurrent-target-owner']);

    const parameterized = baseProject();
    const parameterStage = requireTarget(parameterized, 0);
    parameterStage.blocks = {
      hat: block('event_whenflagclicked', 'call', null, true),
      call: {
        ...procedureCall('write %s', null, 'hat'),
        inputs: {value: [1, [10, 'sample']]},
        mutation: {proccode: 'write %s', argumentids: '["value"]', warp: 'false'}
      },
      definition: block('procedures_definition', 'set', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('write %s', false, 'definition', ['value']),
      set: command('data_setvariableto', null, 'definition', {VALUE: [2, 'argument']}, {VARIABLE: ['global value', 'global']}),
      argument: {
        ...reporter('argument_reporter_string_number', 'set', {}, {VALUE: ['value', null]}),
        shadow: false
      }
    };
    const inFrame = certifyRegionEffects(parameterized, {targetIndex: 0, blockIds: ['set']}, 'no-preserve');
    expect(inFrame.introducesProcedureFrame).toBe(false);
    expect(inFrame.eligible).toBe(true);
    expect(inFrame.reasons).toEqual([]);
    const movedToNewFrame = certifyRegionEffects(parameterized, {
      targetIndex: 0,
      blockIds: ['set'],
      introducesProcedureFrame: true
    }, 'no-preserve');
    expect(movedToNewFrame.introducesProcedureFrame).toBe(true);
    expect(movedToNewFrame.reasons.map(reason => reason.code)).toEqual(['procedure-parameter']);

    const set = parameterStage.blocks['set'];
    if (!isScratchBlock(set)) throw new Error('parameterized procedure body is unavailable');
    set.next = 'show';
    parameterStage.blocks['show'] = command('looks_show', 'hide', 'set');
    parameterStage.blocks['hide'] = command('looks_hide', 'clear', 'show');
    parameterStage.blocks['clear'] = command('looks_cleargraphiceffects', null, 'hide');
    const framedRun = collectCertifiedNestedLinearRuns(parameterized, 'no-preserve', {
      includeProcedureBodies: true
    }).find(candidate => candidate.run.blockIds[0] === 'set');
    expect(framedRun?.certificate.introducesProcedureFrame).toBe(true);
    expect(framedRun?.certificate.reasons.map(reason => reason.code)).toEqual(['procedure-parameter']);

    const inheritedWarp = baseProject();
    const warpStage = requireTarget(inheritedWarp, 0);
    warpStage.blocks = {
      hat: block('event_whenflagclicked', 'outer-call', null, true),
      'outer-call': procedureCall('outer', null, 'hat'),
      'outer-definition': block('procedures_definition', 'inner-call', null, true, {custom_block: [1, 'outer-prototype']}),
      'outer-prototype': procedurePrototype('outer', true, 'outer-definition'),
      'inner-call': procedureCall('inner', null, 'outer-definition'),
      'inner-definition': block('procedures_definition', 'inner-body', null, true, {custom_block: [1, 'inner-prototype']}),
      'inner-prototype': procedurePrototype('inner', false, 'inner-definition'),
      'inner-body': block('looks_show', null, 'inner-definition')
    };
    const helper = certifyRegionEffects(inheritedWarp, {targetIndex: 0, blockIds: ['inner-body']}, 'no-preserve');
    expect(helper.reasons.map(reason => reason.code)).toEqual(['warp-procedure']);

    const liveHat = warpStage.blocks['hat'];
    const deadCall = warpStage.blocks['outer-call'];
    if (!isScratchBlock(liveHat) || !isScratchBlock(deadCall)) {
      throw new Error('warp ownership fixture is malformed');
    }
    liveHat.next = 'inner-live-call';
    warpStage.blocks['inner-live-call'] = procedureCall('inner', null, 'hat');
    deadCall.topLevel = true;
    deadCall.parent = null;
    const unreachableWarp = certifyRegionEffects(
      inheritedWarp,
      {targetIndex: 0, blockIds: ['inner-body']},
      'no-preserve'
    );
    expect(unreachableWarp.reasons.map(reason => reason.code)).toEqual([]);

    const extension = baseProject();
    const extensionStage = requireTarget(extension, 0);
    extensionStage.blocks = {
      extension: block('microbit_whenButtonPressed', 'body', null, true),
      body: block('looks_show', null, 'extension')
    };
    expect(analyzeProjectEffects(extension).runnableEntries).toEqual([
      expect.objectContaining({blockId: 'extension', kind: 'hat'})
    ]);
  });

  it('excludes dead-branch and post-terminal calls from procedure owners without pruning dynamic paths', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      live: block('event_whenflagclicked', 'live-call', null, true),
      'live-call': procedureCall('work', null, 'live'),
      conditional: block('event_whenkeypressed', 'guard', null, true),
      guard: command('control_if', null, 'conditional', {
        CONDITION: [1, [4, '0']],
        SUBSTACK: [2, 'conditional-call']
      }),
      'conditional-call': procedureCall('work', null, 'guard'),
      definition: block('procedures_definition', 'body', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('work', false, 'definition'),
      body: block('looks_show', null, 'definition')
    };

    const certifyBody = (): readonly string[] => certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['body']},
      'no-preserve'
    ).reasons.map(reason => reason.code);
    expect(certifyBody()).toEqual([]);

    const guard = stage.blocks['guard'];
    if (!isScratchBlock(guard)) throw new Error('owner guard is unavailable');
    guard.inputs['CONDITION'] = [2, 'dynamic-condition'];
    stage.blocks['dynamic-condition'] = reporter(
      'data_variable',
      'guard',
      {},
      {VARIABLE: ['global value', 'global']}
    );
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    delete stage.blocks['dynamic-condition'];
    stage.blocks['guard'] = command(
      'control_stop',
      'conditional-call',
      'conditional',
      {},
      {STOP_OPTION: ['this script', null]}
    );
    const conditionalCall = stage.blocks['conditional-call'];
    if (!isScratchBlock(conditionalCall)) throw new Error('conditional procedure call is unavailable');
    conditionalCall.parent = 'guard';
    expect(certifyBody()).toEqual([]);

    const stop = stage.blocks['guard'];
    if (!isScratchBlock(stop)) throw new Error('terminal owner block is unavailable');
    stop.fields['STOP_OPTION'] = ['other scripts in sprite', null];
    expect(certifyBody()).toEqual(['concurrent-target-owner']);
  });

  it('tracks finite-loop procedure owners through static, dynamic, and missing iteration inputs', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      live: block('event_whenflagclicked', 'live-call', null, true),
      'live-call': procedureCall('work', null, 'live'),
      candidate: block('event_whenkeypressed', 'loop', null, true),
      loop: command('control_repeat', null, 'candidate', {
        TIMES: [1, [4, '0']],
        SUBSTACK: [2, 'loop-call']
      }),
      'loop-call': procedureCall('work', null, 'loop'),
      definition: block('procedures_definition', 'body', null, true, {custom_block: [1, 'prototype']}),
      prototype: procedurePrototype('work', false, 'definition'),
      body: block('looks_show', null, 'definition')
    };
    const certifyBody = (): readonly string[] => certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['body']},
      'no-preserve'
    ).reasons.map(reason => reason.code);
    const loop = stage.blocks['loop'];
    if (!isScratchBlock(loop)) throw new Error('owner loop is unavailable');

    expect(certifyBody()).toEqual([]);
    loop.inputs['TIMES'] = [1, [4, '1']];
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    loop.inputs['TIMES'] = [2, 'dynamic-count'];
    stage.blocks['dynamic-count'] = reporter(
      'data_variable',
      'loop',
      {},
      {VARIABLE: ['global value', 'global']}
    );
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    delete stage.blocks['dynamic-count'];
    loop.opcode = 'control_for_each';
    delete loop.inputs['TIMES'];
    loop.inputs['VALUE'] = [1, [4, '0']];
    expect(certifyBody()).toEqual([]);
    loop.inputs['VALUE'] = [1, [4, '1']];
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    delete loop.inputs['VALUE'];
    expect(certifyBody()).toEqual(['concurrent-target-owner']);
    delete loop.inputs['SUBSTACK'];
    expect(certifyBody()).toEqual([]);

    loop.inputs['VALUE'] = [1, [4, '1']];
    loop.inputs['SUBSTACK'] = [2, 'loop-call'];
    loop.next = 'loop';
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    loop.next = null;
    loop.opcode = 'control_all_at_once';
    loop.inputs = {SUBSTACK: [2, 'loop-call']};
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    loop.opcode = 'control_forever';
    expect(certifyBody()).toEqual(['concurrent-target-owner']);

    loop.opcode = 'control_wait_until';
    loop.next = 'loop-call';
    loop.inputs = {CONDITION: [1, [10, 'true']]};
    expect(certifyBody()).toEqual(['concurrent-target-owner']);
    loop.inputs['CONDITION'] = [1, [10, 'false']];
    expect(certifyBody()).toEqual([]);
  });

  it('excludes unreachable calls from inherited-warp analysis while retaining unknown branches', () => {
    const project = baseProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'outer-call', null, true),
      'outer-call': procedureCall('outer', null, 'hat'),
      'outer-definition': block('procedures_definition', 'guard', null, true, {custom_block: [1, 'outer-prototype']}),
      'outer-prototype': procedurePrototype('outer', true, 'outer-definition'),
      guard: command('control_if', null, 'outer-definition', {
        CONDITION: [1, [4, '0']],
        SUBSTACK: [2, 'inner-call']
      }),
      'inner-call': procedureCall('inner', null, 'guard'),
      'inner-definition': block('procedures_definition', 'inner-body', null, true, {custom_block: [1, 'inner-prototype']}),
      'inner-prototype': procedurePrototype('inner', false, 'inner-definition'),
      'inner-body': block('looks_show', null, 'inner-definition')
    };

    const certifyInner = (): readonly string[] => certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['inner-body']},
      'no-preserve'
    ).reasons.map(reason => reason.code);
    expect(certifyInner()).toEqual([]);

    const guard = stage.blocks['guard'];
    if (!isScratchBlock(guard)) throw new Error('warp guard is unavailable');
    guard.inputs['CONDITION'] = [2, 'dynamic-condition'];
    stage.blocks['dynamic-condition'] = reporter(
      'data_variable',
      'guard',
      {},
      {VARIABLE: ['global value', 'global']}
    );
    expect(certifyInner()).toEqual(['warp-procedure']);

    delete stage.blocks['dynamic-condition'];
    stage.blocks['guard'] = command(
      'control_stop',
      'inner-call',
      'outer-definition',
      {},
      {STOP_OPTION: ['all', null]}
    );
    const innerCall = stage.blocks['inner-call'];
    if (!isScratchBlock(innerCall)) throw new Error('inner procedure call is unavailable');
    innerCall.parent = 'guard';
    expect(certifyInner()).toEqual([]);
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
