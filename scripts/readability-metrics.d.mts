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
  readonly concretelyRecoveredDispatcherTransitionEdges: number;
  readonly symbolicallyRecoveredDispatcherTransitionEdges: number;
  readonly unresolvedDispatcherTransitionEdges: number;
  readonly recoveredDispatcherOperations: number;
  readonly recoveredDispatcherStateRails: number;
  readonly recoveredDispatcherTransitionStores: number;
  readonly relationalDispatcherRecoveries: number;
  readonly completeDispatcherRecoveries: number;
  readonly partialDispatcherRecoveries: number;
  readonly structuralOnlyDispatcherRecoveries: number;
  readonly pathSensitiveDispatcherRecoveries: number;
  readonly symbolicDispatcherRecoveries: number;
  readonly correlatedDispatcherWitnessSymbols: number;
  readonly correlatedDispatcherWitnessPathFamilies: number;
  readonly recoveredDispatcherCandidateTerminalRailFamilies: number;
  readonly initialMatchingDispatcherTerminalRailFamilies: number;
  readonly exhaustiveDispatcherTerminalRailEnumerations: number;
  readonly conditionalDispatcherTerminalRailEnumerations: number;
  readonly staticDataDependencyEdges: number;
  readonly staticControlDependencyEdges: number;
  readonly tamperCriticalSymbols: number;
  readonly tamperGuardedSymbols: number;
  readonly tamperGuardSites: number;
  readonly tamperRedundantGuardedSymbols: number;
  readonly tamperGuardCoverage: number;
  readonly tamperIntegrityPairs: number;
  readonly tamperIntegrityGroups: number;
  readonly tamperCompleteIntegrityGroups: number;
  readonly tamperAmbiguousIntegrityGroups: number;
  readonly tamperLinkedIntegrityGroups: number;
  readonly tamperLinkedIntegrityPairs: number;
  readonly tamperIntegrityLinkEdges: number;
  readonly tamperCompleteIntegrityPairs: number;
  readonly tamperDegradedIntegrityPairs: number;
  readonly tamperDisconnectedIntegrityPairs: number;
  readonly tamperAmbiguousIntegrityPairs: number;
  readonly tamperRefreshPaths: number;
  readonly tamperCoupledRefreshPaths: number;
  readonly tamperGuardPaths: number;
  readonly tamperWatchdogPaths: number;
  readonly tamperTripSinks: number;
  readonly tamperPersistentTripStates: number;
  readonly tamperIndependentIntegrityComponents: number;
  readonly tamperSingleComponentBypasses: number;
  readonly tamperWeakestComponentCut: number | null;
  readonly tamperWeakestStructuralComponentCut: number | null;
  readonly tamperIntegrityCutBound: number;
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
  readonly schemaVersion: 9;
  readonly baseline: {
    readonly label: 'original';
    readonly profile: ReadabilityProfile;
    readonly comparison: ReadabilityComparison;
  };
  readonly candidates: readonly ReadabilityCandidate[];
  readonly trend: readonly ReadabilityTrend[];
}

export interface CandidateTerminalRailFamily {
  readonly state: boolean | number | string;
  readonly tag: boolean | number | string;
  readonly key: boolean | number | string;
  readonly matchesInitialRails: boolean;
  readonly witnessPathCount: number;
}

export interface SymbolicTerminalRailFamily {
  readonly modulus: number;
  readonly parameterMinimum: number;
  readonly parameterMaximum: number;
  readonly cardinality: number;
  readonly state: {readonly offset: number; readonly coefficient: 1};
  readonly tag: {readonly offset: number; readonly coefficient: -1};
  readonly key: {readonly offset: 1; readonly coefficient: 1};
  readonly initialMatchStatus: 'possible' | 'disjoint';
  readonly materializedStateCount: 0;
}

