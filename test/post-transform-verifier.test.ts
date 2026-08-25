import {describe, expect, it} from 'vitest';
import {serializeProjectPayload} from '../src/archive/writer.js';
import {DeterministicGenerator} from '../src/deterministic.js';
import {
  aggressiveBlockEquivalentCap,
  antiCheatBlockGrowthLimit,
  compactSerializedJsonLimit,
  exceedsTransformedJsonSafetyLimit,
  transformedJsonSafetyLimit
} from '../src/growth-policy.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {
  ANTI_CHEAT_DECOY_COUNT,
  ANTI_CHEAT_WATERMARK_NAME,
  applyAntiCheatTransform,
  applyWatermarkTransform
} from '../src/obfuscation/anticheat.js';
import {
  ANTI_SAVE_GENERATOR_DOMAIN,
  ANTI_SAVE_PASS_NAME,
  applyAntiSaveTransform,
  type AntiSaveVerificationManifest
} from '../src/obfuscation/antisave.js';
import {obfuscateProject} from '../src/obfuscation/index.js';
import {applySafeOptimizations} from '../src/obfuscation/optimizer.js';
import {
  applyExtraEditorShadowTransform,
  applyExtraPrivacyTransform,
  EXTRA_EDITOR_SHADOW_ALLOWED_CHANGES,
  EXTRA_EDITOR_SHADOW_CAVEAT,
  EXTRA_EDITOR_SHADOW_PASS_NAME,
  EXTRA_PRIVACY_ALLOWED_CHANGES,
  EXTRA_PRIVACY_GENERATOR_DOMAIN,
  EXTRA_PRIVACY_PASS_NAME,
  type ExtraEditorShadowManifest
} from '../src/obfuscation/privacy.js';
import type {
  JsonValue,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject
} from '../src/types.js';
import {
  captureProjectVerificationSnapshot,
  changedVerificationCategories,
  verifyPostTransform,
  type PostTransformVerificationOptions,
  type VerificationPassBoundary
} from '../src/verification/post-transform.js';
import {createFixtureProject} from './support.js';

const seed = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const OFFICIAL_EXTENSION_HATS = [
  'boost_whenColor',
  'boost_whenTilted',
  'ev3_whenBrightnessLessThan',
  'ev3_whenButtonPressed',
  'ev3_whenDistanceLessThan',
  'faceSensing_whenFaceDetected',
  'faceSensing_whenSpriteTouchesPart',
  'faceSensing_whenTilted',
  'gdxfor_whenForcePushedOrPulled',
  'gdxfor_whenGesture',
  'gdxfor_whenTilted',
  'makeymakey_whenCodePressed',
  'makeymakey_whenMakeyKeyPressed',
  'microbit_whenButtonPressed',
  'microbit_whenGesture',
  'microbit_whenPinConnected',
  'microbit_whenTilted',
  'videoSensing_whenMotionGreaterThan',
  'wedo2_whenDistance',
  'wedo2_whenTilted'
] as const;

describe('growth policy boundaries', () => {
  it.each([
    ['lossy', false, 14_999, 29_998],
    ['lossy', false, 15_000, 30_000],
    ['lossy', false, 15_001, 30_000],
    ['lossy', false, 30_001, 30_001],
    ['lossy', true, 1, 257],
    ['lossy', true, 12_499, 49_996],
    ['lossy', true, 12_500, 50_000],
    ['lossy', true, 12_501, 50_000],
    ['lossy', true, 50_001, 50_001],
    ['no-preserve', false, 9_829, 29_999],
    ['no-preserve', false, 9_830, 30_000],
    ['no-preserve', false, 30_001, 30_001],
    ['no-preserve', true, 1, 2_049],
    ['no-preserve', true, 64, 2_112],
    ['no-preserve', true, 3_979, 99_987],
    ['no-preserve', true, 3_980, 100_000],
    ['no-preserve', true, 100_001, 100_001]
  ] as const)('%s allowSize=%s caps N=%i at %i', (mode, allowSize, initial, expected) => {
    expect(aggressiveBlockEquivalentCap(initial, mode, allowSize)).toBe(expected);
  });

  it('keeps compact serialized and anti-cheat thresholds exact at their boundaries', () => {
    expect(compactSerializedJsonLimit(1, 'lossy')).toBe((512 * 1024) + 4);
    expect(compactSerializedJsonLimit(1, 'no-preserve')).toBe((1024 * 1024) + 8);
    expect(antiCheatBlockGrowthLimit(0)).toBe(4096);
    expect(antiCheatBlockGrowthLimit(3238)).toBe(30_000);
    expect(antiCheatBlockGrowthLimit(3239)).toBe(30_000);
  });

  it.each([
    ['lossless', 64 * 1024 * 1024],
    ['lossy', 64 * 1024 * 1024],
    ['no-preserve', 128 * 1024 * 1024]
  ] as const)('%s hard JSON cap cannot be waived by expanded growth', (mode, limit) => {
    expect(transformedJsonSafetyLimit(mode)).toBe(limit);
    expect(exceedsTransformedJsonSafetyLimit(limit, mode)).toBe(false);
    expect(exceedsTransformedJsonSafetyLimit(limit + 1, mode)).toBe(true);
  });
});

