#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {extname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';
import {strFromU8, unzipSync} from 'fflate';

const SCHEMA_VERSION = 2;
const WATERMARK_NAME = 'Obfuscated by PrioSDK Gen 4.';
const REPORTER_PREFIXES = ['operator_', 'sensing_', 'argument_reporter_'];
const REPORTER_OPCODES = new Set([
  'data_itemoflist',
  'data_itemnumoflist',
  'data_lengthoflist',
  'data_listcontainsitem',
  'data_variable',
  'looks_backdropnumbername',
  'looks_costumenumbername',
  'looks_size',
  'motion_direction',
  'motion_xposition',
  'motion_yposition',
  'sound_volume'
]);
const BRANCH_OPCODES = new Set([
  'control_forever',
  'control_if',
  'control_if_else',
  'control_repeat',
  'control_repeat_until',
  'control_wait_until'
]);
const LIST_INDIRECTION_OPCODES = new Set([
  'data_itemoflist',
  'data_itemnumoflist',
  'data_lengthoflist',
  'data_listcontainsitem',
  'data_replaceitemoflist'
]);
const MAX_FINITE_DOMAIN_VALUES = 16;

export function createReadabilityReport(baselineProject, iterations) {
  assertProject(baselineProject, 'baseline');
  if (!Array.isArray(iterations) || iterations.length === 0) {
    throw new Error('at least one candidate iteration is required');
  }
  const labels = new Set();
  const baselineAnalysis = analyzeProject(baselineProject);
  const baselineIdentifiers = collectOriginalIdentifiers(baselineProject);
  const originalComparison = compareAnalysis(baselineAnalysis, baselineAnalysis, baselineIdentifiers);
  const candidates = iterations.map((iteration) => {
    if (!iteration || typeof iteration.label !== 'string' || iteration.label.length === 0) {
      throw new Error('every candidate iteration needs a non-empty label');
    }
    if (labels.has(iteration.label)) throw new Error(`duplicate candidate label ${JSON.stringify(iteration.label)}`);
    labels.add(iteration.label);
    assertProject(iteration.project, iteration.label);
    const analysis = analyzeProject(iteration.project);
    return {
      label: iteration.label,
      profile: publicProfile(analysis),
      comparison: compareAnalysis(baselineAnalysis, analysis, baselineIdentifiers)
    };
  });
  const trend = [];
  let previousLabel = 'original';
  let previousComparison = originalComparison;
  for (const candidate of candidates) {
    trend.push({
      from: previousLabel,
      to: candidate.label,
      resistanceScoreDelta: rounded(candidate.comparison.resistanceScore - previousComparison.resistanceScore),
      directChainRecoveryDelta: rounded(candidate.comparison.directChainRecovery - previousComparison.directChainRecovery),
      normalizedRecoveryDelta: rounded(candidate.comparison.normalizedRecovery - previousComparison.normalizedRecovery),
      retainedQualityDelta: rounded(candidate.comparison.retainedComponentQuality - previousComparison.retainedComponentQuality),
      indirectionDensityDelta: rounded(candidate.comparison.indirectionDensity - previousComparison.indirectionDensity)
    });
    previousLabel = candidate.label;
    previousComparison = candidate.comparison;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    baseline: {label: 'original', profile: publicProfile(baselineAnalysis), comparison: originalComparison},
    candidates,
    trend
  };
}

export function measureProject(project) {
  assertProject(project, 'project');
  return publicProfile(analyzeProject(project));
}

export function recoverAdversarialStructure(project) {
  assertProject(project, 'project');
  const normalization = analyzeProject(project).normalization;
  const dispatchers = normalization.dispatcherRecovery.machines.map(machine => ({
    targetIndex: machine.targetIndex,
    routeCount: machine.routeCount,
    transitionCount: machine.transitionCount,
    recoveredTransitionEdges: machine.recoveredTransitionEdges,
    unresolvedTransitionEdges: machine.unresolvedTransitionEdges,
    stateRailCount: machine.stateRailCount,
    transitionStoreCount: machine.transitionStoreCount,
    relational: machine.relational,
    recoveryStatus: machine.recoveryStatus,
    recoveredChains: machine.chains
  }));
  const structure = {
    provenConstantListSlots: normalization.provenConstantListSlots,
    recoveredProcedureCallEdges: normalization.procedureFlow.callEdges,
    recoveredProcedureReturnEdges: normalization.procedureFlow.returnEdges,
    dispatchers,
    recoveredDispatcherChains: normalization.dispatcherRecovery.chains,
    staticDataDependencyEdges: normalization.staticDependencies.dataEdges,
    staticControlDependencyEdges: normalization.staticDependencies.controlEdges,
    tamperCriticalSymbols: normalization.staticDependencies.criticalSymbols,
    tamperGuardedSymbols: normalization.staticDependencies.guardedSymbols,
    tamperGuardSites: normalization.staticDependencies.guardSites,
    tamperRedundantGuardedSymbols: normalization.staticDependencies.redundantlyGuardedSymbols,
    tamperGuardCoverage: rounded(normalization.staticDependencies.guardCoverage)
  };
  return {
    ...structure,
    digest: createHash('sha256').update(JSON.stringify(structure)).digest('hex')
  };
}

