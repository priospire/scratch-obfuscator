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
import {
  captureProjectVerificationSnapshot,
  verifyPostTransform,
  type PostTransformVerificationReport,
  type ProjectVerificationSnapshot,
  type VerificationChangeCategory,
  type VerificationPassBoundary
} from '../verification/post-transform.js';
import {applyAggressiveTransforms} from './aggressive.js';
import {collectVariableCandidates} from './analysis.js';
import {
  ANTI_SAVE_GENERATOR_DOMAIN,
  ANTI_SAVE_PASS_NAME,
  applyAntiSaveTransform,
  type AntiSaveVerificationManifest
} from './antisave.js';
import {
  applyAntiCheatTransform,
  applyGameplayStateProtection,
  applyWatermarkTransform,
  releaseGameplayStateCandidates,
  reserveGameplayStateCandidates,
  selectReservedGameplayStateCandidates
} from './anticheat.js';
import {applyCommonTransforms} from './common.js';
import {applySafeOptimizations} from './optimizer.js';
import {
  applyExtraPrivacyTransform,
  EXTRA_PRIVACY_ALLOWED_CHANGES,
  EXTRA_PRIVACY_GENERATOR_DOMAIN,
  EXTRA_PRIVACY_PASS_NAME
} from './privacy.js';

const MODES = new Set<ObfuscationMode>(['lossless', 'lossy', 'no-preserve']);
const RECOVERABLE_INPUT_OPTIONS = Object.freeze({
  allowRecoverableLocalSymbolIdCollisions: true,
  allowRecoverableInactiveShadowOwnership: true,
  allowRecoverableStaleInvisibleMonitors: true
});
const OPTIMIZER_CHANGES = Object.freeze<VerificationChangeCategory[]>([
  'identifiers',
  'executable-topology',
  'executable-values',
  'serialized-block-data',
  'comments-layout',
  'monitors'
]);
const COMMON_CHANGES = Object.freeze<VerificationChangeCategory[]>([
  'symbols',
  'identifiers',
  'executable-values',
  'serialized-block-data',
  'comments-layout',
  'monitors'
]);
const AGGRESSIVE_CHANGES = Object.freeze<VerificationChangeCategory[]>([
  'symbols',
  'identifiers',
  'executable-topology',
  'executable-values',
  'serialized-block-data',
  'comments-layout'
]);
const CLEANUP_CHANGES = Object.freeze<VerificationChangeCategory[]>([
  'identifiers',
  'serialized-block-data',
  'comments-layout',
  'monitors'
]);
const WATERMARK_CHANGES = Object.freeze<VerificationChangeCategory[]>(['symbols', 'identifiers']);
const ANTISAVE_CHANGES = AGGRESSIVE_CHANGES;
const ANTICHEAT_CHANGES = AGGRESSIVE_CHANGES;
interface TransformAttempt {
  readonly result: ObfuscationResult;
  readonly verification: PostTransformVerificationReport;
  readonly passTrace: readonly VerificationPassBoundary[];
}

const acceptedAttempts = new WeakMap<ObfuscationResult, TransformAttempt>();

/** Validate and obfuscate a Scratch project without mutating the caller's value. */
export function obfuscateProject(
  project: ScratchProject,
  mode: ObfuscationMode,
  seed: Uint8Array,
  options: ObfuscationOptions = {}
): ObfuscationResult {
  validateArguments(mode, seed, options);
  const progress = progressReporter(options);
  progress('validating-source', 0, 'checking the source project and reference graph');
  validateProject(project, RECOVERABLE_INPUT_OPTIONS);

  const primary = runTransformAttempt(project, mode, seed, options, progress, true, true);
  if (primary.verification.verdict !== 'failed') return finishVerifiedAttempt(primary, progress);
  if (mode === 'lossless') throw verificationFailure(primary.verification);

  progress(
    'verification-fallback',
    99,
    'discarding the rejected candidate and rebuilding with common lossless transforms'
  );
  const fallback = runTransformAttempt(project, mode, seed, options, progress, false, false, 'lossless');
  if (fallback.verification.verdict === 'failed') throw verificationFailure(fallback.verification);
  const attribution = verificationFailureAttribution(primary.verification);
  const fallbackDescription = options.antiCheat === true
    ? 'common lossless transforms plus anti-cheat instrumentation were emitted instead'
    : 'common lossless transforms were emitted instead';
  fallback.result.stats.warnings.push(
    `Static verification rejected the ${mode} structural candidate (${attribution}); ${fallbackDescription}.`
  );
  appendUnique(
    fallback.result.stats.caveats ??= [],
    `The requested ${mode} structural passes were rolled back after static verifier findings (${attribution}).`
  );
  appendVerificationCaveats(fallback.result.stats, primary.verification);
  return finishVerifiedAttempt(fallback, progress);
}

