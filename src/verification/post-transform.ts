import {createHash} from 'node:crypto';
import {serializeProjectPayload} from '../archive/writer.js';
import {
  aggressiveBlockEquivalentCap,
  antiCheatBlockGrowthLimit,
  compactSerializedJsonLimit,
  COMPACT_ANTICHEAT_JSON_GROWTH_BYTES,
  exceedsTransformedJsonSafetyLimit,
  transformedJsonSafetyLimit
} from '../growth-policy.js';
import {countBlockEquivalents, isPrimitive, isScratchBlock} from '../model/blocks.js';
import {cloneProject, isRecord} from '../model/json.js';
import {ANTI_CHEAT_DECOY_COUNT, ANTI_CHEAT_WATERMARK_NAME} from '../obfuscation/anticheat.js';
import type {
  ExtraPrivacyLevel,
  JsonValue,
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../types.js';
import {OFFICIAL_LITERAL_SHADOW_OPCODES} from '../validation/extensions.js';
import {validateProject} from '../validation/index.js';
import {
  ANTI_SAVE_PASS_NAME,
  isSafeCanaryText,
  isTrustedAntiSaveVerificationManifest,
  type AntiSaveHatGuardManifest,
  type AntiSaveProcedureManifest,
  type AntiSaveVerificationManifest
} from '../obfuscation/antisave.js';
import {isOfficialHatOpcode} from '../obfuscation/analysis.js';
import {
  EXTRA_EDITOR_SHADOW_CAVEAT,
  EXTRA_EDITOR_SHADOW_PASS_NAME,
  isTrustedExtraEditorShadowManifest,
  type ExtraEditorShadowManifest
} from '../obfuscation/privacy.js';

const SNAPSHOT_VERSION = 2;
const TRUSTED_VERIFICATION_SNAPSHOTS = new WeakSet<object>();
const STAGE_SENSING_PROPERTIES = new Set([
  'background #',
  'backdrop #',
  'backdrop name',
  'volume'
]);
const SPRITE_SENSING_PROPERTIES = new Set([
  'x position',
  'y position',
  'direction',
  'costume #',
  'costume name',
  'size',
  'volume'
]);
type ExtraSelectorKind = 'target' | 'costume' | 'backdrop' | 'sound' | 'broadcast';
interface ExtraSelectorPlan {
  readonly input: string;
  readonly kind: ExtraSelectorKind;
}
interface ExtraFieldPlan {
  readonly field: string;
  readonly kind: Exclude<ExtraSelectorKind, 'broadcast'>;
}
const EXTRA_TARGET_SENTINELS = new Set(['_mouse_', '_random_', '_stage_', '_myself_']);
const EXTRA_INPUT_SELECTORS: ReadonlyMap<string, ExtraSelectorPlan> = new Map([
  ['control_create_clone_of', {input: 'CLONE_OPTION', kind: 'target'}],
  ['event_broadcast', {input: 'BROADCAST_INPUT', kind: 'broadcast'}],
  ['event_broadcastandwait', {input: 'BROADCAST_INPUT', kind: 'broadcast'}],
  ['event_whentouchingobject', {input: 'TOUCHINGOBJECTMENU', kind: 'target'}],
  ['looks_switchbackdropto', {input: 'BACKDROP', kind: 'backdrop'}],
  ['looks_switchbackdroptoandwait', {input: 'BACKDROP', kind: 'backdrop'}],
  ['looks_switchcostumeto', {input: 'COSTUME', kind: 'costume'}],
  ['motion_glideto', {input: 'TO', kind: 'target'}],
  ['motion_goto', {input: 'TO', kind: 'target'}],
  ['motion_pointtowards', {input: 'TOWARDS', kind: 'target'}],
  ['sensing_distanceto', {input: 'DISTANCETOMENU', kind: 'target'}],
  ['sensing_of', {input: 'OBJECT', kind: 'target'}],
  ['sensing_touchingobject', {input: 'TOUCHINGOBJECTMENU', kind: 'target'}],
  ['sound_play', {input: 'SOUND_MENU', kind: 'sound'}],
  ['sound_playuntildone', {input: 'SOUND_MENU', kind: 'sound'}]
]);
const EXTRA_MENU_FIELDS: ReadonlyMap<string, ExtraFieldPlan> = new Map([
  ['control_create_clone_of_menu', {field: 'CLONE_OPTION', kind: 'target'}],
  ['looks_backdrops', {field: 'BACKDROP', kind: 'backdrop'}],
  ['looks_costume', {field: 'COSTUME', kind: 'costume'}],
  ['motion_goto_menu', {field: 'TO', kind: 'target'}],
  ['motion_pointtowards_menu', {field: 'TOWARDS', kind: 'target'}],
  ['sensing_distancetomenu', {field: 'DISTANCETOMENU', kind: 'target'}],
  ['sensing_of_object_menu', {field: 'OBJECT', kind: 'target'}],
  ['sensing_touchingobjectmenu', {field: 'TOUCHINGOBJECTMENU', kind: 'target'}],
  ['sound_sounds_menu', {field: 'SOUND_MENU', kind: 'sound'}]
]);

export const VERIFICATION_CHANGE_CATEGORIES = Object.freeze([
  'target-identity',
  'assets',
  'runtime-metadata',
  'symbols',
  'identifiers',
  'executable-topology',
  'executable-values',
  'serialized-block-data',
  'comments-layout',
  'monitors'
] as const);

export type VerificationChangeCategory = typeof VERIFICATION_CHANGE_CATEGORIES[number];
export type VerificationSeverity = 'failure' | 'caveat';

const FIXED_PASS_CHANGE_POLICIES: ReadonlyMap<string, readonly VerificationChangeCategory[]> = new Map<
  string,
  readonly VerificationChangeCategory[]
>([
  ['static-input-optimization', Object.freeze([
    'identifiers',
    'executable-topology',
    'executable-values',
    'serialized-block-data',
    'comments-layout',
    'monitors'
  ])],
  ['identifier-and-metadata-remapping', Object.freeze([
    'symbols',
    'identifiers',
    'executable-values',
    'serialized-block-data',
    'comments-layout',
    'monitors'
  ])],
  ['aggressive-structural-hardening', Object.freeze([
    'symbols',
    'identifiers',
    'executable-topology',
    'executable-values',
    'serialized-block-data',
    'comments-layout'
  ])],
  ['post-transform-cleanup', Object.freeze([
    'identifiers',
    'serialized-block-data',
    'comments-layout',
    'monitors'
  ])],
  ['anti-cheat-instrumentation', Object.freeze([
    'symbols',
    'identifiers',
    'executable-topology',
    'executable-values',
    'serialized-block-data',
    'comments-layout'
  ])],
  [ANTI_SAVE_PASS_NAME, Object.freeze([
    'symbols',
    'identifiers',
    'executable-topology',
    'executable-values',
    'serialized-block-data',
    'comments-layout'
  ])],
  ['watermark', Object.freeze(['symbols', 'identifiers'])],
  ['extra-project-privacy', Object.freeze([
    'target-identity',
    'assets',
    'runtime-metadata',
    'symbols',
    'executable-values',
    'serialized-block-data',
    'monitors'
  ])],
  [EXTRA_EDITOR_SHADOW_PASS_NAME, Object.freeze([
    'executable-topology',
    'executable-values',
    'serialized-block-data'
  ])]
]);

export interface ProjectVerificationSnapshot {
  readonly version: 2;
  readonly fullDigest: string;
  readonly targetIdentityDigest: string;
  readonly assetDescriptorDigest: string;
  readonly runtimeMetadataDigest: string;
  readonly symbolDigest: string;
  readonly cloudVariableDigest: string;
  readonly losslessDeclarationStateDigest: string;
  readonly stageWatermarkValueDigest: string | null;
  readonly identifierDigest: string;
  readonly executableTopologyDigest: string;
  readonly executableValueDigest: string;
  readonly extraExecutableValueDigest: string;
  readonly executableNodeSignatures: Readonly<Record<string, number>>;
  readonly serializedBlockDigest: string;
  readonly commentsLayoutDigest: string;
  readonly serializedMonitorDigest: string;
  readonly rawMonitorDigest: string;
  readonly monitorDeclarationDigest: string;
  readonly monitorRuntimeDigest: string;
  readonly monitorBindingDigest: string;
  readonly targetCount: number;
  readonly objectBlockCount: number;
  readonly executableObjectBlocks: number;
  readonly blockEquivalents: number;
  readonly serializedUtf8Bytes: number;
  readonly monitorCount: number;
  readonly preservableMonitorCount: number;
  readonly staleInvisibleMonitorCount: number;
  readonly typedReferenceIntegrityIssues: number;
  readonly variableCount: number;
  readonly listCount: number;
  readonly broadcastCount: number;
  readonly procedureCount: number;
  readonly activeStopAllCount: number;
  readonly stageWatermarkCount: number;
  readonly nativeHatCounts: Readonly<Record<string, number>>;
  readonly nativeHatSignatures: Readonly<Record<string, number>>;
  readonly nativeHatSites: readonly NativeHatSiteSnapshot[];
}

export interface NativeHatSiteSnapshot {
  readonly targetIndex: number;
  readonly hatId: string;
  readonly opcode: string;
  readonly originalNext: string | null;
}

export interface VerificationPassBoundary {
  readonly pass: string;
  readonly before: ProjectVerificationSnapshot;
  readonly after: ProjectVerificationSnapshot;
  readonly allowedChanges: readonly VerificationChangeCategory[];
}

export interface VerificationPassAttribution {
  readonly pass: string;
  readonly changes: readonly VerificationChangeCategory[];
  readonly unexpectedChanges: readonly VerificationChangeCategory[];
  readonly allowedButUnobserved: readonly VerificationChangeCategory[];
  readonly continuous: boolean;
}

export interface VerificationFinding {
  readonly severity: VerificationSeverity;
  readonly code: string;
  readonly message: string;
  readonly pass?: string;
}

export interface PostTransformVerificationOptions {
  readonly mode: ObfuscationMode;
  readonly antiCheat?: boolean;
  readonly antiSave?: boolean;
  readonly allowSize?: boolean;
  readonly extra?: boolean;
  readonly extraLevel?: ExtraPrivacyLevel;
  readonly stats?: Readonly<ObfuscationStats>;
  readonly passTrace?: readonly VerificationPassBoundary[];
  readonly antiSaveManifest?: AntiSaveVerificationManifest;
  readonly extraEditorShadowManifest?: ExtraEditorShadowManifest;
  /** Strict lossless checkpoint captured after common transforms and before anti-cheat instrumentation. */
  readonly losslessCoreSnapshot?: ProjectVerificationSnapshot;
}

export interface PostTransformVerificationReport {
  readonly scope: 'static-project-structure';
  readonly verdict: 'failed' | 'verified-with-caveats';
  readonly mode: ObfuscationMode;
  readonly antiCheat: boolean;
  readonly antiSave?: boolean;
  readonly extra: boolean;
  readonly extraLevel: ExtraPrivacyLevel;
  readonly source: ProjectVerificationSnapshot;
  readonly transformed: ProjectVerificationSnapshot;
  readonly losslessCore?: ProjectVerificationSnapshot;
  readonly failures: readonly VerificationFinding[];
  readonly caveats: readonly VerificationFinding[];
  readonly provenInvariants: readonly string[];
  readonly passAttributions: readonly VerificationPassAttribution[];
}

interface NormalizationMaps {
  readonly targets: readonly TargetNormalizationMaps[];
  readonly stageIndex: number;
}

interface TargetNormalizationMaps {
  readonly variables: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, string>;
  readonly broadcasts: ReadonlyMap<string, string>;
  readonly procedures: ReadonlyMap<string, string>;
  readonly procedureArguments: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly argumentNamesByProcedure: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface CanonicalExecutableGraph {
  readonly topology: readonly unknown[];
  readonly values: readonly unknown[];
  readonly nodeSignatures: Readonly<Record<string, number>>;
  readonly objectBlockCount: number;
  readonly executableObjectBlocks: number;
  readonly procedureCount: number;
  readonly activeStopAllCount: number;
  readonly nativeHatCounts: Readonly<Record<string, number>>;
  readonly nativeHatSignatures: Readonly<Record<string, number>>;
  readonly nativeHatSites: readonly NativeHatSiteSnapshot[];
}

export function captureProjectVerificationSnapshot(project: ScratchProject): ProjectVerificationSnapshot {
  const maps = buildNormalizationMaps(project);
  const executable = canonicalExecutableGraph(project, maps);
  const variableCount = project.targets.reduce((sum, target) => sum + Object.keys(target.variables).length, 0);
  const listCount = project.targets.reduce((sum, target) => sum + Object.keys(target.lists).length, 0);
  const broadcastCount = project.targets.reduce((sum, target) => sum + Object.keys(target.broadcasts).length, 0);
  const stage = project.targets.find(target => target.isStage);
  const stageWatermarkCount = stage
    ? Object.values(stage.variables).filter(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME).length
    : 0;
  const stageWatermark = stageWatermarkCount >= 1
    ? Object.values(stage?.variables ?? {}).find(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME)
    : undefined;
  const preservableMonitors = project.monitors.filter(monitor => !isRecoverableStaleInvisibleMonitor(project, monitor));
  const staleInvisibleMonitorCount = project.monitors.length - preservableMonitors.length;
  return registerVerificationSnapshot(Object.freeze({
    version: SNAPSHOT_VERSION,
    fullDigest: digest(project),
    targetIdentityDigest: digest(project.targets.map(target => ({isStage: target.isStage, name: target.name}))),
    assetDescriptorDigest: digest(project.targets.map(target => ({
      costumes: target.costumes,
      sounds: target.sounds
    }))),
    runtimeMetadataDigest: digest(canonicalRuntimeMetadata(project)),
    symbolDigest: digest(project.targets.map(target => ({
      variables: target.variables,
      lists: target.lists,
      broadcasts: target.broadcasts
    }))),
    cloudVariableDigest: digest(canonicalCloudVariables(project)),
    losslessDeclarationStateDigest: digest(canonicalLosslessDeclarationState(project)),
    stageWatermarkValueDigest: stageWatermark ? digest(stageWatermark.slice(1)) : null,
    identifierDigest: digest(project.targets.map(target => ({
      blocks: Object.keys(target.blocks),
      variables: Object.keys(target.variables),
      lists: Object.keys(target.lists),
      broadcasts: Object.keys(target.broadcasts),
      comments: Object.keys(target.comments)
    }))),
    executableTopologyDigest: digest(executable.topology),
    executableValueDigest: digest(executable.values),
    extraExecutableValueDigest: digest(canonicalExtraExecutableValues(project, maps)),
    executableNodeSignatures: executable.nodeSignatures,
    serializedBlockDigest: digest(canonicalSerializedBlocks(project, maps)),
    commentsLayoutDigest: digest(canonicalCommentsAndLayout(project)),
    serializedMonitorDigest: digest(canonicalMonitors(project, maps, project.monitors)),
    rawMonitorDigest: digest(project.monitors),
    monitorDeclarationDigest: digest(rawMonitorDeclarations(project, preservableMonitors)),
    monitorRuntimeDigest: digest(canonicalMonitors(project, maps, preservableMonitors)),
    monitorBindingDigest: digest(canonicalMonitorBindings(project, maps, preservableMonitors)),
    targetCount: project.targets.length,
    objectBlockCount: executable.objectBlockCount,
    executableObjectBlocks: executable.executableObjectBlocks,
    blockEquivalents: countBlockEquivalents(project),
    serializedUtf8Bytes: serializeProjectPayload(project).byteLength,
    monitorCount: project.monitors.length,
    preservableMonitorCount: preservableMonitors.length,
    staleInvisibleMonitorCount,
    typedReferenceIntegrityIssues: countTypedReferenceIntegrityIssues(project, maps),
    variableCount,
    listCount,
    broadcastCount,
    procedureCount: executable.procedureCount,
    activeStopAllCount: executable.activeStopAllCount,
    stageWatermarkCount,
    nativeHatCounts: executable.nativeHatCounts,
    nativeHatSignatures: executable.nativeHatSignatures,
    nativeHatSites: executable.nativeHatSites
  }));
}

function registerVerificationSnapshot(snapshot: ProjectVerificationSnapshot): ProjectVerificationSnapshot {
  TRUSTED_VERIFICATION_SNAPSHOTS.add(snapshot);
  return snapshot;
}

export function changedVerificationCategories(
  before: ProjectVerificationSnapshot,
  after: ProjectVerificationSnapshot
): VerificationChangeCategory[] {
  requireSnapshotVersion(before);
  requireSnapshotVersion(after);
  const changes: VerificationChangeCategory[] = [];
  const compare = (
    category: VerificationChangeCategory,
    left: keyof ProjectVerificationSnapshot,
    right: keyof ProjectVerificationSnapshot
  ): void => {
    if (before[left] !== after[right]) changes.push(category);
  };
  compare('target-identity', 'targetIdentityDigest', 'targetIdentityDigest');
  compare('assets', 'assetDescriptorDigest', 'assetDescriptorDigest');
  compare('runtime-metadata', 'runtimeMetadataDigest', 'runtimeMetadataDigest');
  compare('symbols', 'symbolDigest', 'symbolDigest');
  compare('identifiers', 'identifierDigest', 'identifierDigest');
  compare('executable-topology', 'executableTopologyDigest', 'executableTopologyDigest');
  compare('executable-values', 'executableValueDigest', 'executableValueDigest');
  compare('serialized-block-data', 'serializedBlockDigest', 'serializedBlockDigest');
  compare('comments-layout', 'commentsLayoutDigest', 'commentsLayoutDigest');
  compare('monitors', 'rawMonitorDigest', 'rawMonitorDigest');
  return changes;
}

export function verifyPostTransform(
  source: ScratchProject,
  transformed: ScratchProject,
  options: PostTransformVerificationOptions
): PostTransformVerificationReport {
  const failures: VerificationFinding[] = [];
  const caveats: VerificationFinding[] = [];
  const antiCheat = options.antiCheat === true;
  const antiSave = options.antiSave === true;
  const extraLevel = resolveVerificationExtraLevel(options, failures);
  const extra = extraLevel >= 1;
  const sourceSnapshot = captureProjectVerificationSnapshot(source);
  const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
  const proven = new Set<string>();
  const losslessCore = options.losslessCoreSnapshot;
  if (losslessCore) requireSnapshotVersion(losslessCore);
  validateForVerification(source, 'source', failures, true);
  validateForVerification(transformed, 'transformed', failures, false);
  if (!failures.some(finding => finding.code === 'transformed-project-invalid')) {
    proven.add('transformed-project-schema-and-reference-validity');
  }

  verifyImmutableProjectSurfaces(
    source,
    transformed,
    sourceSnapshot,
    transformedSnapshot,
    extra,
    failures,
    proven
  );
  verifyTypedReferenceIntegrity(transformedSnapshot, failures, proven);
  verifyWatermark(sourceSnapshot, transformedSnapshot, failures, proven);
  verifyTransformedJsonSafetyCap(transformedSnapshot, options.mode, failures, proven);
  verifyAntiSaveSurface(transformed, options, failures, proven);
  const extraEditorShadowCheckpoint = verifyExtraEditorShadowSurface(
    transformed,
    transformedSnapshot,
    extraLevel,
    options.passTrace,
    options.extraEditorShadowManifest,
    failures,
    caveats,
    proven
  );
  const semanticTransformedSnapshot = extraEditorShadowCheckpoint?.before ?? transformedSnapshot;
  const semanticPassTrace = extraEditorShadowCheckpoint === undefined
    ? options.passTrace
    : options.passTrace?.slice(0, -1);
  verifyAntiCheatSurface(
    sourceSnapshot,
    semanticTransformedSnapshot,
    options,
    failures,
    caveats,
    proven
  );
  verifyMonitorPreservation(
    sourceSnapshot,
    transformedSnapshot,
    options.mode,
    antiCheat,
    antiSave,
    extra,
    options.passTrace,
    failures,
    proven
  );
  verifyModeGraphPolicy(
    sourceSnapshot,
    semanticTransformedSnapshot,
    losslessCore,
    options.mode,
    antiCheat,
    antiSave,
    options.allowSize === true,
    semanticPassTrace,
    options.antiSaveManifest,
    extra,
    failures,
    caveats,
    proven
  );
  verifyStats(sourceSnapshot, transformedSnapshot, options, extraLevel, failures, proven);
  const passAttributions = verifyPassTrace(
    sourceSnapshot,
    transformedSnapshot,
    options.passTrace,
    failures,
    caveats,
    proven
  );
  addScopeCaveats(options.mode, antiCheat, extraLevel, caveats);

  return Object.freeze({
    scope: 'static-project-structure',
    verdict: failures.length > 0 ? 'failed' : 'verified-with-caveats',
    mode: options.mode,
    antiCheat,
    antiSave,
    extra,
    extraLevel,
    source: sourceSnapshot,
    transformed: transformedSnapshot,
    ...(losslessCore === undefined ? {} : {losslessCore}),
    failures: Object.freeze(failures),
    caveats: Object.freeze(caveats),
    provenInvariants: Object.freeze([...proven].sort()),
    passAttributions: Object.freeze(passAttributions)
  });
}

function resolveVerificationExtraLevel(
  options: PostTransformVerificationOptions,
  failures: VerificationFinding[]
): ExtraPrivacyLevel {
  const supplied: unknown = options.extraLevel;
  if (supplied === 0 || supplied === 1 || supplied === 2) {
    if (options.extra !== undefined && options.extra !== (supplied > 0)) {
      failures.push({
        severity: 'failure',
        code: 'extra-level-option-conflict',
        message: 'The legacy extra option conflicts with the requested extra level.'
      });
    }
    return supplied;
  }
  if (supplied !== undefined) {
    failures.push({
      severity: 'failure',
      code: 'extra-level-invalid',
      message: 'The verifier extra level must be 0, 1, or 2.'
    });
  }
  return options.extra === true ? 1 : 0;
}

function verifyExtraEditorShadowSurface(
  transformedProject: ScratchProject,
  transformedSnapshot: ProjectVerificationSnapshot,
  extraLevel: ExtraPrivacyLevel,
  passTrace: readonly VerificationPassBoundary[] | undefined,
  manifest: ExtraEditorShadowManifest | undefined,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): VerificationPassBoundary | undefined {
  const checkpoints = passTrace?.filter(boundary => boundary.pass === EXTRA_EDITOR_SHADOW_PASS_NAME) ?? [];
  if (extraLevel !== 2) {
    if (manifest !== undefined || checkpoints.length > 0) {
      failures.push({
        severity: 'failure',
        code: 'extra-editor-shadow-unexpected',
        message: 'An extra editor-shadow manifest or pass was supplied without extra level 2.'
      });
    }
    return undefined;
  }

  const checkpoint = checkpoints.length === 1 ? checkpoints[0] : undefined;
  if (
    checkpoint === undefined
    || passTrace?.at(-1) !== checkpoint
    || checkpoint.after.fullDigest !== transformedSnapshot.fullDigest
  ) {
    failures.push({
      severity: 'failure',
      code: 'extra-editor-shadow-checkpoint-missing',
      message: 'Extra level 2 requires exactly one final editor-shadow pass boundary matching the output.'
    });
    return undefined;
  }
  if (!isTrustedExtraEditorShadowManifest(manifest)) {
    failures.push({
      severity: 'failure',
      code: 'extra-editor-shadow-manifest-missing-or-untrusted',
      message: 'Extra level 2 requires the immutable editor-shadow manifest from the current transform attempt.'
    });
    return checkpoint;
  }

  requireSnapshotVersion(checkpoint.before);
  requireSnapshotVersion(checkpoint.after);
  const initialFailureCount = failures.length;
  const actualSites = new Map<string, {readonly opcode: string; readonly shadow: boolean}>();
  for (const [targetIndex, target] of transformedProject.targets.entries()) {
    for (const [hatId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || !value.topLevel || !isOfficialHatOpcode(value.opcode)) continue;
      actualSites.set(`${targetIndex}\u0000${hatId}`, {opcode: value.opcode, shadow: value.shadow});
    }
  }

  const seen = new Set<string>();
  let changedHatCount = 0;
  for (const site of manifest.sites) {
    const key = `${site.targetIndex}\u0000${site.hatId}`;
    const actual = actualSites.get(key);
    if (
      seen.has(key)
      || actual === undefined
      || actual.opcode !== site.opcode
      || actual.shadow !== true
    ) {
      failures.push({
        severity: 'failure',
        code: 'extra-editor-shadow-site-invalid',
        message: 'The trusted extra level 2 manifest does not exactly match a shadowed top-level native hat.'
      });
      continue;
    }
    seen.add(key);
    if (!site.previousShadow) changedHatCount += 1;
  }
  if (seen.size !== actualSites.size || manifest.sites.length !== actualSites.size) {
    failures.push({
      severity: 'failure',
      code: 'extra-editor-shadow-coverage-invalid',
      message: 'Extra level 2 did not account for every final top-level native hat exactly once.'
    });
  }
  if (manifest.changedHatCount !== changedHatCount) {
    failures.push({
      severity: 'failure',
      code: 'extra-editor-shadow-count-invalid',
      message: 'The extra level 2 changed-hat count does not match its immutable manifest sites.'
    });
  }

  if (failures.length === initialFailureCount) {
    const restored = cloneProject(transformedProject);
    for (const site of manifest.sites) {
      const block = restored.targets[site.targetIndex]?.blocks[site.hatId];
      if (!isScratchBlock(block)) {
        failures.push({
          severity: 'failure',
          code: 'extra-editor-shadow-restoration-failed',
          message: 'A manifest-bound native hat could not be restored for exact pass verification.'
        });
        break;
      }
      block.shadow = site.previousShadow;
    }
    if (
      failures.length === initialFailureCount
      && captureProjectVerificationSnapshot(restored).fullDigest !== checkpoint.before.fullDigest
    ) {
      failures.push({
        severity: 'failure',
        code: 'extra-editor-shadow-pass-not-isolated',
        message: 'Reversing the manifest-bound shadow flags did not exactly reconstruct the pre-pass project.'
      });
    }
  }

  if (failures.length !== initialFailureCount) return checkpoint;
  proven.add('extra-editor-shadow-pass-changes-only-manifest-bound-native-hat-flags');
  proven.add('extra-editor-shadow-covers-every-final-top-level-native-hat');
  caveats.push(manifest.sites.length === 0
    ? {
        severity: 'caveat',
        code: 'extra-editor-shadow-no-native-hats-found',
        message: 'Extra level 2 found no top-level native event hats to mark as shadows.'
      }
    : {
        severity: 'caveat',
        code: 'extra-editor-shadow-disables-native-event-stacks',
        message: EXTRA_EDITOR_SHADOW_CAVEAT
      });
  return checkpoint;
}

function validateForVerification(
  project: ScratchProject,
  label: 'source' | 'transformed',
  failures: VerificationFinding[],
  allowRecoverable: boolean
): void {
  try {
    validateProject(project, allowRecoverable ? {
      allowRecoverableInactiveShadowOwnership: true,
      allowRecoverableLocalSymbolIdCollisions: true,
      allowRecoverableOrphanedShadowHatRoots: true,
      allowRecoverableStaleInvisibleMonitors: true
    } : {});
  } catch (error) {
    failures.push({
      severity: 'failure',
      code: `${label}-project-invalid`,
      message: `${label} project validation failed: ${errorMessage(error)}`
    });
  }
}

function verifyImmutableProjectSurfaces(
  sourceProject: ScratchProject,
  transformedProject: ScratchProject,
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  extra: boolean,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if (extra) {
    verifyExtraPrivacySurfaces(sourceProject, transformedProject, failures, proven);
  } else {
    compareRequiredDigest(
      source.targetIdentityDigest,
      transformed.targetIdentityDigest,
      'target-order-or-identity-changed',
      'Target order, Stage roles, and target names must be preserved.',
      'target-order-and-identity-preserved',
      failures,
      proven
    );
    compareRequiredDigest(
      source.assetDescriptorDigest,
      transformed.assetDescriptorDigest,
      'asset-descriptors-changed',
      'Costume or sound descriptors changed.',
      'costume-and-sound-descriptors-preserved',
      failures,
      proven
    );
    compareRequiredDigest(
      source.runtimeMetadataDigest,
      transformed.runtimeMetadataDigest,
      'runtime-metadata-changed',
      'Project metadata or target runtime state outside the executable graph changed.',
      'project-and-target-runtime-metadata-preserved',
      failures,
      proven
    );
  }
  compareRequiredDigest(
    source.cloudVariableDigest,
    transformed.cloudVariableDigest,
    'cloud-variable-state-changed',
    'A cloud variable name, value, declaration order, or cloud marker changed.',
    'cloud-variable-names-and-initial-state-preserved',
    failures,
    proven
  );
}

function verifyExtraPrivacySurfaces(
  source: ScratchProject,
  transformed: ScratchProject,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const sourceRoles = source.targets.map(target => target.isStage);
  const transformedRoles = transformed.targets.map(target => target.isStage);
  const transformedStage = transformed.targets.find(target => target.isStage);
  if (digest(sourceRoles) !== digest(transformedRoles) || transformedStage?.name !== 'Stage') {
    failures.push({
      severity: 'failure',
      code: 'extra-target-order-or-stage-identity-changed',
      message: 'Extra privacy must preserve target order, Stage roles, and the literal Stage identity.'
    });
  } else {
    proven.add('extra-privacy-preserves-target-order-stage-roles-and-stage-identity');
  }

  if (digest(canonicalAssetDescriptorsWithoutDisplayNames(source))
    !== digest(canonicalAssetDescriptorsWithoutDisplayNames(transformed))) {
    failures.push({
      severity: 'failure',
      code: 'extra-asset-payload-descriptor-changed',
      message: 'Extra privacy changed a costume or sound descriptor property other than its display name.'
    });
  } else {
    proven.add('extra-privacy-preserves-asset-payload-descriptors');
  }

  if (digest(canonicalExtraCompatibleRuntimeMetadata(source))
    !== digest(canonicalExtraCompatibleRuntimeMetadata(transformed))) {
    failures.push({
      severity: 'failure',
      code: 'extra-runtime-state-changed',
      message: 'Extra privacy changed extension declarations, semver, or target runtime state.'
    });
  } else {
    proven.add('extra-privacy-preserves-extension-and-target-runtime-state');
  }

  const allowedRootKeys = new Set(['targets', 'monitors', 'extensions', 'meta']);
  const unexpectedRootKeys = Object.keys(transformed).filter(key => !allowedRootKeys.has(key));
  const unexpectedMetaKeys = Object.keys(transformed.meta).filter(key => key !== 'semver');
  if (unexpectedRootKeys.length > 0 || unexpectedMetaKeys.length > 0) {
    failures.push({
      severity: 'failure',
      code: 'extra-optional-metadata-retained',
      message: 'Extra privacy retained noncanonical root metadata or optional provenance fields.'
    });
  } else {
    proven.add('extra-privacy-removes-optional-project-provenance');
  }
}

function canonicalAssetDescriptorsWithoutDisplayNames(project: ScratchProject): unknown {
  return project.targets.map(target => ({
    costumes: target.costumes.map(descriptor => Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== 'name')
    )),
    sounds: target.sounds.map(descriptor => Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== 'name')
    ))
  }));
}

