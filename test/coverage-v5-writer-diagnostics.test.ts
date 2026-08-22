import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type * as StreamPromises from 'node:stream/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ArchiveEntry} from '../src/types.js';

const directories: string[] = [];

afterEach(async () => {
  vi.doUnmock('fflate');
  vi.doUnmock('node:stream/promises');
  vi.resetModules();
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('v5 deterministic writer diagnostics', () => {
  it('checks for a compressor error that arrives as stream completion settles', async () => {
    let reportLateFailure: (() => void) | undefined;
    vi.doMock('node:stream/promises', async importOriginal => {
      const actual = await importOriginal<typeof StreamPromises>();
      return {
        ...actual,
        finished: async (...arguments_: Parameters<typeof actual.finished>): Promise<void> => {
          await actual.finished(...arguments_);
          reportLateFailure?.();
        }
      };
    });
    vi.doMock('fflate', async importOriginal => {
      const actual = await importOriginal<Record<string, unknown>>();
      class LateDeflate {
        attrs = 0;
        mtime = new Date(0);
        os = 0;

        constructor(readonly name: string) {}
        push(): void {}
      }
      class LateZip {
        constructor(private readonly callback: (error: Error | null, chunk: Uint8Array | null, final: boolean) => void) {}
        add(): void {}
        end(): void {
          reportLateFailure = () => this.callback(new Error('late compression failure'), null, false);
          this.callback(null, new Uint8Array(0), true);
        }
        terminate(): void {}
      }
      return {...actual, Zip: LateZip, ZipDeflate: LateDeflate};
    });
    vi.resetModules();
    const {writeDeterministicArchive} = await import('../src/archive/writer.js');
    const directory = await temporaryDirectory();
    const bytes = Buffer.from('{}');

    await expect(writeDeterministicArchive(
      join(directory, 'late-error.sb3'),
      bytes,
      [memoryEntry('project.json', bytes)]
    )).rejects.toThrowError('cannot write output archive: late compression failure');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-writer-v5-'));
  directories.push(directory);
  return directory;
}

function memoryEntry(name: string, bytes: Uint8Array): ArchiveEntry {
  return {
    name,
    content: {kind: 'memory', data: bytes},
    contentHash: createHash('sha256').update(bytes).digest(),
    compressedSize: bytes.length,
    uncompressedSize: bytes.length
  };
}