export function formatReadabilitySummary(report) {
  const lines = [
    'iteration\tscore\tidentifier-concealment\tdirect-chain-recovery\tnormalized-recovery\tdevirtualized-recovery\tdispatchers\tdispatcher-routes\tdispatcher-edges\tdispatcher-unresolved\tdispatcher-complete\tdispatcher-partial\tdispatcher-structural-only\ttamper-coverage\tretained-quality\tindirection\tdependencies\tsignature-scale\ttopology-scale\tmax-signature-share\tpaired-channels\tbroadcast-templates\tprune-ratio\tobvious-never-sent-hats'
  ];
  for (const candidate of [report.baseline, ...report.candidates]) {
    const comparison = candidate.comparison;
    const profile = candidate.profile;
    lines.push([
      candidate.label,
      comparison.resistanceScore.toFixed(3),
      comparison.identifierConcealment.toFixed(3),
      comparison.directChainRecovery.toFixed(3),
      comparison.normalizedRecovery.toFixed(3),
      comparison.devirtualizedChainRecovery.toFixed(3),
      String(profile.recoveredDispatchers),
      String(profile.recoveredDispatcherRoutes),
      String(profile.recoveredDispatcherTransitionEdges),
      String(profile.unresolvedDispatcherTransitionEdges),
      String(profile.completeDispatcherRecoveries),
      String(profile.partialDispatcherRecoveries),
      String(profile.structuralOnlyDispatcherRecoveries),
      profile.tamperGuardCoverage.toFixed(3),
      comparison.retainedComponentQuality.toFixed(3),
      comparison.indirectionDensity.toFixed(3),
      String(profile.semanticDependencyKindCount),
      profile.normalizedSignatureScaleDiversity.toFixed(3),
      profile.normalizedTopologyScaleDiversity.toFixed(3),
      (profile.normalizedTopRepeatedSignatures[0]?.share ?? 0).toFixed(3),
      String(profile.pairedBroadcastChannels),
      String(profile.broadcastProcedureTemplateKinds),
      profile.obviousPruneRatio.toFixed(3),
      String(profile.neverSentBroadcastHats)
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export async function loadProjectFile(path) {
  const bytes = new Uint8Array(await readFile(path));
  let source;
  if (extname(path).toLowerCase() === '.sb3') {
    const archive = unzipSync(bytes);
    const projectBytes = archive['project.json'];
    if (!projectBytes) throw new Error(`${path} has no project.json entry`);
    source = strFromU8(projectBytes);
  } else {
    source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  }
  const project = JSON.parse(source);
  assertProject(project, path);
  return project;
}

function analyzeProject(project) {
  const rawBlocks = collectBlocks(project);
  const originalIdentifiers = collectOriginalIdentifiers(project);
  const normalization = normalizeProject(project);
  const candidateStrings = collectStrings(project);
  for (const value of normalization.recoveredConstantStrings) candidateStrings.add(value);
  const opcodes = rawBlocks.map((entry) => entry.block.opcode);
  const rawSignatures = rawBlocks.map((entry) => localBlockSignature(entry.target.blocks, entry.block));
  const rawFamilyCounts = countValues(opcodes.map(opcodeFamily));
  const rawOpcodeCounts = countValues(opcodes);
  const rawReporterIds = inputReferencedReporterIds(project);
  const dormantBroadcasts = measureDormantBroadcastSurface(project);
  const topLevelRoots = rawBlocks.filter((entry) => entry.block.topLevel);
  const broadcastHats = topLevelRoots.filter((entry) => entry.block.opcode === 'event_whenbroadcastreceived');
  const customDefinitions = rawBlocks.filter((entry) => entry.block.opcode === 'procedures_definition').length;
  const customCalls = rawBlocks.filter((entry) => entry.block.opcode === 'procedures_call').length;
  const operators = rawBlocks.filter((entry) => entry.block.opcode.startsWith('operator_')).length;
  const reporters = rawBlocks.filter((entry) => rawReporterIds.has(entry.key) || isReporterOpcode(entry.block.opcode)).length;
  const branchBlocks = rawBlocks.filter((entry) => BRANCH_OPCODES.has(entry.block.opcode)).length;
  const listIndirections = rawBlocks.filter((entry) => LIST_INDIRECTION_OPCODES.has(entry.block.opcode)).length;
  return {
    project,
    originalIdentifiers,
    candidateStrings,
    rawBlocks,
    rawOpcodeCounts,
    rawChains: extractChains(project, normalization.reachable, normalization.simpleProcedures),
    profile: {
      objectBlocks: rawBlocks.length,
      blockEquivalents: countBlockEquivalents(project),
      opcodeKinds: rawOpcodeCounts.size,
      opcodeEntropy: normalizedEntropy(rawOpcodeCounts),
      opcodeSignatureDiversity: distributionDiversity(countValues(rawSignatures)),
      opcodeFamilyKinds: rawFamilyCounts.size,
      topLevelRoots: topLevelRoots.length,
      runnableHats: topLevelRoots.filter((entry) => isRunnableHat(entry.block.opcode)).length,
      broadcastReceiverHats: broadcastHats.length,
      neverSentBroadcastHats: normalization.neverSentBroadcastHats,
      dormantBroadcastHats: dormantBroadcasts.hats,
      stateGatedBroadcastCommands: dormantBroadcasts.commands,
      customDefinitions,
      customCalls,
      reporters,
      operators,
      branchBlocks,
      listIndirections,
      retainedAfterNormalization: normalization.nodes.size,
      prunedByNormalizer: Math.max(0, rawBlocks.length - normalization.nodes.size),
      foldedReporters: normalization.folded.size,
      inlinedProcedures: normalization.inlinedProcedureCalls,
      provenFalseControls: normalization.provenFalseControls,
      constantDeclarations: normalization.constantDeclarations,
      mutableDeclarations: normalization.mutableDeclarations,
      provenConstantListSlots: normalization.provenConstantListSlots,
      recoveredProcedureCallEdges: normalization.procedureFlow.callEdges,
      recoveredProcedureReturnEdges: normalization.procedureFlow.returnEdges,
      recoveredDispatchers: normalization.dispatcherRecovery.machines.length,
      recoveredDispatcherRoutes: normalization.dispatcherRecovery.routeCount,
      recoveredDispatcherTransitions: normalization.dispatcherRecovery.transitionCount,
      recoveredDispatcherTransitionEdges: normalization.dispatcherRecovery.recoveredTransitionEdges,
      unresolvedDispatcherTransitionEdges: normalization.dispatcherRecovery.unresolvedTransitionEdges,
      recoveredDispatcherOperations: normalization.dispatcherRecovery.operationCount,
      recoveredDispatcherStateRails: normalization.dispatcherRecovery.stateRailCount,
      recoveredDispatcherTransitionStores: normalization.dispatcherRecovery.transitionStoreCount,
      relationalDispatcherRecoveries: normalization.dispatcherRecovery.relationalCount,
      completeDispatcherRecoveries: normalization.dispatcherRecovery.completeCount,
      partialDispatcherRecoveries: normalization.dispatcherRecovery.partialCount,
      structuralOnlyDispatcherRecoveries: normalization.dispatcherRecovery.structuralOnlyCount,
      staticDataDependencyEdges: normalization.staticDependencies.dataEdges,
      staticControlDependencyEdges: normalization.staticDependencies.controlEdges,
      tamperCriticalSymbols: normalization.staticDependencies.criticalSymbols,
      tamperGuardedSymbols: normalization.staticDependencies.guardedSymbols,
      tamperGuardSites: normalization.staticDependencies.guardSites,
      tamperRedundantGuardedSymbols: normalization.staticDependencies.redundantlyGuardedSymbols,
      tamperGuardCoverage: normalization.staticDependencies.guardCoverage,
      normalizedOpcodeKinds: normalization.opcodeCounts.size,
      normalizedOpcodeEntropy: normalizedEntropy(normalization.opcodeCounts),
      normalizedSignatureDiversity: distributionDiversity(normalization.signatureCounts),
      normalizedSignatureKinds: normalization.signatureCounts.size,
      normalizedSignatureDensity: ratio(normalization.signatureCounts.size, normalization.nodes.size),
      normalizedSignatureScaleDiversity: scaleDiversity(normalization.signatureCounts.size, normalization.nodes.size),
      normalizedTopologyKinds: normalization.topologyCounts.size,
      normalizedTopologyDensity: ratio(normalization.topologyCounts.size, normalization.nodes.size),
      normalizedTopologyDiversity: distributionDiversity(normalization.topologyCounts),
      normalizedTopologyScaleDiversity: scaleDiversity(normalization.topologyCounts.size, normalization.nodes.size),
      normalizedTopRepeatedSignatures: topRepeatedSignatures(normalization.signatureCounts),
      retainedComponents: normalization.components.length,
      coherentMixedComponents: normalization.components.filter(component => component.coherent).length,
      retainedComponentQuality: weightedMean(
        normalization.components.map(component => [component.quality, component.shape.nodes])
      ),
      crossFamilyDependencyKindCount: normalization.crossFamilyDependencyKinds.length,
      crossFamilyDependencyEdges: normalization.crossFamilyDependencyEdges,
      crossFamilyDependencyDensity: ratio(normalization.crossFamilyDependencyEdges, normalization.nodes.size),
      semanticDependencyKindCount: normalization.semanticDependencyKinds.length,
      indirectionDensity: normalization.indirectionDensity,
      reachableBroadcastSenders: normalization.broadcastMetrics.reachableSenders,
      reachableBroadcastReceivers: normalization.broadcastMetrics.reachableReceivers,
      pairedBroadcastChannels: normalization.broadcastMetrics.pairedChannels,
      rawPairedBroadcastChannels: normalization.broadcastMetrics.rawPairedChannels,
      unpairedBroadcastReceiverHats: normalization.broadcastMetrics.unpairedReceiverHats,
      broadcastPairBalance: normalization.broadcastMetrics.pairBalance,
      retainedBroadcastPairRatio: normalization.broadcastMetrics.retainedPairRatio,
      reachableProcedures: normalization.procedureTemplates.count,
      procedureTemplateKinds: normalization.procedureTemplates.kinds,
      procedureTemplateDiversity: normalization.procedureTemplates.diversity,
      broadcastProcedureTemplateKinds: normalization.procedureTemplates.broadcastKinds,
      procedureWarpVariants: normalization.procedureTemplates.warpVariants,
      componentTemplateKinds: new Set(normalization.components.map(component => component.shape.digest)).size,
      componentTemplateDiversity: ratio(
        new Set(normalization.components.map(component => component.shape.digest)).size,
        normalization.components.length
      ),
      obviousPruneRatio: ratio(Math.max(0, rawBlocks.length - normalization.nodes.size), rawBlocks.length),
      normalizedDigest: normalization.digest,
      retainedComponentShapes: normalization.components.map(component => component.shape)
    },
    normalization
  };
}

function publicProfile(analysis) {
  return {
    ...analysis.profile,
    opcodeEntropy: rounded(analysis.profile.opcodeEntropy),
    opcodeSignatureDiversity: rounded(analysis.profile.opcodeSignatureDiversity),
    normalizedOpcodeEntropy: rounded(analysis.profile.normalizedOpcodeEntropy),
    normalizedSignatureDiversity: rounded(analysis.profile.normalizedSignatureDiversity),
    normalizedSignatureDensity: rounded(analysis.profile.normalizedSignatureDensity),
    normalizedSignatureScaleDiversity: rounded(analysis.profile.normalizedSignatureScaleDiversity),
    normalizedTopologyDensity: rounded(analysis.profile.normalizedTopologyDensity),
    normalizedTopologyDiversity: rounded(analysis.profile.normalizedTopologyDiversity),
    normalizedTopologyScaleDiversity: rounded(analysis.profile.normalizedTopologyScaleDiversity),
    retainedComponentQuality: rounded(analysis.profile.retainedComponentQuality),
    crossFamilyDependencyDensity: rounded(analysis.profile.crossFamilyDependencyDensity),
    indirectionDensity: rounded(analysis.profile.indirectionDensity),
    broadcastPairBalance: rounded(analysis.profile.broadcastPairBalance),
    retainedBroadcastPairRatio: rounded(analysis.profile.retainedBroadcastPairRatio),
    procedureTemplateDiversity: rounded(analysis.profile.procedureTemplateDiversity),
    componentTemplateDiversity: rounded(analysis.profile.componentTemplateDiversity),
    obviousPruneRatio: rounded(analysis.profile.obviousPruneRatio),
    tamperGuardCoverage: rounded(analysis.profile.tamperGuardCoverage)
  };
}

function compareAnalysis(baseline, candidate, baselineIdentifiers) {
  const exposedIdentifiers = [...baselineIdentifiers].filter(identifier => identifierPresent(candidate, identifier));
  const identifierExposure = ratio(exposedIdentifiers.length, baselineIdentifiers.size);
  const directChainRecovery = ngramRecovery(baseline.rawChains, candidate.rawChains);
  const directChainRecoveryByWidth = ngramRecoveryByWidth(baseline.rawChains, candidate.rawChains);
  const normalizedChainRecovery = ngramRecovery(
    baseline.normalization.chains,
    candidate.normalization.chains
  );
  const normalizedChainRecoveryByWidth = ngramRecoveryByWidth(
    baseline.normalization.chains,
    candidate.normalization.chains
  );
  const devirtualizedChainRecovery = ngramRecovery(
    baseline.normalization.devirtualizedChains,
    candidate.normalization.devirtualizedChains
  );
  const devirtualizedChainRecoveryByWidth = ngramRecoveryByWidth(
    baseline.normalization.devirtualizedChains,
    candidate.normalization.devirtualizedChains
  );
  const normalizedOpcodeRecovery = multisetRecall(
    baseline.normalization.opcodeCounts,
    candidate.normalization.opcodeCounts
  );
  const normalizedRecovery = Math.max(normalizedChainRecovery, devirtualizedChainRecovery);
  const retainedComponentQuality = candidate.profile.retainedComponentQuality;
  const structuralQuality = mean([
    candidate.profile.normalizedOpcodeEntropy,
    candidate.profile.normalizedSignatureScaleDiversity,
    candidate.profile.normalizedTopologyScaleDiversity,
    retainedComponentQuality,
    saturate(candidate.profile.semanticDependencyKindCount / 7)
  ]);
  const indirectionDensity = candidate.profile.indirectionDensity;
  const indirectionStrength = saturate(indirectionDensity / 0.28);
  const retainedDependencyQuality = mean([
    retainedComponentQuality,
    saturate(candidate.profile.crossFamilyDependencyDensity / 0.30),
    saturate(candidate.profile.semanticDependencyKindCount / 7)
  ]);
  const broadcastTopologyQuality = candidate.profile.pairedBroadcastChannels === 0 ? 0 : mean([
    candidate.profile.broadcastPairBalance,
    candidate.profile.retainedBroadcastPairRatio,
    saturate(candidate.profile.pairedBroadcastChannels / 3)
  ]);
  const templateQuality = candidate.profile.reachableProcedures === 0 ? 0 : mean([
    candidate.profile.procedureTemplateDiversity,
    saturate(candidate.profile.broadcastProcedureTemplateKinds / 3),
    saturate(candidate.profile.procedureWarpVariants / 2)
  ]);
  const resistanceSignals = (
    ((1 - identifierExposure) * 0.18)
    + ((1 - directChainRecovery) * 0.18)
    + ((1 - normalizedRecovery) * 0.22)
    + (structuralQuality * 0.12)
    + (indirectionStrength * 0.10)
    + (retainedDependencyQuality * 0.09)
    + (broadcastTopologyQuality * 0.04)
    + (templateQuality * 0.04)
  );
  const resistance = (resistanceSignals / 0.97) * 100;
  return {
    originalIdentifierCount: baselineIdentifiers.size,
    exposedOriginalIdentifiers: exposedIdentifiers.length,
    identifierConcealment: rounded(1 - identifierExposure),
    directChainRecovery: rounded(directChainRecovery),
    directChainRecoveryByWidth: roundWidthRecovery(directChainRecoveryByWidth),
    normalizedChainRecovery: rounded(normalizedChainRecovery),
    normalizedChainRecoveryByWidth: roundWidthRecovery(normalizedChainRecoveryByWidth),
    devirtualizedChainRecovery: rounded(devirtualizedChainRecovery),
    devirtualizedChainRecoveryByWidth: roundWidthRecovery(devirtualizedChainRecoveryByWidth),
    normalizedOpcodeRecovery: rounded(normalizedOpcodeRecovery),
    normalizedRecovery: rounded(normalizedRecovery),
    retainedComponentQuality: rounded(retainedComponentQuality),
    indirectionDensity: rounded(indirectionDensity),
    structuralQuality: rounded(structuralQuality),
    retainedDependencyQuality: rounded(retainedDependencyQuality),
    broadcastTopologyQuality: rounded(broadcastTopologyQuality),
    templateQuality: rounded(templateQuality),
    resistanceScore: rounded(resistance)
  };
}

function normalizeProject(project) {
  const proceduresByTarget = project.targets.map(target => collectProcedures(target));
  const simpleProceduresByTarget = project.targets.map((target, targetIndex) => (
    collectSimpleProcedures(target, proceduresByTarget[targetIndex] ?? new Map())
  ));
  const reachability = collectProjectReachability(project, proceduresByTarget);
  const targetAnalyses = project.targets.map((target, targetIndex) => normalizeTarget(
    project,
    target,
    targetIndex,
    proceduresByTarget[targetIndex] ?? new Map(),
    simpleProceduresByTarget[targetIndex] ?? new Map(),
    reachability.reachableByTarget[targetIndex] ?? new Set(),
    reachability.symbolDomains
  ));
  const nodes = new Map();
  const folded = new Set();
  const recoveredConstantStrings = new Set();
  const chains = [];
  let inlinedProcedureCalls = 0;
  let indirectionBlocks = 0;
  let provenFalseControls = 0;
  for (const targetAnalysis of targetAnalyses) {
    for (const [key, node] of targetAnalysis.nodes) nodes.set(key, node);
    for (const key of targetAnalysis.folded) folded.add(key);
    for (const value of targetAnalysis.recoveredConstantStrings) recoveredConstantStrings.add(value);
    chains.push(...targetAnalysis.chains);
    inlinedProcedureCalls += targetAnalysis.inlinedProcedureCalls;
    indirectionBlocks += targetAnalysis.indirectionBlocks;
    provenFalseControls += targetAnalysis.provenFalseControls;
  }
  addBroadcastEdges(project, nodes, reachability);
  const procedureFlow = recoverProcedureFlow(
    project,
    nodes,
    proceduresByTarget,
    reachability.reachableByTarget
  );
  const dispatcherRecovery = recoverDispatcherMachines(
    project,
    proceduresByTarget,
    reachability.reachableByTarget,
    reachability.symbolDomains
  );
  const staticDependencies = measureStaticDependencies(project, proceduresByTarget);
  const graphMetrics = measureNormalizedGraph(nodes, reachability.activeRoots.filter(key => nodes.has(key)));
  const opcodeCounts = countValues([...nodes.values()].map(node => node.opcode));
  const signatures = new Set([...nodes.values()].map(node => node.signature));
  const signatureCounts = countValues([...nodes.values()].map(node => node.signature));
  const topologyCounts = topologySignatureCounts(nodes);
  const canonical = canonicalTarget(nodes, graphMetrics.components);
  const broadcastMetrics = measureReachableBroadcasts(project, reachability);
  const procedureTemplates = measureProcedureTemplates(
    project,
    proceduresByTarget,
    reachability.reachableByTarget
  );
  return {
    nodes,
    folded,
    recoveredConstantStrings,
    chains,
    devirtualizedChains: [...chains, ...dispatcherRecovery.chains],
    components: graphMetrics.components.sort(compareComponent),
    neverSentBroadcastHats: reachability.neverSentBroadcastHats,
    inlinedProcedureCalls,
    provenFalseControls,
    constantDeclarations: reachability.constantValues.size,
    mutableDeclarations: reachability.unknownSymbols.size,
    provenConstantListSlots: reachability.constantListSlots.size,
    opcodeCounts,
    signatures,
    signatureCounts,
    topologyCounts,
    crossFamilyDependencyKinds: graphMetrics.crossFamilyDependencyKinds,
    crossFamilyDependencyEdges: graphMetrics.crossFamilyDependencyEdges,
    semanticDependencyKinds: graphMetrics.semanticDependencyKinds,
    indirectionDensity: ratio(indirectionBlocks, nodes.size),
    digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    reachable: new Set(targetAnalyses.flatMap(analysis => [...analysis.reachable])),
    simpleProcedures: new Map(targetAnalyses.flatMap(analysis => [...analysis.simpleProcedures])),
    broadcastMetrics,
    procedureTemplates,
    procedureFlow,
    dispatcherRecovery,
    staticDependencies
  };
}

function normalizeTarget(project, target, targetIndex, procedures, simpleProcedures, reachable, constantValues) {
  const prefix = `t${targetIndex}:`;
  const foldedLocal = new Set();
  const recoveredConstantStrings = new Set();
  const transparentLocal = new Set();
  const simpleBodyIds = new Set([...simpleProcedures.values()].flatMap(procedure => procedure.bodyIds));
  for (const id of reachable) {
    const block = target.blocks[id];
    if (isBlock(block) && isReporterOpcode(block.opcode)) {
      const evaluation = evaluateReporter(project, targetIndex, id, constantValues, new Set());
      if (evaluation.known) {
        foldedLocal.add(id);
        recoveredConstantStrings.add(String(evaluation.value));
      }
    }
    if (isBlock(block) && block.opcode === 'control_if') {
      const result = evaluateCondition(project, targetIndex, block, constantValues);
      if (result.known && !scratchBoolean(result.value)) transparentLocal.add(id);
    }
  }
  const nodes = new Map();
  let inlinedProcedureCalls = 0;
  for (const id of reachable) {
    const block = target.blocks[id];
    if (!isBlock(block) || foldedLocal.has(id) || transparentLocal.has(id) || simpleBodyIds.has(id)) continue;
    if (block.opcode === 'procedures_definition' || block.opcode === 'procedures_prototype') continue;
    let opcode = block.opcode;
    if (block.opcode === 'procedures_call') {
      const simple = simpleProcedures.get(procedureCode(block));
      if (simple) {
        opcode = `inline(${simple.opcodes.join(',')})`;
        inlinedProcedureCalls += 1;
      }
    }
    nodes.set(`${prefix}${id}`, {
      id: `${prefix}${id}`,
      localId: id,
      opcode,
      family: opcodeFamily(opcode),
      signature: localBlockSignature(target.blocks, block, foldedLocal, simpleProcedures),
      block,
      edges: []
    });
  }
  for (const node of nodes.values()) {
    const edges = collectNormalizedEdges(
      project,
      targetIndex,
      node.block,
      procedures,
      simpleProcedures,
      foldedLocal,
      transparentLocal,
      simpleBodyIds,
      constantValues
    );
    for (const edge of edges) {
      const key = `${prefix}${edge}`;
      if (nodes.has(key)) node.edges.push(key);
    }
    node.edges.sort(compareUtf8);
  }
  const chains = extractTargetChains(target, reachable, simpleProcedures, transparentLocal);
  const folded = new Set([...foldedLocal].map(id => `${prefix}${id}`));
  return {
    nodes,
    folded,
    recoveredConstantStrings,
    chains,
    inlinedProcedureCalls,
    provenFalseControls: transparentLocal.size,
    indirectionBlocks: [...nodes.values()].filter(node => isIndirectionOpcode(node.opcode)).length,
    reachable: [...reachable].map(id => `${prefix}${id}`),
    simpleProcedures: [...simpleProcedures].map(([code, procedure]) => [`${prefix}${code}`, procedure])
  };
}

function recoverProcedureFlow(project, nodes, proceduresByTarget, reachableByTarget) {
  const callEdges = new Set();
  const returnEdges = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const reachable = reachableByTarget[targetIndex] ?? new Set();
    const procedures = proceduresByTarget[targetIndex] ?? new Map();
    for (const id of [...reachable].sort(compareUtf8)) {
      const block = target.blocks[id];
      if (!isBlock(block) || block.opcode !== 'procedures_call') continue;
      const procedure = procedures.get(procedureCode(block));
      const callNode = nodes.get(blockKey(targetIndex, id));
      if (!procedure || !callNode) continue;
      const bodyNode = firstNormalizedStackNode(target, targetIndex, procedure.bodyId, nodes);
      if (!bodyNode || !callNode.edges.includes(bodyNode.id)) continue;
      callEdges.add(`${callNode.id}->${bodyNode.id}`);
      if (typeof block.next !== 'string') continue;
      const successor = firstNormalizedStackNode(target, targetIndex, block.next, nodes);
      if (!successor) continue;
      const exit = lastNormalizedMainStackNode(target, targetIndex, procedure.bodyId, nodes);
      if (!exit || exit.edges.includes(successor.id)) continue;
      exit.edges.push(successor.id);
      exit.edges.sort(compareUtf8);
      returnEdges.add(`${exit.id}->${successor.id}`);
    }
  }
  return {callEdges: callEdges.size, returnEdges: returnEdges.size};
}

function firstNormalizedStackNode(target, targetIndex, startId, nodes) {
  const visited = new Set();
  let id = startId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const node = nodes.get(blockKey(targetIndex, id));
    if (node) return node;
    const block = target.blocks[id];
    if (!isBlock(block)) return undefined;
    id = block.next;
  }
  return undefined;
}

function lastNormalizedMainStackNode(target, targetIndex, startId, nodes) {
  const visited = new Set();
  let id = startId;
  let last;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const node = nodes.get(blockKey(targetIndex, id));
    if (node) last = node;
    const block = target.blocks[id];
    if (!isBlock(block)) break;
    id = block.next;
  }
  return last;
}

function recoverDispatcherMachines(project, proceduresByTarget, reachableByTarget, symbolDomains) {
  const machines = [];
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const procedures = proceduresByTarget[targetIndex] ?? new Map();
    const reachable = reachableByTarget[targetIndex] ?? new Set();
    const orderedProcedures = [...procedures.entries()].sort(([left], [right]) => compareUtf8(left, right));
    for (const [dispatcherCode, procedure] of orderedProcedures) {
      if (!reachable.has(procedure.bodyId)) continue;
      const parsedRoutes = collectDispatcherRoutes(
        project,
        target,
        targetIndex,
        procedure.bodyId,
        symbolDomains
      );
      if (!parsedRoutes || parsedRoutes.routes.length < 4) continue;
      const handlerRoots = new Map();
      const routesByProcedure = new Map();
      for (const route of parsedRoutes.routes) {
        const routes = routesByProcedure.get(route.procedureCode) ?? [];
        routes.push(route);
        routesByProcedure.set(route.procedureCode, routes);
      }
      for (const [procedureCode, routes] of [...routesByProcedure].sort(([left], [right]) => compareUtf8(left, right))) {
        const handlerProcedure = procedures.get(procedureCode);
        if (!handlerProcedure) continue;
        for (const [pair, bodyId] of recoverDispatcherHandlerRoots(
          project,
          target,
          targetIndex,
          handlerProcedure.bodyId,
          routes,
          parsedRoutes,
          symbolDomains
        )) handlerRoots.set(pair, bodyId);
      }
      const handlers = [];
      for (const route of parsedRoutes.routes) {
        const handlerProcedure = procedures.get(route.procedureCode);
        if (!handlerProcedure || route.procedureCode === dispatcherCode) continue;
        const handlerRoot = handlerRoots.get(route.pair);
        if (typeof handlerRoot !== 'string') continue;
        const handler = recoverDispatcherHandler(
          project,
          target,
          targetIndex,
          handlerRoot,
          dispatcherCode,
          parsedRoutes,
          symbolDomains
        );
        if (handler) handlers.push({...handler, entryPair: route.pair, procedureCode: route.procedureCode});
      }
      if (handlers.length < 4) continue;
      const recovered = parsedRoutes.relational
        ? recoverRelationalDispatcher(
            project,
            target,
            targetIndex,
            dispatcherCode,
            parsedRoutes,
            handlers,
            procedures,
            symbolDomains
          )
        : recoverDirectDispatcher(
            project,
            target,
            targetIndex,
            parsedRoutes,
            handlers,
            procedures,
            dispatcherCode
          );
      machines.push({
        targetIndex,
        routeCount: parsedRoutes.routes.length,
        transitionCount: handlers.length,
        recoveredTransitionEdges: recovered.recoveredTransitionEdges,
        unresolvedTransitionEdges: recovered.unresolvedTransitionEdges,
        stateRailCount: parsedRoutes.rails.length,
        transitionStoreCount: new Set(handlers.flatMap(handler => handler.transitionStores)).size,
        relational: parsedRoutes.relational,
        recoveryStatus: recovered.recoveryStatus,
        chains: recovered.chains
      });
    }
  }
  machines.sort((left, right) => (
    left.targetIndex - right.targetIndex || compareUtf8(JSON.stringify(left.chains), JSON.stringify(right.chains))
  ));
  const chains = machines.flatMap(machine => machine.chains);
  return {
    machines,
    chains,
    routeCount: machines.reduce((sum, machine) => sum + machine.routeCount, 0),
    transitionCount: machines.reduce((sum, machine) => sum + machine.transitionCount, 0),
    recoveredTransitionEdges: machines.reduce((sum, machine) => sum + machine.recoveredTransitionEdges, 0),
    unresolvedTransitionEdges: machines.reduce((sum, machine) => sum + machine.unresolvedTransitionEdges, 0),
    operationCount: chains.reduce((sum, chain) => sum + chain.length, 0),
    stateRailCount: machines.reduce((sum, machine) => sum + machine.stateRailCount, 0),
    transitionStoreCount: machines.reduce((sum, machine) => sum + machine.transitionStoreCount, 0),
    relationalCount: machines.filter(machine => machine.relational).length,
    completeCount: machines.filter(machine => machine.recoveryStatus === 'complete').length,
    partialCount: machines.filter(machine => machine.recoveryStatus === 'partial').length,
    structuralOnlyCount: machines.filter(machine => machine.recoveryStatus === 'structural-only').length
  };
}

