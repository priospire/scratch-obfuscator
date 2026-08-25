import {describe, expect, it} from 'vitest';
import {serializeProjectPayload} from '../src/archive/writer.js';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {JsonValue, ObfuscationMode, ObfuscationStats, ScratchBlock, ScratchProject} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';

function projectFixture(): ScratchProject {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {
          score: ['Score', 0],
          cloud: ['☁ cloud score', 2, true]
        },
        lists: {items: ['Items', ['a', 2]]},
        broadcasts: {message: 'Launch'},
        blocks: {
          hat: {
            opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 120, y: 90, comment: 'comment'
          },
          set: {
            opcode: 'data_setvariableto', next: 'say', parent: 'hat', inputs: {VALUE: [1, [4, '4']]}, fields: {VARIABLE: ['Score', 'score']}, shadow: false, topLevel: false
          },
          say: {
            opcode: 'looks_say', next: null, parent: 'set', inputs: {MESSAGE: [3, 'variable', [10, 'visible fallback']]}, fields: {}, shadow: false, topLevel: false
          },
          variable: [12, 'Score', 'score'],
          list: [13, 'Items', 'items', 300, 400]
        },
        comments: {
          comment: {blockId: 'hat', x: 0, y: 0, width: 100, height: 100, minimized: false, text: 'explanation'}
        },
        currentCostume: 0,
        costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: 'backdrop1'}],
        sounds: []
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {local: ['Local', 1]},
        lists: {},
        broadcasts: {},
        blocks: {
          broadcast: {
            opcode: 'event_broadcast', next: null, parent: null,
            inputs: {BROADCAST_INPUT: [1, [11, 'Launch', 'message']]}, fields: {}, shadow: false, topLevel: true, x: -40, y: 5
          }
        },
        comments: {},
        currentCostume: 0,
        costumes: [{assetId: '1'.repeat(32), dataFormat: 'svg', name: 'costume1'}],
        sounds: []
      }
    ],
    monitors: [{id: 'score', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'Score'}, spriteName: null, value: 0, width: 0, height: 0, x: 5, y: 6, visible: true}],
    extensions: [],
    meta: {semver: '3.0.0'}
  };
}

function stats(): ObfuscationStats {
  return {mode: 'lossless', blocksBefore: 6, blocksAfter: 6, identifiersRenamed: 0, symbolsRenamed: 0, commentsRemoved: 0, decoysAdded: 0, virtualizedBlocks: 0, warnings: []};
}

