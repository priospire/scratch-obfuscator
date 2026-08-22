import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {
  collectLinearRuns,
  collectNumericLiteralSites,
  collectStringLiteralSites,
  collectVariableCandidates
} from '../src/obfuscation/analysis.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import type {JsonValue, ObfuscationStats, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {createFixtureProject} from './support.js';

describe('name and analysis edge coverage', () => {
  it('casts monitor JSON values exactly while renaming only the selected variables', () => {
    const project = emptyProject();
    const template = requireTarget(project, 1);
    const cases: Array<{name: string; object?: JsonValue; property: string; value: number}> = [
      {name: 'null', object: null, property: 'Null selected', value: 10},
      {name: ',Cast', object: [null, 'Cast'], property: 'Array selected', value: 20},
      {name: '[object Object]', object: {key: 'value'}, property: 'Object selected', value: 30},
      {name: 'undefined', property: 'Missing selected', value: 40}
    ];
    project.targets = [requireTarget(project, 0)];
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      if (!item) continue;
      const sprite = structuredClone(template);
      sprite.name = item.name;
      sprite.variables = {
        [`selected-${index}`]: [item.property, item.value],
        [`ordinary-${index}`]: [`Ordinary ${index}`, item.value + 1]
      };
      project.targets.push(sprite);
      const params: Record<string, JsonValue> = {PROPERTY: item.property};
      if (Object.prototype.hasOwnProperty.call(item, 'object')) params['OBJECT'] = item.object ?? null;
      project.monitors.push({id: `monitor-${index}`, opcode: 'sensing_of', params, spriteName: null});
    }

    const candidates = collectVariableCandidates(project).map(candidate => candidate.name);
    expect(candidates).toEqual(['Ordinary 0', 'Ordinary 1', 'Ordinary 2', 'Ordinary 3']);

    const resultStats = transform(project, 41);
    expect(resultStats.warnings).toEqual([]);
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const sprite = project.targets[index + 1];
      const monitor = project.monitors[index];
      if (!item || !sprite || !monitor) throw new Error('monitor casting fixture was lost');
      const renamed = variableNameByValue(sprite, item.value);
      expect(renamed).toMatch(/^x_/u);
      expect((monitor['params'] as Record<string, JsonValue>)['PROPERTY']).toBe(renamed);
      expect(variableNames(sprite)).not.toContain(item.property);
    }
  });

  it('resolves primitive, menu, and omitted object selectors while ignoring incomplete monitors', () => {
    const project = emptyProject();
    const owner = requireTarget(project, 1);
    owner.name = 'Owner';
    const primitiveTarget = structuredClone(owner);
    primitiveTarget.name = 'Primitive Sprite';
    primitiveTarget.variables = {primitiveSelected: ['primitive selected', 11]};
    const menuTarget = structuredClone(owner);
    menuTarget.name = 'Menu Sprite';
    menuTarget.variables = {menuSelected: ['menu selected', 12]};
    const omittedTarget = structuredClone(owner);
    omittedTarget.name = 'undefined';
    omittedTarget.variables = {omittedSelected: ['omitted selected', 13]};
    const numericTarget = structuredClone(owner);
    numericTarget.name = '7';
    numericTarget.variables = {numericSelected: ['numeric selected', 14]};
    project.targets.push(primitiveTarget, menuTarget, omittedTarget, numericTarget);
    owner.blocks = {
      primitiveObject: [10, primitiveTarget.name],
      primitiveSense: sensing('primitive selected', [1, 'primitiveObject']),
      menuObject: {
        ...block('sensing_of_object_menu'),
        fields: {OBJECT: [menuTarget.name]},
        shadow: true
      },
      menuSense: sensing('menu selected', [1, 'menuObject']),
      omittedSense: block('sensing_of', null, null, true, {}, {PROPERTY: ['omitted selected']}),
      numericSense: sensing('numeric selected', [1, [4, 7]]),
      danglingSense: sensing('absent everywhere', [1, 'missingReporter'])
    };
    project.monitors = [
      {id: 'incomplete', opcode: 'sensing_of', params: {OBJECT: '_stage_'}, spriteName: null}
    ];

    expect(collectVariableCandidates(project).map(candidate => candidate.id)).toEqual([]);

    const resultStats = transform(project, 42);
    expect(resultStats.warnings).toEqual([]);
    const renamed = [
      variableNameByValue(primitiveTarget, 11),
      variableNameByValue(menuTarget, 12),
      variableNameByValue(omittedTarget, 13),
      variableNameByValue(numericTarget, 14)
    ];
    for (const name of renamed) expect(name).toMatch(/^x_/u);
    const properties = Object.values(owner.blocks).flatMap(value => (
      isScratchBlock(value) && value.opcode === 'sensing_of' ? [value.fields['PROPERTY']?.[0]] : []
    ));
    expect(properties).toEqual(expect.arrayContaining(renamed));
    expect(properties).not.toEqual(expect.arrayContaining(['primitive selected', 'menu selected', 'omitted selected']));
  });

  it('merges overlapping dynamic lookup groups once and keeps distinct properties separate', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    const first = requireTarget(project, 1);
    first.name = 'First';
    const second = structuredClone(first);
    second.name = 'Second';
    project.targets.push(second);
    stage.variables = {
      stageShared: ['Shared lookup', 1],
      stageOther: ['Other lookup', 4]
    };
    first.variables = {
      firstShared: ['Shared lookup', 2],
      firstOther: ['Other lookup', 5],
      selector: ['selector', '_stage_']
    };
    second.variables = {
      secondShared: ['Shared lookup', 3],
      secondOther: ['Other lookup', 6],
      secondSelector: ['selector two', '_stage_']
    };
    first.blocks = {
      sharedOne: sensing('Shared lookup', [1, [12, 'selector', 'selector']]),
      sharedAgain: sensing('Shared lookup', [1, [12, 'selector', 'selector']]),
      other: sensing('Other lookup', [1, [12, 'selector', 'selector']])
    };
    second.blocks = {
      sharedThird: sensing('Shared lookup', [1, [12, 'selector two', 'secondSelector']])
    };

    transform(project, 43);

    const shared = variableNameByValue(stage, 1);
    const other = variableNameByValue(stage, 4);
    expect(shared).toMatch(/^x_/u);
    expect(other).toMatch(/^x_/u);
    expect(shared).not.toBe(other);
    expect(variableNameByValue(first, 2)).toBe(shared);
    expect(variableNameByValue(second, 3)).toBe(shared);
    expect(variableNameByValue(first, 5)).toBe(other);
    expect(variableNameByValue(second, 6)).toBe(other);
    const properties = project.targets.flatMap(target => Object.values(target.blocks).flatMap(value => (
      isScratchBlock(value) && value.opcode === 'sensing_of' ? [value.fields['PROPERTY']?.[0]] : []
    )));
    expect(properties.filter(property => property === shared)).toHaveLength(3);
    expect(properties.filter(property => property === other)).toHaveLength(1);
  });

  it('preserves only the ten cloud declarations the runtime can actually activate', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    stage.variables = Object.fromEntries(Array.from({length: 11}, (_, index) => [
      `cloud-${index}`,
      [`Cloud name ${index}`, index, true]
    ]));

    transform(project, 47);

    const names = variableNames(stage);
    for (let index = 0; index < 10; index += 1) expect(names).toContain(`Cloud name ${index}`);
    expect(names).not.toContain('Cloud name 10');
    expect(variableNameByValue(stage, 10)).toMatch(/^x_/u);
  });

  it('freezes a malformed procedure region while renaming an independent valid region', () => {
    const project = emptyProject();
    const sprite = requireTarget(project, 1);
    sprite.blocks = {
      badDefinition: procedureDefinition('badPrototype'),
      badPrototype: procedurePrototype('badDefinition', 'bad %s', '["badArg"]', '["bad name"]', '[null]'),
      goodDefinition: procedureDefinition('goodPrototype'),
      goodPrototype: procedurePrototype('goodDefinition', 'good', '[]', '[]', '[]'),
      goodCall: {
        ...block('procedures_call'),
        mutation: {tagName: 'mutation', proccode: 'good', argumentids: '[]', warp: 'false'}
      }
    };

    const resultStats = transform(project, 53);

    expect(resultStats.warnings).toEqual([
      'Skipped procedure renaming in "Visible Sprite" because its prototype metadata is ambiguous.'
    ]);
    const procedures = Object.values(sprite.blocks).filter(isScratchBlock);
    expect(procedures.find(value => value.opcode === 'procedures_prototype' && value.mutation?.['proccode'] === 'bad %s')).toBeDefined();
    expect(procedures.find(value => value.opcode === 'procedures_prototype' && value.mutation?.['proccode'] === 'good')).toBeUndefined();
    const goodPrototype = procedures.find(value => value.opcode === 'procedures_prototype' && value.mutation?.['proccode'] !== 'bad %s');
    expect(goodPrototype?.mutation?.['proccode']).toMatch(/^x_/u);
    expect(procedures.find(value => value.opcode === 'procedures_call')?.mutation?.['proccode'])
      .toBe(goodPrototype?.mutation?.['proccode']);
  });

  it('freezes malformed default and call JSON independently without partially rewriting either target', () => {
    const project = emptyProject();
    const badDefaults = requireTarget(project, 1);
    badDefaults.name = 'Malformed defaults';
    badDefaults.blocks = {
      definition: procedureDefinition('prototype'),
      prototype: procedurePrototype('definition', 'defaults %s', '["arg"]', '["name"]', '{')
    };
    const badCall = structuredClone(badDefaults);
    badCall.name = 'Malformed call';
    badCall.blocks = {
      definition: procedureDefinition('prototype'),
      prototype: procedurePrototype('definition', 'call %s', '["arg"]', '["name"]', '[""]'),
      call: {
        ...block('procedures_call'),
        mutation: {tagName: 'mutation', proccode: 'call %s', argumentids: '{', warp: 'false'}
      }
    };
    project.targets.push(badCall);

    const resultStats = transform(project, 59);

    expect(resultStats.warnings).toEqual([
      'Skipped procedure renaming in "Malformed defaults" because its prototype metadata is ambiguous.',
      'Skipped procedure renaming in "Malformed call" because it contains an unresolved call.'
    ]);
    expect(procedureCodes(badDefaults)).toEqual(['defaults %s']);
    expect(procedureCodes(badCall)).toEqual(['call %s', 'call %s']);
  });

  it('handles dangling and cyclic linear-run boundaries without claiming the same run twice', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.blocks = {
      hat: block('event_whenflagclicked', 'a', null, true),
      a: block('motion_setx', 'b', 'hat'),
      b: block('looks_show', 'dangling', 'a')
    };
    sprite.blocks = {
      hat: block('event_whenflagclicked', 'c', null, true),
      c: block('motion_sety', 'd', 'hat'),
      d: block('looks_hide', 'c', 'c')
    };

    const runs = collectLinearRuns(project, 2);

    expect(runs).toEqual([
      expect.objectContaining({targetIndex: 0, blockIds: ['a', 'b'], predecessorId: 'hat', successorId: 'dangling'}),
      expect.objectContaining({targetIndex: 1, blockIds: ['c', 'd'], predecessorId: 'hat', successorId: 'c'})
    ]);
  });

  it('collects only exact string and canonical finite numeric literal domains', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    stage.blocks = {
      validString: block('looks_say', null, null, true, {MESSAGE: [1, [10, 'accepted']]}),
      unsafeStringInput: block('looks_say', null, null, true, {DURATION: [1, [10, 'rejected']]}),
      numericTextPrimitive: block('looks_say', null, null, true, {MESSAGE: [1, [10, 3]]}),
      nonCoreString: block('unknown_say', null, null, true, {MESSAGE: [1, [10, 'opaque']]}),
      validNumbers: block('operator_add', null, null, true, {
        NUM1: [1, [4, '1.5']],
        NUM2: [3, [5, '2'], [4, '0']]
      }),
      validNegativeZero: block('motion_setx', null, null, true, {X: [1, [4, '-0']]}),
      missingSafeInput: block('motion_sety'),
      reporterInput: block('motion_setx', null, null, true, {X: [1, 'reporter']}),
      nonPrimitiveFallback: block('motion_setx', null, null, true, {X: [3, [4, '3'], 'shadow']}),
      wrongPrimitive: block('motion_setx', null, null, true, {X: [1, [10, '4']]}),
      numericJsonValue: block('motion_setx', null, null, true, {X: [1, [4, 4]]}),
      leadingZero: block('motion_setx', null, null, true, {X: [1, [4, '01']]}),
      explicitPlus: block('motion_setx', null, null, true, {X: [1, [4, '+1']]}),
      infinity: block('motion_setx', null, null, true, {X: [1, [4, 'Infinity']]}),
      overflow: block('motion_setx', null, null, true, {X: [1, [4, '1e309']]})
    };

    expect(collectStringLiteralSites(project)).toEqual([
      {targetIndex: 0, ownerId: 'validString', inputName: 'MESSAGE', value: 'accepted'}
    ]);
    expect(collectNumericLiteralSites(project)).toEqual([
      {targetIndex: 0, ownerId: 'validNumbers', inputName: 'NUM1', primitiveCode: 4, value: '1.5', growth: 3},
      {targetIndex: 0, ownerId: 'validNumbers', inputName: 'NUM2', primitiveCode: 5, value: '2', growth: 2},
      {targetIndex: 0, ownerId: 'validNegativeZero', inputName: 'X', primitiveCode: 4, value: '-0', growth: 3}
    ]);
  });

  it('uses conservative Stage-less, monitor-scope, duplicate-ID, and opaque-surface fallbacks', () => {
    const stageLess = emptyProject();
    const onlySprite = requireTarget(stageLess, 1);
    stageLess.targets = [onlySprite];
    onlySprite.variables = {
      monitored: ['Stage-less monitored', 1],
      sensed: ['Stage-less sensed', 2]
    };
    onlySprite.blocks = {
      sense: sensing('Stage-less sensed', [1, [10, '_stage_']])
    };
    stageLess.monitors = [{id: 'monitored', opcode: 'data_variable', params: {}, spriteName: onlySprite.name}];
    expect(collectVariableCandidates(stageLess).map(candidate => candidate.id)).toEqual(['monitored', 'sensed']);

    const scoped = emptyProject();
    const stage = requireTarget(scoped, 0);
    const first = requireTarget(scoped, 1);
    const second = structuredClone(first);
    second.name = 'Second';
    scoped.targets.push(second);
    stage.variables = {
      globalMonitored: ['global monitored', 1],
      globalFallback: ['global fallback', 2]
    };
    first.variables = {
      localMonitored: ['local monitored', 3],
      localCandidate: ['local candidate', 4],
      duplicate: ['duplicate first', 5],
      opaqueCandidate: ['opaque candidate', 7]
    };
    second.variables = {duplicate: ['duplicate second', 6]};
    first.blocks = {
      opaque: block('opaque')
    };
    scoped.monitors = [
      {id: 'globalMonitored', opcode: 'data_variable', params: {}, spriteName: 'Missing Sprite'},
      {id: 'globalFallback', opcode: 'data_variable', params: {}, spriteName: first.name},
      {id: 'localMonitored', opcode: 'data_variable', params: {}, spriteName: first.name},
      {id: 'missing', opcode: 'data_variable', params: {}, spriteName: first.name}
    ];

    expect(collectVariableCandidates(scoped).map(candidate => candidate.id)).toEqual(['duplicate']);
  });

  it('distinguishes exact native attributes from dynamic variable lookup candidates', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {
      stageX: ['x position', 1],
      sharedStage: ['shared', 2],
      untouched: ['untouched', 3]
    };
    sprite.variables = {
      spriteX: ['x position', 4],
      sharedSprite: ['shared', 5],
      selector: ['selector', '_stage_']
    };
    sprite.blocks = {
      dynamicX: sensing('x position', [1, [12, 'selector', 'selector']]),
      dynamicShared: sensing('shared', [1, [12, 'selector', 'selector']]),
      nativeStatic: sensing('x position', [1, [10, sprite.name]])
    };

    const ids = collectVariableCandidates(project).map(candidate => candidate.id);
    expect(ids).toContain('untouched');
    expect(ids).toContain('spriteX');
    expect(ids).toContain('selector');
    expect(ids).not.toContain('stageX');
    expect(ids).not.toContain('sharedStage');
    expect(ids).not.toContain('sharedSprite');
  });

  it('keeps a Stage scalar eligible when an official literal shadow selects a native Sprite attribute', () => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Sprite1';
    stage.variables = {stageX: ['x position', 1]};
    sprite.blocks = {
      sense: sensing('x position', [1, 'menu']),
      menu: {
        ...block('motion_goto_menu', null, 'sense'),
        fields: {TO: [sprite.name]},
        shadow: true
      }
    };

    expect(collectVariableCandidates(project).map(candidate => candidate.id)).toContain('stageX');
  });

  it.each([
    ['sound_sounds_menu', 'SOUND_MENU', undefined],
    ['pen_menu_colorParam', 'colorParam', 'pen']
  ] as const)('treats %s as a literal sensing selector', (opcode, fieldName, extensionId) => {
    const project = emptyProject();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Sprite1';
    stage.variables = {stageX: ['x position', 1]};
    project.extensions = extensionId === undefined ? [] : [extensionId];
    sprite.blocks = {
      sense: sensing('x position', [1, 'menu']),
      menu: {
        ...block(opcode, null, 'sense'),
        fields: {[fieldName]: [sprite.name]},
        shadow: true
      }
    };

    expect(collectVariableCandidates(project).map(candidate => candidate.id)).toContain('stageX');
  });
});

