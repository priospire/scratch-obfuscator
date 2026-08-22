import {describe, expect, it} from 'vitest';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import {createFixtureProject} from './support.js';

const SEED = new Uint8Array(32).fill(0x5a);

function stageOf(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('test fixture is missing Stage');
  return stage;
}

function block(opcode: string, changes: Partial<ScratchBlock> = {}): ScratchBlock {
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

describe('v5 runtime-name precision', () => {
  it('preserves a broadcast display name exposed through a referenced menu reporter', () => {
    const input = createFixtureProject();
    const stage = stageOf(input);
    stage.blocks['say-broadcast-name'] = block('looks_say', {
      inputs: {MESSAGE: [1, 'broadcast-name-value']}
    });
    stage.blocks['broadcast-name-value'] = block('event_broadcast_menu', {
      parent: 'say-broadcast-name',
      fields: {BROADCAST_OPTION: ['go', 'broadcast_go']},
      shadow: true,
      topLevel: false
    });

    const result = obfuscateProject(input, 'lossless', SEED);
    const transformedStage = stageOf(result.project);

    expect(Object.values(transformedStage.broadcasts)).toContain('go');
    expect(result.stats.warnings).toContain(
      'Display names were preserved because typed menu fields are used as runtime reporter values.'
    );
  });

  it('preserves broadcast names selected by direct and referenced data reporters only', () => {
    const input = createFixtureProject();
    const stage = stageOf(input);
    stage.broadcasts['broadcast_stop'] = 'Stop';
    stage.blocks['broadcast-from-variable'] = block('event_broadcast', {
      inputs: {BROADCAST_INPUT: [2, [12, 'Readable score', 'global_score']]}
    });
    stage.blocks['broadcast-from-list'] = block('event_broadcastandwait', {
      inputs: {BROADCAST_INPUT: [2, 'list-runtime-value']}
    });
    stage.blocks['list-runtime-value'] = [13, 'Readable list', 'global_list'];

    const result = obfuscateProject(input, 'lossless', SEED);
    const transformedStage = stageOf(result.project);
    const broadcastNames = new Set(Object.values(transformedStage.broadcasts));
    const variableNames = Object.values(transformedStage.variables).map(tuple => tuple[0]);
    const listNames = Object.values(transformedStage.lists).map(tuple => tuple[0]);

    expect(broadcastNames).toEqual(new Set(['go', 'Stop']));
    expect(variableNames).not.toContain('Readable score');
    expect(listNames).not.toContain('Readable list');
    expect(result.stats.warnings).toContain(
      'Broadcast display names were preserved because the project computes broadcast names at runtime.'
    );
  });

  it('ignores a non-string sensing property instead of preserving unrelated names', () => {
    const input = createFixtureProject();
    const stage = stageOf(input);
    stage.blocks['say-sensed-value'] = block('looks_say', {
      inputs: {MESSAGE: [1, 'sensing-value']}
    });
    stage.blocks['sensing-value'] = block('sensing_of', {
      parent: 'say-sensed-value',
      inputs: {OBJECT: [1, [10, '_stage_']]},
      fields: {PROPERTY: [42]},
      topLevel: false
    });

    const result = obfuscateProject(input, 'lossless', SEED);
    const transformedStage = stageOf(result.project);

    expect(Object.values(transformedStage.variables).map(tuple => tuple[0])).not.toContain('Readable score');
    expect(result.stats.warnings).not.toContain(
      'Variable display names were preserved because the project uses name-based sensing.'
    );
  });
});