function collectDispatcherRoutes(project, target, targetIndex, bodyId, symbolDomains) {
  const routes = [];
  const visited = new Set();
  let id = bodyId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const branch = target.blocks[id];
    if (!isBlock(branch) || (branch.opcode !== 'control_if' && branch.opcode !== 'control_if_else')) break;
    const conditionId = activeInputSlots(branch.inputs?.CONDITION)[0];
    const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
    const parsed = isBlock(condition)
      ? parseDispatcherCondition(project, target, targetIndex, condition, symbolDomains)
      : undefined;
    const callId = activeInputSlots(branch.inputs?.SUBSTACK)[0];
    const call = typeof callId === 'string' ? target.blocks[callId] : undefined;
    if (!parsed || !isBlock(call) || call.opcode !== 'procedures_call') return undefined;
    routes.push({...parsed, procedureCode: procedureCode(call)});
    const next = branch.opcode === 'control_if_else'
      ? activeInputSlots(branch.inputs?.SUBSTACK2)[0]
      : branch.next;
    id = typeof next === 'string' ? next : null;
  }
  if (routes.length < 2) return undefined;
  const dataRails = uniqueSorted(routes.flatMap(route => [...route.expectations.keys()]));
  const keyRails = uniqueSorted(routes.flatMap(route => [...route.expectations.values()]
    .flatMap(expectation => expectation.kind === 'keyed' ? [expectation.keySymbol] : [])));
  const relational = keyRails.length > 0;
  const rails = uniqueSorted([...dataRails, ...keyRails]);
  const expectedShape = relational
    ? dataRails.length === 2 && keyRails.length === 1 && rails.length === 3
    : dataRails.length >= 1 && dataRails.length <= 2 && keyRails.length === 0;
  if (!expectedShape || routes.some(route => route.expectations.size !== dataRails.length)) {
    return undefined;
  }
  const canonicalRoutes = [];
  for (const route of routes) {
    if (dataRails.some(rail => !route.expectations.has(rail))) return undefined;
    const routeRelations = [...route.expectations.values()];
    if (relational && routeRelations.some(relation => (
      relation.kind !== 'keyed' || relation.keySymbol !== keyRails[0]
    ))) return undefined;
    if (!relational && routeRelations.some(relation => relation.kind !== 'constant')) return undefined;
    canonicalRoutes.push({...route, pair: dispatcherRouteKey(dataRails, route.expectations)});
  }
  return {rails, dataRails, keyRails, relational, routes: canonicalRoutes};
}

function recoverDispatcherHandlerRoots(
  project,
  target,
  targetIndex,
  bodyId,
  routes,
  dispatcher,
  symbolDomains
) {
  if (routes.length === 1) return new Map([[routes[0].pair, bodyId]]);
  if (!dispatcher.relational) return new Map();
  const guardedRoots = new Map();
  const visited = new Set();
  let id = bodyId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const branch = target.blocks[id];
    if (!isBlock(branch) || branch.opcode !== 'control_if_else') break;
    const conditionId = activeInputSlots(branch.inputs?.CONDITION)[0];
    const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
    const guard = isBlock(condition)
      ? parseHandlerSelectionGuard(project, target, targetIndex, condition, dispatcher, symbolDomains)
      : undefined;
    const root = activeInputSlots(branch.inputs?.SUBSTACK)[0];
    const alternate = activeInputSlots(branch.inputs?.SUBSTACK2)[0];
    if (guard === undefined || typeof root !== 'string' || typeof alternate !== 'string') return new Map();
    const key = scratchEqualityKey(guard);
    if (guardedRoots.has(key)) return new Map();
    guardedRoots.set(key, root);
    id = alternate;
  }
  if (typeof id !== 'string' || guardedRoots.size !== routes.length - 1) return new Map();
  const roots = new Map();
  const unmatched = [];
  for (const route of routes) {
    const invariant = keyedRouteInvariant(route, dispatcher);
    const root = invariant === undefined ? undefined : guardedRoots.get(scratchEqualityKey(invariant));
    if (typeof root === 'string') roots.set(route.pair, root);
    else unmatched.push(route);
  }
  if (roots.size !== routes.length - 1 || unmatched.length !== 1) return new Map();
  roots.set(unmatched[0].pair, id);
  return roots;
}

function parseHandlerSelectionGuard(project, target, targetIndex, condition, dispatcher, symbolDomains) {
  if (condition.opcode !== 'operator_equals') return undefined;
  const operands = [
    activeInputSlots(condition.inputs?.OPERAND1)[0],
    activeInputSlots(condition.inputs?.OPERAND2)[0]
  ];
  for (const [sumIndex, valueIndex] of [[0, 1], [1, 0]]) {
    const sumId = operands[sumIndex];
    const sum = typeof sumId === 'string' ? target.blocks[sumId] : undefined;
    if (!isBlock(sum) || sum.opcode !== 'operator_add') continue;
    const symbols = ['NUM1', 'NUM2'].flatMap(name => {
      const reporterId = activeInputSlots(sum.inputs?.[name])[0];
      const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
      return isBlock(reporter) && reporter.opcode === 'data_variable'
        ? fieldSymbolKeys(project, targetIndex, 'variable', reporter.fields?.VARIABLE)
        : [];
    });
    if (symbols.length !== 2
      || new Set(symbols).size !== dispatcher.dataRails.length
      || dispatcher.dataRails.some(rail => !symbols.includes(rail))) continue;
    const expected = evaluateInput(project, targetIndex, operands[valueIndex], symbolDomains, new Set());
    if (expected.known && Number.isFinite(scratchToNumber(expected.value))) return expected.value;
  }
  return undefined;
}

