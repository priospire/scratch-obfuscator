import type {ObfuscationMode} from './types.js';

export type AggressiveGrowthMode = Exclude<ObfuscationMode, 'lossless'>;

export const COMPACT_ANTICHEAT_JSON_GROWTH_BYTES = 2 * 1024 * 1024;
export const COMPACT_ANTICHEAT_BLOCK_GROWTH_CEILING = 30_000;

export function aggressivePerSiteBlockEquivalentCap(
  mode: AggressiveGrowthMode,
  allowSize: boolean
): number {
  if (allowSize) return mode === 'lossy' ? 256 : 2048;
  return mode === 'lossy' ? 64 : 256;
}

export function aggressiveBlockEquivalentCap(
  initial: number,
  mode: AggressiveGrowthMode,
  allowSize: boolean
): number {
  if (mode === 'lossy') {
    if (allowSize) {
      return Math.max(initial, Math.min(50_000, Math.max(initial * 4, initial + 256)));
    }
    return Math.max(initial, Math.min(initial * 2, 30_000));
  }
  if (allowSize) {
    return Math.max(initial, Math.min(100_000, Math.max((initial * 25) + 512, initial + 2048)));
  }
  return Math.max(initial, Math.min((initial * 3) + 512, 30_000));
}

export function compactSerializedJsonLimit(sourceBytes: number, mode: AggressiveGrowthMode): number {
  return mode === 'lossy'
    ? Math.max(sourceBytes, (sourceBytes * 4) + (512 * 1024))
    : Math.max(sourceBytes, (sourceBytes * 8) + (1024 * 1024));
}

export function transformedJsonSafetyLimit(mode: ObfuscationMode): number {
  return (mode === 'no-preserve' ? 128 : 64) * 1024 * 1024;
}

export function exceedsTransformedJsonSafetyLimit(bytes: number, mode: ObfuscationMode): boolean {
  return bytes > transformedJsonSafetyLimit(mode);
}

export function antiCheatBlockGrowthLimit(preInstrumentationCount: number): number {
  return Math.max(
    4096,
    Math.min(
      (preInstrumentationCount * 8) + 4096,
      COMPACT_ANTICHEAT_BLOCK_GROWTH_CEILING
    )
  );
}
