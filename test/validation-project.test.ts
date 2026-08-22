import {describe, expect, it} from 'vitest';
import {InputError} from '../src/errors.js';
import {countBlockEquivalents, isPrimitive, isScratchBlock, opcodePrefix, stageOf} from '../src/model/blocks.js';
import {assertJsonTree, cloneProject, hasOwn, isRecord, orderedDictionary} from '../src/model/json.js';
import type {ScratchInput, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';

function minimalProject(): ScratchProject {
  return {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {variable: ['value', 0]},
      lists: {},
      broadcasts: {},
      blocks: {},
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

function fixtureTarget(project: ScratchProject): ScratchProject['targets'][number] {
  const target = project.targets[0];
  if (!target) throw new Error('fixture is missing Stage');
  return target;
}

function raw(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function expectInvalid(mutator: (project: ScratchProject, target: ScratchProject['targets'][number]) => void, pattern?: RegExp): void {
  const project = minimalProject();
  mutator(project, fixtureTarget(project));
  expect(() => validateProject(project)).toThrow(pattern ?? InputError);
}

function plainBlock(opcode = 'looks_show'): Record<string, unknown> {
  return {opcode, next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
}

describe('JSON and ordered model helpers', () => {
  it('recognizes records, blocks, primitives, prefixes, and Stage', () => {
    const project = minimalProject();
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isScratchBlock(plainBlock())).toBe(true);
    expect(isScratchBlock({})).toBe(false);
    expect(isPrimitive([4, 1])).toBe(true);
    expect(isPrimitive([3, 1])).toBe(false);
    expect(isPrimitive(['4', 1])).toBe(false);
    expect(opcodePrefix('looks_show')).toBe('looks');
    expect(opcodePrefix('invalid')).toBe('');
    expect(stageOf(project).name).toBe('Stage');
    expect(() => stageOf({...project, targets: []})).toThrow(/no Stage/);
  });

  it('checks the full JSON value domain and rejects non-JSON objects', () => {
    const dictionary = orderedDictionary<unknown>();
    dictionary['value'] = [null, true, 'text', 3, {nested: false}];
    expect(() => assertJsonTree(dictionary)).not.toThrow();
    expect(Object.getPrototypeOf(dictionary)).toBeNull();
    expect(hasOwn(dictionary, 'value')).toBe(true);
    expect(hasOwn(dictionary, 'toString')).toBe(false);
    expect(() => assertJsonTree(Number.NaN)).toThrow(/non-finite/);
    expect(() => assertJsonTree(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => assertJsonTree(undefined)).toThrow(/non-JSON value/);
    expect(() => assertJsonTree(new Date())).toThrow(/non-JSON object/);
    expect(() => assertJsonTree({[Symbol('hidden')]: 1})).toThrow(/non-JSON object/);
  });

  it('clones projects and counts inline and top-level block equivalents', () => {
    const project = minimalProject();
    const target = fixtureTarget(project);
    target.blocks = {
      reporter: [12, 'value', 'variable'],
      block: {opcode: 'operator_add', next: null, parent: null, inputs: {NUM1: [1, [4, 1]], NUM2: [3, [10, 'x'], [10, 'y']]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0}
    };
    expect(countBlockEquivalents(project)).toBe(5);
    const cloned = cloneProject(project);
    expect(cloned).toEqual(project);
    expect(cloned).not.toBe(project);
  });
});

describe('project validation', () => {
  it('accepts a minimal official Scratch 3 project', () => {
    expect(() => validateProject(minimalProject())).not.toThrow();
  });

  it('enforces official schema constraints before stricter graph checks', () => {
    expectInvalid((_project, target) => {
      const costume = target.costumes[0];
      if (!costume) throw new Error('fixture costume missing');
      costume['assetId'] = 'short';
    }, /official Scratch 3 schema/);
    expectInvalid((_project, target) => {
      const costume = target.costumes[0];
      if (!costume) throw new Error('fixture costume missing');
      costume['dataFormat'] = 'exe';
    }, /official Scratch 3 schema/);
    expectInvalid(project => { project.meta['vm'] = 'not-a-version'; }, /official Scratch 3 schema/);
  });

  it('rejects unsupported and undeclared extensions', () => {
    const unsupported = minimalProject();
    unsupported.extensions = ['https://example.invalid/extension.js'];
    expect(() => validateProject(unsupported)).toThrowError(InputError);

    const undeclared = minimalProject();
    const target = undeclared.targets[0];
    if (!target) throw new Error('fixture is missing Stage');
    target.blocks['pen'] = {opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
    expect(() => validateProject(undeclared)).toThrow(/undeclared extension/);

    undeclared.extensions = ['pen'];
    expect(() => validateProject(undeclared)).not.toThrow();
  });

  it('rejects dangling graph and symbol references', () => {
    const graph = minimalProject();
    const graphTarget = graph.targets[0];
    if (!graphTarget) throw new Error('fixture is missing Stage');
    graphTarget.blocks['bad'] = {opcode: 'looks_say', next: 'missing', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0};
    expect(() => validateProject(graph)).toThrow(/dangling block reference/);

    const symbol = minimalProject();
    const symbolTarget = symbol.targets[0];
    if (!symbolTarget) throw new Error('fixture is missing Stage');
    symbolTarget.blocks['bad'] = {opcode: 'data_variable', next: null, parent: null, inputs: {}, fields: {VARIABLE: ['gone', 'missing']}, shadow: false, topLevel: true, x: 0, y: 0};
    expect(() => validateProject(symbol)).toThrow(/dangling variable reference/);
  });

  it('rejects executable cycles', () => {
    const project = minimalProject();
    const target = project.targets[0];
    if (!target) throw new Error('fixture is missing Stage');
    target.blocks = {
      first: {opcode: 'looks_show', next: 'second', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0},
      second: {opcode: 'looks_hide', next: 'first', parent: 'first', inputs: {}, fields: {}, shadow: false, topLevel: false}
    };
    expect(() => validateProject(project)).toThrow(/contains a cycle/);
  });

  it('rejects cyclic or non-JSON public API input without overflowing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => validateProject(cyclic)).toThrow(/contains a cycle/);
    expect(() => validateProject({meta: {semver: '3.0.0'}, targets: [], bad: 1n})).toThrow(/non-JSON/);
  });

  it.each(['__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects loader-unsafe prototype-colliding symbol ID %s',
    id => {
      const project = minimalProject();
      const target = project.targets[0];
      if (!target) throw new Error('fixture is missing Stage');
      const variables = Object.create(null) as Record<string, [string, number]>;
      variables[id] = ['unsafe', 0];
      target.variables = variables;
      expect(() => validateProject(project)).toThrow(/collides with the Scratch loader's object prototype/u);
    }
  );

  it.each(['a&b', 'a<b', 'a>b', "a'b", 'a"b'])(
    'rejects symbol ID %s which the Scratch loader would rewrite',
    id => {
      const project = minimalProject();
      const target = project.targets[0];
      if (!target) throw new Error('fixture is missing Stage');
      target.variables[id] = ['unsafe', 0];
      expect(() => validateProject(project)).toThrow(/contains characters rewritten by the Scratch loader/u);
    }
  );

  it('rejects malformed root metadata and collection shapes', () => {
    const cases: unknown[] = [
      null,
      [],
      {},
      {meta: null},
      {meta: {semver: 3}},
      {meta: {semver: '2.0.0'}, targets: [], monitors: [], extensions: []},
      {meta: {semver: '3.0.0'}, targets: null, monitors: [], extensions: []},
      {meta: {semver: '3.0.0'}, targets: [], monitors: [], extensions: []},
      {meta: {semver: '3.0.0'}, targets: [{}], monitors: {}, extensions: []},
      {meta: {semver: '3.0.0'}, targets: [{}], monitors: [], extensions: {}},
      {meta: {semver: '3.0.0'}, targets: [{}], monitors: [], extensions: [3]}
    ];
    for (const value of cases) expect(() => validateProject(value)).toThrow(InputError);
  });

  it('rejects malformed target property shapes', () => {
    const cases: Array<(project: ScratchProject, target: ScratchProject['targets'][number]) => void> = [
      (_project, target) => { raw(target)['isStage'] = 'true'; },
      (_project, target) => { raw(target)['name'] = 4; },
      (_project, target) => { raw(target)['variables'] = []; },
      (_project, target) => { raw(target)['lists'] = []; },
      (_project, target) => { raw(target)['broadcasts'] = []; },
      (_project, target) => { raw(target)['blocks'] = []; },
      (_project, target) => { raw(target)['comments'] = []; },
      (_project, target) => { raw(target)['currentCostume'] = '0'; },
      (_project, target) => { target.currentCostume = 0.5; },
      (_project, target) => { raw(target)['costumes'] = null; },
      (_project, target) => { target.costumes = []; },
      (_project, target) => { raw(target)['sounds'] = null; },
      (_project, target) => { target.currentCostume = 1; },
      (_project, target) => { target.costumes = [null as unknown as Record<string, never>]; },
      (_project, target) => { target.costumes = [{assetId: 3, dataFormat: 'svg', name: 'x'}]; },
      (_project, target) => { target.sounds = [null as unknown as Record<string, never>]; },
      (_project, target) => { target.sounds = [{assetId: 'x', dataFormat: false, name: 'x'}]; }
    ];
    for (const mutate of cases) expectInvalid(mutate);
  });

  it('rejects every malformed declaration tuple form', () => {
    const variableCases: unknown[] = [[], ['name'], ['name', 0, true, 4], [3, 0], ['name', null], ['name', 0, false]];
    for (const tuple of variableCases) expectInvalid((_project, target) => { raw(target.variables)['bad'] = tuple; }, /invalid variable/);
    expectInvalid((_project, target) => { raw(target.variables)[''] = ['name', 0]; }, /invalid variable/);

    const listCases: unknown[] = [[], ['name'], ['name', [], 3], [3, []], ['name', null], ['name', [null]]];
    for (const tuple of listCases) expectInvalid((_project, target) => { raw(target.lists)['bad'] = tuple; }, /invalid list/);
    expectInvalid((_project, target) => { raw(target.lists)[''] = ['name', []]; }, /invalid list/);
    expectInvalid((_project, target) => { raw(target.broadcasts)['bad'] = 4; }, /invalid broadcast/);
    expectInvalid((_project, target) => { raw(target.broadcasts)[''] = 'name'; }, /invalid broadcast/);
  });

  it('rejects invalid target ordering and duplicate names', () => {
    expectInvalid((_project, target) => { target.isStage = false; }, /first target must be Stage/);
    expectInvalid((_project, target) => { target.name = 'Not Stage'; }, /first target must be Stage/);
    expectInvalid((project, target) => {
      project.targets.push({...structuredClone(target), isStage: true});
    }, /only the first target/);
    expectInvalid((project, target) => {
      project.targets.push({...structuredClone(target), isStage: false});
    }, /duplicate target name/);
  });

  it('validates primitive codes, payloads, symbols, and coordinates', () => {
    const invalidPrimitives: unknown[] = [
      {}, [3, 0], ['4', 0], [14, 0], [4], [4, true], [9], [9, '#xyzxyz'], [10], [10, false],
      [11, 'name'], [11, 3, 'missing'], [11, 'name', ''], [11, 'name', 'missing'],
      [12, 'name', 'variable', 1], [12, 'value', null], [13, 'list', null], [13, 'name', 'missing'], [12, 'value', 'variable', 'x', 0]
    ];
    for (const primitive of invalidPrimitives) {
      expectInvalid((_project, target) => { raw(target.blocks)['primitive'] = primitive; });
    }
    const valid = minimalProject();
    const target = fixtureTarget(valid);
    target.lists['list'] = ['list', []];
    target.broadcasts['broadcast'] = 'message';
    target.blocks = {
      variable: [12, 'value', 'variable', 1, 2],
      list: [13, 'list', 'list', 3, 4],
      broadcastUser: {opcode: 'event_broadcast', next: null, parent: null, inputs: {BROADCAST_INPUT: [1, [11, 'message', null]]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0}
    };
    expect(() => validateProject(valid)).not.toThrow();
  });

  it('rejects object primitives whose payload would crash or disappear during official serialization', () => {
    expectInvalid((_project, target) => {
      raw(target.blocks)['number'] = {...plainBlock('math_number'), fields: {VARIABLE: ['value', 'variable']}};
    }, /must contain only its NUM field/);
    expectInvalid((_project, target) => {
      raw(target.blocks)['text'] = {
        ...plainBlock('text'),
        fields: {TEXT: ['value']},
        inputs: {ignored: [1, [10, 'lost']]}
      };
    }, /discarded by the Scratch primitive serializer/);
    expectInvalid((_project, target) => {
      raw(target.blocks)['number'] = {...plainBlock('math_number'), fields: {NUM: [true]}};
    }, /require one string or number/);
    expectInvalid((_project, target) => {
      raw(target.blocks)['text'] = {...plainBlock('text'), fields: {TEXT: ['value', 'discarded']}};
    }, /require one string or number/);
    expectInvalid((_project, target) => {
      raw(target.blocks)['color'] = {...plainBlock('colour_picker'), fields: {COLOUR: ['red']}};
    }, /require one #RRGGBB string/);
    expectInvalid((_project, target) => {
      raw(target.blocks)['variable'] = {...plainBlock('data_variable'), fields: {VARIABLE: [true, 'variable']}};
    }, /require a string name/);
    const valid = minimalProject();
    const target = fixtureTarget(valid);
    target.blocks['variable'] = {
      opcode: 'data_variable',
      next: null,
      parent: null,
      inputs: {},
      fields: {VARIABLE: ['value', 'variable']},
      shadow: false,
      topLevel: true,
      x: 1,
      y: 2
    };
    expect(() => validateProject(valid)).not.toThrow();
  });

  it('validates input tuple shapes and referenced children', () => {
    const invalidInputs: unknown[] = [null, [], [1], [0, null], [3, null], [1, {}], [1, 'missing']];
    for (const input of invalidInputs) {
      expectInvalid((_project, target) => {
        raw(target.blocks)['block'] = {...plainBlock(), inputs: {VALUE: input}};
      });
    }
    const valid = minimalProject();
    const target = fixtureTarget(valid);
    target.blocks = {
      parent: {opcode: 'looks_say', next: null, parent: null, inputs: {MESSAGE: [2, 'child'], UNUSED: [2, null]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0},
      child: {opcode: 'operator_join', next: null, parent: 'parent', inputs: {STRING1: [1, [10, 'a']], STRING2: [1, [10, 2]]}, fields: {}, shadow: false, topLevel: false}
    };
    expect(() => validateProject(valid)).not.toThrow();
  });

  it('rejects broadcast input shapes that the runtime would treat as malformed shadows', () => {
    const projectFor = (input: ScratchInput | undefined): ScratchProject => {
      const project = minimalProject();
      const stage = fixtureTarget(project);
      stage.broadcasts['message'] = 'go';
      stage.blocks['broadcast'] = {
        ...plainBlock('event_broadcast'),
        inputs: input === undefined ? {} : {BROADCAST_INPUT: input}
      } as unknown as ScratchProject['targets'][number]['blocks'][string];
      return project;
    };

    expect(() => validateProject(projectFor(undefined))).toThrow(/requires a broadcast input/);
    expect(() => validateProject(projectFor([1, [10, 'go']]))).toThrow(/must be a broadcast menu/);
    expect(() => validateProject(projectFor([2, null]))).toThrow(/executable active reporter/);
    expect(() => validateProject(projectFor([3, [12, 'value', 'variable'], [10, 'go']]))).toThrow(/retain a broadcast menu shadow/);
    expect(() => validateProject(projectFor([2, [12, 'value', 'variable']]))).not.toThrow();
    expect(() => validateProject(projectFor([3, [12, 'value', 'variable'], [11, 'go', 'message']]))).not.toThrow();

    const referencedMenu = projectFor([1, 'menu']);
    fixtureTarget(referencedMenu).blocks['menu'] = {
      opcode: 'event_broadcast_menu',
      next: null,
      parent: 'broadcast',
      inputs: {},
      fields: {BROADCAST_OPTION: ['go', 'message']},
      shadow: true,
      topLevel: false
    };
    expect(() => validateProject(referencedMenu)).not.toThrow();
  });

  it('permits only recoverable inactive shadow ownership artifacts when requested', () => {
    const project = minimalProject();
    const target = fixtureTarget(project);
    target.blocks = {
      parent: {
        opcode: 'looks_say', next: null, parent: null,
        inputs: {MESSAGE: [3, 'active', 'fallback']}, fields: {},
        shadow: false, topLevel: true, x: 0, y: 0
      },
      active: {
        opcode: 'operator_join', next: null, parent: 'parent',
        inputs: {STRING1: [1, [10, 'a']], STRING2: [1, [10, 'b']]}, fields: {},
        shadow: false, topLevel: false
      },
      fallback: {
        opcode: 'text', next: null, parent: null, inputs: {}, fields: {TEXT: ['hidden']},
        shadow: true, topLevel: false
      }
    };

    expect(() => validateProject(project)).toThrow(/non-top-level block must have an owning parent/);
    expect(() => validateProject(project, {allowRecoverableInactiveShadowOwnership: true})).not.toThrow();

    const topLevelShadow = structuredClone(project);
    const repairedByLoader = fixtureTarget(topLevelShadow).blocks['fallback'];
    if (!isScratchBlock(repairedByLoader)) throw new Error('fixture fallback missing');
    repairedByLoader.topLevel = true;
    repairedByLoader.x = 0;
    repairedByLoader.y = 0;
    expect(() => validateProject(topLevelShadow)).toThrow(/top-level block must not have an incoming block edge/);
    expect(() => validateProject(topLevelShadow, {allowRecoverableInactiveShadowOwnership: true})).not.toThrow();

    const executableShadow = structuredClone(project);
    const executableHat = fixtureTarget(executableShadow).blocks['fallback'];
    if (!isScratchBlock(executableHat)) throw new Error('fixture fallback missing');
    executableHat.opcode = 'event_whenflagclicked';
    executableHat.next = 'hatBody';
    executableHat.inputs = {};
    executableHat.fields = {};
    executableHat.topLevel = true;
    executableHat.x = 0;
    executableHat.y = 0;
    fixtureTarget(executableShadow).blocks['hatBody'] = {
      opcode: 'looks_say', next: null, parent: 'fallback',
      inputs: {MESSAGE: [1, [10, 'live']]}, fields: {},
      shadow: false, topLevel: false
    };
    expect(() => validateProject(executableShadow, {allowRecoverableInactiveShadowOwnership: true}))
      .toThrow(/top-level block must not have an incoming block edge/);

    const activeFallback = structuredClone(project);
    const activeParent = fixtureTarget(activeFallback).blocks['parent'];
    if (!isScratchBlock(activeParent)) throw new Error('fixture parent missing');
    activeParent.inputs['MESSAGE'] = [3, null, 'fallback'];
    delete fixtureTarget(activeFallback).blocks['active'];
    expect(() => validateProject(activeFallback, {allowRecoverableInactiveShadowOwnership: true}))
      .toThrow(/non-top-level block must have an owning parent/);

    const nonShadow = structuredClone(project);
    const nonShadowBlock = fixtureTarget(nonShadow).blocks['fallback'];
    if (!isScratchBlock(nonShadowBlock)) throw new Error('fixture fallback missing');
    nonShadowBlock.shadow = false;
    expect(() => validateProject(nonShadow, {allowRecoverableInactiveShadowOwnership: true}))
      .toThrow(/non-top-level block must have an owning parent/);

    const multiplyOwned = structuredClone(project);
    const sharedFallback = fixtureTarget(multiplyOwned).blocks['fallback'];
    if (!isScratchBlock(sharedFallback)) throw new Error('fixture fallback missing');
    sharedFallback.parent = 'parent';
    fixtureTarget(multiplyOwned).blocks['secondParent'] = {
      opcode: 'looks_say', next: null, parent: null,
      inputs: {MESSAGE: [3, [10, 'active'], 'fallback']}, fields: {},
      shadow: false, topLevel: true, x: 10, y: 10
    };
    expect(() => validateProject(multiplyOwned, {allowRecoverableInactiveShadowOwnership: true}))
      .toThrow(/multiple owners/);
  });

  it('validates block fields and all typed symbol scopes', () => {
    const invalidFields: unknown[] = [null, [], ['a', null, 'extra'], [null], ['a', 4]];
    for (const field of invalidFields) {
      expectInvalid((_project, target) => { raw(target.blocks)['block'] = {...plainBlock(), fields: {VALUE: field}}; });
    }
    for (const [name, field] of [
      ['VARIABLE', ['x', 'missing']], ['LIST', ['x', 'missing']], ['BROADCAST_OPTION', ['x', 'missing']]
    ] as const) {
      expectInvalid((_project, target) => { raw(target.blocks)['block'] = {...plainBlock(), fields: {[name]: field}}; }, /dangling/);
    }

    const project = minimalProject();
    const stage = fixtureTarget(project);
    stage.lists['globalList'] = ['global list', []];
    stage.broadcasts['globalBroadcast'] = 'global broadcast';
    const sprite = structuredClone(stage);
    sprite.isStage = false;
    sprite.name = 'Sprite';
    sprite.variables = {local: ['local', 0]};
    sprite.lists = {localList: ['local list', []]};
    sprite.broadcasts = {localBroadcast: 'local broadcast'};
    sprite.blocks = {
      localVar: {...plainBlock('data_variable'), fields: {VARIABLE: ['local', 'local']}},
      globalVar: {...plainBlock('data_variable'), fields: {VARIABLE: ['value', 'variable']}},
      localList: {...plainBlock('data_listcontents'), fields: {LIST: ['local list', 'localList']}},
      globalList: {...plainBlock('data_listcontents'), fields: {LIST: ['global list', 'globalList']}},
      globalBroadcast: {...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['global broadcast', 'globalBroadcast']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    project.targets.push(sprite);
    expect(() => validateProject(project)).not.toThrow();

    const broadcastCaseMismatch = structuredClone(project);
    const caseMismatchSprite = broadcastCaseMismatch.targets[1];
    if (!caseMismatchSprite) throw new Error('fixture Sprite missing');
    caseMismatchSprite.blocks = {
      invalid: {...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['go']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    expect(() => validateProject(broadcastCaseMismatch)).toThrow(/dangling name-only broadcast/);
  });

  it('resolves name-only fields and broadcasts through Stage as the runtime does', () => {
    const project = minimalProject();
    const stage = fixtureTarget(project);
    stage.variables['sameGlobal'] = ['same', 1];
    stage.lists['globalList'] = ['global list', []];
    stage.broadcasts['stageMessage'] = 'Go';
    const sprite = structuredClone(stage);
    sprite.isStage = false;
    sprite.name = 'Sprite';
    sprite.variables = {local: ['same', 2]};
    sprite.lists = {};
    sprite.broadcasts = {spriteMessage: 'go'};
    sprite.blocks = {
      localVariable: {...plainBlock('data_variable'), fields: {VARIABLE: ['same', null]}},
      globalList: {...plainBlock('data_listcontents'), fields: {LIST: ['global list']}},
      stageBroadcast: {...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['Go', '']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    project.targets.push(sprite);
    expect(() => validateProject(project)).not.toThrow();

    const localOnly = structuredClone(project);
    const localOnlySprite = localOnly.targets[1];
    if (!localOnlySprite) throw new Error('fixture Sprite missing');
    localOnlySprite.variables['localOnly'] = ['local only', 3];
    localOnlySprite.blocks = {
      invalid: {...plainBlock('data_variable'), fields: {VARIABLE: ['local only']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    expect(() => validateProject(localOnly)).toThrow(/dangling name-only variable/);

    const localBroadcast = structuredClone(project);
    const localSprite = localBroadcast.targets[1];
    if (!localSprite) throw new Error('fixture Sprite missing');
    localSprite.blocks = {
      invalid: {...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['go', 'spriteMessage']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    expect(() => validateProject(localBroadcast)).toThrow(/dangling broadcast reference/);

    const localPrimitive = structuredClone(project);
    const primitiveSprite = localPrimitive.targets[1];
    if (!primitiveSprite) throw new Error('fixture Sprite missing');
    primitiveSprite.blocks = {
      invalid: {...plainBlock('event_broadcast'), inputs: {BROADCAST_INPUT: [1, [11, 'go', 'spriteMessage']]}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    expect(() => validateProject(localPrimitive)).toThrow(/dangling broadcast reference/);
  });

  it('rejects missing name-only references and accepts deterministic first-name matches', () => {
    for (const [kind, fieldName] of [['variable', 'VARIABLE'], ['list', 'LIST']] as const) {
      const missing = minimalProject();
      fixtureTarget(missing).blocks['missing'] = {
        ...plainBlock(kind === 'variable' ? 'data_variable' : 'data_listcontents'), fields: {[fieldName]: ['absent', null]}
      } as unknown as ScratchProject['targets'][number]['blocks'][string];
      expect(() => validateProject(missing)).toThrow(new RegExp(`dangling name-only ${kind}`));

      const ambiguous = minimalProject();
      const target = fixtureTarget(ambiguous);
      if (kind === 'variable') {
        target.variables = {first: ['duplicate', 0], second: ['duplicate', 1]};
      } else {
        target.lists = {first: ['duplicate', []], second: ['duplicate', []]};
      }
      target.blocks['ambiguous'] = {
        ...plainBlock(kind === 'variable' ? 'data_variable' : 'data_listcontents'), fields: {[fieldName]: ['duplicate']}
      } as unknown as ScratchProject['targets'][number]['blocks'][string];
      expect(() => validateProject(ambiguous)).not.toThrow();
    }

    const broadcasts = minimalProject();
    const stage = fixtureTarget(broadcasts);
    stage.broadcasts = {first: 'Message', second: 'Message'};
    stage.blocks['ambiguous'] = {
      ...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['Message', null]}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(broadcasts)).not.toThrow();
  });

  it('matches null broadcast primitives to exact Stage broadcasts', () => {
    const exact = minimalProject();
    const exactStage = fixtureTarget(exact);
    exactStage.broadcasts['message'] = 'Go';
    exactStage.blocks['broadcast'] = {
      ...plainBlock('event_broadcast'),
      inputs: {BROADCAST_INPUT: [1, [11, 'Go', null]]}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(exact)).not.toThrow();

    const caseMismatch = structuredClone(exact);
    const mismatchedBroadcast = fixtureTarget(caseMismatch).blocks['broadcast'];
    if (!isScratchBlock(mismatchedBroadcast)) throw new Error('fixture broadcast missing');
    mismatchedBroadcast.inputs['BROADCAST_INPUT'] = [1, [11, 'go', null]];
    expect(() => validateProject(caseMismatch)).toThrow(/dangling name-only broadcast reference "go"/);

    const wrongType = minimalProject();
    fixtureTarget(wrongType).blocks['broadcast'] = {
      ...plainBlock('event_broadcast'),
      inputs: {BROADCAST_INPUT: [1, [11, 'value', null]]}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(wrongType)).toThrow(/dangling name-only broadcast reference "value"/);
  });

  it('enforces one homogeneous implicit-reference group per effective loader ID', () => {
    const fieldFor = (name: string, id: undefined | null | ''): Array<string | null> => (
      id === undefined ? [name] : [name, id]
    );

    for (const id of [undefined, null, ''] as const) {
      const homogeneous = minimalProject();
      const homogeneousStage = fixtureTarget(homogeneous);
      homogeneousStage.blocks = {
        first: {...plainBlock('data_variable'), fields: {VARIABLE: fieldFor('value', id)}},
        second: {...plainBlock('data_variable'), fields: {VARIABLE: fieldFor('value', id)}}
      } as unknown as ScratchProject['targets'][number]['blocks'];
      expect(() => validateProject(homogeneous)).not.toThrow();

      const divergent = minimalProject();
      const divergentStage = fixtureTarget(divergent);
      divergentStage.variables['other'] = ['other', 1];
      divergentStage.blocks = {
        first: {...plainBlock('data_variable'), fields: {VARIABLE: fieldFor('value', id)}},
        second: {...plainBlock('data_variable'), fields: {VARIABLE: fieldFor('other', id)}}
      } as unknown as ScratchProject['targets'][number]['blocks'];
      expect(() => validateProject(divergent)).toThrow(/would coalesce with a distinct reference/);

      const mixed = minimalProject();
      const mixedStage = fixtureTarget(mixed);
      mixedStage.lists['items'] = ['items', []];
      mixedStage.blocks = {
        variable: {...plainBlock('data_variable'), fields: {VARIABLE: fieldFor('value', id)}},
        list: {...plainBlock('data_listcontents'), fields: {LIST: fieldFor('items', id)}}
      } as unknown as ScratchProject['targets'][number]['blocks'];
      expect(() => validateProject(mixed)).toThrow(/would coalesce with a distinct reference/);
    }
  });

  it('rejects blocks with competing typed symbol fields', () => {
    const project = minimalProject();
    const stage = fixtureTarget(project);
    stage.lists['items'] = ['items', []];
    stage.blocks['ambiguous'] = {
      ...plainBlock('data_variable'),
      fields: {
        VARIABLE: ['value', 'variable'],
        LIST: ['items', 'items']
      }
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(project)).toThrow(/multiple typed symbol fields have loader-dependent precedence/);
  });

  it('rejects duplicate symbol IDs within runtime-visible scopes before VM loading can rebind them', () => {
    const sameTarget = minimalProject();
    fixtureTarget(sameTarget).lists['variable'] = ['colliding list', []];
    expect(() => validateProject(sameTarget)).toThrow(/duplicate project-wide symbol ID "variable"/);
    expect(() => validateProject(sameTarget, {allowRecoverableLocalSymbolIdCollisions: true}))
      .toThrow(/duplicate project-wide symbol ID "variable"/);

    for (const declaration of ['variable', 'list', 'broadcast'] as const) {
      const project = minimalProject();
      const stage = fixtureTarget(project);
      const sprite = structuredClone(stage);
      sprite.isStage = false;
      sprite.name = `Sprite ${declaration}`;
      sprite.variables = declaration === 'variable' ? {variable: ['local', 0]} : {};
      sprite.lists = declaration === 'list' ? {variable: ['local', []]} : {};
      sprite.broadcasts = declaration === 'broadcast' ? {variable: 'local'} : {};
      sprite.blocks = {};
      project.targets.push(sprite);
      expect(() => validateProject(project)).toThrow(/duplicate project-wide symbol ID "variable"/);
      expect(() => validateProject(project, {allowRecoverableLocalSymbolIdCollisions: true}))
        .toThrow(/duplicate project-wide symbol ID "variable"/);
    }
  });

  it('accepts recoverable duplicate symbol IDs in separate sprite-local scopes only when requested', () => {
    const project = minimalProject();
    const makeSprite = (name: string, value: number): ScratchProject['targets'][number] => ({
      ...structuredClone(fixtureTarget(project)),
      isStage: false,
      name,
      variables: {shared_local_id: [`${name} value`, value]},
      lists: {},
      broadcasts: {},
      blocks: {
        reporter: {
          ...plainBlock('data_variable'),
          fields: {VARIABLE: [`${name} value`, 'shared_local_id']}
        } as unknown as ScratchProject['targets'][number]['blocks'][string]
      },
      comments: {}
    });
    project.targets.push(makeSprite('First sprite', 1), makeSprite('Second sprite', 2));

    expect(() => validateProject(project)).toThrow(/duplicate project-wide symbol ID "shared_local_id"/);
    expect(() => validateProject(project, {allowRecoverableLocalSymbolIdCollisions: true})).not.toThrow();

    const monitored = structuredClone(project);
    monitored.monitors = [
      {
        opcode: 'data_variable', id: 'shared_local_id', params: {VARIABLE: 'First sprite value'},
        spriteName: 'First sprite', value: 1, visible: true
      },
      {
        opcode: 'data_variable', id: 'shared_local_id', params: {VARIABLE: 'Second sprite value'},
        spriteName: 'Second sprite', value: 2, visible: true
      }
    ];
    expect(() => validateProject(monitored, {allowRecoverableLocalSymbolIdCollisions: true}))
      .toThrow(/data monitors for multiple owners and cannot be safely disambiguated/);

    const sameOwner = structuredClone(project);
    sameOwner.monitors = [
      {
        opcode: 'data_variable', id: 'shared_local_id', params: {VARIABLE: 'First sprite value'},
        spriteName: 'First sprite', value: 1, visible: true
      },
      {
        opcode: 'data_variable', id: 'shared_local_id', params: {VARIABLE: 'First sprite value'},
        spriteName: 'First sprite', value: 1, visible: false
      }
    ];
    const firstOwner = sameOwner.targets[1];
    if (!firstOwner) throw new Error('fixture sprite missing');
    firstOwner.blocks['show'] = {
      ...plainBlock('data_showvariable'),
      fields: {VARIABLE: ['First sprite value', 'shared_local_id']}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(sameOwner, {allowRecoverableLocalSymbolIdCollisions: true})).not.toThrow();

    const crossOwner = structuredClone(sameOwner);
    const secondOwner = crossOwner.targets[2];
    if (!secondOwner) throw new Error('fixture sprite missing');
    secondOwner.blocks['show'] = {
      ...plainBlock('data_showvariable'),
      fields: {VARIABLE: ['Second sprite value', 'shared_local_id']}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(crossOwner, {allowRecoverableLocalSymbolIdCollisions: true}))
      .toThrow(/monitor visibility references for multiple owners and cannot be safely disambiguated/);

    const crossOwnerMutators = structuredClone(project);
    const firstMutatorOwner = crossOwnerMutators.targets[1];
    const secondMutatorOwner = crossOwnerMutators.targets[2];
    if (!firstMutatorOwner || !secondMutatorOwner) throw new Error('fixture sprites missing');
    firstMutatorOwner.blocks['show'] = {
      ...plainBlock('data_showvariable'),
      fields: {VARIABLE: ['First sprite value', 'shared_local_id']}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    secondMutatorOwner.blocks['hide'] = {
      ...plainBlock('data_hidevariable'),
      fields: {VARIABLE: ['Second sprite value', 'shared_local_id']}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(crossOwnerMutators, {allowRecoverableLocalSymbolIdCollisions: true}))
      .toThrow(/monitor visibility references for multiple owners and cannot be safely disambiguated/);
  });

  it('rejects effective-ID collisions without rejecting independently resolved name-only fields', () => {
    for (const [effectiveId, field] of [
      ['undefined', ['value']],
      ['null', ['value', null]]
    ] as const) {
      const sentinel = minimalProject();
      const sentinelTarget = fixtureTarget(sentinel);
      sentinelTarget.variables[effectiveId] = ['sentinel', 0];
      for (const [opcode, fieldName] of [
        ['data_showvariable', 'VARIABLE'],
        ['event_whenbroadcastreceived', 'BROADCAST_OPTION']
      ] as const) {
        sentinelTarget.blocks['nameOnly'] = {
          ...plainBlock(opcode), fields: {[fieldName]: [...field]}
        } as unknown as ScratchProject['targets'][number]['blocks'][string];
        expect(() => validateProject(sentinel)).toThrow(
          new RegExp(`implicit symbol ID ${JSON.stringify(effectiveId)} collides`)
        );
      }
    }

    const emptyDeclaration = minimalProject();
    fixtureTarget(emptyDeclaration).variables[''] = ['sentinel', 0];
    expect(() => validateProject(emptyDeclaration)).toThrow(/invalid variable declaration/);

  });

  it('rejects malformed block members and comment references', () => {
    const blockMutations: Array<(block: Record<string, unknown>) => void> = [
      block => { block['opcode'] = ''; },
      block => { block['next'] = 3; },
      block => { block['parent'] = 'missing'; },
      block => { block['inputs'] = null; },
      block => { block['fields'] = null; },
      block => { block['shadow'] = 'false'; },
      block => { block['topLevel'] = 'true'; },
      block => { block['x'] = Number.NaN; },
      block => { block['y'] = '0'; },
      block => { block['comment'] = 3; },
      block => { block['comment'] = 'missing'; },
      block => { block['mutation'] = []; }
    ];
    for (const mutate of blockMutations) {
      expectInvalid((_project, target) => {
        const block = plainBlock();
        mutate(block);
        raw(target.blocks)['block'] = block;
      });
    }
    expectInvalid((_project, target) => { raw(target.comments)['bad'] = null; });
    expectInvalid((_project, target) => { raw(target.comments)['bad'] = {blockId: 4, text: 'x'}; });
    expectInvalid((_project, target) => { raw(target.comments)['bad'] = {blockId: 'missing', text: 'x'}; });
    expectInvalid((_project, target) => { raw(target.comments)['bad'] = {blockId: null, text: 3}; });
    const valid = minimalProject();
    const target = fixtureTarget(valid);
    const linkedBlock = plainBlock();
    linkedBlock['comment'] = 'attached';
    target.blocks['block'] = linkedBlock as unknown as ScratchProject['targets'][number]['blocks'][string];
    target.comments['floating'] = {blockId: null, x: 0, y: 0, width: 1, height: 1, minimized: false, text: 'floating'};
    target.comments['attached'] = {blockId: 'block', x: 0, y: 0, width: 1, height: 1, minimized: false, text: 'attached'};
    expect(() => validateProject(valid)).not.toThrow();
  });

  it('validates variable, list, and ordinary monitors', () => {
    expectInvalid(project => { raw(project)['monitors'] = [null]; });
    expectInvalid(project => { raw(project)['monitors'] = [{opcode: 3, id: 'variable', params: {}}]; });
    expectInvalid(project => { raw(project)['monitors'] = [{opcode: 'data_variable', id: 3, params: {}}]; });
    expectInvalid(project => { raw(project)['monitors'] = [{opcode: 'data_variable', id: 'variable', params: null}]; });
    expectInvalid(project => { project.monitors = [{opcode: 'data_variable', id: 'missing', params: {}}]; }, /dangling monitored variable/);
    expectInvalid(project => { project.monitors = [{opcode: 'data_listcontents', id: 'missing', params: {}}]; }, /dangling monitored list/);
    expectInvalid(project => { project.monitors = [{opcode: 'data_variable', id: 'variable', params: {VARIABLE: 3}}]; }, /expected a string/);

    const project = minimalProject();
    const stage = fixtureTarget(project);
    stage.lists['list'] = ['list', []];
    project.monitors = [
      {opcode: 'data_variable', id: 'variable', params: {VARIABLE: 'value'}},
      {opcode: 'data_listcontents', id: 'list', params: {LIST: 'list'}},
      {opcode: 'motion_xposition', id: 'x', params: {}}
    ];
    expect(() => validateProject(project)).not.toThrow();
  });

  it('permits only stale invisible data monitors for missing sprites when requested', () => {
    const project = minimalProject();
    project.monitors = [{
      opcode: 'data_variable', id: 'old-local-id', params: {VARIABLE: 'i'},
      spriteName: 'Deleted Sprite', value: 0, visible: false
    }];

    expect(() => validateProject(project)).toThrow(/dangling monitored variable/);
    expect(() => validateProject(project, {allowRecoverableStaleInvisibleMonitors: true})).not.toThrow();

    const malformed = structuredClone(project);
    const malformedMonitor = malformed.monitors[0];
    if (!malformedMonitor) throw new Error('fixture monitor missing');
    malformedMonitor['params'] = {VARIABLE: 3};
    expect(() => validateProject(malformed, {allowRecoverableStaleInvisibleMonitors: true}))
      .toThrow(/expected a string/);

    const visible = structuredClone(project);
    const monitor = visible.monitors[0];
    if (!monitor) throw new Error('fixture monitor missing');
    monitor['visible'] = true;
    expect(() => validateProject(visible, {allowRecoverableStaleInvisibleMonitors: true}))
      .toThrow(/dangling monitored variable/);
  });

  it('rejects duplicate declarations and unknown opcode prefixes', () => {
    const duplicate = minimalProject();
    duplicate.extensions = ['pen', 'pen'];
    expect(() => validateProject(duplicate)).toThrow(/duplicate extension/);
    expectInvalid((_project, target) => { target.blocks['unknown'] = plainBlock('custom_do') as unknown as ScratchProject['targets'][number]['blocks'][string]; }, /unsupported opcode/);
  });
});