function keyedRouteInvariant(route, dispatcher) {
  const expectations = dispatcher.dataRails.map(rail => route.expectations.get(rail));
  if (expectations.some(expectation => expectation?.kind !== 'keyed')) return undefined;
  const operations = new Set(expectations.map(expectation => expectation.operation));
  if (!operations.has('add') || !operations.has('subtract') || operations.size !== 2) return undefined;
  const values = expectations.map(expectation => scratchToNumber(expectation.code));
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function parseDispatcherCondition(project, target, targetIndex, condition, symbolDomains) {
  const expectations = new Map();
  const equalities = condition.opcode === 'operator_and'
    ? ['OPERAND1', 'OPERAND2'].map(name => {
        const id = activeInputSlots(condition.inputs?.[name])[0];
        return typeof id === 'string' ? target.blocks[id] : undefined;
      })
    : condition.opcode === 'operator_equals' ? [condition] : [];
  for (const equals of equalities) {
    if (!isBlock(equals) || equals.opcode !== 'operator_equals') return undefined;
    const parsed = parseVariableEquality(project, target, targetIndex, equals, symbolDomains);
    if (!parsed || expectations.has(parsed.symbol)) return undefined;
    expectations.set(parsed.symbol, parsed.expected);
  }
  return {expectations};
}

function parseVariableEquality(project, target, targetIndex, equals, symbolDomains) {
  const operands = [
    activeInputSlots(equals.inputs?.OPERAND1)[0],
    activeInputSlots(equals.inputs?.OPERAND2)[0]
  ];
  for (const [reporterIndex, valueIndex] of [[0, 1], [1, 0]]) {
    const reporterId = operands[reporterIndex];
    const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
    if (!isBlock(reporter) || reporter.opcode !== 'data_variable') continue;
    const symbols = fieldSymbolKeys(project, targetIndex, 'variable', reporter.fields?.VARIABLE);
    const expectation = parseDispatcherExpectation(
      project,
      target,
      targetIndex,
      operands[valueIndex],
      symbolDomains
    );
    if (symbols.length === 1 && expectation) return {symbol: symbols[0], expected: expectation};
  }
  return undefined;
}

function parseDispatcherExpectation(project, target, targetIndex, value, symbolDomains) {
  const expression = typeof value === 'string' ? target.blocks[value] : undefined;
  if (isBlock(expression) && (expression.opcode === 'operator_add' || expression.opcode === 'operator_subtract')) {
    const left = activeInputSlots(expression.inputs?.NUM1)[0];
    const right = activeInputSlots(expression.inputs?.NUM2)[0];
    const candidates = expression.opcode === 'operator_add'
      ? [[left, right], [right, left]]
      : [[right, left]];
    for (const [keyValue, codeValue] of candidates) {
      const keyReporter = typeof keyValue === 'string' ? target.blocks[keyValue] : undefined;
      if (!isBlock(keyReporter) || keyReporter.opcode !== 'data_variable') continue;
      const keySymbols = fieldSymbolKeys(project, targetIndex, 'variable', keyReporter.fields?.VARIABLE);
      const code = evaluateInput(project, targetIndex, codeValue, symbolDomains, new Set());
      if (keySymbols.length === 1 && code.known) {
        return {
          kind: 'keyed',
          keySymbol: keySymbols[0],
          operation: expression.opcode === 'operator_add' ? 'add' : 'subtract',
          code: code.value
        };
      }
    }
  }
  const constant = evaluateInput(project, targetIndex, value, symbolDomains, new Set());
  return constant.known ? {kind: 'constant', value: constant.value} : undefined;
}

function recoverDispatcherHandler(
  project,
  target,
  targetIndex,
  bodyId,
  dispatcherCode,
  dispatcher,
  symbolDomains
) {
  const ids = directStackIds(target, bodyId);
  const transitions = new Map();
  const transitionStores = new Set();
  const writtenDataRails = new Set();
  let wroteKeyRail = false;
  let keyDelta;
  const operations = [];
  for (const id of ids) {
    const block = target.blocks[id];
    if (!isBlock(block)) continue;
    if (block.opcode === 'data_setvariableto') {
      const symbols = fieldSymbolKeys(project, targetIndex, 'variable', block.fields?.VARIABLE);
      const rail = symbols.length === 1 && dispatcher.dataRails.includes(symbols[0]) ? symbols[0] : undefined;
      if (rail !== undefined) {
        writtenDataRails.add(rail);
        for (const store of collectTransitionStores(project, target, targetIndex, block.inputs?.VALUE)) {
          transitionStores.add(store);
        }
        const transition = recoverTransitionValue(
          project,
          target,
          targetIndex,
          block.inputs?.VALUE,
          symbolDomains
        );
        if (transition) transitions.set(rail, transition);
        continue;
      }
    }
    if (block.opcode === 'data_changevariableby' && dispatcher.relational) {
      const symbols = fieldSymbolKeys(project, targetIndex, 'variable', block.fields?.VARIABLE);
      const rail = symbols.length === 1 && dispatcher.keyRails.includes(symbols[0]) ? symbols[0] : undefined;
      if (rail !== undefined) {
        wroteKeyRail = true;
        for (const store of collectTransitionStores(project, target, targetIndex, block.inputs?.VALUE)) {
          transitionStores.add(store);
        }
        const transition = recoverTransitionValue(
          project,
          target,
          targetIndex,
          block.inputs?.VALUE,
          symbolDomains
        );
        if (transition) keyDelta = {...transition, rail};
        continue;
      }
    }
    if (block.opcode === 'procedures_call' && procedureCode(block) === dispatcherCode) continue;
    operations.push(block.opcode);
  }
  if (operations.length === 0 || dispatcher.dataRails.some(rail => !writtenDataRails.has(rail))) return undefined;
  if (dispatcher.relational && !wroteKeyRail) return undefined;
  return {
    transitionPair: dispatcher.relational || dispatcher.dataRails.some(rail => !transitions.has(rail))
      ? undefined
      : dispatcherRouteKey(
          dispatcher.dataRails,
          new Map([...transitions].map(([rail, transition]) => [rail, {
            kind: 'constant',
            value: transition.value
          }]))
        ),
    transitionStores: [...transitionStores].sort(compareUtf8),
    transitions,
    keyDelta,
    operations
  };
}

function collectTransitionStores(project, target, targetIndex, input, visiting = new Set()) {
  const stores = new Set();
  for (const slot of activeInputSlots(input)) {
    if (typeof slot !== 'string' || visiting.has(slot)) continue;
    const reporter = target.blocks[slot];
    if (!isBlock(reporter)) continue;
    visiting.add(slot);
    if (reporter.opcode === 'data_itemoflist') {
      for (const store of fieldSymbolKeys(project, targetIndex, 'list', reporter.fields?.LIST)) {
        stores.add(store);
      }
    }
    for (const nested of Object.values(reporter.inputs ?? {})) {
      for (const store of collectTransitionStores(project, target, targetIndex, nested, visiting)) {
        stores.add(store);
      }
    }
    visiting.delete(slot);
  }
  return [...stores].sort(compareUtf8);
}

function recoverTransitionValue(project, target, targetIndex, input, symbolDomains) {
  const reporterId = activeInputSlots(input)[0];
  const reporter = typeof reporterId === 'string' ? target.blocks[reporterId] : undefined;
  if (!isBlock(reporter) || reporter.opcode !== 'data_itemoflist') return undefined;
  const stores = fieldSymbolKeys(project, targetIndex, 'list', reporter.fields?.LIST);
  const store = stores.length === 1 ? stores[0] : undefined;
  const index = evaluateInput(
    project,
    targetIndex,
    activeInputSlots(reporter.inputs?.INDEX)[0],
    symbolDomains,
    new Set()
  );
  const slot = index.known ? exactStaticListSlot(index.value) : undefined;
  if (!store || slot === undefined) return undefined;
  const domain = symbolDomains.get(listSlotKey(store, slot));
  const value = domain === undefined ? {known: false} : singleExactValue(domain);
  if (value.known) return {store, value: value.value, source: 'domain'};
  const declarationValue = declaredListSlotValue(project, store, slot);
  return declarationValue.known
    ? {store, value: declarationValue.value, source: 'declaration'}
    : undefined;
}

function recoverDirectDispatcher(project, target, targetIndex, dispatcher, handlers, procedures, dispatcherCode) {
  const routeByPair = new Map(handlers.map(handler => [handler.entryPair, handler]));
  const successors = new Map();
  for (const handler of handlers) {
    const successor = routeByPair.get(handler.transitionPair);
    if (successor) successors.set(handler.entryPair, successor.entryPair);
  }
  const ordered = recoverOrderedDispatcherChains(handlers, successors);
  const stable = dispatcherStoresAreStable(
    project,
    target,
    targetIndex,
    dispatcher,
    handlers,
    procedures,
    dispatcherCode
  );
  const complete = ordered.complete && stable;
  return dispatcherRecoveryResult(handlers, successors, ordered, complete);
}

function recoverRelationalDispatcher(
  project,
  target,
  targetIndex,
  dispatcherCode,
  dispatcher,
  handlers,
  procedures,
  symbolDomains
) {
  const routeByPair = new Map(handlers.map(handler => [handler.entryPair, handler]));
  const successors = new Map();
  const nextKeys = new Map();
  for (const handler of handlers) {
    const matches = dispatcher.routes.flatMap(route => {
      const match = matchRelationalRoute(dispatcher, handler.transitions, route);
      return match ? [{...match, pair: route.pair}] : [];
    });
    if (matches.length !== 1) continue;
    const match = matches[0];
    if (!match || !routeByPair.has(match.pair)) continue;
    successors.set(handler.entryPair, match.pair);
    nextKeys.set(handler.entryPair, match.key);
  }
  const ordered = recoverOrderedDispatcherChains(handlers, successors);
  const stable = dispatcherStoresAreStable(
    project,
    target,
    targetIndex,
    dispatcher,
    handlers,
    procedures,
    dispatcherCode
  );
  const entry = recoverDispatcherEntry(
    project,
    target,
    targetIndex,
    dispatcherCode,
    dispatcher,
    procedures,
    symbolDomains
  );
  const relationallyConsistent = validateRelationalPath(
    handlers,
    successors,
    nextKeys,
    ordered,
    entry
  );
  const complete = ordered.complete && stable && relationallyConsistent;
  return dispatcherRecoveryResult(handlers, successors, ordered, complete);
}

function matchRelationalRoute(dispatcher, transitions, route) {
  let key;
  for (const rail of dispatcher.dataRails) {
    const relation = route.expectations.get(rail);
    const transition = transitions.get(rail);
    if (!relation || relation.kind !== 'keyed' || !transition) return undefined;
    const cipher = scratchToNumber(transition.value);
    const code = scratchToNumber(relation.code);
    if (!Number.isFinite(cipher) || !Number.isFinite(code)) return undefined;
    const candidate = relation.operation === 'add' ? cipher - code : code - cipher;
    if (key !== undefined && candidate !== key) return undefined;
    key = candidate;
  }
  return key === undefined ? undefined : {key};
}

function recoverDispatcherEntry(
  project,
  target,
  targetIndex,
  dispatcherCode,
  dispatcher,
  procedures,
  symbolDomains
) {
  const owned = procedureOwnedBlocks(target, procedures);
  const calls = Object.entries(target.blocks).filter(([id, block]) => (
    !owned.has(id)
    && isBlock(block)
    && block.opcode === 'procedures_call'
    && procedureCode(block) === dispatcherCode
  ));
  const candidates = [];
  for (const [callId] of calls) {
    const component = structuralComponent(target, callId);
    const transitions = new Map();
    let keyValue;
    for (const id of component) {
      const block = target.blocks[id];
      if (!isBlock(block) || block.opcode !== 'data_setvariableto') continue;
      const symbols = fieldSymbolKeys(project, targetIndex, 'variable', block.fields?.VARIABLE);
      if (symbols.length !== 1 || !dispatcher.rails.includes(symbols[0])) continue;
      const transition = recoverTransitionValue(project, target, targetIndex, block.inputs?.VALUE, symbolDomains);
      if (!transition) continue;
      if (dispatcher.keyRails.includes(symbols[0])) keyValue = transition.value;
      else if (dispatcher.dataRails.includes(symbols[0])) transitions.set(symbols[0], transition);
    }
    if (transitions.size !== dispatcher.dataRails.length || keyValue === undefined) continue;
    const matches = dispatcher.routes.flatMap(route => {
      const match = matchRelationalRoute(dispatcher, transitions, route);
      return match && match.key === scratchToNumber(keyValue) ? [{pair: route.pair, key: match.key}] : [];
    });
    if (matches.length === 1 && matches[0]) candidates.push(matches[0]);
  }
  const unique = new Map(candidates.map(candidate => [`${candidate.pair}\u0000${candidate.key}`, candidate]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function validateRelationalPath(handlers, successors, nextKeys, ordered, entry) {
  if (!entry || !ordered.complete || ordered.paths.length !== 1) return false;
  const path = ordered.paths[0];
  if (!path || path[0] !== entry.pair) return false;
  const byPair = new Map(handlers.map(handler => [handler.entryPair, handler]));
  let currentKey = entry.key;
  for (let index = 0; index < path.length; index += 1) {
    const pair = path[index];
    const handler = byPair.get(pair);
    if (!handler?.keyDelta) return false;
    const expectedNextKey = currentKey + scratchToNumber(handler.keyDelta.value);
    const successor = successors.get(pair);
    if (successor === undefined) return index === path.length - 1;
    const recoveredNextKey = nextKeys.get(pair);
    if (recoveredNextKey === undefined || recoveredNextKey !== expectedNextKey) return false;
    currentKey = recoveredNextKey;
  }
  return false;
}

function dispatcherStoresAreStable(
  project,
  target,
  targetIndex,
  dispatcher,
  handlers,
  procedures,
  dispatcherCode
) {
  const stores = new Set(handlers.flatMap(handler => handler.transitionStores));
  const needsDeclarationProof = handlers.some(handler => (
    [...handler.transitions.values(), handler.keyDelta].some(transition => transition?.source === 'declaration')
  ));
  if (!needsDeclarationProof) return true;
  const owners = procedureOwnedBlocks(target, procedures);
  const handlerCodes = new Set(handlers.map(handler => handler.procedureCode));
  const routeCodes = new Set(dispatcher.routes.map(route => route.procedureCode));
  for (const [id, block] of Object.entries(target.blocks)) {
    if (!isBlock(block) || ![
      'data_addtolist',
      'data_deletealloflist',
      'data_deleteoflist',
      'data_insertatlist',
      'data_replaceitemoflist'
    ].includes(block.opcode)) continue;
    const blockStores = fieldSymbolKeys(project, targetIndex, 'list', block.fields?.LIST);
    if (!blockStores.some(store => stores.has(store))) continue;
    const owner = owners.get(id);
    if (!owner || handlerCodes.has(owner) || !routeCodes.has(owner)) return false;
    for (const [callId, call] of Object.entries(target.blocks)) {
      if (!isBlock(call) || call.opcode !== 'procedures_call' || procedureCode(call) !== owner) continue;
      if (owners.get(callId) !== dispatcherCode) return false;
    }
  }
  return true;
}

function dispatcherRecoveryResult(handlers, successors, ordered, complete) {
  const recoveredTransitionEdges = successors.size;
  const unresolvedTransitionEdges = Math.max(0, handlers.length - 1 - recoveredTransitionEdges);
  const recoveryStatus = complete
    ? 'complete'
    : recoveredTransitionEdges > 0 ? 'partial' : 'structural-only';
  return {
    recoveredTransitionEdges,
    unresolvedTransitionEdges,
    recoveryStatus,
    chains: recoveryStatus === 'structural-only' ? [] : ordered.chains
  };
}

function recoverOrderedDispatcherChains(handlers, successors) {
  const byPair = new Map(handlers.map(handler => [handler.entryPair, handler]));
  const incoming = new Set(successors.values());
  const starts = uniqueSorted(handlers.map(handler => handler.entryPair).filter(pair => !incoming.has(pair)));
  const orderedStarts = [...starts, ...uniqueSorted(handlers.map(handler => handler.entryPair))];
  const consumed = new Set();
  const paths = [];
  const chains = [];
  for (const start of orderedStarts) {
    if (consumed.has(start)) continue;
    const chain = [];
    const path = [];
    const local = new Set();
    let pair = start;
    while (typeof pair === 'string' && !local.has(pair)) {
      local.add(pair);
      consumed.add(pair);
      const handler = byPair.get(pair);
      if (!handler) break;
      path.push(pair);
      chain.push(...handler.operations);
      pair = successors.get(pair);
    }
    if (path.length > 0) paths.push(path);
    if (path.length > 1 || handlers.length === 1) chains.push(chain);
  }
  return {
    paths,
    chains,
    complete: paths.length === 1
      && paths[0]?.length === handlers.length
      && successors.size === Math.max(0, handlers.length - 1)
  };
}

function procedureOwnedBlocks(target, procedures) {
  const owners = new Map();
  for (const [code, procedure] of procedures) {
    const queue = [procedure.bodyId];
    const visited = new Set();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      if (id === undefined || visited.has(id)) continue;
      const block = target.blocks[id];
      if (!isBlock(block)) continue;
      visited.add(id);
      owners.set(id, code);
      for (const edge of structuralBlockEdges(target, block)) if (!visited.has(edge)) queue.push(edge);
    }
  }
  return owners;
}

function structuralComponent(target, seed) {
  const adjacent = new Map(Object.keys(target.blocks).map(id => [id, new Set()]));
  for (const [id, block] of Object.entries(target.blocks)) {
    if (!isBlock(block)) continue;
    for (const edge of structuralBlockEdges(target, block)) {
      adjacent.get(id)?.add(edge);
      adjacent.get(edge)?.add(id);
    }
  }
  const component = new Set();
  const queue = [seed];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined || component.has(id)) continue;
    component.add(id);
    for (const edge of adjacent.get(id) ?? []) if (!component.has(edge)) queue.push(edge);
  }
  return component;
}

function dispatcherRouteKey(rails, expectations) {
  return rails.map(rail => {
    const expectation = expectations.get(rail);
    if (expectation?.kind === 'keyed') {
      return `${rail}=${expectation.operation}:${scratchEqualityKey(expectation.code)}@${expectation.keySymbol}`;
    }
    return `${rail}=constant:${scratchEqualityKey(expectation?.value)}`;
  }).join('|');
}

function declaredListSlotValue(project, key, slot) {
  const match = /^list:(\d+):([\s\S]+)$/u.exec(key);
  if (!match) return {known: false};
  const targetIndex = Number(match[1]);
  const id = match[2];
  const declaration = id === undefined ? undefined : project.targets[targetIndex]?.lists?.[id];
  const values = Array.isArray(declaration) ? declaration[1] : undefined;
  return Array.isArray(values) && slot >= 1 && slot <= values.length
    ? {known: true, value: values[slot - 1]}
    : {known: false};
}

function scratchEqualityKey(value) {
  const numeric = scratchComparableNumber(value);
  if (!Number.isNaN(numeric)) return `number:${Object.is(numeric, -0) ? 0 : numeric}`;
  return `text:${String(value).toLowerCase()}`;
}

function directStackIds(target, bodyId) {
  const ids = [];
  const visited = new Set();
  let id = bodyId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const block = target.blocks[id];
    if (!isBlock(block)) break;
    ids.push(id);
    id = block.next;
  }
  return ids;
}