describe('common lossless transforms', () => {
  it('exposes an immutable, validated lossless project API', () => {
    const source = projectFixture();
    const sourceJson = JSON.stringify(source);
    const result = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(11));
    expect(JSON.stringify(source)).toBe(sourceJson);
    expect(result.stats.mode).toBe('lossless');
    expect(result.stats.blocksAfter).toBe(result.stats.blocksBefore - 1);
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    expect(result.project).not.toBe(source);
    validateProject(result.project);
  });

  it('keeps a nontrivial lossless project identical when expanded growth is requested', () => {
    const source = projectFixture();
    const seed = new Uint8Array(32).fill(0x2a);
    const compact = obfuscateProject(source, 'lossless', seed);
    const expanded = obfuscateProject(source, 'lossless', seed, {allowSize: true});

    expect(expanded.project).toEqual(compact.project);
    expect(expanded.stats).toEqual(compact.stats);
    validateProject(expanded.project);
  });

  it('keeps lossless anti-cheat output byte-identical when expanded growth is requested', () => {
    const source = projectFixture();
    const seed = new Uint8Array(32).fill(0x2b);
    const compact = obfuscateProject(source, 'lossless', seed, {antiCheat: true});
    const expanded = obfuscateProject(source, 'lossless', seed, {antiCheat: true, allowSize: true});

    expect(expanded.project).toEqual(compact.project);
    expect(serializeProjectPayload(expanded.project)).toEqual(serializeProjectPayload(compact.project));
    validateProject(expanded.project);
  });

  it('normalizes an inactive object-shadow with serializer-style null ownership', () => {
    const source = projectFixture();
    const stage = source.targets[0];
    const say = stage?.blocks['say'];
    if (!stage || !isScratchBlock(say)) throw new Error('fixture blocks missing');
    say.inputs['MESSAGE'] = [3, 'variable', 'orphanShadow'];
    stage.blocks['orphanShadow'] = {
      opcode: 'text', next: null, parent: null, inputs: {}, fields: {TEXT: ['hidden fallback']},
      shadow: true, topLevel: true, x: 0, y: 0
    };

    expect(() => validateProject(source)).toThrow(/top-level block must not have an incoming block edge/);
    const result = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(12));

    expect(result.project.targets[0]?.blocks['orphanShadow']).toBeUndefined();
    expect(result.stats.inactiveFallbacksRemoved).toBe(1);
    validateProject(result.project);
  });

  it('preserves a mode-3 primitive fallback when the active slot is null', () => {
    const source = projectFixture();
    const stage = source.targets[0];
    const say = stage?.blocks['say'];
    if (!stage || !isScratchBlock(say)) throw new Error('fixture blocks missing');
    say.inputs['MESSAGE'] = [3, null, [10, 'runtime fallback']];

    const result = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x35));
    const transformedSay = Object.values(result.project.targets[0]?.blocks ?? {})
      .find(value => isScratchBlock(value) && value.opcode === 'looks_say');

    expect(transformedSay && isScratchBlock(transformedSay)
      ? transformedSay.inputs['MESSAGE']
      : undefined).toEqual([3, null, [10, 'runtime fallback']]);
    validateProject(result.project);
  });

  it('disambiguates duplicate local symbol IDs from separate sprites before strict output validation', () => {
    const source = projectFixture();
    const first = source.targets[1];
    if (!first) throw new Error('fixture sprite missing');
    first.variables = {shared_local_id: ['First local', 1]};
    first.blocks = {
      firstReporter: {
        opcode: 'data_variable', next: null, parent: null, inputs: {},
        fields: {VARIABLE: ['First local', 'shared_local_id']},
        shadow: false, topLevel: true, x: 1, y: 1
      }
    };
    const second = structuredClone(first);
    second.name = 'Sprite2';
    second.variables = {shared_local_id: ['Second local', 2]};
    const secondReporter = second.blocks['firstReporter'];
    if (!secondReporter || !isScratchBlock(secondReporter)) throw new Error('fixture reporter missing');
    secondReporter.fields['VARIABLE'] = ['Second local', 'shared_local_id'];
    source.targets.push(second);
    const before = JSON.stringify(source);

    const result = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(0x4d));

    expect(JSON.stringify(source)).toBe(before);
    validateProject(result.project);
    const transformedSprites = result.project.targets.filter(target => !target.isStage);
    const localIds = transformedSprites.map(target => Object.keys(target.variables)[0]);
    expect(new Set(localIds).size).toBe(2);
    expect(localIds.every(id => typeof id === 'string' && id.startsWith('v_'))).toBe(true);
    for (let index = 0; index < transformedSprites.length; index += 1) {
      const target = transformedSprites[index];
      const localId = localIds[index];
      if (!target || !localId) throw new Error('transformed local symbol missing');
      const reporter = Object.values(target.blocks).find(value => isScratchBlock(value) && value.opcode === 'data_variable');
      expect(reporter && isScratchBlock(reporter) ? reporter.fields['VARIABLE']?.[1] : undefined).toBe(localId);
    }
  });

  it.each<ObfuscationMode>(['lossy', 'no-preserve'])('returns a valid bounded project in %s mode', mode => {
    const source = projectFixture();
    const result = obfuscateProject(source, mode, new Uint8Array(32).fill(29));
    validateProject(result.project);
    const maximum = mode === 'lossy'
      ? Math.max(result.stats.blocksBefore, Math.min(result.stats.blocksBefore * 2, 30_000))
      : Math.max(result.stats.blocksBefore, Math.min((result.stats.blocksBefore * 3) + 512, 30_000));
    expect(result.stats.blocksAfter).toBeLessThanOrEqual(maximum);
    expect(result.stats.blocksAfter).toBeGreaterThanOrEqual(result.stats.blocksBefore);
  });

  it('remaps every typed reference while retaining graph and dictionary order', () => {
    const project = projectFixture();
    const originalOpcodes = project.targets.map(target => Object.values(target.blocks).map(value => Array.isArray(value) ? value[0] : value.opcode));
    const resultStats = stats();
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(7), 'test'), resultStats);

    validateProject(project);
    expect(project.targets.map(target => Object.values(target.blocks).map(value => Array.isArray(value) ? value[0] : value.opcode))).toEqual(originalOpcodes);
    const stage = project.targets[0];
    expect(stage).toBeDefined();
    if (!stage) return;
    expect(Object.keys(stage.blocks).every(id => id.startsWith('b_'))).toBe(true);
    expect(Object.keys(stage.variables).every(id => id.startsWith('v_'))).toBe(true);
    expect(Object.keys(stage.lists).every(id => id.startsWith('l_'))).toBe(true);
    expect(Object.keys(stage.broadcasts).every(id => id.startsWith('c_'))).toBe(true);
    expect(Object.keys(stage.comments)).toEqual([]);
    expect(Object.values(stage.blocks).filter(value => !Array.isArray(value) && value.topLevel).every(value => !Array.isArray(value) && value.x === 0 && value.y === 0)).toBe(true);
    expect(Object.values(stage.variables).find(tuple => tuple[2] === true)?.[0]).toBe('☁ cloud score');
    expect(Object.values(stage.broadcasts)[0]).toMatch(/^x_/);
    expect(Object.values(stage.broadcasts)).not.toContain('Launch');
    expect(resultStats.commentsRemoved).toBe(1);
    expect(resultStats.identifiersRenamed).toBeGreaterThan(6);

    const variableId = Object.keys(stage.variables).find(id => stage.variables[id]?.[2] !== true);
    expect(project.monitors[0]?.['id']).toBe(variableId);
    expect(project.monitors[0]?.['params']).toEqual({VARIABLE: stage.variables[variableId ?? '']?.[0]});
    const say = Object.values(stage.blocks).find(value => !Array.isArray(value) && value.opcode === 'looks_say');
    expect(say && !Array.isArray(say) ? say.inputs['MESSAGE']?.[2] : undefined).not.toEqual([10, 'visible fallback']);
  });

  it('rewrites unique name-only fields to Stage symbols and ignores sprite decoys', () => {
    const project = projectFixture();
    const stage = project.targets[0];
    const sprite = project.targets[1];
    if (!stage || !sprite) throw new Error('fixture targets missing');
    sprite.variables['local'] = ['Score', 1];
    sprite.broadcasts['decoyMessage'] = 'Launch';
    sprite.blocks = {
      stageVariable: {opcode: 'data_variable', next: 'stageList', parent: null, inputs: {}, fields: {VARIABLE: ['Score']}, shadow: false, topLevel: true, x: 1, y: 1},
      stageList: {opcode: 'data_listcontents', next: 'stageBroadcast', parent: 'stageVariable', inputs: {}, fields: {LIST: ['Items', null]}, shadow: false, topLevel: false},
      stageBroadcast: {opcode: 'event_whenbroadcastreceived', next: null, parent: 'stageList', inputs: {}, fields: {BROADCAST_OPTION: ['Launch', '']}, shadow: false, topLevel: false}
    };
    validateProject(project);

    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(17), 'name-only'), stats());
    validateProject(project);

    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    const variableField = blocks.find(block => block.opcode === 'data_variable')?.fields['VARIABLE'];
    const listField = blocks.find(block => block.opcode === 'data_listcontents')?.fields['LIST'];
    const broadcastField = blocks.find(block => block.opcode === 'event_whenbroadcastreceived')?.fields['BROADCAST_OPTION'];
    const stageVariableId = Object.keys(stage.variables).find(id => stage.variables[id]?.[2] !== true);
    const stageListId = Object.keys(stage.lists)[0];
    const stageBroadcastId = Object.keys(stage.broadcasts)[0];
    expect(variableField).toEqual([stage.variables[stageVariableId ?? '']?.[0], stageVariableId]);
    expect(listField).toEqual([stage.lists[stageListId ?? '']?.[0], stageListId]);
    expect(broadcastField).toEqual([stage.broadcasts[stageBroadcastId ?? ''], stageBroadcastId]);
  });

  it('renames static broadcast names but freezes the Stage namespace for a computed broadcast input', () => {
    const staticProject = projectFixture();
    const staticStage = staticProject.targets[0];
    const staticSprite = staticProject.targets[1];
    if (!staticStage || !staticSprite) throw new Error('fixture targets missing');
    staticStage.broadcasts['duplicate-message'] = 'LAUNCH';
    staticStage.broadcasts['unicode-message'] = 'Σ';
    staticStage.broadcasts['unicode-equivalent-message'] = 'ς';
    staticSprite.broadcasts['unused-local-message'] = 'Readable local message';
    applyCommonTransforms(staticProject, new DeterministicGenerator(new Uint8Array(32).fill(18), 'static-broadcast'), stats());
    expect(Object.values(staticStage?.broadcasts ?? {})).not.toContain('Launch');
    const stageNames = Object.values(staticStage.broadcasts);
    const spriteNames = Object.values(staticSprite.broadcasts);
    expect(stageNames[0]).toBe(stageNames[1]);
    expect(stageNames[2]).toBe(stageNames[3]);
    expect(stageNames[2]).not.toBe(stageNames[0]);
    expect(spriteNames[0]).toMatch(/^x_/u);
    expect(spriteNames[0]).not.toBe('Readable local message');

    const dynamicProject = projectFixture();
    const sprite = dynamicProject.targets[1];
    const broadcast = sprite?.blocks['broadcast'];
    if (!sprite || !broadcast || Array.isArray(broadcast)) throw new Error('fixture broadcast block missing');
    broadcast.inputs['BROADCAST_INPUT'] = [3, 'computed-broadcast', [11, 'Launch', 'message']];
    sprite.blocks['computed-broadcast'] = {
      opcode: 'sensing_answer', next: null, parent: 'broadcast', inputs: {}, fields: {}, shadow: false, topLevel: false
    };
    sprite.broadcasts['local-message'] = 'LAUNCH';
    validateProject(dynamicProject);
    applyCommonTransforms(dynamicProject, new DeterministicGenerator(new Uint8Array(32).fill(18), 'dynamic-broadcast'), stats());
    expect(Object.values(dynamicProject.targets[0]?.broadcasts ?? {})).toEqual(['Launch']);
    expect(Object.values(sprite.broadcasts)[0]).toMatch(/^x_/u);
    expect(Object.values(sprite.broadcasts)).not.toContain('LAUNCH');
  });

  it('rewrites a stale typed broadcast name through its Stage ID', () => {
    const project = projectFixture();
    const sprite = project.targets[1];
    const broadcast = sprite?.blocks['broadcast'];
    if (!sprite || !broadcast || !isScratchBlock(broadcast)) throw new Error('fixture broadcast block missing');
    broadcast.inputs['BROADCAST_INPUT'] = [1, [11, 'lAuNcH', 'message']];
    validateProject(project);

    applyCommonTransforms(
      project,
      new DeterministicGenerator(new Uint8Array(32).fill(18), 'static-text-broadcast'),
      stats()
    );
    validateProject(project);

    const stageBroadcastName = Object.values(project.targets[0]?.broadcasts ?? {})[0];
    expect(stageBroadcastName).toMatch(/^x_/u);
    const transformed = Object.values(sprite.blocks).find(value => (
      isScratchBlock(value) && value.opcode === 'event_broadcast'
    ));
    if (!transformed || !isScratchBlock(transformed)) throw new Error('transformed broadcast block missing');
    expect(inputPrimitive(transformed, 'BROADCAST_INPUT', 1)).toEqual([
      11,
      stageBroadcastName,
      Object.keys(project.targets[0]?.broadcasts ?? {})[0]
    ]);
  });

  it('preserves only fixed computed or constrained-literal channels', () => {
    const project = projectFixture();
    const stage = project.targets[0];
    const sprite = project.targets[1];
    const broadcast = sprite?.blocks['broadcast'];
    if (!stage || !sprite || !broadcast || !isScratchBlock(broadcast)) throw new Error('fixture targets missing');
    stage.broadcasts['numeric-message'] = '5';
    stage.broadcasts['unrelated-message'] = 'Unrelated';
    broadcast.inputs['BROADCAST_INPUT'] = [2, 'computed-name'];
    sprite.blocks['computed-name'] = {
      opcode: 'operator_join', next: null, parent: 'broadcast',
      inputs: {STRING1: [1, [10, 'La']], STRING2: [1, [10, 'unch']]},
      fields: {}, shadow: false, topLevel: false
    };
    sprite.blocks['numeric-broadcast'] = {
      opcode: 'event_broadcast', next: null, parent: null,
      inputs: {BROADCAST_INPUT: [3, 'numeric-name', [11, '5', 'numeric-message']]},
      fields: {}, shadow: false, topLevel: true, x: 1, y: 1
    };
    sprite.blocks['numeric-name'] = {
      opcode: 'operator_add', next: null, parent: 'numeric-broadcast',
      inputs: {NUM1: [1, [4, 2]], NUM2: [1, [4, 3]]}, fields: {}, shadow: false, topLevel: false
    };
    validateProject(project);

    const resultStats = stats();
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(21), 'fixed-broadcast'), resultStats);
    validateProject(project);

    const names = Object.values(stage.broadcasts);
    expect(names).toContain('Launch');
    expect(names).toContain('5');
    expect(names).not.toContain('Unrelated');
    expect(names.find(name => name !== 'Launch' && name !== '5')).toMatch(/^x_/u);
    expect(Object.values(sprite.blocks).some(value => isScratchBlock(value) && value.opcode === 'operator_add')).toBe(true);
    expect(resultStats.caveats).toContain('Broadcast display names were preserved because the project computes broadcast names at runtime.');
  });

  it('keeps empty and unmatched fixed selectors inert under generated-name collisions', () => {
    const generator = new DeterministicGenerator(new Uint8Array(32).fill(22), 'broadcast-collision');
    const probe = projectFixture();
    applyCommonTransforms(probe, generator, stats());
    const collidingSelector = Object.values(probe.targets[0]?.broadcasts ?? {})[0];
    if (typeof collidingSelector !== 'string') throw new Error('probe broadcast name missing');

    const project = projectFixture();
    const stage = project.targets[0];
    const sprite = project.targets[1];
    const broadcast = sprite?.blocks['broadcast'];
    if (!stage || !sprite || !broadcast || !isScratchBlock(broadcast)) throw new Error('fixture targets missing');
    stage.broadcasts['empty-message'] = '';
    const split = Math.floor(collidingSelector.length / 2);
    broadcast.inputs['BROADCAST_INPUT'] = [3, 'colliding-name', [11, 'Launch', 'message']];
    sprite.blocks['colliding-name'] = {
      opcode: 'operator_join', next: null, parent: 'broadcast',
      inputs: {
        STRING1: [1, [10, collidingSelector.slice(0, split)]],
        STRING2: [1, [10, collidingSelector.slice(split)]]
      },
      fields: {}, shadow: false, topLevel: false
    };
    sprite.blocks['empty-broadcast'] = {
      opcode: 'event_broadcast', next: null, parent: null,
      inputs: {BROADCAST_INPUT: [3, 'empty-name', [11, '', 'empty-message']]},
      fields: {}, shadow: false, topLevel: true, x: 1, y: 1
    };
    sprite.blocks['empty-name'] = {
      opcode: 'operator_join', next: null, parent: 'empty-broadcast',
      inputs: {STRING1: [1, [10, '']], STRING2: [1, [10, '']]},
      fields: {}, shadow: false, topLevel: false
    };
    validateProject(project);

    applyCommonTransforms(
      project,
      new DeterministicGenerator(new Uint8Array(32).fill(22), 'broadcast-collision'),
      stats()
    );
    validateProject(project);

    expect(Object.values(stage.broadcasts).some(name => name.toLowerCase() === collidingSelector.toLowerCase())).toBe(false);
    const selectors = Object.values(sprite.blocks)
      .filter(value => isScratchBlock(value) && value.opcode === 'operator_join')
      .map(value => isScratchBlock(value) ? joinedLiteral(value) : undefined);
    expect(selectors).toContain(collidingSelector);
    expect(selectors).toContain('');
  });

  it('is deterministic for the same project and seed', () => {
    const left = projectFixture();
    const right = projectFixture();
    applyCommonTransforms(left, new DeterministicGenerator(new Uint8Array(32).fill(19), 'common'), stats());
    applyCommonTransforms(right, new DeterministicGenerator(new Uint8Array(32).fill(19), 'common'), stats());
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it('does not freeze unrelated Stage names for a missing sprite property', () => {
    const project = projectFixture();
    const sprite = project.targets[1];
    if (!sprite) return;
    sprite.blocks['sense'] = {
      opcode: 'sensing_of', next: null, parent: null, inputs: {OBJECT: [1, [10, 'Sprite1']]}, fields: {PROPERTY: ['Score']}, shadow: false, topLevel: true, x: 1, y: 1
    };
    const resultStats = stats();
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32), 'sensing'), resultStats);
    expect(Object.values(project.targets[0]?.variables ?? {}).some(declaration => declaration[0] === 'Score')).toBe(false);
    const sensing = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'sensing_of');
    expect(sensing && isScratchBlock(sensing) ? sensing.fields['PROPERTY']?.[0] : undefined).toBe('Score');
    expect(resultStats.warnings).toEqual([]);
  });

  it('renames consistent custom procedure codes, argument IDs, and reporter names', () => {
    const project = projectFixture();
    const sprite = project.targets[1];
    if (!sprite) return;
    sprite.blocks = {
      definition: {opcode: 'procedures_definition', next: 'body', parent: null, inputs: {custom_block: [1, 'prototype']}, fields: {}, shadow: false, topLevel: true, x: 9, y: 9},
      prototype: {
        opcode: 'procedures_prototype', next: null, parent: 'definition', inputs: {argOne: [1, 'reporter']}, fields: {}, shadow: true, topLevel: false,
        mutation: {tagName: 'mutation', children: [], proccode: 'do %s', argumentids: '["argOne"]', argumentnames: '["value"]', argumentdefaults: '[""]', warp: 'false'}
      },
      reporter: {opcode: 'argument_reporter_string_number', next: null, parent: 'prototype', inputs: {}, fields: {VALUE: ['value', null]}, shadow: true, topLevel: false},
      body: {opcode: 'looks_say', next: null, parent: 'definition', inputs: {MESSAGE: [1, 'bodyReporter']}, fields: {}, shadow: false, topLevel: false},
      bodyReporter: {opcode: 'argument_reporter_string_number', next: null, parent: 'body', inputs: {}, fields: {VALUE: ['value', null]}, shadow: false, topLevel: false},
      unrelated: {opcode: 'looks_show', next: null, parent: null, inputs: {}, fields: {VALUE: ['value']}, shadow: false, topLevel: true, x: 0, y: 0},
      call: {
        opcode: 'procedures_call', next: null, parent: null, inputs: {argOne: [1, [10, 'hello']]}, fields: {}, shadow: false, topLevel: true, x: 1, y: 2,
        mutation: {tagName: 'mutation', children: [], proccode: 'do %s', argumentids: '["argOne"]', warp: 'false'}
      }
    };
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(2), 'procedures'), stats());
    validateProject(project);
    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    const prototype = blocks.find(block => block.opcode === 'procedures_prototype');
    const call = blocks.find(block => block.opcode === 'procedures_call');
    expect(prototype?.mutation?.['proccode']).toBe(call?.mutation?.['proccode']);
    expect(prototype?.mutation?.['proccode']).not.toBe('do %s');
    expect(Object.keys(prototype?.inputs ?? {})).toEqual(Object.keys(call?.inputs ?? {}));
    expect(Object.keys(prototype?.inputs ?? {})[0]).toMatch(/^a_/);
    const reporterNames = blocks.filter(block => block.opcode.startsWith('argument_reporter_')).map(block => block.fields['VALUE']?.[0]);
    expect(new Set(reporterNames).size).toBe(1);
    expect(reporterNames[0]).not.toBe('value');
    expect(blocks.find(block => block.opcode === 'looks_show')?.fields['VALUE']?.[0]).toBe('value');
  });

  it('rejects invalid public mode and seed values', () => {
    expect(() => obfuscateProject(projectFixture(), 'unknown' as ObfuscationMode, new Uint8Array(32))).toThrow(/unsupported obfuscation mode/);
    expect(() => obfuscateProject(projectFixture(), 'lossless', 'seed' as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });

  it('rewrites local and Stage symbols without confusing duplicate old IDs', () => {
    const project = projectFixture();
    const stage = project.targets[0];
    const sprite = project.targets[1];
    if (!stage || !sprite) throw new Error('fixture targets missing');
    sprite.variables['score'] = ['Sprite score', 9];
    sprite.lists['items'] = ['Sprite items', []];
    sprite.blocks = {
      localVariable: {opcode: 'data_variable', next: 'globalList', parent: null, inputs: {}, fields: {VARIABLE: ['Sprite score', 'score']}, shadow: false, topLevel: true, x: 1, y: 1},
      globalList: {opcode: 'data_listcontents', next: null, parent: 'localVariable', inputs: {}, fields: {LIST: ['Sprite items', 'items']}, shadow: false, topLevel: false}
    };
    project.monitors.push(
      {id: 'score', opcode: 'data_variable', params: {VARIABLE: 'Sprite score'}, spriteName: 'Sprite1'},
      {id: 'items', opcode: 'data_listcontents', params: {LIST: 'Items'}, spriteName: null},
      {id: 'score', opcode: 'data_variable', params: {VARIABLE: 'Score'}, spriteName: 'missing sprite'},
      {id: 'missing', opcode: 'data_variable', params: {}, spriteName: null},
      {id: 4, opcode: 'data_variable', params: {}},
      {id: 'ordinary', opcode: 'motion_xposition', params: {}},
      {id: 'items', opcode: 'data_listcontents', params: null}
    );
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(8), 'scopes'), stats());
    const localVariableId = Object.keys(sprite.variables).find(id => sprite.variables[id]?.[1] === 9);
    const localListId = Object.keys(sprite.lists)[0];
    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    expect(blocks.find(block => block.opcode === 'data_variable')?.fields['VARIABLE']?.[1]).toBe(localVariableId);
    expect(blocks.find(block => block.opcode === 'data_listcontents')?.fields['LIST']?.[1]).toBe(localListId);
    expect(project.monitors[2]?.['id']).toBe(Object.keys(stage.lists)[0]);
    expect(project.monitors[4]?.['id']).toBe('missing');
  });

  it('poisons every safe obscured-shadow class and ignores active or symbol shadows', () => {
    const project = projectFixture();
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage missing');
    stage.blocks = {
      shadows: {
        opcode: 'operator_join', next: null, parent: null,
        inputs: {
          NUMBER: [3, [10, 'active'], [4, '5']],
          COLOR: [3, [10, 'active'], [9, '#ffffff']],
          TEXT: [3, [10, 'active'], [10, 'fallback']],
          SYMBOL: [3, [10, 'active'], [12, 'Score', 'score']],
          REFERENCE: [3, [10, 'active'], 'shadowBlock'],
          ACTIVE_FALLBACK: [3, null, [10, 'runtime fallback']],
          UNOBSCURED: [1, [10, 'unchanged']]
        },
        fields: {UNRELATED: ['value'], VARIABLE: ['missing', 'missing']}, shadow: false, topLevel: true, x: 1, y: 2
      },
      shadowBlock: {opcode: 'text', next: null, parent: 'shadows', inputs: {}, fields: {}, shadow: true, topLevel: false}
    };
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(4), 'shadows'), stats());
    const block = Object.values(stage.blocks).find(value => isScratchBlock(value) && value.opcode === 'operator_join');
    if (!block || !isScratchBlock(block)) throw new Error('transformed block missing');
    expect(inputPrimitive(block, 'NUMBER', 2)[1]).not.toBe('5');
    expect(inputPrimitive(block, 'COLOR', 2)[1]).toMatch(/^#[0-9a-f]{6}$/);
    expect(inputPrimitive(block, 'TEXT', 2)[1]).toMatch(/^s_/);
    expect(inputPrimitive(block, 'SYMBOL', 2)[2]).toMatch(/^v_/);
    expect(inputPrimitive(block, 'ACTIVE_FALLBACK', 2)[1]).toBe('runtime fallback');
    expect(inputPrimitive(block, 'UNOBSCURED', 1)[1]).toBe('unchanged');
  });

  it('freezes all procedures for every ambiguous prototype metadata class', () => {
    const variants: Array<(mutation: Record<string, JsonValue>) => void> = [
      mutation => { delete mutation['proccode']; },
      mutation => { mutation['argumentids'] = '['; },
      mutation => { mutation['argumentids'] = '[3]'; },
      mutation => { delete mutation['argumentnames']; },
      mutation => { delete mutation['argumentdefaults']; },
      mutation => { mutation['argumentids'] = '["arg","arg"]'; mutation['argumentnames'] = '["a","b"]'; mutation['argumentdefaults'] = '["",""]'; mutation['proccode'] = 'do %s %s'; },
      mutation => { mutation['argumentnames'] = '[]'; },
      mutation => { mutation['argumentdefaults'] = '[]'; },
      mutation => { mutation['proccode'] = 'do'; }
    ];
    for (const modify of variants) {
      const project = procedureFixture();
      const sprite = project.targets[1];
      if (!sprite) throw new Error('fixture Sprite missing');
      const prototype = Object.values(sprite.blocks).filter(isScratchBlock).find(value => value.opcode === 'procedures_prototype');
      if (!prototype?.mutation) throw new Error('fixture prototype missing');
      modify(prototype.mutation);
      const resultStats = stats();
      applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32), 'ambiguous'), resultStats);
      expect(resultStats.warnings[0]).toMatch(/prototype metadata is ambiguous/);
    }

    const duplicate = procedureFixture();
    const duplicateSprite = duplicate.targets[1];
    if (!duplicateSprite) throw new Error('fixture Sprite missing');
    const firstPrototype = Object.values(duplicateSprite.blocks).filter(isScratchBlock).find(value => value.opcode === 'procedures_prototype');
    if (!firstPrototype) throw new Error('fixture prototype missing');
    duplicateSprite.blocks['duplicatePrototype'] = structuredClone(firstPrototype);
    const duplicateStats = stats();
    applyCommonTransforms(duplicate, new DeterministicGenerator(new Uint8Array(32), 'duplicate'), duplicateStats);
    expect(duplicateStats.warnings[0]).toMatch(/prototype metadata is ambiguous/);
  });

  it('freezes procedures for unresolved and inconsistent calls', () => {
    const variants: Array<(call: ScratchBlock) => void> = [
      call => { if (call.mutation) delete call.mutation['proccode']; },
      call => { if (call.mutation) call.mutation['proccode'] = 'unknown %s'; },
      call => { if (call.mutation) call.mutation['argumentids'] = '['; },
      call => { if (call.mutation) call.mutation['argumentids'] = '[]'; },
      call => { if (call.mutation) call.mutation['argumentids'] = '["other"]'; }
    ];
    for (const modify of variants) {
      const project = procedureFixture();
      const sprite = project.targets[1];
      if (!sprite) throw new Error('fixture Sprite missing');
      const call = Object.values(sprite.blocks).filter(isScratchBlock).find(value => value.opcode === 'procedures_call');
      if (!call) throw new Error('fixture call missing');
      modify(call);
      const resultStats = stats();
      applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32), 'unresolved'), resultStats);
      expect(resultStats.warnings[0]).toMatch(/unresolved call/);
    }
  });

  it('renames argument-free procedures and leaves non-procedure mutations alone', () => {
    const project = projectFixture();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture Sprite missing');
    sprite.blocks = {
      prototype: {opcode: 'procedures_prototype', next: null, parent: null, inputs: {}, fields: {}, shadow: true, topLevel: false, mutation: {proccode: 'run', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]'}},
      call: {opcode: 'procedures_call', next: null, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0, mutation: {proccode: 'run', argumentids: '[]'}},
      other: {opcode: 'looks_show', next: null, parent: null, inputs: {}, fields: {VALUE: ['unknown']}, shadow: false, topLevel: true, x: 1, y: 1, mutation: {proccode: 'unrelated'}}
    };
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32), 'no-args'), stats());
    const blocks = Object.values(sprite.blocks).filter(isScratchBlock);
    const prototype = blocks.find(block => block.opcode === 'procedures_prototype');
    const call = blocks.find(block => block.opcode === 'procedures_call');
    expect(prototype?.mutation?.['proccode']).toBe(call?.mutation?.['proccode']);
    expect(prototype?.mutation?.['proccode']).not.toBe('run');
    expect(blocks.find(block => block.opcode === 'looks_show')?.mutation?.['proccode']).toBe('unrelated');
  });

  it('retries deterministic identifier and display-name collisions', () => {
    const seed = new Uint8Array(32).fill(31);
    const domain = 'collision';
    const probe = new DeterministicGenerator(seed, domain).fork('symbols').fork('target:0:symbols');
    const collidingId = probe.id('v_');
    probe.id('v_');
    const collidingName = probe.id('x_', 28);
    const project = projectFixture();
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage missing');
    stage.variables = {[collidingId]: [collidingName, 0]};
    stage.blocks = {};
    project.monitors = [];
    applyCommonTransforms(project, new DeterministicGenerator(seed, domain), stats());
    expect(Object.keys(stage.variables)[0]).not.toBe(collidingId);
    expect(Object.values(stage.variables)[0]?.[0]).not.toBe(collidingName);
  });

  it('covers conservative fallback paths for malformed direct callers', () => {
    const project = projectFixture();
    const stage = project.targets[0];
    if (!stage) throw new Error('fixture Stage missing');
    rawDictionary(stage.variables)['badName'] = [4, 0];
    rawDictionary(stage.lists)['badListName'] = [4, []];
    stage.broadcasts['secondBroadcast'] = 'second';
    rawDictionary(stage.blocks)['literal'] = [4, '3'];
    rawDictionary(stage.blocks)['missingVariable'] = [12, 'missing', 'missing'];
    rawDictionary(stage.blocks)['junk'] = {notOpcode: true};
    stage.blocks['fallbacks'] = {
      opcode: 'looks_show', next: 'missingNext', parent: 'missingParent',
      inputs: {MISSING: [2, 'missingInput'], NULL: [2, null], PLAIN: [1, [4, '2']]},
      fields: {LIST: ['Items', 'items'], BROADCAST_OPTION: ['Launch', 'message'], UNKNOWN: ['value']},
      shadow: false, topLevel: false
    };
    project.monitors.push({id: 'items', opcode: 'data_listcontents', params: {LIST: 'Items'}, spriteName: null});
    expect(() => applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(12), 'fallbacks'), stats())).not.toThrow();
    expect(Object.keys(stage.blocks).every(id => id.startsWith('b_'))).toBe(true);
  });

  it('deduplicates repeated argument names across a valid multi-argument procedure', () => {
    const project = procedureFixture();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture Sprite missing');
    const prototype = Object.values(sprite.blocks).filter(isScratchBlock).find(block => block.opcode === 'procedures_prototype');
    const call = Object.values(sprite.blocks).filter(isScratchBlock).find(block => block.opcode === 'procedures_call');
    if (!prototype?.mutation || !call?.mutation) throw new Error('fixture procedure missing');
    prototype.mutation['proccode'] = 'do %s %s';
    prototype.mutation['argumentids'] = '["arg","arg2"]';
    prototype.mutation['argumentnames'] = '["value","value"]';
    prototype.mutation['argumentdefaults'] = '["",""]';
    prototype.inputs['arg2'] = [1, [10, 'default']];
    call.mutation['proccode'] = 'do %s %s';
    call.mutation['argumentids'] = '["arg","arg2"]';
    call.inputs['arg2'] = [1, [10, 'second']];
    const resultStats = stats();
    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(6), 'duplicate-names'), resultStats);
    expect(resultStats.warnings).toEqual([]);
    expect(resultStats.symbolsRenamed).toBeGreaterThan(0);
  });

  it('renames legacy numeric procedure placeholders and preserves numeric defaults', () => {
    const project = procedureFixture();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture Sprite missing');
    const prototype = Object.values(sprite.blocks).filter(isScratchBlock).find(block => block.opcode === 'procedures_prototype');
    const call = Object.values(sprite.blocks).filter(isScratchBlock).find(block => block.opcode === 'procedures_call');
    if (!prototype?.mutation || !call?.mutation) throw new Error('fixture procedure missing');
    prototype.mutation['proccode'] = 'calculate %s %b %n';
    prototype.mutation['argumentids'] = '["arg","condition","number"]';
    prototype.mutation['argumentnames'] = '["text","condition","number"]';
    prototype.mutation['argumentdefaults'] = '["",false,0]';
    prototype.inputs['condition'] = [1, [10, 'false']];
    prototype.inputs['number'] = [1, [4, 0]];
    call.mutation['proccode'] = 'calculate %s %b %n';
    call.mutation['argumentids'] = '["arg","condition","number"]';
    call.inputs['condition'] = [1, [10, 'false']];
    call.inputs['number'] = [1, [4, 2]];
    const resultStats = stats();

    applyCommonTransforms(project, new DeterministicGenerator(new Uint8Array(32).fill(23), 'legacy-number'), resultStats);

    expect(resultStats.warnings).toEqual([]);
    expect(prototype.mutation['proccode']).toMatch(/^x_.+ %s %b %n$/);
    expect(call.mutation['proccode']).toBe(prototype.mutation['proccode']);
    expect(prototype.mutation['argumentdefaults']).toBe('["",false,0]');
    expect(Object.keys(prototype.inputs)[0]).toMatch(/^a_/);
    expect(Object.keys(call.inputs)).toEqual(Object.keys(prototype.inputs));
  });
});

