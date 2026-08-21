#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {extname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';
import {strFromU8, unzipSync} from 'fflate';

const SCHEMA_VERSION = 1;
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

export function formatReadabilitySummary(report) {
  const lines = [
    'iteration\tscore\tidentifier-concealment\tdirect-chain-recovery\tnormalized-recovery\tretained-quality\tindirection\tdependencies\tsignature-scale\ttopology-scale\tmax-signature-share\tpaired-channels\tbroadcast-templates\tprune-ratio\tobvious-never-sent-hats'
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
    obviousPruneRatio: rounded(analysis.profile.obviousPruneRatio)
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
  const normalizedOpcodeRecovery = multisetRecall(
    baseline.normalization.opcodeCounts,
    candidate.normalization.opcodeCounts
  );
  const normalizedRecovery = normalizedChainRecovery;
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
    components: graphMetrics.components.sort(compareComponent),
    neverSentBroadcastHats: reachability.neverSentBroadcastHats,
    inlinedProcedureCalls,
    provenFalseControls,
    constantDeclarations: reachability.constantValues.size,
    mutableDeclarations: reachability.unknownSymbols.size,
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
    procedureTemplates
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
      const unknownSymbols = new Set();
      for (const [key, domain] of symbolDomains) {
        const exact = singleExactValue(domain);
        if (exact.known) constantValues.set(key, exact.value);
        else unknownSymbols.add(key);
      }
      reachability.constantValues = constantValues;
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
        values.set(symbolKey('list', targetIndex, id), declaration[1]);
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