function canonicalExtraCompatibleRuntimeMetadata(project: ScratchProject): unknown {
  return {
    extensions: project.extensions,
    semver: project.meta['semver'],
    targets: project.targets.map(target => Object.fromEntries(Object.entries(target).filter(([key]) => ![
      'isStage',
      'name',
      'variables',
      'lists',
      'broadcasts',
      'blocks',
      'comments',
      'costumes',
      'sounds'
    ].includes(key))))
  };
}

function verifyWatermark(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if (transformed.stageWatermarkCount !== 1) {
    failures.push({
      severity: 'failure',
      code: 'watermark-cardinality-invalid',
      message: `Expected exactly one Stage ${JSON.stringify(ANTI_CHEAT_WATERMARK_NAME)} variable, found ${transformed.stageWatermarkCount}.`
    });
  } else {
    proven.add('single-required-watermark-present');
    if (source.stageWatermarkCount >= 1
      && source.stageWatermarkValueDigest !== transformed.stageWatermarkValueDigest) {
      failures.push({
        severity: 'failure',
        code: 'existing-watermark-value-changed',
        message: 'The scalar value and declaration flags of the pre-existing Stage watermark changed.'
      });
    } else if (source.stageWatermarkCount >= 1) {
      proven.add('existing-stage-watermark-value-preserved');
    }
  }
}

