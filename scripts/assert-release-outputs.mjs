import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';

const WATERMARK = 'Obfuscated by PrioSDK Gen 4.';
const STAGE_MARKERS = ['stage-alpha-initial-v2', 'stage-beta-initial-v2'];
const SPRITE_MARKERS = ['sprite-alpha-initial-v2', 'sprite-beta-initial-v2'];
const OPAQUE_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ASCII_OPAQUE = new RegExp(`^x_[${OPAQUE_ALPHABET}](?:[${OPAQUE_ALPHABET}]{27}|[${OPAQUE_ALPHABET}]{35})$`, 'u');
const INVISIBLE_OPAQUE = /^\u2063[\u200b\u2060]{32,}$/u;
const PRIVATE_USE_OPAQUE = new RegExp(`^\\ue000[0-9a-z]+_x_[${OPAQUE_ALPHABET}]{18}$`, 'u');
const SENTINEL_TOKEN = /^[!#$%*+\-./:;=?@^_~]{32}$/u;

const [
  fixturePath,
  losslessPath,
  lossyPath,
  noPreservePath,
  losslessAntiPath,
  lossyAntiPath,
  noPreserveAntiPath
] = process.argv.slice(2);
if (!fixturePath || !losslessPath || !lossyPath || !noPreservePath ||
    !losslessAntiPath || !lossyAntiPath || !noPreserveAntiPath) {
  throw new Error(
    'usage: assert-release-outputs.mjs <fixture.sb3> <lossless.sb3> <lossy.sb3> <no-preserve.sb3> ' +
    '<lossless-anticheat.sb3> <lossy-anticheat.sb3> <no-preserve-anticheat.sb3>'
  );
}

const fixture = await loadArchive(fixturePath);
const specifications = [
  {label: 'lossless', mode: 'lossless', antiCheat: false, path: losslessPath},
  {label: 'lossy', mode: 'lossy', antiCheat: false, path: lossyPath},
  {label: 'no-preserve', mode: 'no-preserve', antiCheat: false, path: noPreservePath},
  {label: 'lossless + anti-cheat', mode: 'lossless', antiCheat: true, path: losslessAntiPath},
  {label: 'lossy + anti-cheat', mode: 'lossy', antiCheat: true, path: lossyAntiPath},
  {label: 'no-preserve + anti-cheat', mode: 'no-preserve', antiCheat: true, path: noPreserveAntiPath}
];
const outputs = await Promise.all(specifications.map(async specification => ({
  ...specification,
  archive: await loadArchive(specification.path)
})));

assertFixtureContract(fixture.project);
const originalIds = collectOriginalIds(fixture.project);
const originalRenamableNames = new Set([
  'Readable score',
  'Readable list',
  'Readable stage alpha',
  'Readable stage beta',
  'Readable sprite alpha',
  'Readable sprite beta'
]);

for (const output of outputs) {
  const {archive, label, mode, antiCheat} = output;
  assertAssetsEqual(fixture.entries, archive.entries, label);
  assertOutputContract(fixture.project, archive.project, label);
  const strings = collectStrings(archive.project);
  for (const id of originalIds) assert(!strings.has(id), `${label} retained original identifier ${JSON.stringify(id)}`);
  for (const name of originalRenamableNames) {
    assert(!strings.has(name), `${label} retained renamable name ${JSON.stringify(name)}`);
  }
  assert(!strings.has('Readable release-fixture comment'), `${label} retained the fixture comment`);
  assertNoInactiveFallbacks(archive.project, label);
  assertWatermark(archive.project, label);
  assertOpaqueSymbolNames(archive.project, label);
  assertStaticOptimization(archive.project, mode, label);
  assertVariablePacking(archive.project, mode, label);
  if (mode === 'no-preserve') assertNoPreserveVirtualization(archive.project, label);
  if (antiCheat) {
    assertAntiCheat(archive.project, label);
  } else {
    assertNoAntiCheat(archive.project, label);
  }
}

process.stdout.write('Release fixture assertions passed for all six mode and anti-cheat combinations.\n');

async function loadArchive(path) {
  const archive = unzipSync(await readFile(path));
  const projectBytes = archive['project.json'];
  assert(projectBytes, `${path} has no project.json`);
  return {
    entries: archive,
    project: JSON.parse(Buffer.from(projectBytes).toString('utf8'))
  };
}

function assertFixtureContract(project) {
  assert(Array.isArray(project.targets) && project.targets.length === 2, 'fixture must contain Stage and one sprite');
  const [stage, sprite] = project.targets;
  assert(stage?.isStage === true && sprite?.isStage === false, 'fixture target order is invalid');
  assert(Array.isArray(project.monitors) && project.monitors.length === 1, 'fixture monitor is missing');
  assert(Array.isArray(project.extensions) && project.extensions.length === 0, 'fixture must remain core-only');

  for (const marker of STAGE_MARKERS) {
    assert(Object.values(stage.variables).some(declaration => declaration?.[1] === marker), `fixture is missing ${marker}`);
  }
  for (const marker of SPRITE_MARKERS) {
    assert(Object.values(sprite.variables).some(declaration => declaration?.[1] === marker), `fixture is missing ${marker}`);
  }
  assert(sprite.blocks.sprite_set_stage?.fields?.VARIABLE?.[1] === 'stage_alpha', 'fixture cross-target variable use is missing');

  const directIds = [
    'sprite_set_stage',
    'sprite_set_local',
    'sprite_set_x',
    'sprite_set_y',
    'sprite_set_size',
    'sprite_set_volume'
  ];
  assert(sprite.blocks.sprite_flag?.next === directIds[0], 'fixture marker chain has no runnable entry');
  for (let index = 0; index < directIds.length - 1; index += 1) {
    assert(sprite.blocks[directIds[index]]?.next === directIds[index + 1], 'fixture virtualization marker chain is incomplete');
  }

  const xInput = sprite.blocks.sprite_set_x?.inputs?.X;
  assert(Array.isArray(xInput) && xInput[0] === 3 && xInput[1] === 'static_multiply', 'fixture inactive numeric fallback is missing');
  const yInput = sprite.blocks.sprite_set_y?.inputs?.Y;
  assert(Array.isArray(yInput) && yInput[0] === 3 && yInput[1] === 'stage_reporter', 'fixture inactive reporter fallback is missing');
  assert(evaluateNumericInput(sprite, xInput, new Set()) === 72, 'fixture nested arithmetic is not (5 + 4) * 8');

  const runnableHats = objectBlocks(project).filter(({block}) => block.topLevel && block.opcode === 'event_whenflagclicked');
  assert(runnableHats.length === 1, 'fixture must have exactly one runnable hat for lossy live-safety');
}

function assertOutputContract(original, transformed, label) {
  assert(transformed.targets.length === original.targets.length, `${label} changed target count`);
  assert(JSON.stringify(transformed.extensions) === JSON.stringify(original.extensions), `${label} changed declared extensions`);
  for (let index = 0; index < original.targets.length; index += 1) {
    const before = original.targets[index];
    const after = transformed.targets[index];
    assert(after?.isStage === before?.isStage, `${label} changed target order`);
    assert(after?.name === before?.name, `${label} changed target name`);
    assert(JSON.stringify(after?.costumes) === JSON.stringify(before?.costumes), `${label} changed costume descriptors`);
    assert(JSON.stringify(after?.sounds) === JSON.stringify(before?.sounds), `${label} changed sound descriptors`);
    assert(Object.keys(after?.comments ?? {}).length === 0, `${label} retained comments`);
  }

  assert(transformed.monitors.length === original.monitors.length, `${label} changed monitor count`);
  const preservedMonitorKeys = [
    'mode', 'opcode', 'spriteName', 'value', 'width', 'height', 'x', 'y', 'visible', 'sliderMin', 'sliderMax', 'isDiscrete'
  ];
  for (const key of preservedMonitorKeys) {
    assert(
      JSON.stringify(transformed.monitors[0]?.[key]) === JSON.stringify(original.monitors[0]?.[key]),
      `${label} changed monitor ${key}`
    );
  }
}

function assertStaticOptimization(project, mode, label) {
  const marker = findUniqueMarker(objectBlocks(project), 'motion_setx', label);
  const input = marker.block.inputs?.X;
  assert(Array.isArray(input), `${label} motion_setx has no X input`);
  const value = evaluateNumericInput(project.targets[marker.targetIndex], input, new Set());
  assert(value === 72, `${label} changed the nested arithmetic result`);
  const descendantOpcodes = collectReporterOpcodes(project.targets[marker.targetIndex], input);
  if (mode === 'lossless') {
    assert(descendantOpcodes.includes('operator_add'), `${label} folded executable operators in lossless mode`);
    assert(descendantOpcodes.includes('operator_multiply'), `${label} lost the original multiply reporter`);
  } else {
    assert(!descendantOpcodes.includes('operator_add'), `${label} retained the original static addition tree`);
  }
}

function assertVariablePacking(project, mode, label) {
  const stage = project.targets.find(target => target.isStage);
  const sprite = project.targets.find(target => !target.isStage);
  assert(stage && sprite, `${label} has no Stage/sprite pair`);

  const monitor = project.monitors[0];
  assert(typeof monitor?.id === 'string' && Object.hasOwn(stage.variables, monitor.id), `${label} packed the monitored variable`);

  if (mode === 'lossless') {
    assertMarkersRemainVariables(stage, STAGE_MARKERS, label);
    assertMarkersRemainVariables(sprite, SPRITE_MARKERS, label);
    return;
  }

  assertMarkersPackedInOneList(stage, STAGE_MARKERS, `${label} Stage`);
  assertMarkersPackedInOneList(sprite, SPRITE_MARKERS, `${label} sprite`);
}

function assertMarkersRemainVariables(target, markers, label) {
  const values = Object.values(target.variables).map(declaration => declaration?.[1]);
  for (const marker of markers) assert(values.includes(marker), `${label} unexpectedly packed ${marker}`);
}

function assertMarkersPackedInOneList(target, markers, label) {
  const variableValues = Object.values(target.variables).map(declaration => declaration?.[1]);
  for (const marker of markers) assert(!variableValues.includes(marker), `${label} retained packed scalar ${marker}`);
  const matchingLists = Object.values(target.lists).filter(declaration => {
    const values = declaration?.[1];
    return Array.isArray(values) && markers.every(marker => values.includes(marker));
  });
  assert(matchingLists.length === 1, `${label} did not place all eligible scalars in one backing list`);
  const packedValues = matchingLists[0]?.[1];
  assert(Array.isArray(packedValues), `${label} backing list has no value array`);
  for (const marker of markers) {
    assert(packedValues.filter(value => value === marker).length === 1, `${label} stored ${marker} more than once`);
  }
}

function assertNoInactiveFallbacks(project, label) {
  for (const {id, block} of objectBlocks(project)) {
    for (const [inputName, input] of Object.entries(block.inputs ?? {})) {
      assert(!Array.isArray(input) || input[0] !== 3, `${label} retained inactive fallback ${id}.${inputName}`);
    }
  }
}

function assertOpaqueSymbolNames(project, label) {
  const symbolNames = [];
  const procedureCodes = [];
  for (const target of project.targets) {
    for (const declaration of [...Object.values(target.variables), ...Object.values(target.lists)]) {
      if (typeof declaration?.[0] === 'string') symbolNames.push(declaration[0]);
    }
    for (const block of Object.values(target.blocks)) {
      const code = isObjectBlock(block) ? block.mutation?.proccode : undefined;
      if (typeof code === 'string') procedureCodes.push(code);
    }
  }

  const watermarkCount = symbolNames.filter(name => name === WATERMARK).length;
  assert(watermarkCount === 1, `${label} has an invalid watermark count`);
  for (const name of [...symbolNames, ...procedureCodes]) {
    if (name === WATERMARK) continue;
    assert(isOpaqueName(name), `${label} has readable generated symbol name ${JSON.stringify(name)}`);
    assert(name.normalize('NFC') === name, `${label} has a non-NFC symbol name`);
  }
  assert(new Set(symbolNames).size === symbolNames.length, `${label} has duplicate generated symbol names`);
}

function isOpaqueName(name) {
  return ASCII_OPAQUE.test(name) || INVISIBLE_OPAQUE.test(name) || PRIVATE_USE_OPAQUE.test(name);
}

function assertNoPreserveVirtualization(project, label) {
  const blocks = objectBlocks(project);
  const opcodes = blocks.map(entry => entry.block.opcode);
  assert(opcodes.includes('control_if_else'), `${label} has no dispatcher branch`);
  assert(opcodes.filter(opcode => opcode === 'procedures_definition').length > 1, `${label} has no generated handler procedures`);

  const markers = [
    findUniqueMarker(blocks, 'motion_setx', label),
    findUniqueMarker(blocks, 'motion_sety', label),
    findUniqueMarker(blocks, 'looks_setsizeto', label),
    findUniqueMarker(blocks, 'sound_setvolumeto', label)
  ];
  for (let index = 0; index < markers.length - 1; index += 1) {
    const current = markers[index];
    const successor = markers[index + 1];
    assert(current.block.next !== successor.id, `${label} retained direct marker edge ${current.block.opcode} -> ${successor.block.opcode}`);
    assert(successor.block.parent !== current.id, `${label} retained direct marker parent ${current.block.opcode} -> ${successor.block.opcode}`);
  }

  const variableReporters = new Set(blocks.filter(entry => entry.block.opcode === 'data_variable').map(entry => entry.id));
  const equalsWithPcReporter = new Set(blocks.filter(entry => {
    if (entry.block.opcode !== 'operator_equals') return false;
    return Object.values(entry.block.inputs ?? {}).some(input => Array.isArray(input) && variableReporters.has(input[1]));
  }).map(entry => entry.id));
  assert(blocks.some(entry => {
    if (entry.block.opcode !== 'control_if_else') return false;
    const condition = entry.block.inputs?.CONDITION;
    return Array.isArray(condition) && equalsWithPcReporter.has(condition[1]);
  }), `${label} dispatcher is not keyed by an encoded program-counter variable`);
}

function assertAntiCheat(project, label) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const watermarkEntries = Object.entries(stage.variables).filter(([, declaration]) => declaration?.[0] === WATERMARK);
  assert(watermarkEntries.length === 1, `${label} has an invalid anti-cheat watermark count`);
  const [watermarkId, watermarkDeclaration] = watermarkEntries[0];

  const stageBlocks = Object.entries(stage.blocks)
    .filter(([, block]) => isObjectBlock(block))
    .map(([id, block]) => ({id, block}));
  const hats = stageBlocks.filter(({block}) => block.topLevel && block.opcode === 'event_whenflagclicked');
  assert(hats.length === 1, `${label} must contain exactly one Stage watchdog hat`);
  const hat = hats[0];
  const forever = requireNextBlock(stage, hat, 'control_forever', label);
  const guard = requireInputBlock(stage, forever.block, 'SUBSTACK', 'control_if', label);
  const setter = requireInputBlock(stage, guard.block, 'SUBSTACK', 'data_setvariableto', label);
  const stopper = requireNextBlock(stage, setter, 'control_stop', label);
  assert(stopper.block.fields?.STOP_OPTION?.[0] === 'all', `${label} watchdog does not stop all threads`);

  const latchId = setter.block.fields?.VARIABLE?.[1];
  assert(typeof latchId === 'string', `${label} watchdog has no latch variable`);
  const latchDeclaration = stage.variables[latchId];
  assert(Array.isArray(latchDeclaration), `${label} latch declaration is missing`);
  const trippedValue = primitiveText(setter.block.inputs?.VALUE);
  assert(typeof trippedValue === 'string' && trippedValue !== latchDeclaration[1], `${label} latch trip value is invalid`);

  const conditionRoot = activeReference(guard.block.inputs?.CONDITION);
  assert(conditionRoot, `${label} watchdog has no condition root`);
  const protectedSentinels = inspectMismatchCondition(stage, conditionRoot, `${label} watchdog`);
  assert(protectedSentinels.size === 8, `${label} watchdog must protect the watermark, six decoys, and latch`);
  for (const [variableId, sentinel] of protectedSentinels) {
    const declaration = stage.variables[variableId];
    assert(Array.isArray(declaration), `${label} protected variable declaration is missing`);
    assert(sentinel.name === declaration[0], `${label} protected variable field name is stale`);
    assert(sentinel.expected === declaration[1], `${label} watchdog sentinel does not match its initial value`);
  }

  assert(protectedSentinels.has(watermarkId), `${label} watchdog does not protect its watermark`);
  assert(watermarkDeclaration && SENTINEL_TOKEN.test(String(watermarkDeclaration[1])), `${label} watermark sentinel is invalid`);
  const decoyIds = [...protectedSentinels.keys()].filter(id => id !== watermarkId && id !== latchId);
  assert(decoyIds.length === 6, `${label} must contain six protected decoy variables`);
  for (const id of decoyIds) {
    const declaration = stage.variables[id];
    assert(isOpaqueName(String(declaration?.[0])), `${label} decoy name is readable`);
    assert(SENTINEL_TOKEN.test(String(declaration?.[1])), `${label} decoy sentinel is invalid`);
  }
  assert(SENTINEL_TOKEN.test(String(latchDeclaration[1])) && SENTINEL_TOKEN.test(trippedValue), `${label} latch tokens are invalid`);

  const eventGuardSetters = assertEveryOriginalHatIsGuarded(
    project,
    hat,
    protectedSentinels,
    latchId,
    latchDeclaration,
    trippedValue,
    label
  );
  const allowedLatchSetters = new Set([setter.id, ...eventGuardSetters]);
  const latchMutators = objectBlocks(project).filter(({block}) => {
    const variableId = block.fields?.VARIABLE?.[1];
    return variableId === latchId && (block.opcode === 'data_setvariableto' || block.opcode === 'data_changevariableby');
  });
  assert(latchMutators.length === allowedLatchSetters.size &&
    latchMutators.every(mutator => allowedLatchSetters.has(mutator.id)), `${label} resets or otherwise mutates its latch`);
}