describe('post-transform verifier', () => {
  it('measures the exact production JSON payload including negative zero', () => {
    const project = createFixtureProject();
    const target = project.targets[0];
    if (target === undefined) throw new Error('fixture target is missing');
    target.variables['negative-zero'] = ['negative zero', -0];

    const snapshot = captureProjectVerificationSnapshot(project);
    const ordinaryBytes = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    expect(snapshot.serializedUtf8Bytes).toBe(serializeProjectPayload(project).byteLength);
    expect(snapshot.serializedUtf8Bytes).toBe(ordinaryBytes + 1);
  });

  it('proves the manifest-bound signed-zero chain and every original native-hat entry', () => {
    const fixture = antiSaveVerifierFixture(false);

    const report = verifyPostTransform(fixture.source, fixture.transformed, fixture.options);

    expect(report.failures).toEqual([]);
    expect(report.provenInvariants).toEqual(expect.arrayContaining([
      'antisave-exact-signed-zero-chain-and-native-hat-coverage-verified',
      'antisave-exact-additive-block-and-declaration-growth-verified',
      'antisave-manifest-derived-serialized-growth-cap-respected'
    ]));
  });

  it('rejects a copied anti-save manifest that was not emitted by the active transform', () => {
    const fixture = antiSaveVerifierFixture(false);
    const copied = structuredClone(fixture.manifest);

    const report = verifyPostTransform(fixture.source, fixture.transformed, {
      ...fixture.options,
      antiSaveManifest: copied
    });

    expect(report.failures.map(finding => finding.code))
      .toContain('antisave-manifest-missing-or-untrusted');
  });

  it('rejects normalization of the signed-zero sentinel before archive release', () => {
    const fixture = antiSaveVerifierFixture(false);
    const stage = requiredFixtureTarget(fixture.transformed, fixture.manifest.stageTargetIndex);
    const sentinel = stage.variables[fixture.manifest.sentinelVariableId];
    if (!sentinel) throw new Error('anti-save sentinel is unavailable');
    sentinel[1] = 0;

    const report = verifyPostTransform(fixture.source, fixture.transformed, fixture.options);

    expect(report.failures.map(finding => finding.code)).toContain('antisave-canary-declaration-invalid');
  });

  it('rejects a missing Unicode marker payload before archive release', () => {
    const fixture = antiSaveVerifierFixture(false);
    const stage = requiredFixtureTarget(fixture.transformed, fixture.manifest.stageTargetIndex);
    const marker = stage.lists[fixture.manifest.markerListId];
    if (!marker) throw new Error('anti-save marker list is unavailable');
    marker[1] = [];

    const report = verifyPostTransform(fixture.source, fixture.transformed, fixture.options);

    expect(report.failures.map(finding => finding.code)).toContain('antisave-canary-declaration-invalid');
  });

  it('binds each manifest guard to the exact pre-pass original successor', () => {
    const fixture = antiSaveVerifierFixture(false);
    const mismatchedSource = structuredClone(fixture.source);
    const site = requiredAntiSaveHatGuard(fixture.manifest, 0);
    const sourceHat = requiredFixtureBlock(
      requiredFixtureTarget(mismatchedSource, site.targetIndex).blocks[site.hatId],
      site.hatId
    );
    sourceHat.next = null;
    const originalPassTrace = fixture.options.passTrace;
    if (!originalPassTrace) throw new Error('anti-save verifier pass trace is unavailable');
    const passTrace = originalPassTrace.map(boundary => boundary.pass === ANTI_SAVE_PASS_NAME
      ? {...boundary, before: captureProjectVerificationSnapshot(mismatchedSource)}
      : boundary);

    const report = verifyPostTransform(fixture.source, fixture.transformed, {
      ...fixture.options,
      passTrace
    });

    expect(report.failures.map(finding => finding.code)).toContain('antisave-hat-coverage-invalid');
  });

  it.each([
    ['inverted condition', 'antisave-guard-procedure-invalid', (fixture: AntiSaveVerifierFixture) => {
      const procedure = requiredAntiSaveProcedure(fixture.manifest, 0);
      requiredFixtureBlock(
        requiredFixtureTarget(fixture.transformed, procedure.targetIndex).blocks[procedure.notId],
        procedure.notId
      ).opcode = 'operator_or';
    }],
    ['detached division', 'antisave-guard-procedure-invalid', (fixture: AntiSaveVerifierFixture) => {
      const procedure = requiredAntiSaveProcedure(fixture.manifest, 0);
      requiredFixtureBlock(
        requiredFixtureTarget(fixture.transformed, procedure.targetIndex).blocks[procedure.lessThanId],
        procedure.lessThanId
      ).inputs['OPERAND1'] = [1, [4, '1']];
    }],
    ['wrong-target procedure', 'antisave-hat-guard-invalid', (fixture: AntiSaveVerifierFixture) => {
      const site = fixture.manifest.hatGuards.find(value => value.targetIndex !== fixture.manifest.stageTargetIndex);
      const stageProcedure = fixture.manifest.procedures.find(
        value => value.targetIndex === fixture.manifest.stageTargetIndex
      );
      if (!site || !stageProcedure) throw new Error('cross-target anti-save fixture is unavailable');
      const call = requiredFixtureBlock(
        requiredFixtureTarget(fixture.transformed, site.targetIndex).blocks[site.callId],
        site.callId
      );
      if (!call.mutation) throw new Error('anti-save call mutation is unavailable');
      call.mutation['proccode'] = stageProcedure.procedureCode;
    }],
    ['wrong procedure code', 'antisave-hat-guard-invalid', (fixture: AntiSaveVerifierFixture) => {
      const site = requiredAntiSaveHatGuard(fixture.manifest, 0);
      const call = requiredFixtureBlock(
        requiredFixtureTarget(fixture.transformed, site.targetIndex).blocks[site.callId],
        site.callId
      );
      if (!call.mutation) throw new Error('anti-save call mutation is unavailable');
      call.mutation['proccode'] = 'missing anti-save procedure';
    }],
    ['missing one hat call', 'antisave-hat-guard-invalid', (fixture: AntiSaveVerifierFixture) => {
      const site = requiredAntiSaveHatGuard(fixture.manifest, 0);
      const target = requiredFixtureTarget(fixture.transformed, site.targetIndex);
      const hat = requiredFixtureBlock(target.blocks[site.hatId], site.hatId);
      delete target.blocks[site.callId];
      hat.next = site.originalNext;
      if (site.originalNext !== null) {
        requiredFixtureBlock(target.blocks[site.originalNext], site.originalNext).parent = site.hatId;
      }
    }],
    ['detached original successor', 'antisave-original-successor-invalid', (fixture: AntiSaveVerifierFixture) => {
      const site = fixture.manifest.hatGuards.find(value => value.originalNext !== null);
      if (!site || site.originalNext === null) throw new Error('anti-save successor fixture is unavailable');
      requiredFixtureBlock(
        requiredFixtureTarget(fixture.transformed, site.targetIndex).blocks[site.originalNext],
        site.originalNext
      ).parent = site.hatId;
    }]
  ] as const)('rejects an antisave manifest mutation: %s', (_name, expectedCode, mutate) => {
    const fixture = antiSaveVerifierFixture(false);
    mutate(fixture);

    const report = verifyPostTransform(fixture.source, fixture.transformed, fixture.options);

    expect(report.failures.map(finding => finding.code)).toContain(expectedCode);
  });

  it('requires anti-cheat to wrap, rather than bypass, every anti-save entry call', () => {
    const accepted = antiSaveVerifierFixture(true);
    expect(verifyPostTransform(accepted.source, accepted.transformed, accepted.options).failures).toEqual([]);
    const site = requiredAntiSaveHatGuard(accepted.manifest, 0);
    const target = requiredFixtureTarget(accepted.transformed, site.targetIndex);
    const hat = requiredFixtureBlock(target.blocks[site.hatId], site.hatId);
    if (typeof hat.next !== 'string') throw new Error('anti-cheat wrapper is unavailable');
    const wrapper = requiredFixtureBlock(target.blocks[hat.next], hat.next);
    wrapper.next = site.originalNext;

    const rejected = verifyPostTransform(accepted.source, accepted.transformed, accepted.options);
    expect(rejected.failures.map(finding => finding.code))
      .toContain('antisave-anticheat-wrapper-order-invalid');
  });

  it('rejects an anti-save manifest when anti-save is disabled', () => {
    const fixture = antiSaveVerifierFixture(false);
    const report = verifyPostTransform(fixture.source, fixture.transformed, {
      mode: 'lossless',
      antiSaveManifest: fixture.manifest
    });

    expect(report.failures.map(finding => finding.code)).toContain('antisave-manifest-unexpected');
  });

  it('rejects anti-save stats that disagree with the trusted canary manifest', () => {
    const fixture = antiSaveVerifierFixture(false);
    const fixtureStats = fixture.options.stats;
    if (!fixtureStats) throw new Error('anti-save verifier stats are unavailable');
    const report = verifyPostTransform(fixture.source, fixture.transformed, {
      ...fixture.options,
      stats: {...fixtureStats, antiSaveCanaries: fixture.manifest.canaryCount + 1}
    });

    expect(report.failures.map(finding => finding.code)).toContain('antisave-canary-stats-mismatch');
  });

  it('proves the supported static lossless invariants while stating its limits', () => {
    const source = createFixtureProject();
    const transformed = obfuscateProject(source, 'lossless', seed(1));

    const report = verifyPostTransform(source, transformed.project, {
      mode: 'lossless',
      stats: transformed.stats
    });

    expect(report.verdict).toBe('verified-with-caveats');
    expect(report.failures).toEqual([]);
    expect(report.provenInvariants).toEqual(expect.arrayContaining([
      'lossless-active-executable-topology-isomorphic',
      'lossless-normalized-executable-values-preserved',
      'monitor-runtime-configuration-preserved',
      'single-required-watermark-present',
      'transformed-project-schema-and-reference-validity'
    ]));
    expect(report.caveats.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'archive-payload-bytes-out-of-scope',
      'pass-attribution-unavailable',
      'runtime-equivalence-not-proven',
      'visual-equivalence-not-proven',
      'wall-clock-equality-not-proven'
    ]));
  });

  it('fails a valid lossless executable opcode change', () => {
    const source = createFixtureProject();
    const transformed = obfuscateProject(source, 'lossless', seed(2)).project;
    const show = Object.values(transformed.targets[0]?.blocks ?? {})
      .find(value => isScratchBlock(value) && value.opcode === 'looks_show');
    if (!isScratchBlock(show)) throw new Error('fixture show block was not found');
    show.opcode = 'looks_hide';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.verdict).toBe('failed');
    expect(report.failures.map(finding => finding.code)).toContain('lossless-executable-topology-changed');
  });

  it('reports invalid source and transformed projects without suppressing static findings', () => {
    const source = createFixtureProject();
    source.targets = [];
    const validSource = createFixtureProject();
    const validOutput = watermarkedClone(validSource, 23);
    const invalidOutput = watermarkedClone(validSource, 24);
    invalidOutput.extensions = ['unsupported-extension'];

    const sourceReport = verifyPostTransform(source, validOutput, {mode: 'lossy'});
    const outputReport = verifyPostTransform(validSource, invalidOutput, {mode: 'lossy'});

    expect(sourceReport.failures).toContainEqual(expect.objectContaining({
      code: 'source-project-invalid',
      message: expect.stringContaining('source project validation failed') as string
    }));
    expect(outputReport.failures).toContainEqual(expect.objectContaining({
      code: 'transformed-project-invalid',
      message: expect.stringContaining('unsupported extension') as string
    }));
    expect(outputReport.provenInvariants).not.toContain('transformed-project-schema-and-reference-validity');
  });

  it('reports immutable identity and metadata changes plus a missing Stage watermark', () => {
    const source = createFixtureProject();
    const transformed = structuredClone(source);
    const sprite = transformed.targets[1];
    if (!sprite) throw new Error('fixture sprite was not found');
    sprite.name = 'Renamed Sprite';
    transformed.meta['agent'] = 'mutated metadata';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'target-order-or-identity-changed',
      'runtime-metadata-changed',
      'watermark-cardinality-invalid'
    ]));
    expect(report.transformed.stageWatermarkCount).toBe(0);
  });

  it('fails lossless initial-state changes that do not alter the block graph', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 11);
    const declaration = transformed.targets[0]?.variables['global_score'];
    if (!declaration) throw new Error('fixture variable was not found');
    declaration[1] = 1_000_000;

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toContain('lossless-declaration-state-changed');
  });

  it('preserves cloud declarations in topology-changing modes', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 12);
    const cloud = transformed.targets[0]?.variables['cloud_value'];
    if (!cloud) throw new Error('fixture cloud variable was not found');
    cloud[0] = 'renamed cloud state';

    const report = verifyPostTransform(source, transformed, {mode: 'no-preserve'});

    expect(report.failures.map(finding => finding.code)).toContain('cloud-variable-state-changed');
  });

  it('detects changes to a reused Stage watermark value', () => {
    const source = createFixtureProject();
    const stage = source.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    stage.variables['existing_watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'original'];
    const transformed = structuredClone(source);
    const watermark = transformed.targets[0]?.variables['existing_watermark'];
    if (!watermark) throw new Error('fixture watermark was not found');
    watermark[1] = 'changed';

    const report = verifyPostTransform(source, transformed, {mode: 'lossy'});

    expect(report.failures.map(finding => finding.code)).toContain('existing-watermark-value-changed');
  });

  it('fails changes to costume or sound descriptors in every mode', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 3);
    const costume = transformed.targets[0]?.costumes[0];
    if (!costume) throw new Error('fixture costume was not found');
    costume['name'] = 'changed costume';

    for (const mode of ['lossless', 'lossy', 'no-preserve'] as const) {
      const report = verifyPostTransform(source, transformed, {mode});
      expect(report.failures.map(finding => finding.code)).toContain('asset-descriptors-changed');
    }
  });

  it('accepts optimizer removal of a recoverable stale invisible monitor', () => {
    const source = createFixtureProject();
    source.monitors.push(dataMonitor('missing', 'Deleted Sprite', false));
    const transformed = structuredClone(source);
    const optimization = applySafeOptimizations(transformed, {foldConstants: false});
    applyWatermarkTransform(transformed, new DeterministicGenerator(seed(4), 'test-watermark'));

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(optimization.staleInvisibleMonitorsRemoved).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.provenInvariants).toContain(
      'monitor-runtime-configuration-preserved-after-stale-invisible-monitor-removal'
    );
    expect(report.source.staleInvisibleMonitorCount).toBe(1);
    expect(report.transformed.staleInvisibleMonitorCount).toBe(0);
  });

  it('rejects a recoverable stale invisible monitor that survives the transform', () => {
    const source = createFixtureProject();
    source.monitors.push(dataMonitor('missing', 'Deleted Sprite', false));
    const transformed = watermarkedClone(source, 25);

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'transformed-project-invalid',
      'stale-invisible-monitor-retained'
    ]));
    expect(report.transformed.staleInvisibleMonitorCount).toBe(1);
  });

  it('still rejects removal or mutation of a real monitor', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 5);
    const monitor = transformed.monitors[0];
    if (!monitor) throw new Error('fixture monitor was not found');
    monitor['x'] = 999;

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toContain('monitor-runtime-configuration-changed');
  });

  it('preserves monitor lineage when aggressive packing shifts declaration ordinals', () => {
    const source = createFixtureProject();
    const stage = source.targets[0];
    const writer = stage?.blocks['set_score'];
    if (!stage || !isScratchBlock(writer)) throw new Error('fixture Stage writer was not found');
    stage.variables = {
      packable_value: ['Packable value', 7],
      ...stage.variables
    };
    writer.fields['VARIABLE'] = ['Packable value', 'packable_value'];

    const transformed = obfuscateProject(source, 'no-preserve', seed(0x47));
    const transformedStage = transformed.project.targets.find(target => target.isStage);
    const monitor = transformed.project.monitors[0];
    if (!transformedStage || !monitor) throw new Error('transformed monitor fixture was not found');
    const monitorId = monitor['id'];
    const params = monitor['params'];
    if (typeof monitorId !== 'string' || !isJsonRecord(params)) {
      throw new Error('transformed monitor binding was not canonical');
    }
    const declaration = transformedStage.variables[monitorId];

    expect(transformed.stats.variablesVirtualized).toBeGreaterThan(0);
    expect(transformed.stats.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Static verification rejected')
    ]));
    expect(declaration?.[0]).toBe(params['VARIABLE']);
    expect(transformed.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
  });

  it('rejects bound declaration mutation inside an otherwise monitor-opaque aggressive pass', () => {
    const source = watermarkedClone(createFixtureProject(), 0x48);
    const transformed = structuredClone(source);
    const declaration = transformed.targets[0]?.variables['global_score'];
    if (!declaration) throw new Error('monitored declaration fixture was not found');
    declaration[1] = 999;
    const before = captureProjectVerificationSnapshot(source);
    const after = captureProjectVerificationSnapshot(transformed);

    const report = verifyPostTransform(source, transformed, {
      mode: 'no-preserve',
      passTrace: [{
        pass: 'aggressive-structural-hardening',
        before,
        after,
        allowedChanges: [
          'symbols',
          'identifiers',
          'executable-topology',
          'executable-values',
          'serialized-block-data',
          'comments-layout'
        ]
      }]
    });

    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'monitor-pass-lineage-changed',
      pass: 'aggressive-structural-hardening'
    }));
  });

  it('resolves sensing monitors through params.OBJECT and the selected target first scalar declaration', () => {
    const source = createFixtureProject();
    source.monitors.push({
      ...sensingMonitor('Readable score'),
      id: 'sprite-score-sensing',
      params: {PROPERTY: 'Readable score', OBJECT: 'Visible Sprite'}
    });

    for (const [mode, extra] of [['lossless', false], ['no-preserve', true]] as const) {
      const result = obfuscateProject(source, mode, seed(extra ? 0x4a : 0x49), {extra});
      expect(result.stats.warnings).not.toEqual(expect.arrayContaining([
        expect.stringContaining('Static verification rejected')
      ]));
      expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    }

    const numericSelector = createFixtureProject();
    requiredFixtureTarget(numericSelector, 1).name = '7';
    numericSelector.monitors.push({
      ...sensingMonitor('Readable score'),
      id: 'numeric-sprite-score-sensing',
      params: {PROPERTY: 'Readable score', OBJECT: 7}
    });
    for (const extra of [false, true]) {
      const result = obfuscateProject(numericSelector, 'lossless', seed(extra ? 0x4f : 0x4e), {extra});
      expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    }
  });

  it('tracks only the selected sensing target first scalar declaration and respects target-native properties', () => {
    const source = createFixtureProject();
    const stage = requiredFixtureTarget(source, 0);
    const sprite = requiredFixtureTarget(source, 1);
    stage.variables['stage_observed'] = ['Observed', 10];
    sprite.variables['first_observed'] = ['Observed', 20];
    sprite.variables['second_observed'] = ['Observed', 30];
    sprite.lists['observed_list'] = ['Observed', [40]];
    source.monitors = [{
      ...sensingMonitor('Observed'),
      params: {PROPERTY: 'Observed', OBJECT: sprite.name}
    }];
    const baseline = captureProjectVerificationSnapshot(source).monitorDeclarationDigest;

    const secondChanged = structuredClone(source);
    const secondDeclaration = requiredFixtureTarget(secondChanged, 1).variables['second_observed'];
    if (!secondDeclaration) throw new Error('second observed declaration was not found');
    secondDeclaration[1] = 31;
    expect(captureProjectVerificationSnapshot(secondChanged).monitorDeclarationDigest).toBe(baseline);
    const unrelatedChanged = structuredClone(source);
    const stageDeclaration = requiredFixtureTarget(unrelatedChanged, 0).variables['stage_observed'];
    const observedList = requiredFixtureTarget(unrelatedChanged, 1).lists['observed_list'];
    if (!stageDeclaration || !observedList) throw new Error('unrelated observed declarations were not found');
    stageDeclaration[1] = 11;
    observedList[1] = [41];
    expect(captureProjectVerificationSnapshot(unrelatedChanged).monitorDeclarationDigest).toBe(baseline);
    const firstChanged = structuredClone(source);
    const firstDeclaration = requiredFixtureTarget(firstChanged, 1).variables['first_observed'];
    if (!firstDeclaration) throw new Error('first observed declaration was not found');
    firstDeclaration[1] = 21;
    expect(captureProjectVerificationSnapshot(firstChanged).monitorDeclarationDigest).not.toBe(baseline);

    const spriteNative = structuredClone(source);
    requiredFixtureTarget(spriteNative, 1).variables['native_collision'] = ['x position', 1];
    spriteNative.monitors = [{
      ...sensingMonitor('x position'),
      params: {PROPERTY: 'x position', OBJECT: sprite.name}
    }];
    const nativeBaseline = captureProjectVerificationSnapshot(spriteNative).monitorDeclarationDigest;
    const nativeCollision = requiredFixtureTarget(spriteNative, 1).variables['native_collision'];
    if (!nativeCollision) throw new Error('native collision declaration was not found');
    nativeCollision[1] = 2;
    expect(captureProjectVerificationSnapshot(spriteNative).monitorDeclarationDigest).toBe(nativeBaseline);

    const stageScalar = structuredClone(source);
    requiredFixtureTarget(stageScalar, 0).variables['stage_x'] = ['x position', 1];
    stageScalar.monitors = [sensingMonitor('x position')];
    const scalarBaseline = captureProjectVerificationSnapshot(stageScalar).monitorDeclarationDigest;
    const stageScalarDeclaration = requiredFixtureTarget(stageScalar, 0).variables['stage_x'];
    if (!stageScalarDeclaration) throw new Error('Stage scalar sensing declaration was not found');
    stageScalarDeclaration[1] = 2;
    expect(captureProjectVerificationSnapshot(stageScalar).monitorDeclarationDigest).not.toBe(scalarBaseline);
  });

  it.each([
    ['identifier-and-metadata-remapping', [
      'symbols',
      'identifiers',
      'executable-values',
      'serialized-block-data',
      'comments-layout',
      'monitors'
    ]],
    [EXTRA_PRIVACY_PASS_NAME, EXTRA_PRIVACY_ALLOWED_CHANGES]
  ] as const)('rejects monitored state mutation in the %s pass', (pass, allowedChanges) => {
    const source = watermarkedClone(createFixtureProject(), 0x4b);
    const transformed = structuredClone(source);
    const declaration = requiredFixtureTarget(transformed, 0).variables['global_score'];
    if (!declaration) throw new Error('monitored declaration fixture was not found');
    declaration[1] = 999;
    const before = captureProjectVerificationSnapshot(source);
    const after = captureProjectVerificationSnapshot(transformed);

    const report = verifyPostTransform(source, transformed, {
      mode: 'no-preserve',
      extra: pass === EXTRA_PRIVACY_PASS_NAME,
      passTrace: [{pass, before, after, allowedChanges}]
    });

    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'monitor-pass-lineage-changed',
      pass
    }));
  });

  it('requires trusted pass lineage for topology-changing monitor verification', () => {
    const source = watermarkedClone(createFixtureProject(), 0x4c);
    const report = verifyPostTransform(source, structuredClone(source), {mode: 'no-preserve'});

    expect(report.failures).toContainEqual(expect.objectContaining({code: 'monitor-pass-lineage-missing'}));
  });

  it('does not canonicalize away missing or corrupt monitor parameters', () => {
    const source = createFixtureProject();
    const missing = watermarkedClone(source, 16);
    const corrupt = watermarkedClone(source, 17);
    const missingParams = missing.monitors[0]?.['params'];
    const corruptParams = corrupt.monitors[0]?.['params'];
    if (!isJsonRecord(missingParams) || !isJsonRecord(corruptParams)) {
      throw new Error('fixture monitor params were not found');
    }
    delete missingParams['VARIABLE'];
    corruptParams['VARIABLE'] = 'wrong display';

    expect(verifyPostTransform(source, missing, {mode: 'lossless'}).failures
      .map(finding => finding.code)).toContain('monitor-runtime-configuration-changed');
    expect(verifyPostTransform(source, corrupt, {mode: 'lossless'}).failures
      .map(finding => finding.code)).toContain('typed-reference-display-inconsistent');
  });

  it('does not canonicalize away typed field display corruption', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 18);
    const setVariable = transformed.targets[0]?.blocks['set_score'];
    if (!isScratchBlock(setVariable)) throw new Error('fixture variable writer was not found');
    setVariable.fields['VARIABLE'] = ['wrong display', 'global_score'];

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toContain('typed-reference-display-inconsistent');
  });

  it('requires one Stage watermark while permitting an identically named sprite variable', () => {
    const source = createFixtureProject();
    const sprite = source.targets[1];
    if (!sprite) throw new Error('fixture sprite was not found');
    sprite.variables['unrelated_local_watermark'] = [ANTI_CHEAT_WATERMARK_NAME, 'leave me'];
    const transformed = watermarkedClone(source, 6);

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).not.toContain('watermark-cardinality-invalid');
    expect(report.transformed.stageWatermarkCount).toBe(1);
    expect(spriteWatermarks(transformed)).toHaveLength(1);
  });

  it('treats only the first duplicate Stage watermark as the watermark declaration', () => {
    const source = createFixtureProject();
    const stage = source.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    stage.variables['watermark_first'] = [ANTI_CHEAT_WATERMARK_NAME, 'first'];
    stage.variables['watermark_lookalike'] = [ANTI_CHEAT_WATERMARK_NAME, 'second'];
    const transformed = obfuscateProject(source, 'lossless', seed(19)).project;

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures).toEqual([]);
    expect(report.transformed.stageWatermarkCount).toBe(1);
    expect(Object.values(transformed.targets[0]?.variables ?? {})
      .some(declaration => declaration[1] === 'second' && declaration[0] !== ANTI_CHEAT_WATERMARK_NAME)).toBe(true);
  });

  it('normalizes repeated procedure argument names within their owning procedure', () => {
    const source = procedureArgumentFixture();
    const transformed = obfuscateProject(source, 'lossless', seed(20));

    const report = verifyPostTransform(source, transformed.project, {mode: 'lossless'});

    expect(report.failures).toEqual([]);
  });

  it('detects removal of a pinned official extension hat in topology-changing modes', () => {
    const source = createFixtureProject();
    const sprite = source.targets[1];
    if (!sprite) throw new Error('fixture sprite was not found');
    source.extensions.push('videoSensing');
    sprite.blocks['extension_hat'] = {
      opcode: 'videoSensing_whenMotionGreaterThan',
      next: null,
      parent: null,
      inputs: {REFERENCE: [1, [4, '10']]},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0
    };
    const transformed = watermarkedClone(source, 7);
    delete (transformed.targets[1] as typeof sprite).blocks['extension_hat'];

    const report = verifyPostTransform(source, transformed, {mode: 'no-preserve'});

    expect(report.source.nativeHatCounts['videoSensing_whenMotionGreaterThan']).toBe(1);
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'native-hat-trigger-decreased',
      message: expect.stringContaining('videoSensing_whenMotionGreaterThan') as string
    }));
  });

  it('inventories all pinned official extension hats', () => {
    const project = createFixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture sprite was not found');
    for (const [index, opcode] of OFFICIAL_EXTENSION_HATS.entries()) {
      sprite.blocks[`extension_hat_${index}`] = {
        opcode,
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: index,
        y: 0
      };
    }

    const snapshot = captureProjectVerificationSnapshot(project);

    expect(Object.fromEntries(OFFICIAL_EXTENSION_HATS.map(opcode => [opcode, snapshot.nativeHatCounts[opcode]])))
      .toEqual(Object.fromEntries(OFFICIAL_EXTENSION_HATS.map(opcode => [opcode, 1])));
  });

  it('detects native-hat trigger changes even when opcode counts are unchanged', () => {
    const source = createFixtureProject();
    const stage = source.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    stage.broadcasts['other_broadcast'] = 'other';
    const transformed = watermarkedClone(source, 13);
    const receive = transformed.targets[1]?.blocks['receive_script'];
    if (!isScratchBlock(receive)) throw new Error('fixture receive hat was not found');
    receive.fields['BROADCAST_OPTION'] = ['other', 'other_broadcast'];

    const report = verifyPostTransform(source, transformed, {mode: 'lossy'});

    expect(report.source.nativeHatCounts).toEqual(report.transformed.nativeHatCounts);
    expect(report.failures.map(finding => finding.code)).toContain('native-hat-trigger-decreased');
  });

  it('enforces the source-derived aggressive growth cap', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 14);
    const stage = transformed.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    for (let index = 0; index < 100; index += 1) {
      stage.blocks[`extra_${index}`] = {
        opcode: 'looks_show',
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: index,
        y: 0
      };
    }

    const report = verifyPostTransform(source, transformed, {mode: 'lossy'});

    expect(report.failures.map(finding => finding.code)).toContain('aggressive-growth-cap-exceeded');
  });

  it('uses compact growth limits unless expanded growth is explicitly allowed', () => {
    const source = createFixtureProject();
    const initial = captureProjectVerificationSnapshot(source).blockEquivalents;
    const transformed = watermarkedClone(source, 36);
    const stage = transformed.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    for (let index = 0; index <= initial; index += 1) {
      stage.blocks[`expanded_${index}`] = {
        opcode: 'looks_show',
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: index,
        y: 0
      };
    }

    const compact = verifyPostTransform(source, transformed, {mode: 'lossy'});
    const expanded = verifyPostTransform(source, transformed, {mode: 'lossy', allowSize: true});

    expect(compact.failures.map(finding => finding.code)).toContain('aggressive-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('aggressive-growth-cap-exceeded');
  });

  it('prevents generated list payloads from bypassing compact growth accounting', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 38);
    const stage = transformed.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    stage.lists['oversized_generated_table'] = [
      'generated table',
      ['x'.repeat(700_000)]
    ];

    const compact = verifyPostTransform(source, transformed, {mode: 'lossy'});
    const expanded = verifyPostTransform(source, transformed, {mode: 'lossy', allowSize: true});

    expect(compact.failures.map(finding => finding.code)).toContain('compact-serialized-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('compact-serialized-growth-cap-exceeded');
    expect(expanded.provenInvariants).toContain('transformed-json-safety-cap-respected');
    expect(expanded.caveats.map(finding => finding.code)).toContain('expanded-serialized-growth-enabled');
  });

  it('checks the selected aggressive cap at the trusted pre-anti-cheat boundary', () => {
    const source = createFixtureProject();
    const initial = captureProjectVerificationSnapshot(source).blockEquivalents;
    const preAntiCheat = watermarkedClone(source, 37);
    const stage = preAntiCheat.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    for (let index = 0; index <= initial; index += 1) {
      stage.blocks[`expanded_${index}`] = {
        opcode: 'looks_show',
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: index,
        y: 0
      };
    }
    const transformed = structuredClone(preAntiCheat);
    const sourceSnapshot = captureProjectVerificationSnapshot(source);
    const preAntiCheatSnapshot = captureProjectVerificationSnapshot(preAntiCheat);
    const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
    const structuralChanges = [
      'symbols',
      'identifiers',
      'executable-topology',
      'executable-values',
      'serialized-block-data',
      'comments-layout'
    ] as const;
    const passTrace = [
      {
        pass: 'aggressive-structural-hardening',
        before: sourceSnapshot,
        after: preAntiCheatSnapshot,
        allowedChanges: structuralChanges
      },
      {
        pass: 'anti-cheat-instrumentation',
        before: preAntiCheatSnapshot,
        after: transformedSnapshot,
        allowedChanges: structuralChanges
      }
    ] as const;

    const compact = verifyPostTransform(source, transformed, {mode: 'lossy', antiCheat: true, passTrace});
    const expanded = verifyPostTransform(source, transformed, {
      mode: 'lossy', antiCheat: true, allowSize: true, passTrace
    });

    expect(compact.failures.map(finding => finding.code)).toContain('aggressive-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('aggressive-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('anticheat-growth-checkpoint-missing');
    expect(expanded.provenInvariants).toContain('aggressive-growth-cap-verified-before-anticheat-instrumentation');
    expect(expanded.caveats.map(finding => finding.code)).toContain('anticheat-growth-outside-aggressive-cap');
  });

  it('bounds compact anti-cheat serialized growth after its trusted checkpoint', () => {
    const source = createFixtureProject();
    const preAntiCheat = watermarkedClone(source, 39);
    const transformed = structuredClone(preAntiCheat);
    const stage = transformed.targets[0];
    if (!stage) throw new Error('fixture Stage was not found');
    stage.lists['oversized_anticheat_payload'] = [
      'oversized anti-cheat payload',
      ['x'.repeat((2 * 1024 * 1024) + 1)]
    ];
    const sourceSnapshot = captureProjectVerificationSnapshot(source);
    const preAntiCheatSnapshot = captureProjectVerificationSnapshot(preAntiCheat);
    const blockLimit = Math.max(
      4096,
      Math.min((preAntiCheatSnapshot.blockEquivalents * 8) + 4096, 30_000)
    );
    for (let index = 0; index <= blockLimit; index += 1) {
      stage.blocks[`oversized_anticheat_block_${index}`] = {
        opcode: 'looks_show',
        next: null,
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: index,
        y: 0
      };
    }
    const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
    const structuralChanges = [
      'symbols',
      'identifiers',
      'executable-topology',
      'executable-values',
      'serialized-block-data',
      'comments-layout'
    ] as const;
    const passTrace = [
      {
        pass: 'aggressive-structural-hardening',
        before: sourceSnapshot,
        after: preAntiCheatSnapshot,
        allowedChanges: structuralChanges
      },
      {
        pass: 'anti-cheat-instrumentation',
        before: preAntiCheatSnapshot,
        after: transformedSnapshot,
        allowedChanges: structuralChanges
      }
    ] as const;

    const compact = verifyPostTransform(source, transformed, {mode: 'lossy', antiCheat: true, passTrace});
    const expanded = verifyPostTransform(source, transformed, {
      mode: 'lossy', antiCheat: true, allowSize: true, passTrace
    });

    expect(compact.failures.map(finding => finding.code)).toContain('anticheat-block-growth-cap-exceeded');
    expect(compact.failures.map(finding => finding.code)).toContain('anticheat-serialized-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('anticheat-block-growth-cap-exceeded');
    expect(expanded.failures.map(finding => finding.code)).not.toContain('anticheat-serialized-growth-cap-exceeded');
    expect(expanded.provenInvariants).toContain('transformed-json-safety-cap-respected');
  });

  it('rejects negative anti-cheat growth even when allow-size waives upper caps', () => {
    const source = createFixtureProject();
    const preAntiCheat = watermarkedClone(source, 45);
    const preStage = preAntiCheat.targets[0];
    if (!preStage) throw new Error('fixture Stage was not found');
    preStage.lists['trusted_checkpoint_state'] = ['trusted checkpoint state', ['sentinel']];
    const transformed = watermarkedClone(source, 45);
    const sourceSnapshot = captureProjectVerificationSnapshot(source);
    const preAntiCheatSnapshot = captureProjectVerificationSnapshot(preAntiCheat);
    const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
    const structuralChanges = [
      'symbols',
      'identifiers',
      'executable-topology',
      'executable-values',
      'serialized-block-data',
      'comments-layout'
    ] as const;
    const passTrace = [
      {
        pass: 'aggressive-structural-hardening',
        before: sourceSnapshot,
        after: preAntiCheatSnapshot,
        allowedChanges: structuralChanges
      },
      {
        pass: 'anti-cheat-instrumentation',
        before: preAntiCheatSnapshot,
        after: transformedSnapshot,
        allowedChanges: structuralChanges
      }
    ] as const;

    const report = verifyPostTransform(source, transformed, {
      mode: 'lossy', antiCheat: true, allowSize: true, passTrace
    });

    expect(report.failures.map(finding => finding.code)).toContain('anticheat-growth-accounting-invalid');
    expect(report.provenInvariants).not.toContain('anticheat-additive-growth-accounting-valid');
  });

  it('rejects lossless active-block and declaration-count additions', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 26);
    const stage = transformed.targets[0];
    const tail = stage?.blocks['broadcast_message'];
    if (!stage || !isScratchBlock(tail)) throw new Error('fixture Stage tail was not found');
    tail.next = 'unexpected_active_block';
    stage.blocks['unexpected_active_block'] = block('looks_show', null, 'broadcast_message');
    stage.variables['extra_variable_a'] = ['extra a', 1];
    stage.variables['extra_variable_b'] = ['extra b', 2];
    stage.lists['extra_list'] = ['extra list', []];
    stage.broadcasts['extra_broadcast'] = 'extra broadcast';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});

    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'lossless-executable-block-count-changed',
      'lossless-declaration-count-changed',
      'lossless-variable-count-changed'
    ]));
  });

  it('attributes changes to continuous pass boundaries with a fixed allowlist', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 8);
    const before = captureProjectVerificationSnapshot(source);
    const after = captureProjectVerificationSnapshot(transformed);
    const changes = changedVerificationCategories(before, after);

    const accepted = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{pass: 'watermark', before, after, allowedChanges: ['symbols', 'identifiers']}]
    });
    const rejected = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{pass: 'watermark', before, after, allowedChanges: ['symbols']}]
    });

    expect(changes).toEqual(['symbols', 'identifiers']);
    expect(accepted.failures).toEqual([]);
    expect(accepted.passAttributions).toEqual([expect.objectContaining({
      pass: 'watermark',
      changes: ['symbols', 'identifiers'],
      unexpectedChanges: [],
      continuous: true
    })]);
    expect(rejected.failures).toContainEqual(expect.objectContaining({code: 'pass-policy-forged', pass: 'watermark'}));
  });

  it('uses internal pass policies and rejects unknown pass names and caller-forged allowances', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 27);
    const before = captureProjectVerificationSnapshot(source);
    const after = captureProjectVerificationSnapshot(transformed);

    const unknown = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{
        pass: 'invented-pass',
        before,
        after,
        allowedChanges: ['symbols', 'identifiers']
      }]
    });
    const forged = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{
        pass: 'watermark',
        before,
        after,
        allowedChanges: ['symbols', 'identifiers', 'runtime-metadata']
      }]
    });

    expect(unknown.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'pass-policy-unknown',
      'pass-change-outside-declared-policy'
    ]));
    expect(forged.failures.map(finding => finding.code)).toContain('pass-policy-forged');
    expect(forged.passAttributions[0]?.unexpectedChanges).toEqual([]);
  });

  it('rejects discontinuous pass traces and traces that do not reach the output', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 21);
    const sourceSnapshot = captureProjectVerificationSnapshot(source);
    const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
    const unrelated = createFixtureProject();
    unrelated.meta['agent'] = 'unrelated-boundary';
    const unrelatedSnapshot = captureProjectVerificationSnapshot(unrelated);

    const discontinuous = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{
        pass: 'watermark',
        before: unrelatedSnapshot,
        after: transformedSnapshot,
        allowedChanges: ['symbols', 'identifiers', 'runtime-metadata']
      }]
    });
    const incomplete = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{pass: 'no-op', before: sourceSnapshot, after: sourceSnapshot, allowedChanges: []}]
    });

    expect(discontinuous.failures.map(finding => finding.code)).toContain('pass-trace-discontinuous');
    expect(incomplete.failures.map(finding => finding.code)).toContain('pass-trace-does-not-reach-output');
  });

  it('reports stats that disagree with snapshot block counts', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', seed(9));
    const report = verifyPostTransform(source, result.project, {
      mode: 'lossless',
      stats: {...result.stats, blocksAfter: result.stats.blocksAfter + 1}
    });

    expect(report.failures.map(finding => finding.code)).toContain('stats-output-block-count-mismatch');
  });

  it('rejects mismatched modes, input counts, and invalid aggregate counters in stats', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', seed(28));
    const invalidStats: ObfuscationStats = {
      ...result.stats,
      mode: 'lossy',
      blocksBefore: result.stats.blocksBefore + 1,
      commentsRemoved: -1
    };

    const report = verifyPostTransform(source, result.project, {mode: 'lossless', stats: invalidStats});

    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'stats-mode-mismatch',
      'stats-input-block-count-mismatch',
      'stats-counter-invalid'
    ]));
  });

  it('checks anti-cheat decoy stats and fails closed without its aggressive growth checkpoint', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossy', seed(29), {antiCheat: true});
    const report = verifyPostTransform(source, result.project, {
      mode: 'lossy',
      antiCheat: true,
      stats: {...result.stats, antiCheatDecoys: 0}
    });

    expect(report.failures.map(finding => finding.code)).toContain('anticheat-decoy-count-mismatch');
    expect(report.failures.map(finding => finding.code)).toContain('anticheat-growth-checkpoint-missing');
  });

  it('marks anti-cheat topology additions and tamper semantics as explicit caveats', () => {
    const source = createFixtureProject();
    const losslessCore = obfuscateProject(source, 'lossless', seed(10));
    const transformed = obfuscateProject(source, 'lossless', seed(10), {antiCheat: true});

    const report = verifyPostTransform(source, transformed.project, {
      mode: 'lossless',
      antiCheat: true,
      stats: transformed.stats,
      losslessCoreSnapshot: captureProjectVerificationSnapshot(losslessCore.project)
    });

    expect(report.failures).toContainEqual(expect.objectContaining({code: 'monitor-pass-lineage-missing'}));
    expect(report.caveats.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'anti-cheat-tamper-path-intentionally-diverges',
      'anti-cheat-topology-additions-prevent-end-to-end-lossless-isomorphism'
    ]));
  });

  it('requires and checks the strict pre-anti-cheat lossless checkpoint', () => {
    const source = createFixtureProject();
    const baseline = watermarkedClone(source, 15);
    const transformed = structuredClone(baseline);
    for (const target of transformed.targets) {
      for (const [id, value] of Object.entries(target.blocks)) {
        if (isScratchBlock(value) && value.topLevel) value.next = null;
        else delete target.blocks[id];
      }
    }

    const missing = verifyPostTransform(source, transformed, {mode: 'lossless', antiCheat: true});
    const destructive = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      antiCheat: true,
      losslessCoreSnapshot: captureProjectVerificationSnapshot(baseline)
    });

    expect(missing.failures.map(finding => finding.code)).toContain('lossless-anticheat-core-checkpoint-missing');
    expect(destructive.failures.map(finding => finding.code)).toContain('anticheat-original-executable-node-missing');
  });

  it('does not accept an ordinary watermarked project as an anti-cheat output', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 22);

    const report = verifyPostTransform(source, transformed, {mode: 'lossy', antiCheat: true});

    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'anticheat-stats-missing',
      'anticheat-sentinel-surface-missing',
      'anticheat-trip-path-missing'
    ]));
  });

  it('normalizes static, dynamic, literal-shadow, and typed sensing selectors', () => {
    const source = sensingCanonicalizationFixture();
    const nameOnlySelector = structuredClone(source);
    const namedSprite = nameOnlySelector.targets[1];
    const nameOnlyReporter = namedSprite?.blocks['sense_broadcast_primitive_reporter'];
    const nameOnlyMenu = namedSprite?.blocks['sense_broadcast_menu_selector'];
    if (!namedSprite || !isScratchBlock(nameOnlyReporter) || !isScratchBlock(nameOnlyMenu)) {
      throw new Error('typed sensing selectors were not found');
    }
    nameOnlyReporter.inputs['OBJECT'] = [1, [11, namedSprite.name]];
    nameOnlyMenu.fields['BROADCAST_OPTION'] = [namedSprite.name, null];
    expect(captureProjectVerificationSnapshot(nameOnlySelector).executableValueDigest)
      .toBe(captureProjectVerificationSnapshot(source).executableValueDigest);

    const referencedPrimitive = structuredClone(source);
    const primitiveOwner = referencedPrimitive.targets[1];
    const primitiveReporter = primitiveOwner?.blocks['sense_broadcast_primitive_reporter'];
    if (!primitiveOwner || !isScratchBlock(primitiveReporter)) {
      throw new Error('primitive sensing selector was not found');
    }
    primitiveOwner.blocks['snapshot_only_primitive'] = [10, '_stage_'];
    primitiveReporter.inputs['OBJECT'] = [2, 'snapshot_only_primitive'];
    expect(captureProjectVerificationSnapshot(referencedPrimitive).executableValueDigest).toBeTypeOf('string');

    const unresolvedTypedSelector = structuredClone(source);
    const unresolvedReporter = unresolvedTypedSelector.targets[1]?.blocks['sense_broadcast_primitive_reporter'];
    if (!isScratchBlock(unresolvedReporter)) throw new Error('typed sensing selector was not found');
    unresolvedReporter.inputs['OBJECT'] = [1, [11, 'missing broadcast selector']];
    expect(captureProjectVerificationSnapshot(unresolvedTypedSelector).executableValueDigest).toBeTypeOf('string');

    const transformed = obfuscateProject(source, 'lossless', seed(30));

    const report = verifyPostTransform(source, transformed.project, {
      mode: 'lossless',
      stats: transformed.stats
    });

    expect(report.failures).toEqual([]);
    expect(report.source.executableTopologyDigest).toBe(report.transformed.executableTopologyDigest);
    expect(report.source.executableValueDigest).toBe(report.transformed.executableValueDigest);
  });

  it('normalizes sensing monitor properties through their resolved declarations', () => {
    const source = createFixtureProject();
    source.monitors = [sensingMonitor('Readable score')];
    const transformed = obfuscateProject(source, 'lossless', seed(31));

    const report = verifyPostTransform(source, transformed.project, {mode: 'lossless'});

    expect(report.failures).toEqual([]);
    expect(report.source.monitorRuntimeDigest).toBe(report.transformed.monitorRuntimeDigest);
  });

  it('canonicalizes sensing block native properties for the selected target only', () => {
    const source = sensingCanonicalizationFixture();
    const stage = requiredFixtureTarget(source, 0);
    const sprite = requiredFixtureTarget(source, 1);
    stage.variables['stage_x_property'] = ['x position', 41];
    sprite.variables['sprite_backdrop_property'] = ['background #', 42];
    const tail = requiredFixtureBlock(sprite.blocks['sense_watermark_name'], 'sense_watermark_name');
    tail.next = 'sense_stage_x_command';
    sprite.blocks['sense_stage_x_command'] = block(
      'data_addtolist',
      'sense_sprite_backdrop_command',
      'sense_watermark_name',
      {ITEM: [2, 'sense_stage_x_reporter']},
      {LIST: ['Readable list', 'global_list']}
    );
    sprite.blocks['sense_stage_x_reporter'] = block(
      'sensing_of',
      null,
      'sense_stage_x_command',
      {OBJECT: [1, [10, '_stage_']]},
      {PROPERTY: ['x position']}
    );
    sprite.blocks['sense_sprite_backdrop_command'] = block(
      'data_addtolist',
      null,
      'sense_stage_x_command',
      {ITEM: [2, 'sense_sprite_backdrop_reporter']},
      {LIST: ['Readable list', 'global_list']}
    );
    sprite.blocks['sense_sprite_backdrop_reporter'] = block(
      'sensing_of',
      null,
      'sense_sprite_backdrop_command',
      {OBJECT: [1, [10, sprite.name]]},
      {PROPERTY: ['background #']}
    );

    const result = obfuscateProject(source, 'lossless', seed(0x4d));
    const report = verifyPostTransform(source, result.project, {mode: 'lossless'});

    expect(report.failures).toEqual([]);
    expect(report.source.executableValueDigest).toBe(report.transformed.executableValueDigest);
  });

  it('classifies stale monitors conservatively across opcode, sprite, ID, and Stage evidence', () => {
    const project = createFixtureProject();
    project.monitors = [
      sensingMonitor('Readable score'),
      dataMonitor('local_score', 'Visible Sprite', false),
      dataMonitor('global_score', 'Deleted Sprite', false),
      {...dataMonitor('not-a-string', 'Deleted Sprite', false), id: 17},
      dataMonitor('actually_missing', 'Deleted Sprite', false)
    ];

    const snapshot = captureProjectVerificationSnapshot(project);
    const stageMissing = structuredClone(project);
    stageMissing.targets = stageMissing.targets.filter(target => !target.isStage);
    stageMissing.monitors = [dataMonitor('actually_missing', 'Deleted Sprite', false)];

    expect(snapshot.staleInvisibleMonitorCount).toBe(1);
    expect(snapshot.preservableMonitorCount).toBe(4);
    expect(captureProjectVerificationSnapshot(stageMissing).staleInvisibleMonitorCount).toBe(0);
  });

  it('detects typed primitive corruption and safely snapshots malformed serialized references', () => {
    const source = createFixtureProject();
    const transformed = watermarkedClone(source, 32);
    const writer = transformed.targets[0]?.blocks['set_score'];
    if (!isScratchBlock(writer)) throw new Error('fixture variable writer was not found');
    writer.inputs['VALUE'] = [1, [12, 'wrong display', 'global_score']];

    const report = verifyPostTransform(source, transformed, {mode: 'lossless'});
    expect(report.failures.map(finding => finding.code)).toContain('typed-reference-display-inconsistent');

    const malformed = createFixtureProject();
    const malformedStage = malformed.targets[0];
    const malformedWriter = malformedStage?.blocks['set_score'];
    if (!malformedStage || !isScratchBlock(malformedWriter)) throw new Error('fixture Stage writer was not found');
    malformedStage.blocks['primitive_by_id'] = [4, '42'];
    malformedStage.blocks['opaque_invalid_entry'] = [3, 'opaque'];
    malformedWriter.inputs['VALUE'] = [1, 'primitive_by_id'];
    const primitiveSnapshot = captureProjectVerificationSnapshot(malformed);
    malformedWriter.inputs['VALUE'] = [1, 'missing_block'];
    const missingSnapshot = captureProjectVerificationSnapshot(malformed);
    malformedWriter.inputs['VALUE'] = [1, null];
    const nullSnapshot = captureProjectVerificationSnapshot(malformed);

    expect(new Set([
      primitiveSnapshot.executableValueDigest,
      missingSnapshot.executableValueDigest,
      nullSnapshot.executableValueDigest
    ]).size).toBe(3);
    expect(primitiveSnapshot.serializedBlockDigest).not.toBe(missingSnapshot.serializedBlockDigest);
  });

  it('freezes malformed procedure metadata and preserves nested mutation shape deterministically', () => {
    const project = procedureArgumentFixture();
    const sprite = project.targets[1];
    const prototype = sprite?.blocks['prototype_a'];
    const body = sprite?.blocks['body_a'];
    if (!sprite || !isScratchBlock(prototype) || !isScratchBlock(body) || !prototype.mutation) {
      throw new Error('fixture procedure was not found');
    }
    prototype.mutation['argumentids'] = '[';
    prototype.mutation['argumentdefaults'] = '[';
    body.mutation = {custom: {nested: [1, true, 'shape']}};
    sprite.blocks['orphan_argument_reporter'] = {
      ...block('argument_reporter_string_number', null, null, {}, {VALUE: ['orphan', null]}),
      topLevel: true
    };

    const first = captureProjectVerificationSnapshot(project);
    const second = captureProjectVerificationSnapshot(structuredClone(project));

    expect(first.executableTopologyDigest).toBe(second.executableTopologyDigest);
    expect(first.executableValueDigest).toBe(second.executableValueDigest);
    expect(first.serializedBlockDigest).toBe(second.serializedBlockDigest);
  });

  it('snapshots malformed active entries, selector misses, and comment references without throwing', () => {
    const project = createFixtureProject();
    const stage = requiredFixtureTarget(project, 0);
    const sprite = requiredFixtureTarget(project, 1);
    const start = requiredFixtureBlock(stage.blocks['start_script'], 'start_script');
    const move = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
    start.comment = 'missing-comment';
    stage.comments['detached'] = {
      blockId: null, x: 0, y: 0, width: 20, height: 20, minimized: false, text: 'detached'
    };
    const writer = requiredFixtureBlock(stage.blocks['set_score'], 'set_score');
    writer.inputs['VALUE'] = [1, {malformed: true}];
    move.opcode = 'motion_goto';
    move.inputs = {};
    move.next = 'opaque-active-entry';
    sprite.blocks['opaque-active-entry'] = {opaque: true} as unknown as ScratchBlock;
    sprite.blocks['missing-selector-reference'] = {
      ...block('motion_pointtowards', null, null, {TOWARDS: [2, 'missing-reporter']}),
      topLevel: true,
      x: 500,
      y: 300
    };
    sprite.blocks['non-scalar-selector'] = {
      ...block('looks_switchcostumeto', null, null, {COSTUME: [1, [4, {malformed: true}]]}),
      topLevel: true,
      x: 500,
      y: 340
    };
    sprite.blocks['numeric-sound-selector'] = {
      ...block('sound_play', null, null, {SOUND_MENU: [1, [4, 2]]}),
      topLevel: true,
      x: 500,
      y: 380
    };

    const snapshot = captureProjectVerificationSnapshot(project);

    expect(snapshot.executableValueDigest).toBeTypeOf('string');
    expect(snapshot.extraExecutableValueDigest).toBeTypeOf('string');
    expect(snapshot.serializedBlockDigest).toBeTypeOf('string');
    expect(snapshot.commentsLayoutDigest).toBeTypeOf('string');
  });

  it('normalizes list and sensing monitor bindings while retaining malformed owner evidence', () => {
    const project = createFixtureProject();
    project.monitors = [
      {
        ...dataMonitor('global_list', 'Deleted Sprite', false),
        opcode: 'data_listcontents',
        params: {LIST: 'Readable list'},
        mode: 'list',
        value: []
      },
      {
        ...sensingMonitor('Readable score'),
        params: {PROPERTY: 'Readable score', OBJECT: 7},
        spriteName: 7
      },
      {
        ...dataMonitor('missing_list', 'Deleted Sprite', false),
        opcode: 'data_listcontents',
        params: {LIST: 'missing list'},
        mode: 'list',
        value: []
      },
      {id: 17, opcode: 'opaque_monitor', params: false, spriteName: '', visible: false}
    ];

    const snapshot = captureProjectVerificationSnapshot(project);

    expect(snapshot.staleInvisibleMonitorCount).toBe(1);
    expect(snapshot.preservableMonitorCount).toBe(3);
    expect(snapshot.monitorBindingDigest).toBeTypeOf('string');
    expect(snapshot.serializedMonitorDigest).toBeTypeOf('string');
  });

  it('accepts omitted optional stats counters and rejects a same-length duplicate pass policy', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', seed(102));
    const stats = {...result.stats} as Partial<ObfuscationStats>;
    delete stats.variablesVirtualized;
    delete stats.listsVirtualized;
    delete stats.constantsFolded;
    delete stats.inactiveFallbacksRemoved;
    delete stats.antiCheatDecoys;
    const statsReport = verifyPostTransform(source, result.project, {
      mode: 'lossless',
      stats: stats as ObfuscationStats
    });
    expect(statsReport.failures).toEqual([]);
    expect(statsReport.provenInvariants).toContain('aggregate-transform-stats-consistent-with-boundary-snapshots');

    const transformed = watermarkedClone(source, 103);
    const before = captureProjectVerificationSnapshot(source);
    const after = captureProjectVerificationSnapshot(transformed);
    const passReport = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      passTrace: [{
        pass: 'watermark',
        before,
        after,
        allowedChanges: ['symbols', 'symbols']
      }]
    });
    expect(passReport.failures).toContainEqual(expect.objectContaining({code: 'pass-policy-forged', pass: 'watermark'}));
  });

  it('rejects unsupported verification snapshot versions', () => {
    const snapshot = captureProjectVerificationSnapshot(createFixtureProject());
    const unsupported = {...snapshot, version: 3} as unknown as typeof snapshot;

    expect(() => changedVerificationCategories(snapshot, unsupported))
      .toThrow('unsupported verification snapshot version 3');
  });

  it('rejects copied or forged verification snapshots', () => {
    const snapshot = captureProjectVerificationSnapshot(createFixtureProject());
    const forged = {...snapshot, rawMonitorDigest: '0'.repeat(64)};

    expect(() => changedVerificationCategories(snapshot, forged))
      .toThrow('untrusted verification snapshot');
  });
});