function measureStaticDependencies(project, proceduresByTarget) {
  const dataEdges = new Set();
  const controlEdges = new Set();
  const criticalSymbols = new Set();
  const guardCounts = new Map();
  const guardSites = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const procedures = proceduresByTarget[targetIndex] ?? new Map();
    const reachable = structurallyReachableBlocks(target, procedures);
    for (const id of [...reachable].sort(compareUtf8)) {
      const block = target.blocks[id];
      if (!isBlock(block)) continue;
      const reads = collectBlockSymbolReads(project, target, targetIndex, block);
      const writes = writerSymbolKeys(project, targetIndex, block);
      for (const symbol of [...reads, ...writes]) criticalSymbols.add(symbol);
      for (const source of reads) for (const destination of writes) dataEdges.add(`${source}->${destination}`);
      if (!BRANCH_OPCODES.has(block.opcode)) continue;
      const conditionSymbols = collectInputSymbolReads(
        project,
        target,
        targetIndex,
        activeInputSlots(block.inputs?.CONDITION)[0]
      );
      const effects = {writes: new Set(), stopsAll: false};
      for (const name of ['SUBSTACK', 'SUBSTACK2']) {
        const root = activeInputSlots(block.inputs?.[name])[0];
        if (typeof root !== 'string') continue;
        const nested = collectStackEffects(project, target, targetIndex, root, procedures);
        for (const symbol of nested.writes) effects.writes.add(symbol);
        effects.stopsAll ||= nested.stopsAll;
      }
      for (const source of conditionSymbols) {
        for (const destination of effects.writes) controlEdges.add(`${source}->${destination}`);
        if (effects.stopsAll) {
          controlEdges.add(`${source}->effect:stop-all`);
          guardCounts.set(source, (guardCounts.get(source) ?? 0) + 1);
          guardSites.add(blockKey(targetIndex, id));
        }
      }
    }
  }
  const guardedSymbols = new Set(guardCounts.keys());
  const covered = [...criticalSymbols].filter(symbol => guardedSymbols.has(symbol)).length;
  return {
    dataEdges: dataEdges.size,
    controlEdges: controlEdges.size,
    criticalSymbols: criticalSymbols.size,
    guardedSymbols: guardedSymbols.size,
    guardSites: guardSites.size,
    redundantlyGuardedSymbols: [...guardCounts.values()].filter(count => count > 1).length,
    guardCoverage: ratio(covered, criticalSymbols.size)
  };
}

function structurallyReachableBlocks(target, procedures) {
  const reachable = new Set();
  const queue = Object.entries(target.blocks)
    .filter(([, block]) => isBlock(block) && block.topLevel && isRunnableHat(block.opcode))
    .map(([id]) => id)
    .sort(compareUtf8);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined || reachable.has(id)) continue;
    const block = target.blocks[id];
    if (!isBlock(block)) continue;
    reachable.add(id);
    for (const edge of structuralBlockEdges(target, block)) if (!reachable.has(edge)) queue.push(edge);
    if (block.opcode === 'procedures_call') {
      const procedure = procedures.get(procedureCode(block));
      if (procedure && !reachable.has(procedure.bodyId)) queue.push(procedure.bodyId);
    }
  }
  return reachable;
}

function collectStackEffects(project, target, targetIndex, rootId, procedures) {
  const writes = new Set();
  let stopsAll = false;
  const visited = new Set();
  const queue = [rootId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined || visited.has(id)) continue;
    const block = target.blocks[id];
    if (!isBlock(block)) continue;
    visited.add(id);
    for (const symbol of writerSymbolKeys(project, targetIndex, block)) writes.add(symbol);
    if (block.opcode === 'control_stop' && block.fields?.STOP_OPTION?.[0] === 'all') stopsAll = true;
    for (const edge of structuralBlockEdges(target, block)) if (!visited.has(edge)) queue.push(edge);
    if (block.opcode === 'procedures_call') {
      const procedure = procedures.get(procedureCode(block));
      if (procedure && !visited.has(procedure.bodyId)) queue.push(procedure.bodyId);
    }
  }
  return {writes, stopsAll};
}

function collectBlockSymbolReads(project, target, targetIndex, block, visiting = new Set()) {
  const reads = new Set();
  if (block.opcode === 'data_variable') {
    for (const symbol of fieldSymbolKeys(project, targetIndex, 'variable', block.fields?.VARIABLE)) reads.add(symbol);
  }
  if (LIST_INDIRECTION_OPCODES.has(block.opcode) || block.opcode === 'data_listcontents') {
    for (const symbol of fieldSymbolKeys(project, targetIndex, 'list', block.fields?.LIST)) reads.add(symbol);
  }
  if (block.opcode === 'data_changevariableby') {
    for (const symbol of fieldSymbolKeys(project, targetIndex, 'variable', block.fields?.VARIABLE)) reads.add(symbol);
  }
  for (const input of Object.values(block.inputs ?? {})) {
    for (const slot of activeInputSlots(input)) {
      for (const symbol of collectInputSymbolReads(project, target, targetIndex, slot, visiting)) reads.add(symbol);
    }
  }
  return reads;
}

function collectInputSymbolReads(project, target, targetIndex, value, visiting = new Set()) {
  const reads = new Set();
  if (Array.isArray(value)) {
    const kind = value[0] === 12 ? 'variable' : value[0] === 13 ? 'list' : undefined;
    if (kind) {
      for (const symbol of resolveSymbolKeys(project, targetIndex, kind, value[2], value[1])) reads.add(symbol);
    }
    return reads;
  }
  if (typeof value !== 'string' || visiting.has(value)) return reads;
  const reporter = target.blocks[value];
  if (!isBlock(reporter)) return reads;
  visiting.add(value);
  for (const symbol of collectBlockSymbolReads(project, target, targetIndex, reporter, visiting)) reads.add(symbol);
  visiting.delete(value);
  return reads;
}

function fieldSymbolKeys(project, targetIndex, kind, field) {
  return Array.isArray(field)
    ? resolveSymbolKeys(project, targetIndex, kind, field[1], field[0])
    : [];
}

function collectProjectReachability(project, proceduresByTarget) {
  const declarationValues = collectDeclarationValues(project);
  const externallyMutable = collectExternallyMutableSymbols(project);
  let symbolDomains = new Map([...declarationValues].map(([key, value]) => [key, exactDomain(value)]));
  for (const key of externallyMutable) symbolDomains.set(key, unknownDomain());
  let reachability;
  const maximumIterations = Math.max(24, (declarationValues.size * 2) + 16);
  for (let iteration = 0; iteration <= maximumIterations; iteration += 1) {
    reachability = traverseProject(project, proceduresByTarget, symbolDomains);
    const nextDomains = new Map([...symbolDomains].map(([key, domain]) => [key, cloneDomain(domain)]));
    for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
      const target = project.targets[targetIndex];
      const reachable = reachability.reachableByTarget[targetIndex] ?? new Set();
      for (const id of reachable) {
        const block = target.blocks[id];
        if (!isBlock(block)) continue;
        widenWrittenSymbols(project, targetIndex, block, symbolDomains, nextDomains);
      }
    }
    if (domainsEqual(nextDomains, symbolDomains)) {
      const constantValues = new Map();
      const constantListSlots = new Map();
      const unknownSymbols = new Set();
      for (const [key, domain] of symbolDomains) {
        const exact = singleExactValue(domain);
        if (key.startsWith('list-slot:')) {
          if (exact.known) constantListSlots.set(key, exact.value);
        } else if (exact.known) constantValues.set(key, exact.value);
        else unknownSymbols.add(key);
      }
      reachability.constantValues = constantValues;
      reachability.constantListSlots = constantListSlots;
      reachability.unknownSymbols = unknownSymbols;
      reachability.symbolDomains = symbolDomains;
      return reachability;
    }
    symbolDomains = nextDomains;
  }
  throw new Error('state reachability fixed point did not converge');
}

function traverseProject(project, proceduresByTarget, symbolDomains) {
  const ordinaryRoots = [];
  const broadcastRoots = new Map();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, value] of Object.entries(target.blocks)) {
      if (!isBlock(value) || !value.topLevel || !isRunnableHat(value.opcode)) continue;
      const key = blockKey(targetIndex, id);
      if (value.opcode === 'event_whenbroadcastreceived') {
        for (const broadcastKey of broadcastKeysFromReceiver(value)) addMapSet(broadcastRoots, broadcastKey, key);
      } else {
        ordinaryRoots.push(key);
      }
    }
  }
  ordinaryRoots.sort(compareUtf8);
  const activeRoots = new Set(ordinaryRoots);
  const reachable = new Set();
  const reachableByTarget = project.targets.map(() => new Set());
  const sentBroadcasts = new Set();
  let dynamicBroadcast = false;
  let changed = true;
  while (changed) {
    changed = false;
    const queue = [...activeRoots].filter(key => !reachable.has(key)).sort(compareUtf8);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const key = queue[cursor];
      if (key === undefined || reachable.has(key)) continue;
      const reference = parseBlockKey(key);
      const target = project.targets[reference.targetIndex];
      if (!target) continue;
      const id = reference.id;
      const block = target.blocks[id];
      if (!isBlock(block)) continue;
      reachable.add(key);
      reachableByTarget[reference.targetIndex]?.add(id);
      changed = true;
      for (const edge of executableEdges(project, reference.targetIndex, block, symbolDomains)) {
        const edgeKey = blockKey(reference.targetIndex, edge);
        if (!reachable.has(edgeKey)) queue.push(edgeKey);
      }
      if (block.opcode === 'procedures_call') {
        const procedure = proceduresByTarget[reference.targetIndex]?.get(procedureCode(block));
        if (procedure) {
          const bodyKey = blockKey(reference.targetIndex, procedure.bodyId);
          if (!reachable.has(bodyKey)) queue.push(bodyKey);
        }
      }
      if (block.opcode === 'event_broadcast' || block.opcode === 'event_broadcastandwait') {
        const keys = broadcastKeysFromEmitter(block);
        if (keys.length === 0) dynamicBroadcast = true;
        for (const key of keys) sentBroadcasts.add(key);
      }
    }
    if (dynamicBroadcast) {
      for (const ids of broadcastRoots.values()) for (const id of ids) activeRoots.add(id);
    } else {
      for (const key of sentBroadcasts) {
        const ids = broadcastRoots.get(key);
        if (ids) for (const id of ids) activeRoots.add(id);
      }
    }
  }
  const allBroadcastRootIds = new Set([...broadcastRoots.values()].flatMap(ids => [...ids]));
  const neverSentBroadcastHats = [...allBroadcastRootIds].filter(key => !activeRoots.has(key)).length;
  return {
    reachable,
    reachableByTarget,
    activeRoots: [...activeRoots].sort(compareUtf8),
    broadcastRoots,
    sentBroadcasts,
    dynamicBroadcast,
    neverSentBroadcastHats,
    constantValues: new Map(),
    constantListSlots: new Map(),
    unknownSymbols: new Set(),
    symbolDomains: new Map()
  };
}

function executableEdges(project, targetIndex, block, symbolDomains) {
  const target = project.targets[targetIndex];
  if (!target) return [];
  const edges = [];
  if (typeof block.next === 'string' && target.blocks[block.next] !== undefined) edges.push(block.next);
  const conditionResult = evaluateCondition(project, targetIndex, block, symbolDomains);
  for (const [name, input] of Object.entries(block.inputs ?? {})) {
    const isSubstack = name === 'SUBSTACK' || name === 'SUBSTACK2';
    if (isSubstack && conditionResult.known) {
      const truth = scratchBoolean(conditionResult.value);
      if (block.opcode === 'control_if' && !truth) continue;
      if (block.opcode === 'control_if_else' && ((name === 'SUBSTACK') !== truth)) continue;
      if ((block.opcode === 'control_repeat_until' || block.opcode === 'control_wait_until') && truth) continue;
    }
    for (const slot of activeInputSlots(input)) {
      if (typeof slot === 'string' && target.blocks[slot] !== undefined) edges.push(slot);
    }
  }
  return uniqueSorted(edges);
}

function collectNormalizedEdges(
  project,
  targetIndex,
  block,
  procedures,
  simpleProcedures,
  folded,
  transparent,
  simpleBodyIds,
  constantValues
) {
  const target = project.targets[targetIndex];
  if (!target) return [];
  const edges = executableEdges(project, targetIndex, block, constantValues)
    .flatMap(id => expandTransparentEdge(target, id, transparent))
    .filter(id => !folded.has(id) && !simpleBodyIds.has(id));
  if (block.opcode === 'procedures_call' && !simpleProcedures.has(procedureCode(block))) {
    const procedure = procedures.get(procedureCode(block));
    if (procedure) edges.push(procedure.bodyId);
  }
  return uniqueSorted(edges);
}

function expandTransparentEdge(target, id, transparent, visiting = new Set()) {
  if (!transparent.has(id) || visiting.has(id)) return [id];
  visiting.add(id);
  const block = target.blocks[id];
  if (!isBlock(block) || typeof block.next !== 'string') return [];
  return expandTransparentEdge(target, block.next, transparent, visiting);
}

function collectDeclarationValues(project) {
  const values = new Map();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, declaration] of Object.entries(target.variables ?? {})) {
      if (Array.isArray(declaration) && declaration.length >= 2) {
        values.set(symbolKey('variable', targetIndex, id), declaration[1]);
      }
    }
    for (const [id, declaration] of Object.entries(target.lists ?? {})) {
      if (Array.isArray(declaration) && Array.isArray(declaration[1])) {
        const key = symbolKey('list', targetIndex, id);
        values.set(key, declaration[1]);
        for (const [index, value] of declaration[1].entries()) {
          values.set(listSlotKey(key, index + 1), value);
        }
      }
    }
  }
  return values;
}