function assertEveryOriginalHatIsGuarded(
  project,
  watchdogHat,
  protectedSentinels,
  latchId,
  latchDeclaration,
  trippedValue,
  label
) {
  const guardedHats = objectBlocks(project).filter(entry =>
    entry.id !== watchdogHat.id && entry.block.topLevel && isExecutableHat(entry.block.opcode));
  assert(guardedHats.length === 1, `${label} release fixture has an unexpected guarded-hat count`);
  const setterIds = [];

  for (const hat of guardedHats) {
    const target = project.targets[hat.targetIndex];
    const callId = hat.block.next;
    const call = typeof callId === 'string' ? target.blocks[callId] : undefined;
    assert(isObjectBlock(call) && call.opcode === 'procedures_call', `${label} hat does not enter a session-lock call`);
    assert(call.parent === hat.id, `${label} session-lock call has a stale parent`);
    const proccode = call.mutation?.proccode;
    assert(typeof proccode === 'string' && call.mutation?.warp === 'true', `${label} session-lock call is not warp-guarded`);

    const definitions = Object.entries(target.blocks).filter(([, block]) => {
      if (!isObjectBlock(block) || block.opcode !== 'procedures_definition') return false;
      const prototypeId = activeReference(block.inputs?.custom_block);
      const prototype = prototypeId ? target.blocks[prototypeId] : undefined;
      return isObjectBlock(prototype) && prototype.opcode === 'procedures_prototype' &&
        prototype.mutation?.proccode === proccode && prototype.mutation?.warp === 'true';
    });
    assert(definitions.length === 1, `${label} session-lock procedure definition is missing or ambiguous`);
    const [definitionId, definition] = definitions[0];
    const guard = requireNextBlock(target, {id: definitionId, block: definition}, 'control_if', label);
    const conditionRoot = activeReference(guard.block.inputs?.CONDITION);
    assert(conditionRoot, `${label} session-lock procedure has no condition root`);
    const guardedSentinels = inspectMismatchCondition(target, conditionRoot, `${label} session-lock procedure`);
    assertSameSentinels(protectedSentinels, guardedSentinels, `${label} session-lock procedure`);
    const setter = requireInputBlock(target, guard.block, 'SUBSTACK', 'data_setvariableto', label);
    assert(setter.block.fields?.VARIABLE?.[1] === latchId, `${label} session-lock procedure latches the wrong variable`);
    assert(setter.block.fields?.VARIABLE?.[0] === latchDeclaration[0], `${label} session-lock latch name is stale`);
    assert(primitiveText(setter.block.inputs?.VALUE) === trippedValue, `${label} session-lock trip value is stale`);
    const stop = requireNextBlock(target, setter, 'control_stop', label);
    assert(stop.block.fields?.STOP_OPTION?.[0] === 'all', `${label} session-lock procedure does not stop all threads`);
    setterIds.push(setter.id);

    assert(typeof call.next === 'string', `${label} session-lock call lost the original continuation`);
    const continuation = target.blocks[call.next];
    assert(isObjectBlock(continuation) && continuation.parent === callId, `${label} session-lock continuation is disconnected`);
  }
  return setterIds;
}

