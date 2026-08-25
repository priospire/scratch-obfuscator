import {createHash} from 'node:crypto';
import {readFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseCliArguments, runCli} from '../src/cli.js';
import {DeterministicGenerator} from '../src/deterministic.js';
import {countBlockEquivalents, isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {isOfficialHatOpcode} from '../src/obfuscation/analysis.js';
import {applyCommonTransforms} from '../src/obfuscation/common.js';
import {getAntiCheatReleaseCheckpoint, obfuscateProject} from '../src/obfuscation/index.js';
import {
  applyExtraEditorShadowTransform,
  applyExtraPrivacyTransform,
  EXTRA_EDITOR_SHADOW_CAVEAT,
  EXTRA_EDITOR_SHADOW_PASS_NAME,
  EXTRA_PRIVACY_ALLOWED_CHANGES,
  EXTRA_PRIVACY_GENERATOR_DOMAIN,
  EXTRA_PRIVACY_PASS_NAME,
  isTrustedExtraEditorShadowManifest
} from '../src/obfuscation/privacy.js';
import type {JsonValue, ObfuscationStats, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/index.js';
import {createFixtureArchive, createFixtureProject, readProjectFromArchive} from './support.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('extra privacy project pass', () => {
  it('renames project display identities and rewrites proven core references deterministically', () => {
    const first = privacyFixture();
    const second = structuredClone(first);
    const firstReport = apply(first, 41);
    const secondReport = apply(second, 41);

    expect(first).toEqual(second);
    expect(firstReport).toEqual(secondReport);
    validateProject(first);
    expect(first.targets[0]?.name).toBe('Stage');
    const stage = requiredTarget(first, 0);
    const sprite = requiredTarget(first, 1);
    expect(sprite.name).toMatch(/^t_[a-z]{24}$/u);
    expect(sprite.name).not.toBe('Visible Sprite');

    const gotoMenu = requiredBlock(sprite, 'goto-menu');
    expect(gotoMenu.fields['TO']?.[0]).toBe(sprite.name);
    expect(first.monitors[0]?.['spriteName']).toBe(sprite.name);
    expect((first.monitors[1]?.['params'] as Record<string, unknown>)['OBJECT']).toBe(sprite.name);

    const firstBackdrop = requiredString(stage.costumes[0]?.['name'], 'first backdrop name');
    const secondBackdrop = requiredString(stage.costumes[1]?.['name'], 'second backdrop name');
    expect(firstBackdrop).toMatch(/^d_[A-Za-z]{24}$/u);
    expect(secondBackdrop).toMatch(/^d_[A-Za-z]{24}$/u);
    expect(firstBackdrop).not.toBe(secondBackdrop);
    expect(firstBackdrop.toUpperCase()).toBe(secondBackdrop.toUpperCase());
    expect(requiredBlock(stage, 'backdrop-hat').fields['BACKDROP']?.[0]).toBe(firstBackdrop);
    expect(requiredBlock(sprite, 'backdrop-menu').fields['BACKDROP']?.[0]).toBe(secondBackdrop);

    const costumeName = sprite.costumes[0]?.['name'];
    const soundName = sprite.sounds[0]?.['name'];
    expect(costumeName).toMatch(/^k_[a-z]{24}$/u);
    expect(sprite.costumes[1]?.['name']).toBe(costumeName);
    expect(sprite.costumes[2]?.['name']).not.toBe(costumeName);
    expect(requiredBlock(sprite, 'costume-menu').fields['COSTUME']?.[0]).toBe(costumeName);
    expect(soundName).toMatch(/^s_[a-z]{24}$/u);
    expect(sprite.sounds[1]?.['name']).toBe(soundName);
    expect(sprite.sounds[2]?.['name']).not.toBe(soundName);
    expect(requiredBlock(sprite, 'sound-menu').fields['SOUND_MENU']?.[0]).toBe(soundName);

    const broadcastName = Object.values(stage.broadcasts)[0];
    expect(broadcastName).toMatch(/^m_[a-z]{24}$/u);
    expect(requiredBlock(sprite, 'receive').fields['BROADCAST_OPTION']?.[0]).toBe(broadcastName);
    expect(requiredBlock(stage, 'typed-broadcast').inputs['BROADCAST_INPUT']?.[1]).toEqual([
      11,
      broadcastName,
      'broadcast_go'
    ]);
    expect(requiredBlock(sprite, 'missing-target').inputs['TO']?.[1]).toEqual([10, 'Missing sprite']);
    expect(requiredBlock(sprite, 'missing-costume').inputs['COSTUME']?.[1]).toEqual([10, 'Missing costume']);
    expect(requiredBlock(sprite, 'missing-backdrop').inputs['BACKDROP']?.[1]).toEqual([10, 'Missing backdrop']);
    expect(requiredBlock(sprite, 'missing-sound').inputs['SOUND_MENU']?.[1]).toEqual([10, 'Missing sound']);

    expect(requiredBlock(sprite, 'extension-selector').fields['VIDEOONMENU2']?.[0]).toBe('Visible Sprite');
    expect(stage.variables['cloud_value']?.[0]).toBe('cloud-visible-name');
    expect(stage.variables['watermark']?.[0]).toBe('Obfuscated by PrioSDK Gen 4.');
    expect(first.extensions).toEqual(['videoSensing']);
    expect(firstReport).toMatchObject({
      targetNamesRenamed: 1,
      costumeNamesRenamed: 5,
      soundNamesRenamed: 3,
      broadcastNamesRenamed: 1,
      nameReporterObservations: 1,
      binaryAssetsPreserved: true,
      dynamicReferences: {targets: 1, costumes: 1, backdrops: 1, sounds: 1, broadcasts: 1}
    });
    expect(firstReport.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining('computed broadcast selector'),
      expect.stringContaining('computed target selector'),
      expect.stringContaining('binary asset bytes')
    ]));
  });

  it('canonicalizes monitor presentation and strips only project-level optional metadata', () => {
    const project = privacyFixture();
    const stageDescriptorBefore = descriptorIdentity(requiredTarget(project, 0).costumes[0]);
    const spriteDescriptorBefore = descriptorIdentity(requiredTarget(project, 1).sounds[0]);
    const report = apply(project, 52);

    expect(project.meta).toEqual({semver: '3.0.0'});
    expect(project['author']).toBeUndefined();
    expect(project['customProjectPayload']).toBeUndefined();
    expect(project.targets[1]?.['customTargetPayload']).toEqual({retained: true});
    expect(report.metadataPropertiesRemoved).toBe(6);
    for (const monitor of project.monitors) {
      expect(monitor).toMatchObject({
        visible: false,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        sliderMin: 0,
        sliderMax: 100,
        isDiscrete: true
      });
    }
    expect(project.monitors[0]?.['mode']).toBe('default');
    expect(project.monitors[0]?.['value']).toBe(0);
    expect(project.monitors[2]?.['mode']).toBe('list');
    expect(project.monitors[2]?.['value']).toEqual([]);
    expect(descriptorIdentity(requiredTarget(project, 0).costumes[0])).toEqual(stageDescriptorBefore);
    expect(descriptorIdentity(requiredTarget(project, 1).sounds[0])).toEqual(spriteDescriptorBefore);
  });

  it.each([
    ['control_create_clone_of_menu', 'CLONE_OPTION'],
    ['motion_goto_menu', 'TO'],
    ['motion_pointtowards_menu', 'TOWARDS'],
    ['sensing_distancetomenu', 'DISTANCETOMENU'],
    ['sensing_of_object_menu', 'OBJECT'],
    ['sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU']
  ] as const)('rewrites the proven %s target menu', (opcode, fieldName) => {
    const project = privacyFixture();
    const sprite = requiredTarget(project, 1);
    sprite.blocks = {menu: block(opcode, {}, {[fieldName]: ['Visible Sprite', null]})};
    apply(project, fieldName.length);
    expect(requiredBlock(sprite, 'menu').fields[fieldName]?.[0]).toBe(sprite.name);
  });

  it.each([
    ['control_create_clone_of', 'CLONE_OPTION', 'target'],
    ['event_whentouchingobject', 'TOUCHINGOBJECTMENU', 'target'],
    ['motion_glideto', 'TO', 'target'],
    ['motion_goto', 'TO', 'target'],
    ['motion_pointtowards', 'TOWARDS', 'target'],
    ['sensing_distanceto', 'DISTANCETOMENU', 'target'],
    ['sensing_of', 'OBJECT', 'target'],
    ['sensing_touchingobject', 'TOUCHINGOBJECTMENU', 'target'],
    ['looks_switchcostumeto', 'COSTUME', 'costume'],
    ['looks_switchbackdropto', 'BACKDROP', 'backdrop'],
    ['looks_switchbackdroptoandwait', 'BACKDROP', 'backdrop'],
    ['sound_play', 'SOUND_MENU', 'sound'],
    ['sound_playuntildone', 'SOUND_MENU', 'sound']
  ] as const)('rewrites a direct literal selector for %s', (opcode, inputName, kind) => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    project.monitors = [];
    stage.blocks = {};
    const oldValue = kind === 'target' ? 'Visible Sprite'
      : kind === 'costume' ? 'Hero'
        : kind === 'backdrop' ? 'Backdrop' : 'Theme';
    sprite.blocks = {owner: block(opcode, {[inputName]: [1, [10, oldValue]]})};
    apply(project, opcode.length);
    const expected = kind === 'target' ? sprite.name
      : kind === 'costume' ? sprite.costumes[0]?.['name']
        : kind === 'backdrop' ? stage.costumes[0]?.['name'] : sprite.sounds[0]?.['name'];
    expect(requiredBlock(sprite, 'owner').inputs[inputName]?.[1]).toEqual([10, expected]);
  });

  it.each([
    ['motion_goto', 'TO', 'target', 2],
    ['looks_switchcostumeto', 'COSTUME', 'costume', '2'],
    ['looks_switchbackdropto', 'BACKDROP', 'backdrop', '2'],
    ['sound_play', 'SOUND_MENU', 'sound', '2']
  ] as const)('rewrites a statically name-resolving scalar selector for %s without changing its primitive type', (
    opcode,
    inputName,
    kind,
    selectorValue
  ) => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    project.monitors = [];
    stage.blocks = {};
    if (kind === 'target') sprite.name = '2';
    else if (kind === 'costume') requiredMedia(sprite.costumes[0])['name'] = '2';
    else if (kind === 'backdrop') requiredMedia(stage.costumes[0])['name'] = '2';
    else requiredMedia(sprite.sounds[0])['name'] = '2';
    sprite.blocks = {owner: block(opcode, {[inputName]: [1, [4, selectorValue]]})};

    const report = apply(project, opcode.length + inputName.length);
    const expected = kind === 'target' ? sprite.name
      : kind === 'costume' ? requiredMedia(sprite.costumes[0])['name']
        : kind === 'backdrop' ? requiredMedia(stage.costumes[0])['name']
          : requiredMedia(sprite.sounds[0])['name'];
    expect(requiredBlock(sprite, 'owner').inputs[inputName]?.[1]).toEqual([4, expected]);
    expect(report.dynamicReferences[kind === 'target' ? 'targets'
      : kind === 'costume' ? 'costumes'
        : kind === 'backdrop' ? 'backdrops' : 'sounds']).toBe(0);
    validateProject(project);
  });

  it.each([
    ['looks_switchcostumeto', 'COSTUME', 'costume'],
    ['looks_switchbackdropto', 'BACKDROP', 'backdrop'],
    ['sound_play', 'SOUND_MENU', 'sound']
  ] as const)('preserves a numeric-index scalar for %s even when an asset has the same display text', (
    opcode,
    inputName,
    kind
  ) => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    project.monitors = [];
    stage.blocks = {};
    if (kind === 'costume') requiredMedia(sprite.costumes[0])['name'] = '2';
    else if (kind === 'backdrop') requiredMedia(stage.costumes[0])['name'] = '2';
    else requiredMedia(sprite.sounds[0])['name'] = '2';
    sprite.blocks = {owner: block(opcode, {[inputName]: [1, [4, 2]]})};

    const report = apply(project, opcode.length + inputName.length + 1);
    expect(requiredBlock(sprite, 'owner').inputs[inputName]?.[1]).toEqual([4, 2]);
    expect(report.dynamicReferences[kind === 'costume' ? 'costumes'
      : kind === 'backdrop' ? 'backdrops' : 'sounds']).toBe(0);
    validateProject(project);
  });

  it('classifies inline and referenced variable/list reporter primitives as computed selectors', () => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    sprite.variables['target_selector'] = ['target selector', 'Visible Sprite'];
    sprite.lists['broadcast_selector'] = ['broadcast selector', ['go']];
    sprite.blocks = {
      inline: block('motion_goto', {TO: [2, [12, 'target selector', 'target_selector']]}),
      referenced: block('motion_pointtowards', {TOWARDS: [2, 'target-reporter']}),
      'target-reporter': [12, 'target selector', 'target_selector'],
      broadcast: block('event_broadcast', {
        BROADCAST_INPUT: [2, [13, 'broadcast selector', 'broadcast_selector']]
      })
    };
    stage.blocks = {};

    const report = apply(project, 88);
    expect(report.dynamicReferences).toMatchObject({targets: 2, broadcasts: 1});
    expect(report.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining('2 computed target selectors'),
      expect.stringContaining('1 computed broadcast selector')
    ]));
    validateProject(project);
  });

  it('retries every deterministic display-name family when its first candidate is already occupied', () => {
    const firstCandidates = privacyFixture();
    apply(firstCandidates, 89);
    const occupiedNames = [
      requiredTarget(firstCandidates, 1).name,
      ...firstCandidates.targets.flatMap(target => target.costumes.map(costume => costume['name'])),
      ...firstCandidates.targets.flatMap(target => target.sounds.map(sound => sound['name'])),
      ...firstCandidates.targets.flatMap(target => Object.values(target.broadcasts))
    ].filter((value): value is string => typeof value === 'string');

    const project = privacyFixture();
    project['reservedDisplayNames'] = occupiedNames;
    const repeated = structuredClone(project);
    apply(project, 89);
    apply(repeated, 89);

    expect(project).toEqual(repeated);
    const generatedNames = [
      requiredTarget(project, 1).name,
      ...project.targets.flatMap(target => target.costumes.map(costume => costume['name'])),
      ...project.targets.flatMap(target => target.sounds.map(sound => sound['name'])),
      ...project.targets.flatMap(target => Object.values(target.broadcasts))
    ].filter((value): value is string => typeof value === 'string');
    expect(generatedNames).not.toEqual(expect.arrayContaining(occupiedNames));
    expect(requiredString(requiredTarget(project, 0).costumes[0]?.['name'], 'retried backdrop').toUpperCase())
      .not.toBe(requiredString(requiredTarget(firstCandidates, 0).costumes[0]?.['name'], 'first backdrop').toUpperCase());
  });

  it('handles referenced scalar shadows, case-folded broadcasts, sentinels, and incomplete selector inputs', () => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    sprite.name = 'true';
    requiredMedia(sprite.costumes[0])['name'] = '2';
    project.monitors = [];
    stage.blocks = {};
    sprite.blocks = {
      target: block('motion_goto', {TO: [1, 'target-literal']}),
      'target-literal': [4, true],
      costume: block('looks_switchcostumeto', {COSTUME: [1, 'costume-index']}),
      'costume-index': [4, 2],
      broadcast: block('event_broadcast', {BROADCAST_INPUT: [1, [10, 'GO']]}),
      'referenced-broadcast': block('event_broadcastandwait', {BROADCAST_INPUT: [1, 'broadcast-literal']}),
      'broadcast-literal': [11, 'GO', 'broadcast_go'],
      sentinel: block('motion_goto_menu', {}, {TO: ['_random_', null]}),
      'missing-input': block('motion_pointtowards'),
      'empty-input': block('sensing_distanceto', {DISTANCETOMENU: [1, null]}),
      'missing-broadcast-field': block('event_whenbroadcastreceived'),
      'name-only-broadcast-field': block('event_whenbroadcastreceived', {}, {BROADCAST_OPTION: ['GO', null]})
    };

    const report = apply(project, 90);
    const renamedSprite = requiredTarget(project, 1);
    const broadcastName = requiredString(Object.values(requiredTarget(project, 0).broadcasts)[0], 'broadcast');

    expect(renamedSprite.blocks['target-literal']).toEqual([4, renamedSprite.name]);
    expect(renamedSprite.blocks['costume-index']).toEqual([4, 2]);
    expect(requiredBlock(renamedSprite, 'broadcast').inputs['BROADCAST_INPUT']?.[1]).toEqual([10, broadcastName]);
    expect(renamedSprite.blocks['broadcast-literal']).toEqual([11, broadcastName, 'broadcast_go']);
    expect(requiredBlock(renamedSprite, 'name-only-broadcast-field').fields['BROADCAST_OPTION']?.[0]).toBe(broadcastName);
    expect(requiredBlock(renamedSprite, 'sentinel').fields['TO']?.[0]).toBe('_random_');
    expect(report.dynamicReferences).toEqual({targets: 0, costumes: 0, backdrops: 0, sounds: 0, broadcasts: 0});
  });

  it('fails closed around malformed optional surfaces while preserving already-canonical monitors', () => {
    const project = privacyFixture();
    const stage = requiredTarget(project, 0);
    const sprite = requiredTarget(project, 1);
    delete project['author'];
    delete project['customProjectPayload'];
    project.meta = {semver: '3.0.0', privateNote: 'remove'};
    sprite.costumes.push({...media('malformed-costume', 'ignored', 'svg'), name: 17});
    sprite.sounds.push({...media('malformed-sound', 'ignored', 'wav'), name: false});
    sprite.blocks['opaque-entry'] = {opaque: true} as unknown as ScratchBlock;
    stage.blocks['second-name-reporter'] = block('looks_backdropnumbername', {}, {NUMBER_NAME: ['name', null]});
    project.monitors = [{
      id: 'opaque-monitor', opcode: 'sensing_of', params: 'malformed', spriteName: 7,
      visible: false, mode: 'default', value: 0, width: 0, height: 0, x: 0, y: 0,
      sliderMin: 0, sliderMax: 100, isDiscrete: true
    }];

    const report = apply(project, 91);

    expect(sprite.costumes.at(-1)?.['name']).toBe(17);
    expect(sprite.sounds.at(-1)?.['name']).toBe(false);
    expect(sprite.blocks['opaque-entry']).toEqual({opaque: true});
    expect(project.monitors[0]).toMatchObject({params: 'malformed', spriteName: 7});
    expect(report.monitorsCanonicalized).toBe(0);
    expect(report.metadataPropertiesRemoved).toBe(1);
    expect(report.nameReporterObservations).toBe(2);
    expect(report.caveats).toEqual(expect.arrayContaining([
      expect.stringContaining('2 built-in display-name reporters'),
      expect.stringContaining('1 optional provenance or noncanonical root metadata property')
    ]));
  });

  it('rejects a non-boolean API modifier and preserves unresolved typed broadcast evidence in the common pass', () => {
    expect(() => obfuscateProject(
      createFixtureProject(),
      'lossless',
      new Uint8Array(32),
      {extra: 'yes' as unknown as boolean}
    )).toThrow('extra must be a boolean');

    const project = createFixtureProject();
    const stage = requiredTarget(project, 0);
    const broadcast = requiredBlock(stage, 'broadcast_message');
    broadcast.inputs['BROADCAST_INPUT'] = [1, [11, 'missing message', 'missing-broadcast-id']];
    const stats: ObfuscationStats = {
      mode: 'lossless', blocksBefore: 0, blocksAfter: 0, identifiersRenamed: 0, symbolsRenamed: 0,
      commentsRemoved: 0, decoysAdded: 0, virtualizedBlocks: 0, warnings: [], caveats: []
    };

    applyCommonTransforms(
      project,
      new DeterministicGenerator(new Uint8Array(32).fill(92), 'privacy-common-defensive-test'),
      stats
    );

    const unresolved = project.targets.flatMap(target => Object.values(target.blocks))
      .flatMap(value => isScratchBlock(value) ? Object.values(value.inputs) : [])
      .flatMap(input => input.slice(1))
      .find(value => isPrimitive(value) && value[0] === 11 && value[2] === 'missing-broadcast-id');
    expect(unresolved).toEqual([11, 'missing message', 'missing-broadcast-id']);
  });

  it('fails explicitly when an unvalidated Stage-less project requests backdrop-name resolution', () => {
    const project = privacyFixture();
    project.targets = project.targets.filter(target => !target.isStage);
    const sprite = requiredTarget(project, 0);
    sprite.blocks = {backdrop: block('looks_switchbackdropto', {BACKDROP: [1, [10, 'Backdrop']]})};

    expect(() => apply(project, 93)).toThrow('validated project has no Stage privacy plan');
  });

  it('allows callers to retain optional metadata and monitor presentation', () => {
    const project = privacyFixture();
    const report = applyExtraPrivacyTransform(
      project,
      new DeterministicGenerator(new Uint8Array(32).fill(71), EXTRA_PRIVACY_GENERATOR_DOMAIN),
      {canonicalizeMonitorPresentation: false, stripOptionalProjectMetadata: false}
    );
    expect(project.meta['agent']).toBe('fixture');
    expect(project['author']).toBe('Readable author');
    expect(project.monitors[0]?.['visible']).toBe(true);
    expect(report.monitorsCanonicalized).toBe(0);
    expect(report.metadataPropertiesRemoved).toBe(0);
  });

  it('exports the pass integration boundary without granting extension or topology changes', () => {
    expect(EXTRA_PRIVACY_GENERATOR_DOMAIN).toBe('extra:v1');
    expect(EXTRA_PRIVACY_PASS_NAME).toBe('extra-project-privacy');
    expect(EXTRA_PRIVACY_ALLOWED_CHANGES).toContain('target-identity');
    expect(EXTRA_PRIVACY_ALLOWED_CHANGES).toContain('assets');
    expect(EXTRA_PRIVACY_ALLOWED_CHANGES).not.toContain('executable-topology');
  });
});

