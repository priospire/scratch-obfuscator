import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {
  applyAggressiveTransforms,
  makeInvisibleDisplayName,
  safeInvisibleDisplayName
} from '../src/obfuscation/aggressive.js';
import {
  blockAt,
  collectLinearRuns,
  collectNumericLiteralSites,
  collectStringLiteralSites,
  collectVariableCandidates,
  countBlockEquivalents,
  countObjectBlocks,
  hardenInactiveShadows,
  isLossyLiveTransformSafe
} from '../src/obfuscation/analysis.js';
import type {
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchBlockValue,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';

describe('aggressive transforms', () => {
  it('produces deterministic, bounded, loadable lossy projects with real opaque decoys', () => {
    const first = fixtureProject();
    const second = structuredClone(first);
    const before = countBlockEquivalents(first);
    const firstStats = stats('lossy', first);
    const secondStats = stats('lossy', second);

    applyAggressiveTransforms(first, 'lossy', generator(7), firstStats);
    applyAggressiveTransforms(second, 'lossy', generator(7), secondStats);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(firstStats).toEqual(secondStats);
    expect(firstStats.decoysAdded).toBeGreaterThan(0);
    expect(firstStats.virtualizedBlocks).toBe(0);
    expect(countBlockEquivalents(first)).toBeLessThanOrEqual(Math.min(before * 4, 50_000));
    expect(opcodes(first)).toContain('control_if');
    expect(opcodes(first)).toContain('operator_equals');
    expect(opcodes(first)).not.toContain('procedures_definition');
    const originalIds = new Set(fixtureProject().targets.flatMap(targetValue => Object.keys(targetValue.blocks)));
    const siteMetrics = measureGeneratedTopLevelSites(first, originalIds);
    expect(siteMetrics.length).toBeGreaterThan(0);
    expect(siteMetrics.every(metric => metric.growth <= 64 && metric.depth <= 32)).toBe(true);
    const sprite = first.targets[1];
    const hat = sprite?.blocks['green-flag'];
    const originalValue = sprite?.blocks['set-1'];
    expect(hat && isScratchBlock(hat) ? hat.next : undefined).toBe('set-1');
    expect(originalValue && isScratchBlock(originalValue) ? originalValue.inputs['VALUE']?.[1] : undefined).toEqual([10, 'alpha']);
    validateProject(first);
  });

  it('fragments eligible runs into shuffled warp handlers in no-preserve mode', () => {
    const project = fixtureProject();
    const before = countBlockEquivalents(project);
    const resultStats = stats('no-preserve', project);

    applyAggressiveTransforms(project, 'no-preserve', generator(91), resultStats);

    expect(resultStats.virtualizedBlocks).toBeGreaterThanOrEqual(4);
    expect(resultStats.decoysAdded).toBeGreaterThan(0);
    expect(opcodes(project).filter(opcode => opcode === 'procedures_definition').length).toBeGreaterThanOrEqual(4);
    expect(opcodes(project).filter(opcode => opcode === 'procedures_call').length).toBeGreaterThanOrEqual(4);
    expect(dispatcherRouteOpcodes(project).length).toBeGreaterThanOrEqual(5);
    expect(countBlockEquivalents(project)).toBeLessThanOrEqual(Math.min((before * 25) + 512, 100_000));

    const sprite = project.targets[1];
    const firstOriginal = sprite?.blocks['set-1'];
    expect(firstOriginal && isScratchBlock(firstOriginal) ? firstOriginal.next : undefined).not.toBe('change-1');
    expect(firstOriginal && isScratchBlock(firstOriginal) ? firstOriginal.parent : undefined).not.toBe('green-flag');
    const originalIds = new Set(['set-1', 'change-1', 'set-2', 'change-2']);
    for (const id of originalIds) {
      const value = sprite?.blocks[id];
      expect(value && isScratchBlock(value) && value.next ? originalIds.has(value.next) : false).toBe(false);
    }
    const encodedLabels = collectDispatcherLabels(project);
    expect(encodedLabels.size).toBeGreaterThan(resultStats.virtualizedBlocks);
    const transitionListEntries = Object.entries(sprite?.lists ?? {}).filter(([, declaration]) => (
      Array.isArray(declaration[1])
      && declaration[1].some(item => typeof item === 'string' && item.startsWith('r_'))
    ));
    expect(transitionListEntries).not.toHaveLength(0);
    const transitionWidths = transitionListEntries.flatMap(([, declaration]) => parseTransitionWidths(declaration[1]));
    expect(new Set(transitionWidths)).toEqual(new Set([1, 2, 3, 4]));
    const transitionListIds = new Set(transitionListEntries.map(([id]) => id));
    const indirectTransitions = Object.values(sprite?.blocks ?? {}).filter(value => {
      if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') return false;
      const reporterId = value.inputs['VALUE']?.[1];
      const reporter = typeof reporterId === 'string' ? sprite?.blocks[reporterId] : undefined;
      const listId = reporter && isScratchBlock(reporter) ? reporter.fields['LIST']?.[1] : undefined;
      return reporter && isScratchBlock(reporter) && reporter.opcode === 'data_itemoflist'
        && typeof listId === 'string' && transitionListIds.has(listId);
    });
    expect(indirectTransitions.length).toBeGreaterThan(resultStats.virtualizedBlocks);
    expect(Object.values(sprite?.blocks ?? {}).some(value => isDualRail(sprite, value))).toBe(true);
    expect(Object.values(sprite?.blocks ?? {}).some(value => {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_definition' || !value.next) return false;
      const body = sprite?.blocks[value.next];
      const listId = body && isScratchBlock(body) ? body.fields['LIST']?.[1] : undefined;
      return body && isScratchBlock(body) && body.opcode === 'data_deletealloflist'
        && typeof listId === 'string' && transitionListIds.has(listId);
    })).toBe(true);
    expect(hasFieldReference(project, 'original-variable-id')).toBe(false);
    expect(sprite?.variables['original-variable-id']).toBeUndefined();
    validateProject(project);
  });

  it('keeps cloud, Stage, monitored, sensed, and unsupported variable uses out of virtualization', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.variables['cloud-local'] = ['cloud', 0, true];
    sprite.variables['sensed'] = ['temperature', 0];
    sprite.variables['shown'] = ['shown', 0];
    project.monitors.push({
      id: 'shown',
      mode: 'default',
      opcode: 'data_variable',
      params: {VARIABLE: 'shown'},
      spriteName: 'Sprite1',
      value: 0,
      visible: false,
      x: 0,
      y: 0
    });
    sprite.blocks['sensed-reader'] = block('sensing_of', null, null, false, {
      OBJECT: [1, [10, 'Sprite1']]
    }, {PROPERTY: ['temperature']});

    const candidates = collectVariableCandidates(project);

    expect(candidates.map(candidate => candidate.id)).toEqual(['original-variable-id']);

    const primitiveReference = structuredClone(project);
    const primitiveSprite = primitiveReference.targets[1];
    if (!primitiveSprite) throw new Error('fixture is missing its sprite');
    primitiveSprite.blocks['primitive-reference'] = [12, 'score', 'original-variable-id'];
    expect(collectVariableCandidates(primitiveReference).some(candidate => candidate.id === 'original-variable-id')).toBe(false);

    const unsupportedField = structuredClone(project);
    const unsupportedFieldSprite = unsupportedField.targets[1];
    if (!unsupportedFieldSprite) throw new Error('fixture is missing its sprite');
    unsupportedFieldSprite.blocks['unsupported-field'] = block(
      'data_showvariable',
      null,
      null,
      false,
      {},
      {VARIABLE: ['score', 'original-variable-id']}
    );
    expect(collectVariableCandidates(unsupportedField).some(candidate => candidate.id === 'original-variable-id')).toBe(false);

    const extension = structuredClone(project);
    const extensionSprite = extension.targets[1];
    if (!extensionSprite) throw new Error('fixture is missing its sprite');
    extensionSprite.blocks['extension'] = block('pen_clear', null, null, false);
    expect(collectVariableCandidates(extension)).toHaveLength(0);

    const opaqueMutation = structuredClone(project);
    const opaqueSprite = opaqueMutation.targets[1];
    if (!opaqueSprite) throw new Error('fixture is missing its sprite');
    const opaqueBlock = opaqueSprite.blocks['set-1'];
    if (!opaqueBlock || !isScratchBlock(opaqueBlock)) throw new Error('fixture is missing its set block');
    opaqueBlock.mutation = {tagName: 'mutation', hiddenSymbol: 'original-variable-id'};
    expect(collectVariableCandidates(opaqueMutation)).toHaveLength(0);

    const recognizedMutation = structuredClone(project);
    const recognizedSprite = recognizedMutation.targets[1];
    if (!recognizedSprite) throw new Error('fixture is missing its sprite');
    recognizedSprite.blocks['call'] = {
      ...block('procedures_call', null, null, false),
      mutation: {tagName: 'mutation', children: [], proccode: 'known', argumentids: '[]', warp: 'false'}
    };
    expect(collectVariableCandidates(recognizedMutation).map(candidate => candidate.id)).toEqual(['original-variable-id']);
  });

  it('creates non-empty NFC-stable invisible names without unsafe controls', () => {
    const names = Array.from({length: 50}, (_, index) => makeInvisibleDisplayName(generator(index), index));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).not.toBe('');
      expect(name.normalize('NFC')).toBe(name);
      expect(Array.from(name).some(character => character === '\u202e' || character === '\ufeff')).toBe(false);
    }
    const unsafeNames = [
      '\u0000', '\u0001', '\u001f', '\u007f', '\u0085', '\u009f', '\u061c', '\u200c', '\u200d', '\u200e', '\u200f',
      '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\u206f', '\ufeff', '\ud800', '\udfff'
    ];
    for (const [index, unsafe] of unsafeNames.entries()) {
      expect(safeInvisibleDisplayName(unsafe, generator(index + 100), index).startsWith('\ue000')).toBe(true);
    }
    expect(safeInvisibleDisplayName('\u2063\u200b\u2060', generator(4), 4)).toBe('\u2063\u200b\u2060');
    expect(safeInvisibleDisplayName('', generator(5), 5).startsWith('\ue000')).toBe(true);
  });

  it('encodes only proof-safe numeric sites and preserves signed zero exactly', () => {
    const project: ScratchProject = {
      targets: [target(true, 'Stage'), target(false, 'Sprite1')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.variables['raw-id'] = ['raw', 'initial'];
    sprite.blocks['hat'] = block('event_whenflagclicked', 'set-x', null, true);
    sprite.blocks['set-x'] = block('motion_setx', null, 'hat', false, {X: [1, [4, '-0']]});
    sprite.blocks['raw-store'] = block(
      'data_setvariableto',
      null,
      null,
      true,
      {VALUE: [1, [4, '01']]},
      {VARIABLE: ['raw', 'raw-id']}
    );
    sprite.blocks['comparison'] = block(
      'operator_equals',
      null,
      null,
      true,
      {OPERAND1: [1, [4, '0']], OPERAND2: [1, [4, '  ']]}
    );

    expect(collectNumericLiteralSites(project)).toMatchObject([
      {ownerId: 'set-x', inputName: 'X', value: '-0', growth: 3}
    ]);
    applyAggressiveTransforms(project, 'lossy', generator(79), stats('lossy', project));

    const setX = sprite.blocks['set-x'];
    if (!setX || !isScratchBlock(setX)) throw new Error('numeric owner disappeared');
    const equationId = setX.inputs['X']?.[1];
    const equation = typeof equationId === 'string' ? sprite.blocks[equationId] : undefined;
    expect(equation && isScratchBlock(equation) ? equation.opcode : undefined).toBe('operator_multiply');
    if (!equation || !isScratchBlock(equation)) throw new Error('numeric equation is missing');
    const left = equation.inputs['NUM1']?.[1];
    const right = equation.inputs['NUM2']?.[1];
    if (!isPrimitive(left) || !isPrimitive(right)) throw new Error('numeric equation operands are missing');
    expect(Object.is(Number(left[1]) * Number(right[1]), -0)).toBe(true);
    expect(setX.inputs['X']?.[2]).not.toEqual([4, '-0']);
    const rawStore = sprite.blocks['raw-store'];
    expect(rawStore && isScratchBlock(rawStore) ? rawStore.inputs['VALUE']?.[1] : undefined).toEqual([4, '01']);

    const dualRail = Object.values(sprite.blocks).find(value => {
      if (!isScratchBlock(value) || value.opcode !== 'control_if_else' || value.next !== 'set-x') return false;
      const firstId = value.inputs['SUBSTACK']?.[1];
      const secondId = value.inputs['SUBSTACK2']?.[1];
      const first = typeof firstId === 'string' ? sprite.blocks[firstId] : undefined;
      const second = typeof secondId === 'string' ? sprite.blocks[secondId] : undefined;
      return first && second && isScratchBlock(first) && isScratchBlock(second)
        && first.opcode === 'data_setvariableto' && second.opcode === 'data_addtolist';
    });
    expect(dualRail).toBeDefined();
    validateProject(project);
  });

  it('proves exact power-of-two equations for finite numeric edge domains', () => {
    const literals = [
      '0',
      '-0',
      '5e-324',
      '-5e-324',
      '1.7976931348623157e+308',
      '-1.7976931348623157e+308',
      '1.2345678901234567',
      '9007199254740991'
    ];
    const project: ScratchProject = {
      targets: [target(true, 'Stage'), target(false, 'Sprite1')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    for (const [index, literal] of literals.entries()) {
      sprite.blocks[`numeric-${index}`] = block('motion_setx', null, null, true, {X: [1, [4, literal]]});
    }

    applyAggressiveTransforms(project, 'lossy', generator(80), stats('lossy', project));

    for (const [index, literal] of literals.entries()) {
      const owner = sprite.blocks[`numeric-${index}`];
      if (!owner || !isScratchBlock(owner)) throw new Error('numeric owner disappeared');
      const equationId = owner.inputs['X']?.[1];
      const equation = typeof equationId === 'string' ? sprite.blocks[equationId] : undefined;
      if (!equation || !isScratchBlock(equation)) throw new Error('numeric equation is missing');
      const left = equation.inputs['NUM1']?.[1];
      const right = equation.inputs['NUM2']?.[1];
      if (!isPrimitive(left) || !isPrimitive(right)) throw new Error('numeric equation operands are missing');
      expect(Object.is(Number(left[1]) * Number(right[1]), Number(literal))).toBe(true);
      expect(Object.is(Number(left[1]), Number(literal))).toBe(false);
      expect(owner.inputs['X']?.[2]).not.toEqual([4, literal]);
    }
    validateProject(project);
  });

  it('pools short strings and retains existing inactive fallbacks exactly', () => {
    const source: ScratchProject = {
      targets: [target(true, 'Stage')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const stage = source.targets[0];
    if (!stage) throw new Error('fixture is missing its Stage');
    stage.blocks['say'] = block(
      'looks_say',
      null,
      null,
      true,
      {MESSAGE: [3, [10, 'x'], [10, 'fallback']]}
    );
    const pooled = structuredClone(source);
    const split = structuredClone(source);
    const pooledLong = structuredClone(source);
    const longSay = pooledLong.targets[0]?.blocks['say'];
    if (!longSay || !isScratchBlock(longSay)) throw new Error('fixture string block is missing');
    longSay.inputs['MESSAGE'] = [3, [10, 'xy'], [10, 'fallback']];

    applyAggressiveTransforms(pooled, 'no-preserve', generator(81), stats('no-preserve', pooled));
    applyAggressiveTransforms(split, 'lossy', generator(81), stats('lossy', split));
    applyAggressiveTransforms(pooledLong, 'no-preserve', generator(81), stats('no-preserve', pooledLong));

    const pooledSay = pooled.targets[0]?.blocks['say'];
    const pooledReporterId = pooledSay && isScratchBlock(pooledSay) ? pooledSay.inputs['MESSAGE']?.[1] : undefined;
    const pooledReporter = typeof pooledReporterId === 'string' ? pooled.targets[0]?.blocks[pooledReporterId] : undefined;
    expect(pooledReporter && isScratchBlock(pooledReporter) ? pooledReporter.opcode : undefined).toBe('data_itemoflist');
    expect(pooledSay && isScratchBlock(pooledSay) ? pooledSay.inputs['MESSAGE']?.[2] : undefined).toEqual([10, 'fallback']);
    const splitSay = split.targets[0]?.blocks['say'];
    const splitReporterId = splitSay && isScratchBlock(splitSay) ? splitSay.inputs['MESSAGE']?.[1] : undefined;
    const splitReporter = typeof splitReporterId === 'string' ? split.targets[0]?.blocks[splitReporterId] : undefined;
    expect(splitReporter && isScratchBlock(splitReporter) ? splitReporter.opcode : undefined).toBe('operator_join');
    expect(splitSay && isScratchBlock(splitSay) ? splitSay.inputs['MESSAGE']?.[2] : undefined).toEqual([10, 'fallback']);
    const transformedLong = pooledLong.targets[0]?.blocks['say'];
    const longReporterId = transformedLong && isScratchBlock(transformedLong) ? transformedLong.inputs['MESSAGE']?.[1] : undefined;
    const longReporter = typeof longReporterId === 'string' ? pooledLong.targets[0]?.blocks[longReporterId] : undefined;
    expect(longReporter && isScratchBlock(longReporter) ? longReporter.opcode : undefined).toBe('operator_join');
    validateProject(pooled);
    validateProject(split);
    validateProject(pooledLong);
  });

  it('adds live non-yielding indirection only when the lossy safety gate succeeds', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    const last = sprite.blocks['change-2'];
    if (!last || !isScratchBlock(last)) throw new Error('fixture is missing its last command');
    last.next = null;
    delete sprite.blocks['wait-anchor'];
    const resultStats = stats('lossy', project);

    applyAggressiveTransforms(project, 'lossy', generator(33), resultStats);

    const hat = sprite.blocks['green-flag'];
    expect(hat && isScratchBlock(hat) ? hat.next : undefined).not.toBe('set-1');
    const set = sprite.blocks['set-1'];
    expect(typeof (set && isScratchBlock(set) ? set.inputs['VALUE']?.[1] : undefined)).toBe('string');
    const lossyPrototype = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.opcode === 'procedures_prototype');
    expect(lossyPrototype && isScratchBlock(lossyPrototype) ? lossyPrototype.mutation?.['warp'] : undefined).toBe('false');
    validateProject(project);
  });

  it('inverts safe conditions once and swaps their branches without changing branch bodies', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    const last = sprite.blocks['change-2'];
    if (!last || !isScratchBlock(last)) throw new Error('fixture is missing its last command');
    last.next = null;
    delete sprite.blocks['wait-anchor'];
    sprite.blocks['manual-if'] = block(
      'control_if',
      null,
      null,
      true,
      {CONDITION: [2, 'condition'], SUBSTACK: [2, 'then-branch']}
    );
    sprite.blocks['condition'] = block(
      'operator_equals',
      null,
      'manual-if',
      false,
      {OPERAND1: [1, [4, '1']], OPERAND2: [1, [4, '1']]}
    );
    sprite.blocks['then-branch'] = block('looks_show', null, 'manual-if', false);
    sprite.blocks['manual-else'] = block(
      'control_if_else',
      null,
      null,
      true,
      {SUBSTACK: [2, 'first-branch'], SUBSTACK2: [2, 'second-branch']}
    );
    sprite.blocks['first-branch'] = block('looks_show', null, 'manual-else', false);
    sprite.blocks['second-branch'] = block('looks_hide', null, 'manual-else', false);
    for (let index = 0; index < 4; index += 1) {
      sprite.blocks[`manual-outline-${index}`] = block(
        index % 2 === 0 ? 'looks_show' : 'looks_hide',
        index === 3 ? null : `manual-outline-${index + 1}`,
        index === 0 ? null : `manual-outline-${index - 1}`,
        index === 0
      );
    }

    applyAggressiveTransforms(project, 'lossy', generator(34), stats('lossy', project));

    const invertedIf = sprite.blocks['manual-if'];
    if (!invertedIf || !isScratchBlock(invertedIf)) throw new Error('conditional disappeared');
    expect(invertedIf.opcode).toBe('control_if_else');
    expect(invertedIf.inputs['SUBSTACK']).toEqual([2, null]);
    expect(invertedIf.inputs['SUBSTACK2']).toEqual([2, 'then-branch']);
    const firstNotId = invertedIf.inputs['CONDITION']?.[1];
    const firstNot = typeof firstNotId === 'string' ? sprite.blocks[firstNotId] : undefined;
    expect(firstNot && isScratchBlock(firstNot) ? firstNot.opcode : undefined).toBe('operator_not');
    expect(firstNot && isScratchBlock(firstNot) ? firstNot.inputs['OPERAND'] : undefined).toEqual([2, 'condition']);
    const originalCondition = sprite.blocks['condition'];
    expect(originalCondition && isScratchBlock(originalCondition) ? originalCondition.parent : undefined).toBe(firstNotId);

    const invertedElse = sprite.blocks['manual-else'];
    if (!invertedElse || !isScratchBlock(invertedElse)) throw new Error('conditional disappeared');
    expect(invertedElse.inputs['SUBSTACK']).toEqual([2, 'second-branch']);
    expect(invertedElse.inputs['SUBSTACK2']).toEqual([2, 'first-branch']);
    const secondNotId = invertedElse.inputs['CONDITION']?.[1];
    const secondNot = typeof secondNotId === 'string' ? sprite.blocks[secondNotId] : undefined;
    expect(secondNot && isScratchBlock(secondNot) ? secondNot.inputs['OPERAND'] : undefined).toEqual([1, [10, '']]);
    const manualCall = Object.values(sprite.blocks).find(
      value => isScratchBlock(value) && value.opcode === 'procedures_call' && value.topLevel
    );
    expect(manualCall && isScratchBlock(manualCall) ? [manualCall.parent, manualCall.x, manualCall.y] : undefined).toEqual([null, 10, 20]);
    validateProject(project);
  });

  it('bounds long dispatcher regions and leaves a native separator between sites', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.blocks = {};
    for (let index = 0; index < 30; index += 1) {
      sprite.blocks[`linear-${index}`] = block(
        'data_setvariableto',
        index === 29 ? null : `linear-${index + 1}`,
        index === 0 ? null : `linear-${index - 1}`,
        index === 0,
        {VALUE: [1, [10, `value-${index}`]]},
        {VARIABLE: ['score', 'original-variable-id']}
      );
    }
    const resultStats = stats('no-preserve', project);

    applyAggressiveTransforms(project, 'no-preserve', generator(55), resultStats);

    expect(resultStats.virtualizedBlocks).toBe(29);
    expect(dispatcherRouteOpcodes(project).length).toBeGreaterThanOrEqual(31);
    expect(Object.values(sprite.variables).filter(tuple => typeof tuple[0] === 'string' && tuple[0].startsWith('\u2063')).length).toBeGreaterThanOrEqual(2);
    validateProject(project);
  });

  it('fills the strongest finite budget even when the source has no blocks', () => {
    const project: ScratchProject = {
      targets: [target(true, 'Stage')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const resultStats = stats('no-preserve', project);

    applyAggressiveTransforms(project, 'no-preserve', generator(8), resultStats);

    expect(countBlockEquivalents(project)).toBe(512);
    expect(resultStats.decoysAdded).toBeGreaterThan(200);
    const siteMetrics = measureGeneratedTopLevelSites(project, new Set());
    expect(siteMetrics.length).toBeGreaterThan(1);
    expect(siteMetrics.every(metric => metric.growth <= 256 && metric.depth <= 128)).toBe(true);
    validateProject(project);
  });

  it('accounts for default VALUE primitives before virtualizing variables at the exact cap', () => {
    const project: ScratchProject = {
      targets: [target(true, 'Stage'), target(false, 'Sprite1')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.variables['local'] = ['local', 0];
    sprite.blocks['hat'] = block('event_whenflagclicked', 'set', null, true);
    sprite.blocks['set'] = block('data_setvariableto', 'change', 'hat', false, {}, {VARIABLE: ['local', 'local']});
    sprite.blocks['change'] = block('data_changevariableby', null, 'set', false, {}, {VARIABLE: ['local', 'local']});
    const before = countBlockEquivalents(project);
    expect(collectVariableCandidates(project)).toMatchObject([{id: 'local', estimatedGrowth: 8}]);

    applyAggressiveTransforms(project, 'no-preserve', generator(17), stats('no-preserve', project));

    expect(countBlockEquivalents(project)).toBe(Math.min((before * 25) + 512, 100_000));
    validateProject(project);
  });

  it('leaves a variable native when its single-site virtualization would exceed 256 equivalents', () => {
    const project: ScratchProject = {
      targets: [target(true, 'Stage'), target(false, 'Sprite1')],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.variables['large-local'] = ['large local', 0];
    sprite.blocks['hat'] = block('event_whenflagclicked', 'change-0', null, true);
    for (let index = 0; index < 50; index += 1) {
      sprite.blocks[`change-${index}`] = block(
        'data_changevariableby',
        index === 49 ? null : `change-${index + 1}`,
        index === 0 ? 'hat' : `change-${index - 1}`,
        false,
        {},
        {VARIABLE: ['large local', 'large-local']}
      );
    }
    expect(collectVariableCandidates(project)).toMatchObject([{id: 'large-local', estimatedGrowth: 300}]);

    applyAggressiveTransforms(project, 'no-preserve', generator(18), stats('no-preserve', project));

    expect(sprite.variables['large-local']).toEqual(['large local', 0]);
    validateProject(project);
  });

  it('classifies lossy observability hazards conservatively', () => {
    const safe = fixtureProject();
    const safeSprite = safe.targets[1];
    if (!safeSprite) throw new Error('fixture is missing its sprite');
    const last = safeSprite.blocks['change-2'];
    if (!last || !isScratchBlock(last)) throw new Error('fixture is missing its last command');
    last.next = null;
    delete safeSprite.blocks['wait-anchor'];
    safeSprite.blocks['primitive'] = [12, 'score', 'original-variable-id'];
    expect(isLossyLiveTransformSafe(safe)).toBe(true);

    const extension = structuredClone(safe);
    const extensionSprite = extension.targets[1];
    if (!extensionSprite) throw new Error('fixture is missing its sprite');
    extensionSprite.blocks['extension'] = block('pen_clear', null, null, false);
    expect(isLossyLiveTransformSafe(extension)).toBe(false);

    const prefixlessExtension = structuredClone(safe);
    const prefixlessSprite = prefixlessExtension.targets[1];
    if (!prefixlessSprite) throw new Error('fixture is missing its sprite');
    prefixlessSprite.blocks['extension'] = block('unknown', null, null, false);
    expect(isLossyLiveTransformSafe(prefixlessExtension)).toBe(false);

    const event = structuredClone(safe);
    const eventSprite = event.targets[1];
    if (!eventSprite) throw new Error('fixture is missing its sprite');
    eventSprite.blocks['key-hat'] = block('event_whenkeypressed', null, null, true);
    expect(isLossyLiveTransformSafe(event)).toBe(false);

    const secondHat = structuredClone(safe);
    const secondSprite = secondHat.targets[1];
    if (!secondSprite) throw new Error('fixture is missing its sprite');
    secondSprite.blocks['second-green-flag'] = block('event_whenflagclicked', null, null, true);
    expect(isLossyLiveTransformSafe(secondHat)).toBe(false);

    for (const hazardousOpcode of ['motion_glidesecstoxy', 'sound_play', 'sensing_setdragmode', 'control_for_each']) {
      const hazardous = structuredClone(safe);
      const hazardousSprite = hazardous.targets[1];
      if (!hazardousSprite) throw new Error('fixture is missing its sprite');
      hazardousSprite.blocks['hazard'] = block(hazardousOpcode, null, null, false);
      expect(isLossyLiveTransformSafe(hazardous)).toBe(false);
    }
  });

  it('derives safe decoy opcodes from the original project vocabulary', () => {
    let observedVocabularyDecoy = false;
    for (let seed = 0; seed < 8; seed += 1) {
      const project: ScratchProject = {
        targets: [target(true, 'Stage'), target(false, 'Sprite1')],
        monitors: [],
        extensions: [],
        meta: {semver: '3.0.0'}
      };
      const sprite = project.targets[1];
      if (!sprite) throw new Error('fixture is missing its sprite');
      sprite.variables['counter-id'] = ['counter', 0];
      sprite.blocks['hat'] = block('event_whenflagclicked', 'change', null, true);
      sprite.blocks['change'] = block(
        'data_changevariableby',
        'wait',
        'hat',
        false,
        {VALUE: [1, [4, '1']]},
        {VARIABLE: ['counter', 'counter-id']}
      );
      sprite.blocks['wait'] = block('control_wait', null, 'change', false, {DURATION: [1, [4, '0.01']]});

      applyAggressiveTransforms(project, 'lossy', generator(120 + seed), stats('lossy', project));

      observedVocabularyDecoy ||= Object.entries(sprite.blocks).some(([id, value]) => (
        id !== 'change' && isScratchBlock(value) && value.opcode === 'data_changevariableby'
      ));
      validateProject(project);
    }
    expect(observedVocabularyDecoy).toBe(true);
  });

  it('uses present list-operation vocabulary for every decoy cost class', () => {
    let sawDelete = false;
    let sawInsert = false;
    for (let seed = 0; seed < 8; seed += 1) {
      const project: ScratchProject = {
        targets: [target(true, 'Stage')],
        monitors: [],
        extensions: [],
        meta: {semver: '3.0.0'}
      };
      const stage = project.targets[0];
      if (!stage) throw new Error('fixture is missing its Stage');
      stage.lists['list-id'] = ['list', ['a']];
      stage.blocks['wait'] = block('control_wait', null, null, true, {DURATION: [1, [4, '0.01']]});
      stage.blocks['clear'] = block('data_deletealloflist', null, null, true, {}, {LIST: ['list', 'list-id']});
      stage.blocks['delete'] = block('data_deleteoflist', null, null, true, {INDEX: [1, [4, '1']]}, {LIST: ['list', 'list-id']});
      stage.blocks['insert'] = block(
        'data_insertatlist',
        null,
        null,
        true,
        {INDEX: [1, [4, '1']], ITEM: [1, [10, 'x']]},
        {LIST: ['list', 'list-id']}
      );

      applyAggressiveTransforms(project, 'lossy', generator(140 + seed), stats('lossy', project));

      sawDelete ||= Object.entries(stage.blocks).some(([id, value]) => id !== 'delete' && isScratchBlock(value) && value.opcode === 'data_deleteoflist');
      sawInsert ||= Object.entries(stage.blocks).some(([id, value]) => id !== 'insert' && isScratchBlock(value) && value.opcode === 'data_insertatlist');
      validateProject(project);
    }
    expect(sawDelete).toBe(true);
    expect(sawInsert).toBe(true);
  });

  it('handles conservative analysis fallbacks and shadow primitive domains', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.variables['unused'] = ['unused', 0];
    sprite.blocks['primitive-variable'] = [12, 'score', 'original-variable-id'];
    sprite.blocks['numeric-text'] = block('looks_say', null, null, false, {MESSAGE: [1, [10, 42]]});
    sprite.blocks['extension-text'] = block('pen_say', null, null, false, {MESSAGE: [1, [10, 'ignored']]});
    sprite.blocks['unsafe-input-name'] = block('looks_say', null, null, false, {MENU: [1, [10, 'ignored']]});
    const danglingTop = block('data_setvariableto', 'missing', null, true, {VALUE: [1, [10, 'kept']]}, {VARIABLE: ['score', 'original-variable-id']});
    delete danglingTop.x;
    delete danglingTop.y;
    sprite.blocks['dangling-top'] = danglingTop;
    const sites = collectStringLiteralSites(project);
    expect(sites.some(site => site.value === 'ignored')).toBe(false);
    expect(collectLinearRuns(project, 1).some(run => run.blockIds.includes('dangling-top'))).toBe(true);
    expect(blockAt(sprite, 'missing')).toBeUndefined();
    expect(countObjectBlocks(project)).toBeLessThan(Object.keys(sprite.blocks).length + Object.keys(project.targets[0]?.blocks ?? {}).length);

    const unsupported = structuredClone(project);
    const unsupportedSprite = unsupported.targets[1];
    if (!unsupportedSprite) throw new Error('fixture is missing its sprite');
    unsupportedSprite.blocks['unsupported-variable'] = block(
      'data_showvariable',
      null,
      null,
      false,
      {},
      {VARIABLE: ['score', 'original-variable-id']}
    );
    expect(collectVariableCandidates(unsupported).some(candidate => candidate.id === 'original-variable-id')).toBe(false);

    const fallback = fixtureProject();
    const fallbackSprite = fallback.targets[1];
    if (!fallbackSprite) throw new Error('fixture is missing its sprite');
    fallbackSprite.blocks['join-original'] = block(
      'operator_join',
      null,
      'set-2',
      false,
      {STRING1: [3, 'fallback-reporter', [12, 'score', 'original-variable-id']], STRING2: [1, [10, 'x']]}
    );
    fallbackSprite.blocks['fallback-reporter'] = block(
      'operator_add',
      null,
      'join-original',
      false,
      {NUM1: [1, [4, '1']], NUM2: [1, [4, '1']]}
    );
    expect(collectVariableCandidates(fallback).some(candidate => candidate.id === 'original-variable-id')).toBe(false);

    const shadowProject = fixtureProject();
    const shadowSprite = shadowProject.targets[1];
    if (!shadowSprite) throw new Error('fixture is missing its sprite');
    const owner = shadowSprite.blocks['shadow-color-owner'];
    const symbolOwner = shadowSprite.blocks['shadow-symbol-owner'];
    if (!owner || !isScratchBlock(owner) || !symbolOwner || !isScratchBlock(symbolOwner)) {
      throw new Error('fixture is missing its shadow owner');
    }
    owner.inputs['MESSAGE'] = [3, 'color-reporter', [9, '#112233']];
    symbolOwner.inputs['MESSAGE'] = [3, 'symbol-reporter', [12, 'score', 'original-variable-id']];
    const changed = hardenInactiveShadows(shadowProject, primitive => primitive[0] === 9 ? [9, '#abcdef'] : primitive);
    expect(changed).toBeGreaterThanOrEqual(3);
    expect(owner.inputs['MESSAGE']?.[2]).toEqual([9, '#abcdef']);
  });

  it('virtualizes a manually startable top-level stack while retaining its coordinates', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.blocks = {};
    sprite.variables['primitive-only'] = ['primitive only', 1];
    sprite.blocks['primitive-entry'] = [12, 'primitive only', 'primitive-only'];
    for (let index = 0; index < 4; index += 1) {
      sprite.blocks[`manual-${index}`] = block(
        'data_setvariableto',
        index === 3 ? null : `manual-${index + 1}`,
        index === 0 ? null : `manual-${index - 1}`,
        index === 0,
        {VALUE: [1, [10, `m-${index}`]]},
        {VARIABLE: ['score', 'original-variable-id']}
      );
    }
    const resultStats = stats('no-preserve', project);

    applyAggressiveTransforms(project, 'no-preserve', generator(71), resultStats);

    const generatedTop = Object.values(sprite.blocks).find(value => isScratchBlock(value) && value.topLevel && value.opcode === 'data_setvariableto');
    expect(generatedTop && isScratchBlock(generatedTop) ? [generatedTop.x, generatedTop.y] : undefined).toEqual([10, 20]);
    validateProject(project);
  });

  it('resolves deterministic block, symbol, and display-name collisions without overwriting input data', () => {
    const sourceRng = generator(88);
    const factoryRng = sourceRng.fork('aggressive-ids');
    const collidingBlockId = factoryRng.fork('block\u0000guard-top-level').id('b_', 20);
    const collidingSymbolId = factoryRng.fork('symbol\u0000state-0').id('v_', 20);
    const collidingName = makeInvisibleDisplayName(factoryRng.fork('name\u0000state-0'), 0);
    const stage = target(true, 'Stage');
    stage.variables['dummy-variable'] = ['dummy', 1];
    stage.variables[collidingSymbolId] = [collidingName, 99];
    stage.blocks[collidingBlockId] = [12, 'dummy', 'dummy-variable'];
    const project: ScratchProject = {
      targets: [stage],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0'}
    };

    applyAggressiveTransforms(project, 'no-preserve', sourceRng, stats('no-preserve', project));

    expect(stage.blocks[collidingBlockId]).toEqual([12, 'dummy', 'dummy-variable']);
    expect(stage.variables[collidingSymbolId]).toEqual([collidingName, 99]);
    expect(Object.values(stage.variables).filter(declaration => declaration[0] === collidingName)).toHaveLength(1);
    validateProject(project);
  });

  it('stops live lossy passes at their stage budgets and falls back to decoys', () => {
    const project = fixtureProject();
    const sprite = project.targets[1];
    if (!sprite) throw new Error('fixture is missing its sprite');
    sprite.blocks = {};
    sprite.blocks['green-flag'] = block('event_whenflagclicked', 'set-0', null, true);
    for (let index = 0; index < 20; index += 1) {
      sprite.blocks[`set-${index}`] = block(
        'data_setvariableto',
        index === 19 ? null : `set-${index + 1}`,
        index === 0 ? 'green-flag' : `set-${index - 1}`,
        false,
        {VALUE: [1, [10, `literal-${index}`]], MESSAGE: [1, [10, `extra-${index}`]]},
        {VARIABLE: ['score', 'original-variable-id']}
      );
    }
    const resultStats = stats('lossy', project);

    applyAggressiveTransforms(project, 'lossy', generator(72), resultStats);

    const originalBlocks = Array.from({length: 20}, (_, index) => sprite.blocks[`set-${index}`]).filter(isScratchBlock);
    const activeLiterals = originalBlocks.flatMap(value => [value.inputs['VALUE']?.[1], value.inputs['MESSAGE']?.[1]]);
    expect(activeLiterals.some(isPrimitive)).toBe(true);
    expect(activeLiterals.some(value => typeof value === 'string')).toBe(true);
    expect(originalBlocks.some((value, index) => value.next === `set-${index + 1}`)).toBe(true);
    expect(opcodes(project).some(opcode => opcode === 'control_if' || opcode === 'control_if_else')).toBe(true);
    validateProject(project);
  });
});

function fixtureProject(): ScratchProject {
  const stage = target(true, 'Stage');
  const sprite = target(false, 'Sprite1');
  sprite.variables['original-variable-id'] = ['score', 1];
  sprite.variables['shadow-variable-id'] = ['shadow', 7];
  sprite.blocks['green-flag'] = block('event_whenflagclicked', 'set-1', null, true);
  sprite.blocks['set-1'] = block(
    'data_setvariableto',
    'change-1',
    'green-flag',
    false,
    {VALUE: [1, [10, 'alpha']]},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['change-1'] = block(
    'data_changevariableby',
    'set-2',
    'set-1',
    false,
    {VALUE: [3, 'delta-reporter', [4, '2']]},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['delta-reporter'] = block(
    'operator_add',
    null,
    'change-1',
    false,
    {NUM1: [1, [4, '1']], NUM2: [1, [4, '1']]}
  );
  sprite.blocks['color-reporter'] = block(
    'operator_add',
    null,
    'shadow-color-owner',
    false,
    {NUM1: [1, [4, '1']], NUM2: [1, [4, '1']]}
  );
  sprite.blocks['symbol-reporter'] = block(
    'operator_add',
    null,
    'shadow-symbol-owner',
    false,
    {NUM1: [1, [4, '1']], NUM2: [1, [4, '1']]}
  );
  sprite.blocks['set-2'] = block(
    'data_setvariableto',
    'change-2',
    'change-1',
    false,
    {VALUE: [3, 'join-original', [10, 'inactive-readable-shadow']]},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['join-original'] = block(
    'operator_join',
    null,
    'set-2',
    false,
    {STRING1: [3, [12, 'score', 'original-variable-id'], [10, '']], STRING2: [1, [10, '']]}
  );
  sprite.blocks['change-2'] = block(
    'data_changevariableby',
    'wait-anchor',
    'set-2',
    false,
    {VALUE: [1, [4, '3']]},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['wait-anchor'] = block('control_wait', null, 'change-2', false, {DURATION: [1, [4, '0.01']]});
  sprite.blocks['variable-reporter'] = {
    ...block('data_variable', null, null, true, {}, {VARIABLE: ['score', 'original-variable-id']}),
    x: 30,
    y: 40
  };
  sprite.blocks['set-with-default'] = block(
    'data_setvariableto',
    null,
    null,
    true,
    {},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['change-with-default'] = block(
    'data_changevariableby',
    null,
    null,
    true,
    {},
    {VARIABLE: ['score', 'original-variable-id']}
  );
  sprite.blocks['shadow-color-owner'] = block(
    'looks_say',
    null,
    null,
    true,
    {MESSAGE: [3, 'color-reporter', [9, '#112233']]}
  );
  sprite.blocks['shadow-symbol-owner'] = block(
    'looks_say',
    null,
    null,
    true,
    {MESSAGE: [3, 'symbol-reporter', [12, 'shadow', 'shadow-variable-id']]}
  );
  return {
    targets: [stage, sprite],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: '3.0.0', agent: 'test'}
  };
}

function target(isStage: boolean, name: string): ScratchTarget {
  return {
    isStage,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{assetId: '00000000000000000000000000000000', dataFormat: 'svg', name: isStage ? 'backdrop1' : 'costume1'}],
    sounds: []
  };
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
    ...(topLevel ? {x: 10, y: 20} : {})
  };
}

function generator(fill: number): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(fill & 0xff), 'test');
}

function stats(mode: ObfuscationMode, project: ScratchProject): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode,
    blocksBefore: blocks,
    blocksAfter: blocks,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function opcodes(project: ScratchProject): string[] {
  return project.targets.flatMap(target => Object.values(target.blocks))
    .filter(isScratchBlock)
    .map(blockValue => blockValue.opcode);
}

function hasFieldReference(project: ScratchProject, id: string): boolean {
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      for (const field of Object.values(value.fields)) {
        if (field[1] === id) return true;
      }
      for (const input of Object.values(value.inputs)) {
        for (const slot of input.slice(1)) {
          if (isPrimitive(slot) && slot[0] === 12 && slot[2] === id && input[1] === slot) return true;
        }
      }
    }
  }
  return false;
}

function collectDispatcherLabels(project: ScratchProject): Set<string> {
  const labels = new Set<string>();
  for (const targetValue of project.targets) {
    for (const value of Object.values(targetValue.blocks)) {
      if (!isScratchBlock(value) || (value.opcode !== 'control_if_else' && value.opcode !== 'control_if')) continue;
      const conditionId = value.inputs['CONDITION']?.[1];
      const condition = typeof conditionId === 'string' ? targetValue.blocks[conditionId] : undefined;
      if (!condition || !isScratchBlock(condition) || condition.opcode !== 'operator_equals') continue;
      const literal = condition.inputs['OPERAND2']?.[1];
      if (isPrimitive(literal) && literal[0] === 4 && (typeof literal[1] === 'string' || typeof literal[1] === 'number')) {
        labels.add(String(literal[1]));
      }
    }
  }
  return labels;
}

function parseTransitionWidths(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const entries = value as readonly unknown[];
  const widths: number[] = [];
  let cursor = 0;
  while (cursor < entries.length) {
    const marker: unknown = entries[cursor];
    const width: unknown = entries[cursor + 1];
    if (typeof marker !== 'string' || !marker.startsWith('r_') || typeof width !== 'number' || width < 1 || width > 4) return [];
    const labelIndex = cursor + 2 + width;
    if (typeof entries[labelIndex] !== 'number') return [];
    widths.push(width);
    cursor = labelIndex + 1;
  }
  return widths;
}

function isDualRail(targetValue: ScratchTarget | undefined, value: ScratchBlockValue): boolean {
  if (!targetValue || !isScratchBlock(value) || value.opcode !== 'control_if_else') return false;
  const firstId = value.inputs['SUBSTACK']?.[1];
  const secondId = value.inputs['SUBSTACK2']?.[1];
  const first = typeof firstId === 'string' ? targetValue.blocks[firstId] : undefined;
  const second = typeof secondId === 'string' ? targetValue.blocks[secondId] : undefined;
  return Boolean(
    first && second && isScratchBlock(first) && isScratchBlock(second)
    && first.opcode === 'data_setvariableto' && second.opcode === 'data_addtolist'
  );
}

function dispatcherRouteOpcodes(project: ScratchProject): string[] {
  const result: string[] = [];
  for (const targetValue of project.targets) {
    const definitionBodies = Object.values(targetValue.blocks)
      .filter(value => isScratchBlock(value) && value.opcode === 'procedures_definition' && value.next !== null)
      .map(value => isScratchBlock(value) ? value.next : null)
      .filter((value): value is string => value !== null);
    for (const bodyId of definitionBodies) {
      const visited = new Set<string>();
      let routeId: string | null = bodyId;
      while (routeId !== null && !visited.has(routeId)) {
        visited.add(routeId);
        const route: ScratchBlockValue | undefined = targetValue.blocks[routeId];
        if (!route || !isScratchBlock(route) || (route.opcode !== 'control_if' && route.opcode !== 'control_if_else')) break;
        result.push(route.opcode);
        const continuation: ScratchInput[number] | null | undefined = route.opcode === 'control_if_else'
          ? route.inputs['SUBSTACK2']?.[1]
          : route.next;
        routeId = typeof continuation === 'string' ? continuation : null;
      }
    }
  }
  return result;
}

interface SiteMetric {
  readonly growth: number;
  readonly depth: number;
}

function measureGeneratedTopLevelSites(project: ScratchProject, originalIds: ReadonlySet<string>): SiteMetric[] {
  const metrics: SiteMetric[] = [];
  for (const targetValue of project.targets) {
    for (const [id, value] of Object.entries(targetValue.blocks)) {
      if (!isScratchBlock(value) || !value.topLevel || originalIds.has(id)) continue;
      metrics.push(measureGeneratedSite(targetValue, id, originalIds, new Set()));
    }
  }
  return metrics;
}

function measureGeneratedSite(
  targetValue: ScratchTarget,
  id: string,
  originalIds: ReadonlySet<string>,
  visited: Set<string>
): SiteMetric {
  if (visited.has(id) || originalIds.has(id)) return {growth: 0, depth: 0};
  const value = targetValue.blocks[id];
  if (!value || !isScratchBlock(value)) return {growth: 0, depth: 0};
  visited.add(id);
  let growth = 1;
  let depth = 1;
  const childIds: string[] = [];
  if (value.next) childIds.push(value.next);
  for (const input of Object.values(value.inputs)) {
    for (const slot of input.slice(1)) {
      if (isPrimitive(slot)) growth += 1;
      else if (typeof slot === 'string') childIds.push(slot);
    }
  }
  for (const childId of childIds) {
    const child = measureGeneratedSite(targetValue, childId, originalIds, visited);
    growth += child.growth;
    depth = Math.max(depth, 1 + child.depth);
  }
  return {growth, depth};
}
