export interface ScratchLikeProject {
  readonly targets: readonly {
    readonly blocks: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  }[];
  readonly [key: string]: unknown;
}

export interface ReadabilityIteration {
  readonly label: string;
  readonly project: ScratchLikeProject;
}

export interface ComponentShape {
  readonly nodes: number;
  readonly families: readonly string[];
  readonly opcodeKinds: number;
  readonly quality: number;
  readonly digest: string;
}

export interface RepeatedSignature {
  readonly signature: string;
  readonly count: number;
  readonly share: number;
}

export interface ReadabilityProfile {
  readonly objectBlocks: number;
  readonly blockEquivalents: number;
  readonly opcodeKinds: number;
  readonly opcodeEntropy: number;
  readonly opcodeSignatureDiversity: number;
  readonly opcodeFamilyKinds: number;
  readonly topLevelRoots: number;
  readonly runnableHats: number;
  readonly broadcastReceiverHats: number;
  readonly neverSentBroadcastHats: number;
  readonly dormantBroadcastHats: number;
  readonly stateGatedBroadcastCommands: number;
  readonly customDefinitions: number;
  readonly customCalls: number;
  readonly reporters: number;
  readonly operators: number;
  readonly branchBlocks: number;
  readonly listIndirections: number;
  readonly retainedAfterNormalization: number;
  readonly prunedByNormalizer: number;
  readonly foldedReporters: number;
  readonly inlinedProcedures: number;
  readonly provenFalseControls: number;
  readonly constantDeclarations: number;
  readonly mutableDeclarations: number;
  readonly provenConstantListSlots: number;
  readonly recoveredProcedureCallEdges: number;
  readonly recoveredProcedureReturnEdges: number;
  readonly recoveredDispatchers: number;
  readonly recoveredDispatcherRoutes: number;
  readonly recoveredDispatcherTransitions: number;
  readonly recoveredDispatcherTransitionEdges: number;
  readonly unresolvedDispatcherTransitionEdges: number;
  readonly recoveredDispatcherOperations: number;
  readonly recoveredDispatcherStateRails: number;
  readonly recoveredDispatcherTransitionStores: number;
  readonly relationalDispatcherRecoveries: number;
  readonly completeDispatcherRecoveries: number;
  readonly partialDispatcherRecoveries: number;
  readonly structuralOnlyDispatcherRecoveries: number;
  readonly staticDataDependencyEdges: number;
  readonly staticControlDependencyEdges: number;
  readonly tamperCriticalSymbols: number;
  readonly tamperGuardedSymbols: number;
  readonly tamperGuardSites: number;
  readonly tamperRedundantGuardedSymbols: number;
  readonly tamperGuardCoverage: number;
  readonly normalizedOpcodeKinds: number;
  readonly normalizedOpcodeEntropy: number;
  readonly normalizedSignatureDiversity: number;
  readonly normalizedSignatureKinds: number;
  readonly normalizedSignatureDensity: number;
  readonly normalizedSignatureScaleDiversity: number;
  readonly normalizedTopologyKinds: number;
  readonly normalizedTopologyDensity: number;
  readonly normalizedTopologyDiversity: number;
  readonly normalizedTopologyScaleDiversity: number;
  readonly normalizedTopRepeatedSignatures: readonly RepeatedSignature[];
  readonly retainedComponents: number;
  readonly coherentMixedComponents: number;
  readonly retainedComponentQuality: number;
  readonly crossFamilyDependencyKindCount: number;
  readonly crossFamilyDependencyEdges: number;
  readonly crossFamilyDependencyDensity: number;
  readonly semanticDependencyKindCount: number;
  readonly indirectionDensity: number;
  readonly reachableBroadcastSenders: number;
  readonly reachableBroadcastReceivers: number;
  readonly pairedBroadcastChannels: number;
  readonly rawPairedBroadcastChannels: number;
  readonly unpairedBroadcastReceiverHats: number;
  readonly broadcastPairBalance: number;
  readonly retainedBroadcastPairRatio: number;
  readonly reachableProcedures: number;
  readonly procedureTemplateKinds: number;
  readonly procedureTemplateDiversity: number;
  readonly broadcastProcedureTemplateKinds: number;
  readonly procedureWarpVariants: number;
  readonly componentTemplateKinds: number;
  readonly componentTemplateDiversity: number;
  readonly obviousPruneRatio: number;
  readonly normalizedDigest: string;
  readonly retainedComponentShapes: readonly ComponentShape[];
}