function watermarkedClone(source: ScratchProject, seedValue: number): ScratchProject {
  const transformed = structuredClone(source);
  applyWatermarkTransform(
    transformed,
    new DeterministicGenerator(seed(seedValue), 'post-transform-verifier-test')
  );
  return transformed;
}

function dataMonitor(id: string, spriteName: string, visible: boolean): Record<string, JsonValue> {
  return {
    id,
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: id},
    spriteName,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}

function requiredFixtureTarget(project: ScratchProject, index: number): ScratchProject['targets'][number] {
  const target = project.targets[index];
  if (!target) throw new Error(`fixture target ${index} was not found`);
  return target;
}

function requiredFixtureBlock(value: unknown, id: string): ScratchBlock {
  if (!isScratchBlock(value)) throw new Error(`fixture block ${id} was not found`);
  return value;
}

function testSound(name: string): Record<string, JsonValue> {
  const assetId = '11111111111111111111111111111111';
  return {assetId, name, dataFormat: 'wav', md5ext: `${assetId}.wav`, rate: 44_100, sampleCount: 1};
}

function sensingMonitor(property: string): Record<string, JsonValue> {
  return {
    id: 'sensing-monitor',
    mode: 'default',
    opcode: 'sensing_of',
    params: {PROPERTY: property, OBJECT: '_stage_'},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: true,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  inputs: Record<string, ScratchInput> = {},
  fields: Record<string, JsonValue[]> = {}
): ScratchBlock {
  return {opcode, next, parent, inputs, fields, shadow: false, topLevel: false};
}

function sensingCanonicalizationFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  const sprite = project.targets[1];
  if (!stage || !sprite) throw new Error('fixture targets were not found');
  stage.broadcasts['sprite_selector'] = sprite.name;

  let previous = 'move_sprite';
  const append = (id: string, property: string, object: ScratchInput): void => {
    const previousBlock = sprite.blocks[previous];
    if (!isScratchBlock(previousBlock)) throw new Error('sensing fixture command chain was lost');
    const reporterId = `${id}_reporter`;
    previousBlock.next = id;
    sprite.blocks[id] = block(
      'data_addtolist',
      null,
      previous,
      {ITEM: [2, reporterId]},
      {LIST: ['Readable list', 'global_list']}
    );
    sprite.blocks[reporterId] = block(
      'sensing_of',
      null,
      id,
      {OBJECT: object},
      {PROPERTY: [property]}
    );
    previous = id;
  };

  append('sense_stage', 'Readable score', [1, [10, '_stage_']]);
  append('sense_sprite', 'Readable score', [1, [10, sprite.name]]);
  append('sense_missing', 'unresolved property', [1, [10, 'Missing Sprite']]);
  append('sense_native', 'x position', [1, [10, sprite.name]]);
  append('sense_dynamic', 'Readable score', [1, [12, 'Readable score', 'local_score']]);
  append('sense_menu', 'Readable score', [1, 'sense_menu_selector']);
  sprite.blocks['sense_menu_selector'] = {
    ...block('motion_goto_menu', null, 'sense_menu_reporter', {}, {TO: [sprite.name]}),
    shadow: true
  };
  append('sense_multifield', 'Readable score', [1, 'sense_multifield_selector']);
  sprite.blocks['sense_multifield_selector'] = {
    ...block('sensing_of_object_menu', null, 'sense_multifield_reporter', {}, {
      OBJECT: [sprite.name],
      EXTRA: ['forces dynamic treatment']
    }),
    shadow: true
  };
  append('sense_broadcast_primitive', 'Readable score', [1, [11, sprite.name, 'sprite_selector']]);
  append('sense_broadcast_menu', 'Readable score', [1, 'sense_broadcast_menu_selector']);
  sprite.blocks['sense_broadcast_menu_selector'] = {
    ...block('event_broadcast_menu', null, 'sense_broadcast_menu_reporter', {}, {
      BROADCAST_OPTION: [sprite.name, 'sprite_selector']
    }),
    shadow: true
  };
  append('sense_watermark_name', ANTI_CHEAT_WATERMARK_NAME, [1, [10, '_stage_']]);
  return project;
}