function procedureFixture(): ScratchProject {
  const project = projectFixture();
  const sprite = project.targets[1];
  if (!sprite) throw new Error('fixture Sprite missing');
  sprite.blocks = {
    prototype: {
      opcode: 'procedures_prototype', next: null, parent: null, inputs: {arg: [1, 'reporter']}, fields: {}, shadow: true, topLevel: false,
      mutation: {proccode: 'do %s', argumentids: '["arg"]', argumentnames: '["value"]', argumentdefaults: '[""]'}
    },
    reporter: {opcode: 'argument_reporter_string_number', next: null, parent: 'prototype', inputs: {}, fields: {VALUE: ['value', null]}, shadow: true, topLevel: false},
    call: {
      opcode: 'procedures_call', next: null, parent: null, inputs: {arg: [1, [10, 'hello']]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0,
      mutation: {proccode: 'do %s', argumentids: '["arg"]'}
    }
  };
  return project;
}

function inputPrimitive(block: ScratchBlock, inputName: string, slot: number): JsonValue[] {
  const value = block.inputs[inputName]?.[slot];
  if (!Array.isArray(value)) throw new Error(`fixture input ${inputName} is not a primitive`);
  return value;
}

function joinedLiteral(block: ScratchBlock): string {
  const left = inputPrimitive(block, 'STRING1', 1)[1];
  const right = inputPrimitive(block, 'STRING2', 1)[1];
  if ((typeof left !== 'string' && typeof left !== 'number') ||
      (typeof right !== 'string' && typeof right !== 'number')) {
    throw new Error('fixture join inputs must be text or numbers');
  }
  return `${left}${right}`;
}

function rawDictionary(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
