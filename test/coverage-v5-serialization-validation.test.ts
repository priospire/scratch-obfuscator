import {describe, expect, it} from 'vitest';
import {InputError} from '../src/errors.js';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {serializeProject} from '../src/archive/writer.js';
import {validateOfficialExtensions, validateProject} from '../src/validation/index.js';
import {createFixtureProject} from './support.js';

function stageOf(project: ScratchProject): ScratchTarget {
  const stage = project.targets[0];
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

describe('v5 deterministic serialization coverage', () => {
  it('matches JSON array and object omission semantics for unsupported member values', () => {
    const project = createFixtureProject();
    const extended = project as unknown as Record<string, unknown>;
    extended['arrayValues'] = [undefined, () => 'ignored', Symbol('ignored'), 'kept'];
    extended['objectValues'] = {
      undefinedValue: undefined,
      functionValue: () => 'ignored',
      symbolValue: Symbol('ignored'),
      kept: true
    };

    const parsed = JSON.parse(Buffer.from(serializeProject(project, 'lossless')).toString('utf8')) as Record<string, unknown>;
    expect(parsed['arrayValues']).toEqual([null, null, null, 'kept']);
    expect(parsed['objectValues']).toEqual({kept: true});
  });

  it('rejects BigInt values with the stable transformed-project diagnostic', () => {
    const project = createFixtureProject();
    (project as unknown as Record<string, unknown>)['unsupportedInteger'] = 1n;

    expect(() => serializeProject(project, 'lossless')).toThrowError(
      new InputError('transformed project cannot be serialized as JSON')
    );
  });
});

describe('v5 structural validation coverage', () => {
  it('accepts a valid object-form color primitive without discarding hidden payload', () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    stage.blocks['color-owner'] = block('looks_say', {
      inputs: {MESSAGE: [1, 'color-value']}
    });
    stage.blocks['color-value'] = block('colour_picker', {
      parent: 'color-owner',
      fields: {COLOUR: ['#aBc123']},
      shadow: true,
      topLevel: false
    });

    expect(() => validateProject(project)).not.toThrow();
  });

  it('distinguishes null broadcast shadows from direct and referenced list reporters', () => {
    const missingMenu = createFixtureProject();
    stageOf(missingMenu).blocks['invalid-broadcast'] = block('event_broadcast', {
      inputs: {BROADCAST_INPUT: [1, null]}
    });
    expect(() => validateProject(missingMenu)).toThrowError(
      /shadow-only broadcast input must be a broadcast menu/u
    );

    const directReporter = createFixtureProject();
    const directStage = stageOf(directReporter);
    directStage.lists['runtime-list'] = ['runtime list', []];
    directStage.blocks['direct-broadcast'] = block('event_broadcast', {
      inputs: {BROADCAST_INPUT: [2, [13, 'runtime list', 'runtime-list']]}
    });
    expect(() => validateProject(directReporter)).not.toThrow();

    const referencedReporter = createFixtureProject();
    const referencedStage = stageOf(referencedReporter);
    referencedStage.lists['runtime-list'] = ['runtime list', []];
    referencedStage.blocks['referenced-broadcast'] = block('event_broadcast', {
      inputs: {BROADCAST_INPUT: [2, 'list-value']}
    });
    referencedStage.blocks['list-value'] = [13, 'runtime list', 'runtime-list'];
    expect(() => validateProject(referencedReporter)).not.toThrow();
  });

  it('rejects a broadcast primitive stored illegally in the block map', () => {
    const project = createFixtureProject();
    const stage = stageOf(project);
    stage.blocks['broadcast-through-map'] = block('event_broadcast', {
      inputs: {BROADCAST_INPUT: [1, 'mapped-broadcast-menu']}
    });
    stage.blocks['mapped-broadcast-menu'] = [11, 'go', 'broadcast_go'];

    expect(() => validateProject(project)).toThrowError(
      /official Scratch 3 schema rejected project.*mapped-broadcast-menu must be object/u
    );
  });

  it('reports a precise path for a malformed non-string comment link', () => {
    const project = createFixtureProject();
    (stageOf(project).comments as unknown as Record<string, unknown>)['non-string-link'] = {
      blockId: 42,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      minimized: false,
      text: 'invalid link'
    };

    expect(() => validateProject(project)).toThrowError(
      '$.targets[0].comments.non-string-link.blockId: expected a string'
    );
  });

  it('walks sparse extension inputs defensively without inventing declarations', () => {
    const sparse = createFixtureProject();
    sparse.targets = new Array<ScratchTarget>(1);
    sparse.monitors = [{}];

    expect(() => validateOfficialExtensions(sparse)).not.toThrow();
  });
});