export interface RecoveredDispatcherShape {
  readonly targetIndex: number;
  readonly routeCount: number;
  readonly transitionCount: number;
  readonly recoveredTransitionEdges: number;
  readonly concretelyRecoveredTransitionEdges: number;
  readonly symbolicallyRecoveredTransitionEdges: number;
  readonly unresolvedTransitionEdges: number;
  readonly stateRailCount: number;
  readonly transitionStoreCount: number;
  readonly relational: boolean;
  readonly recoveryMethod:
    | 'none'
    | 'static'
    | 'path-sensitive'
    | 'symbolic'
    | 'cross-handler-symbolic'
    | 'compact-modular-affine'
    | 'typed-record-schema'
    | 'temporal-frame-symbolic'
    | 'temporal-frame-role-order'
    | 'entry-rooted-execution';
  readonly recoveryStatus: 'complete' | 'partial' | 'structural-only';
  readonly entryRouteRecovered: boolean;
  readonly exitStateValidated: boolean;
  readonly witnessSymbolCount: number;
  readonly correlatedWitnessPathFamilies: number;
  readonly correlatedStateDomainStatus:
    | 'not-applicable'
    | 'exhaustive'
    | 'compact-exhaustive'
    | 'overflow';
  readonly correlatedStateDomainLimit: number;
  readonly correlatedStateDomainPeak: number;
  readonly correlatedStateLayerWidths: readonly number[];
  readonly terminalRailEnumerationStatus:
    | 'concrete'
    | 'abstract-exhaustive'
    | 'symbolic-affine-exhaustive'
    | 'conditional-concrete'
    | 'conditional-abstract-exhaustive'
    | 'conditional-symbolic-affine-exhaustive'
    | 'unresolved';
  readonly candidateTerminalRailFamilyCount: number;
  readonly initialMatchingTerminalRailFamilies: number;
  readonly candidateTerminalRailFamilies: readonly CandidateTerminalRailFamily[];
  readonly symbolicTerminalRailFamily: SymbolicTerminalRailFamily | null;
  readonly typedRecordSchema?: TypedRecordSchemaInference;
  readonly temporalFrameSchema?: TemporalFrameSchemaInference;
  readonly universalProgramSchema?: UniversalProgramSchemaInference;
  readonly transientProgramSchema?: TransientProgramSchemaInference;
  readonly centralProgramSchema?: CentralProgramSchemaInference;
  readonly threadedProgramSchema?: ThreadedProgramSchemaInference;
  readonly unresolvedReasons: readonly string[];
  readonly recoveredChains: readonly (readonly string[])[];
}

export interface TypedRecordSchemaInference {
  readonly status: 'complete' | 'complete-with-bounded-widths';
  readonly recordCount: number;
  readonly recordBoundaryCount: number;
  readonly exactRecordWidthCount: number;
  readonly boundedRecordWidthCount: number;
  readonly recordWidthCandidateSets: readonly (readonly number[])[];
  readonly shareBankCount: number;
  readonly shareRoleCount: number;
  readonly decodedOperandCount: number;
  readonly pointerFieldCount: number;
  readonly resultWitnessAssociationCount: number;
  readonly successorConstraintCount: number;
  readonly terminalConstraintCount: number;
  readonly enumeratedResidueCount: 0;
  readonly requiresKeyExecution: false;
  readonly requiresWitnessExecution: false;
}

export interface TemporalFrameSchemaInference {
  readonly status: 'recognized-only' | 'complete';
  readonly handlerCount: number;
  readonly driverCallCount: number;
  readonly frameRailCount: number;
  readonly fragmentStoreCount: number;
  readonly resultWitnessAssociationCount: number;
  readonly nonlinearPredicateCount: number;
  readonly expressionNodeCount: number;
  readonly recurrenceModulus: number | null;
  readonly resultModulus: number | null;
  readonly enumeratedStateCount: number;
  readonly structurallyPropagatedTerms: number;
  readonly routeResidueModulus: number | null;
  readonly routeResidueLeakCount: number;
  readonly routeResidueRecoveryStatus: 'complete' | 'unresolved';
}

export interface UniversalProgramSchemaInference {
  readonly status: 'complete';
  readonly handlerCount: 9;
  readonly commandCount: 4 | 8;
  readonly programCellCount: 257;
  readonly packedDigitCount: 6;
  readonly authenticatedRecordCount: 257;
  readonly liveRecordCount: number;
  readonly staticCodebookRecoveryStatus: 'complete';
  readonly staticRecoveredTransitionEdges: number;
  readonly concreteTraceStatus: 'complete' | 'guard-conditional' | 'unsupported';
  readonly concreteTraceRouteCount: number;
  readonly concreteTraceTransitionCount: number;
  readonly concreteTraceOperationCount: number;
  readonly concreteTraceStateCount: number;
  readonly concreteTraceBound: 8;
  readonly concreteTraceTerminalValidated: boolean;
  readonly objectOrderIndependent: true;
}