function runTransformAttempt(
  project: ScratchProject,
  mode: ObfuscationMode,
  seed: Uint8Array,
  options: ObfuscationOptions,
  progress: ProgressReporter,
  applyAggressive: boolean,
  reportProgress: boolean,
  verificationMode: ObfuscationMode = mode
): TransformAttempt {
  try {
    return transformValidatedProject(
      project,
      mode,
      seed,
      options,
      progress,
      applyAggressive,
      reportProgress,
      verificationMode
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('internal validation rejected')) throw error;
    throw new Error('internal validation rejected the transformed project or transformation pass', {cause: error});
  }
}

function transformValidatedProject(
  project: ScratchProject,
  mode: ObfuscationMode,
  seed: Uint8Array,
  options: ObfuscationOptions,
  progress: ProgressReporter,
  applyAggressive: boolean,
  reportProgress: boolean,
  verificationMode: ObfuscationMode
): TransformAttempt {
  if (reportProgress) progress('cloning-project', 4, 'creating an isolated transactional working copy');
  const output = cloneProject(project);
  const blocksBefore = countBlockEquivalents(output);
  const stats = createStats(mode, blocksBefore);
  const generator = new DeterministicGenerator(
    seed,
    options.antiCheat === true ? `obfuscation:${mode}\u0000anti-cheat:v2` : `obfuscation:${mode}`
  );
  const passTrace: VerificationPassBoundary[] = [];
  let antiSaveManifest: AntiSaveVerificationManifest | undefined;
  let previousSnapshot = captureProjectVerificationSnapshot(project);
  const recordPass = (
    pass: string,
    allowedChanges: readonly VerificationChangeCategory[],
    allowRecoverable = false
  ): ProjectVerificationSnapshot => {
    validateWorkingProject(output, allowRecoverable);
    const after = captureProjectVerificationSnapshot(output);
    passTrace.push(Object.freeze({
      pass,
      before: previousSnapshot,
      after,
      allowedChanges: Object.freeze([...allowedChanges])
    }));
    previousSnapshot = after;
    return after;
  };

  if (reportProgress) {
    progress('optimizing-static-inputs', 8, mode === 'lossless' || !applyAggressive
      ? 'removing inactive serialized fallbacks'
      : 'folding proven constants and removing inactive serialized fallbacks');
  }
  const optimized = applySafeOptimizations(output, {foldConstants: mode !== 'lossless' && applyAggressive});
  stats.constantsFolded = optimized.reporterTreesFolded;
  stats.inactiveFallbacksRemoved = optimized.inactiveFallbacksRemoved;
  stats.commentsRemoved += optimized.commentsRemoved;
  if (optimized.staleInvisibleMonitorsRemoved > 0) {
    const suffix = optimized.staleInvisibleMonitorsRemoved === 1 ? '' : 's';
    stats.warnings.push(
      `Removed ${optimized.staleInvisibleMonitorsRemoved} stale invisible data monitor${suffix} for a missing sprite.`
    );
  }
  recordPass('static-input-optimization', OPTIMIZER_CHANGES, true);

  if (reportProgress) progress('renaming-identifiers', 22, 'remapping symbols, blocks, broadcasts, and procedures');
  applyCommonTransforms(output, generator.fork('common'), stats);
  recordPass('identifier-and-metadata-remapping', COMMON_CHANGES);
  if (reportProgress) {
    progress('renaming-identifiers', 34, 'identifier and display-name remapping complete', {
      identifiers: stats.identifiersRenamed,
      displayNames: stats.symbolsRenamed,
      commentsRemoved: stats.commentsRemoved
    });
  }

  const gameplayReservation = options.antiCheat === true
    ? reserveGameplayStateCandidates(
        output,
        collectVariableCandidates(output),
        generator.fork('gameplay-reservation')
      )
    : undefined;
  if (mode !== 'lossless' && applyAggressive) {
    applyAggressiveTransforms(
      output,
      mode,
      generator.fork('aggressive'),
      stats,
      reportProgress ? event => progress(
        event.stage,
        35 + Math.round(event.percentage * 0.47),
        event.detail,
        event.metrics
      ) : undefined,
      options.allowSize ?? false,
      gameplayReservation?.candidateKeys
    );
  } else if (reportProgress) {
    progress(
      'structural-obfuscation',
      82,
      mode === 'lossless'
        ? 'executable topology preserved in lossless mode'
        : 'stronger structural passes disabled by verifier fallback'
    );
  }
  if (gameplayReservation) releaseGameplayStateCandidates(output, gameplayReservation);
  if (mode !== 'lossless' && applyAggressive) {
    recordPass('aggressive-structural-hardening', AGGRESSIVE_CHANGES);
  }

  if (reportProgress) progress('cleaning-serialized-inputs', 84, 'removing newly inactive fallback values');
  const cleaned = applySafeOptimizations(output, {foldConstants: false});
  stats.inactiveFallbacksRemoved += cleaned.inactiveFallbacksRemoved;
  stats.commentsRemoved += cleaned.commentsRemoved;
  let losslessCoreSnapshot = recordPass('post-transform-cleanup', CLEANUP_CHANGES);

  if (options.extra === true) {
    if (reportProgress) {
      progress('applying-extra-privacy', 86, 'obscuring project names and optional editor metadata');
    }
    const privacy = applyExtraPrivacyTransform(
      output,
      generator.fork(EXTRA_PRIVACY_GENERATOR_DOMAIN)
    );
    const privacyNames = privacy.targetNamesRenamed
      + privacy.costumeNamesRenamed
      + privacy.soundNamesRenamed
      + privacy.broadcastNamesRenamed;
    stats.symbolsRenamed += privacyNames;
    stats.privacyNamesRenamed = privacyNames;
    stats.privacyMonitorsCanonicalized = privacy.monitorsCanonicalized;
    stats.privacyMetadataPropertiesRemoved = privacy.metadataPropertiesRemoved;
    for (const caveat of privacy.caveats) appendUnique(stats.caveats ??= [], caveat);
    losslessCoreSnapshot = recordPass(EXTRA_PRIVACY_PASS_NAME, EXTRA_PRIVACY_ALLOWED_CHANGES);
  }

  if (options.antiSave === true) {
    if (reportProgress) progress('installing-antisave', 87, 'adding signed-zero resave guards and editor canaries');
    const antiSave = applyAntiSaveTransform(
      output,
      generator.fork(ANTI_SAVE_GENERATOR_DOMAIN)
    );
    antiSaveManifest = antiSave.manifest;
    stats.antiSaveCanaries = antiSave.canaryCount;
    for (const caveat of antiSave.caveats) appendUnique(stats.caveats ??= [], caveat);
    recordPass(ANTI_SAVE_PASS_NAME, ANTISAVE_CHANGES);
    if (reportProgress) {
      progress('installing-antisave', 88, 'signed-zero guard and editor canaries installed', {
        canaries: antiSave.canaryCount
      });
    }
  }

  if (options.antiCheat === true) {
    if (reportProgress) {
      progress('installing-anticheat', 88, 'protecting selected gameplay state and adding tamper sentinels');
    }
    const gameplayState = applyGameplayStateProtection(
      output,
      generator.fork('gameplay-state'),
      gameplayReservation
        ? selectReservedGameplayStateCandidates(collectVariableCandidates(output), gameplayReservation)
        : []
    );
    const antiCheat = applyAntiCheatTransform(
      output,
      generator.fork('anti-cheat'),
      {gameplayState}
    );
    stats.decoysAdded += antiCheat.decoyVariableIds.length;
    stats.antiCheatDecoys = antiCheat.decoyVariableIds.length;
    recordPass('anti-cheat-instrumentation', ANTICHEAT_CHANGES);
    if (reportProgress) {
      progress('installing-anticheat', 95, 'tamper sentinels and event guards installed', {
        decoyVariables: antiCheat.decoyVariableIds.length,
        protectedVariables: gameplayState.protectedVariableIds.length
      });
    }
  } else {
    if (reportProgress) progress('installing-watermark', 92, 'adding the project watermark variable');
    applyWatermarkTransform(output, generator.fork('watermark'));
    recordPass('watermark', WATERMARK_CHANGES);
  }

  stats.blocksAfter = countBlockEquivalents(output);
  if (reportProgress) progress('validating-result', 98, 'checking the transformed reference graph and growth limits');
  const verification = verifyPostTransform(project, output, {
    mode: verificationMode,
    antiCheat: options.antiCheat === true,
    antiSave: options.antiSave === true,
    allowSize: options.allowSize === true,
    extra: options.extra === true,
    stats: verificationMode === mode ? stats : {...stats, mode: verificationMode},
    passTrace,
    ...(antiSaveManifest === undefined ? {} : {antiSaveManifest}),
    ...(verificationMode === 'lossless' && (options.antiCheat === true || options.antiSave === true)
      ? {losslessCoreSnapshot}
      : {})
  });
  return {
    result: {project: output, stats},
    verification,
    passTrace: Object.freeze([...passTrace])
  };
}

