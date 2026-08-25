import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {ANTI_CHEAT_WATERMARK_NAME} from '../src/obfuscation/anticheat.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import type {ObfuscationStats, ScratchBlock, ScratchInput, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('precise symbol-name obfuscation', () => {
  it('renames every ordinary variable and list while preserving only Stage cloud data and the Stage watermark', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {
      ordinary: ['Readable global', 1],
      cloud: ['Cloud contract name', 2, true],
      watermark: [ANTI_CHEAT_WATERMARK_NAME, 'owned'],
      duplicateWatermark: [ANTI_CHEAT_WATERMARK_NAME, 'rename me']
    };
    stage.lists = {globalList: ['Readable global list', []]};
    sprite.variables = {
      ordinaryLocal: ['Readable local', 3],
      falseCloudMarker: ['Not actually cloud', 4, true],
      localWatermarkLookalike: [ANTI_CHEAT_WATERMARK_NAME, 5]
    };
    sprite.lists = {localList: ['Readable local list', []]};

    transform(project);
    validateProject(project);

    expect(variableNames(stage)).toContain('Cloud contract name');
    expect(variableNames(stage).filter(name => name === ANTI_CHEAT_WATERMARK_NAME)).toHaveLength(1);
    expect(variableNameByValue(stage, 'rename me')).toMatch(/^x_/u);
    expect(variableNames(stage)).not.toContain('Readable global');
    expect(listNames(stage)).not.toContain('Readable global list');
    expect(variableNames(sprite)).not.toContain('Readable local');
    expect(variableNames(sprite)).not.toContain('Not actually cloud');
    expect(variableNames(sprite)).not.toContain(ANTI_CHEAT_WATERMARK_NAME);
    expect(listNames(sprite)).not.toContain('Readable local list');
  });

  it('preserves only the ten Stage cloud names the runtime can actually activate', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    stage.variables = Object.fromEntries(Array.from({length: 12}, (_, index) => [
      `cloud-${index}`,
      [`Cloud contract ${index}`, index, true]
    ]));

    transform(project, 41);
    validateProject(project);

    for (let index = 0; index < 10; index += 1) {
      expect(variableNames(stage)).toContain(`Cloud contract ${index}`);
    }
    expect(variableNames(stage)).not.toContain('Cloud contract 10');
    expect(variableNames(stage)).not.toContain('Cloud contract 11');
  });

  it('rewrites exact static Stage and sprite sensing properties without freezing unrelated names', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {
      stageSelected: ['Stage selected', 1],
      stageUnrelated: ['Stage unrelated', 2]
    };
    sprite.variables = {
      spriteSelected: ['Sprite selected', 3],
      spriteUnrelated: ['Sprite unrelated', 4]
    };
    sprite.blocks = {
      stageSense: sensingBlock('Stage selected', [1, [10, '_stage_']]),
      spriteSense: sensingBlock('Sprite selected', [1, [10, sprite.name]]),
      fakeStageSense: sensingBlock('Stage unrelated', [1, [10, 'Stage']])
    };

    const resultStats = transform(project);
    validateProject(project);

    const senses = Object.values(sprite.blocks).flatMap(value => (
      isScratchBlock(value) && value.opcode === 'sensing_of' ? [value] : []
    ));
    expect(senses[0]?.fields['PROPERTY']?.[0]).toBe(variableNameByValue(stage, 1));
    expect(senses[1]?.fields['PROPERTY']?.[0]).toBe(variableNameByValue(sprite, 3));
    expect(senses[2]?.fields['PROPERTY']?.[0]).toBe('Stage unrelated');
    expect(variableNames(stage)).not.toContain('Stage selected');
    expect(variableNames(stage)).not.toContain('Stage unrelated');
    expect(variableNames(sprite)).not.toContain('Sprite selected');
    expect(variableNames(sprite)).not.toContain('Sprite unrelated');
    expect(resultStats.warnings).toEqual([]);
  });

  it.each([
    [4, '7'],
    [5, '7'],
    [6, '7'],
    [7, '7'],
    [8, '7'],
    [9, '#abcdef'],
    [10, 'Visible Sprite']
  ])('casts a static primitive %i OBJECT exactly like the runtime', (primitiveCode, targetName) => {
    const project = emptyFixture();
    const sprite = requireTarget(project, 1);
    sprite.name = targetName;
    sprite.variables = {selected: ['Selected by literal', 11]};
    sprite.blocks = {
      sense: sensingBlock('Selected by literal', [1, [primitiveCode, targetName]])
    };

    transform(project, primitiveCode);
    validateProject(project);

    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(variableNameByValue(sprite, 11));
    expect(variableNames(sprite)).not.toContain('Selected by literal');
  });

  it('resolves the standard sensing object-menu shadow as a static target', () => {
    const project = emptyFixture();
    const sprite = requireTarget(project, 1);
    sprite.variables = {selected: ['Selected through menu', 10]};
    sprite.blocks = {
      sense: sensingBlock('Selected through menu', [1, 'menu']),
      menu: {
        opcode: 'sensing_of_object_menu',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {OBJECT: [sprite.name]},
        shadow: true,
        topLevel: false
      }
    };

    transform(project, 33);
    validateProject(project);

    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(variableNameByValue(sprite, 10));
    expect(variableNames(sprite)).not.toContain('Selected through menu');
  });

  it('treats an unimplemented official one-field shadow as its literal selector', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Sprite1';
    stage.variables = {hiddenBySpriteAttribute: ['x position', 17]};
    sprite.blocks = {
      sense: sensingBlock('x position', [1, 'menu']),
      menu: {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {TO: [sprite.name]},
        shadow: true,
        topLevel: false
      }
    };

    const resultStats = transform(project, 35);
    validateProject(project);

    expect(variableNameByValue(stage, 17)).toMatch(/^x_/u);
    expect(variableNames(stage)).not.toContain('x position');
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe('x position');
    expect(resultStats.warnings).toEqual([]);
  });

  it('treats a broadcast-menu primitive as its static field value', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.broadcasts = {spriteSelector: sprite.name};
    sprite.variables = {selected: ['Selected by broadcast primitive', 12]};
    sprite.blocks = {
      sense: sensingBlock('Selected by broadcast primitive', [1, [11, sprite.name, 'spriteSelector']])
    };

    const resultStats = transform(project, 31);
    validateProject(project);

    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(variableNameByValue(sprite, 12));
    expect(Object.values(stage.broadcasts)).toEqual([sprite.name]);
    expect(resultStats.caveats).toContain('Display names were preserved because typed menu fields are used as runtime reporter values.');
  });

  it('does not preserve a typed field which an implemented menu reporter does not return', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Unobserved typed value';
    stage.variables = {selector: [sprite.name, 'selector']};
    sprite.blocks = {
      sense: sensingBlock('missing property', [2, 'sound-menu']),
      'sound-menu': {
        opcode: 'sound_sounds_menu',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {VARIABLE: [sprite.name, 'selector']},
        shadow: false,
        topLevel: false
      }
    };

    const resultStats = transform(project, 49);
    validateProject(project);

    expect(variableNames(stage)).not.toContain(sprite.name);
    expect(resultStats.caveats).not.toContain(
      'Display names were preserved because typed menu fields are used as runtime reporter values.'
    );
  });

  it('preserves typed names only through inputs consumed by the owning core opcode', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {
      observed: ['Runtime-visible menu value', 'observed'],
      ignored: ['Ignored extra-input value', 'ignored']
    };
    sprite.blocks = {
      say: {
        opcode: 'looks_say',
        next: null,
        parent: null,
        inputs: {MESSAGE: [2, 'observed-menu'], IGNORED: [2, 'ignored-menu']},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      },
      'observed-menu': {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'say',
        inputs: {},
        fields: {VARIABLE: ['stale observed label', 'observed']},
        shadow: false,
        topLevel: false
      },
      'ignored-menu': {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'say',
        inputs: {},
        fields: {VARIABLE: ['stale ignored label', 'ignored']},
        shadow: false,
        topLevel: false
      }
    };

    const resultStats = transform(project, 51);
    validateProject(project);

    expect(variableNameByValue(stage, 'observed')).toBe('Runtime-visible menu value');
    expect(variableNameByValue(stage, 'ignored')).toMatch(/^x_/u);
    expect(resultStats.caveats).toContain(
      'Display names were preserved because typed menu fields are used as runtime reporter values.'
    );
  });

  it('resolves active name-only typed menu values through Stage declaration order', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {variableSelector: ['Name-only variable value', 'variable']};
    stage.lists = {listSelector: ['Name-only list value', []]};
    stage.broadcasts = {broadcastSelector: 'Name-only broadcast value'};
    sprite.blocks = {};
    for (const [ordinal, opcode, fieldName, field] of [
      [0, 'motion_goto_menu', 'VARIABLE', ['Name-only variable value']],
      [1, 'motion_goto_menu', 'LIST', ['Name-only list value', null]],
      [2, 'event_broadcast_menu', 'BROADCAST_OPTION', ['Name-only broadcast value', '']]
    ] as const) {
      const ownerId = `say-${ordinal}`;
      const menuId = `menu-${ordinal}`;
      sprite.blocks[ownerId] = {
        opcode: 'looks_say',
        next: null,
        parent: null,
        inputs: {MESSAGE: [2, menuId]},
        fields: {},
        shadow: false,
        topLevel: true,
        x: ordinal,
        y: 0
      };
      sprite.blocks[menuId] = {
        opcode,
        next: null,
        parent: ownerId,
        inputs: {},
        fields: {[fieldName]: [...field]},
        shadow: false,
        topLevel: false
      };
    }

    transform(project, 53);
    validateProject(project);

    expect(variableNameByValue(stage, 'variable')).toBe('Name-only variable value');
    expect(listNames(stage)).toContain('Name-only list value');
    expect(Object.values(stage.broadcasts)).toContain('Name-only broadcast value');
    const typedFields = Object.values(sprite.blocks)
      .filter(isScratchBlock)
      .flatMap(blockValue => Object.values(blockValue.fields))
      .filter(field => field.length === 2);
    expect(typedFields).toHaveLength(3);
    expect(typedFields.every(field => typeof field[1] === 'string' && field[1].length > 0)).toBe(true);
  });

  it('distinguishes consumed extension inputs from inputs on extension menu helpers', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    project.extensions = ['pen'];
    stage.variables = {
      consumed: ['Extension runtime value', 'consumed'],
      ignored: ['Extension ignored value', 'ignored']
    };
    sprite.blocks = {
      command: {
        opcode: 'pen_setPenSizeTo',
        next: null,
        parent: null,
        inputs: {SIZE: [2, 'consumed-menu']},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      },
      'consumed-menu': {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'command',
        inputs: {},
        fields: {VARIABLE: ['stale consumed label', 'consumed']},
        shadow: false,
        topLevel: false
      },
      'extension-menu': {
        opcode: 'pen_menu_colorParam',
        next: null,
        parent: null,
        inputs: {IGNORED: [2, 'ignored-menu']},
        fields: {colorParam: ['color']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      },
      'ignored-menu': {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'extension-menu',
        inputs: {},
        fields: {VARIABLE: ['stale ignored label', 'ignored']},
        shadow: false,
        topLevel: false
      }
    };

    transform(project, 55);
    validateProject(project);

    expect(variableNameByValue(stage, 'consumed')).toBe('Extension runtime value');
    expect(variableNameByValue(stage, 'ignored')).toMatch(/^x_/u);
  });

  it('uses a typed menu ID rather than a stale display value when selecting a sensing target', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const firstSprite = requireTarget(project, 1);
    firstSprite.name = 'Stale display target';
    firstSprite.variables = {selected: ['Selected through reconciled menu', 71]};
    const secondSprite = structuredClone(firstSprite);
    secondSprite.name = 'Declared broadcast target';
    secondSprite.variables = {selectedSecond: ['Selected through reconciled menu', 72]};
    secondSprite.blocks = {};
    project.targets.push(secondSprite);
    stage.broadcasts = {selector: secondSprite.name};
    firstSprite.blocks = {
      sense: sensingBlock(
        'Selected through reconciled menu',
        [1, [11, firstSprite.name, 'selector']]
      )
    };

    transform(project, 32);
    validateProject(project);

    const sense = Object.values(firstSprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined)
      .toBe(variableNameByValue(secondSprite, 72));
    expect(variableNameByValue(firstSprite, 71)).not.toBe(variableNameByValue(secondSprite, 72));
    expect(Object.values(stage.broadcasts)).toEqual([secondSprite.name]);
  });

  it.each([
    ['VARIABLE', true],
    ['VARIABLE', false],
    ['LIST', true],
    ['LIST', false]
  ] as const)('preserves only a %s name exposed by a one-field reporter with shadow=%s', (fieldName, shadow) => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Runtime menu target';
    sprite.variables = {selected: ['Selected property', 83]};
    stage.variables = {
      selectorVariable: [sprite.name, 'variable selector'],
      unrelatedVariable: ['Ordinary variable', 'ordinary']
    };
    stage.lists = {
      selectorList: [sprite.name, ['list selector']],
      unrelatedList: ['Ordinary list', ['ordinary']]
    };
    const symbolId = fieldName === 'VARIABLE' ? 'selectorVariable' : 'selectorList';
    sprite.blocks = {
      sense: sensingBlock('Selected property', [shadow ? 1 : 2, 'menu']),
      menu: {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {[fieldName]: ['stale display value', symbolId]},
        shadow,
        topLevel: false
      }
    };

    const resultStats = transform(project, shadow ? 45 : 47);
    validateProject(project);

    const selectorNames = fieldName === 'VARIABLE' ? variableNames(stage) : listNames(stage);
    expect(selectorNames).toContain(sprite.name);
    expect(variableNames(stage)).not.toContain('Ordinary variable');
    expect(listNames(stage)).not.toContain('Ordinary list');
    const menu = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'motion_goto_menu');
    expect(menu && isScratchBlock(menu) ? menu.fields[fieldName]?.[0] : undefined).toBe(sprite.name);
    expect(resultStats.caveats).toContain('Display names were preserved because typed menu fields are used as runtime reporter values.');
  });

  it('uses one shared opaque name for all scalars selected by a dynamic OBJECT', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {
      firstGlobal: ['Dynamic score', 1],
      duplicateGlobal: ['Dynamic score', 2]
    };
    sprite.variables = {
      firstLocal: ['Dynamic score', 3],
      duplicateLocal: ['Dynamic score', 4],
      selector: ['Target selector', '_stage_']
    };
    sprite.blocks = {
      sense: sensingBlock('Dynamic score', [1, [12, 'Target selector', 'selector']])
    };

    const resultStats = transform(project);
    validateProject(project);

    const sharedName = variableNameByValue(stage, 1);
    expect(sharedName).toBe(variableNameByValue(sprite, 3));
    expect(sharedName).not.toBe('Dynamic score');
    expect(variableNameByValue(stage, 2)).not.toBe(sharedName);
    expect(variableNameByValue(sprite, 4)).not.toBe(sharedName);
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(sharedName);
    expect(project.targets.flatMap(variableNames)).not.toContain('Dynamic score');
    expect(resultStats.warnings).toEqual([]);
  });

  it('keeps a dynamic group coupled to a genuine Stage cloud name', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {cloud: ['Externally coupled', 1, true]};
    sprite.variables = {
      selected: ['Externally coupled', 2],
      selector: ['Target selector', '_stage_']
    };
    sprite.blocks = {
      sense: sensingBlock('Externally coupled', [1, [12, 'Target selector', 'selector']])
    };

    const resultStats = transform(project);
    validateProject(project);

    expect(variableNameByValue(stage, 1)).toBe('Externally coupled');
    expect(variableNameByValue(sprite, 2)).toBe('Externally coupled');
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe('Externally coupled');
    expect(resultStats.caveats).toContain('Variable display names were preserved because the project uses name-based sensing.');
  });

  it('evaluates a nested constant target selector without preserving an unrelated cloud-coupled name', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Sprite1';
    stage.variables = {cloud: ['Shared sensing name', 1, true]};
    sprite.variables = {selected: ['Shared sensing name', 2]};
    sprite.blocks = {
      sense: sensingBlock('Shared sensing name', [2, 'selector']),
      selector: {
        opcode: 'operator_join',
        next: null,
        parent: 'sense',
        inputs: {STRING1: [1, [10, 'Sprite']], STRING2: [1, [10, '1']]},
        fields: {},
        shadow: false,
        topLevel: false
      }
    };

    const resultStats = transform(project, 43);
    validateProject(project);

    expect(variableNameByValue(stage, 1)).toBe('Shared sensing name');
    expect(variableNameByValue(sprite, 2)).toMatch(/^x_/u);
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(variableNameByValue(sprite, 2));
    expect(resultStats.warnings).toEqual([]);
  });

  it('evaluates a nested typed menu leaf without conservatively preserving a native-name collision', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {collidingName: ['x position', 64]};
    stage.broadcasts = {stageSelector: '_stage_'};
    sprite.blocks = {
      sense: sensingBlock('x position', [2, 'selector']),
      selector: {
        opcode: 'operator_join',
        next: null,
        parent: 'sense',
        inputs: {
          STRING1: [1, [10, '']],
          STRING2: [1, [11, 'stale selector label', 'stageSelector']]
        },
        fields: {},
        shadow: false,
        topLevel: false
      }
    };

    const resultStats = transform(project, 44);
    validateProject(project);

    const renamed = variableNameByValue(stage, 64);
    expect(renamed).toMatch(/^x_/u);
    expect(renamed).not.toBe('x position');
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe(renamed);
    expect(Object.values(stage.broadcasts)).toEqual(['_stage_']);
    expect(resultStats.caveats).not.toContain(
      'Variable display names were preserved because the project uses name-based sensing.'
    );
  });

  it('preserves a typed symbol name exposed through a bundled extension menu helper', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    sprite.name = 'Extension-selected target';
    stage.variables = {
      selector: [sprite.name, 'extension selector'],
      unrelated: ['Readable unrelated variable', 0]
    };
    project.extensions = ['pen'];
    sprite.blocks = {
      sense: sensingBlock('missing property', [1, 'extension-menu']),
      'extension-menu': {
        opcode: 'pen_menu_colorParam',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {VARIABLE: ['stale extension label', 'selector']},
        shadow: true,
        topLevel: false
      }
    };

    const resultStats = transform(project, 46);
    validateProject(project);

    expect(variableNameByValue(stage, 'extension selector')).toBe(sprite.name);
    expect(variableNameByValue(stage, 0)).toMatch(/^x_/u);
    expect(resultStats.caveats).toContain(
      'Display names were preserved because typed menu fields are used as runtime reporter values.'
    );
  });

  it('preserves only a reachable scalar when a dynamic selector can also mean a native attribute', () => {
    const project = dynamicAttributeFixture('x position');
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);

    const resultStats = transform(project);
    validateProject(project);

    expect(variableNameByValue(stage, 1)).toBe('x position');
    expect(variableNameByValue(sprite, 2)).not.toBe('x position');
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe('x position');
    expect(resultStats.caveats).toHaveLength(1);
  });

  it('renames same-named scalars which are hidden by native attributes in every possible target', () => {
    const project = dynamicAttributeFixture('volume');
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);

    const resultStats = transform(project);
    validateProject(project);

    expect(variableNameByValue(stage, 1)).not.toBe('volume');
    expect(variableNameByValue(sprite, 2)).not.toBe('volume');
    const sense = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sense && isScratchBlock(sense) ? sense.fields['PROPERTY']?.[0] : undefined).toBe('volume');
    expect(resultStats.warnings).toEqual([]);
  });

  it('rewrites static sensing monitor properties and treats literal Stage as a missing sprite', () => {
    const stageProject = emptyFixture();
    const stage = requireTarget(stageProject, 0);
    stage.variables = {
      selected: ['Monitor selected', 1],
      unrelated: ['Monitor unrelated', 2]
    };
    stageProject.monitors = [sensingMonitor('Monitor selected', '_stage_')];

    transform(stageProject);
    validateProject(stageProject);
    expect((stageProject.monitors[0]?.['params'] as Record<string, unknown>)['PROPERTY']).toBe(variableNameByValue(stage, 1));
    expect(variableNames(stage)).not.toContain('Monitor unrelated');

    const literalStageProject = emptyFixture();
    const literalStage = requireTarget(literalStageProject, 0);
    literalStage.variables = {selected: ['Not selected by Stage', 1]};
    literalStageProject.monitors = [sensingMonitor('Not selected by Stage', 'Stage')];
    const resultStats = transform(literalStageProject, 29);
    validateProject(literalStageProject);
    expect((literalStageProject.monitors[0]?.['params'] as Record<string, unknown>)['PROPERTY']).toBe('Not selected by Stage');
    expect(variableNames(literalStage)).not.toContain('Not selected by Stage');
    expect(resultStats.warnings).toEqual([]);
  });

  it('treats a missing monitor OBJECT as the fixed runtime value undefined', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    const sprite = requireTarget(project, 1);
    stage.variables = {selected: ['Unknown monitor target', 1]};
    sprite.variables = {selected: ['Unknown monitor target', 2]};
    const monitor = sensingMonitor('Unknown monitor target', '_stage_');
    delete (monitor['params'] as Record<string, unknown>)['OBJECT'];
    project.monitors = [monitor];

    const resultStats = transform(project, 37);

    const stageName = variableNameByValue(stage, 1);
    const spriteName = variableNameByValue(sprite, 2);
    expect(stageName).not.toBe('Unknown monitor target');
    expect(spriteName).not.toBe('Unknown monitor target');
    expect(stageName).not.toBe(spriteName);
    expect((project.monitors[0]?.['params'] as Record<string, unknown>)['PROPERTY']).toBe('Unknown monitor target');
    expect(resultStats.warnings).toEqual([]);
  });

  it('renames duplicate declarations and binds name-only fields to the runtime first match', () => {
    const project = emptyFixture();
    const stage = requireTarget(project, 0);
    stage.variables = {
      first: ['Duplicate variable', 1],
      second: ['Duplicate variable', 2],
      unrelated: ['Unrelated variable', 3]
    };
    stage.lists = {
      firstList: ['Duplicate list', []],
      secondList: ['Duplicate list', []],
      unrelatedList: ['Unrelated list', []]
    };
    stage.blocks = {
      variable: block('data_variable', {VARIABLE: ['Duplicate variable']}),
      list: block('data_listcontents', {LIST: ['Duplicate list', '']})
    };

    const resultStats = transform(project);

    expect(variableNames(stage)).not.toContain('Duplicate variable');
    expect(listNames(stage)).not.toContain('Duplicate list');
    expect(variableNames(stage)).not.toContain('Unrelated variable');
    expect(listNames(stage)).not.toContain('Unrelated list');
    const blocks = Object.values(stage.blocks).filter(isScratchBlock);
    const variableField = blocks.find(value => value.opcode === 'data_variable')?.fields['VARIABLE'];
    const listField = blocks.find(value => value.opcode === 'data_listcontents')?.fields['LIST'];
    const firstVariableId = Object.keys(stage.variables)[0];
    const firstListId = Object.keys(stage.lists)[0];
    expect(variableField).toEqual([stage.variables[firstVariableId ?? '']?.[0], firstVariableId]);
    expect(listField).toEqual([stage.lists[firstListId ?? '']?.[0], firstListId]);
    expect(resultStats.warnings).toEqual([]);
  });
});

