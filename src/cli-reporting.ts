import type {ExtraPrivacyLevel, ObfuscationMode, ObfuscationStats} from './types.js';
import {RELEASE_TEST_COVERAGE, type ReleaseCoverageMetric} from './release-coverage.js';
import {ANTI_SAVE_CAVEAT} from './obfuscation/antisave.js';
import {EXTRA_EDITOR_SHADOW_CAVEAT} from './obfuscation/privacy.js';

export type CliVerbosity = 'normal' | 'verbose' | 'max';

export interface CliExecutionMetrics {
  readonly archiveEntries: number;
  readonly assetsVerified: number;
  readonly assetBytesVerified: number;
  readonly projectBytesWritten: number;
}

export interface CliProgressOptions {
  readonly stderr: (text: string) => void;
  readonly interactive: boolean;
  readonly verbosity: CliVerbosity;
}

const BAR_WIDTH = 24;
const NON_INTERACTIVE_MILESTONE = 10;

export class CliProgressReporter {
  readonly #stderr: (text: string) => void;
  readonly #interactive: boolean;
  readonly #verbosity: CliVerbosity;
  #lastPercent = -1;
  #lastLabel = '';
  #lastLineWidth = 0;
  #lineOpen = false;
  #nextMilestone = 0;

  constructor(options: CliProgressOptions) {
    this.#stderr = options.stderr;
    this.#interactive = options.interactive;
    this.#verbosity = options.verbosity;
  }