function spriteWatermarks(project: ScratchProject): JsonValue[][] {
  return project.targets.slice(1).flatMap(target => Object.values(target.variables))
    .filter(declaration => declaration[0] === ANTI_CHEAT_WATERMARK_NAME);
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function procedureArgumentFixture(): ScratchProject {
  const project = createFixtureProject();
  const sprite = project.targets[1];
  if (!sprite) throw new Error('fixture sprite was not found');
  sprite.blocks = {
    definition_a: {
      opcode: 'procedures_definition', next: 'body_a', parent: null,
      inputs: {custom_block: [1, 'prototype_a']}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0
    },
    prototype_a: {
      opcode: 'procedures_prototype', next: null, parent: 'definition_a',
      inputs: {a1: [1, 'prototype_reporter_a'], a2: [1, [10, '']]}, fields: {}, shadow: true, topLevel: false,
      mutation: {
        tagName: 'mutation', children: [], proccode: 'alpha %s %s', argumentids: '["a1","a2"]',
        argumentnames: '["value","value"]', argumentdefaults: '["",""]', warp: 'false'
      }
    },
    prototype_reporter_a: {
      opcode: 'argument_reporter_string_number', next: null, parent: 'prototype_a',
      inputs: {}, fields: {VALUE: ['value', null]}, shadow: true, topLevel: false
    },
    body_a: {
      opcode: 'looks_say', next: null, parent: 'definition_a',
      inputs: {MESSAGE: [2, 'body_reporter_a']}, fields: {}, shadow: false, topLevel: false
    },
    body_reporter_a: {
      opcode: 'argument_reporter_string_number', next: null, parent: 'body_a',
      inputs: {}, fields: {VALUE: ['value', null]}, shadow: false, topLevel: false
    },
    definition_b: {
      opcode: 'procedures_definition', next: 'body_b', parent: null,
      inputs: {custom_block: [1, 'prototype_b']}, fields: {}, shadow: false, topLevel: true, x: 40, y: 0
    },
    prototype_b: {
      opcode: 'procedures_prototype', next: null, parent: 'definition_b',
      inputs: {b1: [1, 'prototype_reporter_b']}, fields: {}, shadow: true, topLevel: false,
      mutation: {
        tagName: 'mutation', children: [], proccode: 'beta %s', argumentids: '["b1"]',
        argumentnames: '["value"]', argumentdefaults: '[""]', warp: 'false'
      }
    },
    prototype_reporter_b: {
      opcode: 'argument_reporter_string_number', next: null, parent: 'prototype_b',
      inputs: {}, fields: {VALUE: ['value', null]}, shadow: true, topLevel: false
    },
    body_b: {
      opcode: 'looks_say', next: null, parent: 'definition_b',
      inputs: {MESSAGE: [2, 'body_reporter_b']}, fields: {}, shadow: false, topLevel: false
    },
    body_reporter_b: {
      opcode: 'argument_reporter_string_number', next: null, parent: 'body_b',
      inputs: {}, fields: {VALUE: ['value', null]}, shadow: false, topLevel: false
    },
    call_a: {
      opcode: 'procedures_call', next: null, parent: null,
      inputs: {a1: [1, [10, 'first']], a2: [1, [10, 'second']]}, fields: {}, shadow: false, topLevel: true, x: 0, y: 100,
      mutation: {tagName: 'mutation', children: [], proccode: 'alpha %s %s', argumentids: '["a1","a2"]', warp: 'false'}
    },
    call_b: {
      opcode: 'procedures_call', next: null, parent: null,
      inputs: {b1: [1, [10, 'third']]}, fields: {}, shadow: false, topLevel: true, x: 40, y: 100,
      mutation: {tagName: 'mutation', children: [], proccode: 'beta %s', argumentids: '["b1"]', warp: 'false'}
    }
  };
  return project;
}

describe('extra privacy verification boundary', () => {
  it('canonicalizes referenced primitive selectors by context and treats shared-context primitives as ambiguous', () => {
    const source = createFixtureProject();
    const sprite = requiredFixtureTarget(source, 1);
    const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
    command.opcode = 'motion_goto';
    command.inputs = {TO: [2, 'referenced-selector']};
    sprite.blocks['referenced-selector'] = [10, 'Visible Sprite'];

    const renamed = structuredClone(source);
    const renamedSprite = requiredFixtureTarget(renamed, 1);
    renamedSprite.name = 'Opaque Sprite';
    const renamedPrimitive = renamedSprite.blocks['referenced-selector'];
    if (!isPrimitive(renamedPrimitive)) throw new Error('referenced selector primitive was not found');
    renamedPrimitive[1] = 'Opaque Sprite';
    expect(captureProjectVerificationSnapshot(source).extraExecutableValueDigest)
      .toBe(captureProjectVerificationSnapshot(renamed).extraExecutableValueDigest);

    const ambiguous = structuredClone(source);
    const ambiguousSprite = requiredFixtureTarget(ambiguous, 1);
    ambiguousSprite.blocks['second-owner'] = {
      ...block('looks_switchcostumeto', null, null, {COSTUME: [2, 'referenced-selector']}),
      topLevel: true,
      x: 500,
      y: 300
    };
    const renamedAmbiguous = structuredClone(ambiguous);
    const renamedAmbiguousSprite = requiredFixtureTarget(renamedAmbiguous, 1);
    renamedAmbiguousSprite.name = 'Opaque Sprite';
    const ambiguousPrimitive = renamedAmbiguousSprite.blocks['referenced-selector'];
    if (!isPrimitive(ambiguousPrimitive)) throw new Error('ambiguous selector primitive was not found');
    ambiguousPrimitive[1] = 'Opaque Sprite';
    expect(captureProjectVerificationSnapshot(ambiguous).extraExecutableValueDigest)
      .not.toBe(captureProjectVerificationSnapshot(renamedAmbiguous).extraExecutableValueDigest);
  });

  it('case-folds scalar broadcast selectors and snapshots incomplete selectors without throwing', () => {
    const source = createFixtureProject();
    const sprite = requiredFixtureTarget(source, 1);
    const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
    command.opcode = 'event_broadcast';
    command.inputs = {BROADCAST_INPUT: [2, [10, 'GO']]};
    const renamed = structuredClone(source);
    const renamedStage = requiredFixtureTarget(renamed, 0);
    const renamedSprite = requiredFixtureTarget(renamed, 1);
    renamedStage.broadcasts['broadcast_go'] = 'Opaque Message';
    const renamedCommand = requiredFixtureBlock(renamedSprite.blocks['move_sprite'], 'move_sprite');
    renamedCommand.inputs = {BROADCAST_INPUT: [2, [10, 'OPAQUE MESSAGE']]};

    expect(captureProjectVerificationSnapshot(source).extraExecutableValueDigest)
      .toBe(captureProjectVerificationSnapshot(renamed).extraExecutableValueDigest);

    const missingValue = structuredClone(source);
    const missingCommand = requiredFixtureBlock(
      requiredFixtureTarget(missingValue, 1).blocks['move_sprite'],
      'move_sprite'
    );
    missingCommand.opcode = 'motion_goto';
    missingCommand.inputs = {TO: [1]};
    const nullValue = structuredClone(missingValue);
    const nullCommand = requiredFixtureBlock(requiredFixtureTarget(nullValue, 1).blocks['move_sprite'], 'move_sprite');
    nullCommand.inputs = {TO: [1, null]};
    expect(captureProjectVerificationSnapshot(missingValue).extraExecutableValueDigest)
      .toBe(captureProjectVerificationSnapshot(nullValue).extraExecutableValueDigest);
  });

  it('tracks case-folded broadcast and backdrop ordinals, duplicates, misses, and a missing Stage', () => {
    const project = createFixtureProject();
    const stage = requiredFixtureTarget(project, 0);
    const sprite = requiredFixtureTarget(project, 1);
    stage.broadcasts = {first: 'first', duplicateFirst: 'FIRST', broadcast_go: 'go'};
    const descriptor = stage.costumes[0];
    if (!descriptor) throw new Error('backdrop descriptor was not found');
    stage.costumes = [
      {...descriptor, name: false},
      {...descriptor, name: 'Other'},
      {...descriptor, name: 'other'},
      {...descriptor, name: 'Backdrop'}
    ];
    stage.blocks['matched-backdrop-hat'] = {
      ...block('event_whenbackdropswitchesto', null, null, {}, {BACKDROP: ['Backdrop', null]}),
      topLevel: true,
      x: 20,
      y: 220
    };
    stage.blocks['missing-backdrop-hat'] = {
      ...block('event_whenbackdropswitchesto', null, null, {}, {BACKDROP: ['Missing', null]}),
      topLevel: true,
      x: 20,
      y: 260
    };
    sprite.blocks['matched-broadcast-hat'] = {
      ...block('event_whenbroadcastreceived', null, null, {}, {BROADCAST_OPTION: ['go', null]}),
      topLevel: true,
      x: 500,
      y: 220
    };
    sprite.blocks['missing-broadcast-hat'] = {
      ...block('event_whenbroadcastreceived', null, null, {}, {BROADCAST_OPTION: ['missing', null]}),
      topLevel: true,
      x: 500,
      y: 260
    };
    sprite.blocks['missing-sound-selector'] = {
      ...block('sound_play', null, null, {SOUND_MENU: [1, [10, 'Missing sound']]}),
      topLevel: true,
      x: 500,
      y: 300
    };

    const withStage = captureProjectVerificationSnapshot(project);
    const withoutStage = structuredClone(project);
    withoutStage.targets = withoutStage.targets.filter(target => !target.isStage);
    const loneSprite = requiredFixtureTarget(withoutStage, 0);
    loneSprite.blocks['stage-less-backdrop-selector'] = {
      ...block('looks_switchbackdropto', null, null, {BACKDROP: [1, [10, 'Missing']]}),
      topLevel: true,
      x: 500,
      y: 340
    };
    loneSprite.blocks['stage-less-backdrop-hat'] = {
      ...block('event_whenbackdropswitchesto', null, null, {}, {BACKDROP: ['Missing', null]}),
      topLevel: true,
      x: 500,
      y: 380
    };
    const noStage = captureProjectVerificationSnapshot(withoutStage);

    expect(withStage.extraExecutableValueDigest).toBeTypeOf('string');
    expect(noStage.extraExecutableValueDigest).toBeTypeOf('string');
    expect(withStage.extraExecutableValueDigest).not.toBe(noStage.extraExecutableValueDigest);
  });

  it('accepts each supported name-bearing surface independently through the verified pipeline', () => {
    const cases: Array<readonly [string, (project: ScratchProject) => void]> = [
      ['inline target selector', project => {
        const sprite = requiredFixtureTarget(project, 1);
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'motion_goto';
        command.inputs = {TO: [1, [10, 'Visible Sprite']]};
      }],
      ['target menu', project => {
        const sprite = requiredFixtureTarget(project, 1);
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'motion_goto';
        command.inputs = {TO: [1, 'target-menu']};
        sprite.blocks['target-menu'] = {
          ...block('motion_goto_menu', null, 'move_sprite', {}, {TO: ['Visible Sprite', null]}),
          shadow: true
        };
      }],
      ['backdrop hat', project => {
        const stage = requiredFixtureTarget(project, 0);
        const backdrop = stage.costumes[0];
        if (!backdrop) throw new Error('backdrop fixture missing');
        backdrop['name'] = 'Backdrop';
        stage.blocks['extra-hat'] = {
          ...block('event_whenbackdropswitchesto', null, null, {}, {BACKDROP: ['Backdrop', null]}),
          topLevel: true,
          x: 20,
          y: 220
        };
      }],
      ['name-only broadcast hat', project => {
        const sprite = requiredFixtureTarget(project, 1);
        sprite.blocks['extra-hat'] = {
          ...block('event_whenbroadcastreceived', null, null, {}, {BROADCAST_OPTION: ['go', null]}),
          topLevel: true,
          x: 420,
          y: 220
        };
      }],
      ['costume menu', project => {
        const sprite = requiredFixtureTarget(project, 1);
        const costume = sprite.costumes[0];
        if (!costume) throw new Error('costume fixture missing');
        costume['name'] = 'Hero';
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'looks_switchcostumeto';
        command.inputs = {COSTUME: [1, 'costume-menu']};
        sprite.blocks['costume-menu'] = {
          ...block('looks_costume', null, 'move_sprite', {}, {COSTUME: ['Hero', null]}),
          shadow: true
        };
      }],
      ['backdrop menu', project => {
        const stage = requiredFixtureTarget(project, 0);
        const sprite = requiredFixtureTarget(project, 1);
        const backdrop = stage.costumes[0];
        if (!backdrop) throw new Error('backdrop fixture missing');
        backdrop['name'] = 'Backdrop';
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'looks_switchbackdropto';
        command.inputs = {BACKDROP: [1, 'backdrop-menu']};
        sprite.blocks['backdrop-menu'] = {
          ...block('looks_backdrops', null, 'move_sprite', {}, {BACKDROP: ['Backdrop', null]}),
          shadow: true
        };
      }],
      ['sound menu', project => {
        const sprite = requiredFixtureTarget(project, 1);
        sprite.sounds = [testSound('Theme')];
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'sound_play';
        command.inputs = {SOUND_MENU: [1, 'sound-menu']};
        sprite.blocks['sound-menu'] = {
          ...block('sound_sounds_menu', null, 'move_sprite', {}, {SOUND_MENU: ['Theme', null]}),
          shadow: true
        };
      }],
      ['display-name reporter', project => {
        const sprite = requiredFixtureTarget(project, 1);
        const command = requiredFixtureBlock(sprite.blocks['move_sprite'], 'move_sprite');
        command.opcode = 'looks_say';
        command.inputs = {MESSAGE: [2, 'name-reporter']};
        sprite.blocks['name-reporter'] = block(
          'looks_costumenumbername', null, 'move_sprite', {}, {NUMBER_NAME: ['name', null]}
        );
      }],
      ['sprite-owned data monitor', project => {
        project.monitors.push({
          id: 'local_score', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'Readable score'},
          spriteName: 'Visible Sprite', value: 3, width: 88, height: 24, x: 13, y: 17, visible: true,
          sliderMin: 0, sliderMax: 100, isDiscrete: true
        });
      }],
      ['sensing monitor object', project => {
        project.monitors.push({...sensingMonitor('x position'), params: {PROPERTY: 'x position', OBJECT: 'Visible Sprite'}});
      }]
    ];
    const failures: string[] = [];
    for (const [name, arrange] of cases) {
      const project = createFixtureProject();
      arrange(project);
      try {
        obfuscateProject(project, 'lossless', seed(101), {extra: true});
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('verifies name and presentation privacy without weakening lossless topology checks', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', seed(91), {extra: true});
    const report = verifyPostTransform(source, result.project, {
      mode: 'lossless',
      extra: true,
      stats: result.stats
    });

    expect(report.verdict).toBe('verified-with-caveats');
    expect(report.extra).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.provenInvariants).toEqual(expect.arrayContaining([
      'extra-privacy-preserves-asset-payload-descriptors',
      'extra-privacy-preserves-target-order-stage-roles-and-stage-identity',
      'lossless-active-executable-topology-isomorphic',
      'lossless-extra-executable-values-preserved-outside-name-waiver',
      'lossless-extra-active-executable-topology-preserved-with-name-value-waiver'
    ]));
    expect(report.caveats.map(finding => finding.code)).toContain(
      'extra-name-and-editor-compatibility-waiver-active'
    );
  });

  it('rejects payload-descriptor, Stage, runtime-state, and retained-metadata changes under extra', () => {
    const source = createFixtureProject();
    const transformed = obfuscateProject(source, 'lossless', seed(92), {extra: true}).project;
    const stage = transformed.targets.find(target => target.isStage);
    const sprite = transformed.targets.find(target => !target.isStage);
    const costume = sprite?.costumes[0];
    if (!stage || !sprite || !costume) throw new Error('extra verifier fixture is incomplete');
    stage.name = 'Not Stage';
    costume['assetId'] = 'changed';
    sprite['volume'] = 37;
    transformed['retainedProvenance'] = 'unexpected';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});

    expect(report.verdict).toBe('failed');
    expect(report.failures.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'extra-asset-payload-descriptor-changed',
      'extra-optional-metadata-retained',
      'extra-runtime-state-changed',
      'extra-target-order-or-stage-identity-changed'
    ]));
  });

  it('rejects an unrelated active gameplay-value mutation under the extra name waiver', () => {
    const source = createFixtureProject();
    const transformed = obfuscateProject(source, 'lossless', seed(94), {extra: true}).project;
    const setX = transformed.targets
      .flatMap(target => Object.values(target.blocks))
      .find(value => isScratchBlock(value) && value.opcode === 'motion_setx');
    if (!isScratchBlock(setX)) throw new Error('active motion value fixture is unavailable');
    const value = setX.inputs['X']?.[1];
    if (!isPrimitive(value)) throw new Error('active motion literal is unavailable');
    value[1] = '999';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});
    expect(report.verdict).toBe('failed');
    expect(report.failures).toContainEqual(expect.objectContaining({code: 'lossless-executable-values-changed'}));
  });

  it('does not waive a numeric costume index as though it were a display-name reference', () => {
    const source = createFixtureProject();
    const sprite = source.targets.find(target => !target.isStage);
    const active = sprite && Object.values(sprite.blocks)
      .find(value => isScratchBlock(value) && value.opcode === 'motion_changexby');
    const costume = sprite?.costumes[0];
    if (!sprite || !isScratchBlock(active) || !costume) throw new Error('numeric selector fixture is unavailable');
    costume['name'] = '2';
    active.opcode = 'looks_switchcostumeto';
    active.inputs = {COSTUME: [1, [4, 2]]};

    const transformed = obfuscateProject(source, 'lossless', seed(96), {extra: true}).project;
    const transformedSprite = transformed.targets.find(target => !target.isStage);
    const switchCostume = transformedSprite && Object.values(transformedSprite.blocks)
      .find(value => isScratchBlock(value) && value.opcode === 'looks_switchcostumeto');
    const transformedCostume = transformedSprite?.costumes[0]?.['name'];
    const selector = isScratchBlock(switchCostume) ? switchCostume.inputs['COSTUME']?.[1] : undefined;
    if (!isPrimitive(selector) || typeof transformedCostume !== 'string') {
      throw new Error('transformed numeric selector fixture is unavailable');
    }
    expect(selector).toEqual([4, 2]);
    selector[1] = transformedCostume;

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});
    expect(report.verdict).toBe('failed');
    expect(report.failures).toContainEqual(expect.objectContaining({code: 'lossless-executable-values-changed'}));
  });

  it('rejects retargeting a monitor while still waiving its presentation under extra', () => {
    const source = createFixtureProject();
    const transformed = obfuscateProject(source, 'lossless', seed(95), {extra: true}).project;
    const stage = transformed.targets.find(target => target.isStage);
    const monitor = transformed.monitors[0];
    if (!stage || !monitor) throw new Error('monitor binding fixture is unavailable');
    const replacement = Object.entries(stage.variables).find(([id]) => id !== monitor['id']);
    if (!replacement) throw new Error('replacement monitor declaration is unavailable');
    const replacementName = replacement[1][0];
    if (typeof replacementName !== 'string') throw new Error('replacement monitor name is unavailable');
    monitor['id'] = replacement[0];
    monitor['params'] = {VARIABLE: replacementName};

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});
    expect(report.verdict).toBe('failed');
    expect(report.failures).toContainEqual(expect.objectContaining({code: 'extra-monitor-binding-surface-changed'}));
  });

  it('canonicalizes menu fields, hats, referenced primitives, scalar selectors, name reporters, and monitor owners', () => {
    const source = extraPrivacySurfaceFixture();
    const result = obfuscateProject(source, 'lossless', seed(97), {extra: true});
    const report = verifyPostTransform(source, result.project, {
      mode: 'lossless',
      extra: true,
      stats: result.stats
    });

    expect(report.failures).toEqual([]);
    expect(report.source.extraExecutableValueDigest).toBe(report.transformed.extraExecutableValueDigest);
    expect(report.source.monitorBindingDigest).toBe(report.transformed.monitorBindingDigest);
    expect(report.provenInvariants).toEqual(expect.arrayContaining([
      'extra-privacy-retains-monitor-records-and-exact-runtime-bindings',
      'lossless-extra-executable-values-preserved-outside-name-waiver'
    ]));
    expect(result.stats.privacyNamesRenamed).toBeGreaterThanOrEqual(6);
  });

  it('detects monitor-owner and sensing-object retargeting under the presentation waiver', () => {
    const source = extraPrivacySurfaceFixture();
    const transformed = obfuscateProject(source, 'lossless', seed(98), {extra: true}).project;
    const localMonitor = transformed.monitors.find(monitor => monitor['opcode'] === 'data_variable'
      && typeof monitor['spriteName'] === 'string');
    const sensing = transformed.monitors.find(monitor => monitor['opcode'] === 'sensing_of');
    if (!localMonitor || !sensing || !isJsonRecord(sensing['params'])) {
      throw new Error('extra monitor-owner fixtures were not found');
    }
    localMonitor['spriteName'] = null;
    sensing['params']['OBJECT'] = '_stage_';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});

    expect(report.failures).toContainEqual(expect.objectContaining({code: 'extra-monitor-binding-surface-changed'}));
  });

  it('attributes the extra pass with its fixed policy and rejects topology laundering through that pass', () => {
    const source = watermarkedClone(extraPrivacySurfaceFixture(), 99);
    const transformed = structuredClone(source);
    const before = captureProjectVerificationSnapshot(source);
    applyExtraPrivacyTransform(
      transformed,
      new DeterministicGenerator(seed(99), EXTRA_PRIVACY_GENERATOR_DOMAIN)
    );
    const after = captureProjectVerificationSnapshot(transformed);
    const accepted = verifyPostTransform(source, transformed, {
      mode: 'lossless',
      extra: true,
      passTrace: [{
        pass: EXTRA_PRIVACY_PASS_NAME,
        before,
        after,
        allowedChanges: EXTRA_PRIVACY_ALLOWED_CHANGES
      }]
    });

    expect(accepted.failures).toEqual([]);
    expect(accepted.passAttributions).toEqual([expect.objectContaining({
      pass: EXTRA_PRIVACY_PASS_NAME,
      continuous: true,
      unexpectedChanges: []
    })]);
    expect(accepted.provenInvariants).toContain('pass-boundary-change-attribution-complete');

    const laundered = structuredClone(transformed);
    const firstActive = laundered.targets.flatMap(target => Object.values(target.blocks))
      .find(value => isScratchBlock(value) && value.next !== null);
    if (!isScratchBlock(firstActive)) throw new Error('active topology fixture was not found');
    firstActive.next = null;
    const launderedAfter = captureProjectVerificationSnapshot(laundered);
    const rejected = verifyPostTransform(source, laundered, {
      mode: 'lossless',
      extra: true,
      passTrace: [{
        pass: EXTRA_PRIVACY_PASS_NAME,
        before,
        after: launderedAfter,
        allowedChanges: [...EXTRA_PRIVACY_ALLOWED_CHANGES, 'executable-topology']
      }]
    });

    expect(rejected.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'pass-policy-forged', pass: EXTRA_PRIVACY_PASS_NAME}),
      expect.objectContaining({code: 'pass-change-outside-declared-policy', pass: EXTRA_PRIVACY_PASS_NAME})
    ]));
  });

  it('reports removed semver and malformed sensing-monitor parameters without hiding either failure', () => {
    const source = extraPrivacySurfaceFixture();
    const transformed = obfuscateProject(source, 'lossless', seed(100), {extra: true}).project;
    delete transformed.meta['semver'];
    const sensing = transformed.monitors.find(monitor => monitor['opcode'] === 'sensing_of');
    if (!sensing) throw new Error('sensing monitor fixture was not found');
    sensing['params'] = 'malformed';

    const report = verifyPostTransform(source, transformed, {mode: 'lossless', extra: true});

    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'extra-runtime-state-changed'}),
      expect.objectContaining({code: 'extra-monitor-binding-surface-changed'})
    ]));
  });

  it('canonicalizes array-shaped sensing monitor selectors without throwing', () => {
    const project = createFixtureProject();
    project.monitors = [{
      ...sensingMonitor('x position'),
      params: {PROPERTY: 'x position', OBJECT: [null, 'Visible Sprite']}
    }];

    const first = captureProjectVerificationSnapshot(project);
    const second = captureProjectVerificationSnapshot(structuredClone(project));

    expect(first.monitorBindingDigest).toBe(second.monitorBindingDigest);
    expect(first.monitorCount).toBe(1);
  });

  it('keeps extra inside the verified lossless anti-cheat checkpoint', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', seed(93), {antiCheat: true, extra: true});

    expect(result.stats.verification).toEqual(expect.objectContaining({
      verdict: 'verified-with-caveats'
    }));
    expect(result.stats.privacyNamesRenamed).toBeGreaterThan(0);
    expect(result.stats.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining('Extra privacy preserves binary asset bytes')
    ]));
  });

  it('proves the final extra level 2 pass by exactly reversing its manifest-bound hat flags', () => {
    const fixture = extraEditorShadowVerifierFixture();
    const report = verifyPostTransform(fixture.source, fixture.transformed, fixture.options);

    expect(report.verdict).toBe('verified-with-caveats');
    expect(report.extra).toBe(true);
    expect(report.extraLevel).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.provenInvariants).toEqual(expect.arrayContaining([
      'extra-editor-shadow-covers-every-final-top-level-native-hat',
      'extra-editor-shadow-pass-changes-only-manifest-bound-native-hat-flags',
      'lossless-active-executable-topology-isomorphic'
    ]));
    expect(report.caveats).toContainEqual(expect.objectContaining({
      code: 'extra-editor-shadow-disables-native-event-stacks',
      message: EXTRA_EDITOR_SHADOW_CAVEAT
    }));
    expect(report.passAttributions).toEqual([
      expect.objectContaining({
        pass: EXTRA_EDITOR_SHADOW_PASS_NAME,
        continuous: true,
        unexpectedChanges: []
      })
    ]);
  });

  it('rejects laundering an unrelated executable change through the extra level 2 waiver', () => {
    const fixture = extraEditorShadowVerifierFixture();
    const body = fixture.transformed.targets.flatMap(target => Object.values(target.blocks))
      .find(value => isScratchBlock(value) && value.opcode === 'motion_setx');
    const literal = isScratchBlock(body) ? body.inputs['X']?.[1] : undefined;
    if (!isPrimitive(literal)) throw new Error('extra level 2 laundering fixture was not found');
    literal[1] = '999';
    const after = captureProjectVerificationSnapshot(fixture.transformed);
    const passTrace: VerificationPassBoundary[] = [{
      ...fixture.options.passTrace?.[0] as VerificationPassBoundary,
      after
    }];

    const report = verifyPostTransform(fixture.source, fixture.transformed, {
      ...fixture.options,
      passTrace
    });

    expect(report.verdict).toBe('failed');
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'extra-editor-shadow-pass-not-isolated'
    }));
  });

  it('rejects missing hat coverage, an untrusted manifest, and incompatible level options', () => {
    const missingSite = extraEditorShadowVerifierFixture();
    const firstHat = missingSite.transformed.targets.flatMap(target => Object.values(target.blocks))
      .find(value => isScratchBlock(value) && value.topLevel && isOfficialHatOpcodeForTest(value.opcode));
    if (!isScratchBlock(firstHat)) throw new Error('extra level 2 hat fixture was not found');
    firstHat.shadow = false;
    const missingAfter = captureProjectVerificationSnapshot(missingSite.transformed);
    const missingReport = verifyPostTransform(missingSite.source, missingSite.transformed, {
      ...missingSite.options,
      passTrace: [{
        ...missingSite.options.passTrace?.[0] as VerificationPassBoundary,
        after: missingAfter
      }]
    });
    expect(missingReport.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'extra-editor-shadow-site-invalid'})
    ]));
    expect(missingReport.failures.map(finding => finding.code))
      .not.toContain('lossless-executable-topology-changed');

    const untrusted = extraEditorShadowVerifierFixture();
    const copiedManifest = structuredClone(untrusted.options.extraEditorShadowManifest);
    const untrustedReport = verifyPostTransform(untrusted.source, untrusted.transformed, {
      ...untrusted.options,
      extraEditorShadowManifest: copiedManifest
    });
    expect(untrustedReport.failures).toContainEqual(expect.objectContaining({
      code: 'extra-editor-shadow-manifest-missing-or-untrusted'
    }));
    expect(untrustedReport.failures.map(finding => finding.code))
      .not.toContain('lossless-executable-topology-changed');

    const conflicting = extraEditorShadowVerifierFixture();
    const conflictReport = verifyPostTransform(conflicting.source, conflicting.transformed, {
      ...conflicting.options,
      extra: false
    });
    expect(conflictReport.failures).toContainEqual(expect.objectContaining({code: 'extra-level-option-conflict'}));

    const invalidLevel = extraEditorShadowVerifierFixture();
    const invalidLevelReport = verifyPostTransform(invalidLevel.source, invalidLevel.transformed, {
      ...invalidLevel.options,
      extraLevel: 3 as 2
    });
    expect(invalidLevelReport.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'extra-level-invalid'}),
      expect.objectContaining({code: 'extra-editor-shadow-unexpected'})
    ]));

    const missingBoundary = extraEditorShadowVerifierFixture();
    const missingBoundaryReport = verifyPostTransform(missingBoundary.source, missingBoundary.transformed, {
      ...missingBoundary.options,
      passTrace: []
    });
    expect(missingBoundaryReport.failures).toContainEqual(expect.objectContaining({
      code: 'extra-editor-shadow-checkpoint-missing'
    }));
  });
});