function verifyTypedReferenceIntegrity(
  transformed: ProjectVerificationSnapshot,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if (transformed.typedReferenceIntegrityIssues > 0) {
    failures.push({
      severity: 'failure',
      code: 'typed-reference-display-inconsistent',
      message: `The transformed project contains ${transformed.typedReferenceIntegrityIssues} typed reference display/ID inconsistency or incomplete data-monitor binding(s).`
    });
  } else proven.add('transformed-typed-reference-displays-match-bound-declarations');
}

function verifyMonitorPreservation(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  mode: ObfuscationMode,
  antiCheat: boolean,
  antiSave: boolean,
  extra: boolean,
  trace: readonly VerificationPassBoundary[] | undefined,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if ((mode !== 'lossless' || antiCheat || antiSave) && (!trace || trace.length === 0)) {
    failures.push({
      severity: 'failure',
      code: 'monitor-pass-lineage-missing',
      message: 'Topology-changing instrumentation requires trusted pass snapshots to prove monitor lineage.'
    });
    return;
  }
  if ((mode !== 'lossless' || antiCheat || antiSave) && trace) {
    let preserved = true;
    for (const boundary of trace) {
      let boundaryPreserved: boolean;
      if (boundary.pass === 'static-input-optimization'
        || boundary.pass === 'identifier-and-metadata-remapping'
        || boundary.pass === 'post-transform-cleanup') {
        boundaryPreserved = boundary.before.preservableMonitorCount === boundary.after.preservableMonitorCount
          && boundary.before.monitorRuntimeDigest === boundary.after.monitorRuntimeDigest
          && boundary.before.losslessDeclarationStateDigest === boundary.after.losslessDeclarationStateDigest;
      } else if (boundary.pass === 'extra-project-privacy') {
        boundaryPreserved = boundary.before.preservableMonitorCount === boundary.after.preservableMonitorCount
          && boundary.before.monitorBindingDigest === boundary.after.monitorBindingDigest
          && boundary.before.losslessDeclarationStateDigest === boundary.after.losslessDeclarationStateDigest
          && boundary.after.staleInvisibleMonitorCount === 0;
      } else {
        boundaryPreserved = boundary.before.preservableMonitorCount === boundary.after.preservableMonitorCount
          && boundary.before.rawMonitorDigest === boundary.after.rawMonitorDigest
          && boundary.before.monitorDeclarationDigest === boundary.after.monitorDeclarationDigest;
      }
      if (boundaryPreserved) continue;
      preserved = false;
      failures.push({
        severity: 'failure',
        code: 'monitor-pass-lineage-changed',
        pass: boundary.pass,
        message: `Pass ${JSON.stringify(boundary.pass)} changed monitor runtime configuration, binding, or bound declaration state.`
      });
    }
    if (transformed.staleInvisibleMonitorCount > 0) {
      preserved = false;
      failures.push({
        severity: 'failure',
        code: 'stale-invisible-monitor-retained',
        message: `The transformed project retains ${transformed.staleInvisibleMonitorCount} recoverable stale invisible data monitor(s).`
      });
    }
    if (preserved) {
      proven.add(extra
        ? 'extra-privacy-retains-monitor-records-and-exact-runtime-bindings'
        : source.staleInvisibleMonitorCount > 0
          ? 'monitor-runtime-configuration-preserved-after-stale-invisible-monitor-removal'
          : 'monitor-runtime-configuration-preserved');
      proven.add('monitor-bindings-preserved-through-pass-lineage');
    }
    return;
  }
  if (extra) {
    if (source.preservableMonitorCount !== transformed.preservableMonitorCount
      || source.monitorBindingDigest !== transformed.monitorBindingDigest
      || transformed.staleInvisibleMonitorCount > 0) {
      failures.push({
        severity: 'failure',
        code: 'extra-monitor-binding-surface-changed',
        message: 'Extra privacy changed a monitor binding, changed the preservable monitor count, or retained a stale invisible monitor.'
      });
    } else {
      proven.add('extra-privacy-retains-monitor-records-and-exact-runtime-bindings');
    }
    return;
  }
  if (source.preservableMonitorCount !== transformed.preservableMonitorCount
    || source.monitorRuntimeDigest !== transformed.monitorRuntimeDigest) {
    failures.push({
      severity: 'failure',
      code: 'monitor-runtime-configuration-changed',
      message: 'Preservable monitor count, visibility, placement, slider configuration, or normalized binding changed.'
    });
  } else if (transformed.staleInvisibleMonitorCount > 0) {
    failures.push({
      severity: 'failure',
      code: 'stale-invisible-monitor-retained',
      message: `The transformed project retains ${transformed.staleInvisibleMonitorCount} recoverable stale invisible data monitor(s).`
    });
  } else {
    proven.add(source.staleInvisibleMonitorCount > 0
      ? 'monitor-runtime-configuration-preserved-after-stale-invisible-monitor-removal'
      : 'monitor-runtime-configuration-preserved');
  }
}

function verifyAntiCheatSurface(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  options: PostTransformVerificationOptions,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): void {
  if (options.antiCheat !== true) return;
  const stats = options.stats;
  if (!stats) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-stats-missing',
      message: 'Anti-cheat verification requires transform stats that identify the generated decoy count.'
    });
  } else if (stats.antiCheatDecoys !== ANTI_CHEAT_DECOY_COUNT) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-decoy-count-mismatch',
      message: `Anti-cheat stats report ${String(stats.antiCheatDecoys)} decoys; expected ${ANTI_CHEAT_DECOY_COUNT}.`
    });
  }
  if (transformed.variableCount < ANTI_CHEAT_DECOY_COUNT + 1) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-sentinel-surface-missing',
      message: 'The transformed declaration surface is too small to contain the watermark and configured decoy sentinels.'
    });
  }
  if (transformed.activeStopAllCount === 0 || transformed.activeStopAllCount <= source.activeStopAllCount) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-trip-path-missing',
      message: 'No additional reachable stop-all trip block was found in the anti-cheat output.'
    });
  }
  if (!failures.some(finding => finding.code.startsWith('anticheat-'))) {
    proven.add('anticheat-decoy-count-and-reachable-stop-surface-present');
  }
  caveats.push({
    severity: 'caveat',
    code: 'anticheat-manifest-level-integrity-not-proven',
    message: 'Without an internal sentinel/guard manifest, static verification cannot prove every decoy, latch, guarded site, and trip path is correctly coupled.'
  });
}

function verifyAntiSaveSurface(
  transformedProject: ScratchProject,
  options: PostTransformVerificationOptions,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if (options.antiSave !== true) {
    if (options.antiSaveManifest !== undefined) {
      addAntiSaveFailure(
        failures,
        'antisave-manifest-unexpected',
        'An anti-save manifest was supplied while anti-save instrumentation is disabled.'
      );
    }
    return;
  }
  const manifest = options.antiSaveManifest;
  if (!isTrustedAntiSaveVerificationManifest(manifest)) {
    addAntiSaveFailure(
      failures,
      'antisave-manifest-missing-or-untrusted',
      'Anti-save verification requires the immutable manifest emitted by the current transform attempt.'
    );
    return;
  }

  const initialFailureCount = failures.length;
  const antiSaveBoundaries = options.passTrace?.filter(
    boundary => boundary.pass === ANTI_SAVE_PASS_NAME
  ) ?? [];
  const antiSaveBoundary = antiSaveBoundaries.length === 1 ? antiSaveBoundaries[0] : undefined;
  if (
    antiSaveBoundary === undefined
    || !sameAntiSaveHatSites(manifest.hatGuards, antiSaveBoundary.before.nativeHatSites)
  ) {
    addAntiSaveFailure(
      failures,
      'antisave-hat-coverage-invalid',
      'The trusted anti-save manifest does not exactly cover every official native-hat site and original successor at the pre-pass checkpoint.'
    );
  }
  const stage = transformedProject.targets[manifest.stageTargetIndex];
  const sentinel = stage?.variables[manifest.sentinelVariableId];
  const marker = stage?.lists[manifest.markerListId];
  if (
    !stage?.isStage
    || sentinel?.length !== 2
    || sentinel[0] !== manifest.sentinelName
    || !Object.is(sentinel[1], -0)
    || marker?.length !== 2
    || marker[0] !== manifest.markerListName
    || !Array.isArray(marker[1])
    || marker[1].length !== 1
    || marker[1][0] !== manifest.markerListValue
  ) {
    addAntiSaveFailure(
      failures,
      'antisave-canary-declaration-invalid',
      'The manifest-bound Stage signed-zero variable or marker list is missing or changed.'
    );
  }
  if (![manifest.sentinelName, manifest.markerListName, manifest.markerListValue]
    .every(isSafeCanaryText)) {
    addAntiSaveFailure(
      failures,
      'antisave-unicode-canary-invalid',
      'An anti-save declaration or marker contains unsafe or unstable Unicode text.'
    );
  }

  const expectedProcedureTargets = new Set([
    manifest.stageTargetIndex,
    ...manifest.hatGuards.map(site => site.targetIndex)
  ]);
  const actualProcedureTargets = new Set(manifest.procedures.map(procedure => procedure.targetIndex));
  if (
    manifest.procedures.length !== expectedProcedureTargets.size
    || actualProcedureTargets.size !== manifest.procedures.length
    || [...expectedProcedureTargets].some(targetIndex => !actualProcedureTargets.has(targetIndex))
  ) {
    addAntiSaveFailure(
      failures,
      'antisave-procedure-target-coverage-invalid',
      'Anti-save does not have exactly one manifest-bound guard procedure for Stage and each guarded target.'
    );
  }

  const procedureByTarget = new Map<number, AntiSaveProcedureManifest>();
  const generatedIds = [manifest.sentinelVariableId, manifest.markerListId];
  for (const procedure of manifest.procedures) {
    procedureByTarget.set(procedure.targetIndex, procedure);
    generatedIds.push(
      procedure.definitionId,
      procedure.prototypeId,
      procedure.guardId,
      procedure.notId,
      procedure.lessThanId,
      procedure.divideId,
      procedure.stopId
    );
    if (!isSafeCanaryText(procedure.procedureCode)) {
      addAntiSaveFailure(
        failures,
        'antisave-unicode-canary-invalid',
        'An anti-save procedure code contains unsafe or unstable Unicode text.'
      );
    }
    const target = transformedProject.targets[procedure.targetIndex];
    if (!target || !hasExactAntiSaveProcedure(target, procedure, manifest)) {
      addAntiSaveFailure(
        failures,
        'antisave-guard-procedure-invalid',
        'A target-local anti-save procedure no longer implements the exact signed-zero stop-all chain.'
      );
    }
  }

  const seenHatSites = new Set<string>();
  const seenCallIds = new Set<string>();
  for (const site of manifest.hatGuards) {
    const siteKey = `${site.targetIndex}\u0000${site.hatId}`;
    if (seenHatSites.has(siteKey) || seenCallIds.has(site.callId)) {
      addAntiSaveFailure(
        failures,
        'antisave-hat-coverage-invalid',
        'The anti-save manifest contains a duplicate guarded hat or guard call.'
      );
      continue;
    }
    seenHatSites.add(siteKey);
    seenCallIds.add(site.callId);
    generatedIds.push(site.callId);
    const procedure = procedureByTarget.get(site.targetIndex);
    const target = transformedProject.targets[site.targetIndex];
    const hat = target?.blocks[site.hatId];
    const call = target?.blocks[site.callId];
    if (
      !procedure
      || procedure.procedureCode !== site.procedureCode
      || !target
      || !isScratchBlock(hat)
      || !hat.topLevel
      || hat.opcode !== site.hatOpcode
      || !isOfficialHatOpcode(hat.opcode)
      || !isExactAntiSaveCall(call, site.procedureCode)
    ) {
      addAntiSaveFailure(
        failures,
        'antisave-hat-guard-invalid',
        'A manifest-bound native hat or its target-local anti-save call is missing or changed.'
      );
      continue;
    }
    const expectedParent = antiSaveCallParent(target, hat, site, options.antiCheat === true);
    if (expectedParent === undefined || call.parent !== expectedParent) {
      addAntiSaveFailure(
        failures,
        options.antiCheat === true
          ? 'antisave-anticheat-wrapper-order-invalid'
          : 'antisave-hat-guard-invalid',
        options.antiCheat === true
          ? 'Anti-cheat must wrap each native hat before its anti-save call without bypassing the signed-zero guard.'
          : 'Each native hat must enter its anti-save call before the original continuation.'
      );
    }
    const continuationParent = antiSaveContinuationParent(
      target,
      call,
      site,
      options.antiCheat === true
    );
    if (continuationParent === undefined) {
      addAntiSaveFailure(
        failures,
        options.antiCheat === true
          ? 'antisave-anticheat-wrapper-order-invalid'
          : 'antisave-hat-guard-invalid',
        options.antiCheat === true
          ? 'Anti-cheat continuation guards must remain between each anti-save call and its original event continuation.'
          : 'Each anti-save call must lead directly to its original event continuation.'
      );
    }
    if (site.originalNext !== null) {
      const successor = target.blocks[site.originalNext];
      if (!isScratchBlock(successor) || successor.parent !== continuationParent) {
        addAntiSaveFailure(
          failures,
          'antisave-original-successor-invalid',
          'An anti-save call no longer preserves ownership of its original event continuation.'
        );
      }
    }
  }

  for (const procedure of manifest.procedures) {
    const target = transformedProject.targets[procedure.targetIndex];
    if (!target) continue;
    const expectedCalls = new Set(
      manifest.hatGuards
        .filter(site => site.targetIndex === procedure.targetIndex)
        .map(site => site.callId)
    );
    const actualCalls = new Set(Object.entries(target.blocks).flatMap(([id, value]) => (
      isScratchBlock(value)
      && value.opcode === 'procedures_call'
      && value.mutation?.['proccode'] === procedure.procedureCode
        ? [id]
        : []
    )));
    if (!sameStringSet(expectedCalls, actualCalls)) {
      addAntiSaveFailure(
        failures,
        'antisave-hat-coverage-invalid',
        'Anti-save procedure call coverage differs from the manifest-bound native-hat set.'
      );
    }
  }

  for (const fallback of manifest.fallbackCanaries) {
    const block = transformedProject.targets[fallback.targetIndex]?.blocks[fallback.blockId];
    const input = isScratchBlock(block) ? block.inputs[fallback.inputName] : undefined;
    const value = input?.[2];
    if (
      input?.[0] !== 3
      || input[1] === null
      || input[1] === undefined
      || !isPrimitive(value)
      || value[0] !== 10
      || value[1] !== fallback.value
      || !isSafeCanaryText(fallback.value)
    ) {
      addAntiSaveFailure(
        failures,
        'antisave-fallback-canary-invalid',
        'A manifest-bound inactive fallback canary is missing, active, or unsafe.'
      );
    }
  }

  const expectedObjectBlocks = (manifest.procedures.length * 7) + manifest.hatGuards.length;
  const expectedBlockEquivalents = (manifest.procedures.length * 10) + manifest.hatGuards.length;
  const expectedCanaries = 2 + manifest.procedures.length + manifest.fallbackCanaries.length;
  if (
    new Set(generatedIds).size !== generatedIds.length
    || manifest.generatedObjectBlockCount !== expectedObjectBlocks
    || manifest.generatedBlockEquivalentCount !== expectedBlockEquivalents
    || manifest.inactiveFallbackCanaries !== manifest.fallbackCanaries.length
    || manifest.canaryCount !== expectedCanaries
  ) {
    addAntiSaveFailure(
      failures,
      'antisave-manifest-accounting-invalid',
      'Anti-save manifest IDs or generated block/canary accounting are inconsistent.'
    );
  }
  if (!options.stats || options.stats.antiSaveCanaries !== manifest.canaryCount) {
    addAntiSaveFailure(
      failures,
      'antisave-canary-stats-mismatch',
      'Anti-save stats do not exactly match the trusted canary manifest.'
    );
  }
  if (failures.length === initialFailureCount) {
    proven.add('antisave-exact-signed-zero-chain-and-native-hat-coverage-verified');
  }
}

function addAntiSaveFailure(
  failures: VerificationFinding[],
  code: string,
  message: string
): void {
  if (failures.some(finding => finding.code === code)) return;
  failures.push({severity: 'failure', code, message});
}