describe('extra level 2 editor-shadow pass', () => {
  it('marks every final native event hat and changes no other serialized value', () => {
    const first = createFixtureProject();
    const second = structuredClone(first);
    const firstOrder = first.targets.map(target => Object.keys(target.blocks));
    const equivalentsBefore = countBlockEquivalents(first);

    const firstReport = applyExtraEditorShadowTransform(first);
    const secondReport = applyExtraEditorShadowTransform(second);

    expect(first).toEqual(second);
    expect(firstReport).toEqual(secondReport);
    expect(first.targets.map(target => Object.keys(target.blocks))).toEqual(firstOrder);
    expect(countBlockEquivalents(first)).toBe(equivalentsBefore);
    expect(firstReport.coveredHatCount).toBe(2);
    expect(firstReport.changedHatCount).toBe(2);
    expect(firstReport.manifest).toMatchObject({version: 1, changedHatCount: 2});
    expect(firstReport.manifest.sites).toHaveLength(2);
    expect(isTrustedExtraEditorShadowManifest(firstReport.manifest)).toBe(true);
    expect(isTrustedExtraEditorShadowManifest(structuredClone(firstReport.manifest))).toBe(false);
    expect(firstReport.caveats).toEqual([EXTRA_EDITOR_SHADOW_CAVEAT]);
    expect(EXTRA_EDITOR_SHADOW_PASS_NAME).toBe('extra-editor-shadow-hats');

    for (const target of first.targets) {
      for (const value of Object.values(target.blocks)) {
        if (!isScratchBlock(value) || !value.topLevel || !isOfficialHatOpcode(value.opcode)) continue;
        expect(value.shadow).toBe(true);
      }
    }
    expect(requiredBlock(requiredTarget(first, 0), 'set_score').shadow).toBe(false);
    expect(requiredBlock(requiredTarget(first, 1), 'change_local').shadow).toBe(false);
    validateProject(first);
  });

  it('records pre-existing shadow state and reports a project with no native hats', () => {
    const project = createFixtureProject();
    requiredBlock(requiredTarget(project, 0), 'start_script').shadow = true;
    requiredTarget(project, 1).blocks = {};
    const report = applyExtraEditorShadowTransform(project);

    expect(report.coveredHatCount).toBe(1);
    expect(report.changedHatCount).toBe(0);
    expect(report.manifest.sites).toEqual([
      expect.objectContaining({targetIndex: 0, previousShadow: true, opcode: 'event_whenflagclicked'})
    ]);

    requiredTarget(project, 0).blocks = {};
    const empty = applyExtraEditorShadowTransform(project);
    expect(empty.manifest.sites).toEqual([]);
    expect(empty.caveats).toEqual(['Extra level 2 found no native event hats to hide.']);
  });

  it('runs through the engine with strict manifest verification and rejects conflicting API levels', () => {
    const source = createFixtureProject();
    const result = obfuscateProject(source, 'lossless', new Uint8Array(32).fill(94), {
      extra: true,
      extraLevel: 2
    });
    const finalHats = result.project.targets.flatMap(target => Object.values(target.blocks))
      .filter(value => isScratchBlock(value) && value.topLevel && isOfficialHatOpcode(value.opcode));

    expect(finalHats).toHaveLength(2);
    expect(finalHats.every(value => isScratchBlock(value) && value.shadow)).toBe(true);
    expect(result.stats.extraPrivacyLevel).toBe(2);
    expect(result.stats.privacyHatShadowSites).toBe(2);
    expect(result.stats.privacyHatShadowChanges).toBe(2);
    expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    expect(result.stats.caveats).toEqual(expect.arrayContaining([EXTRA_EDITOR_SHADOW_CAVEAT]));

    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32), {
      extra: false,
      extraLevel: 2
    })).toThrow('extra conflicts with extraLevel');
    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32), {
      extra: true,
      extraLevel: 0
    })).toThrow('extra conflicts with extraLevel');
    expect(() => obfuscateProject(source, 'lossless', new Uint8Array(32), {
      extraLevel: 3 as 2
    })).toThrow('extraLevel must be 0, 1, or 2');
  });

  it.each([
    ['lossless', true, false],
    ['lossless', false, true],
    ['lossless', true, true],
    ['lossy', true, false],
    ['lossy', false, true],
    ['lossy', true, true],
    ['no-preserve', true, false],
    ['no-preserve', false, true],
    ['no-preserve', true, true]
  ] as const)('verifies %s with antiCheat=%s and antiSave=%s', (mode, antiCheat, antiSave) => {
    const result = obfuscateProject(createFixtureProject(), mode, new Uint8Array(32).fill(0x5f), {
      antiCheat,
      antiSave,
      extraLevel: 2
    });
    const nativeHats = result.project.targets.flatMap(target => Object.values(target.blocks))
      .filter(value => isScratchBlock(value) && value.topLevel && isOfficialHatOpcode(value.opcode));

    expect(nativeHats.length).toBeGreaterThan(0);
    expect(nativeHats.every(hat => isScratchBlock(hat) && hat.shadow)).toBe(true);
    expect(result.stats.verification).toEqual(expect.objectContaining({verdict: 'verified-with-caveats'}));
    if (antiCheat) expect(getAntiCheatReleaseCheckpoint(result)).toBeDefined();
    if (antiSave) expect(result.stats.antiSaveCanaries).toBeGreaterThan(0);
    validateProject(result.project);
  });
});