interface ExtraEditorShadowVerifierFixture {
  readonly source: ScratchProject;
  readonly transformed: ScratchProject;
  readonly options: PostTransformVerificationOptions & {
    readonly extraEditorShadowManifest: ExtraEditorShadowManifest;
    readonly passTrace: readonly VerificationPassBoundary[];
  };
}

function extraEditorShadowVerifierFixture(): ExtraEditorShadowVerifierFixture {
  const source = watermarkedClone(extraPrivacySurfaceFixture(), 0xe2);
  applyExtraPrivacyTransform(
    source,
    new DeterministicGenerator(seed(0xe2), EXTRA_PRIVACY_GENERATOR_DOMAIN)
  );
  const transformed = structuredClone(source);
  const before = captureProjectVerificationSnapshot(transformed);
  const shadow = applyExtraEditorShadowTransform(transformed);
  const after = captureProjectVerificationSnapshot(transformed);
  return {
    source,
    transformed,
    options: {
      mode: 'lossless',
      extra: true,
      extraLevel: 2,
      extraEditorShadowManifest: shadow.manifest,
      passTrace: [{
        pass: EXTRA_EDITOR_SHADOW_PASS_NAME,
        before,
        after,
        allowedChanges: EXTRA_EDITOR_SHADOW_ALLOWED_CHANGES
      }]
    }
  };
}

