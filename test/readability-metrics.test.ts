import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {
  createReadabilityReport,
  formatReadabilitySummary,
  measureProject,
  recoverAdversarialStructure,
  type ReadabilityCandidate,
  type ReadabilityReport,
  type TamperIntegrityAnalysis
} from '../scripts/readability-metrics.mjs';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {JsonValue, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

const requireModule = createRequire(import.meta.url);
const scratchVmEntry = requireModule.resolve('@scratch/scratch-vm');
const ScratchCast = requireModule(resolve(dirname(scratchVmEntry), '..', '..', 'src', 'util', 'cast.js')) as {
  compare(left: unknown, right: unknown): number;
  toBoolean(value: unknown): boolean;
};

describe('readability and structural recovery measurements', () => {
  it('compares every mode deterministically using several size-independent resistance signals', () => {
    const source = readabilityFixture();
    const report = modeReport(source);
    const repeated = modeReport(structuredClone(source));

    expect(JSON.stringify(repeated)).toBe(JSON.stringify(report));
    expect(report.schemaVersion).toBe(9);
    expect(report.candidates.map(candidate => candidate.label)).toEqual(['lossless', 'lossy', 'no-preserve']);
    expect(report.trend.map(entry => `${entry.from}->${entry.to}`)).toEqual([
      'original->lossless',
      'lossless->lossy',
      'lossy->no-preserve'
    ]);

    const lossless = candidate(report, 'lossless');
    const lossy = candidate(report, 'lossy');
    const strongest = candidate(report, 'no-preserve');
    for (const measured of [lossless, lossy, strongest]) {
      expect(measured.comparison.resistanceScore).toBeGreaterThanOrEqual(0);
      expect(measured.comparison.resistanceScore).toBeLessThanOrEqual(100);
      expect(measured.comparison.directChainRecovery).toBeGreaterThanOrEqual(0);
      expect(measured.comparison.directChainRecovery).toBeLessThanOrEqual(1);
      expect(measured.profile.normalizedSignatureDensity).toBeGreaterThanOrEqual(0);
      expect(measured.profile.normalizedSignatureDensity).toBeLessThanOrEqual(1);
      expect(measured.profile.normalizedTopologyDensity).toBeGreaterThanOrEqual(0);
      expect(measured.profile.normalizedTopologyDensity).toBeLessThanOrEqual(1);
    }
    expect(lossless.comparison.identifierConcealment).toBeGreaterThan(0.95);
    expect(lossless.comparison.directChainRecovery).toBe(1);
    expect(lossless.comparison.normalizedRecovery).toBe(1);

    expect(lossy.profile.branchBlocks).toBeGreaterThan(lossless.profile.branchBlocks);
    expect(lossy.profile.operators).toBeGreaterThan(lossless.profile.operators);
    expect(lossy.profile.reporters).toBeGreaterThan(lossless.profile.reporters);
    expect(lossy.comparison.resistanceScore).toBeGreaterThan(lossless.comparison.resistanceScore + 30);
    expect(lossy.comparison.directChainRecovery).toBeLessThan(lossless.comparison.directChainRecovery - 0.5);

    expect(strongest.comparison.resistanceScore).toBeGreaterThan(lossy.comparison.resistanceScore + 1);
    expect(strongest.comparison.directChainRecovery).toBeLessThan(lossy.comparison.directChainRecovery - 0.05);
    expect(strongest.comparison.devirtualizedChainRecovery)
      .toBeGreaterThanOrEqual(strongest.comparison.normalizedChainRecovery);
    expect(strongest.comparison.normalizedRecovery).toBe(strongest.comparison.devirtualizedChainRecovery);
    expect(strongest.profile.recoveredDispatchers).toBe(0);
    expect(strongest.profile.recoveredDispatcherTransitionEdges).toBe(0);
    expect(strongest.profile.unresolvedDispatcherTransitionEdges).toBe(0);
    expect(strongest.profile.recoveredDispatcherOperations).toBe(0);
    expect(strongest.comparison.indirectionDensity).toBeGreaterThan(0.24);
    expect(strongest.comparison.retainedDependencyQuality).toBeGreaterThan(0.8);
    expect(strongest.profile.crossFamilyDependencyDensity).toBeGreaterThan(0.25);
    expect(strongest.profile.obviousPruneRatio).toBeLessThan(0.41);
    expect(strongest.profile.coherentMixedComponents).toBeGreaterThanOrEqual(1);
    expect(strongest.profile.semanticDependencyKindCount).toBeGreaterThanOrEqual(6);
    expect(strongest.profile.customDefinitions).toBeGreaterThan(0);
    expect(strongest.profile.customCalls).toBeGreaterThan(0);
    expect(lossy.profile.broadcastReceiverHats).toBe(lossless.profile.broadcastReceiverHats);
    expect(strongest.profile.pairedBroadcastChannels).toBeGreaterThan(lossy.profile.pairedBroadcastChannels + 2);
    expect(strongest.profile.reachableBroadcastSenders)
      .toBeGreaterThanOrEqual(strongest.profile.pairedBroadcastChannels);
    expect(strongest.profile.reachableBroadcastReceivers)
      .toBeGreaterThanOrEqual(strongest.profile.reachableBroadcastSenders);
    expect(strongest.profile.unpairedBroadcastReceiverHats).toBe(0);
    expect(strongest.profile.broadcastPairBalance).toBeGreaterThan(0.65);
    expect(strongest.profile.retainedBroadcastPairRatio).toBe(1);
    expect(strongest.profile.broadcastProcedureTemplateKinds).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.procedureTemplateKinds).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.procedureTemplateDiversity).toBeGreaterThan(0.15);
    expect(strongest.profile.procedureWarpVariants).toBe(2);
    expect(strongest.profile.componentTemplateKinds).toBeGreaterThanOrEqual(2);
    expect(strongest.profile.normalizedSignatureKinds).toBeGreaterThanOrEqual(72);
    expect(strongest.profile.normalizedSignatureDensity).toBeGreaterThan(0.1);
    expect(strongest.profile.normalizedSignatureScaleDiversity).toBeGreaterThan(0.65);
    expect(strongest.profile.normalizedTopologyDensity).toBeGreaterThan(0.55);
    expect(strongest.profile.normalizedTopologyScaleDiversity).toBeGreaterThan(0.9);
    expect(strongest.profile.normalizedTopRepeatedSignatures[0]?.share).toBeLessThan(0.12);
    expect(strongest.profile.provenFalseControls).toBeLessThanOrEqual(19);
    expect(strongest.profile.recoveredDispatcherRoutes).toBe(0);
    expect(strongest.profile.recoveredDispatcherTransitions).toBe(0);
    expect(strongest.profile.concretelyRecoveredDispatcherTransitionEdges).toBe(0);
    expect(strongest.profile.symbolicallyRecoveredDispatcherTransitionEdges).toBe(0);
    expect(strongest.profile.completeDispatcherRecoveries).toBe(0);
    expect(strongest.profile.partialDispatcherRecoveries).toBe(0);
    expect(strongest.profile.structuralOnlyDispatcherRecoveries).toBe(0);
  });

  it('keeps no-preserve measurably more indirect when lossy live rewrites are fully eligible', () => {
    const source = readabilityFixture();
    const stage = requireStage(source);
    const sprite = requireSprite(source);
    stage.broadcasts = {};
    const volume = sprite.blocks['main-volume'];
    if (!volume || Array.isArray(volume)) throw new Error('fixture volume block is unavailable');
    volume.next = null;
    for (const id of [
      'main-broadcast',
      'launch-receiver',
      'launch-if',
      'launch-equals',
      'launch-variable',
      'launch-change',
      'launch-finish'
    ]) delete sprite.blocks[id];
    validateProject(source);

    const report = modeReport(source);
    const lossless = candidate(report, 'lossless');
    const lossy = candidate(report, 'lossy');
    const strongest = candidate(report, 'no-preserve');
    expect(strongest.comparison.resistanceScore).toBeGreaterThan(lossless.comparison.resistanceScore + 25);
    expect(strongest.comparison.directChainRecovery).toBeLessThan(0.5);
    expect(strongest.profile.listIndirections).toBeGreaterThan(lossy.profile.listIndirections);
    expect(strongest.comparison.devirtualizedChainRecovery)
      .toBeGreaterThanOrEqual(strongest.comparison.normalizedChainRecovery);
    expect(lossy.profile.broadcastReceiverHats).toBe(0);
    expect(lossy.profile.pairedBroadcastChannels).toBe(0);
    expect(strongest.profile.pairedBroadcastChannels).toBeGreaterThan(lossy.profile.pairedBroadcastChannels);
    expect(strongest.profile.broadcastProcedureTemplateKinds)
      .toBeGreaterThan(lossy.profile.broadcastProcedureTemplateKinds);
    expect(strongest.profile.unpairedBroadcastReceiverHats).toBe(0);
    expect(strongest.profile.obviousPruneRatio).toBeLessThan(0.36);
  });

  it('does not reward thousands of repeated, obviously unreachable blocks', () => {
    const source = readabilityFixture();
    const report = modeReport(source);
    const strongest = candidate(report, 'no-preserve');
    const repeatedJunk = structuredClone(source);
    const stage = requireStage(repeatedJunk);
    const sprite = requireSprite(repeatedJunk);
    for (let index = 0; index < 2_000; index += 1) {
      sprite.blocks[`repeated-junk-${index}`] = block(
        'data_setvariableto',
        null,
        null,
        true,
        {VALUE: [1, [4, '0']]},
        {VARIABLE: ['Readable score', 'readable-score-id']}
      );
    }
    for (let index = 0; index < 100; index += 1) {
      const broadcastId = `orphan-broadcast-${index}`;
      stage.broadcasts[broadcastId] = `Orphan ${index}`;
      sprite.blocks[`orphan-hat-${index}`] = block(
        'event_whenbroadcastreceived',
        null,
        null,
        true,
        {},
        {BROADCAST_OPTION: [`Orphan ${index}`, broadcastId]}
      );
    }
    const junkReport = createReadabilityReport(source, [{label: 'repeated-junk', project: repeatedJunk}]);
    const junk = candidate(junkReport, 'repeated-junk');

    expect(junk.profile.objectBlocks).toBeGreaterThan(strongest.profile.objectBlocks);
    expect(junk.profile.prunedByNormalizer).toBeGreaterThanOrEqual(2_100);
    expect(junk.profile.neverSentBroadcastHats).toBe(100);
    expect(junk.profile.unpairedBroadcastReceiverHats).toBe(100);
    expect(junk.profile.pairedBroadcastChannels).toBe(losslessPairedChannels(report));
    expect(junk.comparison.directChainRecovery).toBe(1);
    expect(junk.comparison.normalizedRecovery).toBe(1);
    expect(junk.comparison.identifierConcealment).toBe(0);
    expect(junk.comparison.resistanceScore).toBeLessThan(strongest.comparison.resistanceScore - 35);
  });

  it('reports low signature and topology coverage for balanced reachable repetition', () => {
    const source = readabilityFixture();
    const repetitive = structuredClone(source);
    const sprite = requireSprite(repetitive);
    sprite.blocks['repetition-hat'] = block('event_whenflagclicked', 'repetition-0', null, true);
    const repeatedBlocks = 2_000;
    for (let index = 0; index < repeatedBlocks; index += 1) {
      const id = `repetition-${index}`;
      const next = index + 1 < repeatedBlocks ? `repetition-${index + 1}` : null;
      const parent = index === 0 ? 'repetition-hat' : `repetition-${index - 1}`;
      const variant = index % 4;
      sprite.blocks[id] = variant === 0
        ? block(
            'data_setvariableto',
            next,
            parent,
            false,
            {VALUE: [1, [4, '1']]},
            {VARIABLE: ['Readable score', 'readable-score-id']}
          )
        : variant === 1
          ? block(
              'data_changevariableby',
              next,
              parent,
              false,
              {VALUE: [1, [4, '1']]},
              {VARIABLE: ['Readable score', 'readable-score-id']}
            )
          : variant === 2
            ? block(
                'data_addtolist',
                next,
                parent,
                false,
                {ITEM: [1, [10, 'repeated']]},
                {LIST: ['Readable records', 'readable-list-id']}
              )
            : block(
                'data_replaceitemoflist',
                next,
                parent,
                false,
                {INDEX: [1, [4, '1']], ITEM: [1, [10, 'repeated']]},
                {LIST: ['Readable records', 'readable-list-id']}
              );
    }
    validateProject(repetitive);

    const report = createReadabilityReport(source, [{label: 'reachable-repetition', project: repetitive}]);
    const measured = candidate(report, 'reachable-repetition');
    expect(measured.profile.normalizedSignatureDiversity).toBeGreaterThan(0.75);
    expect(measured.profile.normalizedSignatureDensity).toBeLessThan(0.02);
    expect(measured.profile.normalizedSignatureScaleDiversity).toBeLessThan(0.4);
    expect(measured.profile.normalizedTopologyDensity).toBeLessThan(0.03);
    expect(measured.profile.normalizedTopologyScaleDiversity).toBeLessThan(0.5);
    expect(measured.profile.normalizedTopRepeatedSignatures[0]?.count).toBeGreaterThan(400);
    expect(measured.comparison.structuralQuality).toBeLessThan(0.75);
  });

  it('keeps large generated graphs accountable to absolute signature and topology coverage', () => {
    const source = largeRepeatedFixture(300);
    const transformed = obfuscateProject(source, 'no-preserve', seed()).project;
    const report = createReadabilityReport(source, [{label: 'large-no-preserve', project: transformed}]);
    const measured = candidate(report, 'large-no-preserve');
    const profile = measured.profile;
    const baseline = report.baseline.profile;

    expect(profile.objectBlocks).toBeGreaterThan(baseline.objectBlocks * 2);
    expect(profile.retainedAfterNormalization).toBeGreaterThan(baseline.retainedAfterNormalization * 2);
    expect(profile.blockEquivalents).toBeLessThanOrEqual((baseline.blockEquivalents * 3) + 512);
    expect(profile.normalizedSignatureKinds).toBeGreaterThan(baseline.normalizedSignatureKinds * 2);
    expect(profile.normalizedSignatureDensity).toBeGreaterThan(baseline.normalizedSignatureDensity);
    expect(profile.normalizedSignatureDensity).toBeLessThan(0.15);
    expect(profile.normalizedSignatureScaleDiversity).toBeGreaterThan(0.42);
    expect(profile.normalizedSignatureScaleDiversity).toBeLessThan(0.8);
    expect(profile.normalizedTopologyKinds).toBeGreaterThan(baseline.normalizedTopologyKinds * 2);
    expect(profile.normalizedTopologyDensity).toBeGreaterThan(0.2);
    expect(profile.normalizedTopologyScaleDiversity).toBeGreaterThan(0.82);
    expect(profile.normalizedTopologyScaleDiversity).toBeGreaterThan(
      profile.normalizedSignatureScaleDiversity + 0.1
    );
    expect(profile.normalizedTopRepeatedSignatures[0]?.share).toBeLessThanOrEqual(0.09);
    expect(profile.obviousPruneRatio).toBeLessThan(0.6);
    expect(profile.pairedBroadcastChannels).toBeGreaterThan(baseline.pairedBroadcastChannels);
    expect(profile.procedureTemplateDiversity).toBeGreaterThan(0.7);
    expect(measured.comparison.retainedDependencyQuality).toBeGreaterThan(0.9);
  }, 40_000);

  it('canonicalizes names, IDs, and layout while pruning manual roots and never-sent receivers', () => {
    const source = readabilityFixture();
    const noisy = structuredClone(source);
    const stage = requireStage(noisy);
    const sprite = requireSprite(noisy);
    stage.broadcasts['unreachable-broadcast-id'] = 'Unreachable event';
    sprite.blocks['unreachable-hat'] = block(
      'event_whenbroadcastreceived',
      'unreachable-change',
      null,
      true,
      {},
      {BROADCAST_OPTION: ['Unreachable event', 'unreachable-broadcast-id']}
    );
    sprite.blocks['unreachable-change'] = block(
      'data_changevariableby',
      null,
      'unreachable-hat',
      false,
      {VALUE: [1, [4, '999']]},
      {VARIABLE: ['Readable score', 'readable-score-id']}
    );
    for (let index = 0; index < 20; index += 1) {
      sprite.blocks[`manual-root-${index}`] = block('looks_say', null, null, true, {MESSAGE: [1, [10, 'noise']]});
    }
    const renamed = renameBlockIdsAndMove(noisy);
    const baselineProfile = measureProject(source);
    const noisyProfile = measureProject(noisy);
    const renamedProfile = measureProject(renamed);

    expect(noisyProfile.neverSentBroadcastHats).toBe(1);
    expect(noisyProfile.prunedByNormalizer - baselineProfile.prunedByNormalizer).toBeGreaterThanOrEqual(22);
    expect(noisyProfile.normalizedDigest).toBe(baselineProfile.normalizedDigest);
    expect(renamedProfile.normalizedDigest).toBe(noisyProfile.normalizedDigest);
    expect(renamedProfile.retainedComponentShapes).toEqual(noisyProfile.retainedComponentShapes);
  });

  it('folds transparent reporters and inlines short custom procedures before measuring recovery', () => {
    const project = readabilityFixture();
    const sprite = requireSprite(project);
    const say = sprite.blocks['main-say'];
    if (!say || Array.isArray(say)) throw new Error('fixture say block is unavailable');
    say.inputs['MESSAGE'] = [3, 'fixed-join', [10, 'discarded']];
    sprite.blocks['fixed-join'] = block(
      'operator_join',
      null,
      'main-say',
      false,
      {STRING1: [1, [10, 'fixed']], STRING2: [1, [10, ' text']]}
    );
    sprite.blocks['procedure-hat'] = block('event_whenkeypressed', 'procedure-call', null, true, {}, {KEY_OPTION: ['space', null]});
    sprite.blocks['procedure-call'] = {
      ...block('procedures_call', null, 'procedure-hat', false),
      mutation: {tagName: 'mutation', children: [], proccode: 'Readable helper', argumentids: '[]', warp: 'false'}
    };
    sprite.blocks['procedure-definition'] = block(
      'procedures_definition',
      'procedure-body-one',
      null,
      true,
      {custom_block: [1, 'procedure-prototype']}
    );
    sprite.blocks['procedure-prototype'] = {
      ...block('procedures_prototype', null, 'procedure-definition', false),
      shadow: true,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode: 'Readable helper',
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        warp: 'false'
      }
    };
    sprite.blocks['procedure-body-one'] = block(
      'looks_say',
      'procedure-body-two',
      'procedure-definition',
      false,
      {MESSAGE: [1, [10, 'helper']]}
    );
    sprite.blocks['procedure-body-two'] = block(
      'data_addtolist',
      null,
      'procedure-body-one',
      false,
      {ITEM: [1, [10, 'helper']]},
      {LIST: ['Readable records', 'readable-list-id']}
    );
    validateProject(project);

    const profile = measureProject(project);
    expect(profile.foldedReporters).toBeGreaterThanOrEqual(1);
    expect(profile.inlinedProcedures).toBe(1);
    expect(profile.prunedByNormalizer).toBeGreaterThanOrEqual(4);
  });

  it('counts identifiers recovered by folding split constant reporters as exposed', () => {
    const baseline = splitIdentifierFixture(false);
    const split = splitIdentifierFixture(true);
    expect(JSON.stringify(split)).not.toContain('SecretName');

    const measured = candidate(
      createReadabilityReport(baseline, [{label: 'split-constant', project: split}]),
      'split-constant'
    );
    expect(measured.profile.foldedReporters).toBe(1);
    expect(measured.comparison.exposedOriginalIdentifiers).toBe(1);
    expect(measured.comparison.identifierConcealment).toBeLessThan(1);
  });

  it('ignores inactive saved shadow blocks during adversarial normalization', () => {
    const activeOnly = readabilityFixture();
    const activeSprite = requireSprite(activeOnly);
    const activeSay = activeSprite.blocks['main-say'];
    if (!activeSay || Array.isArray(activeSay)) throw new Error('fixture say block is unavailable');
    activeSay.inputs['MESSAGE'] = [2, 'active-answer'];
    activeSprite.blocks['active-answer'] = block('sensing_answer', null, 'main-say', false);

    const withFallback = structuredClone(activeOnly);
    const fallbackSprite = requireSprite(withFallback);
    const fallbackSay = fallbackSprite.blocks['main-say'];
    if (!fallbackSay || Array.isArray(fallbackSay)) throw new Error('fixture say block is unavailable');
    fallbackSay.inputs['MESSAGE'] = [3, 'active-answer', 'inactive-shadow'];
    fallbackSprite.blocks['inactive-shadow'] = {
      ...block(
        'operator_join',
        null,
        'main-say',
        false,
        {STRING1: [1, [10, 'inactive']], STRING2: [1, [10, 'fallback']]}
      ),
      shadow: true
    };
    validateProject(activeOnly);
    validateProject(withFallback);

    const activeProfile = measureProject(activeOnly);
    const fallbackProfile = measureProject(withFallback);
    expect(fallbackProfile.objectBlocks).toBe(activeProfile.objectBlocks + 1);
    expect(fallbackProfile.retainedAfterNormalization).toBe(activeProfile.retainedAfterNormalization);
    expect(fallbackProfile.normalizedDigest).toBe(activeProfile.normalizedDigest);
  });

  it('prunes broadcast, procedure, and data flow guarded only by immutable false state', () => {
    const guarded = immutableGuardFixture(false);
    const stripped = immutableGuardFixture(false);
    const sprite = requireSprite(stripped);
    const after = sprite.blocks['guard-after'];
    const hat = sprite.blocks['guard-hat'];
    if (!after || Array.isArray(after) || !hat || Array.isArray(hat)) throw new Error('guard fixture is unavailable');
    hat.next = 'guard-after';
    after.parent = 'guard-hat';
    for (const id of Object.keys(sprite.blocks)) {
      if (id !== 'guard-hat' && id !== 'guard-after') delete sprite.blocks[id];
    }

    const guardedProfile = measureProject(guarded);
    const strippedProfile = measureProject(stripped);
    expect(guardedProfile.provenFalseControls).toBe(1);
    expect(guardedProfile.neverSentBroadcastHats).toBe(1);
    expect(guardedProfile.reachableBroadcastSenders).toBe(0);
    expect(guardedProfile.reachableBroadcastReceivers).toBe(0);
    expect(guardedProfile.reachableProcedures).toBe(0);
    expect(guardedProfile.mutableDeclarations).toBe(0);
    expect(guardedProfile.normalizedDigest).toBe(strippedProfile.normalizedDigest);
  });

  it('prunes a written rail when its finite values remain unequal to the guard sentinel', () => {
    const guarded = immutableGuardFixture(true);
    const sprite = requireSprite(guarded);
    const writer = sprite.blocks['guard-writer'];
    if (!writer || Array.isArray(writer)) throw new Error('guard writer is unavailable');
    writer.opcode = 'data_changevariableby';
    writer.inputs['VALUE'] = [1, [4, '1']];
    validateProject(guarded);
    const profile = measureProject(guarded);

    expect(profile.provenFalseControls).toBe(1);
    expect(profile.neverSentBroadcastHats).toBe(1);
    expect(profile.mutableDeclarations).toBeGreaterThanOrEqual(1);
    expect(profile.reachableBroadcastSenders).toBe(0);
    expect(profile.reachableBroadcastReceivers).toBe(0);
    expect(profile.pairedBroadcastChannels).toBe(0);
    expect(profile.reachableProcedures).toBe(0);
  });

  it('propagates an untouched constant list slot across an unrelated dynamic slot write', () => {
    const project = constantListSlotFixture();
    const profile = measureProject(project);

    expect(profile.mutableDeclarations).toBe(1);
    expect(profile.provenConstantListSlots).toBe(1);
    expect(profile.provenFalseControls).toBe(1);
    expect(profile.retainedAfterNormalization).toBe(4);
  });

  it('recovers custom-procedure call and return edges for non-inlineable bodies', () => {
    const profile = measureProject(procedureReturnFixture());

    expect(profile.recoveredProcedureCallEdges).toBe(1);
    expect(profile.recoveredProcedureReturnEdges).toBe(1);
    expect(profile.retainedComponents).toBe(1);
  });

  it('keeps direct dispatch recovery and proves evolving-key recovery only through consistent rail equations', () => {
    const direct = recoverAdversarialStructure(dispatcherRecoveryFixture('direct'));
    const evolvingFixture = dispatcherRecoveryFixture('evolving');
    const evolving = recoverAdversarialStructure(evolvingFixture);
    const inconsistentFixture = structuredClone(evolvingFixture);
    const keyStore = requireSprite(inconsistentFixture).lists['key-store-id'];
    if (!keyStore || !Array.isArray(keyStore[1])) throw new Error('key transition store is unavailable');
    keyStore[1][1] = Number(keyStore[1][1]) + 1;
    const inconsistent = recoverAdversarialStructure(inconsistentFixture);
    const inconsistentProfile = measureProject(inconsistentFixture);
    const dynamicIndexFixture = makeDispatcherTransitionIndicesDynamic(evolvingFixture);
    const dynamicIndex = recoverAdversarialStructure(dynamicIndexFixture);
    const dynamicIndexProfile = measureProject(dynamicIndexFixture);
    const expectedChain = [
      'motion_changexby',
      'looks_say',
      'sound_setvolumeto',
      'motion_changeyby'
    ];
    expect({
      direct: direct.digest,
      evolving: evolving.digest,
      inconsistent: inconsistent.digest,
      dynamicIndex: dynamicIndex.digest
    }).toEqual({
      direct: 'bc295a2f59c9ded1266f9b0117cb28b7ea68da904940a36eaedb5a95026bd58c',
      evolving: 'd7aecf648f8aabc2c5cd860e99317ba769d9eae0ff43d3d3d9563eafbdff29af',
      inconsistent: '6b2087801869fb286b9074e3cfde7218c7432439ff2cfc45d614ee67d4be85f6',
      dynamicIndex: 'c6572c5d9e1c39b2965fd28b817108285febdde9ac964fe838597ff4a53d7303'
    });

    expect(direct.dispatchers).toEqual([expect.objectContaining({
      stateRailCount: 1,
      transitionStoreCount: 1,
      relational: false,
      recoveryMethod: 'static',
      recoveryStatus: 'complete',
      recoveredTransitionEdges: 3,
      unresolvedTransitionEdges: 0,
      recoveredChains: [expectedChain]
    })]);
    expect(evolving.dispatchers).toEqual([expect.objectContaining({
      stateRailCount: 3,
      transitionStoreCount: 2,
      relational: true,
      recoveryMethod: 'static',
      recoveryStatus: 'complete',
      recoveredTransitionEdges: 3,
      unresolvedTransitionEdges: 0,
      recoveredChains: [expectedChain]
    })]);
    expect(inconsistent.dispatchers).toEqual([expect.objectContaining({
      stateRailCount: 3,
      transitionStoreCount: 2,
      relational: true,
      recoveryMethod: 'static',
      unresolvedReasons: ['relational-path-inconsistent'],
      recoveryStatus: 'partial',
      recoveredTransitionEdges: 3,
      unresolvedTransitionEdges: 0,
      recoveredChains: [expectedChain]
    })]);
    expect(inconsistentProfile.relationalDispatcherRecoveries).toBe(1);
    expect(inconsistentProfile.completeDispatcherRecoveries).toBe(0);
    expect(inconsistentProfile.partialDispatcherRecoveries).toBe(1);
    expect(dynamicIndex.dispatchers).toEqual([expect.objectContaining({
      routeCount: 5,
      transitionCount: 4,
      stateRailCount: 3,
      transitionStoreCount: 2,
      relational: true,
      recoveryMethod: 'path-sensitive',
      recoveryStatus: 'structural-only',
      recoveredTransitionEdges: 0,
      unresolvedTransitionEdges: 3,
      entryRouteRecovered: true,
      exitStateValidated: false,
      unresolvedReasons: [
        'exit-state-mismatch',
        'incomplete-handler-coverage',
        'terminal-exit-not-reached',
        'transition-route-not-found'
      ],
      recoveredChains: []
    })]);
    expect(dynamicIndexProfile.relationalDispatcherRecoveries).toBe(1);
    expect(dynamicIndexProfile.completeDispatcherRecoveries).toBe(0);
    expect(dynamicIndexProfile.structuralOnlyDispatcherRecoveries).toBe(1);
  });

  it('measures static anti-tamper dependencies without assuming normal initial values stay fixed', () => {
    const source = readabilityFixture();
    const plain = recoverAdversarialStructure(
      obfuscateProject(source, 'lossless', seed()).project
    );
    const protectedProject = obfuscateProject(source, 'lossless', seed(), {antiCheat: true}).project;
    const protectedFirst = recoverAdversarialStructure(protectedProject);
    const protectedSecond = recoverAdversarialStructure(structuredClone(protectedProject));

    expect(protectedSecond).toEqual(protectedFirst);
    expect(protectedFirst.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(protectedFirst.tamperGuardedSymbols).toBeGreaterThan(plain.tamperGuardedSymbols);
    expect(protectedFirst.tamperGuardSites).toBeGreaterThan(plain.tamperGuardSites);
    expect(protectedFirst.staticControlDependencyEdges).toBeGreaterThan(plain.staticControlDependencyEdges);
    expect(protectedFirst.tamperGuardCoverage).toBeGreaterThan(0);
    expect(protectedFirst.tamperGuardCoverage).toBeLessThan(1);
  });

  it('computes bounded integrity cuts and exposes single-component bypasses', () => {
    const source = integrityCutFixture();
    const transformed = obfuscateProject(
      source,
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    const baselineProfile = measureProject(transformed);
    const baseline = recoverAdversarialStructure(transformed).tamperIntegrityAnalysis;

    expect({
      scope: baseline.scope,
      status: baseline.status,
      cutBound: baseline.cutBound,
      pairs: baseline.integrityPairCount,
      complete: baseline.completePairCount,
      degraded: baseline.degradedPairCount,
      disconnected: baseline.disconnectedPairCount,
      ambiguous: baseline.ambiguousPairCount,
      refresh: baseline.refreshPathCount,
      guards: baseline.guardPathCount,
      watchdogs: baseline.watchdogPathCount,
      sinks: baseline.tripSinkCount,
      persistent: baseline.persistentTripStateCount,
      independent: baseline.independentIntegrityComponents,
      bypasses: baseline.singleComponentBypassCount,
      cut: baseline.weakestComponentCut,
      structuralCut: baseline.weakestStructuralComponentCut
    }).toEqual({
      scope: 'bounded-static-integrity-graph',
      status: 'analyzed',
      cutBound: 3,
      pairs: 1,
      complete: 1,
      degraded: 0,
      disconnected: 0,
      ambiguous: 0,
      refresh: 4,
      guards: 2,
      watchdogs: 1,
      sinks: 2,
      persistent: 2,
      independent: 2,
      bypasses: 1,
      cut: 1,
      structuralCut: 2
    });
    expect(baseline.pairs.every(pair => (
      pair.analysisStatus === 'complete'
      && pair.smallestComponentCut === 1
      && pair.smallestCutComponentKinds.join(',') === 'integrity-tag'
      && pair.smallestStructuralComponentCut === 2
      && pair.independentIntegrityComponents === 2
      && pair.singleComponentBypass === true
    ))).toBe(true);
    expect(baseline.caveats).toContain('offline-project-editing-remains-out-of-scope');
    expect(baselineProfile.tamperWeakestComponentCut).toBe(1);
    expect(baselineProfile.tamperWeakestStructuralComponentCut).toBe(2);
  });

  it('recovers cyclic linked tags and measures coupled refresh resilience', () => {
    const transformed = obfuscateProject(
      linkedIntegrityCutFixture(),
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    const profile = measureProject(transformed);
    const first = recoverAdversarialStructure(transformed).tamperIntegrityAnalysis;
    const repeated = recoverAdversarialStructure(structuredClone(transformed)).tamperIntegrityAnalysis;

    expect(repeated).toEqual(first);
    expect({
      status: first.status,
      pairs: first.integrityPairCount,
      groups: first.integrityGroupCount,
      completeGroups: first.completeIntegrityGroupCount,
      ambiguousGroups: first.ambiguousIntegrityGroupCount,
      linkedGroups: first.linkedIntegrityGroupCount,
      linkedPairs: first.linkedIntegrityPairCount,
      linkEdges: first.integrityLinkEdgeCount,
      refresh: first.refreshPathCount,
      coupledRefresh: first.coupledRefreshPathCount,
      guards: first.guardPathCount,
      watchdogs: first.watchdogPathCount,
      independent: first.independentIntegrityComponents,
      bypasses: first.singleComponentBypassCount,
      cut: first.weakestComponentCut,
      structuralCut: first.weakestStructuralComponentCut
    }).toEqual({
      status: 'analyzed',
      pairs: 2,
      groups: 1,
      completeGroups: 1,
      ambiguousGroups: 0,
      linkedGroups: 1,
      linkedPairs: 2,
      linkEdges: 2,
      refresh: 8,
      coupledRefresh: 4,
      guards: 8,
      watchdogs: 4,
      independent: 2,
      bypasses: 0,
      cut: 2,
      structuralCut: 2
    });
    expect(first.pairs).toHaveLength(2);
    expect(first.pairs.every(pair => (
      pair.integrityGroupIndex === 0
      && pair.integrityGroupSize === 2
      && pair.authenticatingTagCount === 2
      && pair.requiredRefreshesPerWriter === 2
      && pair.gameplayWriterCount === 2
      && pair.refreshPathCount === 4
      && pair.coupledRefreshPathCount === 2
      && pair.smallestComponentCut === 2
      && pair.singleComponentBypass === false
    ))).toBe(true);
    expect(profile.tamperIntegrityGroups).toBe(1);
    expect(profile.tamperIntegrityLinkEdges).toBe(2);
    expect(profile.tamperCoupledRefreshPaths).toBe(4);
    expect(profile.tamperWeakestComponentCut).toBe(2);
  });

  it('degrades linked groups when coupled refreshes are removed and fails closed on a broken link', () => {
    const transformed = obfuscateProject(
      linkedIntegrityCutFixture(),
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    const missingRefresh = mutateIntegrityProject(transformed, removeSecondLinkedRefreshes);
    const brokenLink = mutateIntegrityProject(transformed, breakOneIntegrityLink);
    const refreshAnalysis = recoverAdversarialStructure(missingRefresh).tamperIntegrityAnalysis;
    const linkAnalysis = recoverAdversarialStructure(brokenLink).tamperIntegrityAnalysis;
    const linkedControls: Record<string, TamperIntegrityAnalysis> = {
      latch: recoverAdversarialStructure(
        mutateIntegrityProject(transformed, bypassIntegrityTripState)
      ).tamperIntegrityAnalysis,
      guard: recoverAdversarialStructure(
        mutateIntegrityProject(transformed, removeDirectIntegrityGuards)
      ).tamperIntegrityAnalysis,
      watchdog: recoverAdversarialStructure(
        mutateIntegrityProject(transformed, removeIntegrityWatchdog)
      ).tamperIntegrityAnalysis,
      disconnected: recoverAdversarialStructure(mutateIntegrityProject(
        transformed,
        removeDirectIntegrityGuards,
        removeIntegrityWatchdog
      )).tamperIntegrityAnalysis
    };

    expect({
      status: refreshAnalysis.status,
      complete: refreshAnalysis.completePairCount,
      degraded: refreshAnalysis.degradedPairCount,
      groups: refreshAnalysis.integrityGroupCount,
      completeGroups: refreshAnalysis.completeIntegrityGroupCount,
      refresh: refreshAnalysis.refreshPathCount,
      coupledRefresh: refreshAnalysis.coupledRefreshPathCount,
      cut: refreshAnalysis.weakestComponentCut
    }).toEqual({
      status: 'degraded',
      complete: 0,
      degraded: 2,
      groups: 1,
      completeGroups: 1,
      refresh: 4,
      coupledRefresh: 2,
      cut: 2
    });
    expect(refreshAnalysis.pairs.every(pair => (
      pair.refreshStatus === 'incomplete'
      && pair.unrefreshedWriterCount === 2
      && pair.requiredRefreshesPerWriter === 2
    ))).toBe(true);

    expect(linkAnalysis.status).toBe('partial');
    expect(linkAnalysis.integrityGroupCount).toBe(1);
    expect(linkAnalysis.ambiguousIntegrityGroupCount).toBe(1);
    expect(linkAnalysis.ambiguousPairCount).toBe(2);
    expect(linkAnalysis.weakestComponentCut).toBeNull();
    expect(linkAnalysis.pairs.every(pair => (
      pair.analysisStatus === 'ambiguous'
      && pair.componentCutStatus === 'ambiguous'
      && pair.singleComponentBypass === null
    ))).toBe(true);

    expect(Object.fromEntries(Object.entries(linkedControls).map(([name, analysis]) => [name, {
      status: analysis.status,
      degraded: analysis.degradedPairCount,
      disconnected: analysis.disconnectedPairCount,
      guards: analysis.guardPathCount,
      watchdogs: analysis.watchdogPathCount,
      persistent: analysis.persistentTripStateCount,
      independent: analysis.independentIntegrityComponents,
      bypasses: analysis.singleComponentBypassCount,
      cut: analysis.weakestComponentCut,
      structuralCut: analysis.weakestStructuralComponentCut
    }]))).toEqual({
      latch: {
        status: 'degraded', degraded: 2, disconnected: 0,
        guards: 8, watchdogs: 4, persistent: 0, independent: 2,
        bypasses: 0, cut: 2, structuralCut: 2
      },
      guard: {
        status: 'degraded', degraded: 2, disconnected: 0,
        guards: 0, watchdogs: 4, persistent: 1, independent: 1,
        bypasses: 2, cut: 1, structuralCut: 1
      },
      watchdog: {
        status: 'degraded', degraded: 2, disconnected: 0,
        guards: 8, watchdogs: 0, persistent: 1, independent: 1,
        bypasses: 2, cut: 1, structuralCut: 1
      },
      disconnected: {
        status: 'disconnected', degraded: 0, disconnected: 2,
        guards: 0, watchdogs: 0, persistent: 0, independent: 0,
        bypasses: 2, cut: 0, structuralCut: 0
      }
    });
  });

  it('distinguishes refresh, latch, guard, and watchdog removal combinations', () => {
    const transformed = obfuscateProject(
      integrityCutFixture(),
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    const profileBefore = measureProject(transformed);
    const variants = {
      refresh: mutateIntegrityProject(transformed, removeIntegrityRefreshes),
      latch: mutateIntegrityProject(transformed, bypassIntegrityTripState),
      guard: mutateIntegrityProject(transformed, removeDirectIntegrityGuards),
      watchdog: mutateIntegrityProject(transformed, removeIntegrityWatchdog),
      disconnected: mutateIntegrityProject(
        transformed,
        removeDirectIntegrityGuards,
        removeIntegrityWatchdog
      ),
      latchWithoutWatchdog: mutateIntegrityProject(
        transformed,
        bypassIntegrityTripState,
        removeIntegrityWatchdog
      )
    };
    const recovered = Object.fromEntries(Object.entries(variants).map(([name, project]) => (
      [name, recoverAdversarialStructure(project).tamperIntegrityAnalysis]
    )));

    expect(Object.fromEntries(Object.entries(recovered).map(([name, analysis]) => [name, {
      status: analysis.status,
      complete: analysis.completePairCount,
      degraded: analysis.degradedPairCount,
      disconnected: analysis.disconnectedPairCount,
      refresh: analysis.refreshPathCount,
      guards: analysis.guardPathCount,
      watchdogs: analysis.watchdogPathCount,
      persistent: analysis.persistentTripStateCount,
      independent: analysis.independentIntegrityComponents,
      cut: analysis.weakestComponentCut,
      structuralCut: analysis.weakestStructuralComponentCut
    }]))).toEqual({
      refresh: {
        status: 'degraded', complete: 0, degraded: 1, disconnected: 0,
        refresh: 0, guards: 2, watchdogs: 1, persistent: 2,
        independent: 2, cut: 1, structuralCut: 2
      },
      latch: {
        status: 'degraded', complete: 0, degraded: 1, disconnected: 0,
        refresh: 4, guards: 2, watchdogs: 1, persistent: 0,
        independent: 2, cut: 1, structuralCut: 2
      },
      guard: {
        status: 'degraded', complete: 0, degraded: 1, disconnected: 0,
        refresh: 4, guards: 0, watchdogs: 1, persistent: 1,
        independent: 1, cut: 1, structuralCut: 1
      },
      watchdog: {
        status: 'degraded', complete: 0, degraded: 1, disconnected: 0,
        refresh: 4, guards: 2, watchdogs: 0, persistent: 1,
        independent: 1, cut: 1, structuralCut: 1
      },
      disconnected: {
        status: 'disconnected', complete: 0, degraded: 0, disconnected: 1,
        refresh: 4, guards: 0, watchdogs: 0, persistent: 0,
        independent: 0, cut: 0, structuralCut: 0
      },
      latchWithoutWatchdog: {
        status: 'degraded', complete: 0, degraded: 1, disconnected: 0,
        refresh: 4, guards: 2, watchdogs: 0, persistent: 0,
        independent: 1, cut: 1, structuralCut: 1
      }
    });

    const refreshProfile = measureProject(variants.refresh);
    const latchProfile = measureProject(variants.latch);
    expect(refreshProfile.tamperGuardCoverage).toBe(profileBefore.tamperGuardCoverage);
    expect(latchProfile.tamperGuardCoverage).toBe(profileBefore.tamperGuardCoverage);
    expect(refreshProfile.tamperCompleteIntegrityPairs).toBe(0);
    expect(latchProfile.tamperPersistentTripStates).toBe(0);
  });

  it('fails closed when one protected value has conflicting integrity grammars', () => {
    const transformed = obfuscateProject(
      integrityCutFixture(),
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    corruptOneIntegritySecret(transformed);
    const analysis = recoverAdversarialStructure(transformed).tamperIntegrityAnalysis;
    const ambiguous = analysis.pairs.filter(pair => pair.analysisStatus === 'ambiguous');

    expect(analysis.status).toBe('partial');
    expect(analysis.ambiguousPairCount).toBeGreaterThanOrEqual(2);
    expect(ambiguous.length).toBe(analysis.ambiguousPairCount);
    expect(ambiguous.every(pair => (
      pair.componentCutStatus === 'ambiguous'
      && pair.smallestComponentCut === null
      && pair.singleComponentBypass === null
    ))).toBe(true);
  });

  it('reports a structural cut above the fixed bound without unbounded search', () => {
    const transformed = obfuscateProject(
      integrityCutFixture(),
      'lossless',
      new Uint8Array(32).fill(73),
      {antiCheat: true}
    ).project;
    duplicateIntegrityWatchdog(transformed, 3);
    const analysis = recoverAdversarialStructure(transformed).tamperIntegrityAnalysis;
    const pair = analysis.pairs[0];

    expect(pair).toBeDefined();
    expect(pair?.watchdogPathCount).toBe(4);
    expect(pair?.independentIntegrityComponents).toBe(5);
    expect(pair?.componentCutStatus).toBe('exact');
    expect(pair?.smallestComponentCut).toBe(1);
    expect(pair?.structuralCutStatus).toBe('greater-than-bound');
    expect(pair?.smallestStructuralComponentCut).toBeNull();
    expect(analysis.cutBound).toBe(3);
    expect(analysis.weakestStructuralComponentCut).toBeNull();
  });

  it('retains a decoy dependency graph derived from an unknown live reporter', () => {
    const guarded = unknownGuardFixture();
    const profile = measureProject(guarded);

    expect(profile.provenFalseControls).toBe(0);
    expect(profile.neverSentBroadcastHats).toBe(0);
    expect(profile.mutableDeclarations).toBeGreaterThanOrEqual(2);
    expect(profile.reachableBroadcastSenders).toBe(1);
    expect(profile.reachableBroadcastReceivers).toBe(1);
    expect(profile.pairedBroadcastChannels).toBe(1);
    expect(profile.broadcastPairBalance).toBe(1);
    expect(profile.retainedBroadcastPairRatio).toBe(1);
    expect(profile.reachableProcedures).toBe(1);
    expect(profile.broadcastProcedureTemplateKinds).toBe(1);
  });

  it('matches pinned runtime comparison coercion before pruning numeric guards', () => {
    const cases = [
      {initial: 0, delta: 16, comparator: '0x10', runtimeLeft: 16, canPrune: false},
      {initial: 0, delta: 16, comparator: '0b10000', runtimeLeft: 16, canPrune: false},
      {initial: 0, delta: 16, comparator: ' 16 ', runtimeLeft: 16, canPrune: false},
      {initial: 'Infinity', delta: 0, comparator: 'Infinity', runtimeLeft: Infinity, canPrune: false},
      {initial: 'Infinity', delta: 0, comparator: 'infInity', runtimeLeft: Infinity, canPrune: false},
      {initial: 0, delta: 16, comparator: '   ', runtimeLeft: 16, canPrune: true}
    ] as const;
    for (const entry of cases) {
      const runtimeEqual = ScratchCast.compare(entry.runtimeLeft, entry.comparator) === 0;
      expect(runtimeEqual).toBe(!entry.canPrune);
      const profile = measureProject(numericGuardFixture(entry.initial, entry.delta, entry.comparator));
      expect(profile.provenFalseControls, entry.comparator).toBe(entry.canPrune ? 1 : 0);
    }
  });

  it('matches pinned runtime boolean coercion for an arithmetic NaN guard', () => {
    const runtimeCondition = !ScratchCast.toBoolean(Infinity - Infinity);
    expect(runtimeCondition).toBe(true);

    const profile = measureProject(nanBooleanGuardFixture());
    expect(profile.provenFalseControls).toBe(0);
    expect(profile.retainedAfterNormalization).toBe(3);
  });

  it('activates broadcast receivers across targets at the project-wide fixed point', () => {
    const project = immutableGuardFixture(false);
    const stage = requireStage(project);
    const sprite = requireSprite(project);
    stage.blocks['cross-target-hat'] = block('event_whenflagclicked', 'cross-target-send', null, true);
    stage.blocks['cross-target-send'] = block(
      'event_broadcast',
      null,
      'cross-target-hat',
      false,
      {BROADCAST_INPUT: [1, [11, 'Cross target', 'cross-target-id']]}
    );
    stage.broadcasts['cross-target-id'] = 'Cross target';
    sprite.blocks['cross-target-receiver'] = block(
      'event_whenbroadcastreceived',
      'cross-target-effect',
      null,
      true,
      {},
      {BROADCAST_OPTION: ['Cross target', 'cross-target-id']}
    );
    sprite.blocks['cross-target-effect'] = block('looks_say', null, 'cross-target-receiver', false, {
      MESSAGE: [1, [10, 'received']]
    });
    validateProject(project);

    const profile = measureProject(project);
    expect(profile.pairedBroadcastChannels).toBe(1);
    expect(profile.reachableBroadcastSenders).toBe(1);
    expect(profile.reachableBroadcastReceivers).toBe(1);
    expect(profile.neverSentBroadcastHats).toBe(1);
    expect(profile.retainedComponents).toBeGreaterThanOrEqual(1);
  });

  it('emits stable machine-readable JSON and a compact iteration summary from the command line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-readability-'));
    try {
      const source = readabilityFixture();
      const lossless = obfuscateProject(source, 'lossless', seed()).project;
      const lossy = obfuscateProject(source, 'lossy', seed()).project;
      const baselinePath = join(directory, 'baseline.json');
      const losslessPath = join(directory, 'lossless.json');
      const lossyPath = join(directory, 'lossy.json');
      await Promise.all([
        writeFile(baselinePath, JSON.stringify(source)),
        writeFile(losslessPath, JSON.stringify(lossless)),
        writeFile(lossyPath, JSON.stringify(lossy))
      ]);
      const script = resolve('scripts/readability-metrics.mjs');
      const args = [
        script,
        '--baseline', baselinePath,
        '--candidate', `lossless=${losslessPath}`,
        '--candidate', `lossy=${lossyPath}`
      ];
      const first = spawnSync(process.execPath, args, {encoding: 'utf8'});
      const second = spawnSync(process.execPath, args, {encoding: 'utf8'});
      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toBe(first.stdout);
      const parsed = JSON.parse(first.stdout) as ReadabilityReport;
      expect(parsed.candidates.map(candidateValue => candidateValue.label)).toEqual(['lossless', 'lossy']);

      const summary = spawnSync(process.execPath, [...args, '--summary'], {encoding: 'utf8'});
      expect(summary.status, summary.stderr).toBe(0);
      expect(summary.stdout).toBe(formatReadabilitySummary(parsed));
      expect(summary.stdout).toContain('identifier-concealment\tdirect-chain-recovery\tnormalized-recovery');
      expect(summary.stdout).toContain(
        'devirtualized-recovery\tdispatchers\tdispatcher-routes\tdispatcher-edges\tdispatcher-unresolved\t'
        + 'dispatcher-complete\tdispatcher-partial\tdispatcher-structural-only\twitness-symbols\t'
        + 'witness-path-families\tcandidate-terminal-rail-families\tinitial-matching-terminal-families\t'
        + 'terminal-enumerations-exhaustive\tterminal-enumerations-conditional\ttamper-coverage\t'
        + 'integrity-pairs\tintegrity-groups\tintegrity-link-edges\tcoupled-refresh-paths\t'
        + 'weakest-component-cut\tweakest-structural-cut\tsingle-component-bypasses'
      );
      expect(summary.stdout).toContain('signature-scale\ttopology-scale\tmax-signature-share');
      expect(summary.stdout).toContain('\noriginal\t');
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});

function modeReport(source: ScratchProject): ReadabilityReport {
  const modes = ['lossless', 'lossy', 'no-preserve'] as const;
  return createReadabilityReport(source, modes.map(mode => ({
    label: mode,
    project: obfuscateProject(source, mode, seed()).project
  })));
}

function candidate(report: ReadabilityReport, label: string): ReadabilityCandidate {
  const result = report.candidates.find(candidateValue => candidateValue.label === label);
  if (!result) throw new Error(`missing readability candidate ${label}`);
  return result;
}

function losslessPairedChannels(report: ReadabilityReport): number {
  return candidate(report, 'lossless').profile.pairedBroadcastChannels;
}

function integrityCutFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'protected-value-id': ['Protected value', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'protected-hat': block('event_whenflagclicked', 'protected-write-0', null, true)
  };
  for (let index = 0; index < 4; index += 1) {
    sprite.blocks[`protected-write-${index}`] = block(
      'data_setvariableto',
      index === 3 ? null : `protected-write-${index + 1}`,
      index === 0 ? 'protected-hat' : `protected-write-${index - 1}`,
      false,
      {VALUE: [1, [4, String(index + 1)]]},
      {VARIABLE: ['Protected value', 'protected-value-id']}
    );
  }
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function linkedIntegrityCutFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {
    'protected-alpha-id': ['Protected alpha', 0],
    'protected-beta-id': ['Protected beta', 'seed']
  };
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'linked-hat': block('event_whenflagclicked', 'linked-alpha-0', null, true),
    'linked-alpha-0': block(
      'data_setvariableto',
      'linked-beta-0',
      'linked-hat',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['Protected alpha', 'protected-alpha-id']}
    ),
    'linked-beta-0': block(
      'data_setvariableto',
      'linked-alpha-1',
      'linked-alpha-0',
      false,
      {VALUE: [1, [10, 'next']]},
      {VARIABLE: ['Protected beta', 'protected-beta-id']}
    ),
    'linked-alpha-1': block(
      'data_changevariableby',
      'linked-beta-1',
      'linked-beta-0',
      false,
      {VALUE: [1, [4, '2']]},
      {VARIABLE: ['Protected alpha', 'protected-alpha-id']}
    ),
    'linked-beta-1': block(
      'data_setvariableto',
      null,
      'linked-alpha-1',
      false,
      {VALUE: [1, [10, 'done']]},
      {VARIABLE: ['Protected beta', 'protected-beta-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function readabilityFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {'launch-broadcast-id': 'Launch sequence'};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {
    'readable-score-id': ['Readable score', 0],
    'readable-state-id': ['Readable state', 1]
  };
  sprite.lists = {'readable-list-id': ['Readable records', ['seed']]};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'main-green-flag': block('event_whenflagclicked', 'main-set-score', null, true),
    'main-set-score': block(
      'data_setvariableto',
      'main-change-score',
      'main-green-flag',
      false,
      {VALUE: [1, [4, '10']]},
      {VARIABLE: ['Readable score', 'readable-score-id']}
    ),
    'main-change-score': block(
      'data_changevariableby',
      'main-add-list',
      'main-set-score',
      false,
      {VALUE: [1, [4, '2']]},
      {VARIABLE: ['Readable score', 'readable-score-id']}
    ),
    'main-add-list': block(
      'data_addtolist',
      'main-replace-list',
      'main-change-score',
      false,
      {ITEM: [1, [10, 'checkpoint']]},
      {LIST: ['Readable records', 'readable-list-id']}
    ),
    'main-replace-list': block(
      'data_replaceitemoflist',
      'main-set-state',
      'main-add-list',
      false,
      {INDEX: [1, [4, '1']], ITEM: [1, [10, 'active']]},
      {LIST: ['Readable records', 'readable-list-id']}
    ),
    'main-set-state': block(
      'data_setvariableto',
      'main-move-x',
      'main-replace-list',
      false,
      {VALUE: [1, [4, '2']]},
      {VARIABLE: ['Readable state', 'readable-state-id']}
    ),
    'main-move-x': block('motion_changexby', 'main-move-y', 'main-set-state', false, {DX: [1, [4, '4']]}),
    'main-move-y': block('motion_changeyby', 'main-say', 'main-move-x', false, {DY: [1, [4, '-3']]}),
    'main-say': block('looks_say', 'main-volume', 'main-move-y', false, {MESSAGE: [1, [10, 'ready']]}),
    'main-volume': block('sound_setvolumeto', 'main-broadcast', 'main-say', false, {VOLUME: [1, [4, '80']]}),
    'main-broadcast': block(
      'event_broadcast',
      null,
      'main-volume',
      false,
      {BROADCAST_INPUT: [1, [11, 'Launch sequence', 'launch-broadcast-id']]}
    ),
    'launch-receiver': block(
      'event_whenbroadcastreceived',
      'launch-if',
      null,
      true,
      {},
      {BROADCAST_OPTION: ['Launch sequence', 'launch-broadcast-id']}
    ),
    'launch-if': block(
      'control_if',
      'launch-finish',
      'launch-receiver',
      false,
      {CONDITION: [2, 'launch-equals'], SUBSTACK: [2, 'launch-change']}
    ),
    'launch-equals': block(
      'operator_equals',
      null,
      'launch-if',
      false,
      {OPERAND1: [3, 'launch-variable', [4, '0']], OPERAND2: [1, [4, '99']]}
    ),
    'launch-variable': block(
      'data_variable',
      null,
      'launch-equals',
      false,
      {},
      {VARIABLE: ['Readable score', 'readable-score-id']}
    ),
    'launch-change': block(
      'data_changevariableby',
      null,
      'launch-if',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['Readable state', 'readable-state-id']}
    ),
    'launch-finish': block('looks_say', null, 'launch-if', false, {MESSAGE: [1, [10, 'complete']]})
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function largeRepeatedFixture(count: number): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {};
  sprite.lists = {'stress-list-id': ['Stress work list', ['seed']]};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {};
  for (let index = 0; index < count; index += 1) {
    const id = `stress-${index}`;
    const variant = index % 3;
    sprite.blocks[id] = variant === 0
      ? block('control_wait', null, null, true, {DURATION: [1, [4, '0']]})
      : variant === 1
        ? block(
            'data_deleteoflist',
            null,
            null,
            true,
            {INDEX: [1, [4, '1']]},
            {LIST: ['Stress work list', 'stress-list-id']}
          )
        : block(
            'data_insertatlist',
            null,
            null,
            true,
            {INDEX: [1, [4, '1']], ITEM: [1, [10, 'work']]},
            {LIST: ['Stress work list', 'stress-list-id']}
          );
  }
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function immutableGuardFixture(withReachableWriter: boolean): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {'guard-broadcast-id': 'Guard continuation'};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'private-rail-id': ['Private rail', 'stable-token']};
  sprite.lists = {'private-list-id': ['Private slot', ['stable-list-token']]};
  sprite.broadcasts = {};
  sprite.comments = {};
  const predecessor = withReachableWriter ? 'guard-writer' : 'guard-hat';
  sprite.blocks = {
    'guard-hat': block('event_whenflagclicked', withReachableWriter ? 'guard-writer' : 'guard-if', null, true),
    ...(withReachableWriter ? {
      'guard-writer': block(
        'data_setvariableto',
        'guard-if',
        'guard-hat',
        false,
        {VALUE: [1, [10, 'stable-token']]},
        {VARIABLE: ['Private rail', 'private-rail-id']}
      )
    } : {}),
    'guard-if': block(
      'control_if',
      'guard-after',
      predecessor,
      false,
      {CONDITION: [2, 'guard-or'], SUBSTACK: [2, 'guard-sender']}
    ),
    'guard-or': block(
      'operator_or',
      null,
      'guard-if',
      false,
      {OPERAND1: [2, 'guard-variable-equals'], OPERAND2: [2, 'guard-list-equals']}
    ),
    'guard-variable-equals': block(
      'operator_equals',
      null,
      'guard-or',
      false,
      {OPERAND1: [3, 'guard-variable', [10, '']], OPERAND2: [1, [10, 'impossible-variable']]}
    ),
    'guard-variable': block(
      'data_variable',
      null,
      'guard-variable-equals',
      false,
      {},
      {VARIABLE: ['Private rail', 'private-rail-id']}
    ),
    'guard-list-equals': block(
      'operator_equals',
      null,
      'guard-or',
      false,
      {OPERAND1: [3, 'guard-list-item', [10, '']], OPERAND2: [1, [10, 'impossible-list']]}
    ),
    'guard-list-item': block(
      'data_itemoflist',
      null,
      'guard-list-equals',
      false,
      {INDEX: [1, [4, '1']]},
      {LIST: ['Private slot', 'private-list-id']}
    ),
    'guard-sender': block(
      'event_broadcast',
      null,
      'guard-if',
      false,
      {BROADCAST_INPUT: [1, [11, 'Guard continuation', 'guard-broadcast-id']]}
    ),
    'guard-after': block('looks_say', null, 'guard-if', false, {MESSAGE: [1, [10, 'after']]}),
    'guard-receiver': block(
      'event_whenbroadcastreceived',
      'guard-call',
      null,
      true,
      {},
      {BROADCAST_OPTION: ['Guard continuation', 'guard-broadcast-id']}
    ),
    'guard-call': {
      ...block('procedures_call', null, 'guard-receiver', false),
      mutation: {tagName: 'mutation', children: [], proccode: 'guard helper', argumentids: '[]', warp: 'false'}
    },
    'guard-definition': block(
      'procedures_definition',
      'guard-body-writer',
      null,
      true,
      {custom_block: [1, 'guard-prototype']}
    ),
    'guard-prototype': {
      ...block('procedures_prototype', null, 'guard-definition', false),
      shadow: true,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode: 'guard helper',
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        warp: 'false'
      }
    },
    'guard-body-writer': block(
      'data_replaceitemoflist',
      null,
      'guard-definition',
      false,
      {INDEX: [1, [4, '1']], ITEM: [1, [10, 'changed']]},
      {LIST: ['Private slot', 'private-list-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function unknownGuardFixture(): ScratchProject {
  const project = immutableGuardFixture(true);
  const sprite = requireSprite(project);
  const writer = sprite.blocks['guard-writer'];
  if (!writer || Array.isArray(writer)) throw new Error('guard writer is unavailable');
  writer.inputs['VALUE'] = [3, 'guard-live-join', [10, '']];
  sprite.blocks['guard-live-join'] = block(
    'operator_join',
    null,
    'guard-writer',
    false,
    {STRING1: [3, 'guard-live-answer', [10, '']], STRING2: [1, [10, ':live']]}
  );
  sprite.blocks['guard-live-answer'] = block('sensing_answer', null, 'guard-live-join', false);
  validateProject(project);
  return project;
}

function constantListSlotFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {};
  sprite.lists = {'slot-list-id': ['Slot records', ['fixed', 'replaceable']]};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'slot-hat': block('event_whenflagclicked', 'slot-replace', null, true),
    'slot-replace': block(
      'data_replaceitemoflist',
      'slot-if',
      'slot-hat',
      false,
      {INDEX: [1, [4, '2']], ITEM: [3, 'slot-answer', [10, '']]},
      {LIST: ['Slot records', 'slot-list-id']}
    ),
    'slot-answer': block('sensing_answer', null, 'slot-replace', false),
    'slot-if': block(
      'control_if',
      'slot-after',
      'slot-replace',
      false,
      {CONDITION: [2, 'slot-equals'], SUBSTACK: [2, 'slot-unreachable']}
    ),
    'slot-equals': block(
      'operator_equals',
      null,
      'slot-if',
      false,
      {OPERAND1: [2, 'slot-item'], OPERAND2: [1, [10, 'impossible']]}
    ),
    'slot-item': block(
      'data_itemoflist',
      null,
      'slot-equals',
      false,
      {INDEX: [1, [4, '1']]},
      {LIST: ['Slot records', 'slot-list-id']}
    ),
    'slot-unreachable': block('looks_say', null, 'slot-if', false, {MESSAGE: [1, [10, 'unreachable']]}),
    'slot-after': block('looks_say', null, 'slot-if', false, {MESSAGE: [1, [10, 'after']]})
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function procedureReturnFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'return-value-id': ['Return value', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'return-hat': block('event_whenflagclicked', 'return-call', null, true),
    'return-call': {
      ...block('procedures_call', 'return-after', 'return-hat', false),
      mutation: {tagName: 'mutation', children: [], proccode: 'long helper', argumentids: '[]', warp: 'false'}
    },
    'return-after': block('looks_say', null, 'return-call', false, {MESSAGE: [1, [10, 'returned']]}),
    'return-definition': block(
      'procedures_definition',
      'return-body-one',
      null,
      true,
      {custom_block: [1, 'return-prototype']}
    ),
    'return-prototype': {
      ...block('procedures_prototype', null, 'return-definition', false),
      shadow: true,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode: 'long helper',
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        warp: 'false'
      }
    },
    'return-body-one': block(
      'data_setvariableto',
      'return-body-two',
      'return-definition',
      false,
      {VALUE: [1, [4, '1']]},
      {VARIABLE: ['Return value', 'return-value-id']}
    ),
    'return-body-two': block('motion_changexby', 'return-body-three', 'return-body-one', false, {DX: [1, [4, '2']]}),
    'return-body-three': block('looks_say', null, 'return-body-two', false, {MESSAGE: [1, [10, 'body']]})
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function numericGuardFixture(initial: number | string, delta: number, comparator: string): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'numeric-rail-id': ['Numeric rail', initial]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'numeric-hat': block('event_whenflagclicked', 'numeric-change', null, true),
    'numeric-change': block(
      'data_changevariableby',
      'numeric-if',
      'numeric-hat',
      false,
      {VALUE: [1, [4, String(delta)]]},
      {VARIABLE: ['Numeric rail', 'numeric-rail-id']}
    ),
    'numeric-if': block(
      'control_if',
      null,
      'numeric-change',
      false,
      {CONDITION: [2, 'numeric-equals'], SUBSTACK: [2, 'numeric-say']}
    ),
    'numeric-equals': block(
      'operator_equals',
      null,
      'numeric-if',
      false,
      {OPERAND1: [3, 'numeric-reporter', [4, '0']], OPERAND2: [1, [10, comparator]]}
    ),
    'numeric-reporter': block(
      'data_variable',
      null,
      'numeric-equals',
      false,
      {},
      {VARIABLE: ['Numeric rail', 'numeric-rail-id']}
    ),
    'numeric-say': block('looks_say', null, 'numeric-if', false, {MESSAGE: [1, [10, 'reachable']]})
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function nanBooleanGuardFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'nan-result-id': ['NaN result', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    'nan-hat': block('event_whenflagclicked', 'nan-if', null, true),
    'nan-if': block(
      'control_if',
      null,
      'nan-hat',
      false,
      {CONDITION: [2, 'nan-not'], SUBSTACK: [2, 'nan-set']}
    ),
    'nan-not': block('operator_not', null, 'nan-if', false, {OPERAND: [2, 'nan-subtract']}),
    'nan-subtract': block(
      'operator_subtract',
      null,
      'nan-not',
      false,
      {NUM1: [1, [4, 'Infinity']], NUM2: [1, [4, 'Infinity']]}
    ),
    'nan-set': block(
      'data_setvariableto',
      null,
      'nan-if',
      false,
      {VALUE: [1, [10, 'reachable']]},
      {VARIABLE: ['NaN result', 'nan-result-id']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function splitIdentifierFixture(split: boolean): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = split ? {'opaque-id': ['x_name', 0]} : {'secret-id': ['SecretName', 0]};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = split ? {
    'opaque-hat': block('event_whenflagclicked', 'opaque-say', null, true),
    'opaque-say': block(
      'looks_say',
      null,
      'opaque-hat',
      false,
      {MESSAGE: [3, 'opaque-join', [10, 'discarded']]}
    ),
    'opaque-join': block(
      'operator_join',
      null,
      'opaque-say',
      false,
      {STRING1: [1, [10, 'Secret']], STRING2: [1, [10, 'Name']]}
    )
  } : {
    'secret-hat': block('event_whenflagclicked', 'secret-say', null, true),
    'secret-say': block('looks_say', null, 'secret-hat', false, {MESSAGE: [1, [10, 'SecretName']]})
  };
  sprite.variables = {};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {};
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function dispatcherRecoveryFixture(kind: 'direct' | 'evolving'): ScratchProject {
  const project = createFixtureProject();
  const stage = requireStage(project);
  const sprite = requireSprite(project);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = kind === 'evolving'
    ? {
        'state-id': ['state', 0],
        'tag-id': ['tag', 0],
        'key-id': ['key', 0]
      }
    : {'state-id': ['state', 0]};
  const stateCodes = [100, 200, 300, 400];
  const tagCodes = [11, 22, 33, 44];
  const keys = [7, 13, 19, 29, 37];
  const stateCiphers = [...stateCodes, 500].map((code, index) => code + (keys[index] ?? 0));
  const tagCiphers = [...tagCodes, 55].map((code, index) => code - (keys[index] ?? 0));
  const directStates = [101, 202, 303, 404, 505];
  const transitionValues = kind === 'evolving'
    ? stateCiphers.flatMap((state, index) => [state, tagCiphers[index] ?? 0])
    : directStates;
  const keyValues = [keys[0] ?? 0, ...stateCodes.map((_, index) => (
    (keys[index + 1] ?? 0) - (keys[index] ?? 0)
  ))];
  sprite.lists = kind === 'evolving'
    ? {
        'transition-id': ['transitions', transitionValues],
        'key-store-id': ['keys', keyValues]
      }
    : {'transition-id': ['transitions', transitionValues]};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {};
  project.monitors = [];
  project.extensions = [];

  const procedureMutation = (code: string, prototype: boolean): NonNullable<ScratchBlock['mutation']> => ({
    tagName: 'mutation',
    children: [],
    proccode: code,
    argumentids: '[]',
    ...(prototype ? {argumentnames: '[]', argumentdefaults: '[]'} : {}),
    warp: 'false'
  });
  const addProcedure = (prefix: string, code: string, bodyId: string): void => {
    sprite.blocks[`${prefix}-definition`] = block(
      'procedures_definition',
      bodyId,
      null,
      true,
      {custom_block: [1, `${prefix}-prototype`]}
    );
    sprite.blocks[`${prefix}-prototype`] = {
      ...block('procedures_prototype', null, `${prefix}-definition`, false),
      shadow: true,
      mutation: procedureMutation(code, true)
    };
  };
  const addCall = (id: string, code: string, parent: string, next: string | null): void => {
    sprite.blocks[id] = {
      ...block('procedures_call', next, parent, false),
      mutation: procedureMutation(code, false)
    };
  };
  const addListReporter = (id: string, parent: string, listId: string, slot: number): void => {
    sprite.blocks[id] = block(
      'data_itemoflist',
      null,
      parent,
      false,
      {INDEX: [1, [4, String(slot)]]},
      {LIST: [listId, listId]}
    );
  };
  const addVariableReporter = (id: string, parent: string, variable: string): void => {
    sprite.blocks[id] = block(
      'data_variable',
      null,
      parent,
      false,
      {},
      {VARIABLE: [variable, `${variable}-id`]}
    );
  };

  const dispatcherCode = 'dispatcher';
  const handlerCodes = stateCodes.map((_, index) => `handler-${index}`);
  addProcedure('dispatcher', dispatcherCode, 'route-0');
  for (const [index, handlerCode] of handlerCodes.entries()) {
    const operationId = `handler-${index}-operation`;
    addProcedure(`handler-${index}`, handlerCode, operationId);
    const internalFirst = kind === 'evolving' ? `handler-${index}-key-change` : `handler-${index}-state-set`;
    const operationSpecs = [
      ['motion_changexby', 'DX', [4, '1']],
      ['looks_say', 'MESSAGE', [10, 'step']],
      ['sound_setvolumeto', 'VOLUME', [4, '75']],
      ['motion_changeyby', 'DY', [4, '-1']]
    ] as const;
    const spec = operationSpecs[index];
    if (!spec) throw new Error('dispatcher fixture operation is unavailable');
    sprite.blocks[operationId] = block(
      spec[0],
      internalFirst,
      `handler-${index}-definition`,
      false,
      {[spec[1]]: [1, [...spec[2]] as [number, string]]}
    );
    if (kind === 'evolving') {
      sprite.blocks[`handler-${index}-key-change`] = block(
        'data_changevariableby',
        `handler-${index}-state-set`,
        operationId,
        false,
        {VALUE: [2, `handler-${index}-key-delta`]},
        {VARIABLE: ['key', 'key-id']}
      );
      addListReporter(`handler-${index}-key-delta`, `handler-${index}-key-change`, 'key-store-id', index + 2);
    }
    const stateNext = kind === 'evolving' ? `handler-${index}-tag-set` : (
      index + 1 < handlerCodes.length ? `handler-${index}-dispatch` : null
    );
    sprite.blocks[`handler-${index}-state-set`] = block(
      'data_setvariableto',
      stateNext,
      kind === 'evolving' ? `handler-${index}-key-change` : operationId,
      false,
      {VALUE: [2, `handler-${index}-next-state`]},
      {VARIABLE: ['state', 'state-id']}
    );
    const stateSlot = kind === 'evolving' ? ((index + 1) * 2) + 1 : index + 2;
    addListReporter(`handler-${index}-next-state`, `handler-${index}-state-set`, 'transition-id', stateSlot);
    if (kind === 'evolving') {
      sprite.blocks[`handler-${index}-tag-set`] = block(
        'data_setvariableto',
        index + 1 < handlerCodes.length ? `handler-${index}-dispatch` : null,
        `handler-${index}-state-set`,
        false,
        {VALUE: [2, `handler-${index}-next-tag`]},
        {VARIABLE: ['tag', 'tag-id']}
      );
      addListReporter(`handler-${index}-next-tag`, `handler-${index}-tag-set`, 'transition-id', stateSlot + 1);
    }
    if (index + 1 < handlerCodes.length) {
      addCall(
        `handler-${index}-dispatch`,
        dispatcherCode,
        kind === 'evolving' ? `handler-${index}-tag-set` : `handler-${index}-state-set`,
        null
      );
    }
  }

  addProcedure('fake', 'fake-handler', 'fake-delete-transition');
  sprite.blocks['fake-delete-transition'] = block(
    'data_deletealloflist',
    kind === 'evolving' ? 'fake-delete-key' : null,
    'fake-definition',
    false,
    {},
    {LIST: ['transition-id', 'transition-id']}
  );
  if (kind === 'evolving') {
    sprite.blocks['fake-delete-key'] = block(
      'data_deletealloflist',
      null,
      'fake-delete-transition',
      false,
      {},
      {LIST: ['key-store-id', 'key-store-id']}
    );
  }

  const routeCodes = [...handlerCodes, 'fake-handler'];
  for (const [index, routeCode] of routeCodes.entries()) {
    const routeId = `route-${index}`;
    const conditionId = `route-${index}-condition`;
    const callId = `route-${index}-call`;
    sprite.blocks[routeId] = block(
      'control_if',
      index + 1 < routeCodes.length ? `route-${index + 1}` : null,
      index === 0 ? 'dispatcher-definition' : `route-${index - 1}`,
      false,
      {CONDITION: [2, conditionId], SUBSTACK: [2, callId]}
    );
    addCall(callId, routeCode, routeId, null);
    if (kind === 'direct') {
      const expected = index < directStates.length - 1 ? directStates[index] : 999;
      sprite.blocks[conditionId] = block(
        'operator_equals',
        null,
        routeId,
        false,
        {OPERAND1: [2, `route-${index}-state`], OPERAND2: [1, [4, String(expected)]]}
      );
      addVariableReporter(`route-${index}-state`, conditionId, 'state');
      continue;
    }
    const stateCode = index < stateCodes.length ? stateCodes[index] : 999;
    const tagCode = index < tagCodes.length ? tagCodes[index] : 888;
    sprite.blocks[conditionId] = block(
      'operator_and',
      null,
      routeId,
      false,
      {OPERAND1: [2, `route-${index}-state-equals`], OPERAND2: [2, `route-${index}-tag-equals`]}
    );
    sprite.blocks[`route-${index}-state-equals`] = block(
      'operator_equals',
      null,
      conditionId,
      false,
      {OPERAND1: [2, `route-${index}-state`], OPERAND2: [2, `route-${index}-state-expected`]}
    );
    addVariableReporter(`route-${index}-state`, `route-${index}-state-equals`, 'state');
    sprite.blocks[`route-${index}-state-expected`] = block(
      'operator_add',
      null,
      `route-${index}-state-equals`,
      false,
      {NUM1: [1, [4, String(stateCode)]], NUM2: [2, `route-${index}-state-key`]}
    );
    addVariableReporter(`route-${index}-state-key`, `route-${index}-state-expected`, 'key');
    sprite.blocks[`route-${index}-tag-equals`] = block(
      'operator_equals',
      null,
      conditionId,
      false,
      {OPERAND1: [2, `route-${index}-tag`], OPERAND2: [2, `route-${index}-tag-expected`]}
    );
    addVariableReporter(`route-${index}-tag`, `route-${index}-tag-equals`, 'tag');
    sprite.blocks[`route-${index}-tag-expected`] = block(
      'operator_subtract',
      null,
      `route-${index}-tag-equals`,
      false,
      {NUM1: [1, [4, String(tagCode)]], NUM2: [2, `route-${index}-tag-key`]}
    );
    addVariableReporter(`route-${index}-tag-key`, `route-${index}-tag-expected`, 'key');
  }

  sprite.blocks['entry-hat'] = block('event_whenflagclicked', kind === 'evolving' ? 'entry-key-set' : 'entry-state-set', null, true);
  if (kind === 'evolving') {
    sprite.blocks['entry-key-set'] = block(
      'data_setvariableto',
      'entry-state-set',
      'entry-hat',
      false,
      {VALUE: [2, 'entry-key-value']},
      {VARIABLE: ['key', 'key-id']}
    );
    addListReporter('entry-key-value', 'entry-key-set', 'key-store-id', 1);
  }
  sprite.blocks['entry-state-set'] = block(
    'data_setvariableto',
    kind === 'evolving' ? 'entry-tag-set' : 'entry-call',
    kind === 'evolving' ? 'entry-key-set' : 'entry-hat',
    false,
    {VALUE: [2, 'entry-state-value']},
    {VARIABLE: ['state', 'state-id']}
  );
  addListReporter('entry-state-value', 'entry-state-set', 'transition-id', 1);
  if (kind === 'evolving') {
    sprite.blocks['entry-tag-set'] = block(
      'data_setvariableto',
      'entry-call',
      'entry-state-set',
      false,
      {VALUE: [2, 'entry-tag-value']},
      {VARIABLE: ['tag', 'tag-id']}
    );
    addListReporter('entry-tag-value', 'entry-tag-set', 'transition-id', 2);
  }
  addCall('entry-call', dispatcherCode, kind === 'evolving' ? 'entry-tag-set' : 'entry-state-set', null);
  return project;
}

function makeDispatcherTransitionIndicesDynamic(project: ScratchProject): ScratchProject {
  const result = structuredClone(project);
  const sprite = requireSprite(result);
  const transitionReporter = /^handler-\d+-(?:key-delta|next-state|next-tag)$/u;
  for (const [id, value] of Object.entries(sprite.blocks)) {
    if (!transitionReporter.test(id) || Array.isArray(value)) continue;
    const indexId = `${id}-dynamic-index`;
    value.inputs['INDEX'] = [2, indexId];
    sprite.blocks[indexId] = block(
      'data_variable',
      null,
      id,
      false,
      {},
      {VARIABLE: ['key', 'key-id']}
    );
  }
  validateProject(result);
  return result;
}

function renameBlockIdsAndMove(project: ScratchProject): ScratchProject {
  const result = structuredClone(project);
  for (const [targetIndex, target] of result.targets.entries()) {
    const mapping = new Map(Object.keys(target.blocks).map((id, index) => [id, `renamed-${targetIndex}-${index}`]));
    const rewritten: ScratchTarget['blocks'] = {};
    for (const [id, value] of Object.entries(target.blocks)) {
      if (Array.isArray(value)) {
        rewritten[requiredMapping(mapping, id)] = value;
        continue;
      }
      value.next = value.next === null ? null : requiredMapping(mapping, value.next);
      value.parent = value.parent === null ? null : requiredMapping(mapping, value.parent);
      for (const input of Object.values(value.inputs)) {
        for (let index = 1; index < input.length; index += 1) {
          const slot = input[index];
          if (typeof slot === 'string' && mapping.has(slot)) input[index] = requiredMapping(mapping, slot);
        }
      }
      if (value.topLevel) {
        value.x = 20_000 + targetIndex;
        value.y = -20_000 - targetIndex;
      }
      rewritten[requiredMapping(mapping, id)] = value;
    }
    target.blocks = rewritten;
  }
  return result;
}

function mutateIntegrityProject(
  project: ScratchProject,
  ...mutators: Array<(candidate: ScratchProject) => void>
): ScratchProject {
  const result = structuredClone(project);
  for (const mutate of mutators) mutate(result);
  return result;
}

function removeSecondLinkedRefreshes(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || !linkedIntegritySetter(target, block) || typeof block.parent !== 'string') continue;
      const parent = target.blocks[block.parent];
      if (Array.isArray(parent) || !parent
        || linkedIntegritySetter(target, parent) || typeof block.next !== 'string') continue;
      const second = target.blocks[block.next];
      if (!Array.isArray(second) && second && linkedIntegritySetter(target, second)) {
        replaceTestBlockWithNoop(second);
      }
    }
  }
}

function breakOneIntegrityLink(project: ScratchProject): void {
  const sites: Array<{tagId: string; linkJoin: ScratchBlock; ownValue: JsonValue[]}> = [];
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== 'operator_not') continue;
      const equalsId = activeTestInput(block.inputs['OPERAND']);
      const equals = typeof equalsId === 'string' ? target.blocks[equalsId] : undefined;
      const tagId = !Array.isArray(equals) && equals?.opcode === 'operator_equals'
        ? directTestVariableId(target, activeTestInput(equals.inputs['OPERAND1']))
        : undefined;
      const expectedId = !Array.isArray(equals) && equals?.opcode === 'operator_equals'
        ? activeTestInput(equals.inputs['OPERAND2'])
        : undefined;
      const expected = typeof expectedId === 'string' ? target.blocks[expectedId] : undefined;
      const bodyId = !Array.isArray(expected) && expected?.opcode === 'operator_join'
        ? activeTestInput(expected.inputs['STRING2'])
        : undefined;
      const body = typeof bodyId === 'string' ? target.blocks[bodyId] : undefined;
      const ownJoinId = !Array.isArray(body) && body?.opcode === 'operator_join'
        ? activeTestInput(body.inputs['STRING2'])
        : undefined;
      const ownJoin = typeof ownJoinId === 'string' ? target.blocks[ownJoinId] : undefined;
      const ownValue = !Array.isArray(ownJoin) && ownJoin?.opcode === 'operator_join'
        ? activeTestInput(ownJoin.inputs['STRING1'])
        : undefined;
      const linkJoinId = !Array.isArray(ownJoin) && ownJoin?.opcode === 'operator_join'
        ? activeTestInput(ownJoin.inputs['STRING2'])
        : undefined;
      const linkJoin = typeof linkJoinId === 'string' ? target.blocks[linkJoinId] : undefined;
      if (tagId && !Array.isArray(linkJoin) && linkJoin?.opcode === 'operator_join'
        && Array.isArray(ownValue) && ownValue[0] === 12) {
        sites.push({tagId, linkJoin, ownValue});
      }
    }
  }
  const selectedTag = sites[0]?.tagId;
  if (!selectedTag) throw new Error('linked integrity fixture is unavailable');
  for (const site of sites) {
    if (site.tagId === selectedTag) {
      site.linkJoin.inputs['STRING2'] = [1, structuredClone(site.ownValue)];
    }
  }
}

function linkedIntegritySetter(target: ScratchTarget, block: ScratchBlock): boolean {
  if (block.opcode !== 'data_setvariableto') return false;
  const expectedId = activeTestInput(block.inputs['VALUE']);
  const expected = typeof expectedId === 'string' ? target.blocks[expectedId] : undefined;
  const bodyId = !Array.isArray(expected) && expected?.opcode === 'operator_join'
    ? activeTestInput(expected.inputs['STRING2'])
    : undefined;
  const body = typeof bodyId === 'string' ? target.blocks[bodyId] : undefined;
  return !Array.isArray(body) && body?.opcode === 'operator_join';
}

function removeIntegrityRefreshes(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block)
        || (block.opcode !== 'data_setvariableto' && block.opcode !== 'data_changevariableby')
        || typeof block.next !== 'string') continue;
      const valueId = typeof block.fields['VARIABLE']?.[1] === 'string'
        ? block.fields['VARIABLE'][1]
        : undefined;
      const setter = target.blocks[block.next];
      const joinId = !Array.isArray(setter) && setter?.opcode === 'data_setvariableto'
        ? activeTestInput(setter.inputs['VALUE'])
        : undefined;
      const join = typeof joinId === 'string' ? target.blocks[joinId] : undefined;
      if (!valueId || Array.isArray(join) || join?.opcode !== 'operator_join'
        || directTestVariableId(target, activeTestInput(join.inputs['STRING2'])) !== valueId
        || !setter || Array.isArray(setter)) continue;
      replaceTestBlockWithNoop(setter);
    }
  }
}