function hasExactAntiSaveProcedure(
  target: ScratchTarget,
  procedure: AntiSaveProcedureManifest,
  manifest: AntiSaveVerificationManifest
): boolean {
  const definition = target.blocks[procedure.definitionId];
  const prototype = target.blocks[procedure.prototypeId];
  const guard = target.blocks[procedure.guardId];
  const not = target.blocks[procedure.notId];
  const lessThan = target.blocks[procedure.lessThanId];
  const divide = target.blocks[procedure.divideId];
  const stop = target.blocks[procedure.stopId];
  if (
    !isScratchBlock(definition)
    || definition.opcode !== 'procedures_definition'
    || definition.next !== procedure.guardId
    || definition.parent !== null
    || !definition.topLevel
    || definition.shadow
    || definition.x !== 0
    || definition.y !== 0
    || !hasOnlyKeys(definition.inputs, ['custom_block'])
    || !isBlockInput(definition.inputs['custom_block'], 1, procedure.prototypeId)
    || !hasOnlyKeys(definition.fields, [])
    || !isScratchBlock(prototype)
    || prototype.opcode !== 'procedures_prototype'
    || prototype.next !== null
    || prototype.parent !== procedure.definitionId
    || prototype.topLevel
    || !prototype.shadow
    || !hasOnlyKeys(prototype.inputs, [])
    || !hasOnlyKeys(prototype.fields, [])
    || !isExactAntiSaveMutation(prototype.mutation, procedure.procedureCode)
    || !isScratchBlock(guard)
    || guard.opcode !== 'control_if'
    || guard.next !== null
    || guard.parent !== procedure.definitionId
    || guard.topLevel
    || guard.shadow
    || !hasOnlyKeys(guard.inputs, ['CONDITION', 'SUBSTACK'])
    || !isBlockInput(guard.inputs['CONDITION'], 2, procedure.notId)
    || !isBlockInput(guard.inputs['SUBSTACK'], 2, procedure.stopId)
    || !hasOnlyKeys(guard.fields, [])
    || !isScratchBlock(not)
    || not.opcode !== 'operator_not'
    || not.next !== null
    || not.parent !== procedure.guardId
    || not.topLevel
    || not.shadow
    || !hasOnlyKeys(not.inputs, ['OPERAND'])
    || !isBlockInput(not.inputs['OPERAND'], 2, procedure.lessThanId)
    || !hasOnlyKeys(not.fields, [])
    || !isScratchBlock(lessThan)
    || lessThan.opcode !== 'operator_lt'
    || lessThan.next !== null
    || lessThan.parent !== procedure.notId
    || lessThan.topLevel
    || lessThan.shadow
    || !hasOnlyKeys(lessThan.inputs, ['OPERAND1', 'OPERAND2'])
    || !isBlockInput(lessThan.inputs['OPERAND1'], 2, procedure.divideId)
    || !isNumericInput(lessThan.inputs['OPERAND2'], '0')
    || !hasOnlyKeys(lessThan.fields, [])
    || !isScratchBlock(divide)
    || divide.opcode !== 'operator_divide'
    || divide.next !== null
    || divide.parent !== procedure.lessThanId
    || divide.topLevel
    || divide.shadow
    || !hasOnlyKeys(divide.inputs, ['NUM1', 'NUM2'])
    || !isNumericInput(divide.inputs['NUM1'], '1')
    || !isSentinelInput(
      divide.inputs['NUM2'],
      manifest.sentinelName,
      manifest.sentinelVariableId
    )
    || !hasOnlyKeys(divide.fields, [])
    || !isScratchBlock(stop)
    || stop.opcode !== 'control_stop'
    || stop.next !== null
    || stop.parent !== procedure.guardId
    || stop.topLevel
    || stop.shadow
    || !hasOnlyKeys(stop.inputs, [])
    || !hasOnlyKeys(stop.fields, ['STOP_OPTION'])
    || !isStopAllField(stop.fields['STOP_OPTION'])
    || !isExactStopMutation(stop.mutation)
  ) return false;
  const definitions = Object.values(target.blocks).filter(value => {
    if (!isScratchBlock(value) || value.opcode !== 'procedures_definition') return false;
    const prototypeInput = value.inputs['custom_block']?.[1];
    const candidate = typeof prototypeInput === 'string' ? target.blocks[prototypeInput] : undefined;
    return isScratchBlock(candidate) && candidate.mutation?.['proccode'] === procedure.procedureCode;
  });
  return definitions.length === 1;
}

function antiSaveCallParent(
  target: ScratchTarget,
  hat: ScratchBlock,
  site: AntiSaveHatGuardManifest,
  antiCheat: boolean
): string | undefined {
  if (!antiCheat) return hat.next === site.callId ? site.hatId : undefined;
  if (typeof hat.next !== 'string' || hat.next === site.callId) return undefined;
  const wrapper = target.blocks[hat.next];
  if (
    !isScratchBlock(wrapper)
    || wrapper.opcode !== 'procedures_call'
    || wrapper.next !== site.callId
    || wrapper.parent !== site.hatId
    || wrapper.topLevel
    || wrapper.shadow
    || !hasOnlyKeys(wrapper.inputs, [])
    || !hasOnlyKeys(wrapper.fields, [])
  ) return undefined;
  const wrapperCode = wrapper.mutation?.['proccode'];
  if (
    typeof wrapperCode !== 'string'
    || wrapperCode === site.procedureCode
    || !isExactZeroArgumentWarpCallMutation(wrapper.mutation, wrapperCode)
    || !hasLocalProcedureDefinition(target, wrapperCode)
  ) return undefined;
  return hat.next;
}

function hasLocalProcedureDefinition(target: ScratchTarget, procedureCode: string): boolean {
  return Object.values(target.blocks).some(value => {
    if (!isScratchBlock(value) || value.opcode !== 'procedures_definition') return false;
    const prototypeId = value.inputs['custom_block']?.[1];
    const prototype = typeof prototypeId === 'string' ? target.blocks[prototypeId] : undefined;
    return isScratchBlock(prototype)
      && prototype.opcode === 'procedures_prototype'
      && isExactAntiSaveMutation(prototype.mutation, procedureCode);
  });
}

function antiSaveContinuationParent(
  target: ScratchTarget,
  call: ScratchBlock,
  site: AntiSaveHatGuardManifest,
  antiCheat: boolean
): string | undefined {
  let parentId = site.callId;
  let nextId = call.next;
  const visited = new Set<string>();
  while (nextId !== site.originalNext) {
    if (!antiCheat || nextId === null || visited.has(nextId)) return undefined;
    visited.add(nextId);
    const wrapper = target.blocks[nextId];
    if (
      !isScratchBlock(wrapper)
      || wrapper.opcode !== 'procedures_call'
      || wrapper.parent !== parentId
      || wrapper.topLevel
      || wrapper.shadow
      || !hasOnlyKeys(wrapper.inputs, [])
      || !hasOnlyKeys(wrapper.fields, [])
    ) return undefined;
    const wrapperCode = wrapper.mutation?.['proccode'];
    if (
      typeof wrapperCode !== 'string'
      || wrapperCode === site.procedureCode
      || !isExactAntiSaveMutation(wrapper.mutation, wrapperCode)
      || !hasLocalProcedureDefinition(target, wrapperCode)
    ) return undefined;
    parentId = nextId;
    nextId = wrapper.next;
  }
  return parentId;
}

function isExactAntiSaveCall(
  value: ScratchTarget['blocks'][string] | undefined,
  procedureCode: string
): value is ScratchBlock {
  return isScratchBlock(value)
    && value.opcode === 'procedures_call'
    && !value.topLevel
    && !value.shadow
    && hasOnlyKeys(value.inputs, [])
    && hasOnlyKeys(value.fields, [])
    && isExactAntiSaveMutation(value.mutation, procedureCode);
}

function isExactAntiSaveMutation(
  mutation: Readonly<Record<string, JsonValue>> | undefined,
  procedureCode: string
): boolean {
  return mutation !== undefined
    && hasOnlyKeys(mutation, [
      'tagName',
      'children',
      'proccode',
      'argumentids',
      'argumentnames',
      'argumentdefaults',
      'warp'
    ])
    && mutation['tagName'] === 'mutation'
    && Array.isArray(mutation['children'])
    && mutation['children'].length === 0
    && mutation['proccode'] === procedureCode
    && mutation['argumentids'] === '[]'
    && mutation['argumentnames'] === '[]'
    && mutation['argumentdefaults'] === '[]'
    && mutation['warp'] === 'true';
}

function isExactZeroArgumentWarpCallMutation(
  mutation: Readonly<Record<string, JsonValue>> | undefined,
  procedureCode: string
): boolean {
  return mutation !== undefined
    && hasOnlyKeys(mutation, ['tagName', 'children', 'proccode', 'argumentids', 'warp'])
    && mutation['tagName'] === 'mutation'
    && Array.isArray(mutation['children'])
    && mutation['children'].length === 0
    && mutation['proccode'] === procedureCode
    && mutation['argumentids'] === '[]'
    && mutation['warp'] === 'true';
}

function isExactStopMutation(mutation: Readonly<Record<string, JsonValue>> | undefined): boolean {
  return mutation !== undefined
    && hasOnlyKeys(mutation, ['tagName', 'children', 'hasnext'])
    && mutation['tagName'] === 'mutation'
    && Array.isArray(mutation['children'])
    && mutation['children'].length === 0
    && mutation['hasnext'] === 'false';
}

function isBlockInput(input: ScratchInput | undefined, type: 1 | 2, id: string): boolean {
  return input?.length === 2 && input[0] === type && input[1] === id;
}

function isNumericInput(input: ScratchInput | undefined, expected: string): boolean {
  const primitive = input?.[1];
  return input?.length === 2
    && input[0] === 1
    && isPrimitive(primitive)
    && primitive.length === 2
    && primitive[0] === 4
    && primitive[1] === expected;
}

function isSentinelInput(input: ScratchInput | undefined, name: string, id: string): boolean {
  const primitive = input?.[1];
  return input?.length === 2
    && input[0] === 1
    && isPrimitive(primitive)
    && primitive.length === 3
    && primitive[0] === 12
    && primitive[1] === name
    && primitive[2] === id;
}

function isStopAllField(field: JsonValue[] | undefined): boolean {
  return field?.length === 2 && field[0] === 'all' && field[1] === null;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function sameAntiSaveHatSites(
  manifestSites: readonly AntiSaveHatGuardManifest[],
  snapshotSites: readonly NativeHatSiteSnapshot[]
): boolean {
  if (manifestSites.length !== snapshotSites.length) return false;
  const expected = new Map<string, NativeHatSiteSnapshot>();
  for (const site of snapshotSites) {
    const key = `${site.targetIndex}\u0000${site.hatId}`;
    if (expected.has(key)) return false;
    expected.set(key, site);
  }
  const seen = new Set<string>();
  for (const site of manifestSites) {
    const key = `${site.targetIndex}\u0000${site.hatId}`;
    const source = expected.get(key);
    if (
      seen.has(key)
      || source === undefined
      || source.opcode !== site.hatOpcode
      || source.originalNext !== site.originalNext
    ) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

function verifyModeGraphPolicy(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  losslessCore: ProjectVerificationSnapshot | undefined,
  mode: ObfuscationMode,
  antiCheat: boolean,
  antiSave: boolean,
  allowSize: boolean,
  passTrace: readonly VerificationPassBoundary[] | undefined,
  antiSaveManifest: AntiSaveVerificationManifest | undefined,
  extra: boolean,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): void {
  if (mode === 'lossless' && !antiCheat && !antiSave) {
    verifyStrictLosslessCore(source, transformed, extra, failures, proven);
    return;
  }

  if (mode === 'lossless' && (antiCheat || antiSave)) {
    if (!losslessCore) {
      failures.push({
        severity: 'failure',
        code: antiCheat
          ? 'lossless-anticheat-core-checkpoint-missing'
          : 'lossless-antisave-core-checkpoint-missing',
        message: antiCheat
          ? 'Lossless plus anti-cheat requires a pre-instrumentation snapshot for strict source-graph verification.'
          : 'Lossless plus antisave requires a pre-instrumentation snapshot for strict source-graph verification.'
      });
    } else {
      verifyStrictLosslessCore(source, losslessCore, extra, failures, proven);
      verifyExecutableNodeRetention(losslessCore, transformed, failures, proven);
    }
    if (antiSave) verifyAntiSavePassGrowth(
      passTrace,
      antiSaveManifest,
      failures,
      caveats,
      proven
    );
    if (antiCheat) verifyFinalAntiCheatGrowth(transformed, passTrace, false, failures, proven);
    verifyNativeHatLowerBound(source, transformed, extra, failures, proven);
    caveats.push({
      severity: 'caveat',
      code: antiCheat
        ? 'anti-cheat-topology-additions-prevent-end-to-end-lossless-isomorphism'
        : 'antisave-topology-additions-prevent-end-to-end-lossless-isomorphism',
      message: antiCheat
        ? 'The combined instrumentation layer intentionally adds executable guards, so end-to-end graph isomorphism is not a valid lossless claim.'
        : 'Antisave intentionally adds a signed-zero executable guard, so end-to-end graph isomorphism is not a valid lossless claim.'
    });
  } else {
    verifyNativeHatLowerBound(source, transformed, extra, failures, proven);
    if (mode !== 'lossless') {
      verifyAggressiveGrowthCap(
        source,
        transformed,
        mode,
        antiCheat,
        antiSave,
        allowSize,
        passTrace,
        antiSaveManifest,
        failures,
        caveats,
        proven
      );
    }
    proven.add('mode-permits-executable-topology-change');
  }
}

function verifyStrictLosslessCore(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  extra: boolean,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  compareRequiredDigest(
    source.executableTopologyDigest,
    transformed.executableTopologyDigest,
    'lossless-executable-topology-changed',
    'Lossless mode changed the active executable opcode/reference topology.',
    'lossless-active-executable-topology-isomorphic',
    failures,
    proven
  );
  compareRequiredDigest(
    extra ? source.extraExecutableValueDigest : source.executableValueDigest,
    extra ? transformed.extraExecutableValueDigest : transformed.executableValueDigest,
    'lossless-executable-values-changed',
    extra
      ? 'Lossless extra mode changed an active executable value outside permitted project-name references.'
      : 'Lossless mode changed normalized active inputs, fields, mutations, or block payloads.',
    extra
      ? 'lossless-extra-executable-values-preserved-outside-name-waiver'
      : 'lossless-normalized-executable-values-preserved',
    failures,
    proven
  );
  if (extra) proven.add('lossless-extra-active-executable-topology-preserved-with-name-value-waiver');
  compareRequiredDigest(
    source.losslessDeclarationStateDigest,
    transformed.losslessDeclarationStateDigest,
    'lossless-declaration-state-changed',
    'Lossless mode changed a variable/list initial value, cloud flag, or declaration order.',
    'lossless-variable-and-list-initial-state-preserved',
    failures,
    proven
  );
  if (source.executableObjectBlocks !== transformed.executableObjectBlocks) {
    failures.push({
      severity: 'failure',
      code: 'lossless-executable-block-count-changed',
      message: `Lossless active object-block count changed from ${source.executableObjectBlocks} to ${transformed.executableObjectBlocks}.`
    });
  } else proven.add('lossless-active-object-block-count-preserved');
  if (source.listCount !== transformed.listCount || source.broadcastCount !== transformed.broadcastCount) {
    failures.push({
      severity: 'failure',
      code: 'lossless-declaration-count-changed',
      message: 'Lossless mode added or removed list or broadcast declarations.'
    });
  }
  const expectedVariables = source.variableCount + (source.stageWatermarkCount === 0 ? 1 : 0);
  if (transformed.variableCount !== source.variableCount && transformed.variableCount !== expectedVariables) {
    failures.push({
      severity: 'failure',
      code: 'lossless-variable-count-changed',
      message: `Lossless variable count was ${transformed.variableCount}; expected ${source.variableCount} before watermarking or ${expectedVariables} afterward.`
    });
  }
}

function verifyExecutableNodeRetention(
  baseline: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const missing = missingMultisetEntries(baseline.executableNodeSignatures, transformed.executableNodeSignatures);
  if (missing.length > 0) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-original-executable-node-missing',
      message: `Anti-cheat output no longer contains ${missing.length} pre-anti-cheat active executable node signature(s).`
    });
  } else proven.add('anticheat-retains-preinstrumentation-active-executable-nodes');
}