function emptyProject(): ScratchProject {
  const project = createFixtureProject();
  for (const target of project.targets) {
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

function transform(project: ScratchProject, seed: number): ObfuscationStats {
  const resultStats: ObfuscationStats = {
    mode: 'lossless',
    blocksBefore: project.targets.reduce((sum, target) => sum + Object.keys(target.blocks).length, 0),
    blocksAfter: 0,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    variablesVirtualized: 0,
    constantsFolded: 0,
    inactiveFallbacksRemoved: 0,
    antiCheatDecoys: 0,
    warnings: []
  };
  applyCommonTransforms(
    project,
    new DeterministicGenerator(new Uint8Array(32).fill(seed), `name-analysis:${seed}`),
    resultStats
  );
  return resultStats;
}

function sensing(property: string, object: ScratchInput): ScratchBlock {
  return block('sensing_of', null, null, true, {OBJECT: object}, {PROPERTY: [property]});
}

function procedureDefinition(prototypeId: string): ScratchBlock {
  return block('procedures_definition', null, null, true, {custom_block: [1, prototypeId]});
}

function procedurePrototype(
  parent: string,
  code: string,
  argumentIds: string,
  argumentNames: string,
  argumentDefaults: string
): ScratchBlock {
  return {
    ...block('procedures_prototype', null, parent),
    shadow: true,
    mutation: {
      tagName: 'mutation',
      proccode: code,
      argumentids: argumentIds,
      argumentnames: argumentNames,
      argumentdefaults: argumentDefaults,
      warp: 'false'
    }
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
    opcode,
    next,
    parent,
    inputs,
    fields,
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing target ${index}`);
  return target;
}

function variableNames(target: ScratchTarget): string[] {
  return Object.values(target.variables).flatMap(declaration => (
    typeof declaration[0] === 'string' ? [declaration[0]] : []
  ));
}

function variableNameByValue(target: ScratchTarget, value: unknown): string | undefined {
  const declaration = Object.values(target.variables).find(candidate => candidate[1] === value);
  return typeof declaration?.[0] === 'string' ? declaration[0] : undefined;
}

function procedureCodes(target: ScratchTarget): Array<JsonValue | undefined> {
  return Object.values(target.blocks).flatMap(value => (
    isScratchBlock(value) && (value.opcode === 'procedures_prototype' || value.opcode === 'procedures_call')
      ? [value.mutation?.['proccode']]
      : []
  ));
}