function collectExternallyMutableSymbols(project) {
  const result = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, declaration] of Object.entries(target.variables ?? {})) {
      if (Array.isArray(declaration) && declaration[2] === true) {
        result.add(symbolKey('variable', targetIndex, id));
      }
    }
  }
  for (const monitor of project.monitors ?? []) {
    if (!monitor || typeof monitor !== 'object') continue;
    const id = monitor.id;
    if (typeof id !== 'string') continue;
    const spriteName = monitor.spriteName;
    const targetIndex = project.targets.findIndex(target => (
      typeof spriteName === 'string' ? target.name === spriteName : target.isStage
    ));
    if (targetIndex < 0) continue;
    const opcode = monitor.opcode;
    const kind = opcode === 'data_listcontents' ? 'list' : 'variable';
    for (const key of resolveSymbolKeys(project, targetIndex, kind, id, undefined)) result.add(key);
  }
  return result;
}

function writerSymbolKeys(project, targetIndex, block) {
  const variableWriters = new Set(['data_changevariableby', 'data_setvariableto']);
  const listWriters = new Set([
    'data_addtolist',
    'data_deletealloflist',
    'data_deleteoflist',
    'data_insertatlist',
    'data_replaceitemoflist'
  ]);
  if (variableWriters.has(block.opcode)) {
    const field = block.fields?.VARIABLE;
    return Array.isArray(field)
      ? resolveSymbolKeys(project, targetIndex, 'variable', field[1], field[0])
      : [];
  }
  if (listWriters.has(block.opcode)) {
    const field = block.fields?.LIST;
    return Array.isArray(field)
      ? resolveSymbolKeys(project, targetIndex, 'list', field[1], field[0])
      : [];
  }
  return [];
}

function widenWrittenSymbols(project, targetIndex, block, currentDomains, nextDomains) {
  const keys = writerSymbolKeys(project, targetIndex, block);
  if (keys.length === 0) return;
  if (keys.length !== 1) {
    for (const key of keys) nextDomains.set(key, unknownDomain());
    return;
  }
  const key = keys[0];
  if (key === undefined) return;
  let written;
  if (block.opcode === 'data_changevariableby') {
    written = numericDomain();
  } else if (block.opcode === 'data_setvariableto') {
    const value = evaluateInput(
      project,
      targetIndex,
      activeInputSlots(block.inputs?.VALUE)[0],
      currentDomains,
      new Set()
    );
    written = resultDomain(value);
  } else {
    written = unknownDomain();
  }
  const previous = nextDomains.get(key) ?? unknownDomain();
  nextDomains.set(key, mergeDomains(previous, written));
  if (!block.opcode.startsWith('data_') || !block.opcode.endsWith('list')) return;
  widenWrittenListSlots(project, targetIndex, block, key, currentDomains, nextDomains);
}

function widenWrittenListSlots(project, targetIndex, block, key, currentDomains, nextDomains) {
  if (block.opcode === 'data_addtolist') return;
  const slotKeys = [...nextDomains.keys()].filter(candidate => candidate.startsWith(`${listSlotKey(key, '')}`));
  if (block.opcode === 'data_replaceitemoflist') {
    const index = evaluateInput(
      project,
      targetIndex,
      activeInputSlots(block.inputs?.INDEX)[0],
      currentDomains,
      new Set()
    );
    const slot = index.known ? exactStaticListSlot(index.value) : undefined;
    const slotKey = slot === undefined ? undefined : listSlotKey(key, slot);
    if (slotKey !== undefined && nextDomains.has(slotKey)) {
      const item = evaluateInput(
        project,
        targetIndex,
        activeInputSlots(block.inputs?.ITEM)[0],
        currentDomains,
        new Set()
      );
      const previous = nextDomains.get(slotKey) ?? unknownDomain();
      nextDomains.set(slotKey, mergeDomains(previous, resultDomain(item)));
      return;
    }
  }
  for (const slotKey of slotKeys) nextDomains.set(slotKey, unknownDomain());
}

function exactDomain(value) {
  return {unknown: false, numeric: false, values: [value]};
}

function numericDomain() {
  return {unknown: false, numeric: true, values: []};
}

function unknownDomain() {
  return {unknown: true, numeric: true, values: []};
}

function cloneDomain(domain) {
  return {unknown: domain.unknown, numeric: domain.numeric, values: [...domain.values]};
}

function mergeDomains(left, right) {
  if (left.unknown || right.unknown) return unknownDomain();
  const values = new Map();
  for (const value of [...left.values, ...right.values]) values.set(stableValueKey(value), value);
  if (values.size > MAX_FINITE_DOMAIN_VALUES) return unknownDomain();
  return {
    unknown: false,
    numeric: left.numeric || right.numeric,
    values: [...values.values()].sort((first, second) => compareUtf8(stableValueKey(first), stableValueKey(second)))
  };
}

function resultDomain(result) {
  if (result.domain) return result.domain;
  if (result.known) return exactDomain(result.value);
  return unknownDomain();
}

function singleExactValue(domain) {
  return !domain.unknown && !domain.numeric && domain.values.length === 1
    ? {known: true, value: domain.values[0]}
    : {known: false};
}

function domainsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, leftDomain] of left) {
    const rightDomain = right.get(key);
    if (!rightDomain || domainKey(leftDomain) !== domainKey(rightDomain)) return false;
  }
  return true;
}

function domainKey(domain) {
  return JSON.stringify({
    unknown: domain.unknown,
    numeric: domain.numeric,
    values: domain.values.map(stableValueKey).sort(compareUtf8)
  });
}

function stableValueKey(value) {
  return `${Array.isArray(value) ? 'array' : typeof value}:${JSON.stringify(value)}`;
}

function resolveSymbolKeys(project, targetIndex, kind, id, name) {
  const declarationName = kind === 'variable' ? 'variables' : 'lists';
  const target = project.targets[targetIndex];
  const stageIndex = project.targets.findIndex(candidate => candidate.isStage);
  const dictionaries = [];
  if (target) dictionaries.push({targetIndex, declarations: target[declarationName] ?? {}});
  if (stageIndex >= 0 && stageIndex !== targetIndex) {
    dictionaries.push({targetIndex: stageIndex, declarations: project.targets[stageIndex]?.[declarationName] ?? {}});
  }
  if (typeof id === 'string') {
    for (const dictionary of dictionaries) {
      if (dictionary.declarations[id] !== undefined) return [symbolKey(kind, dictionary.targetIndex, id)];
    }
  }
  if (typeof name !== 'string') return [];
  const matches = [];
  for (const dictionary of dictionaries) {
    for (const [candidateId, declaration] of Object.entries(dictionary.declarations)) {
      if (Array.isArray(declaration) && declaration[0] === name) {
        matches.push(symbolKey(kind, dictionary.targetIndex, candidateId));
      }
    }
    if (matches.length > 0) break;
  }
  return uniqueSorted(matches);
}

function symbolKey(kind, targetIndex, id) {
  return `${kind}:${targetIndex}:${id}`;
}

function listSlotKey(listKey, slot) {
  return `list-slot:${listKey.slice('list:'.length)}:${slot}`;
}

function blockKey(targetIndex, id) {
  return `t${targetIndex}:${id}`;
}

function parseBlockKey(key) {
  const separator = key.indexOf(':');
  const targetIndex = Number(key.slice(1, separator));
  return {targetIndex, id: key.slice(separator + 1)};
}

function addBroadcastEdges(project, nodes, reachability) {
  const receivers = new Map();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, block] of Object.entries(target.blocks)) {
      const key = blockKey(targetIndex, id);
      if (!reachability.reachable.has(key) || !nodes.has(key) || !isBlock(block)
        || block.opcode !== 'event_whenbroadcastreceived') continue;
      for (const broadcastKey of broadcastKeysFromReceiver(block)) addMapSet(receivers, broadcastKey, key);
    }
  }
  const allReceivers = uniqueSorted([...receivers.values()].flatMap(ids => [...ids]));
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, block] of Object.entries(target.blocks)) {
      const key = blockKey(targetIndex, id);
      const node = nodes.get(key);
      if (!node || !isBlock(block)
        || (block.opcode !== 'event_broadcast' && block.opcode !== 'event_broadcastandwait')) continue;
      const broadcastKeys = broadcastKeysFromEmitter(block);
      const targets = broadcastKeys.length === 0
        ? allReceivers
        : uniqueSorted(broadcastKeys.flatMap(broadcastKey => [...(receivers.get(broadcastKey) ?? [])]));
      node.edges = uniqueSorted([...node.edges, ...targets]);
    }
  }
}

function measureReachableBroadcasts(project, reachability) {
  const channels = new Map();
  let dynamicSenders = 0;
  const add = (channel, role, key) => {
    const present = channels.get(channel) ?? {senders: new Set(), receivers: new Set()};
    present[role].add(key);
    channels.set(channel, present);
  };
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, block] of Object.entries(target.blocks)) {
      if (!isBlock(block)) continue;
      const key = blockKey(targetIndex, id);
      const reachable = reachability.reachable.has(key);
      if (block.opcode === 'event_whenbroadcastreceived') {
        const channel = primaryBroadcastKey(broadcastKeysFromReceiver(block));
        if (channel) add(channel, 'receivers', reachable ? key : `pruned:${key}`);
      } else if (block.opcode === 'event_broadcast' || block.opcode === 'event_broadcastandwait') {
        const channel = primaryBroadcastKey(broadcastKeysFromEmitter(block));
        if (channel) add(channel, 'senders', reachable ? key : `pruned:${key}`);
        else if (reachable) dynamicSenders += 1;
      }
    }
  }
  let reachableSenders = 0;
  let reachableReceivers = 0;
  let pairedChannels = 0;
  let rawPairedChannels = 0;
  let unpairedReceiverHats = 0;
  let balanceTotal = 0;
  for (const channel of channels.values()) {
    const allSenders = [...channel.senders];
    const allReceivers = [...channel.receivers];
    const senders = allSenders.filter(key => !key.startsWith('pruned:'));
    const receivers = allReceivers.filter(key => !key.startsWith('pruned:'));
    reachableSenders += senders.length;
    reachableReceivers += receivers.length;
    if (allSenders.length > 0 && allReceivers.length > 0) rawPairedChannels += 1;
    if (allSenders.length === 0) unpairedReceiverHats += allReceivers.length;
    if (senders.length > 0 && receivers.length > 0) {
      pairedChannels += 1;
      balanceTotal += Math.min(senders.length, receivers.length) / Math.max(senders.length, receivers.length);
    }
  }
  return {
    reachableSenders: reachableSenders + dynamicSenders,
    reachableReceivers,
    pairedChannels,
    rawPairedChannels,
    unpairedReceiverHats,
    pairBalance: ratio(balanceTotal, pairedChannels),
    retainedPairRatio: ratio(pairedChannels, rawPairedChannels)
  };
}

function primaryBroadcastKey(keys) {
  return keys.find(key => key.startsWith('id:')) ?? keys.find(key => key.startsWith('name:'));
}

function measureProcedureTemplates(project, proceduresByTarget, reachableByTarget) {
  const templateByTargetCode = new Map();
  const templates = [];
  const warpValues = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const reachable = reachableByTarget[targetIndex] ?? new Set();
    for (const [code, procedure] of proceduresByTarget[targetIndex] ?? []) {
      if (!reachable.has(procedure.bodyId)) continue;
      const prototype = target.blocks[procedure.prototypeId];
      if (isBlock(prototype) && typeof prototype.mutation?.warp === 'string') warpValues.add(prototype.mutation.warp);
      const digest = procedureTemplateDigest(target, procedure.bodyId, reachable);
      templates.push(digest);
      templateByTargetCode.set(`${targetIndex}:${code}`, digest);
    }
  }
  const broadcastTemplates = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const reachable = reachableByTarget[targetIndex] ?? new Set();
    for (const [id, block] of Object.entries(target.blocks)) {
      if (!reachable.has(id) || !isBlock(block) || block.opcode !== 'event_whenbroadcastreceived') continue;
      for (const callCode of reachableProcedureCalls(target, id, reachable)) {
        const template = templateByTargetCode.get(`${targetIndex}:${callCode}`);
        if (template) broadcastTemplates.add(template);
      }
    }
  }
  return {
    count: templates.length,
    kinds: new Set(templates).size,
    diversity: ratio(new Set(templates).size, templates.length),
    broadcastKinds: broadcastTemplates.size,
    warpVariants: warpValues.size
  };
}

function procedureTemplateDigest(target, bodyId, reachable) {
  const signatures = [];
  const edges = [];
  const queue = [bodyId];
  const seen = new Set();
  for (let cursor = 0; cursor < queue.length && seen.size < 512; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined || seen.has(id) || !reachable.has(id)) continue;
    const block = target.blocks[id];
    if (!isBlock(block)) continue;
    seen.add(id);
    signatures.push(localBlockSignature(target.blocks, block));
    for (const next of structuralBlockEdges(target, block)) {
      if (!reachable.has(next)) continue;
      const targetBlock = target.blocks[next];
      if (isBlock(targetBlock)) edges.push(`${block.opcode}->${targetBlock.opcode}`);
      queue.push(next);
    }
  }
  return createHash('sha256').update(JSON.stringify({
    signatures: signatures.sort(compareUtf8),
    edges: edges.sort(compareUtf8)
  })).digest('hex').slice(0, 16);
}

function reachableProcedureCalls(target, rootId, reachable) {
  const codes = new Set();
  const queue = [rootId];
  const seen = new Set();
  for (let cursor = 0; cursor < queue.length && seen.size < 512; cursor += 1) {
    const id = queue[cursor];
    if (id === undefined || seen.has(id) || !reachable.has(id)) continue;
    const block = target.blocks[id];
    if (!isBlock(block)) continue;
    seen.add(id);
    if (block.opcode === 'procedures_call' && procedureCode(block).length > 0) codes.add(procedureCode(block));
    for (const next of structuralBlockEdges(target, block)) queue.push(next);
  }
  return codes;
}

function structuralBlockEdges(target, block) {
  const edges = [];
  if (typeof block.next === 'string' && target.blocks[block.next] !== undefined) edges.push(block.next);
  for (const input of Object.values(block.inputs ?? {})) {
    for (const slot of activeInputSlots(input)) {
      if (typeof slot === 'string' && target.blocks[slot] !== undefined) edges.push(slot);
    }
  }
  return uniqueSorted(edges);
}