function verifyAggressiveGrowthCap(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  mode: Exclude<ObfuscationMode, 'lossless'>,
  antiCheat: boolean,
  antiSave: boolean,
  allowSize: boolean,
  passTrace: readonly VerificationPassBoundary[] | undefined,
  antiSaveManifest: AntiSaveVerificationManifest | undefined,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): void {
  let cappedSnapshot = transformed;
  if (antiCheat) {
    const checkpoints = passTrace?.filter(boundary => boundary.pass === 'anti-cheat-instrumentation') ?? [];
    const checkpoint = checkpoints.length === 1 ? checkpoints[0] : undefined;
    if (
      !checkpoint
      || passTrace?.at(-1) !== checkpoint
      || checkpoint.after.fullDigest !== transformed.fullDigest
    ) {
      failures.push({
        severity: 'failure',
        code: 'anticheat-growth-checkpoint-missing',
        message: 'Aggressive anti-cheat verification requires exactly one final trusted pass snapshot captured immediately before instrumentation.'
      });
      return;
    }
    requireSnapshotVersion(checkpoint.before);
    requireSnapshotVersion(checkpoint.after);
    cappedSnapshot = checkpoint.before;
    verifyAntiCheatAdditiveGrowth(cappedSnapshot, transformed, allowSize, failures, proven);
    caveats.push({
      severity: 'caveat',
      code: 'anticheat-growth-outside-aggressive-cap',
      message: 'The aggressive growth cap was checked immediately before the separately bounded anti-cheat instrumentation layer.'
    });
  }
  if (antiSave) {
    const checkpoint = verifyAntiSavePassGrowth(
      passTrace,
      antiSaveManifest,
      failures,
      caveats,
      proven
    );
    if (!checkpoint) return;
    cappedSnapshot = checkpoint.before;
  }
  const initial = source.blockEquivalents;
  const cap = aggressiveBlockEquivalentCap(initial, mode, allowSize);
  if (cappedSnapshot.blockEquivalents > cap) {
    failures.push({
      severity: 'failure',
      code: 'aggressive-growth-cap-exceeded',
      message: `${mode} aggressive output has ${cappedSnapshot.blockEquivalents} block-equivalents; the source-derived cap is ${cap}.`
    });
  } else {
    proven.add('configured-aggressive-block-equivalent-cap-respected');
    if (antiCheat) proven.add('aggressive-growth-cap-verified-before-anticheat-instrumentation');
    if (antiSave) proven.add('aggressive-growth-cap-verified-before-antisave-instrumentation');
  }

  if (allowSize) {
    caveats.push({
      severity: 'caveat',
      code: 'expanded-serialized-growth-enabled',
      message: 'Expanded size mode waives the compact serialized-growth ratio but retains the transformed-JSON safety cap.'
    });
    return;
  }

  const compactJsonLimit = compactSerializedJsonLimit(source.serializedUtf8Bytes, mode);
  if (cappedSnapshot.serializedUtf8Bytes > compactJsonLimit) {
    failures.push({
      severity: 'failure',
      code: 'compact-serialized-growth-cap-exceeded',
      message: `${mode} aggressive JSON has ${cappedSnapshot.serializedUtf8Bytes} UTF-8 bytes; the compact cap is ${compactJsonLimit}.`
    });
  } else {
    proven.add('compact-serialized-growth-cap-respected');
  }
}

function verifyFinalAntiCheatGrowth(
  transformed: ProjectVerificationSnapshot,
  passTrace: readonly VerificationPassBoundary[] | undefined,
  allowSize: boolean,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const checkpoints = passTrace?.filter(boundary => boundary.pass === 'anti-cheat-instrumentation') ?? [];
  const checkpoint = checkpoints.length === 1 ? checkpoints[0] : undefined;
  if (!checkpoint || passTrace?.at(-1) !== checkpoint || checkpoint.after.fullDigest !== transformed.fullDigest) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-growth-checkpoint-missing',
      message: 'Anti-cheat verification requires exactly one final trusted pass snapshot.'
    });
    return;
  }
  verifyAntiCheatAdditiveGrowth(checkpoint.before, transformed, allowSize, failures, proven);
}

function verifyAntiSavePassGrowth(
  passTrace: readonly VerificationPassBoundary[] | undefined,
  manifest: AntiSaveVerificationManifest | undefined,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): VerificationPassBoundary | undefined {
  const checkpoints = passTrace?.filter(boundary => boundary.pass === ANTI_SAVE_PASS_NAME) ?? [];
  const checkpoint = checkpoints.length === 1 ? checkpoints[0] : undefined;
  if (!checkpoint) {
    failures.push({
      severity: 'failure',
      code: 'antisave-growth-checkpoint-missing',
      message: 'Antisave verification requires exactly one trusted editor-resave-canaries pass snapshot.'
    });
    return undefined;
  }
  if (!isTrustedAntiSaveVerificationManifest(manifest)) return undefined;
  requireSnapshotVersion(checkpoint.before);
  requireSnapshotVersion(checkpoint.after);
  const blockGrowth = checkpoint.after.blockEquivalents - checkpoint.before.blockEquivalents;
  const objectBlockGrowth = checkpoint.after.objectBlockCount - checkpoint.before.objectBlockCount;
  const byteGrowth = checkpoint.after.serializedUtf8Bytes - checkpoint.before.serializedUtf8Bytes;
  const sourceHatCount = checkpoint.before.nativeHatSites.length;
  const expectedProcedureGrowth = manifest.procedures.length;
  const exactAccounting = blockGrowth === manifest.generatedBlockEquivalentCount
    && objectBlockGrowth === manifest.generatedObjectBlockCount
    && checkpoint.after.variableCount - checkpoint.before.variableCount === 1
    && checkpoint.after.listCount - checkpoint.before.listCount === 1
    && checkpoint.after.procedureCount - checkpoint.before.procedureCount === expectedProcedureGrowth
    && checkpoint.after.targetCount === checkpoint.before.targetCount
    && sourceHatCount === manifest.hatGuards.length
    && sameAntiSaveHatSites(manifest.hatGuards, checkpoint.before.nativeHatSites)
    && sameCountRecord(checkpoint.before.nativeHatCounts, checkpoint.after.nativeHatCounts)
    && sameCountRecord(checkpoint.before.nativeHatSignatures, checkpoint.after.nativeHatSignatures);
  if (!exactAccounting) {
    failures.push({
      severity: 'failure',
      code: 'antisave-additive-growth-accounting-invalid',
      message: `Antisave added ${objectBlockGrowth} object blocks and ${blockGrowth} block-equivalents; the trusted manifest requires ${manifest.generatedObjectBlockCount} and ${manifest.generatedBlockEquivalentCount}.`
    });
  } else {
    proven.add('antisave-exact-additive-block-and-declaration-growth-verified');
  }
  const byteLimit = antiSaveSerializedGrowthLimit(manifest);
  if (byteGrowth > byteLimit) {
    failures.push({
      severity: 'failure',
      code: 'antisave-serialized-growth-cap-exceeded',
      message: `Antisave added ${byteGrowth} serialized UTF-8 bytes; its manifest-derived cap is ${byteLimit}.`
    });
  } else {
    proven.add('antisave-manifest-derived-serialized-growth-cap-respected');
  }
  caveats.push({
    severity: 'caveat',
    code: 'antisave-resave-deterrence-not-save-prevention',
    message: 'Antisave detects the official editor\'s signed-zero normalization when the resaved project starts; it does not prevent the save operation.'
  });
  return checkpoint;
}

function antiSaveSerializedGrowthLimit(manifest: AntiSaveVerificationManifest): number {
  return 16_384
    + (manifest.generatedObjectBlockCount * 2_048)
    + (manifest.fallbackCanaries.length * 512);
}

function sameCountRecord(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([key, count]) => right[key] === count);
}

function verifyTransformedJsonSafetyCap(
  transformed: ProjectVerificationSnapshot,
  mode: ObfuscationMode,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const limit = transformedJsonSafetyLimit(mode);
  if (exceedsTransformedJsonSafetyLimit(transformed.serializedUtf8Bytes, mode)) {
    failures.push({
      severity: 'failure',
      code: 'transformed-json-size-cap-exceeded',
      message: `${mode} output JSON has ${transformed.serializedUtf8Bytes} UTF-8 bytes; the safety cap is ${limit}.`
    });
  } else {
    proven.add('transformed-json-safety-cap-respected');
  }
}

function verifyAntiCheatAdditiveGrowth(
  before: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  allowSize: boolean,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const blockGrowth = transformed.blockEquivalents - before.blockEquivalents;
  const byteGrowth = transformed.serializedUtf8Bytes - before.serializedUtf8Bytes;
  if (blockGrowth < 0 || byteGrowth < 0) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-growth-accounting-invalid',
      message: 'Anti-cheat output is smaller than its trusted pre-instrumentation checkpoint.'
    });
    return;
  }
  if (allowSize) {
    proven.add('anticheat-additive-growth-accounting-valid');
    return;
  }
  const blockLimit = antiCheatBlockGrowthLimit(before.blockEquivalents);
  if (blockGrowth > blockLimit) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-block-growth-cap-exceeded',
      message: `Anti-cheat added ${blockGrowth} block-equivalents; the compact additive cap is ${blockLimit}. Use -allowsize with a stronger mode to waive the compact cap.`
    });
  } else {
    proven.add('anticheat-additive-block-growth-cap-respected');
  }
  if (byteGrowth > COMPACT_ANTICHEAT_JSON_GROWTH_BYTES) {
    failures.push({
      severity: 'failure',
      code: 'anticheat-serialized-growth-cap-exceeded',
      message: `Anti-cheat added ${byteGrowth} serialized UTF-8 bytes; the compact additive cap is ${COMPACT_ANTICHEAT_JSON_GROWTH_BYTES}. Use -allowsize with a stronger mode to waive the compact cap.`
    });
  } else {
    proven.add('anticheat-additive-serialized-growth-cap-respected');
  }
}

function verifyNativeHatLowerBound(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  extra: boolean,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  let preserved = true;
  const sourceCounts = extra ? source.nativeHatCounts : source.nativeHatSignatures;
  const transformedCounts = extra ? transformed.nativeHatCounts : transformed.nativeHatSignatures;
  for (const [signature, count] of Object.entries(sourceCounts)) {
    const present = transformedCounts[signature] ?? 0;
    if (present >= count) continue;
    preserved = false;
    const [, opcode = 'unknown'] = signature.split(':', 3);
    failures.push({
      severity: 'failure',
      code: 'native-hat-trigger-decreased',
      message: `Native hat trigger ${JSON.stringify(opcode)} decreased from ${count} to ${present} on its original target.`
    });
  }
  if (preserved) proven.add(extra
    ? 'native-hat-target-and-opcode-lower-bounds-preserved-under-extra-name-waiver'
    : 'native-hat-target-and-trigger-signature-lower-bounds-preserved');
}

function verifyStats(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  options: PostTransformVerificationOptions,
  extraLevel: ExtraPrivacyLevel,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  const stats = options.stats;
  if (!stats) return;
  if (stats.mode !== options.mode) {
    failures.push({
      severity: 'failure',
      code: 'stats-mode-mismatch',
      message: `Stats report mode ${JSON.stringify(stats.mode)} instead of ${JSON.stringify(options.mode)}.`
    });
  }
  if (stats.blocksBefore !== source.blockEquivalents) {
    failures.push({
      severity: 'failure',
      code: 'stats-input-block-count-mismatch',
      message: `Stats blocksBefore=${stats.blocksBefore}, but the source snapshot has ${source.blockEquivalents} block-equivalents.`
    });
  }
  if (stats.blocksAfter !== transformed.blockEquivalents) {
    failures.push({
      severity: 'failure',
      code: 'stats-output-block-count-mismatch',
      message: `Stats blocksAfter=${stats.blocksAfter}, but the transformed snapshot has ${transformed.blockEquivalents} block-equivalents.`
    });
  }
  const counters = [
    stats.identifiersRenamed,
    stats.symbolsRenamed,
    stats.commentsRemoved,
    stats.decoysAdded,
    stats.virtualizedBlocks,
    stats.variablesVirtualized ?? 0,
    stats.listsVirtualized ?? 0,
    stats.constantsFolded ?? 0,
    stats.inactiveFallbacksRemoved ?? 0,
    stats.antiCheatDecoys ?? 0,
    stats.antiSaveCanaries ?? 0,
    stats.privacyHatShadowSites ?? 0,
    stats.privacyHatShadowChanges ?? 0
  ];
  if (counters.some(value => !Number.isSafeInteger(value) || value < 0)) {
    failures.push({
      severity: 'failure',
      code: 'stats-counter-invalid',
      message: 'One or more transform counters are negative or not safe integers.'
    });
  }
  if (stats.extraPrivacyLevel !== undefined && stats.extraPrivacyLevel !== extraLevel) {
    failures.push({
      severity: 'failure',
      code: 'stats-extra-level-mismatch',
      message: `Stats report extra level ${String(stats.extraPrivacyLevel)}, but verification requested ${String(extraLevel)}.`
    });
  }
  if (
    extraLevel === 2
    && isTrustedExtraEditorShadowManifest(options.extraEditorShadowManifest)
    && (
      stats.privacyHatShadowSites !== options.extraEditorShadowManifest.sites.length
      || stats.privacyHatShadowChanges !== options.extraEditorShadowManifest.changedHatCount
    )
  ) {
    failures.push({
      severity: 'failure',
      code: 'stats-extra-shadow-count-mismatch',
      message: 'Stats do not match the manifest-bound extra level 2 covered-hat and changed-hat counts.'
    });
  }
  if (!failures.some(finding => finding.code.startsWith('stats-'))) {
    proven.add('aggregate-transform-stats-consistent-with-boundary-snapshots');
  }
}

function verifyPassTrace(
  source: ProjectVerificationSnapshot,
  transformed: ProjectVerificationSnapshot,
  trace: readonly VerificationPassBoundary[] | undefined,
  failures: VerificationFinding[],
  caveats: VerificationFinding[],
  proven: Set<string>
): VerificationPassAttribution[] {
  if (!trace || trace.length === 0) {
    caveats.push({
      severity: 'caveat',
      code: 'pass-attribution-unavailable',
      message: 'No pass-boundary trace was supplied; end-to-end changes cannot be assigned to individual passes.'
    });
    return [];
  }
  const attributions: VerificationPassAttribution[] = [];
  let expectedBefore = source.fullDigest;
  for (const boundary of trace) {
    requireSnapshotVersion(boundary.before);
    requireSnapshotVersion(boundary.after);
    const continuous = boundary.before.fullDigest === expectedBefore;
    const changes = changedVerificationCategories(boundary.before, boundary.after);
    const fixedPolicy = FIXED_PASS_CHANGE_POLICIES.get(boundary.pass);
    const allowed = new Set(fixedPolicy ?? []);
    const unexpected = changes.filter(category => !allowed.has(category));
    const allowedButUnobserved = [...allowed].filter(category => !changes.includes(category));
    attributions.push(Object.freeze({
      pass: boundary.pass,
      changes: Object.freeze(changes),
      unexpectedChanges: Object.freeze(unexpected),
      allowedButUnobserved: Object.freeze(allowedButUnobserved),
      continuous
    }));
    if (!continuous) {
      failures.push({
        severity: 'failure',
        code: 'pass-trace-discontinuous',
        pass: boundary.pass,
        message: `Pass ${JSON.stringify(boundary.pass)} does not begin at the preceding verified boundary.`
      });
    }
    if (!fixedPolicy) {
      failures.push({
        severity: 'failure',
        code: 'pass-policy-unknown',
        pass: boundary.pass,
        message: `Pass ${JSON.stringify(boundary.pass)} is not part of the verifier's fixed pass policy.`
      });
    } else if (!sameCategorySet(boundary.allowedChanges, fixedPolicy)) {
      failures.push({
        severity: 'failure',
        code: 'pass-policy-forged',
        pass: boundary.pass,
        message: `Pass ${JSON.stringify(boundary.pass)} supplied an allowed-change policy that differs from the verifier's fixed policy.`
      });
    }
    if (unexpected.length > 0) {
      failures.push({
        severity: 'failure',
        code: 'pass-change-outside-declared-policy',
        pass: boundary.pass,
        message: `Pass ${JSON.stringify(boundary.pass)} changed undeclared categories: ${unexpected.join(', ')}.`
      });
    }
    expectedBefore = boundary.after.fullDigest;
  }
  if (expectedBefore !== transformed.fullDigest) {
    failures.push({
      severity: 'failure',
      code: 'pass-trace-does-not-reach-output',
      message: 'The final pass boundary does not match the transformed project snapshot.'
    });
  }
  if (!failures.some(finding => finding.code.startsWith('pass-'))) {
    proven.add('pass-boundary-change-attribution-complete');
  }
  return attributions;
}