function isOfficialHatOpcodeForTest(opcode: string): boolean {
  return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
}

function extraPrivacySurfaceFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = project.targets[0];
  const sprite = project.targets[1];
  if (!stage || !sprite) throw new Error('extra privacy fixture targets were not found');

  const backdrop = stage.costumes[0];
  const costume = sprite.costumes[0];
  if (!backdrop || !costume) throw new Error('extra privacy fixture media was not found');
  backdrop['name'] = 'Backdrop';
  stage.costumes.push({...backdrop, name: 'backdrop'});
  costume['name'] = 'Hero';
  const soundAsset = '11111111111111111111111111111111';
  sprite.sounds = [{
    assetId: soundAsset,
    name: 'Theme',
    dataFormat: 'wav',
    md5ext: `${soundAsset}.wav`,
    rate: 44_100,
    sampleCount: 1
  }];

  stage.blocks['backdrop-name-hat'] = {
    ...block('event_whenbackdropswitchesto', null, null, {}, {BACKDROP: ['Backdrop', null]}),
    topLevel: true,
    x: 20,
    y: 220
  };
  sprite.blocks['broadcast-name-hat'] = {
    ...block('event_whenbroadcastreceived', null, null, {}, {BROADCAST_OPTION: ['go', null]}),
    topLevel: true,
    x: 420,
    y: 220
  };

  let previous = 'move_sprite';
  const append = (id: string, value: ScratchBlock): void => {
    const parent = sprite.blocks[previous];
    if (!isScratchBlock(parent)) throw new Error(`extra privacy chain parent ${previous} was not found`);
    parent.next = id;
    value.parent = previous;
    sprite.blocks[id] = value;
    previous = id;
  };
  append('goto-name', block('motion_goto', null, null, {TO: [1, 'goto-name-menu']}));
  sprite.blocks['goto-name-menu'] = {
    ...block('motion_goto_menu', null, 'goto-name', {}, {TO: ['Visible Sprite', null]}),
    shadow: true
  };
  append('point-name', block('motion_pointtowards', null, null, {TOWARDS: [1, [10, 'Visible Sprite']]}));
  append('costume-name', block('looks_switchcostumeto', null, null, {COSTUME: [1, 'costume-name-menu']}));
  sprite.blocks['costume-name-menu'] = {
    ...block('looks_costume', null, 'costume-name', {}, {COSTUME: ['Hero', null]}),
    shadow: true
  };
  append('backdrop-name', block('looks_switchbackdropto', null, null, {BACKDROP: [1, 'backdrop-name-menu']}));
  sprite.blocks['backdrop-name-menu'] = {
    ...block('looks_backdrops', null, 'backdrop-name', {}, {BACKDROP: ['backdrop', null]}),
    shadow: true
  };
  append('sound-name', block('sound_play', null, null, {SOUND_MENU: [1, 'sound-name-menu']}));
  sprite.blocks['sound-name-menu'] = {
    ...block('sound_sounds_menu', null, 'sound-name', {}, {SOUND_MENU: ['Theme', null]}),
    shadow: true
  };
  append('broadcast-name', block('event_broadcast', null, null, {BROADCAST_INPUT: [1, [11, 'go', 'broadcast_go']]}));
  append('say-costume-name', block('looks_say', null, null, {MESSAGE: [2, 'costume-name-reporter']}));
  sprite.blocks['costume-name-reporter'] = block(
    'looks_costumenumbername',
    null,
    'say-costume-name',
    {},
    {NUMBER_NAME: ['name', null]}
  );
  append('say-backdrop-name', block('looks_say', null, null, {MESSAGE: [2, 'backdrop-name-reporter']}));
  sprite.blocks['backdrop-name-reporter'] = block(
    'looks_backdropnumbername',
    null,
    'say-backdrop-name',
    {},
    {NUMBER_NAME: ['name', null]}
  );

  project.monitors.push({
    id: 'local_score', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'Readable score'},
    spriteName: 'Visible Sprite', value: 3, width: 88, height: 24, x: 13, y: 17, visible: true,
    sliderMin: 0, sliderMax: 100, isDiscrete: true
  });
  project.monitors.push({
    ...sensingMonitor('x position'),
    params: {PROPERTY: 'x position', OBJECT: 'Visible Sprite'}
  });
  return project;
}

