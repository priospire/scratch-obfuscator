import {describe, expect, it} from 'vitest';
import {InputError} from '../src/errors.js';
import {countBlockEquivalents, isPrimitive, isScratchBlock, opcodePrefix, stageOf} from '../src/model/blocks.js';
import {assertJsonTree, cloneProject, hasOwn, isRecord, orderedDictionary} from '../src/model/json.js';
import type {ScratchProject} from '../src/types.js';
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

  it('handles prototype-like dictionary keys as data', () => {
    const project = minimalProject();
    const target = project.targets[0];
    if (!target) throw new Error('fixture is missing Stage');
    target.variables = JSON.parse('{"__proto__":["safe",0]}') as Record<string, [string, number]>;
    target.blocks['read'] = {opcode: 'data_variable', next: null, parent: null, inputs: {}, fields: {VARIABLE: ['safe', '__proto__']}, shadow: false, topLevel: true, x: 0, y: 0};
    expect(() => validateProject(project)).not.toThrow();
  });

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
      broadcastUser: {opcode: 'event_broadcast', next: null, parent: null, inputs: {BROADCAST_INPUT: [1, [11, 'dynamic message', null]]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0}
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
  });

  it('resolves name-only fields through Stage as the whole-project loader does', () => {
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

  it('rejects missing or ambiguous name-only symbol references', () => {
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
      expect(() => validateProject(ambiguous)).toThrow(new RegExp(`ambiguous name-only ${kind}`));
    }

    const broadcasts = minimalProject();
    const stage = fixtureTarget(broadcasts);
    stage.broadcasts = {first: 'Message', second: 'Message'};
    stage.blocks['ambiguous'] = {
      ...plainBlock('event_whenbroadcastreceived'), fields: {BROADCAST_OPTION: ['Message', null]}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(broadcasts)).toThrow(/ambiguous name-only broadcast/);
  });

  it('rejects duplicate symbol IDs across kinds and targets before VM loading can rebind them', () => {
    const sameTarget = minimalProject();
    fixtureTarget(sameTarget).lists['variable'] = ['colliding list', []];
    expect(() => validateProject(sameTarget)).toThrow(/duplicate project-wide symbol ID "variable"/);

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
    }
  });

  it('rejects implicit-ID collisions and field coalescing performed by the Scratch loader', () => {
    const sentinel = minimalProject();
    const sentinelTarget = fixtureTarget(sentinel);
    sentinelTarget.variables['null'] = ['sentinel', 0];
    sentinelTarget.blocks['nameOnly'] = {
      ...plainBlock('data_variable'), fields: {VARIABLE: ['value', null]}
    } as unknown as ScratchProject['targets'][number]['blocks'][string];
    expect(() => validateProject(sentinel)).toThrow(/implicit symbol ID "null" collides/);

    const coalesced = minimalProject();
    const coalescedTarget = fixtureTarget(coalesced);
    coalescedTarget.variables['other'] = ['other', 0];
    coalescedTarget.blocks = {
      first: {...plainBlock('data_variable'), fields: {VARIABLE: ['value']}},
      second: {...plainBlock('data_variable'), fields: {VARIABLE: ['other']}}
    } as unknown as ScratchProject['targets'][number]['blocks'];
    expect(() => validateProject(coalesced)).toThrow(/would coalesce distinct references/);
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

  it('rejects duplicate declarations and unknown opcode prefixes', () => {
    const duplicate = minimalProject();
    duplicate.extensions = ['pen', 'pen'];
    expect(() => validateProject(duplicate)).toThrow(/duplicate extension/);
    expectInvalid((_project, target) => { target.blocks['unknown'] = plainBlock('custom_do') as unknown as ScratchProject['targets'][number]['blocks'][string]; }, /unsupported opcode/);
  });
});