function bypassIntegrityTripState(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== 'data_setvariableto' || typeof block.next !== 'string') {
        continue;
      }
      const next = target.blocks[block.next];
      if (!Array.isArray(next) && next?.opcode === 'control_stop'
        && next.fields['STOP_OPTION']?.[0] === 'all') replaceTestBlockWithNoop(block);
    }
  }
}

function removeDirectIntegrityGuards(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== 'control_if') continue;
      const rootId = activeTestInput(block.inputs['CONDITION']);
      if (typeof rootId === 'string' && directIntegrityExpectedJoin(target, rootId)) {
        replaceTestBlockWithNoop(block);
      }
    }
  }
}

function removeIntegrityWatchdog(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== 'event_whenflagclicked' || typeof block.next !== 'string') {
        continue;
      }
      const next = target.blocks[block.next];
      if (!Array.isArray(next) && next?.opcode === 'control_forever') replaceTestBlockWithNoop(block);
    }
  }
}

function corruptOneIntegritySecret(project: ScratchProject): void {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (Array.isArray(block) || block.opcode !== 'control_if') continue;
      const rootId = activeTestInput(block.inputs['CONDITION']);
      const join = typeof rootId === 'string' ? directIntegrityExpectedJoin(target, rootId) : undefined;
      if (!join) continue;
      join.inputs['STRING1'] = [1, [10, 'conflicting-integrity-secret']];
      return;
    }
  }
  throw new Error('integrity secret fixture is unavailable');
}