interface AntiSaveVerifierFixture {
  readonly source: ScratchProject;
  readonly transformed: ScratchProject;
  readonly manifest: AntiSaveVerificationManifest;
  readonly options: PostTransformVerificationOptions;
}

function antiSaveVerifierFixture(antiCheat: boolean): AntiSaveVerifierFixture {
  const source = createFixtureProject();
  const transformed = structuredClone(source);
  const sourceSnapshot = captureProjectVerificationSnapshot(source);
  const antiSaveResult = applyAntiSaveTransform(
    transformed,
    new DeterministicGenerator(seed(0xa5), ANTI_SAVE_GENERATOR_DOMAIN)
  );
  const antiSaveSnapshot = captureProjectVerificationSnapshot(transformed);
  const passTrace: VerificationPassBoundary[] = [{
    pass: ANTI_SAVE_PASS_NAME,
    before: sourceSnapshot,
    after: antiSaveSnapshot,
    allowedChanges: [
      'symbols',
      'identifiers',
      'executable-topology',
      'executable-values',
      'serialized-block-data',
      'comments-layout'
    ]
  }];
  let antiCheatDecoys = 0;
  if (antiCheat) {
    const result = applyAntiCheatTransform(
      transformed,
      new DeterministicGenerator(seed(0xac), 'post-transform-antisave-anticheat')
    );
    antiCheatDecoys = result.decoyVariableIds.length;
    passTrace.push({
      pass: 'anti-cheat-instrumentation',
      before: antiSaveSnapshot,
      after: captureProjectVerificationSnapshot(transformed),
      allowedChanges: [
        'symbols',
        'identifiers',
        'executable-topology',
        'executable-values',
        'serialized-block-data',
        'comments-layout'
      ]
    });
  } else {
    applyWatermarkTransform(
      transformed,
      new DeterministicGenerator(seed(0xa7), 'post-transform-antisave-watermark')
    );
    passTrace.push({
      pass: 'watermark',
      before: antiSaveSnapshot,
      after: captureProjectVerificationSnapshot(transformed),
      allowedChanges: ['symbols', 'identifiers']
    });
  }
  const transformedSnapshot = captureProjectVerificationSnapshot(transformed);
  const stats: ObfuscationStats = {
    mode: 'lossless',
    blocksBefore: sourceSnapshot.blockEquivalents,
    blocksAfter: transformedSnapshot.blockEquivalents,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: antiCheatDecoys,
    virtualizedBlocks: 0,
    antiCheatDecoys,
    antiSaveCanaries: antiSaveResult.canaryCount,
    warnings: [],
    caveats: []
  };
  expect(antiCheatDecoys).toBe(antiCheat ? ANTI_CHEAT_DECOY_COUNT : 0);
  return {
    source,
    transformed,
    manifest: antiSaveResult.manifest,
    options: {
      mode: 'lossless',
      antiCheat,
      antiSave: true,
      stats,
      passTrace,
      losslessCoreSnapshot: sourceSnapshot,
      antiSaveManifest: antiSaveResult.manifest
    }
  };
}

function requiredAntiSaveProcedure(
  manifest: AntiSaveVerificationManifest,
  index: number
): AntiSaveVerificationManifest['procedures'][number] {
  const procedure = manifest.procedures[index];
  if (!procedure) throw new Error(`anti-save procedure ${index} was not found`);
  return procedure;
}

function requiredAntiSaveHatGuard(
  manifest: AntiSaveVerificationManifest,
  index: number
): AntiSaveVerificationManifest['hatGuards'][number] {
  const site = manifest.hatGuards[index];
  if (!site) throw new Error(`anti-save hat guard ${index} was not found`);
  return site;
}