function sameCategorySet(
  supplied: readonly VerificationChangeCategory[],
  fixed: readonly VerificationChangeCategory[]
): boolean {
  if (supplied.length !== fixed.length) return false;
  const suppliedSet = new Set(supplied);
  return suppliedSet.size === supplied.length && fixed.every(category => suppliedSet.has(category));
}

function addScopeCaveats(
  mode: ObfuscationMode,
  antiCheat: boolean,
  extraLevel: ExtraPrivacyLevel,
  caveats: VerificationFinding[]
): void {
  caveats.push(
    {
      severity: 'caveat',
      code: 'archive-payload-bytes-out-of-scope',
      message: 'This project.json verifier compares asset descriptors, not the external ZIP entry bytes.'
    },
    {
      severity: 'caveat',
      code: 'visual-equivalence-not-proven',
      message: 'Static graph and metadata checks do not prove renderer-level visual equivalence.'
    },
    {
      severity: 'caveat',
      code: 'runtime-equivalence-not-proven',
      message: 'Static verification does not replace VM differential execution with controlled clocks, randomness, and inputs.'
    }
  );
  if (mode === 'lossless') {
    caveats.push({
      severity: 'caveat',
      code: 'wall-clock-equality-not-proven',
      message: 'Executable topology checks cannot prove exact wall-clock equality across machines.'
    });
  } else if (mode === 'lossy') {
    caveats.push({
      severity: 'caveat',
      code: 'lossy-yield-boundary-equivalence-requires-runtime-test',
      message: 'Preservation of observable effects at original yield boundaries requires differential VM testing.'
    });
  } else {
    caveats.push({
      severity: 'caveat',
      code: 'no-preserve-timing-concurrency-divergence-accepted',
      message: 'No-preserve mode intentionally waives timing, responsiveness, redraw cadence, and thread interleaving.'
    });
  }
  if (antiCheat) {
    caveats.push({
      severity: 'caveat',
      code: 'anti-cheat-tamper-path-intentionally-diverges',
      message: 'Anti-cheat mode intentionally changes behavior when protected state or sentinels are altered.'
    });
  }
  if (extraLevel >= 1) {
    caveats.push({
      severity: 'caveat',
      code: 'extra-name-and-editor-compatibility-waiver-active',
      message: 'Extra privacy intentionally changes editor-visible names, monitor presentation, optional metadata, and unresolved computed name dispatch.'
    });
  }
}

function compareRequiredDigest(
  source: string,
  transformed: string,
  failureCode: string,
  failureMessage: string,
  provenInvariant: string,
  failures: VerificationFinding[],
  proven: Set<string>
): void {
  if (source === transformed) proven.add(provenInvariant);
  else failures.push({severity: 'failure', code: failureCode, message: failureMessage});
}

function canonicalRuntimeMetadata(project: ScratchProject): unknown {
  const rootExtras = Object.fromEntries(Object.entries(project).filter(([key]) => (
    key !== 'targets' && key !== 'monitors' && key !== 'extensions' && key !== 'meta'
  )));
  return {
    extensions: project.extensions,
    meta: project.meta,
    rootExtras,
    targets: project.targets.map(target => Object.fromEntries(Object.entries(target).filter(([key]) => ![
      'isStage',
      'name',
      'variables',
      'lists',
      'broadcasts',
      'blocks',
      'comments',
      'costumes',
      'sounds'
    ].includes(key))))
  };
}

function canonicalCloudVariables(project: ScratchProject): unknown {
  return project.targets.map(target => Object.values(target.variables)
    .filter(declaration => declaration[2] === true));
}

function canonicalLosslessDeclarationState(project: ScratchProject): unknown {
  return project.targets.map(target => ({
    variables: Object.values(target.variables)
      .filter((declaration, index, declarations) => !target.isStage
        || declaration[0] !== ANTI_CHEAT_WATERMARK_NAME
        || declarations.findIndex(candidate => candidate[0] === ANTI_CHEAT_WATERMARK_NAME) !== index)
      .map(declaration => declaration.slice(1)),
    lists: Object.values(target.lists).map(declaration => declaration.slice(1))
  }));
}

function canonicalCommentsAndLayout(project: ScratchProject): unknown {
  return project.targets.map(target => {
    const blockOrdinals = new Map(Object.keys(target.blocks).map((id, index) => [id, index]));
    const commentOrdinals = new Map(Object.keys(target.comments).map((id, index) => [id, index]));
    return {
      comments: Object.values(target.comments).map(comment => ({
        ...comment,
        blockId: comment.blockId === null ? null : blockOrdinals.get(comment.blockId) ?? `missing:${comment.blockId}`
      })),
      blocks: Object.values(target.blocks).flatMap(value => isScratchBlock(value) ? [{
      x: value.x ?? null,
      y: value.y ?? null,
        comment: value.comment === null || value.comment === undefined
          ? null
          : commentOrdinals.get(value.comment) ?? `missing:${value.comment}`
    }] : [])
    };
  });
}

function canonicalSerializedBlocks(project: ScratchProject, maps: NormalizationMaps): unknown {
  return project.targets.map((target, targetIndex) => {
    const ordinals = new Map(Object.keys(target.blocks).map((id, index) => [id, index]));
    return Object.entries(target.blocks).map(([blockId, value]) => {
      if (isPrimitive(value)) return canonicalPrimitive(value, project, maps, targetIndex);
      if (!isScratchBlock(value)) return value;
      const standard = new Set([
        'opcode', 'next', 'parent', 'inputs', 'fields', 'shadow', 'topLevel', 'x', 'y', 'comment', 'mutation'
      ]);
      return {
        opcode: value.opcode,
        next: canonicalBlockReference(value.next, ordinals),
        parent: canonicalBlockReference(value.parent, ordinals),
        inputs: Object.entries(value.inputs).map(([name, input]) => [
          canonicalInputName(value, name, targetIndex, maps),
          input.map((item, inputIndex) => canonicalSerializedInputItem(
            item,
            inputIndex,
            project,
            maps,
            targetIndex,
            ordinals
          ))
        ]),
        fields: Object.entries(value.fields).map(([name, field]) => [
          name,
          canonicalField(blockId, value, name, field, project, maps, targetIndex)
        ]),
        mutation: canonicalMutation(value.mutation, value, targetIndex, maps, true),
        shadow: value.shadow,
        topLevel: value.topLevel,
        extras: Object.fromEntries(Object.entries(value).filter(([key]) => !standard.has(key)))
      };
    });
  });
}

function canonicalSerializedInputItem(
  item: JsonValue,
  inputIndex: number,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  ordinals: ReadonlyMap<string, number>
): unknown {
  if (inputIndex === 0) return item;
  if (typeof item === 'string') return ['block', ordinals.get(item) ?? `missing:${item}`];
  if (isPrimitive(item)) return canonicalPrimitive(item, project, maps, targetIndex);
  return item;
}

function canonicalMonitors(
  project: ScratchProject,
  maps: NormalizationMaps,
  monitors: readonly Record<string, JsonValue>[]
): unknown {
  return monitors.map(monitor => {
    const copy = structuredClone(monitor);
    const targetIndex = monitorTargetIndex(project, monitor);
    const opcode = copy['opcode'];
    const id = copy['id'];
    if (typeof opcode === 'string' && typeof id === 'string') {
      const kind = opcode === 'data_variable' ? 'variable'
        : opcode === 'data_listcontents' ? 'list' : undefined;
      if (kind) {
        const resolved = resolveSymbolDeclaration(project, maps, targetIndex, kind, id);
        if (resolved) {
          copy['id'] = resolved.token;
          const params = copy['params'];
          const parameter = kind === 'variable' ? 'VARIABLE' : 'LIST';
          if (isRecord(params) && Object.hasOwn(params, parameter)) params[parameter] = resolved.token;
        }
      }
    }
    const params = copy['params'];
    if (isRecord(params)) {
      if (copy['opcode'] === 'sensing_of' && typeof params['PROPERTY'] === 'string') {
        const binding = resolveSensingMonitorBinding(project, maps, params);
        if (binding?.variableToken) params['PROPERTY'] = binding.variableToken;
      }
    }
    return copy;
  });
}

function canonicalMonitorBindings(
  project: ScratchProject,
  maps: NormalizationMaps,
  monitors: readonly Record<string, JsonValue>[]
): unknown {
  return monitors.map(monitor => {
    const targetIndex = monitorTargetIndex(project, monitor);
    const opcode = monitor['opcode'];
    const rawId = monitor['id'];
    const kind = opcode === 'data_variable' ? 'variable'
      : opcode === 'data_listcontents' ? 'list' : undefined;
    const resolved = kind && typeof rawId === 'string'
      ? resolveSymbolDeclaration(project, maps, targetIndex, kind, rawId)
      : undefined;
    const rawParams = monitor['params'];
    const params = isRecord(rawParams) ? structuredClone(rawParams) : rawParams;
    if (isRecord(params)) {
      if (resolved && kind) params[kind === 'variable' ? 'VARIABLE' : 'LIST'] = resolved.token;
      if (opcode === 'sensing_of') {
        const property = params['PROPERTY'];
        if (typeof property === 'string') {
          const binding = resolveSensingMonitorBinding(project, maps, params);
          if (binding?.variableToken) params['PROPERTY'] = binding.variableToken;
        }
        const object = params['OBJECT'];
        params['OBJECT'] = extraTargetNameToken(project, scratchSensingValue(object));
      }
    }
    const spriteName = monitor['spriteName'];
    return {
      id: resolved?.token ?? rawId,
      opcode,
      params,
      owner: typeof spriteName === 'string' ? extraTargetNameToken(project, spriteName) : spriteName ?? null
    };
  });
}

function rawMonitorDeclarations(
  project: ScratchProject,
  monitors: readonly Record<string, JsonValue>[]
): unknown {
  const stageIndex = project.targets.findIndex(target => target.isStage);
  return monitors.map(monitor => {
    const ownerTargetIndex = monitorTargetIndex(project, monitor);
    const opcode = monitor['opcode'];
    const id = monitor['id'];
    const kind = opcode === 'data_variable' ? 'variable'
      : opcode === 'data_listcontents' ? 'list' : undefined;
    if (kind && typeof id === 'string') {
      const candidateIndices = uniqueNumbers([ownerTargetIndex, stageIndex >= 0 ? stageIndex : 0]);
      for (const targetIndex of candidateIndices) {
        const target = project.targets[targetIndex];
        const declarations = kind === 'variable' ? target?.variables : target?.lists;
        const declaration = declarations?.[id];
        if (declaration !== undefined) {
          return {opcode, ownerTargetIndex, targetIndex, id, declaration};
        }
      }
      return {opcode, ownerTargetIndex, id, declaration: null};
    }
    if (opcode === 'sensing_of' && isRecord(monitor['params'])) {
      const params = monitor['params'];
      const binding = resolveSensingMonitorBinding(project, undefined, params);
      if (binding) return {
        opcode,
        ownerTargetIndex,
        selectedTargetIndex: binding.targetIndex,
        object: params['OBJECT'],
        property: params['PROPERTY'],
        native: binding.native,
        variableId: binding.variableId ?? null,
        declaration: binding.declaration ?? null
      };
    }
    return {opcode, ownerTargetIndex, declaration: null};
  });
}

interface SensingMonitorBinding {
  readonly targetIndex: number;
  readonly native: boolean;
  readonly variableId?: string;
  readonly variableToken?: string;
  readonly declaration?: JsonValue[];
}

function resolveSensingMonitorBinding(
  project: ScratchProject,
  maps: NormalizationMaps | undefined,
  params: Readonly<Record<string, JsonValue>>
): SensingMonitorBinding | undefined {
  const object = params['OBJECT'];
  const property = params['PROPERTY'];
  if (typeof property !== 'string') return undefined;
  const objectName = scratchSensingValue(object);
  const targetIndex = objectName === '_stage_'
    ? project.targets.findIndex(target => target.isStage)
    : project.targets.findIndex(target => !target.isStage && target.name === objectName);
  const target = project.targets[targetIndex];
  if (!target) return undefined;
  const native = (target.isStage ? STAGE_SENSING_PROPERTIES : SPRITE_SENSING_PROPERTIES).has(property);
  if (native) return {targetIndex, native: true};
  for (const [variableId, declaration] of Object.entries(target.variables)) {
    if (declaration[0] !== property) continue;
    const variableToken = maps?.targets[targetIndex]?.variables.get(variableId);
    return {
      targetIndex,
      native: false,
      variableId,
      ...(variableToken === undefined ? {} : {variableToken}),
      declaration
    };
  }
  return {targetIndex, native: false};
}

function scratchSensingValue(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.map(item => item === null ? '' : scratchSensingValue(item)).join(',');
  }
  if (typeof value === 'object') return '[object Object]';
  return String(value);
}

function isRecoverableStaleInvisibleMonitor(
  project: ScratchProject,
  monitor: Readonly<Record<string, JsonValue>>
): boolean {
  const opcode = monitor['opcode'];
  if (opcode !== 'data_variable' && opcode !== 'data_listcontents') return false;
  const spriteName = monitor['spriteName'];
  if (typeof spriteName !== 'string' || spriteName.length === 0 || monitor['visible'] !== false) return false;
  if (project.targets.some(target => target.name === spriteName)) return false;
  const id = monitor['id'];
  if (typeof id !== 'string') return false;
  const stage = project.targets.find(target => target.isStage);
  if (!stage) return false;
  const declarations = opcode === 'data_variable' ? stage.variables : stage.lists;
  return !Object.hasOwn(declarations, id);
}

function countTypedReferenceIntegrityIssues(project: ScratchProject, maps: NormalizationMaps): number {
  let issues = 0;
  const inspectPrimitive = (primitive: ScratchInput, targetIndex: number): void => {
    const type = primitive[0];
    const kind = type === 11 ? 'broadcast' : type === 12 ? 'variable' : type === 13 ? 'list' : undefined;
    const id = primitive[2];
    if (!kind || typeof id !== 'string' || id.length === 0) return;
    const resolved = resolveSymbolDeclaration(project, maps, targetIndex, kind, id);
    if (resolved && primitive[1] !== resolved.name) issues += 1;
  };
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const value of Object.values(target.blocks)) {
      if (isPrimitive(value)) {
        inspectPrimitive(value, targetIndex);
        continue;
      }
      if (!isScratchBlock(value)) continue;
      for (const input of Object.values(value.inputs)) {
        for (let slot = 1; slot < input.length; slot += 1) {
          const item = input[slot];
          if (isPrimitive(item)) inspectPrimitive(item, targetIndex);
        }
      }
      for (const [name, field] of Object.entries(value.fields)) {
        const kind = name === 'VARIABLE' ? 'variable'
          : name === 'LIST' ? 'list' : name === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
        const id = field[1];
        if (!kind || typeof id !== 'string' || id.length === 0) continue;
        const resolved = resolveSymbolDeclaration(project, maps, targetIndex, kind, id);
        if (resolved && field[0] !== resolved.name) issues += 1;
      }
    }
  }
  for (const monitor of project.monitors) {
    const kind = monitor['opcode'] === 'data_variable' ? 'variable'
      : monitor['opcode'] === 'data_listcontents' ? 'list' : undefined;
    const id = monitor['id'];
    if (!kind || typeof id !== 'string') continue;
    const targetIndex = monitorTargetIndex(project, monitor);
    const resolved = resolveSymbolDeclaration(project, maps, targetIndex, kind, id);
    if (!resolved) continue;
    const params = monitor['params'];
    const parameter = kind === 'variable' ? 'VARIABLE' : 'LIST';
    if (!isRecord(params) || params[parameter] !== resolved.name) issues += 1;
  }
  return issues;
}