function duplicateIntegrityWatchdog(project: ScratchProject, copies: number): void {
  const stage = requireStage(project);
  const entry = Object.entries(stage.blocks).find(([, block]) => {
    if (Array.isArray(block) || block.opcode !== 'event_whenflagclicked' || typeof block.next !== 'string') {
      return false;
    }
    const next = stage.blocks[block.next];
    return !Array.isArray(next) && next?.opcode === 'control_forever';
  });
  if (!entry) throw new Error('integrity watchdog fixture is unavailable');
  const component = new Set<string>();
  const queue = [entry[0]];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (!id || component.has(id)) continue;
    const block = stage.blocks[id];
    if (Array.isArray(block) || !block) continue;
    component.add(id);
    if (typeof block.next === 'string') queue.push(block.next);
    for (const input of Object.values(block.inputs)) {
      const child = activeTestInput(input);
      if (typeof child === 'string' && stage.blocks[child] !== undefined) queue.push(child);
    }
  }
  for (let copy = 0; copy < copies; copy += 1) {
    const mapping = new Map([...component].map(id => [id, `integrity-watchdog-${copy}-${id}`]));
    for (const id of component) {
      const original = stage.blocks[id];
      const replacementId = mapping.get(id);
      if (!replacementId || Array.isArray(original) || !original) continue;
      const block = structuredClone(original);
      if (typeof block.next === 'string' && mapping.has(block.next)) {
        block.next = mapping.get(block.next) ?? null;
      }
      if (typeof block.parent === 'string' && mapping.has(block.parent)) {
        block.parent = mapping.get(block.parent) ?? null;
      }
      for (const input of Object.values(block.inputs)) {
        for (let index = 1; index < input.length; index += 1) {
          const value = input[index];
          if (typeof value === 'string' && mapping.has(value)) input[index] = mapping.get(value) ?? value;
        }
      }
      if (block.topLevel) {
        block.x = (block.x ?? 0) + ((copy + 1) * 20);
        block.y = (block.y ?? 0) + ((copy + 1) * 20);
      }
      stage.blocks[replacementId] = block;
    }
  }
}

