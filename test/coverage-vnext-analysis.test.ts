import {describe, expect, it} from 'vitest';
import {
  analyzeProjectEffects,
  certifyRegionEffects,
  collectNestedLinearRuns,
  collectVariableCandidates
} from '../src/obfuscation/analysis.js';
import type {JsonValue, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';

describe('vNext analysis coverage regressions', () => {
  it('orders concurrent target owners and detects a self-recursive procedure', () => {
    const concurrent = project([
      target(true, 'Stage', {
        a: block('event_whenflagclicked', null, null, true),
        b: block('event_whenkeypressed', null, null, true)
      }),
      target(false, 'Sprite', {
        c: block('event_whenflagclicked', null, null, true),
        d: block('event_whenthisspriteclicked', null, null, true)
      })
    ]);
    expect(analyzeProjectEffects(concurrent).concurrentTargetIndexes).toEqual([0, 1]);

    const recursive = project([target(true, 'Stage', {
      definition: procedureDefinition('self', 'prototype', 'call'),
      prototype: procedurePrototype('self', 'definition'),
      call: procedureCall('self', null, 'definition')
    })]);
    const node = analyzeProjectEffects(recursive).procedures[0];
    expect(node).toMatchObject({proccode: 'self', recursive: true});
    expect(node?.calls[0]).toMatchObject({resolution: 'resolved'});
  });

  it('marks duplicate procedure codes malformed and resolves a matching call as ambiguous', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'call', null, true),
      call: procedureCall('duplicate', null, 'hat'),
      first: procedureDefinition('first', 'first-prototype', null),
      'first-prototype': procedurePrototype('duplicate', 'first'),
      second: procedureDefinition('second', 'second-prototype', null),
      'second-prototype': procedurePrototype('duplicate', 'second')
    });
    const value = project([stage]);
    const analysis = analyzeProjectEffects(value);
    expect(analysis.procedures.every(node => node.malformed)).toBe(true);
    const certificate = certifyRegionEffects(value, {targetIndex: 0, blockIds: ['call']}, 'lossy', analysis);
    expect(certificate.effects.procedureCalls[0]).toMatchObject({resolution: 'ambiguous'});
    expect(certificate.reasons.map(reason => reason.code)).toContain('ambiguous-procedure');
  });

  it('tracks stage and sprite selectors, backdrop writes, and sensed variable ownership', () => {
    const stage = target(true, 'Stage');
    const sprite = target(false, 'Sprite', {
      backdrop: block('looks_switchbackdropto', null, null, false, {BACKDROP: [1, [10, '_stage_']]}),
      goto: block('motion_goto', null, null, false, {TO: [1, [10, '_stage_']]}),
      clone: block('control_create_clone_of', null, null, false, {CLONE_OPTION: [1, [10, 'Sprite']]}),
      sensed: block('sensing_of', null, null, false, {OBJECT: [1, [10, 'Sprite']]}, {PROPERTY: ['money', null]})
    });
    sprite.variables = {money: ['money', 7]};
    const value = project([stage, sprite]);
    const certificate = certifyRegionEffects(
      value,
      {targetIndex: 1, blockIds: ['backdrop', 'goto', 'clone', 'sensed']},
      'no-preserve'
    );

    expect(certificate.effects.ownership.readTargetIndexes).toEqual([0, 1]);
    expect(certificate.effects.ownership.writeTargetIndexes).toEqual([0, 1]);
    expect(certificate.effects.variableReads).toContainEqual({
      kind: 'variable', targetIndex: 1, scope: 'target', id: 'money', name: 'money'
    });
  });

  it('distinguishes dynamic, missing, native, and ambiguous sensing-of ownership', () => {
    const stage = target(true, 'Stage');
    const sprite = target(false, 'Sprite', {
      dynamic: block('sensing_of', null, null, false, {OBJECT: [2, 'selector']}, {PROPERTY: ['money', null]}),
      selector: reporter('data_variable', 'dynamic', {}, {VARIABLE: ['selector', 'selector']}),
      missing: block('sensing_of', null, null, false, {OBJECT: [1, [10, 'Ghost']]}, {PROPERTY: ['money', null]}),
      native: block('sensing_of', null, null, false, {OBJECT: [1, [10, 'Sprite']]}, {PROPERTY: ['x position', null]}),
      ambiguous: block('sensing_of', null, null, false, {OBJECT: [1, [10, 'Sprite']]}, {PROPERTY: ['money', null]})
    });
    sprite.variables = {
      selector: ['selector', 'Sprite'],
      one: ['money', 1],
      two: ['money', 2]
    };
    const value = project([stage, sprite]);

    const dynamic = certifyRegionEffects(value, {targetIndex: 1, blockIds: ['dynamic']}, 'no-preserve');
    expect(dynamic.effects.ownership).toMatchObject({dynamicTargetRead: true, readTargetIndexes: [0, 1]});
    const missing = certifyRegionEffects(value, {targetIndex: 1, blockIds: ['missing']}, 'no-preserve');
    expect(missing.effects.ownership.dynamicTargetRead).toBe(false);
    const native = certifyRegionEffects(value, {targetIndex: 1, blockIds: ['native']}, 'no-preserve');
    expect(native.effects.ownership.unresolvedSymbolOwnership).toBe(false);
    const ambiguous = certifyRegionEffects(value, {targetIndex: 1, blockIds: ['ambiguous']}, 'no-preserve');
    expect(ambiguous.effects.ownership.unresolvedSymbolOwnership).toBe(true);
  });

  it('walks from a rewritten nested reporter through its parent expression', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'store', null, true),
      store: block('data_setvariableto', null, 'hat', false, {VALUE: [2, 'sum']}, {VARIABLE: ['value', 'value']}),
      sum: reporter('operator_add', 'store', {NUM1: [2, 'rewritten'], NUM2: [2, 'mouse']}),
      rewritten: reporter('operator_round', 'sum', {NUM: [1, [4, '1']]}),
      mouse: reporter('sensing_mousex', 'sum')
    });
    stage.variables = {value: ['value', 0]};
    const certificate = certifyRegionEffects(
      project([stage]),
      {targetIndex: 0, blockIds: ['rewritten']},
      'lossy'
    );
    expect(certificate.effects.liveInputs).toEqual([]);
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'live-input', blockId: 'mouse'})
    ]);
  });

  it.each([
    ['missing', undefined, [], 'unresolved-procedure'],
    ['ambiguous', 'duplicate', ['duplicate', 'duplicate'], 'ambiguous-procedure'],
    ['malformed', 'broken', ['broken'], 'unresolved-procedure'],
    ['recursive', 'recursive', ['recursive'], 'recursive-procedure']
  ] as const)('rejects a forward %s procedure call', (variant, proccode, definitions, expectedCode) => {
    const blocks: Record<string, ScratchBlock> = {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'call', 'hat'),
      call: procedureCall(proccode, null, 'safe')
    };
    definitions.forEach((code, index) => {
      const definitionId = `definition-${index}`;
      const prototypeId = `prototype-${index}`;
      const bodyId = `body-${index}`;
      blocks[definitionId] = procedureDefinition(definitionId, prototypeId, variant === 'recursive' ? bodyId : null);
      blocks[prototypeId] = variant === 'malformed'
        ? procedurePrototype(code, definitionId, {argumentids: '["missing"]'})
        : procedurePrototype(code, definitionId);
      if (variant === 'recursive') blocks[bodyId] = procedureCall(code, null, definitionId);
    });
    const certificate = certifyRegionEffects(project([target(true, 'Stage', blocks)]), {
      targetIndex: 0,
      blockIds: ['safe']
    }, 'lossy');
    expect(certificate.reasons.map(reason => reason.code)).toContain(expectedCode);
  });

  it('continues through an empty procedure body to a later sample', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'call', 'hat'),
      call: procedureCall('empty', 'store', 'safe'),
      store: block('data_setvariableto', null, 'call', false, {VALUE: [2, 'timer']}, {VARIABLE: ['value', 'value']}),
      timer: reporter('sensing_timer', 'store'),
      definition: procedureDefinition('definition', 'prototype', null),
      prototype: procedurePrototype('empty', 'definition')
    });
    stage.variables = {value: ['value', 0]};
    const certificate = certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.reasons).toEqual([expect.objectContaining({code: 'timer', blockId: 'timer'})]);
  });

  it('returns through nested runnable procedures while ignoring an unused caller', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'call-outer', null, true),
      'call-outer': procedureCall('outer', 'store', 'hat'),
      store: block('data_setvariableto', null, 'call-outer', false, {VALUE: [2, 'timer']}, {VARIABLE: ['value', 'value']}),
      timer: reporter('sensing_timer', 'store'),
      outer: procedureDefinition('outer', 'outer-prototype', 'call-inner'),
      'outer-prototype': procedurePrototype('outer', 'outer'),
      'call-inner': procedureCall('inner', null, 'outer'),
      inner: procedureDefinition('inner', 'inner-prototype', 'inside'),
      'inner-prototype': procedurePrototype('inner', 'inner'),
      inside: block('looks_show', null, 'inner'),
      unused: procedureDefinition('unused', 'unused-prototype', 'unused-call-inner'),
      'unused-prototype': procedurePrototype('unused', 'unused'),
      'unused-call-inner': procedureCall('inner', null, 'unused')
    });
    stage.variables = {value: ['value', 0]};
    const certificate = certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['inside']}, 'lossy');
    expect(certificate.reasons).toEqual([expect.objectContaining({code: 'timer', blockId: 'timer'})]);
  });

  it.each([
    ['control_for_each', 'VALUE', [4, '1'] as ScratchInput, 'branch-timer'],
    ['control_for_each', 'VALUE', [4, '0'] as ScratchInput, 'after-timer'],
    ['control_repeat_until', 'CONDITION', [10, 'true'] as ScratchInput, 'after-timer'],
    ['control_repeat_until', 'CONDITION', [10, 'false'] as ScratchInput, 'branch-timer'],
    ['control_while', 'CONDITION', [10, 'true'] as ScratchInput, 'branch-timer'],
    ['control_while', 'CONDITION', [10, 'false'] as ScratchInput, 'after-timer'],
    ['control_forever', '', [10, ''] as ScratchInput, 'branch-timer']
  ] as const)('models %s temporal reachability through static control flow', (opcode, inputName, primitive, expectedTimer) => {
    const inputs: Record<string, ScratchInput> = {SUBSTACK: [2, 'branch-store']};
    if (inputName.length > 0) inputs[inputName] = [1, primitive];
    const stage = temporalControlProject(opcode, inputs);
    const certificate = certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.reasons).toContainEqual(expect.objectContaining({code: 'timer', blockId: expectedTimer}));
  });

  it('models dynamic loop paths, wait-until bypass, and all-at-once boundaries', () => {
    const dynamicLoop = temporalControlProject('control_while', {
      CONDITION: [2, 'condition'],
      SUBSTACK: [2, 'branch-store']
    });
    dynamicLoop.blocks['condition'] = reporter('data_variable', 'control', {}, {VARIABLE: ['condition', 'condition']});
    dynamicLoop.variables['condition'] = ['condition', 1];
    const loopCertificate = certifyRegionEffects(project([dynamicLoop]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(loopCertificate.reasons.map(reason => reason.blockId)).toEqual(['after-timer', 'branch-timer']);

    const waitTrue = temporalControlProject('control_wait_until', {CONDITION: [1, [10, 'true']]});
    expect(certifyRegionEffects(project([waitTrue]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').reasons)
      .toContainEqual(expect.objectContaining({blockId: 'after-timer'}));
    const waitFalse = temporalControlProject('control_wait_until', {CONDITION: [1, [10, 'false']]});
    expect(certifyRegionEffects(project([waitFalse]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').eligible).toBe(true);

    const allAtOnce = temporalControlProject('control_all_at_once', {SUBSTACK: [2, 'yield']});
    allAtOnce.blocks['yield'] = block('control_repeat', null, 'control', false, {
      TIMES: [1, [4, '1']],
      SUBSTACK: [2, 'body']
    });
    allAtOnce.blocks['body'] = block('looks_show', null, 'yield');
    expect(certifyRegionEffects(project([allAtOnce]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').eligible).toBe(true);
  });

  it.each([
    ['control_repeat', 'TIMES'],
    ['control_for_each', 'VALUE'],
    ['control_repeat_until', 'CONDITION']
  ] as const)('explores both %s paths when its control value is dynamic', (opcode, inputName) => {
    const stage = temporalControlProject(opcode, {
      [inputName]: [2, 'dynamic-value'],
      SUBSTACK: [2, 'branch-store']
    });
    stage.blocks['dynamic-value'] = reporter('data_variable', 'control', {}, {VARIABLE: ['dynamic', 'dynamic']});
    stage.variables['dynamic'] = ['dynamic', 1];
    const reasons = certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').reasons;
    expect(reasons.map(reason => reason.blockId)).toEqual(['after-timer', 'branch-timer']);
  });

  it('handles dynamic if paths, shared branch memoization, and cyclic continuations deterministically', () => {
    const stage = temporalControlProject('control_if', {
      CONDITION: [2, 'condition'],
      SUBSTACK: [2, 'branch-store']
    });
    stage.blocks['condition'] = reporter('data_variable', 'control', {}, {VARIABLE: ['condition', 'condition']});
    stage.variables['condition'] = ['condition', 1];
    expect(certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').reasons)
      .toContainEqual(expect.objectContaining({blockId: 'branch-timer'}));

    const shared = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'choose', 'hat'),
      choose: block('control_if_else', null, 'safe', false, {
        CONDITION: [2, 'condition'],
        SUBSTACK: [2, 'shared'],
        SUBSTACK2: [2, 'shared']
      }),
      condition: reporter('data_variable', 'choose', {}, {VARIABLE: ['condition', 'condition']}),
      shared: block('looks_show', 'shared', 'choose')
    });
    shared.variables = {condition: ['condition', 0]};
    const first = certifyRegionEffects(project([shared]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    const second = certifyRegionEffects(project([shared]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(first).toEqual(second);
    expect(first.eligible).toBe(true);
  });

  it('covers target menu sentinel and missing-target selector behavior', () => {
    const stage = target(true, 'Stage');
    const sprite = target(false, 'Sprite', {
      mouse: block('motion_goto', null, null, false, {TO: [1, [10, '_mouse_']]}),
      random: block('looks_switchbackdropto', null, null, false, {BACKDROP: [1, [10, 'random backdrop']]}),
      myself: block('control_create_clone_of', null, null, false, {CLONE_OPTION: [1, [10, '_myself_']]}),
      missingClone: block('control_create_clone_of', null, null, false, {CLONE_OPTION: [1, [10, 'Ghost']]}),
      point: block('motion_pointtowards', null, null, false, {TOWARDS: [1, [10, 'Sprite']]}),
      distance: block('sensing_distanceto', null, null, false, {DISTANCETOMENU: [1, [10, 'Sprite']]})
    });
    const value = project([stage, sprite]);
    const effects = certifyRegionEffects(value, {
      targetIndex: 1,
      blockIds: ['mouse', 'random', 'myself', 'missingClone', 'point', 'distance']
    }, 'no-preserve').effects;
    expect(effects.liveInputs.map(site => site.blockId)).toEqual(['distance', 'mouse']);
    expect(effects.randomSources.map(site => site.blockId)).toEqual(['random']);
    expect(effects.ownership).toMatchObject({dynamicTargetRead: true, readTargetIndexes: [1], writeTargetIndexes: [0, 1]});
  });

  it('classifies malformed, shared, and list-index procedure arguments', () => {
    const stage = target(true, 'Stage', {
      malformed: {
        ...procedureCall('p %s', null, null),
        inputs: {a: [1, [10, 'x']]},
        mutation: {proccode: 'p %s', argumentids: 'not-json', warp: 'false'}
      },
      shared: {
        ...procedureCall('p %s %s', null, null),
        inputs: {a: [2, 'reporter'], b: [2, 'reporter']},
        mutation: {proccode: 'p %s %s', argumentids: '["a","b"]', warp: 'false'}
      },
      reporter: reporter('operator_round', 'shared', {NUM: [1, [4, '1']]}),
      indexed: {
        ...procedureCall('p %s', null, null),
        inputs: {a: [2, 'item']},
        mutation: {proccode: 'p %s', argumentids: '["a"]', warp: 'false'}
      },
      item: reporter('data_itemoflist', 'indexed', {INDEX: [1, [10, 'any']]}, {LIST: ['items', 'items']})
    });
    stage.lists = {items: ['items', []]};
    const value = project([stage]);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['malformed']}, 'lossy').effects.argumentEvaluationHazards[0]?.reason)
      .toBe('malformed-arguments');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['shared']}, 'lossy').effects.argumentEvaluationHazards[0]?.reason)
      .toBe('shared-reporter');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['indexed']}, 'lossy').effects.argumentEvaluationHazards[0]?.reason)
      .toBe('observable-reporter');
  });

  it('handles malformed nested-run links and deduplicates a shared branch entry', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'choose', null, true),
      choose: block('control_if_else', 'missing', 'hat', false, {
        CONDITION: [1, [10, 'true']],
        SUBSTACK: [2, 'shared'],
        SUBSTACK2: [2, 'shared']
      }),
      shared: block('looks_show', null, 'choose')
    });
    expect(collectNestedLinearRuns(project([stage]), {minimumLength: Number.NaN})).toEqual([]);
  });

  it('rejects unsafe candidate references without a stage or with hidden fallback ownership', () => {
    const spriteOnly = target(false, 'Sprite', {
      read: reporter('data_variable', 'owner', {}, {VARIABLE: ['missing', 'unknown-id']}),
      owner: block('operator_add', null, null, false, {
        NUM1: [1, [12, 'local', 'local'], [12, 'local', 'local']],
        NUM2: [1, [12, 'missing']]
      })
    });
    spriteOnly.variables = {local: ['local', 0]};
    expect(collectVariableCandidates(project([spriteOnly]))).toEqual([]);
  });

  it('reports unresolved symbols and tolerates absent selector and list-index inputs', () => {
    const stage = target(true, 'Stage', {
      symbol: reporter('data_variable', 'owner', {}, {VARIABLE: ['missing', 'missing-id']}),
      owner: block('operator_round', null, null, false, {NUM: [2, 'symbol']}),
      goto: block('motion_goto'),
      list: block('data_itemoflist', null, null, false, {}, {LIST: ['items', 'items']}),
      nullObject: block('sensing_of', null, null, false, {
        OBJECT: [1, null] as unknown as ScratchInput
      }, {PROPERTY: ['x position', null]})
    });
    stage.lists = {items: ['items', []]};
    const value = project([stage]);
    const symbol = certifyRegionEffects(value, {targetIndex: 0, blockIds: ['owner']}, 'no-preserve');
    expect(symbol.effects.ownership.unresolvedSymbolOwnership).toBe(true);
    expect(symbol.effects.variableReads[0]).toMatchObject({scope: 'unresolved', id: 'missing-id'});
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['goto', 'list', 'nullObject']}, 'no-preserve').effects)
      .toMatchObject({randomSources: []});
  });

  it('rejects a downstream official extension whose temporal effects are opaque', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'safe', null, true),
      safe: block('looks_show', 'extension', 'hat'),
      extension: block('pen_clear', null, 'safe')
    });
    const certificate = certifyRegionEffects(project([stage]), {targetIndex: 0, blockIds: ['safe']}, 'lossy');
    expect(certificate.reasons).toEqual([
      expect.objectContaining({code: 'unsupported-opcode', blockId: 'extension'})
    ]);
  });

  it('deduplicates repeated direct calls to an empty procedure body', () => {
    const stage = target(true, 'Stage', {
      hat: block('event_whenflagclicked', 'first', null, true),
      first: procedureCall('empty', 'second', 'hat'),
      second: procedureCall('empty', null, 'first'),
      definition: procedureDefinition('definition', 'prototype', null),
      prototype: procedurePrototype('empty', 'definition')
    });
    const certificate = certifyRegionEffects(project([stage]), {
      targetIndex: 0,
      blockIds: ['first', 'second']
    }, 'lossy');
    expect(certificate.eligible).toBe(true);
    expect(certificate.effects.procedureCalls).toHaveLength(2);
  });

  it('detects missing, cyclic, and transparent procedure argument reporters', () => {
    const stage = target(true, 'Stage', {
      missingCall: {
        ...procedureCall('p %s', null, null),
        inputs: {a: [2, 'absent']},
        mutation: {proccode: 'p %s', argumentids: '["a"]', warp: 'false'}
      },
      cyclicCall: {
        ...procedureCall('p %s', null, null),
        inputs: {a: [2, 'cycle']},
        mutation: {proccode: 'p %s', argumentids: '["a"]', warp: 'false'}
      },
      cycle: reporter('operator_round', 'cyclicCall', {NUM: [2, 'cycle']}),
      safeCall: {
        ...procedureCall('p %s', null, null),
        inputs: {a: [2, 'sum']},
        mutation: {proccode: 'p %s', argumentids: '["a"]', warp: 'false'}
      },
      sum: reporter('operator_add', 'safeCall', {NUM1: [2, 'rounded'], NUM2: [1, [4, '2']]}),
      rounded: reporter('operator_round', 'sum', {NUM: [1, [4, '1']]})
    });
    const value = project([stage]);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['missingCall']}, 'lossy')
      .effects.argumentEvaluationHazards[0]?.reason).toBe('observable-reporter');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['cyclicCall']}, 'lossy')
      .effects.argumentEvaluationHazards[0]?.reason).toBe('observable-reporter');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['safeCall']}, 'lossy')
      .effects.argumentEvaluationHazards).toEqual([]);
  });

  it('uses typed static numeric and boolean results for temporal control paths', () => {
    const numeric = temporalControlProject('control_repeat', {
      TIMES: [2, 'sum'],
      SUBSTACK: [2, 'branch-store']
    });
    numeric.blocks['sum'] = reporter('operator_add', 'control', {
      NUM1: [1, [4, '0']],
      NUM2: [1, [4, '0']]
    });
    expect(certifyRegionEffects(project([numeric]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').reasons)
      .toContainEqual(expect.objectContaining({blockId: 'after-timer'}));

    const boolean = temporalControlProject('control_if', {
      CONDITION: [2, 'equals'],
      SUBSTACK: [2, 'branch-store']
    });
    boolean.blocks['equals'] = reporter('operator_equals', 'control', {
      OPERAND1: [1, [10, 'a']],
      OPERAND2: [1, [10, 'a']]
    });
    expect(certifyRegionEffects(project([boolean]), {targetIndex: 0, blockIds: ['safe']}, 'lossy').reasons)
      .toContainEqual(expect.objectContaining({blockId: 'branch-timer'}));
  });

  it('fails closed without throwing on broken structural parent links', () => {
    const missingParent = target(true, 'Stage', {
      reporter: reporter('operator_round', 'missing', {NUM: [1, [4, '1']]})
    });
    const unattached = target(true, 'Stage', {
      parent: block('operator_add', null, null, false, {NUM1: [1, [4, '1']]}),
      reporter: reporter('operator_round', 'parent', {NUM: [1, [4, '1']]})
    });
    expect(certifyRegionEffects(project([missingParent]), {targetIndex: 0, blockIds: ['reporter']}, 'lossy').eligible).toBe(true);
    expect(certifyRegionEffects(project([unattached]), {targetIndex: 0, blockIds: ['reporter']}, 'lossy').eligible).toBe(true);
  });

  it('reports malformed region requests and unsupported executable shapes precisely', () => {
    const stage = target(true, 'Stage', {
      primitive: [12, 'value'] as unknown as ScratchBlock,
      unsupported: block('custom_unknown', null, null)
    });
    stage.variables = {value: ['value', 0]};
    const value = project([stage]);

    expect(certifyRegionEffects(value, {targetIndex: 4, blockIds: ['x']}, 'lossy').reasons[0]?.code).toBe('target-missing');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: []}, 'lossy').reasons[0]?.code).toBe('empty-region');
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['absent']}, 'lossy').reasons[0]?.code).toBe('block-missing');
    const primitive = certifyRegionEffects(value, {targetIndex: 0, blockIds: ['primitive']}, 'lossy');
    expect(primitive.reasons.map(reason => reason.code)).toEqual(['block-not-object', 'unsupported-opcode']);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['unsupported']}, 'lossy').reasons[0]?.code)
      .toBe('unsupported-opcode');
  });

  it('classifies greater-than hats, runtime state, and random list indexes', () => {
    const stage = target(true, 'Stage', {
      timerHat: block('event_whengreaterthan', null, null, true, {}, {WHENGREATERTHANMENU: ['timer', null]}),
      loudHat: block('event_whengreaterthan', null, null, true, {}, {WHENGREATERTHANMENU: ['loudness', null]}),
      unknownHat: block('event_whengreaterthan', null, null, true),
      reset: block('sensing_resettimer'),
      counter: reporter('control_get_counter', 'reset'),
      list: block('data_itemoflist', null, null, false, {INDEX: [1, [10, 'random']]}, {LIST: ['items', 'items']})
    });
    stage.lists = {items: ['items', ['a']]};
    const value = project([stage]);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['timerHat']}, 'no-preserve').effects.timers).toHaveLength(1);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['loudHat']}, 'no-preserve').effects.liveInputs).toHaveLength(1);
    const unknown = certifyRegionEffects(value, {targetIndex: 0, blockIds: ['unknownHat']}, 'no-preserve').effects;
    expect([unknown.timers.length, unknown.liveInputs.length]).toEqual([1, 1]);
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['reset', 'counter']}, 'no-preserve').effects)
      .toMatchObject({runtimeStateReads: ['control-counter'], runtimeStateWrites: ['project-timer']});
    expect(certifyRegionEffects(value, {targetIndex: 0, blockIds: ['list']}, 'lossy').reasons.map(reason => reason.code))
      .toContain('random-source');
  });
});