function monitorTargetIndex(project: ScratchProject, monitor: Record<string, JsonValue>): number {
  const spriteName = monitor['spriteName'];
  if (typeof spriteName === 'string') {
    const index = project.targets.findIndex(target => target.name === spriteName);
    if (index >= 0) return index;
  }
  const stage = project.targets.findIndex(target => target.isStage);
  return stage >= 0 ? stage : 0;
}

function canonicalExtraExecutableValues(project: ScratchProject, maps: NormalizationMaps): unknown {
  return project.targets.map((target, targetIndex) => {
    const active = activeBlockIds(target);
    const orderedIds = Object.keys(target.blocks).filter(id => active.has(id));
    const ordinals = new Map(orderedIds.map((id, index) => [id, index]));
    const primitiveContexts = extraPrimitiveSelectorContexts(target, active);
    return orderedIds.map(id => {
      const value = target.blocks[id];
      if (isPrimitive(value)) {
        const context = primitiveContexts.get(id);
        return context === undefined || context === 'ambiguous'
          ? canonicalPrimitive(value, project, maps, targetIndex)
          : canonicalExtraSelectorPrimitive(value, context, project, maps, targetIndex);
      }
      if (!isScratchBlock(value)) return value;
      return canonicalExtraBlockValues(id, value, project, maps, targetIndex, ordinals);
    });
  });
}

function extraPrimitiveSelectorContexts(
  target: ScratchTarget,
  active: ReadonlySet<string>
): ReadonlyMap<string, ExtraSelectorKind | 'ambiguous'> {
  const contexts = new Map<string, ExtraSelectorKind | 'ambiguous'>();
  for (const [id, value] of Object.entries(target.blocks)) {
    if (!active.has(id) || !isScratchBlock(value)) continue;
    const selector = EXTRA_INPUT_SELECTORS.get(value.opcode);
    if (!selector) continue;
    const input = value.inputs[selector.input];
    if (!input) continue;
    const referenced = activeInputValue(input);
    if (typeof referenced !== 'string' || !isPrimitive(target.blocks[referenced])) continue;
    const previous = contexts.get(referenced);
    contexts.set(referenced, previous === undefined || previous === selector.kind ? selector.kind : 'ambiguous');
  }
  return contexts;
}

function canonicalExtraBlockValues(
  blockId: string,
  block: ScratchBlock,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  ordinals: ReadonlyMap<string, number>
): unknown {
  const standard = new Set([
    'opcode', 'next', 'parent', 'inputs', 'fields', 'shadow', 'topLevel', 'x', 'y', 'comment', 'mutation'
  ]);
  const selector = EXTRA_INPUT_SELECTORS.get(block.opcode);
  return {
    inputs: Object.entries(block.inputs).map(([name, input]) => [
      canonicalInputName(block, name, targetIndex, maps),
      selector?.input === name
        ? canonicalExtraSelectorInput(activeInputValue(input), selector.kind, project, maps, targetIndex, ordinals)
        : canonicalInputValue(activeInputValue(input), project, maps, targetIndex, ordinals)
    ]),
    fields: Object.entries(block.fields).map(([name, field]) => [
      name,
      canonicalExtraField(blockId, block, name, field, project, maps, targetIndex)
    ]),
    mutation: canonicalMutation(block.mutation, block, targetIndex, maps, true),
    extras: Object.fromEntries(Object.entries(block).filter(([key]) => !standard.has(key)))
  };
}

function canonicalExtraSelectorInput(
  value: JsonValue | undefined,
  kind: ExtraSelectorKind,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  ordinals: ReadonlyMap<string, number>
): unknown {
  if (typeof value === 'string') return ['block', ordinals.get(value) ?? `missing:${value}`];
  if (isPrimitive(value)) return canonicalExtraSelectorPrimitive(value, kind, project, maps, targetIndex);
  return value ?? null;
}

function canonicalExtraSelectorPrimitive(
  primitive: ScratchInput,
  kind: ExtraSelectorKind,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number
): unknown {
  if (kind === 'broadcast' && primitive[0] === 11) {
    return canonicalPrimitive(primitive, project, maps, targetIndex);
  }
  const literal = extraScalarLiteral(primitive);
  if (literal === undefined) return canonicalPrimitive(primitive, project, maps, targetIndex);
  if (!extraSelectorValueUsesNameLookup(kind, primitive[1])) {
    return canonicalPrimitive(primitive, project, maps, targetIndex);
  }
  return [primitive[0], extraSelectorNameToken(project, targetIndex, kind, literal), ...primitive.slice(2)];
}

function canonicalExtraField(
  blockId: string,
  block: ScratchBlock,
  name: string,
  field: JsonValue[],
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number
): unknown {
  const menu = EXTRA_MENU_FIELDS.get(block.opcode);
  const value = field[0];
  if (menu?.field === name && typeof value === 'string') {
    return [extraSelectorNameToken(project, targetIndex, menu.kind, value), ...field.slice(1)];
  }
  if (block.opcode === 'event_whenbackdropswitchesto' && name === 'BACKDROP' && typeof value === 'string') {
    return [extraBackdropHatToken(project, value), ...field.slice(1)];
  }
  if ((block.opcode === 'event_whenbroadcastreceived' || block.opcode === 'event_broadcast_menu')
    && name === 'BROADCAST_OPTION' && typeof value === 'string') {
    const id = field[1];
    const hasExplicitId = typeof id === 'string' && id.length > 0;
    if (!hasExplicitId) {
      const resolvedByName = resolveTypedSymbolDeclarationByName(project, maps, value, 'broadcast');
      if (resolvedByName) {
        return [resolvedByName.token, resolvedByName.token, ...field.slice(2)];
      }
    }
    if (!hasExplicitId || resolveSymbolDeclaration(project, maps, targetIndex, 'broadcast', id) === undefined) {
      return [extraBroadcastNameToken(project, value), ...field.slice(1)];
    }
  }
  return canonicalField(blockId, block, name, field, project, maps, targetIndex);
}

function extraScalarLiteral(primitive: ScratchInput): string | undefined {
  const type = primitive[0];
  if (typeof type !== 'number' || type < 4 || type > 10) return undefined;
  const value = primitive[1];
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : undefined;
}

function extraSelectorValueUsesNameLookup(kind: ExtraSelectorKind, value: JsonValue | undefined): boolean {
  if (kind === 'target' || kind === 'broadcast') return true;
  if (kind === 'sound') return typeof value === 'string';
  return typeof value !== 'number';
}

function extraSelectorNameToken(
  project: ScratchProject,
  ownerTargetIndex: number,
  kind: ExtraSelectorKind,
  name: string
): JsonValue {
  if (kind === 'target') return extraTargetNameToken(project, name);
  if (kind === 'broadcast') return extraBroadcastNameToken(project, name);
  const target = kind === 'backdrop'
    ? project.targets.find(candidate => candidate.isStage)
    : project.targets[ownerTargetIndex];
  if (!target) return name;
  const descriptors = kind === 'sound' ? target.sounds : target.costumes;
  const index = descriptors.findIndex(descriptor => descriptor['name'] === name);
  return index < 0 ? name : [`extra-${kind}`, project.targets.indexOf(target), index];
}

function extraTargetNameToken(project: ScratchProject, name: string): JsonValue {
  if (EXTRA_TARGET_SENTINELS.has(name)) return name;
  const index = project.targets.findIndex(target => !target.isStage && target.name === name);
  return index < 0 ? name : ['extra-target', index];
}

function extraBroadcastNameToken(project: ScratchProject, name: string): JsonValue {
  const requested = name.toLowerCase();
  const seen = new Set<string>();
  let ordinal = 0;
  for (const target of project.targets) {
    for (const declaration of Object.values(target.broadcasts)) {
      const runtimeName = declaration.toLowerCase();
      if (seen.has(runtimeName)) continue;
      seen.add(runtimeName);
      if (runtimeName === requested) return ['extra-broadcast', ordinal];
      ordinal += 1;
    }
  }
  return name;
}

function extraBackdropHatToken(project: ScratchProject, name: string): JsonValue {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) return name;
  const requested = name.toUpperCase();
  const seen = new Set<string>();
  let ordinal = 0;
  for (const descriptor of stage.costumes) {
    const display = descriptor['name'];
    if (typeof display !== 'string') continue;
    const runtimeName = display.toUpperCase();
    if (seen.has(runtimeName)) continue;
    seen.add(runtimeName);
    if (runtimeName === requested) return ['extra-backdrop-hat', ordinal];
    ordinal += 1;
  }
  return name;
}

function canonicalExecutableGraph(project: ScratchProject, maps: NormalizationMaps): CanonicalExecutableGraph {
  const topology: unknown[] = [];
  const values: unknown[] = [];
  const nativeHatCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const nativeHatSignatures: Record<string, number> = Object.create(null) as Record<string, number>;
  const nativeHatSites: NativeHatSiteSnapshot[] = [];
  const nodeSignatures: Record<string, number> = Object.create(null) as Record<string, number>;
  let objectBlockCount = 0;
  let executableObjectBlocks = 0;
  let procedureCount = 0;
  let activeStopAllCount = 0;
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [id, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      objectBlockCount += 1;
      if (!value.topLevel || !isOfficialHatOpcode(value.opcode)) continue;
      nativeHatSites.push(Object.freeze({
        targetIndex,
        hatId: id,
        opcode: value.opcode,
        originalNext: value.next
      }));
    }
    const active = activeBlockIds(target);
    const orderedIds = Object.keys(target.blocks).filter(id => active.has(id));
    const ordinals = new Map(orderedIds.map((id, index) => [id, index]));
    const targetTopology: unknown[] = [];
    const targetValues: unknown[] = [];
    for (const id of orderedIds) {
      const value = target.blocks[id];
      if (isPrimitive(value)) {
        targetTopology.push({kind: 'primitive', type: value[0]});
        targetValues.push(canonicalPrimitive(value, project, maps, targetIndex));
        continue;
      }
      if (!isScratchBlock(value)) continue;
      executableObjectBlocks += 1;
      if (value.opcode === 'procedures_definition') procedureCount += 1;
      if (value.opcode === 'control_stop' && value.fields['STOP_OPTION']?.[0] === 'all') {
        activeStopAllCount += 1;
      }
      const blockTopology = canonicalBlockTopology(value, targetIndex, ordinals, maps);
      const blockValues = canonicalBlockValues(id, value, project, targetIndex, maps, ordinals);
      incrementCount(nodeSignatures, `${targetIndex}:${digest(canonicalRetentionNodeSignature(value, target))}`);
      if (value.topLevel && isOfficialHatOpcode(value.opcode)) {
        nativeHatCounts[value.opcode] = (nativeHatCounts[value.opcode] ?? 0) + 1;
        const signature = `${targetIndex}:${value.opcode}:${digest({
          topology: canonicalNodeTopology(blockTopology),
          values: blockValues
        })}`;
        incrementCount(nativeHatSignatures, signature);
      }
      targetTopology.push(blockTopology);
      targetValues.push(blockValues);
    }
    topology.push(targetTopology);
    values.push(targetValues);
  }
  return {
    topology,
    values,
    nodeSignatures,
    objectBlockCount,
    executableObjectBlocks,
    procedureCount,
    activeStopAllCount,
    nativeHatCounts,
    nativeHatSignatures,
    nativeHatSites: Object.freeze(nativeHatSites)
  };
}

function canonicalNodeTopology(topology: unknown): unknown {
  if (!isRecord(topology)) return topology;
  return Object.fromEntries(Object.entries(topology).filter(([key]) => key !== 'next' && key !== 'parent'));
}

function canonicalRetentionNodeSignature(block: ScratchBlock, target: ScratchTarget): unknown {
  return {
    opcode: block.opcode,
    inputs: Object.entries(block.inputs).map(([name, input]) => [
      name,
      canonicalRetentionInput(activeInputValue(input), target)
    ]),
    fields: Object.entries(block.fields).map(([name, field]) => [
      name,
      name === 'VARIABLE' || name === 'LIST' || name === 'BROADCAST_OPTION'
        || ((block.opcode === 'argument_reporter_boolean'
          || block.opcode === 'argument_reporter_string_number') && name === 'VALUE')
        ? ['typed-reference']
        : field
    ]),
    mutation: block.opcode === 'procedures_call' || block.opcode === 'procedures_prototype'
      ? {
          placeholders: typeof block.mutation?.['proccode'] === 'string'
            ? block.mutation['proccode'].match(/%[sbn]/g) ?? []
            : null,
          argumentCount: parseJsonStringArray(block.mutation?.['argumentids'])?.length ?? null,
          warp: block.mutation?.['warp'] ?? null
        }
      : block.mutation ?? null,
    shadow: block.shadow,
    topLevel: block.topLevel
  };
}

function canonicalRetentionInput(value: JsonValue | undefined, target: ScratchTarget): unknown {
  if (typeof value === 'string') {
    const referenced = target.blocks[value];
    return isScratchBlock(referenced) ? ['block', referenced.opcode]
      : isPrimitive(referenced) ? ['primitive', referenced[0]] : ['missing'];
  }
  if (isPrimitive(value)) {
    const type = value[0];
    return typeof type === 'number' && type >= 11 ? [type, 'typed-reference'] : value;
  }
  return value ?? null;
}

function activeBlockIds(target: ScratchTarget): Set<string> {
  const active = new Set<string>();
  const queue = Object.entries(target.blocks)
    .filter(([, value]) => isScratchBlock(value) && value.topLevel && !value.shadow)
    .map(([id]) => id);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id || active.has(id)) continue;
    const value = target.blocks[id];
    if (!value) continue;
    active.add(id);
    if (!isScratchBlock(value)) continue;
    if (typeof value.next === 'string') queue.push(value.next);
    for (const input of Object.values(value.inputs)) {
      const child = activeInputValue(input);
      if (typeof child === 'string') queue.push(child);
    }
  }
  return active;
}

function canonicalBlockTopology(
  block: ScratchBlock,
  targetIndex: number,
  ordinals: ReadonlyMap<string, number>,
  maps: NormalizationMaps
): unknown {
  return {
    opcode: block.opcode,
    next: canonicalBlockReference(block.next, ordinals),
    parent: canonicalBlockReference(block.parent, ordinals),
    inputs: Object.entries(block.inputs).map(([name, input]) => [
      canonicalInputName(block, name, targetIndex, maps),
      canonicalInputTopology(activeInputValue(input), ordinals)
    ]),
    fieldNames: Object.keys(block.fields),
    shadow: block.shadow,
    topLevel: block.topLevel,
    mutationShape: canonicalMutation(block.mutation, block, targetIndex, maps, false)
  };
}

function canonicalBlockValues(
  blockId: string,
  block: ScratchBlock,
  project: ScratchProject,
  targetIndex: number,
  maps: NormalizationMaps,
  ordinals: ReadonlyMap<string, number>
): unknown {
  const standard = new Set([
    'opcode', 'next', 'parent', 'inputs', 'fields', 'shadow', 'topLevel', 'x', 'y', 'comment', 'mutation'
  ]);
  const extras = Object.fromEntries(Object.entries(block).filter(([key]) => !standard.has(key)));
  return {
    inputs: Object.entries(block.inputs).map(([name, input]) => [
      canonicalInputName(block, name, targetIndex, maps),
      canonicalInputValue(activeInputValue(input), project, maps, targetIndex, ordinals)
    ]),
    fields: Object.entries(block.fields).map(([name, field]) => [
      name,
      canonicalField(blockId, block, name, field, project, maps, targetIndex)
    ]),
    mutation: canonicalMutation(block.mutation, block, targetIndex, maps, true),
    extras
  };
}

function canonicalInputTopology(value: JsonValue | undefined, ordinals: ReadonlyMap<string, number>): unknown {
  if (typeof value === 'string') return ['block', ordinals.get(value) ?? `missing:${value}`];
  if (isPrimitive(value)) return ['primitive', value[0]];
  return value ?? null;
}

function canonicalInputValue(
  value: JsonValue | undefined,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  ordinals: ReadonlyMap<string, number>
): unknown {
  if (typeof value === 'string') return ['block', ordinals.get(value) ?? `missing:${value}`];
  if (isPrimitive(value)) return canonicalPrimitive(value, project, maps, targetIndex);
  return value ?? null;
}

