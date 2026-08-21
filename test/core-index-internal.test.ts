import {describe, expect, it, vi} from 'vitest';
import type {ScratchProject} from '../src/types.js';

const validationState = vi.hoisted(() => ({calls: 0}));

vi.mock('../src/validation/index.js', () => ({
  validateProject: (): void => {
    validationState.calls += 1;
    if (validationState.calls === 6) throw new Error('generated graph is invalid');
  }
}));

const {obfuscateProject} = await import('../src/obfuscation/index.js');

describe('obfuscation output invariant', () => {
  it('classifies transformed-project validation failure as internal', () => {
    validationState.calls = 0;
    expect(() => obfuscateProject(project(), 'lossless', new Uint8Array(32))).toThrow(/internal validation rejected/);
    expect(validationState.calls).toBe(6);
  });
});

function project(): ScratchProject {
  return {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: 'backdrop'}],
      sounds: []
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'}
  };
}
