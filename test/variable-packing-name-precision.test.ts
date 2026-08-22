import {describe, expect, it} from 'vitest';
import {collectVariableCandidates} from '../src/obfuscation/analysis.js';
import type {JsonValue, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';

function target(name: string, isStage: boolean, variables: Record<string, JsonValue[]>): ScratchTarget {
  return {
    isStage,
    name,
    variables,
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: isStage ? 'backdrop' : 'costume'}],
    sounds: []
  };
}

function project(...targets: ScratchTarget[]): ScratchProject {
  return {targets, monitors: [], extensions: [], meta: {semver: '3.0.0'}};
}

function block(
  opcode: string,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {},
  mutation?: ScratchBlock['mutation']
): ScratchBlock {
  return {
    opcode,
    next: null,
    parent: null,
    inputs,
    fields,
    shadow: false,
    topLevel: false,
    ...(mutation ? {mutation} : {})
  };
}

function candidateKeys(value: ScratchProject): Set<string> {
  return new Set(collectVariableCandidates(value).map(candidate => `${candidate.targetIndex}:${candidate.id}`));
}

describe('variable packing name precision', () => {
  it('resolves static Stage, sprite, and missing sensing targets without excluding same-name variables elsewhere', () => {
    const stage = target('Stage', true, {'stage-score': ['score', 1], 'stage-other': ['other', 2]});
    const first = target('Sprite1', false, {'first-score': ['score', 3], 'first-other': ['other', 4]});
    const second = target('Sprite2', false, {'second-score': ['score', 5]});
    const value = project(stage, first, second);
    first.blocks['sprite-menu'] = block('sensing_of_object_menu', {}, {
      OBJECT: ['Sprite1'],
      EXTRA_SERIALIZED_FIELD: ['ignored']
    });
    first.blocks['sprite-sense'] = block(
      'sensing_of',
      {OBJECT: [1, 'sprite-menu']},
      {PROPERTY: ['score']}
    );
    first.blocks['stage-sense'] = block(
      'sensing_of',
      {OBJECT: [1, [10, '_stage_']]},
      {PROPERTY: ['other']}
    );
    first.blocks['missing-sense'] = block(
      'sensing_of',
      {OBJECT: [1, [10, 'Missing']]},
      {PROPERTY: ['score']}
    );

    expect(candidateKeys(value)).toEqual(new Set(['1:first-other']));
  });

  it('treats the literal Stage display name as missing because the runtime token is _stage_', () => {
    const stage = target('Stage', true, {score: ['score', 1]});
    const sprite = target('Sprite1', false, {});
    sprite.blocks['sense'] = block('sensing_of', {OBJECT: [1, [10, 'Stage']]}, {PROPERTY: ['score']});

    expect(candidateKeys(project(stage, sprite))).toContain('0:score');
  });

  it('excludes only the first same-name declaration visible to sensing_of', () => {
    const stage = target('Stage', true, {});
    const sprite = target('Sprite1', false, {
      first: ['duplicate', 1],
      second: ['duplicate', 2],
      unrelated: ['unrelated', 3]
    });
    sprite.blocks['sense'] = block(
      'sensing_of',
      {OBJECT: [1, [10, 'Sprite1']]},
      {PROPERTY: ['duplicate']}
    );

    expect(candidateKeys(project(stage, sprite))).toEqual(new Set(['1:second', '1:unrelated']));
  });

  it('honors native attribute precedence for static and dynamic selectors', () => {
    const staticStage = target('Stage', true, {'stage-x': ['x position', 1], backdrop: ['backdrop name', 2]});
    const staticSprite = target('Sprite1', false, {'sprite-x': ['x position', 3]});
    staticSprite.blocks['sprite-native'] = block(
      'sensing_of',
      {OBJECT: [1, [10, 'Sprite1']]},
      {PROPERTY: ['x position']}
    );
    staticSprite.blocks['stage-native'] = block(
      'sensing_of',
      {OBJECT: [1, [10, '_stage_']]},
      {PROPERTY: ['backdrop name']}
    );
    expect(candidateKeys(project(staticStage, staticSprite))).toEqual(new Set(['0:stage-x', '0:backdrop', '1:sprite-x']));

    const dynamicStage = target('Stage', true, {'stage-x': ['x position', 1]});
    const dynamicSprite = target('Sprite1', false, {'sprite-x': ['x position', 2], selector: ['selector', 'Sprite1']});
    dynamicSprite.blocks['selector'] = block('sensing_answer');
    dynamicSprite.blocks['sense'] = block('sensing_of', {OBJECT: [1, 'selector']}, {PROPERTY: ['x position']});
    expect(candidateKeys(project(dynamicStage, dynamicSprite))).toEqual(new Set(['1:sprite-x', '1:selector']));
  });

  it('treats an unresolved dynamic selector as able to select every project target', () => {
    const stage = target('Stage', true, {shared: ['shared', 1], other: ['other', 0]});
    const first = target('Sprite1', false, {shared1: ['shared', 2]});
    const second = target('Sprite2', false, {shared2: ['shared', 3]});
    first.blocks['selector'] = block('sensing_answer');
    first.blocks['sense'] = block('sensing_of', {OBJECT: [1, 'selector']}, {PROPERTY: ['shared']});

    expect(candidateKeys(project(stage, first, second))).toEqual(new Set(['0:other']));
  });

  it('uses only resolved data-variable monitor IDs and applies sensing monitor target semantics', () => {
    const stage = target('Stage', true, {
      monitored: ['monitored', 1],
      incidental: ['incidental', 2],
      shared: ['shared', 3]
    });
    const first = target('Sprite1', false, {local: ['local', 4], shared1: ['shared', 5]});
    const second = target('Sprite2', false, {shared2: ['shared', 6]});
    const value = project(stage, first, second);
    value.monitors.push(
      {
        id: 'monitored', opcode: 'data_variable', params: {VARIABLE: 'monitored', NOTE: 'incidental'},
        spriteName: null, value: 'incidental'
      },
      {id: 'local', opcode: 'data_variable', params: {VARIABLE: 'local'}, spriteName: 'Sprite1'},
      {id: 'incidental', opcode: 'sensing_timer', params: {NOTE: 'incidental'}, spriteName: null},
      {id: 'sense', opcode: 'sensing_of', params: {OBJECT: 'Sprite2', PROPERTY: 'shared'}, spriteName: null}
    );

    expect(candidateKeys(value)).toEqual(new Set(['0:incidental', '0:shared', '1:shared1']));
  });

  it('treats every sensing monitor selector as a literal serialized field value', () => {
    const stage = target('Stage', true, {shared: ['shared', 1], stageSentinel: ['sentinel', 3]});
    const sprite = target('Sprite1', false, {local: ['local', 2]});
    const value = project(stage, sprite);
    value.monitors.push(
      {id: 'array', opcode: 'sensing_of', params: {OBJECT: ['Sprite1'], PROPERTY: 'local'}},
      {id: 'object', opcode: 'sensing_of', params: {OBJECT: {name: 'Sprite1'}, PROPERTY: 'local'}},
      {id: 'missing', opcode: 'sensing_of', params: {PROPERTY: 'local'}},
      {id: 'array-stage-token', opcode: 'sensing_of', params: {OBJECT: ['_stage_'], PROPERTY: 'sentinel'}}
    );

    expect(candidateKeys(value)).toEqual(new Set(['0:shared', '0:stageSentinel']));
  });

  it('treats only Stage declarations marked cloud as cloud variables', () => {
    const stage = target('Stage', true, {cloud: ['cloud', 1, true], ordinary: ['ordinary', 2]});
    const sprite = target('Sprite1', false, {legacyMarker: ['local', 3, true]});

    expect(candidateKeys(project(stage, sprite))).toEqual(new Set(['0:ordinary', '1:legacyMarker']));
  });

  it('applies the runtime cloud quota in Stage declaration order', () => {
    const variables: Record<string, JsonValue[]> = {};
    for (let index = 0; index < 12; index += 1) {
      variables[`marked-${index}`] = [`marked ${index}`, index, true];
    }
    variables['ordinary'] = ['ordinary', 12];
    const candidates = candidateKeys(project(target('Stage', true, variables)));

    expect(candidates).toEqual(new Set(['0:marked-10', '0:marked-11', '0:ordinary']));
  });

  it('allows exact bundled extension surfaces but remains conservative for invented opcodes and unknown mutations', () => {
    const officialStage = target('Stage', true, {global: ['global', 1]});
    const officialSprite = target('Sprite1', false, {local: ['local', 2]});
    officialSprite.blocks['pen'] = block('pen_clear', {}, {}, {opaque: 'global'});
    officialSprite.blocks['pen-menu'] = block('pen_menu_colorParam', {}, {colorParam: ['color']}, {opaque: 'local'});
    expect(candidateKeys(project(officialStage, officialSprite))).toEqual(new Set(['0:global', '1:local']));

    const inventedStage = target('Stage', true, {global: ['global', 1]});
    const inventedSprite = target('Sprite1', false, {local: ['local', 2]});
    inventedSprite.blocks['invented'] = block('pen_readVariableByName');
    expect(candidateKeys(project(inventedStage, inventedSprite))).toEqual(new Set());

    const inventedCoreStage = target('Stage', true, {global: ['global', 1]});
    const inventedCoreSprite = target('Sprite1', false, {local: ['local', 2]});
    inventedCoreSprite.blocks['invented'] = block('data_readVariableByName');
    expect(candidateKeys(project(inventedCoreStage, inventedCoreSprite))).toEqual(new Set());

    const mutationStage = target('Stage', true, {global: ['global', 1]});
    const mutationSprite = target('Sprite1', false, {local: ['local', 2]});
    const cleanSprite = target('Sprite2', false, {clean: ['clean', 3]});
    mutationSprite.blocks['opaque-core'] = block('looks_say', {}, {}, {unknownVariableName: 'global'});
    expect(candidateKeys(project(mutationStage, mutationSprite, cleanSprite))).toEqual(new Set(['2:clean']));
  });
});
