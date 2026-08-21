import {createHash} from 'node:crypto';
import {compareUtf8} from '../deterministic.js';
import type {ArchiveEntry, ObfuscationMode} from '../types.js';

const ARCHIVE_DOMAIN = Buffer.from('scratch-obfuscator\u0000logical-archive\u0000v1\u0000', 'utf8');
const MODE_DOMAIN = Buffer.from('scratch-obfuscator\u0000mode-seed\u0000v1\u0000', 'utf8');

export function deriveArchiveSeed(projectBytes: Uint8Array, entries: readonly ArchiveEntry[]): Uint8Array {
  const hash = createHash('sha256');
  hash.update(ARCHIVE_DOMAIN);
  updateLength(hash, projectBytes.length);
  hash.update(projectBytes);

  const ordered = [...entries].sort((left, right) => compareUtf8(left.name, right.name));
  updateLength(hash, ordered.length);
  for (const entry of ordered) {
    const name = Buffer.from(entry.name, 'utf8');
    if (entry.contentHash.length !== 32) {
      throw new RangeError(`content hash for ${JSON.stringify(entry.name)} must be 32 bytes`);
    }
    updateLength(hash, name.length);
    hash.update(name);
    updateLength(hash, entry.uncompressedSize);
    hash.update(entry.contentHash);
  }
  return hash.digest();
}

export function deriveModeSeed(archiveSeed: Uint8Array, mode: ObfuscationMode): Uint8Array {
  const hash = createHash('sha256');
  hash.update(MODE_DOMAIN);
  hash.update(archiveSeed);
  hash.update('\u0000', 'utf8');
  hash.update(mode, 'utf8');
  return hash.digest();
}

function updateLength(hash: ReturnType<typeof createHash>, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('length must be a non-negative safe integer');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  hash.update(bytes);
}