function canonicalPrimitive(
  primitive: ScratchInput,
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number
): unknown {
  const type = primitive[0];
  if (type !== 11 && type !== 12 && type !== 13) return primitive;
  const kind = type === 11 ? 'broadcast' : type === 12 ? 'variable' : 'list';
  const id = primitive[2];
  const name = primitive[1];
  const resolved = typeof id === 'string'
    ? resolveSymbolDeclaration(project, maps, targetIndex, kind, id)
    : undefined;
  const nameToken = typeof name === 'string'
    ? resolveTypedSymbolNameToken(project, maps, targetIndex, name, kind)
    : undefined;
  if (resolved) {
    return [type, resolved.token, resolved.token, ...primitive.slice(3)];
  }
  return [type, nameToken ?? name, nameToken ?? id, ...primitive.slice(3)];
}

function canonicalField(
  blockId: string,
  block: ScratchBlock,
  name: string,
  field: JsonValue[],
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number
): unknown {
  if (block.opcode === 'sensing_of' && name === 'PROPERTY' && typeof field[0] === 'string') {
    return [canonicalSensingProperty(project, maps, targetIndex, block, field[0]), ...field.slice(1)];
  }
  const kind = name === 'VARIABLE' ? 'variable'
    : name === 'LIST' ? 'list'
      : name === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
  if (kind) {
    const id = field[1];
    const display = field[0];
    const resolved = typeof id === 'string'
      ? resolveSymbolDeclaration(project, maps, targetIndex, kind, id)
      : undefined;
    const nameToken = typeof display === 'string'
      ? resolveTypedSymbolNameToken(project, maps, targetIndex, display, kind)
      : undefined;
    if (resolved) {
      return [resolved.token, resolved.token, ...field.slice(2)];
    }
    return [nameToken ?? display, nameToken ?? id, ...field.slice(2)];
  }
  if ((block.opcode === 'argument_reporter_boolean'
    || block.opcode === 'argument_reporter_string_number') && name === 'VALUE') {
    const display = field[0];
    if (typeof display === 'string') {
      const target = project.targets[targetIndex];
      const ownerCode = target ? owningProcedureCode(target, blockId) : undefined;
      const token = ownerCode
        ? maps.targets[targetIndex]?.argumentNamesByProcedure.get(ownerCode)?.get(display)
        : undefined;
      if (token) return [token, ...field.slice(1)];
    }
  }
  return field;
}

function canonicalSensingProperty(
  project: ScratchProject,
  maps: NormalizationMaps,
  ownerTargetIndex: number,
  block: ScratchBlock,
  property: string
): unknown {
  if (property === ANTI_CHEAT_WATERMARK_NAME) return property;
  const selection = sensingSelectionTargetIndices(project, maps, ownerTargetIndex, block.inputs['OBJECT']);
  if (selection === 'missing') return property;
  const targetIndices = selection === 'dynamic'
    ? project.targets.map((_, index) => index)
    : [selection];
  if (targetIndices.some(targetIndex => {
    const target = project.targets[targetIndex];
    return target !== undefined
      && (target.isStage ? STAGE_SENSING_PROPERTIES : SPRITE_SENSING_PROPERTIES).has(property);
  })) return property;
  const tokens: string[] = [];
  for (const targetIndex of targetIndices) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [id, declaration] of Object.entries(target.variables)) {
      if (declaration[0] !== property) continue;
      if (target.isStage && declaration[0] === ANTI_CHEAT_WATERMARK_NAME) continue;
      const token = maps.targets[targetIndex]?.variables.get(id);
      if (token) tokens.push(token);
      break;
    }
  }
  return tokens.length === 0 ? property : ['variable-property', ...tokens];
}

function sensingSelectionTargetIndices(
  project: ScratchProject,
  maps: NormalizationMaps,
  ownerTargetIndex: number,
  input: ScratchInput | undefined
): number | 'dynamic' | 'missing' {
  const literal = sensingSelectorLiteral(project, maps, ownerTargetIndex, input?.[1]);
  if (literal === undefined) return 'dynamic';
  if (literal === '_stage_') return maps.stageIndex;
  const targetIndex = project.targets.findIndex(target => !target.isStage && target.name === literal);
  return targetIndex < 0 ? 'missing' : targetIndex;
}

function sensingSelectorLiteral(
  project: ScratchProject,
  maps: NormalizationMaps,
  ownerTargetIndex: number,
  value: JsonValue | undefined
): string | undefined {
  if (isPrimitive(value)) return sensingPrimitiveLiteral(project, maps, ownerTargetIndex, value);
  if (typeof value !== 'string') return undefined;
  const target = project.targets[ownerTargetIndex];
  const reporter = target?.blocks[value];
  if (isPrimitive(reporter)) return sensingPrimitiveLiteral(project, maps, ownerTargetIndex, reporter);
  if (!isScratchBlock(reporter) || !OFFICIAL_LITERAL_SHADOW_OPCODES.has(reporter.opcode)
    || Object.keys(reporter.inputs).length > 0 || Object.keys(reporter.fields).length !== 1) return undefined;
  const entry = Object.entries(reporter.fields)[0];
  if (!entry) return undefined;
  const [fieldName, field] = entry;
  const kind = fieldName === 'VARIABLE' ? 'variable'
    : fieldName === 'LIST' ? 'list' : fieldName === 'BROADCAST_OPTION' ? 'broadcast' : undefined;
  if (kind) {
    const id = field[1];
    const resolved = typeof id === 'string' && id.length > 0
      ? resolveSymbolDeclaration(project, maps, ownerTargetIndex, kind, id)
      : typeof field[0] === 'string'
        ? resolveTypedSymbolDeclarationByName(project, maps, field[0], kind)
        : undefined;
    return resolved?.name;
  }
  const literal = field[0];
  return typeof literal === 'string' || typeof literal === 'number' || typeof literal === 'boolean'
    ? String(literal)
    : undefined;
}

function sensingPrimitiveLiteral(
  project: ScratchProject,
  maps: NormalizationMaps,
  ownerTargetIndex: number,
  primitive: ScratchInput
): string | undefined {
  const type = primitive[0];
  if (type === 11) {
    const id = primitive[2];
    const resolved = typeof id === 'string' && id.length > 0
      ? resolveSymbolDeclaration(project, maps, ownerTargetIndex, 'broadcast', id)
      : typeof primitive[1] === 'string'
        ? resolveTypedSymbolDeclarationByName(project, maps, primitive[1], 'broadcast')
        : undefined;
    return resolved?.name;
  }
  if (typeof type !== 'number' || type < 4 || type > 10) return undefined;
  const literal = primitive[1];
  return typeof literal === 'string' || typeof literal === 'number' || typeof literal === 'boolean'
    ? String(literal)
    : undefined;
}

function canonicalMutation(
  mutation: Record<string, JsonValue> | undefined,
  block: ScratchBlock,
  targetIndex: number,
  maps: NormalizationMaps,
  includeValues: boolean
): unknown {
  if (!mutation) return null;
  const code = typeof mutation['proccode'] === 'string' ? mutation['proccode'] : undefined;
  const procedureToken = code ? maps.targets[targetIndex]?.procedures.get(code) : undefined;
  const argumentsForProcedure = code
    ? maps.targets[targetIndex]?.procedureArguments.get(code)
    : undefined;
  return Object.entries(mutation).map(([key, value]) => {
    if (key === 'proccode') return [key, procedureToken ?? (includeValues ? value : typeof value)];
    if (key === 'argumentids' && typeof value === 'string') {
      const ids = parseJsonStringArray(value);
      return [key, ids && argumentsForProcedure
        ? ids.map(id => argumentsForProcedure.get(id) ?? ['unknown-argument-id', id])
        : value];
    }
    if (key === 'argumentnames' && typeof value === 'string') {
      const names = parseJsonStringArray(value);
      const nameTokens = code
        ? maps.targets[targetIndex]?.argumentNamesByProcedure.get(code)
        : undefined;
      return [key, names && nameTokens ? names.map(name => nameTokens.get(name) ?? name) : value];
    }
    if (!includeValues && key !== 'warp') return [key, jsonShape(value)];
    return [key, value];
  });
}

function canonicalInputName(
  block: ScratchBlock,
  name: string,
  targetIndex: number,
  maps: NormalizationMaps
): string {
  if (block.opcode !== 'procedures_call' && block.opcode !== 'procedures_prototype') return name;
  const code = typeof block.mutation?.['proccode'] === 'string' ? block.mutation['proccode'] : undefined;
  return code ? maps.targets[targetIndex]?.procedureArguments.get(code)?.get(name) ?? name : name;
}

function canonicalBlockReference(value: string | null, ordinals: ReadonlyMap<string, number>): unknown {
  if (value === null) return null;
  return ordinals.get(value) ?? `missing:${value}`;
}

function activeInputValue(input: ScratchInput): JsonValue | undefined {
  return input[1] ?? input[2];
}

function buildNormalizationMaps(project: ScratchProject): NormalizationMaps {
  const targets: TargetNormalizationMaps[] = [];
  const stageIndex = project.targets.findIndex(target => target.isStage);
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    const procedures = new Map<string, string>();
    const procedureArguments = new Map<string, ReadonlyMap<string, string>>();
    const argumentNamesByProcedure = new Map<string, ReadonlyMap<string, string>>();
    const prototypes = Object.values(target.blocks).flatMap(value => {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_prototype') return [];
      const code = value.mutation?.['proccode'];
      const ids = parseJsonStringArray(value.mutation?.['argumentids']);
      const names = parseJsonStringArray(value.mutation?.['argumentnames']);
      const defaults = parseJsonScalarArray(value.mutation?.['argumentdefaults']);
      const placeholders = typeof code === 'string' ? code.match(/%[sbn]/g) ?? [] : [];
      if (typeof code !== 'string' || !ids || !names || !defaults
        || new Set(ids).size !== ids.length
        || ids.length !== names.length
        || ids.length !== defaults.length
        || ids.length !== placeholders.length) return [];
      return [{code, ids, names}];
    });
    const codeCounts = new Map<string, number>();
    for (const prototype of prototypes) {
      codeCounts.set(prototype.code, (codeCounts.get(prototype.code) ?? 0) + 1);
    }
    const blockedCodes = new Set<string>();
    const prototypeByCode = new Map(prototypes
      .filter(prototype => codeCounts.get(prototype.code) === 1)
      .map(prototype => [prototype.code, prototype]));
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
      const code = value.mutation?.['proccode'];
      if (typeof code !== 'string') continue;
      const expected = prototypeByCode.get(code)?.ids;
      const actual = parseJsonStringArray(value.mutation?.['argumentids']);
      if (!expected || !actual || actual.length !== expected.length
        || actual.some((id, index) => id !== expected[index])) blockedCodes.add(code);
    }
    let procedureOrdinal = 0;
    for (const prototype of prototypes) {
      const {code, ids, names} = prototype;
      if (codeCounts.get(code) !== 1 || blockedCodes.has(code)) continue;
      const procedureToken = `procedure:${targetIndex}:${procedureOrdinal}`;
      procedureOrdinal += 1;
      procedures.set(code, procedureToken);
      const idMap = new Map<string, string>();
      for (const [index, id] of ids.entries()) {
        const token = `${procedureToken}:argument:${index}`;
        idMap.set(id, token);
      }
      procedureArguments.set(code, idMap);
      const nameMap = new Map<string, string>();
      for (const [index, name] of names.entries()) {
        if (!nameMap.has(name)) nameMap.set(name, `${procedureToken}:argument-name:${index}`);
      }
      argumentNamesByProcedure.set(code, nameMap);
    }
    targets[targetIndex] = {
      variables: declarationTokens(target.variables, 'variable', targetIndex),
      lists: declarationTokens(target.lists, 'list', targetIndex),
      broadcasts: declarationTokens(target.broadcasts, 'broadcast', targetIndex),
      procedures,
      procedureArguments,
      argumentNamesByProcedure
    };
  }
  return {targets, stageIndex: stageIndex >= 0 ? stageIndex : 0};
}

function declarationTokens(
  declarations: Readonly<Record<string, unknown>>,
  kind: string,
  targetIndex: number
): ReadonlyMap<string, string> {
  return new Map(Object.keys(declarations).map((id, index) => [id, `${kind}:${targetIndex}:${index}`]));
}

function resolveSymbolDeclaration(
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  kind: 'variable' | 'list' | 'broadcast',
  id: string
): {readonly name: string; readonly token: string} | undefined {
  const candidateIndices = kind === 'broadcast' ? [maps.stageIndex] : uniqueNumbers([targetIndex, maps.stageIndex]);
  for (const candidateTargetIndex of candidateIndices) {
    const target = project.targets[candidateTargetIndex];
    if (!target) continue;
    const declarations: Readonly<Record<string, string | JsonValue[]>> = kind === 'broadcast'
      ? target.broadcasts
      : kind === 'variable' ? target.variables : target.lists;
    const declaration = declarations[id];
    if (declaration === undefined) continue;
    const name = typeof declaration === 'string' ? declaration : declaration[0];
    const token = maps.targets[candidateTargetIndex]?.[`${kind}s`].get(id);
    if (typeof name === 'string' && token) return {name, token};
  }
  return undefined;
}

function resolveTypedSymbolNameToken(
  project: ScratchProject,
  maps: NormalizationMaps,
  targetIndex: number,
  name: string,
  kind: 'variable' | 'list' | 'broadcast'
): string | undefined {
  void targetIndex;
  for (const candidateTargetIndex of [maps.stageIndex]) {
    const target = project.targets[candidateTargetIndex];
    if (!target) continue;
    const declarations: Readonly<Record<string, string | JsonValue[]>> = kind === 'broadcast'
      ? target.broadcasts
      : kind === 'variable' ? target.variables : target.lists;
    for (const [id, declaration] of Object.entries(declarations)) {
      const display = typeof declaration === 'string' ? declaration : declaration[0];
      if (display !== name) continue;
      return maps.targets[candidateTargetIndex]?.[`${kind}s`].get(id);
    }
  }
  return undefined;
}

function resolveTypedSymbolDeclarationByName(
  project: ScratchProject,
  maps: NormalizationMaps,
  name: string,
  kind: 'variable' | 'list' | 'broadcast'
): {readonly name: string; readonly token: string} | undefined {
  const stage = project.targets[maps.stageIndex];
  if (!stage) return undefined;
  const declarations: Readonly<Record<string, string | JsonValue[]>> = kind === 'broadcast'
    ? stage.broadcasts
    : kind === 'variable' ? stage.variables : stage.lists;
  for (const [id, declaration] of Object.entries(declarations)) {
    const display = typeof declaration === 'string' ? declaration : declaration[0];
    if (display !== name) continue;
    const token = maps.targets[maps.stageIndex]?.[`${kind}s`].get(id);
    if (token) return {name, token};
  }
  return undefined;
}

function parseJsonStringArray(value: JsonValue | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonScalarArray(value: JsonValue | undefined): Array<boolean | number | string> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => (
      typeof item === 'boolean' || typeof item === 'string'
        || (typeof item === 'number' && Number.isFinite(item))
    )) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function owningProcedureCode(target: ScratchTarget, blockId: string): string | undefined {
  const visited = new Set<string>();
  let currentId: string | null = blockId;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const current: unknown = target.blocks[currentId];
    if (!isScratchBlock(current)) return undefined;
    if (current.opcode === 'procedures_prototype') {
      const code = current.mutation?.['proccode'];
      return typeof code === 'string' ? code : undefined;
    }
    if (current.opcode === 'procedures_definition') {
      const prototypeId = current.inputs['custom_block']?.[1];
      if (typeof prototypeId !== 'string') return undefined;
      const prototype = target.blocks[prototypeId];
      const code = isScratchBlock(prototype) ? prototype.mutation?.['proccode'] : undefined;
      return typeof code === 'string' ? code : undefined;
    }
    currentId = current.parent;
  }
  return undefined;
}

function jsonShape(value: JsonValue): unknown {
  if (Array.isArray(value)) return value.map(jsonShape);
  if (isRecord(value)) return Object.entries(value).map(([key, child]) => [key, jsonShape(child)]);
  return typeof value;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function missingMultisetEntries(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>
): string[] {
  return Object.entries(expected).flatMap(([key, count]) => (
    (actual[key] ?? 0) < count ? [key] : []
  ));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireSnapshotVersion(snapshot: ProjectVerificationSnapshot): void {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new TypeError(`unsupported verification snapshot version ${String(snapshot.version)}`);
  }
  if (!TRUSTED_VERIFICATION_SNAPSHOTS.has(snapshot)) {
    throw new TypeError('untrusted verification snapshot');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