function measureNormalizedGraph(nodes, activeRoots) {
  const undirected = new Map([...nodes.keys()].map(id => [id, new Set()]));
  const crossFamilyDependencyKinds = new Set();
  let crossFamilyDependencyEdges = 0;
  for (const node of nodes.values()) {
    for (const targetId of node.edges) {
      const targetNode = nodes.get(targetId);
      if (!targetNode) continue;
      undirected.get(node.id)?.add(targetId);
      undirected.get(targetId)?.add(node.id);
      if (node.family !== targetNode.family) {
        crossFamilyDependencyKinds.add(`${node.family}->${targetNode.family}`);
        crossFamilyDependencyEdges += 1;
      }
    }
  }
  const seen = new Set();
  const components = [];
  const orderedSeeds = [...new Set([...activeRoots.filter(id => nodes.has(id)), ...nodes.keys()])];
  for (const seed of orderedSeeds) {
    if (seen.has(seed)) continue;
    const ids = [];
    const queue = [seed];
    seen.add(seed);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      if (id === undefined) continue;
      ids.push(id);
      for (const adjacent of undirected.get(id) ?? []) {
        if (!seen.has(adjacent)) {
          seen.add(adjacent);
          queue.push(adjacent);
        }
      }
    }
    components.push(measureComponent(ids.map(id => nodes.get(id)).filter(Boolean)));
  }
  const semanticDependencyKinds = new Set();
  for (const component of components) {
    const families = new Set(component.families);
    addFamilyPair(families, semanticDependencyKinds, 'event', 'data');
    addFamilyPair(families, semanticDependencyKinds, 'event', 'procedure');
    addFamilyPair(families, semanticDependencyKinds, 'procedure', 'data');
    addFamilyPair(families, semanticDependencyKinds, 'procedure', 'control');
    addFamilyPair(families, semanticDependencyKinds, 'control', 'data');
    addFamilyPair(families, semanticDependencyKinds, 'control', 'operator');
    addFamilyPair(families, semanticDependencyKinds, 'operator', 'data');
  }
  return {
    components,
    crossFamilyDependencyKinds: [...crossFamilyDependencyKinds].sort(compareUtf8),
    crossFamilyDependencyEdges,
    semanticDependencyKinds: [...semanticDependencyKinds].sort(compareUtf8)
  };
}

function measureComponent(nodes) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const opcodes = nodes.map(node => node.opcode);
  const families = uniqueSorted(nodes.map(node => node.family));
  const signatures = new Set(nodes.map(node => node.signature));
  const reporterCount = nodes.filter(node => isReporterOpcode(node.opcode)).length;
  const operatorCount = nodes.filter(node => node.family === 'operator').length;
  const controlCount = nodes.filter(node => node.family === 'control').length;
  const eventCount = nodes.filter(node => node.family === 'event').length;
  const dataCount = nodes.filter(node => node.family === 'data').length;
  const procedureCount = nodes.filter(node => node.family === 'procedure' || node.opcode.startsWith('inline(')).length;
  const quality = (
    (saturate(nodes.length / 8) * 0.15)
    + (saturate(families.length / 5) * 0.20)
    + (ratio(signatures.size, nodes.length) * 0.15)
    + ((reporterCount > 0 ? 1 : 0) * 0.10)
    + ((operatorCount > 0 ? 1 : 0) * 0.10)
    + ((controlCount > 0 ? 1 : 0) * 0.10)
    + ((eventCount > 0 ? 1 : 0) * 0.07)
    + ((dataCount > 0 ? 1 : 0) * 0.07)
    + ((procedureCount > 0 ? 1 : 0) * 0.06)
  );
  const shape = {
    nodes: nodes.length,
    families,
    opcodeKinds: new Set(opcodes).size,
    quality: rounded(quality),
    digest: createHash('sha256').update(JSON.stringify({
      opcodes: [...opcodes].sort(compareUtf8),
      signatures: [...signatures].sort(compareUtf8),
      edges: nodes.flatMap(node => node.edges.map(edge => `${node.opcode}->${nodesById.get(edge)?.opcode ?? '?'}`)).sort(compareUtf8)
    })).digest('hex').slice(0, 16)
  };
  return {
    quality,
    coherent: nodes.length >= 4 && families.length >= 3 && quality >= 0.55,
    families,
    shape
  };
}

function canonicalTarget(nodes, components) {
  return {
    nodeSignatures: [...nodes.values()].map(node => node.signature).sort(compareUtf8),
    edgeSignatures: [...nodes.values()].flatMap(node => node.edges.map(edge => {
      const target = nodes.get(edge);
      return `${node.signature}->${target?.signature ?? '?'}`;
    })).sort(compareUtf8),
    componentShapes: components.map(component => component.shape).sort(compareShape)
  };
}

function collectProcedures(target) {
  const procedures = new Map();
  for (const [definitionId, definition] of Object.entries(target.blocks)) {
    if (!isBlock(definition) || definition.opcode !== 'procedures_definition' || typeof definition.next !== 'string') continue;
    const prototypeId = definition.inputs?.custom_block?.[1];
    if (typeof prototypeId !== 'string') continue;
    const prototype = target.blocks[prototypeId];
    if (!isBlock(prototype)) continue;
    const code = procedureCode(prototype);
    if (code.length > 0) procedures.set(code, {definitionId, prototypeId, bodyId: definition.next});
  }
  return procedures;
}

function collectSimpleProcedures(target, procedures) {
  const result = new Map();
  for (const [code, procedure] of procedures) {
    const bodyIds = [];
    const opcodes = [];
    const visited = new Set();
    let id = procedure.bodyId;
    while (typeof id === 'string' && bodyIds.length <= 2 && !visited.has(id)) {
      visited.add(id);
      const block = target.blocks[id];
      if (!isBlock(block) || /^(?:control|event|procedures)_/.test(block.opcode)) break;
      if (Object.keys(block.inputs ?? {}).some(name => name === 'SUBSTACK' || name === 'SUBSTACK2')) break;
      bodyIds.push(id);
      opcodes.push(block.opcode);
      id = block.next;
    }
    if (id === null && bodyIds.length > 0 && bodyIds.length <= 2) result.set(code, {bodyIds, opcodes});
  }
  return result;
}

function extractChains(project, reachable, simpleProcedures) {
  const chains = [];
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    const targetReachable = new Set([...reachable]
      .filter(id => id.startsWith(`t${targetIndex}:`))
      .map(id => id.slice(`t${targetIndex}:`.length)));
    const targetSimple = new Map([...simpleProcedures]
      .filter(([code]) => code.startsWith(`t${targetIndex}:`))
      .map(([code, procedure]) => [code.slice(`t${targetIndex}:`.length), procedure]));
    chains.push(...extractTargetChains(target, targetReachable, targetSimple));
  }
  return chains;
}

function extractTargetChains(target, reachable, simpleProcedures, transparent = new Set()) {
  const starts = [];
  const hasIncomingNext = new Set();
  const simpleBodyIds = new Set([...simpleProcedures.values()].flatMap(procedure => procedure.bodyIds));
  for (const id of reachable) {
    const block = target.blocks[id];
    if (isBlock(block) && typeof block.next === 'string' && reachable.has(block.next)) {
      for (const next of expandTransparentEdge(target, block.next, transparent)) hasIncomingNext.add(next);
    }
  }
  for (const id of reachable) {
    if (!hasIncomingNext.has(id) && !simpleBodyIds.has(id) && !transparent.has(id)) starts.push(id);
  }
  starts.sort(compareUtf8);
  const chains = [];
  for (const start of starts) {
    const opcodes = [];
    const visited = new Set();
    let id = start;
    while (typeof id === 'string' && reachable.has(id) && !visited.has(id)) {
      visited.add(id);
      const block = target.blocks[id];
      if (!isBlock(block)) break;
      if (transparent.has(id)) {
        id = block.next;
        continue;
      }
      if (block.opcode === 'procedures_call') {
        const simple = simpleProcedures.get(procedureCode(block));
        if (simple) opcodes.push(...simple.opcodes);
        else opcodes.push(block.opcode);
      } else if (block.opcode !== 'procedures_definition' && block.opcode !== 'procedures_prototype' && !isReporterOpcode(block.opcode)) {
        opcodes.push(block.opcode);
      }
      const next = typeof block.next === 'string'
        ? expandTransparentEdge(target, block.next, transparent)[0]
        : undefined;
      id = next ?? null;
    }
    if (opcodes.length > 0) chains.push(opcodes);
  }
  return chains;
}

function collectOriginalIdentifiers(project) {
  const identifiers = new Set();
  for (const target of project.targets) {
    for (const id of Object.keys(target.blocks)) addIdentifier(identifiers, id);
    for (const [id, declaration] of Object.entries(target.variables ?? {})) {
      if (Array.isArray(declaration) && declaration[2] === true) continue;
      addIdentifier(identifiers, id);
      if (Array.isArray(declaration) && declaration[0] !== WATERMARK_NAME) addIdentifier(identifiers, declaration[0]);
    }
    for (const [id, declaration] of Object.entries(target.lists ?? {})) {
      addIdentifier(identifiers, id);
      if (Array.isArray(declaration)) addIdentifier(identifiers, declaration[0]);
    }
    for (const [id, name] of Object.entries(target.broadcasts ?? {})) {
      addIdentifier(identifiers, id);
      addIdentifier(identifiers, name);
    }
    for (const [id, value] of Object.entries(target.comments ?? {})) {
      addIdentifier(identifiers, id);
      if (value && typeof value === 'object') addIdentifier(identifiers, value.blockId);
    }
    for (const value of Object.values(target.blocks)) {
      if (!isBlock(value) || !value.mutation) continue;
      addIdentifier(identifiers, value.mutation.proccode);
      for (const key of ['argumentids', 'argumentnames']) {
        const encoded = value.mutation[key];
        if (typeof encoded !== 'string') continue;
        addIdentifier(identifiers, encoded);
        try {
          const parsed = JSON.parse(encoded);
          if (Array.isArray(parsed)) for (const item of parsed) addIdentifier(identifiers, item);
        } catch {
          // Malformed mutation data is measured only as its complete encoded value.
        }
      }
    }
  }
  return identifiers;
}

function addIdentifier(identifiers, value) {
  if (typeof value === 'string' && value.length >= 2 && value !== WATERMARK_NAME) identifiers.add(value);
}

function identifierPresent(candidate, identifier) {
  if (candidate.candidateStrings.has(identifier)) return true;
  if (identifier.length < 8) return false;
  return JSON.stringify(candidate.project).includes(identifier);
}

function collectStrings(value, output = new Set()) {
  if (typeof value === 'string') output.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      output.add(key);
      collectStrings(item, output);
    }
  }
  return output;
}

function measureDormantBroadcastSurface(project) {
  const receivers = [];
  const emitters = [];
  for (const target of project.targets) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (!isBlock(block)) continue;
      if (block.opcode === 'event_whenbroadcastreceived') {
        receivers.push({id, keys: new Set(broadcastKeysFromReceiver(block))});
      } else if (block.opcode === 'event_broadcast' || block.opcode === 'event_broadcastandwait') {
        emitters.push({
          keys: new Set(broadcastKeysFromEmitter(block)),
          stateGated: isStateGatedBlock(target, id)
        });
      }
    }
  }
  const dormantReceivers = receivers.filter(receiver => {
    const matching = emitters.filter(emitter => setsIntersect(receiver.keys, emitter.keys));
    return matching.length === 0 || matching.every(emitter => emitter.stateGated);
  });
  return {
    hats: dormantReceivers.length,
    commands: emitters.filter(emitter => emitter.stateGated).length
  };
}

function isStateGatedBlock(target, id) {
  const visited = new Set();
  let block = target.blocks[id];
  while (isBlock(block) && typeof block.parent === 'string' && !visited.has(block.parent)) {
    visited.add(block.parent);
    const parent = target.blocks[block.parent];
    if (!isBlock(parent)) return false;
    if (BRANCH_OPCODES.has(parent.opcode)) {
      const condition = activeInputSlots(parent.inputs?.CONDITION)[0];
      if (typeof condition === 'string' && reporterDependsOnState(target, condition, new Set())) return true;
    }
    block = parent;
  }
  return false;
}

function reporterDependsOnState(target, id, visiting) {
  if (visiting.has(id)) return false;
  const block = target.blocks[id];
  if (!isBlock(block)) return false;
  if (block.opcode === 'data_variable' || LIST_INDIRECTION_OPCODES.has(block.opcode)) return true;
  visiting.add(id);
  for (const input of Object.values(block.inputs ?? {})) {
    for (const slot of activeInputSlots(input)) {
      if (typeof slot === 'string' && reporterDependsOnState(target, slot, visiting)) {
        visiting.delete(id);
        return true;
      }
    }
  }
  visiting.delete(id);
  return false;
}

function setsIntersect(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function inputReferencedReporterIds(project) {
  const result = new Set();
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const block of Object.values(target.blocks)) {
      if (!isBlock(block)) continue;
      for (const input of Object.values(block.inputs ?? {})) {
        for (const slot of activeInputSlots(input)) {
          if (typeof slot === 'string' && target.blocks[slot] !== undefined) result.add(`t${targetIndex}:${slot}`);
        }
      }
    }
  }
  return result;
}

function evaluateCondition(project, targetIndex, block, constantValues) {
  const condition = activeInputSlots(block.inputs?.CONDITION)[0];
  return evaluateInput(project, targetIndex, condition, constantValues, new Set());
}

function evaluateReporter(project, targetIndex, id, constantValues, visiting) {
  if (visiting.has(id)) return {known: false};
  const target = project.targets[targetIndex];
  if (!target) return {known: false};
  const block = target.blocks[id];
  if (!isBlock(block)) return {known: false};
  visiting.add(id);
  const read = (name) => evaluateInput(
    project,
    targetIndex,
    activeInputSlots(block.inputs?.[name])[0],
    constantValues,
    visiting
  );
  let result = {known: false};
  if (block.opcode === 'data_variable') {
    result = constantFieldValue(project, targetIndex, 'variable', block.fields?.VARIABLE, constantValues);
  } else if (block.opcode === 'data_itemoflist') {
    const list = constantFieldValue(project, targetIndex, 'list', block.fields?.LIST, constantValues);
    const index = read('INDEX');
    if (list.known && Array.isArray(list.value) && index.known) {
      const item = exactListItem(list.value, index.value);
      if (item.known) result = item;
    } else if (index.known) {
      result = constantListSlotValue(
        project,
        targetIndex,
        block.fields?.LIST,
        index.value,
        constantValues
      );
    }
  } else if (block.opcode === 'data_lengthoflist') {
    const list = constantFieldValue(project, targetIndex, 'list', block.fields?.LIST, constantValues);
    if (list.known && Array.isArray(list.value)) result = {known: true, value: list.value.length};
  } else if (block.opcode === 'operator_join') {
    const left = read('STRING1');
    const right = read('STRING2');
    if (left.known && right.known) {
      result = {known: true, value: `${left.value ?? ''}${right.value ?? ''}`};
    } else {
      const joined = combineFiniteDomains(resultDomain(left), resultDomain(right), (first, second) => (
        `${first ?? ''}${second ?? ''}`
      ));
      if (joined) result = domainResult(joined);
    }
  } else if (block.opcode === 'operator_not') {
    const operand = read('OPERAND');
    if (operand.known) result = {known: true, value: !scratchBoolean(operand.value)};
  } else if (block.opcode === 'operator_and' || block.opcode === 'operator_or') {
    const left = read('OPERAND1');
    const right = read('OPERAND2');
    const leftBoolean = left.known ? scratchBoolean(left.value) : undefined;
    const rightBoolean = right.known ? scratchBoolean(right.value) : undefined;
    if (block.opcode === 'operator_and' && (leftBoolean === false || rightBoolean === false)) {
      result = {known: true, value: false};
    } else if (block.opcode === 'operator_or' && (leftBoolean === true || rightBoolean === true)) {
      result = {known: true, value: true};
    } else if (leftBoolean !== undefined && rightBoolean !== undefined) {
      result = {known: true, value: block.opcode === 'operator_and'
        ? leftBoolean && rightBoolean
        : leftBoolean || rightBoolean};
    }
  } else if (block.opcode === 'operator_equals') {
    const left = read('OPERAND1');
    const right = read('OPERAND2');
    if (left.known && right.known) {
      result = {known: true, value: obviousEqual(left.value, right.value)};
    } else if (!domainsMayEqual(resultDomain(left), resultDomain(right))) {
      result = {known: true, value: false};
    }
  } else if (block.opcode === 'operator_add' || block.opcode === 'operator_subtract' || block.opcode === 'operator_multiply') {
    const left = read('NUM1');
    const right = read('NUM2');
    if (left.known && right.known) {
      const leftNumber = scratchToNumber(left.value);
      const rightNumber = scratchToNumber(right.value);
      result = {known: true, value: block.opcode === 'operator_add'
        ? leftNumber + rightNumber
        : block.opcode === 'operator_subtract' ? leftNumber - rightNumber : leftNumber * rightNumber};
    } else result = domainResult(numericDomain());
  }
  visiting.delete(id);
  return result;
}