export interface ReadabilityComparison {
  readonly originalIdentifierCount: number;
  readonly exposedOriginalIdentifiers: number;
  readonly identifierConcealment: number;
  readonly directChainRecovery: number;
  readonly directChainRecoveryByWidth: Readonly<Record<2 | 3 | 4, number>>;
  readonly normalizedChainRecovery: number;
  readonly normalizedChainRecoveryByWidth: Readonly<Record<2 | 3 | 4, number>>;
  readonly devirtualizedChainRecovery: number;
  readonly devirtualizedChainRecoveryByWidth: Readonly<Record<2 | 3 | 4, number>>;
  readonly normalizedOpcodeRecovery: number;
  readonly normalizedRecovery: number;
  readonly retainedComponentQuality: number;
  readonly indirectionDensity: number;
  readonly structuralQuality: number;
  readonly retainedDependencyQuality: number;
  readonly broadcastTopologyQuality: number;
  readonly templateQuality: number;
  readonly resistanceScore: number;
}

export interface ReadabilityCandidate {
  readonly label: string;
  readonly profile: ReadabilityProfile;
  readonly comparison: ReadabilityComparison;
}

export interface ReadabilityTrend {
  readonly from: string;
  readonly to: string;
  readonly resistanceScoreDelta: number;
  readonly directChainRecoveryDelta: number;
  readonly normalizedRecoveryDelta: number;
  readonly retainedQualityDelta: number;
  readonly indirectionDensityDelta: number;
}

export interface ReadabilityReport {
  readonly schemaVersion: 2;
  readonly baseline: {
    readonly label: 'original';
    readonly profile: ReadabilityProfile;
    readonly comparison: ReadabilityComparison;
  };
  readonly candidates: readonly ReadabilityCandidate[];
  readonly trend: readonly ReadabilityTrend[];
}

export interface RecoveredDispatcherShape {
  readonly targetIndex: number;
  readonly routeCount: number;
  readonly transitionCount: number;
  readonly recoveredTransitionEdges: number;
  readonly unresolvedTransitionEdges: number;
  readonly stateRailCount: number;
  readonly transitionStoreCount: number;
  readonly relational: boolean;
  readonly recoveryStatus: 'complete' | 'partial' | 'structural-only';
  readonly recoveredChains: readonly (readonly string[])[];
}

export interface AdversarialStructure {
  readonly provenConstantListSlots: number;
  readonly recoveredProcedureCallEdges: number;
  readonly recoveredProcedureReturnEdges: number;
  readonly dispatchers: readonly RecoveredDispatcherShape[];
  readonly recoveredDispatcherChains: readonly (readonly string[])[];
  readonly staticDataDependencyEdges: number;
  readonly staticControlDependencyEdges: number;
  readonly tamperCriticalSymbols: number;
  readonly tamperGuardedSymbols: number;
  readonly tamperGuardSites: number;
  readonly tamperRedundantGuardedSymbols: number;
  readonly tamperGuardCoverage: number;
  readonly digest: string;
}

export function createReadabilityReport(
  baselineProject: ScratchLikeProject,
  iterations: readonly ReadabilityIteration[]
): ReadabilityReport;

export function measureProject(project: ScratchLikeProject): ReadabilityProfile;

export function recoverAdversarialStructure(project: ScratchLikeProject): AdversarialStructure;

export function formatReadabilitySummary(report: ReadabilityReport): string;

export function loadProjectFile(path: string): Promise<ScratchLikeProject>;