function finishVerifiedAttempt(attempt: TransformAttempt, progress: ProgressReporter): ObfuscationResult {
  const {stats} = attempt.result;
  stats.verification = {
    scope: attempt.verification.scope,
    verdict: 'verified-with-caveats',
    provenInvariants: attempt.verification.provenInvariants.length,
    attributedPasses: attempt.verification.passAttributions.length,
    caveats: attempt.verification.caveats.length
  };
  appendVerificationCaveats(stats, attempt.verification);
  progress('transformation-complete', 100, 'in-memory transformation and static verification complete', {
    blocksBefore: stats.blocksBefore,
    blocksAfter: stats.blocksAfter,
    warnings: stats.warnings.length
  });
  acceptedAttempts.set(attempt.result, attempt);
  return attempt.result;
}

export function getAntiCheatReleaseCheckpoint(
  result: ObfuscationResult
): VerificationPassBoundary | undefined {
  const attempt = acceptedAttempts.get(result);
  if (!attempt) throw new Error('release checkpoint requested for an unregistered obfuscation result');
  const matches = attempt.passTrace.filter(boundary => boundary.pass === 'anti-cheat-instrumentation');
  const checkpoint = matches.length === 1 ? matches[0] : undefined;
  if (
    checkpoint === undefined
    || attempt.passTrace.at(-1) !== checkpoint
    || checkpoint.after.fullDigest !== attempt.verification.transformed.fullDigest
  ) return undefined;
  return checkpoint;
}

