import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DeterministicGenerator} from '../src/deterministic.js';
import {captureProjectVerificationSnapshot} from '../src/verification/post-transform.js';
import type {
  PostTransformVerificationOptions,
  PostTransformVerificationReport,
  ProjectVerificationSnapshot,
  VerificationChangeCategory
} from '../src/verification/post-transform.js';
import type {ObfuscationProgressEvent, ObfuscationStats, ScratchBlock, ScratchProject} from '../src/types.js';

interface InjectedPassAttribution {
  readonly pass: string;
  readonly unexpectedChanges?: readonly VerificationChangeCategory[];
  readonly continuous?: boolean;
}

interface VerificationDirective {
  readonly verdict: 'failed' | 'verified-with-caveats';
  readonly failureCodes?: readonly string[];
  readonly failurePass?: string;
  readonly caveats?: ReadonlyArray<{readonly code: string; readonly message: string; readonly pass?: string}>;
  readonly provenInvariants?: readonly string[];
  readonly attributedPasses?: number;
  readonly passAttributions?: readonly InjectedPassAttribution[];
}

interface RecordedVerificationOptions {
  readonly mode: string;
  readonly antiCheat: boolean;
  readonly statsMode: string | undefined;
  readonly passNames: readonly string[];
  readonly hasLosslessCore: boolean;
}

interface PostTransformModule {
  captureProjectVerificationSnapshot(project: ScratchProject): ProjectVerificationSnapshot;
  verifyPostTransform(
    source: ScratchProject,
    transformed: ScratchProject,
    options: PostTransformVerificationOptions
  ): PostTransformVerificationReport;
}

interface CommonTransformModule {
  applyCommonTransforms(
    project: ScratchProject,
    generator: DeterministicGenerator,
    stats: ObfuscationStats
  ): void;
}

const validationState = vi.hoisted(() => ({calls: 0, throwAt: -1}));
const verifierState = vi.hoisted(() => ({
  directives: [] as VerificationDirective[],
  options: [] as RecordedVerificationOptions[]
}));
const transformState = vi.hoisted<{
  commonFailure: unknown;
  commonCalls: number;
  tamperFallback: boolean;
}>(() => ({commonFailure: undefined, commonCalls: 0, tamperFallback: false}));

vi.mock('../src/validation/index.js', () => ({
  validateProject: (): void => {
    validationState.calls += 1;
    if (validationState.calls === validationState.throwAt) throw new Error('generated graph is invalid');
  }
}));

vi.mock('../src/verification/post-transform.js', async importOriginal => {
  const actual = await importOriginal<PostTransformModule>();
  return {
    ...actual,
    verifyPostTransform: (
      source: Parameters<typeof actual.verifyPostTransform>[0],
      transformed: Parameters<typeof actual.verifyPostTransform>[1],
      options: Parameters<typeof actual.verifyPostTransform>[2]
    ): ReturnType<typeof actual.verifyPostTransform> => {
      verifierState.options.push({
        mode: options.mode,
        antiCheat: options.antiCheat === true,
        statsMode: options.stats?.mode,
        passNames: options.passTrace?.map(boundary => boundary.pass) ?? [],
        hasLosslessCore: options.losslessCoreSnapshot !== undefined
      });
      const directive = verifierState.directives.shift();
      if (directive === undefined) return actual.verifyPostTransform(source, transformed, options);
      const passAttributions = directive.passAttributions?.map(attribution => ({
        pass: attribution.pass,
        changes: [...(attribution.unexpectedChanges ?? [])],
        unexpectedChanges: [...(attribution.unexpectedChanges ?? [])],
        allowedButUnobserved: [],
        continuous: attribution.continuous ?? true
      })) ?? Array.from({length: directive.attributedPasses ?? 0}, (_, index) => ({
        pass: `injected-pass-${index}`,
        changes: [] as VerificationChangeCategory[],
        unexpectedChanges: [] as VerificationChangeCategory[],
        allowedButUnobserved: [] as VerificationChangeCategory[],
        continuous: true
      }));
      return {
        scope: 'static-project-structure',
        verdict: directive.verdict,
        mode: options.mode,
        antiCheat: options.antiCheat === true,
        extra: options.extra === true,
        source: actual.captureProjectVerificationSnapshot(source),
        transformed: actual.captureProjectVerificationSnapshot(transformed),
        ...(options.losslessCoreSnapshot === undefined ? {} : {losslessCore: options.losslessCoreSnapshot}),
        failures: (directive.failureCodes ?? []).map(code => ({
          severity: 'failure' as const,
          code,
          message: `injected failure ${code}`,
          ...(directive.failurePass === undefined ? {} : {pass: directive.failurePass})
        })),
        caveats: (directive.caveats ?? []).map(finding => ({
          severity: 'caveat' as const,
          code: finding.code,
          message: finding.message,
          ...(finding.pass === undefined ? {} : {pass: finding.pass})
        })),
        provenInvariants: [...(directive.provenInvariants ?? [])],
        passAttributions
      };
    }
  };
});

