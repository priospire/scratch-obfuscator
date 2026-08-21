import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {strToU8, zipSync} from 'fflate';
import {AppError, InputError} from '../src/errors.js';
import {loadArchiveBuffer} from '../src/archive/index.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

const extended = process.env['SCRATCH_OBFUSCATOR_EXTENDED_FUZZ'] === '1';

describe('malformed input properties', () => {
  it('classifies arbitrary and truncated ZIP payloads without leaking internal failures', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uint8Array({maxLength: 4096}),
      async bytes => classifyArchive(bytes)
    ), {
      seed: 0x5b33_0101,
      numRuns: extended ? 3000 : 300
    });

    const valid = createFixtureArchive();
    await fc.assert(fc.asyncProperty(
      fc.integer({min: 0, max: valid.length}),
      async length => classifyArchive(valid.subarray(0, length))
    ), {
      seed: 0x5b33_0102,
      numRuns: extended ? 1500 : 150
    });
  });

  it('classifies deterministic mutations of a valid archive', async () => {
    const valid = createFixtureArchive();
    await fc.assert(fc.asyncProperty(
      fc.integer({min: 0, max: valid.length - 1}),
      fc.integer({min: 1, max: 255}),
      async (offset, mask) => {
        const mutated = Uint8Array.from(valid);
        mutated[offset] = (mutated[offset] ?? 0) ^ mask;
        await classifyArchive(mutated);
      }
    ), {
      seed: 0x5b33_0103,
      numRuns: extended ? 3000 : 300
    });
  });

  it('rejects duplicate JSON keys and malformed UTF-8 across a generated corpus', async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({minLength: 1, maxLength: 40}),
      async key => {
        const encodedKey = JSON.stringify(key);
        const archive = zipSync({'project.json': strToU8(`{${encodedKey}:1,${encodedKey}:2}`)});
        await expect(loadArchiveBuffer(archive)).rejects.toThrowError(/duplicate object (?:property|member)/);
      }
    ), {
      seed: 0x5b33_0104,
      numRuns: extended ? 1000 : 100
    });

    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[ -~]{0,40}$/),
      async prefix => {
        const bytes = Buffer.concat([
          Buffer.from(`{"value":"${prefix.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}`),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('"}')
        ]);
        await expect(loadArchiveBuffer(zipSync({'project.json': bytes}))).rejects.toThrowError(/UTF-8/);
      }
    ), {
      seed: 0x5b33_0105,
      numRuns: extended ? 1000 : 100
    });
  });

  it('rejects generated dangling block references as invalid input', () => {
    fc.assert(fc.property(
      fc.string({minLength: 1, maxLength: 60}),
      missingId => {
        const project = createFixtureProject();
        const stage = project.targets[0];
        if (!stage) throw new Error('fixture Stage is missing');
        const start = stage.blocks['start_script'];
        if (!start || Array.isArray(start)) throw new Error('fixture start block is missing');
        start.next = `missing_${missingId}`;
        expect(() => validateProject(project)).toThrow(InputError);
      }
    ), {
      seed: 0x5b33_0106,
      numRuns: extended ? 2000 : 200
    });
  });
});

async function classifyArchive(bytes: Uint8Array): Promise<void> {
  try {
    const archive = await loadArchiveBuffer(bytes);
    await archive.cleanup();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof AppError)) throw error;
    expect([3, 4]).toContain(error.exitCode);
  }
}
