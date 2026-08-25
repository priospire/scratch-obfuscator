import {describe, expect, it} from 'vitest';
import {InputError} from '../src/errors.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ObfuscationMode, ObfuscationProgressEvent} from '../src/types.js';
import {createFixtureProject} from './support.js';

describe('obfuscation progress events', () => {
  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])('reports monotonic %s stages without project data', mode => {
    const events: ObfuscationProgressEvent[] = [];
    obfuscateProject(createFixtureProject(), mode, new Uint8Array(32).fill(0x47), {
      onProgress: event => events.push(event)
    });

    expect(events[0]).toMatchObject({stage: 'validating-source', percentage: 0});
    expect(events.at(-1)).toMatchObject({stage: 'transformation-complete', percentage: 100});
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.percentage).toBeGreaterThanOrEqual(events[index - 1]?.percentage ?? 0);
    }
    expect(events.every(event => event.percentage >= 0 && event.percentage <= 100)).toBe(true);
    const diagnostics = JSON.stringify(events);
    expect(diagnostics).not.toContain('score');
    expect(diagnostics).not.toContain('secret');

    if (mode === 'lossless') {
      expect(events.some(event => event.stage === 'structural-obfuscation')).toBe(true);
      expect(events.some(event => event.stage === 'virtualizing-lists')).toBe(false);
    } else {
      expect(events.some(event => event.stage === 'virtualizing-lists')).toBe(true);
      expect(events.some(event => event.stage === 'building-decoy-graphs')).toBe(true);
    }
  });

  it('rejects a non-function progress callback', () => {
    expect(() => obfuscateProject(
      createFixtureProject(),
      'lossless',
      new Uint8Array(32),
      {onProgress: 1 as unknown as (event: ObfuscationProgressEvent) => void}
    )).toThrow(InputError);
  });
});
