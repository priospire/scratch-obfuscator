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
  type ReadabilityCandidate,
  type ReadabilityReport
} from '../scripts/readability-metrics.mjs';
import {obfuscateProject} from '../src/obfuscation/index.js';
import type {ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
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
    expect(report.schemaVersion).toBe(1);
    expect(report.candidates.map(candidate => candidate.label)).toEqual(['lossless', 'lossy', 'no-preserve']);
    expect(report.trend.map(entry => `${entry.from}->${entry.to}`)).toEqual([
      'original->lossless',
      'lossless->lossy',
      'lossy->no-preserve'
    ]);

    const lossless = candidate(report, 'lossless');
    const lossy = candidate(report, 'lossy');
    const strongest = candidate(report, 'no-preserve');
    expect(lossless.comparison.identifierConcealment).toBeGreaterThan(0.95);
    expect(lossless.comparison.directChainRecovery).toBe(1);
    expect(lossless.comparison.normalizedRecovery).toBe(1);

    expect(lossy.profile.branchBlocks).toBeGreaterThan(lossless.profile.branchBlocks);
    expect(lossy.profile.operators).toBeGreaterThan(lossless.profile.operators);
    expect(lossy.profile.reporters).toBeGreaterThan(lossless.profile.reporters);
    expect(lossy.comparison.resistanceScore).toBe(lossless.comparison.resistanceScore);

    expect(strongest.comparison.resistanceScore).toBeGreaterThan(lossy.comparison.resistanceScore + 4);
    expect(strongest.comparison.directChainRecovery).toBeLessThan(lossy.comparison.directChainRecovery - 0.4);
    expect(strongest.comparison.normalizedRecovery).toBeLessThan(lossy.comparison.normalizedRecovery - 0.35);
    expect(strongest.comparison.indirectionDensity).toBeGreaterThan(lossy.comparison.indirectionDensity + 0.08);
    expect(strongest.comparison.retainedDependencyQuality).toBeGreaterThan(0.8);
    expect(strongest.profile.crossFamilyDependencyDensity).toBeGreaterThan(0.25);
    expect(strongest.profile.obviousPruneRatio).toBeLessThan(0.25);
    expect(strongest.profile.coherentMixedComponents).toBeGreaterThanOrEqual(1);
    expect(strongest.profile.semanticDependencyKindCount).toBeGreaterThanOrEqual(6);
    expect(strongest.profile.customDefinitions).toBeGreaterThan(0);
    expect(strongest.profile.customCalls).toBeGreaterThan(0);
    expect(lossy.profile.broadcastReceiverHats).toBe(lossless.profile.broadcastReceiverHats);
    expect(strongest.profile.pairedBroadcastChannels).toBeGreaterThan(lossy.profile.pairedBroadcastChannels + 2);
    expect(strongest.profile.reachableBroadcastSenders).toBe(strongest.profile.reachableBroadcastReceivers);
    expect(strongest.profile.unpairedBroadcastReceiverHats).toBe(0);
    expect(strongest.profile.broadcastPairBalance).toBe(1);
    expect(strongest.profile.retainedBroadcastPairRatio).toBe(1);
    expect(strongest.profile.broadcastProcedureTemplateKinds).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.procedureTemplateKinds).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.procedureTemplateDiversity).toBeGreaterThan(0.5);
    expect(strongest.profile.procedureWarpVariants).toBe(2);
    expect(strongest.profile.componentTemplateKinds).toBeGreaterThanOrEqual(2);
    expect(strongest.profile.normalizedSignatureKinds).toBeGreaterThanOrEqual(75);
    expect(strongest.profile.normalizedSignatureDensity).toBeGreaterThan(0.1);
    expect(strongest.profile.normalizedSignatureScaleDiversity).toBeGreaterThan(0.65);
    expect(strongest.profile.normalizedTopologyDensity).toBeGreaterThan(0.55);
    expect(strongest.profile.normalizedTopologyScaleDiversity).toBeGreaterThan(0.9);
    expect(strongest.profile.normalizedTopRepeatedSignatures[0]?.share).toBeLessThan(0.12);
    expect(strongest.profile.provenFalseControls).toBe(0);
  });

  it('keeps no-preserve measurably stronger when lossy live rewrites are fully eligible', () => {
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
    const lossy = candidate(report, 'lossy');
    const strongest = candidate(report, 'no-preserve');
    expect(strongest.comparison.resistanceScore).toBeGreaterThan(lossy.comparison.resistanceScore + 4);
    expect(strongest.comparison.directChainRecovery).toBeLessThan(lossy.comparison.directChainRecovery);
    expect(strongest.comparison.normalizedRecovery).toBeLessThan(lossy.comparison.normalizedRecovery - 0.01);
    expect(lossy.profile.broadcastReceiverHats).toBe(0);
    expect(lossy.profile.pairedBroadcastChannels).toBe(0);
    expect(strongest.profile.pairedBroadcastChannels).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.broadcastProcedureTemplateKinds).toBeGreaterThanOrEqual(3);
    expect(strongest.profile.unpairedBroadcastReceiverHats).toBe(0);
    expect(strongest.profile.obviousPruneRatio).toBeLessThan(0.25);
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

    expect(profile.objectBlocks).toBeGreaterThan(10_000);
    expect(profile.retainedAfterNormalization).toBeGreaterThan(8_000);
    expect(profile.normalizedSignatureKinds).toBeGreaterThanOrEqual(70);
    expect(profile.normalizedSignatureDensity).toBeLessThan(0.02);
    expect(profile.normalizedSignatureScaleDiversity).toBeGreaterThan(0.42);
    expect(profile.normalizedSignatureScaleDiversity).toBeLessThan(0.6);
    expect(profile.normalizedTopologyKinds).toBeGreaterThanOrEqual(1_800);
    expect(profile.normalizedTopologyDensity).toBeGreaterThan(0.2);
    expect(profile.normalizedTopologyScaleDiversity).toBeGreaterThan(0.82);
    expect(profile.normalizedTopologyScaleDiversity).toBeGreaterThan(
      profile.normalizedSignatureScaleDiversity + 0.1
    );
    expect(profile.normalizedTopRepeatedSignatures[0]?.share).toBeLessThanOrEqual(0.09);
    expect(profile.obviousPruneRatio).toBeLessThan(0.22);
    expect(profile.pairedBroadcastChannels).toBeGreaterThanOrEqual(320);
    expect(profile.procedureTemplateDiversity).toBeGreaterThan(0.7);
    expect(measured.comparison.retainedDependencyQuality).toBeGreaterThan(0.9);
  });

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