function evaluateInput(project, targetIndex, value, constantValues, visiting) {
  const target = project.targets[targetIndex];
  if (typeof value === 'string' && target?.blocks[value] !== undefined) {
    return evaluateReporter(project, targetIndex, value, constantValues, visiting);
  }
  return evaluatePrimitive(project, targetIndex, value, constantValues);
}

function evaluatePrimitive(project, targetIndex, value, constantValues) {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'number') return {known: false};
  if (value[0] >= 4 && value[0] <= 10) return {known: true, value: value[1]};
  if (value[0] === 12) return constantSymbolValue(project, targetIndex, 'variable', value[2], value[1], constantValues);
  if (value[0] === 13) return constantSymbolValue(project, targetIndex, 'list', value[2], value[1], constantValues);
  return {known: false};
}

function constantFieldValue(project, targetIndex, kind, field, constantValues) {
  if (!Array.isArray(field)) return {known: false};
  return constantSymbolValue(project, targetIndex, kind, field[1], field[0], constantValues);
}

function constantSymbolValue(project, targetIndex, kind, id, name, constantValues) {
  const keys = resolveSymbolKeys(project, targetIndex, kind, id, name);
  if (keys.length !== 1) return {known: false};
  const domain = constantValues.get(keys[0]);
  if (domain === undefined) return {known: false};
  const exact = singleExactValue(domain);
  return exact.known ? exact : domainResult(domain);
}

function constantListSlotValue(project, targetIndex, field, index, constantValues) {
  if (!Array.isArray(field)) return {known: false};
  const keys = resolveSymbolKeys(project, targetIndex, 'list', field[1], field[0]);
  const slot = exactStaticListSlot(index);
  if (keys.length !== 1 || slot === undefined) return {known: false};
  const domain = constantValues.get(listSlotKey(keys[0], slot));
  if (domain === undefined) return {known: false};
  const exact = singleExactValue(domain);
  return exact.known ? exact : domainResult(domain);
}

function domainResult(domain) {
  return {known: false, domain};
}

function combineFiniteDomains(left, right, combine) {
  if (left.unknown || right.unknown || left.numeric || right.numeric) return undefined;
  const values = [];
  for (const first of left.values) {
    for (const second of right.values) {
      values.push(combine(first, second));
      if (values.length > MAX_FINITE_DOMAIN_VALUES) return undefined;
    }
  }
  let result = {unknown: false, numeric: false, values: []};
  for (const value of values) result = mergeDomains(result, exactDomain(value));
  return result;
}

function domainsMayEqual(left, right) {
  if (left.unknown || right.unknown) return true;
  if (left.numeric && right.numeric) return true;
  if (left.numeric && right.values.some(numericDomainMayEqual)) return true;
  if (right.numeric && left.values.some(numericDomainMayEqual)) return true;
  for (const first of left.values) {
    for (const second of right.values) if (obviousEqual(first, second)) return true;
  }
  return false;
}

function numericDomainMayEqual(value) {
  const numeric = scratchComparableNumber(value);
  if (!Number.isNaN(numeric)) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  if (normalized === 'nan' || normalized === 'infinity' || normalized === '-infinity') return true;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value);
}

function exactListItem(list, index) {
  if (index === 'last') {
    return list.length === 0 ? {known: true, value: ''} : {known: true, value: list[list.length - 1]};
  }
  if (index === 'random' || index === 'any') {
    return list.length === 0 ? {known: true, value: ''} : {known: false};
  }
  if (index === 'all') return {known: true, value: ''};
  const numeric = Math.floor(scratchToNumber(index));
  if (numeric < 1 || numeric > list.length) return {known: true, value: ''};
  return {known: true, value: list[numeric - 1]};
}

function exactStaticListSlot(index) {
  if (index === 'last' || index === 'random' || index === 'any' || index === 'all') return undefined;
  const numeric = Math.floor(scratchToNumber(index));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : undefined;
}

function obviousEqual(left, right) {
  const leftNumber = scratchComparableNumber(left);
  const rightNumber = scratchComparableNumber(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    if (leftNumber === Infinity && rightNumber === Infinity) return true;
    if (leftNumber === -Infinity && rightNumber === -Infinity) return true;
    return leftNumber - rightNumber === 0;
  }
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function scratchBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  }
  return Boolean(value);
}

function scratchComparableNumber(value) {
  const numeric = Number(value);
  return numeric === 0 && (value === null || (typeof value === 'string' && value.trim().length === 0))
    ? Number.NaN
    : numeric;
}

function scratchToNumber(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function localBlockSignature(blocks, block, folded = new Set(), simpleProcedures = new Map()) {
  const inputs = Object.entries(block.inputs ?? {}).map(([name, input]) => {
    const slots = activeInputSlots(input).map(slot => {
      if (typeof slot === 'string' && folded.has(slot)) return 'literal';
      if (typeof slot === 'string' && isBlock(blocks[slot])) return blocks[slot].opcode;
      if (Array.isArray(slot)) return `primitive:${String(slot[0])}`;
      return typeof slot;
    });
    return `${name}:${slots.join(',')}`;
  }).sort(compareUtf8);
  const fields = Object.keys(block.fields ?? {}).sort(compareUtf8);
  const simple = block.opcode === 'procedures_call' ? simpleProcedures.get(procedureCode(block)) : undefined;
  const opcode = simple ? `inline(${simple.opcodes.join(',')})` : block.opcode;
  return `${opcode}|next:${block.next === null ? 0 : 1}|inputs:${inputs.join(';')}|fields:${fields.join(',')}`;
}

function countBlockEquivalents(project) {
  let count = 0;
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (isBlock(value)) {
        count += 1;
        for (const input of Object.values(value.inputs ?? {})) {
          for (const slot of input.slice(1)) if (Array.isArray(slot)) count += 1;
        }
      } else if (Array.isArray(value)) count += 1;
    }
  }
  return count;
}

function collectBlocks(project) {
  const blocks = [];
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    for (const [id, block] of Object.entries(target.blocks)) {
      if (isBlock(block)) blocks.push({key: `t${targetIndex}:${id}`, id, targetIndex, target, block});
    }
  }
  return blocks;
}

function isBlock(value) {
  return Boolean(value && !Array.isArray(value) && typeof value === 'object' && typeof value.opcode === 'string');
}

function isReporterOpcode(opcode) {
  return REPORTER_PREFIXES.some(prefix => opcode.startsWith(prefix)) || REPORTER_OPCODES.has(opcode);
}

function isRunnableHat(opcode) {
  return opcode.startsWith('event_when')
    || opcode === 'control_start_as_clone'
    || /(?:^|_)when(?:[A-Z_]|$)/.test(opcode);
}

function isIndirectionOpcode(opcode) {
  return opcode === 'procedures_call' || opcode.startsWith('inline(')
    || LIST_INDIRECTION_OPCODES.has(opcode) || BRANCH_OPCODES.has(opcode);
}

function opcodeFamily(opcode) {
  if (opcode.startsWith('inline(') || opcode.startsWith('procedures_')) return 'procedure';
  const separator = opcode.indexOf('_');
  return separator === -1 ? opcode : opcode.slice(0, separator);
}

function procedureCode(block) {
  return typeof block.mutation?.proccode === 'string' ? block.mutation.proccode : '';
}

function broadcastKeysFromReceiver(block) {
  const field = block.fields?.BROADCAST_OPTION;
  if (!Array.isArray(field)) return [];
  return broadcastKeys(field[0], field[1]);
}

function broadcastKeysFromEmitter(block) {
  const input = block.inputs?.BROADCAST_INPUT;
  if (!Array.isArray(input)) return [];
  const slot = activeInputSlots(input)[0];
  if (Array.isArray(slot) && slot[0] === 11) return broadcastKeys(slot[1], slot[2]);
  return [];
}

function activeInputSlots(input) {
  if (!Array.isArray(input)) return [];
  const active = input[1] ?? input[2];
  return active === undefined ? [] : [active];
}

function broadcastKeys(name, id) {
  const keys = [];
  if (typeof id === 'string' && id.length > 0) keys.push(`id:${id}`);
  if (typeof name === 'string' && name.length > 0) keys.push(`name:${name.toLowerCase()}`);
  return keys;
}

function addMapSet(map, key, value) {
  const set = map.get(key) ?? new Set();
  set.add(value);
  map.set(key, set);
}

function addFamilyPair(families, output, left, right) {
  if (families.has(left) && families.has(right)) output.add(`${left}+${right}`);
}

function ngramRecovery(baselineChains, candidateChains) {
  const baseline = chainNgrams(baselineChains);
  const candidate = chainNgrams(candidateChains);
  if (baseline.size === 0) return 1;
  return multisetRecall(baseline, candidate);
}

function ngramRecoveryByWidth(baselineChains, candidateChains) {
  const result = {};
  for (let width = 2; width <= 4; width += 1) {
    const baseline = chainNgrams(baselineChains, width, width);
    const candidate = chainNgrams(candidateChains, width, width);
    result[width] = baseline.size === 0 ? 1 : multisetRecall(baseline, candidate);
  }
  return result;
}

function chainNgrams(chains, minimumWidth = 2, maximumWidth = 4) {
  const result = new Map();
  for (const chain of chains) {
    for (let width = minimumWidth; width <= maximumWidth; width += 1) {
      for (let index = 0; index + width <= chain.length; index += 1) {
        const key = `${width}:${chain.slice(index, index + width).join('>')}`;
        result.set(key, (result.get(key) ?? 0) + width);
      }
    }
  }
  return result;
}

function multisetRecall(baseline, candidate) {
  let total = 0;
  let recovered = 0;
  for (const [key, count] of baseline) {
    total += count;
    recovered += Math.min(count, candidate.get(key) ?? 0);
  }
  return ratio(recovered, total);
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function normalizedEntropy(counts) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total <= 1 || counts.size <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy / Math.log2(counts.size);
}

function distributionDiversity(counts) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total <= 1 || counts.size <= 1) return 0;
  let concentration = 0;
  for (const count of counts.values()) concentration += (count / total) ** 2;
  return (1 - concentration) / (1 - (1 / counts.size));
}

function scaleDiversity(kinds, total) {
  if (kinds <= 0 || total <= 1) return 0;
  return Math.log2(kinds + 1) / Math.log2(total + 1);
}

function topologySignatureCounts(nodes) {
  const incoming = new Map([...nodes.keys()].map(id => [id, []]));
  for (const node of nodes.values()) {
    for (const edge of node.edges) if (nodes.has(edge)) incoming.get(edge)?.push(node.id);
  }
  let labels = new Map([...nodes.values()].map(node => [node.id, node.signature]));
  for (let depth = 0; depth < 2; depth += 1) {
    const nextLabels = new Map();
    for (const node of nodes.values()) {
      const outgoing = node.edges.map(edge => labels.get(edge)).filter(Boolean).sort(compareUtf8);
      const predecessors = (incoming.get(node.id) ?? []).map(id => labels.get(id)).filter(Boolean).sort(compareUtf8);
      const digest = createHash('sha256').update(JSON.stringify({
        self: labels.get(node.id),
        outgoing,
        incoming: predecessors
      })).digest('hex').slice(0, 16);
      nextLabels.set(node.id, digest);
    }
    labels = nextLabels;
  }
  return countValues(labels.values());
}

function topRepeatedSignatures(counts) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || compareUtf8(left[0], right[0]))
    .slice(0, 10)
    .map(([signature, count]) => ({signature, count, share: rounded(ratio(count, total))}));
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedMean(entries) {
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight === 0) return 0;
  return entries.reduce((sum, [value, weight]) => sum + (value * weight), 0) / totalWeight;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function saturate(value) {
  return Math.max(0, Math.min(1, value));
}

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundWidthRecovery(recovery) {
  return {
    2: rounded(recovery[2]),
    3: rounded(recovery[3]),
    4: rounded(recovery[4])
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function compareComponent(left, right) {
  return compareShape(left.shape, right.shape);
}

function compareShape(left, right) {
  return compareUtf8(JSON.stringify(left), JSON.stringify(right));
}

function assertProject(project, label) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.targets)) {
    throw new Error(`${label} is not a Scratch 3 project`);
  }
  for (const target of project.targets) {
    if (!target || typeof target !== 'object' || !target.blocks || typeof target.blocks !== 'object') {
      throw new Error(`${label} contains a target without a block map`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage: node scripts/readability-metrics.mjs --baseline <project.sb3|json>',
      '  --candidate <label=project.sb3|json> [--candidate <label=path> ...] [--summary]',
      '',
      'JSON is emitted by default. Candidate order is treated as iteration order.',
      ''
    ].join('\n'));
    return;
  }
  let baselinePath;
  const candidates = [];
  let summary = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--summary') {
      summary = true;
    } else if (argument === '--baseline') {
      baselinePath = args[index + 1];
      index += 1;
    } else if (argument === '--candidate') {
      const specification = args[index + 1];
      index += 1;
      const separator = specification?.indexOf('=') ?? -1;
      if (!specification || separator <= 0 || separator === specification.length - 1) {
        throw new Error('--candidate must use label=path');
      }
      candidates.push({label: specification.slice(0, separator), path: specification.slice(separator + 1)});
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (!baselinePath) throw new Error('--baseline is required');
  if (candidates.length === 0) throw new Error('at least one --candidate is required');
  const baselineProject = await loadProjectFile(baselinePath);
  const iterations = [];
  for (const candidate of candidates) {
    iterations.push({label: candidate.label, project: await loadProjectFile(candidate.path)});
  }
  const report = createReadabilityReport(baselineProject, iterations);
  process.stdout.write(summary ? formatReadabilitySummary(report) : `${JSON.stringify(report, null, 2)}\n`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`readability measurement failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