function directIntegrityExpectedJoin(target: ScratchTarget, rootId: string): ScratchBlock | undefined {
  const root = target.blocks[rootId];
  const equalsId = !Array.isArray(root) && root?.opcode === 'operator_not'
    ? activeTestInput(root.inputs['OPERAND'])
    : undefined;
  const equals = typeof equalsId === 'string' ? target.blocks[equalsId] : undefined;
  if (Array.isArray(equals) || equals?.opcode !== 'operator_equals'
    || !directTestVariableId(target, activeTestInput(equals.inputs['OPERAND1']))) return undefined;
  const joinId = activeTestInput(equals.inputs['OPERAND2']);
  const join = typeof joinId === 'string' ? target.blocks[joinId] : undefined;
  if (Array.isArray(join) || join?.opcode !== 'operator_join') return undefined;
  if (directTestVariableId(target, activeTestInput(join.inputs['STRING2']))) return join;
  const bodyId = activeTestInput(join.inputs['STRING2']);
  const body = typeof bodyId === 'string' ? target.blocks[bodyId] : undefined;
  const ownJoinId = !Array.isArray(body) && body?.opcode === 'operator_join'
    ? activeTestInput(body.inputs['STRING2'])
    : undefined;
  const ownJoin = typeof ownJoinId === 'string' ? target.blocks[ownJoinId] : undefined;
  return !Array.isArray(ownJoin) && ownJoin?.opcode === 'operator_join'
    && directTestVariableId(target, activeTestInput(ownJoin.inputs['STRING1']))
    ? join
    : undefined;
}