function emptyFixture(): ScratchProject {
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

function dynamicAttributeFixture(property: string): ScratchProject {
  const project = emptyFixture();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.variables = {stageValue: [property, 1]};
  sprite.variables = {
    spriteValue: [property, 2],
    selector: ['Target selector', '_stage_']
  };
  sprite.blocks = {sense: sensingBlock(property, [1, [12, 'Target selector', 'selector']])};
  return project;
}

function sensingBlock(property: string, object: ScratchInput): ScratchBlock {
  return {
    opcode: 'sensing_of',
    next: null,
    parent: null,
    inputs: {OBJECT: object},
    fields: {PROPERTY: [property]},
    shadow: false,
    topLevel: true,
    x: 1,
    y: 1
  };
}

function sensingMonitor(property: string, object: string): ScratchProject['monitors'][number] {
  return {
    id: `sense-${property}`,
    mode: 'default',
    opcode: 'sensing_of',
    params: {PROPERTY: property, OBJECT: object},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: true,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}

function block(opcode: string, fields: ScratchBlock['fields']): ScratchBlock {
  return {opcode, next: null, parent: null, inputs: {}, fields, shadow: false, topLevel: true, x: 1, y: 1};
}

function transform(project: ScratchProject, seed = 23): ObfuscationStats {
  const resultStats: ObfuscationStats = {
    mode: 'lossless',
    blocksBefore: Object.values(project.targets).reduce((sum, target) => sum + Object.keys(target.blocks).length, 0),
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
    new DeterministicGenerator(new Uint8Array(32).fill(seed), `name-obfuscation:${seed}`),
    resultStats
  );
  return resultStats;
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

function listNames(target: ScratchTarget): string[] {
  return Object.values(target.lists).flatMap(declaration => (
    typeof declaration[0] === 'string' ? [declaration[0]] : []
  ));
}

function variableNameByValue(target: ScratchTarget, value: unknown): string | undefined {
  return Object.values(target.variables).find(declaration => declaration[1] === value)?.[0] as string | undefined;
}
