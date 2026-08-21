import {DeterministicGenerator} from '../deterministic.js';
import {InputError} from '../errors.js';
import {countBlockEquivalents} from '../model/blocks.js';
import {cloneProject} from '../model/json.js';
import type {
  ObfuscationMode,
  ObfuscationOptions,
  ObfuscationResult,
  ObfuscationStats,
  ScratchProject
} from '../types.js';
import {validateProject} from '../validation/index.js';
import {applyAggressiveTransforms} from './aggressive.js';
import {applyAntiCheatTransform, applyWatermarkTransform} from './anticheat.js';
import {applyCommonTransforms} from './common.js';
import {applySafeOptimizations} from './optimizer.js';

const MODES = new Set<ObfuscationMode>(['lossless', 'lossy', 'no-preserve']);

/**
 * Validate and obfuscate a Scratch project without mutating the caller's value.
 */
export function obfuscateProject(
  project: ScratchProject,
  mode: ObfuscationMode,
  seed: Uint8Array,
  options: ObfuscationOptions = {}
): ObfuscationResult {
  if (!MODES.has(mode)) throw new InputError(`unsupported obfuscation mode: ${JSON.stringify(mode)}`);
  if (!(seed instanceof Uint8Array)) throw new InputError('deterministic seed must be a Uint8Array');
  if (options.antiCheat !== undefined && typeof options.antiCheat !== 'boolean') {
    throw new InputError('antiCheat must be a boolean');
  }
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
    variablesVirtualized: 0,
    constantsFolded: 0,
    inactiveFallbacksRemoved: 0,
    antiCheatDecoys: 0,
    warnings: []
  };
  const generator = new DeterministicGenerator(
    seed,
    options.antiCheat === true ? `obfuscation:${mode}\u0000anti-cheat:v1` : `obfuscation:${mode}`
  );
  const optimized = applySafeOptimizations(output, {foldConstants: mode !== 'lossless'});
  stats.constantsFolded = optimized.reporterTreesFolded;
  stats.inactiveFallbacksRemoved = optimized.inactiveFallbacksRemoved;
  stats.commentsRemoved += optimized.commentsRemoved;
  applyCommonTransforms(output, generator.fork('common'), stats);
  if (mode !== 'lossless') applyAggressiveTransforms(output, mode, generator.fork('aggressive'), stats);
  const cleaned = applySafeOptimizations(output, {foldConstants: false});
  stats.inactiveFallbacksRemoved += cleaned.inactiveFallbacksRemoved;
  stats.commentsRemoved += cleaned.commentsRemoved;
  if (options.antiCheat === true) {
    const antiCheat = applyAntiCheatTransform(output, generator.fork('anti-cheat'));
    stats.decoysAdded += antiCheat.decoyVariableIds.length;
    stats.antiCheatDecoys = antiCheat.decoyVariableIds.length;
  } else {
    applyWatermarkTransform(output, generator.fork('watermark'));
  }
  stats.blocksAfter = countBlockEquivalents(output);
  try {
    validateProject(output);
  } catch (error) {
    throw new Error('internal validation rejected the transformed project', {cause: error});
  }
  return {project: output, stats};
}

export {applyCommonTransforms} from './common.js';