function inspectMismatchCondition(target, rootId, label) {
  const reachable = collectInputReachable(target, rootId);
  const blocks = [...reachable].map(id => ({id, block: target.blocks[id]}))
    .filter(entry => isObjectBlock(entry.block));
  const reporters = blocks.filter(({block}) => block.opcode === 'data_variable');
  const equalsBlocks = blocks.filter(({block}) => block.opcode === 'operator_equals');
  const notBlocks = blocks.filter(({block}) => block.opcode === 'operator_not');
  const orBlocks = blocks.filter(({block}) => block.opcode === 'operator_or');
  assert(reporters.length > 0, `${label} has no protected reporters`);
  assert(equalsBlocks.length === reporters.length, `${label} comparison tree is incomplete`);
  assert(notBlocks.length === reporters.length, `${label} mismatch tree is incomplete`);
  assert(orBlocks.length === reporters.length - 1, `${label} OR tree is incomplete`);
  assert(blocks.length === reporters.length * 4 - 1, `${label} contains an unexpected condition opcode`);

  const sentinels = new Map();
  for (const reporter of reporters) {
    const variableId = reporter.block.fields?.VARIABLE?.[1];
    const variableName = reporter.block.fields?.VARIABLE?.[0];
    assert(typeof variableId === 'string' && typeof variableName === 'string' && !sentinels.has(variableId),
      `${label} has an invalid protected variable`);
    const equals = target.blocks[reporter.block.parent];
    assert(isObjectBlock(equals) && equals.opcode === 'operator_equals', `${label} protected reporter is not compared`);
    assert(Object.values(equals.inputs ?? {}).some(input => activeReference(input) === reporter.id),
      `${label} comparison does not reference its reporter`);
    const expectedValues = Object.values(equals.inputs ?? {}).map(primitiveText)
      .filter(value => typeof value === 'string');
    assert(expectedValues.length === 1, `${label} protected comparison has no unique sentinel value`);
    const not = target.blocks[equals.parent];
    assert(isObjectBlock(not) && not.opcode === 'operator_not' && activeReference(not.inputs?.OPERAND) === reporter.block.parent,
      `${label} sentinel comparison does not trip on mismatch`);
    sentinels.set(variableId, {name: variableName, expected: expectedValues[0]});
  }
  return sentinels;
}