export interface TransientProgramSchemaInference {
  readonly status: 'recognized-only' | 'complete';
  readonly handlerCount: number;
  readonly commandCount: 4 | 8;
  readonly stateCellCount: 6;
  readonly codebookCellCount: number;
  readonly authenticatedStateCellCount: 6;
  readonly inlineResultBindingCount: number;
  readonly mutableStateWriterCount: number;
  readonly driverCallCount: number;
  readonly staticCodebookRecoveryStatus: 'complete' | 'unresolved';
  readonly staticPolynomialRecoveryStatus?: 'complete' | 'unresolved';
  readonly staticRecoveredTransitionEdges: number;
  readonly polynomialWordCount?: 3;
  readonly producerFrameCellCount?: 7;
  readonly polynomialEvaluationCount?: number;
  readonly originalDirectChainAbsent?: true;
  readonly concreteTraceStatus: 'complete' | 'guard-conditional' | 'unsupported';
  readonly concreteTraceRouteCount: number;
  readonly concreteTraceTransitionCount: number;
  readonly concreteTraceOperationCount: number;
  readonly concreteTraceStateCount: number;
  readonly concreteTraceBound: 8;
  readonly concreteTraceTerminalValidated: boolean;
  readonly objectOrderIndependent: true;
}

export interface CentralProgramSchemaInference {
  readonly status: 'recognized-only' | 'complete';
  readonly handlerCount: 4;
  readonly commandCount: 4 | 8;
  readonly stateCellCount: 7;
  readonly coefficientCount: 64 | 128;
  readonly inlineResultBindingCount: number;
  readonly mutableStateWriterCount: number;
  readonly driverCallCount: number;
  readonly staticGroupingRecoveryStatus: 'complete' | 'unresolved';
  readonly staticRecoveredTransitionEdges: number;
  readonly nonEntryRecoveredTransitionEdges: number;
  readonly coordinateEnumerationStatus: 'complete' | 'unresolved';
  readonly coordinateDomainSize: 250;
  readonly coordinateEvaluationCount: number;
  readonly coherentCoordinateCount: number;
  readonly entryOrientationRequired: false;
  readonly entryCoordinateValidated: boolean;
  readonly concreteTraceStatus: 'complete' | 'not-required' | 'guard-conditional' | 'unsupported';
  readonly concreteTraceRouteCount: number;
  readonly concreteTraceTransitionCount: number;
  readonly concreteTraceOperationCount: number;
  readonly concreteTraceStateCount: number;
  readonly concreteTraceBound: 8;
  readonly concreteTraceTimerMilliseconds: 0;
  readonly concreteTraceTerminalValidated: boolean;
  readonly originalDirectChainAbsent: true;
  readonly objectOrderIndependent: true;
}

export interface ThreadedProgramSchemaInference {
  readonly status: 'recognized-only' | 'entry-rooted-complete';
  readonly handlerCount: 4;
  readonly commandCount: 4 | 8;
  readonly fieldModulus: 67_108_859;
  readonly stateCellCount: 7;
  readonly encryptedRecordCount: number;
  readonly encryptedRecordWordCount: number;
  readonly packedRailCount: 2;
  readonly feistelRoundCount: 8;
  readonly immutableRecordStoreCount: 1;
  readonly mutableStateWriterCount: number;
  readonly driverCallCount: number;
  readonly staticDirectTableRecoveryStatus: 'unresolved';
  readonly staticAffineRecoveryStatus: 'unresolved';
  readonly staticPolynomialRecoveryStatus: 'unresolved';
  readonly randomAccessNonEntryRecoveredEdges: 0;
  readonly randomAccessValidNonEntryRecordDecrypts: 0;
  readonly randomAccessProbeScope: 'entry-key-reuse-only';
  readonly randomAccessExhaustive: false;
  readonly randomAccessTestedStateCount: number;
  readonly randomAccessTestedKeyHypothesisCount: number;
  readonly fullyKnownPlaintextWordCount: 0 | 1;
  readonly smallDomainPlaintextRailCount: 0 | 1;
  readonly knownPlaintextMarkerGrammarValidated: boolean;
  readonly knownPlaintextKeyRecoveryStatus:
    | 'not-applicable-no-known-plaintext'
    | 'not-attempted-domain-over-limit'
    | 'unsupported';
  readonly knownPlaintextKeyDomainSize: number;
  readonly knownPlaintextKeyEvaluationLimit: 4096;
  readonly knownPlaintextAlgebraicDegreeUpperBound: 256 | null;
  readonly reducedDomainControlStatus: 'complete' | 'not-run';
  readonly feistelGrammarValidated: boolean;
  readonly scanTopologyValidated: boolean;
  readonly commitTopologyValidated: boolean;
  readonly entryRootedRecoveryStatus: 'complete' | 'unsupported';
  readonly entryRootedRecoveredTransitionEdges: number;
  readonly entryRootedRouteCount: number;
  readonly reachablePhysicalStateCount: number;
  readonly reachablePhysicalTransitionCount: number;
  readonly reachablePhysicalPathCount: number;
  readonly recordScanAttemptCount: number;
  readonly wordDecryptCount: number;
  readonly feistelRoundEvaluationCount: number;
  readonly physicalStateLayerWidths: readonly number[];
  readonly entryKeyValidated: boolean;
  readonly terminalStateCount: number;
  readonly terminalValidated: boolean;
  readonly originalDirectChainAbsent: true;
  readonly objectOrderIndependent: true;
  readonly recordWordCount?: 2;
  readonly selectorRecordWordPresent?: false;
  readonly markerRecordWordPresent?: false;
  readonly directlyKnownPlaintextRecordWordCount?: 0;
}