function createStats(mode: ObfuscationMode, blocksBefore: number): ObfuscationStats {
  return {
    mode,
    blocksBefore,
    blocksAfter: blocksBefore,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    variablesVirtualized: 0,
    listsVirtualized: 0,
    constantsFolded: 0,
    inactiveFallbacksRemoved: 0,
    antiCheatDecoys: 0,
    antiSaveCanaries: 0,
    warnings: [],
    caveats: []
  };
}

function validateArguments(mode: ObfuscationMode, seed: Uint8Array, options: ObfuscationOptions): void {
  if (!MODES.has(mode)) throw new InputError(`unsupported obfuscation mode: ${JSON.stringify(mode)}`);
  if (!(seed instanceof Uint8Array)) throw new InputError('deterministic seed must be a Uint8Array');
  if (options.antiCheat !== undefined && typeof options.antiCheat !== 'boolean') {
    throw new InputError('antiCheat must be a boolean');
  }
  if (options.antiSave !== undefined && typeof options.antiSave !== 'boolean') {
    throw new InputError('antiSave must be a boolean');
  }
  if (options.allowSize !== undefined && typeof options.allowSize !== 'boolean') {
    throw new InputError('allowSize must be a boolean');
  }
  if (options.extra !== undefined && typeof options.extra !== 'boolean') {
    throw new InputError('extra must be a boolean');
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    throw new InputError('onProgress must be a function');
  }
}

type ProgressReporter = (
  stage: string,
  percentage: number,
  detail?: string,
  metrics?: Readonly<Record<string, number | string | boolean>>
) => void;

function progressReporter(options: ObfuscationOptions): ProgressReporter {
  return (stage, percentage, detail, metrics): void => {
    options.onProgress?.({
      stage,
      percentage,
      ...(detail === undefined ? {} : {detail}),
      ...(metrics === undefined ? {} : {metrics})
    });
  };
}

function verificationFailure(report: PostTransformVerificationReport): Error {
  return new Error(
    `post-transform static verification rejected the generated project (${verificationFailureAttribution(report)})`
  );
}

function verificationFailureAttribution(report: PostTransformVerificationReport): string {
  const codes = [...new Set(report.failures.map(finding => finding.code))].sort();
  const passes = new Set(report.failures.flatMap(finding => finding.pass === undefined ? [] : [finding.pass]));
  const categories = new Set<VerificationChangeCategory>();
  for (const attribution of report.passAttributions) {
    if (!attribution.continuous || attribution.unexpectedChanges.length > 0) passes.add(attribution.pass);
    for (const category of attribution.unexpectedChanges) categories.add(category);
  }
  return [
    `codes=${codes.length === 0 ? 'unattributed-failure' : codes.join(',')}`,
    `passes=${passes.size === 0 ? 'none' : [...passes].sort().join(',')}`,
    `categories=${categories.size === 0 ? 'none' : [...categories].sort().join(',')}`
  ].join('; ');
}

function appendVerificationCaveats(
  stats: ObfuscationStats,
  report: PostTransformVerificationReport
): void {
  const caveats = stats.caveats ?? (stats.caveats = []);
  for (const finding of report.caveats) {
    const attribution = finding.pass === undefined
      ? `code=${finding.code}`
      : `code=${finding.code}; pass=${finding.pass}`;
    appendUnique(caveats, `Static verifier caveat [${attribution}]: ${finding.message}`);
  }
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function validateWorkingProject(project: ScratchProject, allowRecoverable: boolean): void {
  try {
    if (allowRecoverable) validateProject(project, RECOVERABLE_INPUT_OPTIONS);
    else validateProject(project);
  } catch (error) {
    throw new Error('internal validation rejected the transformed project', {cause: error});
  }
}

export {applyCommonTransforms} from './common.js';