vi.mock('../src/obfuscation/common.js', async importOriginal => {
  const actual = await importOriginal<CommonTransformModule>();
  return {
    ...actual,
    applyCommonTransforms: (...arguments_: Parameters<typeof actual.applyCommonTransforms>): void => {
      transformState.commonCalls += 1;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises defensive wrapping of foreign throws
      if (transformState.commonFailure !== undefined) throw transformState.commonFailure;
      actual.applyCommonTransforms(...arguments_);
      if (transformState.tamperFallback && transformState.commonCalls === 2) {
        const transformed = arguments_[0];
        const stage = transformed.targets.find(target => target.isStage);
        if (stage) stage.blocks['fallback-common-tamper'] = fallbackTamperBlock();
      }
    }
  };
});

const {
  getAntiCheatReleaseCheckpoint,
  obfuscateProject
} = await import('../src/obfuscation/index.js');

beforeEach(() => {
  validationState.calls = 0;
  validationState.throwAt = -1;
  verifierState.directives.splice(0);
  verifierState.options.splice(0);
  transformState.commonFailure = undefined;
  transformState.commonCalls = 0;
  transformState.tamperFallback = false;
});

describe('obfuscation output invariant', () => {
  it('rejects an invalid protection option before transformation starts', () => {
    expect(() => obfuscateProject(
      project(),
      'lossless',
      new Uint8Array(32),
      {antiCheat: 'enabled'} as unknown as {antiCheat: boolean}
    )).toThrow('antiCheat must be a boolean');
    expect(validationState.calls).toBe(0);
  });

  it('classifies transformed-project validation failure as internal and preserves its cause', () => {
    validationState.throwAt = 4;
    let thrown: unknown;
    try {
      obfuscateProject(project(), 'lossless', new Uint8Array(32));
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) throw new TypeError('expected an Error from the transformation boundary');
    expect(thrown.message).toMatch(/internal validation rejected/u);
    expect(thrown.cause).toMatchObject({message: 'generated graph is invalid'});
    expect(validationState.calls).toBe(4);
  });

  it('wraps a transformation-pass failure without losing the original error', () => {
    const passFailure = new TypeError('common transform failed');
    transformState.commonFailure = passFailure;
    let thrown: unknown;
    try {
      obfuscateProject(project(), 'lossless', new Uint8Array(32));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: 'internal validation rejected the transformed project or transformation pass',
      cause: passFailure
    });
  });

  it('wraps a non-Error transformation failure as an unknown cause', () => {
    transformState.commonFailure = 'non-error failure';
    let thrown: unknown;
    try {
      obfuscateProject(project(), 'lossless', new Uint8Array(32));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      message: 'internal validation rejected the transformed project or transformation pass',
      cause: 'non-error failure'
    });
  });

  it('sorts and deduplicates verifier failure codes for a rejected lossless result', () => {
    verifierState.directives.push({
      verdict: 'failed',
      failureCodes: ['topology-changed', 'asset-changed', 'topology-changed'],
      failurePass: 'identifier-and-metadata-remapping',
      passAttributions: [{
        pass: 'identifier-and-metadata-remapping',
        unexpectedChanges: ['executable-values']
      }]
    });

    expect(() => obfuscateProject(project(), 'lossless', new Uint8Array(32))).toThrow(
      'post-transform static verification rejected the generated project '
        + '(codes=asset-changed,topology-changed; passes=identifier-and-metadata-remapping; categories=executable-values)'
    );
  });

  it('rebuilds a rejected lossy candidate, aggregates diagnostics, and reports monotonic fallback progress', () => {
    verifierState.directives.push(
      {
        verdict: 'failed',
        failureCodes: ['unexpected-live-change'],
        failurePass: 'aggressive-structural-hardening',
        caveats: [
          {code: 'visual-equivalence-not-proven', message: 'Visual equivalence remains outside static proof.'},
          {code: 'candidate-static-scope', message: 'The rejected candidate had a separate static caveat.'}
        ],
        passAttributions: [{
          pass: 'aggressive-structural-hardening',
          unexpectedChanges: ['executable-topology']
        }]
      },
      {
        verdict: 'verified-with-caveats',
        caveats: [
          {code: 'visual-equivalence-not-proven', message: 'Visual equivalence remains outside static proof.'},
          {code: 'visual-equivalence-not-proven', message: 'Visual equivalence remains outside static proof.'},
          {code: 'runtime-equivalence-not-proven', message: 'Runtime equivalence remains outside static proof.'},
          {
            code: 'informational-only',
            message: 'This finding is intentionally not promoted.',
            pass: 'post-transform-cleanup'
          }
        ],
        provenInvariants: ['archive-shape', 'typed-references'],
        attributedPasses: 2
      }
    );
    const events: ObfuscationProgressEvent[] = [];
    const result = obfuscateProject(project(), 'lossy', new Uint8Array(32).fill(0x61), {
      antiCheat: true,
      onProgress: event => events.push(event)
    });

    expect(result.stats.warnings).toContain(
      'Static verification rejected the lossy structural candidate '
        + '(codes=unexpected-live-change; passes=aggressive-structural-hardening; categories=executable-topology); '
        + 'common lossless transforms plus anti-cheat instrumentation were emitted instead.'
    );
    expect(result.stats.caveats).toEqual([
      'The requested lossy structural passes were rolled back after static verifier findings '
        + '(codes=unexpected-live-change; passes=aggressive-structural-hardening; categories=executable-topology).',
      'Static verifier caveat [code=visual-equivalence-not-proven]: Visual equivalence remains outside static proof.',
      'Static verifier caveat [code=candidate-static-scope]: The rejected candidate had a separate static caveat.',
      'Static verifier caveat [code=runtime-equivalence-not-proven]: Runtime equivalence remains outside static proof.',
      'Static verifier caveat [code=informational-only; pass=post-transform-cleanup]: '
        + 'This finding is intentionally not promoted.'
    ]);
    expect(result.stats.verification).toEqual({
      scope: 'static-project-structure',
      verdict: 'verified-with-caveats',
      provenInvariants: 2,
      attributedPasses: 2,
      caveats: 4
    });
    expect(events.filter(event => event.stage === 'verification-fallback')).toHaveLength(1);
    expect(events.at(-1)?.stage).toBe('transformation-complete');
    expect(events.at(-1)?.percentage).toBe(100);
    expect(events.at(-1)?.metrics?.['warnings']).toBe(1);
    expect(events.every((event, index) => index === 0 || event.percentage >= (events[index - 1]?.percentage ?? 0))).toBe(true);
    expect(verifierState.options).toHaveLength(2);
    expect(verifierState.options[0]).toMatchObject({mode: 'lossy', statsMode: 'lossy'});
    expect(verifierState.options[0]?.passNames).toContain('aggressive-structural-hardening');
    expect(verifierState.options[1]).toMatchObject({mode: 'lossless', statsMode: 'lossless', hasLosslessCore: true});
    expect(verifierState.options[1]?.passNames).not.toContain('aggressive-structural-hardening');
    expect(verifierState.options.every(options => options.antiCheat)).toBe(true);
    expect(result.stats.mode).toBe('lossy');
    const checkpoint = getAntiCheatReleaseCheckpoint(result);
    expect(checkpoint?.pass).toBe('anti-cheat-instrumentation');
    expect(checkpoint?.after.fullDigest).toBe(
      captureProjectVerificationSnapshot(result.project).fullDigest
    );
    expect(Object.isFrozen(checkpoint)).toBe(true);
  });

  it('rejects a common-only fallback that changes lossless executable topology', () => {
    verifierState.directives.push({verdict: 'failed', failureCodes: ['primary-rejected']});
    transformState.tamperFallback = true;

    expect(() => obfuscateProject(project(), 'no-preserve', new Uint8Array(32).fill(0x64))).toThrow(
      /codes=.*lossless-executable-topology-changed.*passes=identifier-and-metadata-remapping.*categories=executable-topology/u
    );
    expect(verifierState.options).toHaveLength(2);
    expect(verifierState.options[1]).toMatchObject({mode: 'lossless', statsMode: 'lossless'});
  });

  it('surfaces a second verifier rejection instead of emitting an unverified fallback', () => {
    verifierState.directives.push(
      {verdict: 'failed', failureCodes: ['primary-rejected']},
      {
        verdict: 'failed',
        failureCodes: ['fallback-z', 'fallback-a'],
        failurePass: 'post-transform-cleanup',
        passAttributions: [{
          pass: 'post-transform-cleanup',
          unexpectedChanges: ['serialized-block-data']
        }]
      }
    );

    expect(() => obfuscateProject(project(), 'lossy', new Uint8Array(32).fill(0x62))).toThrow(
      'post-transform static verification rejected the generated project '
        + '(codes=fallback-a,fallback-z; passes=post-transform-cleanup; categories=serialized-block-data)'
    );
    expect(verifierState.options).toHaveLength(2);
  });

  it('passes a strict lossless checkpoint to anti-cheat verification and reports both guard stages', () => {
    verifierState.directives.push({
      verdict: 'verified-with-caveats',
      provenInvariants: ['watermark'],
      attributedPasses: 3
    });
    const events: ObfuscationProgressEvent[] = [];
    const result = obfuscateProject(project(), 'lossless', new Uint8Array(32).fill(0x63), {
      antiCheat: true,
      onProgress: event => events.push(event)
    });

    const antiCheatEvents = events.filter(event => event.stage === 'installing-anticheat');
    expect(antiCheatEvents).toHaveLength(2);
    expect(antiCheatEvents[0]).toMatchObject({percentage: 88});
    expect(antiCheatEvents[1]?.percentage).toBe(95);
    expect(antiCheatEvents[1]?.metrics?.['decoyVariables']).toEqual(expect.any(Number));
    expect(antiCheatEvents[1]?.metrics?.['protectedVariables']).toEqual(expect.any(Number));
    expect(verifierState.options).toEqual([
      expect.objectContaining({mode: 'lossless', antiCheat: true, hasLosslessCore: true})
    ]);
    expect(result.stats.verification).toMatchObject({provenInvariants: 1, attributedPasses: 3});
  });

  it('distinguishes ordinary results from unregistered result objects', () => {
    const result = obfuscateProject(project(), 'lossless', new Uint8Array(32).fill(0x68));

    expect(getAntiCheatReleaseCheckpoint(result)).toBeUndefined();
    expect(() => getAntiCheatReleaseCheckpoint({
      project: project(),
      stats: result.stats
    })).toThrow('unregistered obfuscation result');
  });
});

function project(): ScratchProject {
  return {
    targets: [{
      isStage: true,
      name: 'Stage',
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [{assetId: '0'.repeat(32), dataFormat: 'svg', name: 'backdrop'}],
      sounds: []
    }],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0'}
  };
}

function fallbackTamperBlock(): ScratchBlock {
  return {
    opcode: 'looks_say',
    next: null,
    parent: null,
    inputs: {MESSAGE: [1, [10, 'fallback-tamper']]},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
}
