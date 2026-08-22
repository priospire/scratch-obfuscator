import {describe, expect, it} from 'vitest';
import {InputError} from '../src/errors.js';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {
  validateOfficialExtensions,
  validateOfficialSchema,
  validateProject
} from '../src/validation/index.js';

function makeTarget(name: string, isStage: boolean): ScratchTarget {
  return {
    isStage,
    name,
    variables: isStage ? {global: ['global value', 0]} : {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: isStage ? 'backdrop' : 'costume'}],
    sounds: []
  };
}

function makeProject(): ScratchProject {
  return {
    targets: [makeTarget('Stage', true)],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'}
  };
}

function stageOf(project: ScratchProject): ScratchTarget {
  const stage = project.targets[0];
  if (!stage) throw new Error('test project is missing Stage');
  return stage;
}

function makeBlock(opcode: string, changes: Partial<ScratchBlock> = {}): ScratchBlock {
  return {
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0,
    ...changes
  };
}

function inputErrorMessage(action: () => void): string {
  try {
    action();
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
  throw new Error('expected validation to reject the project');
}

describe('validation diagnostic regressions', () => {
  it('reports malformed graph ownership and comment links at their exact paths', () => {
    const primitiveNext = makeProject();
    stageOf(primitiveNext).blocks = {
      owner: makeBlock('looks_show', {next: 'literal'}),
      literal: [10, 'not an executable block']
    };
    expect(inputErrorMessage(() => validateProject(primitiveNext))).toBe(
      '$.targets[0].blocks.owner.next: next edge must reference an object block, not "literal"'
    );

    const mismatchedParent = makeProject();
    stageOf(mismatchedParent).blocks = {
      owner: makeBlock('looks_say', {inputs: {MESSAGE: [1, 'child']}}),
      other: makeBlock('looks_show'),
      child: makeBlock('operator_join', {parent: 'other', topLevel: false})
    };
    expect(inputErrorMessage(() => validateProject(mismatchedParent))).toBe(
      '$.targets[0].blocks.child.parent: parent does not match incoming owner "owner"'
    );

    const topLevelParent = makeProject();
    stageOf(topLevelParent).blocks = {
      owner: makeBlock('looks_show'),
      child: makeBlock('looks_hide', {parent: 'owner'})
    };
    expect(inputErrorMessage(() => validateProject(topLevelParent))).toBe(
      '$.targets[0].blocks.child.parent: top-level block must have a null parent'
    );

    const orphan = makeProject();
    stageOf(orphan).blocks = {
      owner: makeBlock('looks_show'),
      child: makeBlock('looks_hide', {parent: 'owner', topLevel: false})
    };
    expect(inputErrorMessage(() => validateProject(orphan))).toBe(
      '$.targets[0].blocks.child: non-top-level block is orphaned'
    );

    const primitiveInput = makeProject();
    stageOf(primitiveInput).blocks = {
      owner: makeBlock('looks_say', {inputs: {MESSAGE: [1, 'reporter']}}),
      reporter: [12, 'global value', 'global']
    };
    expect(() => validateProject(primitiveInput)).not.toThrow();

    const primitiveComment = makeProject();
    const primitiveCommentStage = stageOf(primitiveComment);
    primitiveCommentStage.blocks['literal'] = [10, 'value'];
    primitiveCommentStage.comments['attached'] = {
      blockId: 'literal',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      minimized: false,
      text: 'invalid attachment'
    };
    expect(inputErrorMessage(() => validateProject(primitiveComment))).toBe(
      '$.targets[0].comments.attached.blockId: linked comment must reference an object block'
    );

    const unreciprocatedComment = makeProject();
    const unreciprocatedCommentStage = stageOf(unreciprocatedComment);
    unreciprocatedCommentStage.blocks['block'] = makeBlock('looks_show');
    unreciprocatedCommentStage.comments['attached'] = {
      blockId: 'block',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      minimized: false,
      text: 'one-way link'
    };
    expect(inputErrorMessage(() => validateProject(unreciprocatedComment))).toBe(
      '$.targets[0].comments.attached.blockId: comment link is not reciprocated by block "block"'
    );

    const unreciprocatedBlock = makeProject();
    const unreciprocatedBlockStage = stageOf(unreciprocatedBlock);
    unreciprocatedBlockStage.blocks = {
      owner: makeBlock('looks_show', {comment: 'attached'}),
      intruder: makeBlock('looks_hide', {comment: 'attached'})
    };
    unreciprocatedBlockStage.comments['attached'] = {
      blockId: 'owner',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      minimized: false,
      text: 'shared link'
    };
    expect(inputErrorMessage(() => validateProject(unreciprocatedBlock))).toBe(
      '$.targets[0].blocks.intruder.comment: block comment link is not reciprocated by comment "attached"'
    );

    const emptyBlockId = makeProject();
    stageOf(emptyBlockId).blocks[''] = makeBlock('looks_show');
    expect(inputErrorMessage(() => validateProject(emptyBlockId))).toBe(
      '$.targets[0].blocks: block IDs must not be empty'
    );
  });

  it('diagnoses malformed procedure references and schema-governed mutation values', () => {
    const danglingPrototype = makeProject();
    stageOf(danglingPrototype).blocks['definition'] = makeBlock('procedures_definition', {
      inputs: {custom_block: [1, 'missing-prototype']}
    });
    expect(inputErrorMessage(() => validateProject(danglingPrototype))).toBe(
      '$.targets[0].blocks.definition.inputs.custom_block[1]: dangling block reference "missing-prototype"'
    );

    const malformedMutation = makeProject();
    stageOf(malformedMutation).blocks['call'] = makeBlock('procedures_call', {
      mutation: {
        tagName: 'mutation',
        proccode: 7,
        argumentids: '[]',
        warp: 'false'
      }
    });
    expect(inputErrorMessage(() => validateProject(malformedMutation))).toBe(
      'official Scratch 3 schema rejected project: $/targets/0/blocks/call/mutation/proccode must be string'
    );
  });

  it('distinguishes invalid name-only fields from valid loader-resolved visibility fields', () => {
    const nonStringName = makeProject();
    stageOf(nonStringName).blocks['read'] = makeBlock('data_variable', {
      fields: {VARIABLE: [42]}
    });
    expect(inputErrorMessage(() => validateProject(nonStringName))).toBe(
      '$.targets[0].blocks.read.fields.VARIABLE[0]: expected a string for a name-only variable reference'
    );

    const nameOnlyVisibility = makeProject();
    stageOf(nameOnlyVisibility).blocks['show'] = makeBlock('data_showvariable', {
      fields: {VARIABLE: ['global value']}
    });
    expect(() => validateProject(nameOnlyVisibility)).not.toThrow();

    const missingNameOnlyVisibility = makeProject();
    stageOf(missingNameOnlyVisibility).blocks['show'] = makeBlock('data_showvariable', {
      fields: {VARIABLE: ['missing visibility label']}
    });
    expect(inputErrorMessage(() => validateProject(missingNameOnlyVisibility))).toBe(
      '$.targets[0].blocks.show.fields.VARIABLE: dangling name-only variable reference "missing visibility label"'
    );

    const missingVisibility = makeProject();
    stageOf(missingVisibility).blocks['show'] = makeBlock('data_showvariable', {
      fields: {VARIABLE: ['missing', 'missing-id']}
    });
    expect(inputErrorMessage(() => validateProject(missingVisibility))).toBe(
      '$.targets[0].blocks.show.fields.VARIABLE[1]: dangling variable reference "missing-id"'
    );

    const globalListVisibility = makeProject();
    stageOf(globalListVisibility).lists['items'] = ['items', []];
    const sprite = makeTarget('Sprite', false);
    sprite.blocks['show-list'] = makeBlock('data_showlist', {
      fields: {LIST: ['items', 'items']}
    });
    globalListVisibility.targets.push(sprite);
    expect(() => validateProject(globalListVisibility)).not.toThrow();

    const malformedFieldStage = stageOf(makeProject());
    const malformedField = {
      ...makeProject(),
      targets: [{
        ...malformedFieldStage,
        blocks: {show: {...makeBlock('data_showlist'), fields: {LIST: 'not a tuple'}}}
      }]
    };
    expect(inputErrorMessage(() => validateProject(malformedField))).toBe(
      '$.targets[0].blocks.show.fields.LIST: invalid field tuple'
    );
  });

  it('rejects cross-sprite local references while retaining Stage fallback scope', () => {
    const crossSprite = makeProject();
    const first = makeTarget('First', false);
    const second = makeTarget('Second', false);
    first.variables['first-local'] = ['first local', 1];
    second.variables['second-local'] = ['second local', 2];
    first.blocks['foreign-read'] = makeBlock('data_variable', {
      fields: {VARIABLE: ['second local', 'second-local']}
    });
    crossSprite.targets.push(first, second);
    expect(inputErrorMessage(() => validateProject(crossSprite))).toBe(
      '$.targets[1].blocks.foreign-read.fields.VARIABLE[1]: dangling variable reference "second-local"'
    );

    const stageFallback = makeProject();
    const sprite = makeTarget('Sprite', false);
    sprite.blocks['global-read'] = makeBlock('data_variable', {
      fields: {VARIABLE: ['global value', 'global']}
    });
    stageFallback.targets.push(sprite);
    expect(() => validateProject(stageFallback)).not.toThrow();
  });

  it('groups null broadcast IDs by exact Stage name without unsafe coalescing', () => {
    const compatible = makeProject();
    const compatibleStage = stageOf(compatible);
    compatibleStage.broadcasts['message-one'] = 'one';
    compatibleStage.blocks = {
      dynamic: makeBlock('event_broadcast', {
        inputs: {BROADCAST_INPUT: [1, [11, 'one', null]]}
      }),
      field: makeBlock('event_whenbroadcastreceived', {
        fields: {BROADCAST_OPTION: ['one', null]}
      })
    };
    expect(() => validateProject(compatible)).not.toThrow();

    const divergent = makeProject();
    const divergentStage = stageOf(divergent);
    divergentStage.broadcasts = {'message-one': 'one', 'message-two': 'two'};
    divergentStage.blocks = {
      dynamicOne: makeBlock('event_broadcast', {
        inputs: {BROADCAST_INPUT: [1, [11, 'one', null]]}
      }),
      dynamicTwo: makeBlock('event_broadcast', {
        inputs: {BROADCAST_INPUT: [1, [11, 'two', null]]}
      }),
      field: makeBlock('event_whenbroadcastreceived', {
        fields: {BROADCAST_OPTION: ['one', null]}
      })
    };
    expect(inputErrorMessage(() => validateProject(divergent))).toBe(
      '$.targets[0].blocks.dynamicTwo.inputs.BROADCAST_INPUT[1]: implicit symbol ID "null" would coalesce with a distinct reference first seen at $.targets[0].blocks.dynamicOne.inputs.BROADCAST_INPUT[1]'
    );
  });

  it('resolves data monitors only within the named target and Stage fallback scope', () => {
    const missingSpriteGlobal = makeProject();
    missingSpriteGlobal.monitors = [{
      opcode: 'data_variable',
      id: 'global',
      params: {VARIABLE: 'global value'},
      spriteName: 'Deleted Sprite',
      visible: true
    }];
    expect(() => validateProject(missingSpriteGlobal)).not.toThrow();

    const namedSpriteGlobal = makeProject();
    namedSpriteGlobal.targets.push(makeTarget('Sprite', false));
    namedSpriteGlobal.monitors = [{
      opcode: 'data_variable',
      id: 'global',
      params: {VARIABLE: 'global value'},
      spriteName: 'Sprite',
      visible: true
    }];
    expect(() => validateProject(namedSpriteGlobal)).not.toThrow();

    const wrongLocalOwner = makeProject();
    const first = makeTarget('First', false);
    const second = makeTarget('Second', false);
    first.variables['first-local'] = ['first local', 1];
    second.variables['second-local'] = ['second local', 2];
    wrongLocalOwner.targets.push(first, second);
    wrongLocalOwner.monitors = [{
      opcode: 'data_variable',
      id: 'second-local',
      params: {VARIABLE: 'second local'},
      spriteName: 'First',
      visible: true
    }];
    expect(inputErrorMessage(() => validateProject(wrongLocalOwner))).toBe(
      '$.monitors[0].id: dangling monitored variable "second-local"'
    );

    const malformedListParameter = makeProject();
    stageOf(malformedListParameter).lists['items'] = ['items', []];
    malformedListParameter.monitors = [{
      opcode: 'data_listcontents',
      id: 'items',
      params: {LIST: false},
      spriteName: null
    }];
    expect(inputErrorMessage(() => validateProject(malformedListParameter))).toBe(
      '$.monitors[0].params.LIST: expected a string'
    );
  });

  it('provides stable diagnostics for extension declarations, core blocks, and opcode locations', () => {
    const unsupportedDeclaration = makeProject();
    unsupportedDeclaration.extensions = ['unbundled'];
    expect(inputErrorMessage(() => validateOfficialExtensions(unsupportedDeclaration))).toBe(
      'unsupported extension: "unbundled"'
    );

    const core = makeProject();
    stageOf(core).blocks['show'] = makeBlock('looks_show');
    expect(() => validateOfficialExtensions(core)).not.toThrow();

    const validExtension = makeProject();
    validExtension.extensions = ['pen'];
    stageOf(validExtension).blocks['clear'] = makeBlock('pen_clear');
    expect(() => validateOfficialExtensions(validExtension)).not.toThrow();

    const inventedExtensionOpcode = makeProject();
    inventedExtensionOpcode.extensions = ['pen'];
    stageOf(inventedExtensionOpcode).blocks['invented'] = makeBlock('pen_notRegistered');
    expect(inputErrorMessage(() => validateOfficialExtensions(inventedExtensionOpcode))).toBe(
      'target 0 block "invented" has unsupported opcode "pen_notRegistered" for bundled extension "pen"'
    );

    const noPrefix = makeProject();
    stageOf(noPrefix).blocks['invalid'] = makeBlock('invalid');
    expect(inputErrorMessage(() => validateOfficialExtensions(noPrefix))).toBe(
      'target 0 block "invalid" has unsupported opcode "invalid"'
    );

    const undeclaredMonitorExtension = makeProject();
    undeclaredMonitorExtension.monitors = [{opcode: 'pen_clear', id: 'pen-monitor', params: {}}];
    expect(inputErrorMessage(() => validateOfficialExtensions(undeclaredMonitorExtension))).toBe(
      'monitor 0 uses undeclared extension "pen"'
    );
  });

  it('formats official schema failures with root and nested JSON locations', () => {
    expect(inputErrorMessage(() => validateOfficialSchema(null))).toBe(
      'official Scratch 3 schema rejected project: $ must be object'
    );

    const nested = makeProject();
    const costume = stageOf(nested).costumes[0];
    if (!costume) throw new Error('test project is missing a costume');
    costume['assetId'] = 'short';
    expect(inputErrorMessage(() => validateOfficialSchema(nested))).toBe(
      'official Scratch 3 schema rejected project: $/targets/0/costumes/0/assetId must match pattern "^[a-fA-F0-9]{32}$"'
    );
  });
});