function assertSameSentinels(expected, actual, label) {
  assert(actual.size === expected.size, `${label} does not protect the full sentinel set`);
  for (const [id, sentinel] of expected) {
    const candidate = actual.get(id);
    assert(candidate?.name === sentinel.name && candidate?.expected === sentinel.expected,
      `${label} has a missing or stale sentinel check`);
  }
}

function isExecutableHat(opcode) {
  return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
}

function assertWatermark(project, label) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const stageCount = Object.values(stage.variables).filter(declaration => declaration?.[0] === WATERMARK).length;
  const spriteCount = project.targets.filter(target => !target.isStage).flatMap(target => Object.values(target.variables))
    .filter(declaration => declaration?.[0] === WATERMARK).length;
  assert(stageCount === 1 && spriteCount === 0, `${label} must contain exactly one Stage watermark`);
}

function assertNoAntiCheat(project, label) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const watchdogHats = Object.values(stage.blocks).filter(block =>
    isObjectBlock(block) && block.topLevel && block.opcode === 'event_whenflagclicked');
  assert(watchdogHats.length === 0, `${label} enabled the anti-cheat watchdog without the flag`);
}

function requireNextBlock(target, entry, opcode, label) {
  const next = entry.block.next;
  const block = typeof next === 'string' ? target.blocks[next] : undefined;
  assert(isObjectBlock(block) && block.opcode === opcode, `${label} watchdog expected ${opcode} after ${entry.block.opcode}`);
  return {id: next, block};
}