function directTestVariableId(target: ScratchTarget, value: unknown): string | undefined {
  if (Array.isArray(value) && value[0] === 12 && typeof value[2] === 'string') return value[2];
  const reporter = typeof value === 'string' ? target.blocks[value] : undefined;
  return !Array.isArray(reporter) && reporter?.opcode === 'data_variable'
    && typeof reporter.fields['VARIABLE']?.[1] === 'string'
    ? reporter.fields['VARIABLE'][1]
    : undefined;
}

function activeTestInput(input: ScratchBlock['inputs'][string] | undefined): JsonValue | undefined {
  return input?.[1] ?? input?.[2];
}

function replaceTestBlockWithNoop(block: ScratchBlock): void {
  block.opcode = 'looks_say';
  block.inputs = {MESSAGE: [1, [10, '']]};
  block.fields = {};
  delete block.mutation;
}

function requiredMapping(mapping: ReadonlyMap<string, string>, id: string): string {
  const value = mapping.get(id);
  if (!value) throw new Error(`missing block ID mapping for ${id}`);
  return value;
}

function requireStage(project: ScratchProject): ScratchTarget {
  const stage = project.targets.find(target => target.isStage);
  if (!stage) throw new Error('fixture has no Stage');
  return stage;
}

function requireSprite(project: ScratchProject): ScratchTarget {
  const sprite = project.targets.find(target => !target.isStage);
  if (!sprite) throw new Error('fixture has no sprite');
  return sprite;
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  topLevel: boolean,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {
    opcode,
    next,
    parent,
    inputs,
    fields,
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 40, y: 60} : {})
  };
}

function seed(): Uint8Array {
  return new Uint8Array(32).fill(113);
}
