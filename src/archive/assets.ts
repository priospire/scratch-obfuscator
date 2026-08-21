import {InputError} from '../errors.js';
import type {ArchiveEntry, JsonValue, ScratchProject} from '../types.js';

/** Verify every runtime asset descriptor resolves to a byte entry in the SB3. */
export function validateReferencedAssets(project: ScratchProject, entries: readonly ArchiveEntry[]): void {
  const names = new Set(entries.map(entry => entry.name));
  for (const [targetIndex, target] of project.targets.entries()) {
    validateDescriptors(target.costumes, `$.targets[${targetIndex}].costumes`, names);
    validateDescriptors(target.sounds, `$.targets[${targetIndex}].sounds`, names);
  }
}

function validateDescriptors(descriptors: readonly Record<string, JsonValue>[], path: string, names: ReadonlySet<string>): void {
  for (const [index, descriptor] of descriptors.entries()) {
    const assetId = descriptor['assetId'];
    const dataFormat = descriptor['dataFormat'];
    if (typeof assetId !== 'string' || typeof dataFormat !== 'string') {
      throw new InputError(`${path}[${index}] has an invalid asset descriptor`);
    }
    const canonicalName = `${assetId}.${dataFormat}`;
    const md5ext = descriptor['md5ext'];
    const referencedName = typeof md5ext === 'string' && md5ext.length > 0 ? md5ext : canonicalName;
    if (!names.has(referencedName)) {
      throw new InputError(`${path}[${index}] references missing archive entry ${JSON.stringify(referencedName)}`);
    }
    if (typeof md5ext === 'string' && md5ext.length > 0 && md5ext !== canonicalName) {
      throw new InputError(`${path}[${index}].md5ext does not match assetId and dataFormat`);
    }
  }
}
