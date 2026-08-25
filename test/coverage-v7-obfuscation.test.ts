import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock, stageOf} from '../src/model/blocks.js';
import {
  analyzeProjectEffects,
  certifyRegionEffects,
  collectVariableCandidates,
  isImmediatelyNumericInput,
  type VariableCandidate
} from '../src/obfuscation/analysis.js';
import {
  ANTI_CHEAT_WATERMARK_NAME,
  applyAntiCheatTransform,
  applyGameplayStateProtection,
  applyWatermarkTransform,
  releaseGameplayStateCandidates,
  reserveGameplayStateCandidates,
  type GameplayStateProtectionResult
} from '../src/obfuscation/anticheat.js';
import {applyAntiSaveTransform, isSafeCanaryText} from '../src/obfuscation/antisave.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import {applyExtraPrivacyTransform, EXTRA_PRIVACY_GENERATOR_DOMAIN} from '../src/obfuscation/privacy.js';
import type {
  JsonValue,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../src/types.js';
import {createFixtureProject} from './support.js';

describe('v7 obfuscation boundary coverage', () => {
  it('models static control paths, reporter cycles, and nested procedure ownership', () => {
    expect(isImmediatelyNumericInput('operator_add', 'NUM1')).toBe(true);
    expect(isImmediatelyNumericInput('operator_add', 'STRING1')).toBe(false);
    expect(isImmediatelyNumericInput('unknown_opcode', 'NUM1')).toBe(false);

    const stage = emptyTarget(true, 'Stage');
    stage.variables['condition'] = ['condition', 1];
    stage.blocks = {
      hat: block('event_whenflagclicked', 'choose', null, true),
      'hat-two': block('event_whenkeypressed', 'call-inner-second-hat', null, true),
      'call-inner-second-hat': procedureCall('inner', null, 'hat-two'),
      'hat-missing': block('event_whenthisspriteclicked', 'call-missing-only', null, true),
      'call-missing-only': procedureCall('missing', null, 'hat-missing'),
      'hat-shared': block('event_whenkeypressed', 'shared-choice', null, true),
      'shared-choice': block('control_if_else', null, 'hat-shared', false, {
        CONDITION: [2, 'condition-reporter'],
        SUBSTACK: [2, 'shared-call-inner'],
        SUBSTACK2: [2, 'shared-call-inner']
      }),
      'shared-call-inner': procedureCall('inner', null, 'shared-choice'),
      'hat-numeric': block('event_whenkeypressed', 'numeric-choice', null, true),
      'numeric-choice': block('control_if_else', null, 'hat-numeric', false, {
        CONDITION: [2, 'numeric-expression'],
        SUBSTACK: [2, 'numeric-call-inner'],
        SUBSTACK2: [2, 'numeric-call-missing']
      }),
      'numeric-expression': block('operator_add', null, 'numeric-choice', false, {
        NUM1: [1, [4, 1]], NUM2: [1, [4, 1]]
      }),
      'numeric-call-inner': procedureCall('inner', null, 'numeric-choice'),
      'numeric-call-missing': procedureCall('missing', null, 'numeric-choice'),
      'hat-entering-loop': block('event_whenkeypressed', 'entering-loop', null, true),
      'entering-loop': block('control_repeat_until', 'unreachable-after-loop', 'hat-entering-loop', false, {
        CONDITION: [1, [10, 'false']], SUBSTACK: [2, 'loop-call-inner']
      }),
      'loop-call-inner': procedureCall('inner', null, 'entering-loop'),
      'unreachable-after-loop': procedureCall('missing', null, 'entering-loop'),
      choose: block('control_if_else', 'until', 'hat', false, {
        CONDITION: [2, 'condition-reporter'],
        SUBSTACK: [2, 'call-outer'],
        SUBSTACK2: [2, 'call-missing']
      }),
      'condition-reporter': block('operator_not', null, 'choose', false, {OPERAND: [2, 'condition-reporter']}),
      'call-outer': procedureCall('outer', null, 'choose'),
      'call-missing': procedureCall('missing', null, 'choose'),
      until: block('control_repeat_until', 'while', 'choose', false, {
        CONDITION: [2, 'missing-reporter'],
        SUBSTACK: [2, 'call-inner-direct']
      }),
      'call-inner-direct': procedureCall('inner', null, 'until'),
      while: block('control_while', null, 'until', false, {
        CONDITION: [1, [10, 'false']],
        SUBSTACK: [2, 'call-inner-skipped']
      }),
      'call-inner-skipped': procedureCall('inner', null, 'while'),
      'outer-definition': procedureDefinition('outer-definition', 'outer-prototype', 'outer-call-self'),
      'outer-prototype': procedurePrototype('outer', 'outer-definition', 'true'),
      'outer-call-self': procedureCall('outer', 'outer-call-inner', 'outer-definition'),
      'outer-call-inner': procedureCall('inner', 'outer-call-ambiguous', 'outer-call-self'),
      'outer-call-ambiguous': procedureCall('duplicate', 'outer-call-unresolved', 'outer-call-inner'),
      'outer-call-unresolved': procedureCall('absent', null, 'outer-call-ambiguous'),
      'inner-definition': procedureDefinition('inner-definition', 'inner-prototype', 'inner-body'),
      'inner-prototype': procedurePrototype('inner', 'inner-definition', 'neither'),
      'inner-body': block('looks_show', null, 'inner-definition'),
      'duplicate-one-definition': procedureDefinition('duplicate-one-definition', 'duplicate-one-prototype', null),
      'duplicate-one-prototype': procedurePrototype('duplicate', 'duplicate-one-definition', 'false'),
      'duplicate-two-definition': procedureDefinition('duplicate-two-definition', 'duplicate-two-prototype', null),
      'duplicate-two-prototype': procedurePrototype('duplicate', 'duplicate-two-definition', 'false')
    };
    const project = scratchProject([stage]);
    const analysis = analyzeProjectEffects(project);

    expect(analysis.procedures.find(value => value.proccode === 'inner')?.warp).toBeNull();
    const certificate = certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['inner-body']},
      'no-preserve',
      analysis
    );
    expect(certificate.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'warp-procedure',
      'concurrent-target-owner'
    ]));

    const direct = certifyRegionEffects(
      project,
      {targetIndex: 0, blockIds: ['choose']},
      'lossy',
      analysis
    );
    expect(direct.effects.procedureCalls.map(call => call.resolution)).toContain('unresolved');
    expect(direct.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'ambiguous-procedure', 'unresolved-procedure', 'recursive-procedure'
    ]));
  });

  it('traces reporter and structural cycles without inventing temporal effects', () => {
    const reporterStage = emptyTarget(true, 'Stage');
    reporterStage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'owner', 'hat'),
      owner: block('operator_not', null, 'safe', false, {
        OPERAND: [2, 'cycle'],
        SUBSTACK: [2, 'ignored-substack']
      }),
      cycle: block('operator_not', null, 'owner', false, {
        OPERAND: [2, 'cycle'], SUBSTACK: [2, 'ignored-substack']
      }),
      'ignored-substack': block('sensing_timer', null, 'owner')
    };
    const reporterCertificate = certifyRegionEffects(
      scratchProject([reporterStage]),
      {targetIndex: 0, blockIds: ['safe']},
      'lossy'
    );
    expect(reporterCertificate.reasons).toEqual([]);

    const missingStage = emptyTarget(true, 'Stage');
    missingStage.blocks = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'missing', 'hat')
    };
    expect(certifyRegionEffects(
      scratchProject([missingStage]),
      {targetIndex: 0, blockIds: ['safe']},
      'lossy'
    ).eligible).toBe(true);

    const structuralStage = emptyTarget(true, 'Stage');
    structuralStage.blocks = {
      first: block('operator_not', null, 'second', false, {OPERAND: [2, 'second']}),
      second: block('operator_not', null, 'first', false, {OPERAND: [2, 'first']})
    };
    expect(certifyRegionEffects(
      scratchProject([structuralStage]),
      {targetIndex: 0, blockIds: ['first']},
      'lossy'
    ).eligible).toBe(true);

    const filteredStage = emptyTarget(true, 'Stage');
    filteredStage.blocks = {
      hat: block('event_whenflagclicked', 'owner', null, true),
      owner: block('looks_say', null, 'hat', false, {MESSAGE: [2, 'literal'], OTHER: [2, 'timer']}),
      literal: block('operator_join', null, 'owner', false, {
        STRING1: [1, [10, 'a']], STRING2: [1, [10, 'b']]
      }),
      timer: block('sensing_timer', null, 'owner')
    };
    expect(certifyRegionEffects(scratchProject([filteredStage]), {
      targetIndex: 0,
      blockIds: ['owner'],
      inputNamesByBlock: {owner: ['MESSAGE']}
    }, 'lossy').reasons).toEqual([expect.objectContaining({code: 'timer', blockId: 'timer'})]);
  });

  it('orders mixed symbol effects and covers selector and argument coercion edges', () => {
    const stage = emptyTarget(true, 'Stage');
    stage.variables = {
      globalA: ['same', 1],
      globalB: ['same', 2]
    };
    stage.lists = {globalList: ['items', []]};
    const sprite = emptyTarget(false, 'Sprite');
    sprite.variables = {local: ['local', 0]};
    sprite.lists = {localList: ['local items', []]};
    sprite.blocks = {
      localRead: block('data_variable', null, null, false, {}, {VARIABLE: ['local', 'local']}),
      globalReadByName: block('data_variable', null, null, false, {}, {VARIABLE: ['same', '']}),
      ambiguousRead: block('data_variable', null, null, false, {}, {VARIABLE: ['same', 'missing']}),
      localList: block('data_itemoflist', null, null, false, {INDEX: [1, [10, 'last']]}, {LIST: ['local items', 'localList']}),
      stageList: block('data_addtolist', null, null, false, {ITEM: [1, [10, 'x']]}, {LIST: ['items', 'globalList']}),
      glide: block('motion_glideto', null, null, false, {TO: [1, [10, '_mouse_']]}),
      myself: block('control_create_clone_of', null, null, false, {CLONE_OPTION: [1, [10, '_myself_']]}),
      malformedCall: {
        ...procedureCall('p %s', null, null),
        inputs: {arg: [1, [10, 'x']]},
        mutation: {proccode: 'p %s', argumentids: ['not-json'], warp: 'false'}
      },
      malformedLengths: {
        ...procedureCall('p %s', null, null),
        inputs: {arg: [1, [10, 'x']]},
        mutation: {proccode: 'p %s', argumentids: '[1]', warp: 'false'}
      },
      definition: procedureDefinition('definition', 'prototype', null),
      prototype: {
        ...procedurePrototype('p %s', 'definition', 'false'),
        mutation: {
          proccode: 'p %s', argumentids: '["arg"]', argumentnames: 'not-json',
          argumentdefaults: 'false', warp: 'false'
        }
      },
      nonStringDefaultsDefinition: procedureDefinition(
        'nonStringDefaultsDefinition', 'nonStringDefaultsPrototype', null
      ),
      nonStringDefaultsPrototype: {
        ...procedurePrototype('non-string defaults', 'nonStringDefaultsDefinition', 'false'),
        mutation: {
          proccode: 'non-string defaults', argumentids: '[]', argumentnames: '[]',
          argumentdefaults: false, warp: 'false'
        }
      },
      invalidDefaultsDefinition: procedureDefinition('invalidDefaultsDefinition', 'invalidDefaultsPrototype', null),
      invalidDefaultsPrototype: {
        ...procedurePrototype('invalid defaults', 'invalidDefaultsDefinition', 'false'),
        mutation: {
          proccode: 'invalid defaults', argumentids: '[]', argumentnames: '[]',
          argumentdefaults: 'not-json', warp: 'false'
        }
      },
      sensingNonString: block('sensing_of', null, null, false, {
        OBJECT: [1, {selector: 'Sprite'}] as unknown as ScratchInput
      }, {PROPERTY: ['x position', null]})
    };
    const project = scratchProject([stage, sprite]);
    const certificate = certifyRegionEffects(project, {
      targetIndex: 1,
      blockIds: [
        'localRead', 'globalReadByName', 'ambiguousRead', 'localList', 'stageList',
        'glide', 'myself', 'malformedCall', 'malformedLengths', 'sensingNonString'
      ]
    }, 'lossy');

    expect(certificate.effects.variableReads.map(value => value.scope)).toEqual(expect.arrayContaining([
      'target', 'unresolved'
    ]));
    expect(certificate.effects.listReads.map(value => value.id)).toEqual(expect.arrayContaining([
      'localList', 'globalList'
    ]));
    expect(certificate.effects.listWrites).toHaveLength(1);
    expect(certificate.effects.argumentEvaluationHazards.map(value => value.reason)).toContain('malformed-arguments');
    expect(certificate.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'clone', 'live-input', 'symbol-owner-unresolved'
    ]));
  });

  it('handles runtime typed names and malformed broadcast, sensing, and procedure surfaces', () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    project.targets = [stage];
    project.monitors = [];
    stage.variables = {value: ['value', 0]};
    stage.lists = {items: ['items', []]};
    stage.broadcasts = {message: 'message'};
    stage.comments = {};
    stage.blocks = {
      primitive: [11, 'message', 'message'],
      primitiveParent: [10, 'parent'],
      runtimePrimitiveOwner: block('looks_say', null, null, true, {MESSAGE: [2, 'primitive']}),
      missingTypedOwner: block('looks_say', null, null, true, {
        MESSAGE: [1, [12, 'missing', 'missing-variable']]
      }),
      missingTypedReporterOwner: block('looks_say', null, null, true, {
        MESSAGE: [2, 'missingTypedReporter']
      }),
      missingTypedReporter: block(
        'event_broadcast_menu', null, 'missingTypedReporterOwner', false, {},
        {BROADCAST_OPTION: ['missing', 'missing-broadcast']}
      ),
      missingBroadcast: block('event_broadcast', null, null, true),
      nullBroadcast: block('event_broadcast', null, null, true, {
        BROADCAST_INPUT: [1, null] as unknown as ScratchInput
      }),
      menuOwner: block('event_broadcast', null, null, true, {BROADCAST_INPUT: [2, 'missingMenuField']}),
      missingMenuField: block('event_broadcast_menu', null, 'menuOwner'),
      numericMenuOwner: block('event_broadcast', null, null, true, {BROADCAST_INPUT: [2, 'numericMenu']}),
      numericMenu: block('event_broadcast_menu', null, 'numericMenuOwner', false, {}, {BROADCAST_OPTION: [7, null]}),
      literalMenuOwner: block('event_broadcast', null, null, true, {BROADCAST_INPUT: [2, 'literalMenu']}),
      literalMenu: block('motion_goto_menu', null, 'literalMenuOwner', false, {}, {TO: ['message', null]}),
      sensingNull: block('sensing_of', null, null, true, {
        OBJECT: [1, null] as unknown as ScratchInput
      }, {PROPERTY: ['x position', null]}),
      sensingDynamic: block('sensing_of', null, null, true, {
        OBJECT: [1, {bad: true}] as unknown as ScratchInput
      }, {PROPERTY: ['x position', null]}),
      badDefinition: block('procedures_definition', null, null, true, {
        custom_block: [1, [10, 'not-an-id']]
      }),
      orphanArgument: block(
        'argument_reporter_string_number', null, 'primitiveParent', false, {}, {VALUE: [false, null]}
      ),
      orphanNamedArgument: block(
        'argument_reporter_string_number', null, 'primitiveParent', false, {}, {VALUE: ['name', null]}
      ),
      badDefinitionArgument: block(
        'argument_reporter_string_number', null, 'badDefinition', false, {}, {VALUE: ['name', null]}
      )
    };
    const stats = emptyStats();

    expect(() => applyCommonTransforms(project, generator('common'), stats)).not.toThrow();
    expect(stats.identifiersRenamed).toBeGreaterThan(0);
    expect(stats.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining('runtime reporter values'),
      expect.stringContaining('Broadcast display names')
    ]));
  });

  it('coerces all monitor selector JSON domains while retaining opted-out presentation metadata', () => {
    const project = createFixtureProject();
    const sprite = project.targets.find(target => !target.isStage);
    if (!sprite) throw new Error('fixture sprite unavailable');
    project['customRoot'] = {retained: true};
    project.monitors = [
      sensingMonitor('missing', {}),
      sensingMonitor('null', {OBJECT: null}),
      sensingMonitor('array', {OBJECT: ['Visible Sprite']}),
      sensingMonitor('nested-array', {OBJECT: [null, ['Visible Sprite']]}),
      sensingMonitor('object', {OBJECT: {value: 'Visible Sprite'}}),
      sensingMonitor('number', {OBJECT: 7}),
      sensingMonitor('match', {OBJECT: 'Visible Sprite'})
    ];
    const before = structuredClone(project.monitors);
    const report = applyExtraPrivacyTransform(
      project,
      new DeterministicGenerator(new Uint8Array(32).fill(0x77), EXTRA_PRIVACY_GENERATOR_DOMAIN),
      {canonicalizeMonitorPresentation: false, stripOptionalProjectMetadata: false}
    );

    expect(report.monitorsCanonicalized).toBe(0);
    expect(report.metadataPropertiesRemoved).toBe(0);
    expect(project['customRoot']).toEqual({retained: true});
    expect(project.monitors.map(monitor => monitor['visible'])).toEqual(before.map(monitor => monitor['visible']));
    expect((project.monitors[2]?.['params'] as Record<string, JsonValue>)['OBJECT']).toBe(sprite.name);
    expect((project.monitors[6]?.['params'] as Record<string, JsonValue>)['OBJECT']).toBe(sprite.name);
  });

  it('rejects unsafe canary text and bounds native hats and inactive fallbacks', () => {
    expect(() => applyAntiSaveTransform(scratchProject([]), generator('antisave-empty')))
      .toThrow('antisave requires at least one Scratch target');
    expect(isSafeCanaryText('e\u0301')).toBe(false);
    expect(isSafeCanaryText('\u0000')).toBe(false);
    expect(isSafeCanaryText('\ufeff')).toBe(false);
    expect(isSafeCanaryText('\u200d')).toBe(false);
    expect(isSafeCanaryText('\n')).toBe(false);
    expect(isSafeCanaryText('\u202e')).toBe(false);
    expect(isSafeCanaryText('\ud800')).toBe(false);
    expect(isSafeCanaryText('')).toBe(false);
    expect(isSafeCanaryText('\u2063\ue001')).toBe(true);

    const fallbacks = scratchProject([emptyTarget(true, 'Stage')]);
    const fallbackStage = stageOf(fallbacks);
    const inputs: Record<string, ScratchInput> = {};
    for (let index = 0; index < 33; index += 1) {
      inputs[`VALUE${index}`] = [3, [4, index], [10, `fallback-${index}`]];
    }
    fallbackStage.blocks = {
      primitive: [10, 'occupied'],
      procedure: {
        ...block('procedures_call'),
        mutation: {proccode: 'occupied procedure'}
      },
      owner: block('operator_join', null, null, true, inputs)
    };
    const fallbackResult = applyAntiSaveTransform(fallbacks, generator('antisave-fallback-cap'));
    expect(fallbackResult.inactiveFallbackCanaries).toBe(32);

    const brokenContinuation = scratchProject([emptyTarget(true, 'Stage')]);
    const brokenStage = stageOf(brokenContinuation);
    brokenStage.blocks = {
      hat: block('event_whenflagclicked', 'primitive-next', null, true),
      'primitive-next': [10, 'not a statement']
    };
    expect(() => applyAntiSaveTransform(brokenContinuation, generator('antisave-bad-next')))
      .toThrow('antisave guarded continuation is unavailable');

    const tooManyHats = scratchProject([emptyTarget(true, 'Stage')]);
    const largeStage = stageOf(tooManyHats);
    for (let index = 0; index <= 10_000; index += 1) {
      largeStage.blocks[`hat-${index}`] = block('event_whenflagclicked', null, null, true);
    }
    expect(() => applyAntiSaveTransform(tooManyHats, generator('antisave-hat-limit')))
      .toThrow('antisave native-hat limit exceeded (10001 > 10000)');

    expect(() => applyAntiSaveTransform(
      scratchProject([emptyTarget(true, 'Stage')]),
      new ReservedIdGenerator()
    )).toThrow('could not allocate a collision-free antisave ID');

    const exhaustedNames = scratchProject([emptyTarget(true, 'Stage')]);
    const exhaustedStage = stageOf(exhaustedNames);
    for (let attempt = 0; attempt < 1_024; attempt += 1) {
      exhaustedStage.variables[`occupied-${attempt}`] = [zeroByteCanary(attempt * 17), attempt];
    }
    expect(() => applyAntiSaveTransform(exhaustedNames, new ZeroBytesGenerator()))
      .toThrow('could not allocate a collision-free antisave name');
  });

  it('covers watermark reuse, marker release, scalar sentinels, and reservation graph failures', () => {
    const watermarked = scratchProject([emptyTarget(true, 'Stage')]);
    const firstWatermark = applyWatermarkTransform(watermarked, generator('watermark'));
    const secondWatermark = applyWatermarkTransform(watermarked, generator('watermark-again'));
    expect(firstWatermark.watermarkCreated).toBe(true);
    expect(secondWatermark).toEqual({watermarkVariableId: firstWatermark.watermarkVariableId, watermarkCreated: false});
    expect(stageOf(watermarked).variables[firstWatermark.watermarkVariableId]?.[0]).toBe(ANTI_CHEAT_WATERMARK_NAME);

    const retainedMonitor = {id: 'retained'} as Record<string, JsonValue>;
    const markerOne = {id: 'marker-one'} as Record<string, JsonValue>;
    const markerTwo = {id: 'marker-two'} as Record<string, JsonValue>;
    watermarked.monitors = [markerOne, retainedMonitor, markerTwo];
    releaseGameplayStateCandidates(watermarked, {
      candidateKeys: new Set(),
      markerMonitors: [markerOne, markerTwo]
    });
    expect(watermarked.monitors).toEqual([retainedMonitor]);

    for (const expected of [true, false, 9, 0] as const) {
      const project = scratchProject([emptyTarget(true, 'Stage')]);
      const stage = stageOf(project);
      stage.variables['probe'] = ['probe', expected];
      if (expected === true) {
        stage.variables['non-string-name'] = [false, 0];
        stage.lists['non-string-list-name'] = [null, []];
        project.monitors = [
          {opcode: 'sensing_of', params: null},
          {opcode: 'sensing_of', params: {PROPERTY: 7}},
          {opcode: 'sensing_of', params: {PROPERTY: 'score'}}
        ];
      }
      const gameplayState: GameplayStateProtectionResult = {
        protectedVariableIds: [],
        integrityVariableIds: [],
        generatedBlockCount: 0,
        integrityPairs: [],
        guardProcedureCodes: new Map(),
        tripSentinel: {id: 'probe', name: 'probe', expected}
      };
      applyAntiCheatTransform(project, generator(`sentinel:${String(expected)}`), {gameplayState});
      const expectedOpcode = typeof expected === 'boolean'
        ? 'operator_equals'
        : expected === 0 ? 'operator_subtract' : 'operator_multiply';
      expect(Object.values(stage.blocks).some(value => isScratchBlock(value) && value.opcode === expectedOpcode)).toBe(true);
    }

    const preparedEmpty = scratchProject([emptyTarget(true, 'Stage')]);
    stageOf(preparedEmpty).variables['value'] = ['value', 0];
    const unavailableUsage: VariableCandidate = {
      targetIndex: 0,
      id: 'value',
      name: 'value',
      initialValue: 0,
      estimatedGrowth: 0,
      usages: [{kind: 'field', targetIndex: 99, blockId: 'missing'}]
    };
    expect(applyGameplayStateProtection(preparedEmpty, generator('prepared-empty'), [unavailableUsage]).generatedBlockCount)
      .toBe(0);

    const nonWriterProject = scratchProject([emptyTarget(true, 'Stage')]);
    const nonWriterStage = stageOf(nonWriterProject);
    nonWriterStage.variables['value'] = ['value', 'solo'];
    nonWriterStage.blocks = {
      hat: block('event_whenflagclicked', 'show', null, true),
      show: block('looks_show', null, 'hat')
    };
    const nonWriterCandidate: VariableCandidate = {
      targetIndex: 0,
      id: 'value',
      name: 'value',
      initialValue: 'solo',
      estimatedGrowth: 0,
      usages: [{kind: 'field', targetIndex: 0, blockId: 'show'}]
    };
    const nonWriterResult = applyGameplayStateProtection(
      nonWriterProject,
      generator('non-writer-usage'),
      [nonWriterCandidate]
    );
    expect(nonWriterResult.integrityPairs).toHaveLength(1);
    expect(nonWriterResult.integrityPairs[0]?.nextValueId).toBeUndefined();

    const malformed = scratchProject([emptyTarget(true, 'Stage')]);
    const malformedStage = stageOf(malformed);
    malformedStage.variables['value'] = ['value', 0];
    malformedStage.blocks = {
      primitiveRoot: [10, 'primitive'],
      middle: block('looks_show', 'writer', 'primitiveRoot'),
      writer: block('data_setvariableto', null, 'middle', false, {VALUE: [1, [4, 1]]}, {VARIABLE: ['value', 'value']})
    };
    const candidate = collectVariableCandidates(malformed).find(value => value.id === 'value');
    if (!candidate) throw new Error('malformed candidate unavailable');
    expect(reserveGameplayStateCandidates(malformed, [candidate], generator('primitive-root')).candidateKeys.size).toBe(0);

    const cyclicOwnership = scratchProject([emptyTarget(true, 'Stage')]);
    const cyclicStage = stageOf(cyclicOwnership);
    cyclicStage.variables['value'] = ['value', 0];
    cyclicStage.blocks = {
      first: block('data_setvariableto', null, 'second', false, {VALUE: [1, [4, 1]]}, {
        VARIABLE: ['value', 'value']
      }),
      second: block('looks_show', null, 'first')
    };
    const cyclicCandidate: VariableCandidate = {
      targetIndex: 0,
      id: 'value',
      name: 'value',
      initialValue: 0,
      estimatedGrowth: 0,
      usages: [{kind: 'field', targetIndex: 0, blockId: 'first'}]
    };
    expect(reserveGameplayStateCandidates(
      cyclicOwnership,
      [cyclicCandidate],
      generator('cyclic-statement-owner')
    ).candidateKeys.size).toBe(0);

    const invalidPairProject = scratchProject([emptyTarget(true, 'Stage')]);
    const invalidPair: GameplayStateProtectionResult = {
      protectedVariableIds: [], integrityVariableIds: [], generatedBlockCount: 0,
      guardProcedureCodes: new Map(),
      integrityPairs: [{
        declarationTargetIndex: 0, valueId: 'value', valueName: 'value', tagId: 'tag', tagName: 'tag',
        secret: 'secret', selector: '_stage_', usageTargetIndex: 0, groupSize: 2, groupPosition: 0,
        nextValueId: 'next'
      }]
    };
    expect(() => applyAntiCheatTransform(invalidPairProject, generator('invalid-linked-pair'), {
      gameplayState: invalidPair
    })).toThrow('anti-cheat linked gameplay integrity metadata is unavailable');
  });
});