describe('extra privacy CLI contract', () => {
  it('accepts the modifier independently, normalizes both spellings, and rejects assigned values', () => {
    expect(parseCliArguments(['input.sb3', '-extra'])).toMatchObject({mode: 'lossless', extra: true});
    expect(parseCliArguments(['input.sb3', '--lossy', '--extra'])).toMatchObject({mode: 'lossy', extra: true});
    expect(parseCliArguments(['--no-preserve', '-anticheat', '-extra', 'input.sb3'])).toMatchObject({
      mode: 'no-preserve', antiCheat: true, extra: true
    });
    expect(parseCliArguments(['input.sb3', '--extra', '-extra'])).toMatchObject({extra: true});
    expect(parseCliArguments(['input.sb3'])).toMatchObject({extra: false});
    expect(() => parseCliArguments(['input.sb3', '--extra=max'])).toThrow('unknown option');
  });

  it('documents both spellings in CLI help', async () => {
    const captured = capture();
    expect(await runCli(['--help'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('-extra, --extra');
  });

  it('runs deterministically, preserves archive asset bytes, and reports privacy caveats', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-extra-'));
    temporaryDirectories.push(directory);
    const input = join(directory, 'input.sb3');
    const firstOutput = join(directory, 'first.sb3');
    const secondOutput = join(directory, 'second.sb3');
    await writeFile(input, createFixtureArchive());
    const first = capture();
    const second = capture();

    expect(await runCli([input, '-extra', '-o', firstOutput], first.io), first.stderr.join('')).toBe(0);
    expect(await runCli([input, '--extra', '-o', secondOutput], second.io), second.stderr.join('')).toBe(0);
    expect(await readFile(firstOutput)).toEqual(await readFile(secondOutput));
    expect(first.stdout.join('')).toContain('extra=1');
    expect(first.stderr.join('')).toContain('binary asset bytes');
    expect(first.stderr.join('')).toContain('external target or asset-name consumers');

    const transformed = readProjectFromArchive(await readFile(firstOutput));
    expect(transformed.targets[0]?.name).toBe('Stage');
    expect(transformed.targets[1]?.name).not.toBe('Visible Sprite');
    expect(transformed.targets.flatMap(target => target.costumes).some(costume => costume['name'] === 'visible costume')).toBe(false);
    expect(transformed.meta).toEqual({semver: '3.0.0'});
  });
});

function privacyFixture(): ScratchProject {
  const project = createFixtureProject();
  const stage = requiredTarget(project, 0);
  const sprite = requiredTarget(project, 1);
  stage.variables['cloud_value'] = ['cloud-visible-name', 1, true];
  stage.variables['watermark'] = ['Obfuscated by PrioSDK Gen 4.', 0];
  stage.costumes = [
    media('stage-a', 'Backdrop', 'svg'),
    media('stage-b', 'backdrop', 'svg')
  ];
  sprite.costumes = [
    media('costume-a', 'Hero', 'svg'),
    media('costume-b', 'Hero', 'svg'),
    media('costume-c', 'hero', 'svg')
  ];
  sprite.sounds = [
    media('sound-a', 'Theme', 'wav'),
    media('sound-b', 'Theme', 'wav'),
    media('sound-c', 'theme', 'wav')
  ];
  stage.blocks = {
    'backdrop-hat': block('event_whenbackdropswitchesto', {}, {BACKDROP: ['Backdrop', null]}),
    'typed-broadcast': block('event_broadcast', {BROADCAST_INPUT: [1, [11, 'go', 'broadcast_go']]}),
    'dynamic-broadcast': block('event_broadcast', {BROADCAST_INPUT: [2, 'computed-broadcast']}),
    'computed-broadcast': {
      ...block('operator_join', {STRING1: [1, [10, 'g']], STRING2: [1, [10, 'o']]}),
      parent: 'dynamic-broadcast',
      topLevel: false
    }
  };
  stage.comments = {};
  sprite.blocks = {
    goto: block('motion_goto', {TO: [1, 'goto-menu']}),
    'goto-menu': {...block('motion_goto_menu', {}, {TO: ['Visible Sprite', null]}), parent: 'goto', shadow: true, topLevel: false},
    'missing-target': block('motion_goto', {TO: [1, [10, 'Missing sprite']]}),
    'dynamic-target': block('motion_goto', {TO: [2, 'dynamic-target-value']}),
    'dynamic-target-value': {...block('sensing_answer'), parent: 'dynamic-target', topLevel: false},
    costume: block('looks_switchcostumeto', {COSTUME: [1, 'costume-menu']}),
    'costume-menu': {...block('looks_costume', {}, {COSTUME: ['Hero', null]}), parent: 'costume', shadow: true, topLevel: false},
    'missing-costume': block('looks_switchcostumeto', {COSTUME: [1, [10, 'Missing costume']]}),
    'dynamic-costume': block('looks_switchcostumeto', {COSTUME: [2, 'dynamic-costume-value']}),
    'dynamic-costume-value': {...block('sensing_answer'), parent: 'dynamic-costume', topLevel: false},
    backdrop: block('looks_switchbackdropto', {BACKDROP: [1, 'backdrop-menu']}),
    'backdrop-menu': {...block('looks_backdrops', {}, {BACKDROP: ['backdrop', null]}), parent: 'backdrop', shadow: true, topLevel: false},
    'missing-backdrop': block('looks_switchbackdropto', {BACKDROP: [1, [10, 'Missing backdrop']]}),
    'dynamic-backdrop': block('looks_switchbackdropto', {BACKDROP: [2, 'dynamic-backdrop-value']}),
    'dynamic-backdrop-value': {...block('sensing_answer'), parent: 'dynamic-backdrop', topLevel: false},
    sound: block('sound_play', {SOUND_MENU: [1, 'sound-menu']}),
    'sound-menu': {...block('sound_sounds_menu', {}, {SOUND_MENU: ['Theme', null]}), parent: 'sound', shadow: true, topLevel: false},
    'missing-sound': block('sound_play', {SOUND_MENU: [1, [10, 'Missing sound']]}),
    'dynamic-sound': block('sound_play', {SOUND_MENU: [2, 'dynamic-sound-value']}),
    'dynamic-sound-value': {...block('sensing_answer'), parent: 'dynamic-sound', topLevel: false},
    receive: block('event_whenbroadcastreceived', {}, {BROADCAST_OPTION: ['go', 'broadcast_go']}),
    reporter: block('looks_costumenumbername', {}, {NUMBER_NAME: ['name', null]}),
    'extension-selector': block('videoSensing_videoOn', {}, {VIDEOONMENU2: ['Visible Sprite', null]})
  };
  sprite['customTargetPayload'] = {retained: true};
  project.monitors = [
    {
      id: 'local_score', opcode: 'data_variable', params: {VARIABLE: 'Readable score'}, spriteName: 'Visible Sprite',
      visible: true, mode: 'slider', value: 88, width: 120, height: 24, x: 70, y: 90,
      sliderMin: -50, sliderMax: 500, isDiscrete: false
    },
    {
      id: 'sensing-object', opcode: 'sensing_of', params: {OBJECT: 'Visible Sprite', PROPERTY: 'x position'},
      spriteName: null, visible: true, mode: 'default', value: 'Visible Sprite', width: 50, height: 20, x: 2, y: 3
    },
    {
      id: 'global_list', opcode: 'data_listcontents', params: {LIST: 'Readable list'}, spriteName: null,
      visible: true, mode: 'list', value: ['alpha'], width: 100, height: 80, x: 1, y: 1
    }
  ];
  project.extensions = ['videoSensing'];
  project.meta = {semver: '3.0.0', vm: '15.1.0', agent: 'fixture', origin: 'https://example.invalid', privateNote: 'remove'};
  project['author'] = 'Readable author';
  project['customProjectPayload'] = {remove: true};
  return project;
}

function apply(project: ScratchProject, byte: number): ReturnType<typeof applyExtraPrivacyTransform> {
  return applyExtraPrivacyTransform(
    project,
    new DeterministicGenerator(new Uint8Array(32).fill(byte), EXTRA_PRIVACY_GENERATOR_DOMAIN)
  );
}

function media(assetId: string, name: string, dataFormat: string): Record<string, string | number> {
  const digest = createHash('md5').update(assetId).digest('hex');
  return {assetId: digest, name, dataFormat, md5ext: `${digest}.${dataFormat}`, rotationCenterX: 0, rotationCenterY: 0};
}

function descriptorIdentity(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) throw new Error('missing media descriptor');
  return {
    assetId: value['assetId'],
    dataFormat: value['dataFormat'],
    md5ext: value['md5ext'],
    rotationCenterX: value['rotationCenterX'],
    rotationCenterY: value['rotationCenterY']
  };
}

function requiredMedia(value: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  if (!value) throw new Error('missing media descriptor');
  return value;
}

function block(
  opcode: string,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {opcode, next: null, parent: null, inputs, fields, shadow: false, topLevel: true, x: 0, y: 0};
}

function requiredTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`missing target ${index}`);
  return target;
}

function requiredBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!isScratchBlock(value)) throw new Error(`missing block ${id}`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`missing ${label}`);
  return value;
}

function capture(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: {stdout(text: string): void; stderr(text: string): void};
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {stdout: text => stdout.push(text), stderr: text => stderr.push(text)}
  };
}