function requireInputBlock(target, owner, inputName, opcode, label) {
  const id = activeReference(owner.inputs?.[inputName]);
  const block = id ? target.blocks[id] : undefined;
  assert(isObjectBlock(block) && block.opcode === opcode, `${label} watchdog expected ${opcode} in ${inputName}`);
  return {id, block};
}

function collectInputReachable(target, rootId) {
  const found = new Set();
  const visit = id => {
    if (found.has(id)) return;
    const block = target.blocks[id];
    assert(isObjectBlock(block), `watchdog condition references missing block ${JSON.stringify(id)}`);
    found.add(id);
    for (const input of Object.values(block.inputs ?? {})) {
      const child = activeReference(input);
      if (child) visit(child);
    }
  };
  visit(rootId);
  return found;
}

function collectReporterOpcodes(target, input) {
  const found = [];
  const visited = new Set();
  const visitInput = value => {
    const id = activeReference(value);
    if (!id || visited.has(id)) return;
    visited.add(id);
    const block = target.blocks[id];
    if (!isObjectBlock(block)) return;
    found.push(block.opcode);
    for (const child of Object.values(block.inputs ?? {})) visitInput(child);
  };
  visitInput(input);
  return found;
}

function evaluateNumericInput(target, input, visiting) {
  if (!Array.isArray(input)) return undefined;
  const active = input[1];
  if (Array.isArray(active) && active.length >= 2 && Number.isFinite(Number(active[1]))) return Number(active[1]);
  if (typeof active !== 'string' || visiting.has(active)) return undefined;
  const block = target.blocks[active];
  if (!isObjectBlock(block)) return undefined;
  visiting.add(active);
  try {
    if (block.opcode !== 'operator_add' && block.opcode !== 'operator_multiply') return undefined;
    const left = evaluateNumericInput(target, block.inputs?.NUM1, visiting);
    const right = evaluateNumericInput(target, block.inputs?.NUM2, visiting);
    if (left === undefined || right === undefined) return undefined;
    return block.opcode === 'operator_add' ? left + right : left * right;
  } finally {
    visiting.delete(active);
  }
}