export type IntegrityComponentCutStatus = 'exact' | 'greater-than-bound' | 'ambiguous';

export interface IntegrityPairAnalysis {
  readonly targetIndex: number;
  readonly pairIndex: number;
  readonly integrityGroupIndex: number;
  readonly integrityGroupSize: number;
  readonly authenticatingTagCount: number;
  readonly requiredRefreshesPerWriter: number;
  readonly analysisStatus: 'complete' | 'degraded' | 'disconnected' | 'ambiguous';
  readonly evidenceKinds: readonly ('direct-guard' | 'refresh' | 'sensing-watchdog')[];
  readonly refreshStatus: 'complete' | 'incomplete' | 'not-required';
  readonly gameplayWriterCount: number;
  readonly refreshPathCount: number;
  readonly coupledRefreshPathCount: number;
  readonly unrefreshedWriterCount: number;
  readonly guardPathCount: number;
  readonly watchdogPathCount: number;
  readonly tripSinkCount: number;
  readonly persistentTripStateCount: number;
  readonly persistentTripPathCount: number;
  readonly independentIntegrityComponents: number;
  readonly componentCutStatus: IntegrityComponentCutStatus;
  readonly smallestComponentCut: number | null;
  readonly smallestCutComponentKinds: readonly string[];
  readonly structuralCutStatus: IntegrityComponentCutStatus;
  readonly smallestStructuralComponentCut: number | null;
  readonly smallestStructuralCutComponentKinds: readonly string[];
  readonly singleComponentBypass: boolean | null;
  readonly caveats: readonly string[];
}

export interface TamperIntegrityAnalysis {
  readonly scope: 'bounded-static-integrity-graph';
  readonly status: 'not-applicable' | 'analyzed' | 'degraded' | 'disconnected' | 'partial' | 'ambiguous';
  readonly cutBound: number;
  readonly integrityPairCount: number;
  readonly integrityGroupCount: number;
  readonly completeIntegrityGroupCount: number;
  readonly ambiguousIntegrityGroupCount: number;
  readonly linkedIntegrityGroupCount: number;
  readonly linkedIntegrityPairCount: number;
  readonly integrityLinkEdgeCount: number;
  readonly completePairCount: number;
  readonly degradedPairCount: number;
  readonly disconnectedPairCount: number;
  readonly ambiguousPairCount: number;
  readonly refreshPathCount: number;
  readonly coupledRefreshPathCount: number;
  readonly guardPathCount: number;
  readonly watchdogPathCount: number;
  readonly tripSinkCount: number;
  readonly persistentTripStateCount: number;
  readonly independentIntegrityComponents: number;
  readonly singleComponentBypassCount: number;
  readonly weakestComponentCut: number | null;
  readonly weakestStructuralComponentCut: number | null;
  readonly pairs: readonly IntegrityPairAnalysis[];
  readonly caveats: readonly string[];
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
  readonly tamperIntegrityAnalysis: TamperIntegrityAnalysis;
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