  update(completion: number, label: string): void {
    const percent = normalizedPercent(completion);
    const safeLabel = progressLabel(label, this.#verbosity === 'max');
    if (percent < this.#lastPercent) return;
    if (percent === this.#lastPercent && safeLabel === this.#lastLabel) return;

    if (this.#interactive && this.#verbosity === 'normal') {
      const line = progressBar(percent, safeLabel);
      const padded = line.padEnd(Math.max(line.length, this.#lastLineWidth));
      this.#stderr(`\r${padded}`);
      this.#lastLineWidth = padded.length;
      this.#lineOpen = true;
    } else if (this.#verbosity === 'normal') {
      this.#writeMilestones(percent, safeLabel);
    } else if (this.#shouldWriteLine(percent, safeLabel)) {
      this.#stderr(`progress: ${progressBar(percent, safeLabel)}\n`);
    }
    this.#lastPercent = percent;
    this.#lastLabel = safeLabel;
  }

  complete(): void {
    this.update(1, 'Complete');
    if (this.#interactive && this.#verbosity === 'normal' && this.#lineOpen) {
      this.#stderr('\n');
      this.#lineOpen = false;
    }
  }

  stop(): void {
    if (this.#interactive && this.#lineOpen) {
      this.#stderr('\n');
      this.#lineOpen = false;
    }
  }

  #shouldWriteLine(percent: number, label: string): boolean {
    if (this.#verbosity === 'max') return true;
    if (this.#lastPercent < 0 || percent === 100 || label !== this.#lastLabel) return true;
    return Math.floor(percent / 5) > Math.floor(this.#lastPercent / 5);
  }

  #writeMilestones(percent: number, label: string): void {
    while (this.#nextMilestone <= percent && this.#nextMilestone <= 100) {
      this.#stderr(`progress: ${progressBar(this.#nextMilestone, label)}\n`);
      this.#nextMilestone += NON_INTERACTIVE_MILESTONE;
    }
  }
}

export function formatSuccessSummary(
  inputName: string,
  outputName: string,
  mode: ObfuscationMode,
  antiCheat: boolean,
  stats: ObfuscationStats,
  caveatCount: number = stats.caveats?.length ?? 0,
  extra: ExtraPrivacyLevel | boolean = 0,
  allowSize = false,
  antiSave = false
): string {
  const extraLevel = normalizeExtraLevel(extra);
  const summary = 'Obfuscation completed: 100% (operation completion, not protection strength)\n'
    + `Obfuscated ${JSON.stringify(inputName)} -> ${JSON.stringify(outputName)}`
    + ` (mode=${mode}, anticheat=${antiCheat ? 'on' : 'off'}, extra=${extraLevel === 0 ? 'off' : extraLevel},`
    + ` allowsize=${allowSize ? 'on' : 'off'}, antisave=${antiSave ? 'on' : 'off'},`
    + ` blocks=${stats.blocksBefore}->${stats.blocksAfter}, renamed=${stats.identifiersRenamed + stats.symbolsRenamed},`
    + ` packed=${stats.variablesVirtualized ?? 0}, folded=${stats.constantsFolded ?? 0},`
    + ` fallbacks=${stats.inactiveFallbacksRemoved ?? 0}, comments=${stats.commentsRemoved},`
    + ` packed-lists=${stats.listsVirtualized ?? 0},`
    + ` decoys=${stats.decoysAdded}, virtualized=${stats.virtualizedBlocks},`
    + ` warnings=${stats.warnings.length}, caveats=${caveatCount})\n`;
  return summary + formatReleaseTestCoverage();
}

export function formatVerboseReport(
  stats: ObfuscationStats,
  metrics: CliExecutionMetrics,
  verbosity: CliVerbosity
): string {
  if (verbosity === 'normal') return '';
  const virtualizedActivity = percentage(stats.virtualizedBlocks, stats.blocksBefore);
  const verification = stats.verification;
  const lines = [
    `transforms: identifier-ids=${stats.identifiersRenamed}, display-symbols=${stats.symbolsRenamed},`
      + ` virtualized-commands=${stats.virtualizedBlocks}/${stats.blocksBefore}`
      + ` (${virtualizedActivity} relative to source block-equivalents; transform activity, not test coverage)`,
    verification
      ? `verification: static=${verification.verdict}, proven-invariants=${verification.provenInvariants},`
        + ` attributed-passes=${verification.attributedPasses}, scope=${verification.scope};`
        + ` assets-verified=${metrics.assetsVerified}, asset-bytes=${metrics.assetBytesVerified}`
      : `verification: static=unavailable; assets-verified=${metrics.assetsVerified},`
        + ` asset-bytes=${metrics.assetBytesVerified}`
  ];
  if (verbosity === 'max') {
    const blockDelta = stats.blocksAfter - stats.blocksBefore;
    lines.push(
      `max-detail: archive-entries=${metrics.archiveEntries}, project-bytes=${metrics.projectBytesWritten},`
        + ` block-delta=${signedInteger(blockDelta)}, growth=${percentage(blockDelta, stats.blocksBefore)}`,
      `max-detail: variables-packed=${stats.variablesVirtualized ?? 0}, lists-packed=${stats.listsVirtualized ?? 0},`
        + ` constants-folded=${stats.constantsFolded ?? 0}, inactive-fallbacks-removed=${stats.inactiveFallbacksRemoved ?? 0},`
        + ` comments-removed=${stats.commentsRemoved}, decoys=${stats.decoysAdded},`
        + ` anticheat-decoys=${stats.antiCheatDecoys ?? 0}, antisave-canaries=${stats.antiSaveCanaries ?? 0}`,
      `max-detail: privacy-names=${stats.privacyNamesRenamed ?? 0},`
        + ` privacy-monitors=${stats.privacyMonitorsCanonicalized ?? 0},`
        + ` privacy-metadata-properties=${stats.privacyMetadataPropertiesRemoved ?? 0},`
        + ` privacy-shadow-hat-sites=${stats.privacyHatShadowSites ?? 0},`
        + ` privacy-shadow-hat-changes=${stats.privacyHatShadowChanges ?? 0}`,
      `max-detail: static-verifier-caveats=${verification?.caveats ?? 0},`
        + ` attributed-passes=${verification?.attributedPasses ?? 0}`
    );
  }
  return `${lines.join('\n')}\n`;
}

export function cliCaveats(
  mode: ObfuscationMode,
  antiCheat: boolean,
  extra: ExtraPrivacyLevel | boolean = 0,
  allowSize = false,
  antiSave = false
): string[] {
  const extraLevel = normalizeExtraLevel(extra);
  const caveats: string[] = [];
  if (mode === 'no-preserve') {
    caveats.push(
      'no-preserve intentionally waives timing, live-input sampling time, responsiveness, redraw cadence, thread interleaving, and race outcomes.'
    );
  } else if (mode === 'lossy') {
    caveats.push('lossy rewrites only statically certified live regions; rejected regions retain common lossless transforms.');
  } else if (antiCheat || antiSave) {
    caveats.push(
      antiCheat
        ? 'lossless common transforms preserve the original executable opcode topology before anti-cheat instrumentation; anti-cheat intentionally adds executable guard topology.'
        : 'lossless common transforms preserve the original executable opcode topology before instrumentation; antisave intentionally adds executable guard topology.'
    );
  } else if (extraLevel === 2) {
    caveats.push(
      'lossless common transforms preserve executable opcode topology before the terminal extra level 2 shadow pass; that pass intentionally disables native event stacks.'
    );
  } else {
    caveats.push('lossless preserves executable opcode topology; comments and workspace layout are intentionally not preserved.');
  }
  if (antiCheat) {
    caveats.push('anti-cheat is local tamper response; an editor with complete archive control remains outside its trust boundary.');
  }
  if (extraLevel >= 1) {
    caveats.push(
      'extra intentionally waives compatibility for computed name-based dispatch, editor-visible names and monitor presentation, and external target or asset-name consumers.'
    );
  }
  if (extraLevel === 2) caveats.push(EXTRA_EDITOR_SHADOW_CAVEAT);
  if (allowSize && mode !== 'lossless') {
    caveats.push('allowsize permits expanded bounded block and file-size growth in the selected stronger mode.');
  } else if (allowSize) {
    caveats.push('allowsize does not change lossless executable growth limits.');
  }
  if (antiSave) caveats.push(ANTI_SAVE_CAVEAT);
  caveats.push('progress percentages report operation completion, not obfuscation strength or security coverage.');
  return caveats;
}

export function formatReleaseTestCoverage(): string {
  const metrics = coverageEntries();
  const fullyCovered = metrics.filter(([, metric]) => metric.allCovered).map(([name]) => name);
  const details = metrics.map(([name, metric]) => (
    `${name}=${metric.percentage.toFixed(2)}% (${metric.covered}/${metric.total}, ${metric.allCovered ? 'all' : 'not-all'})`
  ));
  return `release test coverage (v${RELEASE_TEST_COVERAGE.version}): ${details.join('; ')}\n`
    + `release test coverage: 100%-covered categories=${fullyCovered.length === 0 ? 'none' : fullyCovered.join(',')};`
    + ` all-categories-100%=${fullyCovered.length === metrics.length ? 'yes' : 'no'}.`
    + ' Test coverage does not guarantee correctness.\n';
}

function normalizedPercent(completion: number): number {
  if (!Number.isFinite(completion)) return 0;
  return Math.round(Math.min(1, Math.max(0, completion)) * 100);
}

function progressLabel(label: string, preserveDetail: boolean): string {
  const sanitized = label.replace(/\p{Cc}+/gu, ' ').trim();
  return (preserveDetail ? sanitized : sanitized.slice(0, 96)) || 'Working';
}

function progressBar(percent: number, label: string): string {
  const completed = Math.round((percent / 100) * BAR_WIDTH);
  return `${label} ${String(percent).padStart(3)}% [${'#'.repeat(completed)}${'-'.repeat(BAR_WIDTH - completed)}]`;
}

function percentage(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function signedInteger(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function normalizeExtraLevel(value: ExtraPrivacyLevel | boolean): ExtraPrivacyLevel {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

function coverageEntries(): Array<readonly [string, ReleaseCoverageMetric]> {
  return [
    ['statements', RELEASE_TEST_COVERAGE.statements],
    ['branches', RELEASE_TEST_COVERAGE.branches],
    ['functions', RELEASE_TEST_COVERAGE.functions],
    ['lines', RELEASE_TEST_COVERAGE.lines]
  ];
}