function temporalControlProject(opcode: string, inputs: Record<string, ScratchInput>): ScratchTarget {
  const stage = target(true, 'Stage', {
    hat: block('event_whenflagclicked', 'safe', null, true),
    safe: block('looks_show', 'control', 'hat'),
    control: block(opcode, 'after-store', 'safe', false, inputs, {VARIABLE: ['loop', 'loop']}),
    'branch-store': block('data_setvariableto', null, 'control', false, {VALUE: [2, 'branch-timer']}, {VARIABLE: ['value', 'value']}),
    'branch-timer': reporter('sensing_timer', 'branch-store'),
    'after-store': block('data_setvariableto', null, 'control', false, {VALUE: [2, 'after-timer']}, {VARIABLE: ['value', 'value']}),
    'after-timer': reporter('sensing_timer', 'after-store')
  });
  stage.variables = {loop: ['loop', 0], value: ['value', 0]};
  return stage;
}

function project(targets: ScratchTarget[]): ScratchProject {
  return {targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}};
}

function target(isStage: boolean, name: string, blocks: ScratchTarget['blocks'] = {}): ScratchTarget {
  return {
    isStage,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks,
    comments: {},
    currentCostume: 0,
    costumes: [],
    sounds: []
  };
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

function reporter(
  opcode: string,
  parent: string,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, ScratchInput> = {}
): ScratchBlock {
  return block(opcode, null, parent, false, inputs, fields);
}

function procedureDefinition(id: string, prototypeId: string, next: string | null): ScratchBlock {
  return block('procedures_definition', next, null, true, {custom_block: [1, prototypeId]}, {ID: [id, null]});
}

function procedurePrototype(
  proccode: string,
  parent: string,
  overrides: Record<string, JsonValue> = {}
): ScratchBlock {
  return {
    ...block('procedures_prototype', null, parent),
    shadow: true,
    mutation: {
      proccode,
      argumentids: '[]',
      argumentnames: '[]',
      argumentdefaults: '[]',
      warp: 'false',
      ...overrides
    }
  };
}

function procedureCall(proccode: string | undefined, next: string | null, parent: string | null): ScratchBlock {
  return {
    ...block('procedures_call', next, parent),
    ...(proccode === undefined ? {} : {mutation: {proccode, argumentids: '[]', warp: 'false'}})
  };
}