function generator(domain: string): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => ((index * 29) + 7) & 0xff),
    `test:v7-obfuscation:${domain}`
  );
}

function scratchProject(targets: ScratchTarget[]): ScratchProject {
  return {targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}};
}

function emptyTarget(isStage: boolean, name: string): ScratchTarget {
  return {
    isStage,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: [],
    ...(isStage ? {} : {
      visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'
    })
  };
}

function block(
  opcode: string,
  next: string | null = null,
  parent: string | null = null,
  topLevel = false,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {
    opcode, next, parent, inputs, fields, shadow: false, topLevel,
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function procedureDefinition(id: string, prototypeId: string, next: string | null): ScratchBlock {
  return block('procedures_definition', next, null, true, {custom_block: [1, prototypeId]}, {ID: [id, null]});
}

function procedurePrototype(proccode: string, parent: string, warp: JsonValue): ScratchBlock {
  return {
    ...block('procedures_prototype', null, parent),
    shadow: true,
    mutation: {
      proccode, argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp
    }
  };
}

function procedureCall(proccode: string, next: string | null, parent: string | null): ScratchBlock {
  return {
    ...block('procedures_call', next, parent),
    mutation: {proccode, argumentids: '[]', warp: 'false'}
  };
}

function sensingMonitor(id: string, params: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    id, opcode: 'sensing_of', params, spriteName: null, visible: true, mode: 'default', value: 0,
    width: 80, height: 20, x: 10, y: 10, sliderMin: 0, sliderMax: 100, isDiscrete: true
  };
}

function emptyStats(): ObfuscationStats {
  return {
    mode: 'lossless', blocksBefore: 0, blocksAfter: 0, identifiersRenamed: 0,
    symbolsRenamed: 0, commentsRemoved: 0, decoysAdded: 0, virtualizedBlocks: 0,
    warnings: [], caveats: []
  };
}

class ReservedIdGenerator extends DeterministicGenerator {
  constructor() {
    super(new Uint8Array(32), 'test:v7-obfuscation:reserved-id');
  }

  override fork(domain: string): ReservedIdGenerator {
    void domain;
    return new ReservedIdGenerator();
  }

  override id(prefix: string, length?: number): string {
    void prefix;
    void length;
    return '__proto__';
  }
}

class ZeroBytesGenerator extends DeterministicGenerator {
  constructor() {
    super(new Uint8Array(32), 'test:v7-obfuscation:zero-bytes');
  }

  override fork(domain: string): ZeroBytesGenerator {
    void domain;
    return new ZeroBytesGenerator();
  }

  override bytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }
}

function zeroByteCanary(ordinal: number): string {
  const safeFormats = ['\u200b', '\u2060', '\u2063', '\ufe00', '\ufe01', '\ufe02'];
  let value = `\u2063\u200b\u2060${String.fromCharCode(0xe000 + (ordinal % 0x1900))}`;
  for (let index = 0; index < 18; index += 1) {
    value += safeFormats[(index + ordinal) % safeFormats.length];
    value += String.fromCharCode(0xe000 + (((ordinal * 257) + (index * 17)) % 0x1900));
  }
  return value.normalize('NFC');
}