function activeReference(input) {
  return Array.isArray(input) && typeof input[1] === 'string' ? input[1] : undefined;
}

function primitiveText(input) {
  const active = Array.isArray(input) ? input[1] : undefined;
  return Array.isArray(active) && active[0] === 10 && typeof active[1] === 'string' ? active[1] : undefined;
}

function findUniqueMarker(blocks, opcode, label) {
  const matches = blocks.filter(({block}) => block.opcode === opcode);
  assert(matches.length === 1, `${label}: expected one ${opcode} marker, found ${matches.length}`);
  return matches[0];
}

function objectBlocks(project) {
  return project.targets.flatMap((target, targetIndex) => Object.entries(target.blocks)
    .filter(([, block]) => isObjectBlock(block))
    .map(([id, block]) => ({targetIndex, id, block})));
}

function isObjectBlock(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.opcode === 'string';
}

function collectOriginalIds(project) {
  const ids = new Set();
  for (const target of project.targets) {
    for (const id of Object.keys(target.blocks)) ids.add(id);
    for (const id of Object.keys(target.variables)) ids.add(id);
    for (const id of Object.keys(target.lists)) ids.add(id);
    for (const id of Object.keys(target.broadcasts)) ids.add(id);
    for (const id of Object.keys(target.comments)) ids.add(id);
  }
  return ids;
}

function collectStrings(value, found = new Set()) {
  if (typeof value === 'string') {
    found.add(value);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    found.add(key);
    collectStrings(item, found);
  }
  return found;
}

function assertAssetsEqual(original, transformed, label) {
  const originalNames = Object.keys(original).filter(name => name !== 'project.json').sort();
  const transformedNames = Object.keys(transformed).filter(name => name !== 'project.json').sort();
  assert(JSON.stringify(transformedNames) === JSON.stringify(originalNames), `${label} changed asset entry names`);
  for (const name of originalNames) {
    assert(Buffer.from(transformed[name]).equals(Buffer.from(original[name])), `${label} changed asset bytes for ${JSON.stringify(name)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
