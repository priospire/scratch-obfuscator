import snapshot from './release-coverage.json' with {type: 'json'};

export interface ReleaseCoverageMetric {
  readonly covered: number;
  readonly total: number;
  readonly percentage: number;
  readonly allCovered: boolean;
}

export interface ReleaseCoverageSnapshot {
  readonly version: string;
  readonly statements: ReleaseCoverageMetric;
  readonly branches: ReleaseCoverageMetric;
  readonly functions: ReleaseCoverageMetric;
  readonly lines: ReleaseCoverageMetric;
}

/** Generated from the complete Windows release-coverage gate before each release. */
export const RELEASE_TEST_COVERAGE: ReleaseCoverageSnapshot = Object.freeze(snapshot);
