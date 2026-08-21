import {describe, expect, it} from 'vitest';
import {validateProject} from '../src/validation/index.js';
import {createFixtureProject} from './support.js';

describe('strict block and comment ownership invariants', () => {
  it('accepts a primitive block-map value referenced by an input', () => {
    const project = createFixtureProject();
    const stage = requireStage(project);
    stage.blocks['workspace_reporter'] = [12, 'Readable score', 'global_score', 10, 20];
    const setScore = requireObjectBlock(stage.blocks['set_score']);
    setScore.inputs['VALUE'] = [2, 'workspace_reporter'];
    expect(() => validateProject(project)).not.toThrow();
  });

  it('rejects mismatched, missing, multiple, and top-level owners', () => {
    const mismatched = createFixtureProject();
    requireObjectBlock(requireStage(mismatched).blocks['set_score']).parent = 'show_stage';
    expect(() => validateProject(mismatched)).toThrow(/parent does not match incoming owner/);

    const orphaned = createFixtureProject();
    requireStage(orphaned).blocks['orphan'] = {
      opcode: 'looks_show', next: null, parent: 'start_script', inputs: {}, fields: {}, shadow: false, topLevel: false
    };
    expect(() => validateProject(orphaned)).toThrow(/orphaned/);

    const multiplyOwned = createFixtureProject();
    const start = requireObjectBlock(requireStage(multiplyOwned).blocks['start_script']);
    start.inputs['EXTRA'] = [2, 'set_score'];
    expect(() => validateProject(multiplyOwned)).toThrow(/multiple owners/);

    const topLevelParent = createFixtureProject();
    requireObjectBlock(requireStage(topLevelParent).blocks['start_script']).parent = 'set_score';
    expect(() => validateProject(topLevelParent)).toThrow(/top-level block must have a null parent/);

    const incomingTopLevel = createFixtureProject();
    const setScore = requireObjectBlock(requireStage(incomingTopLevel).blocks['set_score']);
    setScore.topLevel = true;
    setScore.parent = null;
    expect(() => validateProject(incomingTopLevel)).toThrow(/top-level block must not have an incoming block edge/);
  });

  it('rejects a next edge to a primitive block-map value', () => {
    const project = createFixtureProject();
    const stage = requireStage(project);
    stage.blocks['workspace_reporter'] = [12, 'Readable score', 'global_score', 10, 20];
    requireObjectBlock(stage.blocks['start_script']).next = 'workspace_reporter';
    expect(() => validateProject(project)).toThrow(/next edge must reference an object block/);
  });

  it('requires comment links to be reciprocal in both directions', () => {
    const missingBlockLink = createFixtureProject();
    delete requireObjectBlock(requireStage(missingBlockLink).blocks['start_script']).comment;
    expect(() => validateProject(missingBlockLink)).toThrow(/comment link is not reciprocated/);

    const wrongCommentLink = createFixtureProject();
    const stage = requireStage(wrongCommentLink);
    stage.comments['other'] = {
      blockId: null, x: 0, y: 0, width: 10, height: 10, minimized: false, text: 'other'
    };
    const originalComment = stage.comments['comment_one'];
    if (!originalComment) throw new Error('fixture comment is missing');
    originalComment.blockId = null;
    requireObjectBlock(stage.blocks['start_script']).comment = 'other';
    expect(() => validateProject(wrongCommentLink)).toThrow(/block comment link is not reciprocated/);
  });
});

function requireStage(project: ReturnType<typeof createFixtureProject>) {
  const stage = project.targets[0];
  if (!stage) throw new Error('fixture Stage is missing');
  return stage;
}

function requireObjectBlock(value: ReturnType<typeof createFixtureProject>['targets'][number]['blocks'][string] | undefined) {
  if (!value || Array.isArray(value)) throw new Error('fixture object block is missing');
  return value;
}
