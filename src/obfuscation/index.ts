import {DeterministicGenerator} from '../deterministic.js';
import {InputError} from '../errors.js';
import {countBlockEquivalents} from '../model/blocks.js';
import {cloneProject} from '../model/json.js';
import type {ObfuscationMode, ObfuscationResult, ObfuscationStats, ScratchProject} from '../types.js';
import {validateProject} from '../validation/index.js';
import {applyAggressiveTransforms} from './aggressive.js';
import {applyCommonTransforms} from './common.js';

const MODES = new Set<ObfuscationMode>(['lossless', 'lossy', 'no-preserve']);

/**
 * Validate and obfuscate a Scratch project without mutating the caller's value.
 */
export function obfuscateProject(
  project: ScratchProject,
  mode: ObfuscationMode,
  seed: Uint8Array
): ObfuscationResult {
  if (!MODES.has(mode)) throw new InputError(`unsupported obfuscation mode: ${JSON.stringify(mode)}`);
  if (!(seed instanceof Uint8Array)) throw new InputError('deterministic seed must be a Uint8Array');
  validateProject(project);
  const output = cloneProject(project);
  const blocksBefore = countBlockEquivalents(output);
  const stats: ObfuscationStats = {
    mode,
    blocksBefore,
    blocksAfter: blocksBefore,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
  const generator = new DeterministicGenerator(seed, `obfuscation:${mode}`);
  applyCommonTransforms(output, generator.fork('common'), stats);
  if (mode !== 'lossless') applyAggressiveTransforms(output, mode, generator.fork('aggressive'), stats);
  stats.blocksAfter = countBlockEquivalents(output);
  try {
    validateProject(output);
  } catch (error) {
    throw new Error('internal validation rejected the transformed project', {cause: error});
  }
  return {project: output, stats};
}

export {applyCommonTransforms} from './common.js';
