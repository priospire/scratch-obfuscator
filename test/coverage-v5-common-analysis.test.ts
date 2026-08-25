import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {collectVariableCandidates} from '../src/obfuscation/analysis.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import type {ObfuscationStats, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('common and analysis validated edge coverage', () => {
  it('renames a typed value attached only to an ignored input of a no-argument procedure', () => {
    const project = emptyProject();
    const stage = targetAt(project, 0);
    const sprite = targetAt(project, 1);
    stage.variables = {secret: ['Readable ignored procedure value', 17]};
    sprite.blocks = {
      definition: block('procedures_definition', null, null, true, {custom_block: [1, 'procedure-prototype']}),
      'procedure-prototype': {
        ...block('procedures_prototype', null, 'definition'),
        shadow: true,
        mutation: {
          tagName: 'mutation',
          proccode: 'no arguments',
          argumentids: '[]',
          argumentnames: '[]',
          argumentdefaults: '[]',
          warp: 'false'
        }
      },
      call: {
        ...block('procedures_call', null, null, true, {IGNORED: [2, 'value']}),
        mutation: {tagName: 'mutation', proccode: 'no arguments', argumentids: '[]', warp: 'false'}
      },
      value: {
        ...block('data_variable', null, 'call'),
        fields: {VARIABLE: ['Readable ignored procedure value', 'secret']}
      }
    };
    validateProject(project);

    transform(project, 71);
    validateProject(project);

    expect(Object.values(stage.variables).map(declaration => declaration[0]))
      .not.toContain('Readable ignored procedure value');
    const codes = Object.values(sprite.blocks)
      .filter(isScratchBlock)
      .flatMap(value => typeof value.mutation?.['proccode'] === 'string' ? [value.mutation['proccode']] : []);
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toMatch(/^x_/u);
  });

  it('renames a referenced broadcast menu while retaining its typed identity', () => {
    const project = emptyProject();
    const stage = targetAt(project, 0);
    stage.broadcasts = {message: 'Readable broadcast menu'};
    stage.blocks = {
      send: block('event_broadcast', null, null, true, {BROADCAST_INPUT: [1, 'menu']}),
      menu: {
        ...block('event_broadcast_menu', null, 'send'),
        fields: {BROADCAST_OPTION: ['Readable broadcast menu', 'message']},
        shadow: true
      }
    };
    validateProject(project);

    const result = transform(project, 73);
    validateProject(project);

    const [newId, newName] = onlyEntry(stage.broadcasts);
    const menu = Object.values(stage.blocks)
      .find(value => isScratchBlock(value) && value.opcode === 'event_broadcast_menu');
    expect(newName).toMatch(/^x_/u);
    expect(newName).not.toBe('Readable broadcast menu');
    expect(menu && isScratchBlock(menu) ? menu.fields['BROADCAST_OPTION'] : undefined).toEqual([newName, newId]);
    expect(result.caveats).not.toContain(
      'Broadcast display names were preserved because the project computes broadcast names at runtime.'
    );
  });

  it('treats a wrong-field implemented sound menu as dynamic during variable analysis', () => {
    const project = emptyProject();
    const stage = targetAt(project, 0);
    const sprite = targetAt(project, 1);
    stage.variables = {
      stageShared: ['Shared runtime property', 1],
      ordinary: ['Ordinary candidate', 2]
    };
    sprite.variables = {spriteShared: ['Shared runtime property', 3]};
    sprite.blocks = {
      sense: {
        ...block('sensing_of', null, null, true, {OBJECT: [1, 'menu']}),
        fields: {PROPERTY: ['Shared runtime property']}
      },
      menu: {
        ...block('sound_sounds_menu', null, 'sense'),
        fields: {WRONG: [sprite.name]},
        shadow: true
      }
    };
    validateProject(project);

    expect(collectVariableCandidates(project).map(candidate => candidate.id)).toEqual(['ordinary']);
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

function targetAt(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing fixture target ${index}`);
  return target;
}

function onlyEntry<Value>(record: Readonly<Record<string, Value>>): readonly [string, Value] {
  const entries = Object.entries(record);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) throw new Error('expected exactly one fixture entry');
  return entry;
}

function block(
  opcode: string,
  next: string | null = null,
  parent: string | null = null,
  topLevel = false,
  inputs: ScratchBlock['inputs'] = {}
): ScratchBlock {
  return {opcode, next, parent, inputs, fields: {}, shadow: false, topLevel, ...(topLevel ? {x: 0, y: 0} : {})};
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
    new DeterministicGenerator(new Uint8Array(32).fill(seed), `coverage-v5-common-analysis:${seed}`),
    stats
  );
  return stats;
}
