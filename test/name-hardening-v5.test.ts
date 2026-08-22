import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {collectVariableCandidates} from '../src/obfuscation/analysis.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import type {ObfuscationStats, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {OFFICIAL_EXTENSION_OPCODES} from '../src/validation/extensions.js';
import {createFixtureProject} from './support.js';

describe('name hardening v5', () => {
  it('renames typed symbols attached only to unknown inputs across the complete pinned extension surface', () => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    stage.variables = {ignored: ['Readable ignored extension value', sprite.name]};
    project.extensions = [...OFFICIAL_EXTENSION_OPCODES.keys()];

    let ordinal = 0;
    for (const opcodes of OFFICIAL_EXTENSION_OPCODES.values()) {
      for (const opcode of opcodes) {
        const ownerId = `owner-${ordinal}`;
        const menuId = `menu-${ordinal}`;
        sprite.blocks[ownerId] = command(opcode, {IGNORED: [2, menuId]}, ordinal);
        sprite.blocks[menuId] = typedMenu(ownerId, 'ignored');
        ordinal += 1;
      }
    }

    transform(project, 0x51);

    expect(stageVariableNameByValue(stage, sprite.name)).toMatch(/^x_/u);
    expect(stageVariableNameByValue(stage, sprite.name)).not.toBe('Readable ignored extension value');
  });

  it.each([
    ['boost', 'boost_motorOnFor', 'DURATION'],
    ['ev3', 'ev3_beep', 'NOTE'],
    ['faceSensing', 'faceSensing_goToPart', 'PART'],
    ['gdxfor', 'gdxfor_getTilt', 'TILT'],
    ['makeymakey', 'makeymakey_whenCodePressed', 'SEQUENCE'],
    ['microbit', 'microbit_displayText', 'TEXT'],
    ['music', 'music_playNoteForBeats', 'NOTE'],
    ['pen', 'pen_setPenSizeTo', 'SIZE'],
    ['text2speech', 'text2speech_speakAndWait', 'WORDS'],
    ['translate', 'translate_getTranslate', 'WORDS'],
    ['videoSensing', 'videoSensing_videoOn', 'SUBJECT'],
    ['wedo2', 'wedo2_playNoteFor', 'NOTE']
  ] as const)('preserves a typed value consumed by the %s extension', (extensionId, opcode, inputName) => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    const visibleName = `Runtime value for ${extensionId}`;
    stage.variables = {consumed: [visibleName, sprite.name]};
    project.extensions = [extensionId];
    sprite.blocks = {
      owner: command(opcode, {[inputName]: [2, 'menu']}, 0),
      menu: typedMenu('owner', 'consumed')
    };

    transform(project, inputName.length);

    expect(stageVariableNameByValue(stage, sprite.name)).toBe(visibleName);
  });

  it('uses prototype argument IDs to ignore extra custom-call inputs without missing consumed inputs', () => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    stage.variables = {
      consumed: ['Consumed custom-call value', 'consumed'],
      ignored: ['Ignored custom-call value', 'ignored']
    };
    appendProcedure(sprite, 0, 'invoke %s', 'parameter');
    const call = sprite.blocks['call-0'];
    if (!isScratchBlock(call)) throw new Error('procedure call fixture missing');
    call.inputs['arg-0'] = [2, 'consumed-menu'];
    call.inputs['IGNORED'] = [2, 'ignored-menu'];
    sprite.blocks['consumed-menu'] = typedMenu('call-0', 'consumed');
    sprite.blocks['ignored-menu'] = typedMenu('call-0', 'ignored');

    transform(project, 0x52);

    expect(stageVariableNameByValue(stage, 'consumed')).toBe('Consumed custom-call value');
    expect(stageVariableNameByValue(stage, 'ignored')).toMatch(/^x_/u);
  });

  it('preserves typed call inputs when duplicate prototype signatures make consumption ambiguous', () => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    stage.variables = {ambiguous: ['Ambiguous custom-call value', 'ambiguous']};
    appendProcedure(sprite, 0, 'duplicate %s', 'first');
    appendProcedure(sprite, 1, 'duplicate %s', 'second');
    const secondPrototype = sprite.blocks['prototype-1'];
    const secondCall = sprite.blocks['call-1'];
    if (!isScratchBlock(secondPrototype) || !isScratchBlock(secondCall) || !secondPrototype.mutation || !secondCall.mutation) {
      throw new Error('duplicate procedure fixture missing');
    }
    secondPrototype.mutation['argumentids'] = '["AMBIGUOUS"]';
    secondPrototype.inputs = {AMBIGUOUS: secondPrototype.inputs['arg-1'] ?? [1, [10, '']]};
    secondCall.mutation['argumentids'] = '["AMBIGUOUS"]';
    secondCall.inputs = {AMBIGUOUS: [2, 'ambiguous-menu']};
    sprite.blocks['ambiguous-menu'] = typedMenu('call-1', 'ambiguous');

    transform(project, 0x54);

    expect(stageVariableNameByValue(stage, 'ambiguous')).toBe('Ambiguous custom-call value');
  });

  it('renames valid procedure regions independently and gives same-named arguments unlinkable labels', () => {
    const source = emptyProject();
    const sprite = requiredTarget(source, 1);
    appendProcedure(sprite, 0, 'first %s', 'shared argument');
    appendProcedure(sprite, 1, 'second %s', 'shared argument');
    appendProcedure(sprite, 2, 'broken %s', 'shared argument', true);
    sprite.blocks['orphan-reporter'] = {
      opcode: 'argument_reporter_string_number',
      next: null,
      parent: null,
      inputs: {},
      fields: {VALUE: ['shared argument', null]},
      shadow: false,
      topLevel: true,
      x: 90,
      y: 90
    };
    const left = structuredClone(source);
    const right = structuredClone(source);
    const leftStats = transform(left, 0x53);
    transform(right, 0x53);

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    const transformed = requiredTarget(left, 1);
    const prototypes = Object.values(transformed.blocks)
      .filter(isScratchBlock)
      .filter(block => block.opcode === 'procedures_prototype');
    const safePrototypes = prototypes.filter(block => block.mutation?.['proccode'] !== 'broken %s');
    expect(safePrototypes).toHaveLength(2);
    expect(safePrototypes.map(block => block.mutation?.['proccode'])).not.toContain('first %s');
    expect(safePrototypes.map(block => block.mutation?.['proccode'])).not.toContain('second %s');
    const safeArgumentNames = safePrototypes.map(block => {
      const serializedNames = block.mutation?.['argumentnames'];
      if (typeof serializedNames !== 'string') throw new Error('serialized argument names missing');
      const names = JSON.parse(serializedNames) as unknown;
      if (!Array.isArray(names) || typeof names[0] !== 'string') throw new Error('renamed arguments missing');
      return names[0];
    });
    expect(new Set(safeArgumentNames).size).toBe(2);
    expect(safeArgumentNames).not.toContain('shared argument');

    const reporterNames = Object.values(transformed.blocks)
      .filter(isScratchBlock)
      .filter(block => block.opcode.startsWith('argument_reporter_'))
      .map(block => block.fields['VALUE']?.[0]);
    for (const name of safeArgumentNames) expect(reporterNames.filter(candidate => candidate === name)).toHaveLength(2);
    expect(reporterNames.filter(name => name === 'shared argument')).toHaveLength(3);
    expect(prototypes.find(block => block.mutation?.['proccode'] === 'broken %s')?.mutation?.['argumentnames'])
      .toBe('["shared argument"]');
    expect(leftStats.warnings).toContain(
      `Skipped procedure renaming in ${JSON.stringify(sprite.name)} because its prototype metadata is ambiguous.`
    );
  });

  it('evaluates nested constant sensing targets before excluding variables from virtualization', () => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    stage.variables = {global: ['Shared sensed name', 1]};
    sprite.variables = {local: ['Shared sensed name', 2]};
    sprite.blocks = {
      sense: {
        opcode: 'sensing_of',
        next: null,
        parent: null,
        inputs: {OBJECT: [2, 'selector']},
        fields: {PROPERTY: ['Shared sensed name']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      },
      selector: {
        opcode: 'operator_join',
        next: null,
        parent: 'sense',
        inputs: {STRING1: [1, [10, 'Visible ']], STRING2: [1, [10, 'Sprite']]},
        fields: {},
        shadow: false,
        topLevel: false
      }
    };

    const candidates = collectVariableCandidates(project);

    expect(candidates.map(candidate => candidate.id)).toContain('global');
    expect(candidates.map(candidate => candidate.id)).not.toContain('local');
  });

  it('uses the sole field of an unimplemented official shadow regardless of its field key', () => {
    const project = emptyProject();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    stage.variables = {global: ['x position', 1]};
    sprite.blocks = {
      sense: {
        opcode: 'sensing_of',
        next: null,
        parent: null,
        inputs: {OBJECT: [1, 'selector']},
        fields: {PROPERTY: ['x position']},
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
      },
      selector: {
        opcode: 'motion_goto_menu',
        next: null,
        parent: 'sense',
        inputs: {},
        fields: {FAKE: [sprite.name]},
        shadow: true,
        topLevel: false
      }
    };

    expect(collectVariableCandidates(project).map(candidate => candidate.id)).toContain('global');
  });
});

function emptyProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requiredTarget(project, 0);
  const sprite = requiredTarget(project, 1);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.blocks = {};
  sprite.comments = {};
  project.monitors = [];
  project.extensions = [];
  return project;
}

function appendProcedure(
  target: ScratchTarget,
  ordinal: number,
  code: string,
  argumentName: string,
  malformed = false
): void {
  const definitionId = `definition-${ordinal}`;
  const prototypeId = `prototype-${ordinal}`;
  const prototypeReporterId = `prototype-reporter-${ordinal}`;
  const bodyId = `body-${ordinal}`;
  const bodyReporterId = `body-reporter-${ordinal}`;
  const callId = `call-${ordinal}`;
  const argumentId = `arg-${ordinal}`;
  target.blocks[definitionId] = {
    opcode: 'procedures_definition',
    next: bodyId,
    parent: null,
    inputs: {custom_block: [1, prototypeId]},
    fields: {},
    shadow: false,
    topLevel: true,
    x: ordinal,
    y: 0
  };
  target.blocks[prototypeId] = {
    opcode: 'procedures_prototype',
    next: null,
    parent: definitionId,
    inputs: {[argumentId]: [1, prototypeReporterId]},
    fields: {},
    shadow: true,
    topLevel: false,
    mutation: {
      proccode: code,
      argumentids: malformed ? '[' : JSON.stringify([argumentId]),
      argumentnames: JSON.stringify([argumentName]),
      argumentdefaults: '[""]'
    }
  };
  target.blocks[prototypeReporterId] = argumentReporter(prototypeId, argumentName, true);
  target.blocks[bodyId] = {
    opcode: 'looks_say',
    next: null,
    parent: definitionId,
    inputs: {MESSAGE: [2, bodyReporterId]},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[bodyReporterId] = argumentReporter(bodyId, argumentName, false);
  target.blocks[callId] = {
    opcode: 'procedures_call',
    next: null,
    parent: null,
    inputs: {[argumentId]: [1, [10, `value-${ordinal}`]]},
    fields: {},
    shadow: false,
    topLevel: true,
    x: ordinal,
    y: 30,
    mutation: {proccode: code, argumentids: JSON.stringify([argumentId])}
  };
}

function argumentReporter(parent: string, name: string, shadow: boolean): ScratchBlock {
  return {
    opcode: 'argument_reporter_string_number',
    next: null,
    parent,
    inputs: {},
    fields: {VALUE: [name, null]},
    shadow,
    topLevel: false
  };
}

function command(opcode: string, inputs: ScratchBlock['inputs'], ordinal: number): ScratchBlock {
  return {
    opcode,
    next: null,
    parent: null,
    inputs,
    fields: {},
    shadow: false,
    topLevel: true,
    x: ordinal,
    y: 0
  };
}

function typedMenu(parent: string, variableId: string): ScratchBlock {
  return {
    opcode: 'motion_goto_menu',
    next: null,
    parent,
    inputs: {},
    fields: {VARIABLE: ['stale display value', variableId]},
    shadow: false,
    topLevel: false
  };
}

function transform(project: ScratchProject, seed: number): ObfuscationStats {
  const stats: ObfuscationStats = {
    mode: 'lossless',
    blocksBefore: 0,
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
    new DeterministicGenerator(new Uint8Array(32).fill(seed), `name-hardening-v5:${seed}`),
    stats
  );
  return stats;
}

function requiredTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing fixture target ${index}`);
  return target;
}

function stageVariableNameByValue(stage: ScratchTarget, expectedValue: string): string | undefined {
  return Object.values(stage.variables).find(declaration => declaration[1] === expectedValue)?.[0] as string | undefined;
}
