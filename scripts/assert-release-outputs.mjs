import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import {deriveModeSeed, loadArchiveBuffer} from '../dist/archive/index.js';
import {serializeProjectPayload} from '../dist/archive/writer.js';
import {
  getAntiCheatReleaseCheckpoint,
  obfuscateProject
} from '../dist/obfuscation/index.js';
import {isOfficialHatOpcode} from '../dist/obfuscation/analysis.js';
import {recoverAdversarialStructure} from './readability-metrics.mjs';

const WATERMARK = 'Obfuscated by PrioSDK Gen 4.';
const STAGE_MARKERS = ['stage-alpha-initial-v2', 'stage-beta-initial-v2'];
const SPRITE_MARKERS = ['sprite-alpha-initial-v2', 'sprite-beta-initial-v2'];
const OPAQUE_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ASCII_OPAQUE = new RegExp(`^x_[${OPAQUE_ALPHABET}](?:[${OPAQUE_ALPHABET}]{27}|[${OPAQUE_ALPHABET}]{35})$`, 'u');
const INVISIBLE_OPAQUE = /^\u2063[\u200b\u2060]{32,}$/u;
const PRIVATE_USE_OPAQUE = new RegExp(`^\\ue000[0-9a-z]+_x_[${OPAQUE_ALPHABET}]{18}$`, 'u');
const PRIVACY_OPAQUE = /^[dksmt]_[a-z]{24}$/u;
const SENTINEL_TOKEN = /^[!#$%*+\-./:;=?@^_~]{32}$/u;
const LIVE_SENSING_OPCODES = new Set(['sensing_answer', 'sensing_mousex', 'sensing_mousey', 'sensing_timer']);
const LIVE_CONDITION_OPCODES = new Set(['operator_contains', 'operator_equals', 'operator_gt', 'operator_lt']);

const [
  fixturePath,
  losslessPath,
  lossyPath,
  noPreservePath,
  losslessAntiPath,
  lossyAntiPath,
  noPreserveAntiPath,
  noPreserveAntiExtraPath,
  lossyAllowSizePath,
  noPreserveAllowSizePath,
  noPreserveAntiExtraAllowSizePath,
  lossyAntiAllowSizePath,
  noPreserveAntiAllowSizePath,
  losslessAntiSavePath,
  lossyAntiSavePath,
  noPreserveAntiSavePath,
  noPreserveAntiExtraAllowSizeAntiSavePath
] = process.argv.slice(2);
if (!fixturePath || !losslessPath || !lossyPath || !noPreservePath ||
    !losslessAntiPath || !lossyAntiPath || !noPreserveAntiPath || !noPreserveAntiExtraPath ||
    !lossyAllowSizePath || !noPreserveAllowSizePath || !noPreserveAntiExtraAllowSizePath ||
    !lossyAntiAllowSizePath || !noPreserveAntiAllowSizePath || !losslessAntiSavePath ||
    !lossyAntiSavePath || !noPreserveAntiSavePath || !noPreserveAntiExtraAllowSizeAntiSavePath) {
  throw new Error(
    'usage: assert-release-outputs.mjs <fixture.sb3> <lossless.sb3> <lossy.sb3> <no-preserve.sb3> ' +
    '<lossless-anticheat.sb3> <lossy-anticheat.sb3> <no-preserve-anticheat.sb3> ' +
    '<no-preserve-anticheat-extra.sb3> <lossy-allowsize.sb3> <no-preserve-allowsize.sb3> ' +
    '<no-preserve-anticheat-extra-allowsize.sb3> <lossy-anticheat-allowsize.sb3> ' +
    '<no-preserve-anticheat-allowsize.sb3> <lossless-antisave.sb3> <lossy-antisave.sb3> ' +
    '<no-preserve-antisave.sb3> <no-preserve-anticheat-extra-allowsize-antisave.sb3>'
  );
}

const fixtureBuffer = await readFile(fixturePath);
const fixture = await loadArchive(fixturePath, fixtureBuffer);
const strictFixture = await loadArchiveBuffer(fixtureBuffer);
const specifications = [
  {
    label: 'lossless + antisave',
    mode: 'lossless',
    antiCheat: false,
    antiSave: true,
    allowSize: false,
    path: losslessAntiSavePath
  },
  {
    label: 'lossy + antisave',
    mode: 'lossy',
    antiCheat: false,
    antiSave: true,
    allowSize: false,
    path: lossyAntiSavePath
  },
  {
    label: 'no-preserve + antisave',
    mode: 'no-preserve',
    antiCheat: false,
    antiSave: true,
    allowSize: false,
    path: noPreserveAntiSavePath
  },
  {label: 'lossless', mode: 'lossless', antiCheat: false, antiSave: false, allowSize: false, path: losslessPath},
  {label: 'lossy', mode: 'lossy', antiCheat: false, antiSave: false, allowSize: false, path: lossyPath},
  {label: 'no-preserve', mode: 'no-preserve', antiCheat: false, antiSave: false, allowSize: false, path: noPreservePath},
  {label: 'lossless + anti-cheat', mode: 'lossless', antiCheat: true, antiSave: false, allowSize: false, path: losslessAntiPath},
  {label: 'lossy + anti-cheat', mode: 'lossy', antiCheat: true, antiSave: false, allowSize: false, path: lossyAntiPath},
  {label: 'no-preserve + anti-cheat', mode: 'no-preserve', antiCheat: true, antiSave: false, allowSize: false, path: noPreserveAntiPath},
  {label: 'lossy + allow size', mode: 'lossy', antiCheat: false, antiSave: false, allowSize: true, path: lossyAllowSizePath},
  {
    label: 'no-preserve + allow size',
    mode: 'no-preserve',
    antiCheat: false,
    antiSave: false,
    allowSize: true,
    path: noPreserveAllowSizePath
  },
  {
    label: 'lossy + anti-cheat + allow size',
    mode: 'lossy',
    antiCheat: true,
    antiSave: false,
    allowSize: true,
    path: lossyAntiAllowSizePath
  },
  {
    label: 'no-preserve + anti-cheat + allow size',
    mode: 'no-preserve',
    antiCheat: true,
    antiSave: false,
    allowSize: true,
    path: noPreserveAntiAllowSizePath
  }
];
const outputs = await Promise.all(specifications.map(async specification => ({
  ...specification,
  archive: await loadArchive(specification.path)
})));
const extraArchive = await loadArchive(noPreserveAntiExtraPath);
const extraAllowSizeArchive = await loadArchive(noPreserveAntiExtraAllowSizePath);
const extraAllowSizeAntiSaveArchive = await loadArchive(noPreserveAntiExtraAllowSizeAntiSavePath);
const antiCheatCheckpoints = new Map();

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
  const {archive, label, mode, antiCheat, antiSave, allowSize} = output;
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
  assertVariablePacking(archive.project, mode, antiCheat, label);
  const antiSaveAudit = antiSave
    ? assertAntiSave(archive.project, label, antiCheat)
    : assertNoAntiSave(archive.project, label);
  if (antiSave && !antiCheat) {
    replayDeterministicOutput(strictFixture, archive, {mode, allowSize, extra: false, antiCheat: false, antiSave, label});
  }
  if (mode === 'lossy') assertLossyEventSurface(fixture.project, archive.project, antiCheat, label);
  if (mode === 'no-preserve') {
    assertNoPreserveVirtualization(archive.project, label, allowSize);
    assertNoPreserveCoherentSystems(archive.project, label, allowSize);
    if (!antiCheat) assertNoPreserveSiteCaps(archive.project, label, allowSize);
  }
  let antiCheatCheckpoint;
  if (antiCheat) {
    assertAntiCheat(archive.project, label);
    antiCheatCheckpoint = replayAntiCheatCheckpoint(strictFixture, archive, {
      mode,
      allowSize,
      extra: false,
      antiSave,
      label
    });
    antiCheatCheckpoints.set(label, antiCheatCheckpoint);
  } else {
    assertNoAntiCheat(archive.project, label);
  }
  assertGrowthCap(
    fixture.project,
    archive.project,
    mode,
    allowSize,
    label,
    antiCheatCheckpoint,
    antiSaveAudit
  );
  assertSerializedGrowth(
    fixture.project,
    archive.project,
    mode,
    allowSize,
    label,
    antiCheatCheckpoint
  );
}

const extraCheckpoint = replayAntiCheatCheckpoint(strictFixture, extraArchive, {
  mode: 'no-preserve',
  allowSize: false,
  extra: true,
  antiSave: false,
  label: 'no-preserve + anti-cheat + extra'
});
const extraAllowSizeCheckpoint = replayAntiCheatCheckpoint(strictFixture, extraAllowSizeArchive, {
  mode: 'no-preserve',
  allowSize: true,
  extra: true,
  antiSave: false,
  label: 'no-preserve + anti-cheat + extra + allow size'
});
const extraAllowSizeAntiSaveCheckpoint = replayAntiCheatCheckpoint(strictFixture, extraAllowSizeAntiSaveArchive, {
  mode: 'no-preserve',
  allowSize: true,
  extra: true,
  antiSave: true,
  label: 'no-preserve + anti-cheat + extra + allow size + antisave'
});
assertExtraPrivacy(fixture, extraArchive, originalIds, originalRenamableNames, false, extraCheckpoint);
assertExtraPrivacy(
  fixture,
  extraAllowSizeArchive,
  originalIds,
  originalRenamableNames,
  true,
  extraAllowSizeCheckpoint
);
assertExtraPrivacy(
  fixture,
  extraAllowSizeAntiSaveArchive,
  originalIds,
  originalRenamableNames,
  true,
  extraAllowSizeAntiSaveCheckpoint,
  true
);
assertExpandedPolicyEffective(
  outputs,
  antiCheatCheckpoints,
  extraCheckpoint,
  extraAllowSizeCheckpoint
);
await strictFixture.cleanup();

process.stdout.write('Release fixture assertions passed for all 16 mode, protection, privacy, and size-policy outputs.\n');

function assertExpandedPolicyEffective(outputs, antiCheatCheckpoints, extraCheckpoint, extraAllowSizeCheckpoint) {
  const byLabel = new Map(outputs.map(output => [output.label, output]));
  assertExpandedPair(
    requireOutput(byLabel, 'lossy'),
    requireOutput(byLabel, 'lossy + allow size')
  );
  assertExpandedPair(
    requireOutput(byLabel, 'no-preserve'),
    requireOutput(byLabel, 'no-preserve + allow size')
  );
  assertExpandedCheckpointPair(
    requireCheckpoint(antiCheatCheckpoints, 'lossy + anti-cheat'),
    requireCheckpoint(antiCheatCheckpoints, 'lossy + anti-cheat + allow size'),
    'lossy + anti-cheat'
  );
  assertExpandedCheckpointPair(
    requireCheckpoint(antiCheatCheckpoints, 'no-preserve + anti-cheat'),
    requireCheckpoint(antiCheatCheckpoints, 'no-preserve + anti-cheat + allow size'),
    'no-preserve + anti-cheat'
  );
  assertExpandedCheckpointPair(
    extraCheckpoint,
    extraAllowSizeCheckpoint,
    'no-preserve + anti-cheat + extra'
  );
}

function assertExpandedPair(compact, expanded) {
  const compactBlocks = countBlockEquivalents(compact.archive.project);
  const expandedBlocks = countBlockEquivalents(expanded.archive.project);
  assert(
    expandedBlocks > compactBlocks,
    `${expanded.label} did not increase the exercised block-equivalent allowance (${expandedBlocks} <= ${compactBlocks})`
  );
  assert(
    expanded.archive.projectBytes.byteLength > compact.archive.projectBytes.byteLength,
    `${expanded.label} did not increase the exercised serialized-size allowance`
  );
}

function assertExpandedCheckpointPair(compact, expanded, label) {
  assert(
    expanded.before.blockEquivalents > compact.before.blockEquivalents,
    `${label} + allow size did not increase the pre-anti-cheat block allowance`
  );
  assert(
    expanded.before.serializedUtf8Bytes > compact.before.serializedUtf8Bytes,
    `${label} + allow size did not increase the pre-anti-cheat serialized allowance`
  );
}

function requireOutput(outputs, label) {
  const output = outputs.get(label);
  assert(output !== undefined, `release output ${label} is missing`);
  return output;
}

function requireCheckpoint(checkpoints, label) {
  const checkpoint = checkpoints.get(label);
  assert(checkpoint !== undefined, `release checkpoint ${label} is missing`);
  return checkpoint;
}

async function loadArchive(path, providedBytes) {
  const archive = unzipSync(providedBytes ?? await readFile(path));
  const projectBytes = archive['project.json'];
  assert(projectBytes, `${path} has no project.json`);
  return {
    entries: archive,
    project: JSON.parse(Buffer.from(projectBytes).toString('utf8')),
    projectBytes
  };
}

function replayAntiCheatCheckpoint(fixtureArchive, suppliedArchive, options) {
  const replay = replayDeterministicOutput(fixtureArchive, suppliedArchive, {
    ...options,
    antiCheat: true
  });
  const checkpoint = getAntiCheatReleaseCheckpoint(replay);
  assert(checkpoint !== undefined, `${options.label} has no accepted anti-cheat checkpoint`);
  assert(
    checkpoint.after.serializedUtf8Bytes === suppliedArchive.projectBytes.byteLength,
    `${options.label} checkpoint has the wrong final serialized size`
  );
  assert(
    checkpoint.after.blockEquivalents === countBlockEquivalents(suppliedArchive.project),
    `${options.label} checkpoint has the wrong final block-equivalent count`
  );
  return checkpoint;
}

function replayDeterministicOutput(fixtureArchive, suppliedArchive, options) {
  const replay = obfuscateProject(
    fixtureArchive.project,
    options.mode,
    deriveModeSeed(fixtureArchive.seed, options.mode),
    {
      antiCheat: options.antiCheat,
      antiSave: options.antiSave,
      allowSize: options.allowSize,
      extra: options.extra
    }
  );
  const replayedBytes = serializeProjectPayload(replay.project);
  assert(
    Buffer.compare(Buffer.from(replayedBytes), Buffer.from(suppliedArchive.projectBytes)) === 0,
    `${options.label} does not match its deterministic in-memory replay`
  );
  return replay;
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
    'sprite_set_stage_beta',
    'sprite_set_local',
    'sprite_set_local_beta',
    'sprite_set_x',
    'sprite_set_y',
    'sprite_set_size',
    'sprite_set_volume',
    'dispatcher_separator',
    'dispatcher_change_x',
    'dispatcher_change_y',
    'dispatcher_change_size',
    'dispatcher_change_volume'
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

function assertVariablePacking(project, mode, antiCheat, label) {
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

  if (antiCheat) {
    assertMarkersProtectedOrPacked(stage, STAGE_MARKERS, `${label} Stage`);
    assertMarkersProtectedOrPacked(sprite, SPRITE_MARKERS, `${label} sprite`);
    return;
  }

  assertMarkersPackedInOneList(stage, STAGE_MARKERS, `${label} Stage`);
  assertMarkersPackedInOneList(sprite, SPRITE_MARKERS, `${label} sprite`);
}

function assertMarkersProtectedOrPacked(target, markers, label) {
  const variableValues = Object.values(target.variables).map(declaration => declaration?.[1]);
  const listValues = Object.values(target.lists).flatMap(declaration => (
    Array.isArray(declaration?.[1]) ? declaration[1] : []
  ));
  let packed = 0;
  for (const marker of markers) {
    const scalarCount = variableValues.filter(value => value === marker).length;
    const listCount = listValues.filter(value => value === marker).length;
    assert(scalarCount + listCount === 1, `${label} did not retain exactly one logical copy of ${marker}`);
    if (listCount === 1) packed += 1;
  }
  return packed;
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
    symbolNames.push(...Object.values(target.broadcasts).filter(name => typeof name === 'string'));
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

function assertLossyEventSurface(original, transformed, antiCheat, label) {
  const originalHats = objectBlocks(original).filter(entry => entry.block.topLevel && isExecutableHat(entry.block.opcode));
  const transformedHats = objectBlocks(transformed).filter(entry => entry.block.topLevel && isExecutableHat(entry.block.opcode));
  assert(originalHats.length === 1 && originalHats[0]?.block.opcode === 'event_whenflagclicked',
    `${label} fixture event surface is not the expected single green-flag hat`);
  assert(transformedHats.length === originalHats.length + (antiCheat ? 1 : 0),
    `${label} added a lossy event hat`);
  assert(transformedHats.every(entry => entry.block.opcode === 'event_whenflagclicked'),
    `${label} added a lossy event receiver`);
  assert(transformed.targets.every(target => Object.keys(target.broadcasts).length === 0),
    `${label} added a lossy broadcast declaration`);
  assert(!objectBlocks(transformed).some(entry =>
    entry.block.opcode === 'event_broadcast' || entry.block.opcode === 'event_broadcastandwait'),
  `${label} added a lossy broadcast command`);
}

function assertGrowthCap(original, transformed, mode, allowSize, label, antiCheatCheckpoint, antiSaveAudit) {
  const initial = mode === 'lossless'
    ? countBlockEquivalents(original)
    : countPreAggressiveEquivalents(original);
  const transformedCount = countBlockEquivalents(transformed);
  const instrumentedCount = antiCheatCheckpoint?.before.blockEquivalents ?? transformedCount;
  const aggressiveCount = instrumentedCount - (antiSaveAudit?.generatedBlockEquivalents ?? 0);
  assert(Number.isInteger(aggressiveCount) && aggressiveCount >= 0, `${label} has invalid pre-anti-cheat cap accounting`);
  const expandedGrowth = allowSize && mode !== 'lossless';
  if (antiCheatCheckpoint !== undefined) {
    const antiCheatGrowth = transformedCount - instrumentedCount;
    assert(antiCheatGrowth >= 0, `${label} has negative anti-cheat block-growth accounting`);
    const antiCheatCap = Math.max(4096, Math.min((aggressiveCount * 8) + 4096, 30_000));
    if (!expandedGrowth) {
      assert(
        antiCheatGrowth <= antiCheatCap,
        `${label} exceeded its compact anti-cheat block-growth cap (${antiCheatGrowth} > ${antiCheatCap})`
      );
    }
  }
  const cap = mode === 'lossless'
    ? initial
    : mode === 'lossy'
      ? Math.max(initial, Math.min(
          allowSize ? Math.max(initial * 4, initial + 256) : initial * 2,
          allowSize ? 50_000 : 30_000
        ))
      : Math.max(
          initial,
          Math.min(
            allowSize
              ? Math.max((initial * 25) + 512, initial + 2048)
              : (initial * 3) + 512,
            allowSize ? 100_000 : 30_000
          )
        );
  assert(aggressiveCount <= cap, `${label} exceeded its block-equivalent cap (${aggressiveCount} > ${cap})`);
}

function assertSerializedGrowth(original, transformed, mode, allowSize, label, antiCheatCheckpoint) {
  const initialBytes = serializeProjectPayload(original).byteLength;
  const transformedBytes = serializeProjectPayload(transformed).byteLength;
  const hardLimit = mode === 'no-preserve' ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
  assert(transformedBytes <= hardLimit, `${label} exceeded its transformed-JSON safety cap`);
  const expandedGrowth = allowSize && mode !== 'lossless';
  const preAntiBytes = antiCheatCheckpoint?.before.serializedUtf8Bytes ?? transformedBytes;
  if (antiCheatCheckpoint !== undefined) {
    const antiCheatByteGrowth = transformedBytes - preAntiBytes;
    assert(antiCheatByteGrowth >= 0, `${label} has invalid anti-cheat serialized-growth accounting`);
    if (!expandedGrowth) {
      assert(
        antiCheatByteGrowth <= 2 * 1024 * 1024,
        `${label} exceeded its compact anti-cheat serialized-growth cap ` +
          `(${antiCheatByteGrowth} > ${2 * 1024 * 1024})`
      );
    }
  }
  if (mode === 'lossless' || expandedGrowth) return;
  const compactLimit = mode === 'lossy'
    ? (initialBytes * 4) + (512 * 1024)
    : (initialBytes * 8) + (1024 * 1024);
  assert(
    preAntiBytes <= compactLimit,
    `${label} exceeded its compact serialized-growth cap ` +
      `(${preAntiBytes} > ${compactLimit})`
  );
}

function countPreAggressiveEquivalents(project) {
  let count = countBlockEquivalents(project);
  for (const target of project.targets) {
    const candidates = [];
    for (const block of Object.values(target.blocks)) {
      if (!isObjectBlock(block)) continue;
      for (const input of Object.values(block.inputs ?? {})) {
        const rootId = activeReference(input);
        if (!rootId || evaluateNumericInput(target, input, new Set()) === undefined) continue;
        candidates.push(collectInputReachable(target, rootId));
      }
    }
    candidates.sort((left, right) => right.size - left.size);
    const folded = new Set();
    for (const region of candidates) {
      if ([...region].some(id => folded.has(id))) continue;
      count -= equivalentGrowth(target, region) - 1;
      for (const id of region) folded.add(id);
    }
    for (const [blockId, block] of Object.entries(target.blocks)) {
      if (folded.has(blockId)) continue;
      if (!isObjectBlock(block)) continue;
      for (const input of Object.values(block.inputs ?? {})) {
        if (Array.isArray(input) && input[0] === 3 && Array.isArray(input[2])) count -= 1;
      }
    }
  }
  assert(Number.isInteger(count) && count >= 0, 'fixture has an invalid normalized block-equivalent count');
  return count;
}

function isOpaqueName(name) {
  return ASCII_OPAQUE.test(name)
    || INVISIBLE_OPAQUE.test(name)
    || PRIVATE_USE_OPAQUE.test(name)
    || PRIVACY_OPAQUE.test(name)
    || isAntiSaveCanaryText(name);
}

function assertExtraPrivacy(
  fixtureArchive,
  extraArchive,
  originalIds,
  originalRenamableNames,
  allowSize,
  antiCheatCheckpoint,
  antiSave = false
) {
  const label = antiSave
    ? 'no-preserve + anti-cheat + extra + allow size + antisave'
    : allowSize
      ? 'no-preserve + anti-cheat + extra + allow size'
    : 'no-preserve + anti-cheat + extra';
  const original = fixtureArchive.project;
  const transformed = extraArchive.project;
  assertAssetsEqual(fixtureArchive.entries, extraArchive.entries, label);
  assert(transformed.targets.length === original.targets.length, `${label} changed target count`);
  assert(JSON.stringify(transformed.extensions) === JSON.stringify(original.extensions), `${label} changed declared extensions`);
  assert(JSON.stringify(transformed.meta) === JSON.stringify({semver: original.meta?.semver}),
    `${label} did not reduce metadata to the preserved semver`);

  for (let targetIndex = 0; targetIndex < original.targets.length; targetIndex += 1) {
    const before = original.targets[targetIndex];
    const after = transformed.targets[targetIndex];
    assert(before && after, `${label} has a missing target`);
    assert(after.isStage === before.isStage, `${label} changed target order`);
    if (before.isStage) assert(after.name === 'Stage', `${label} changed the Stage identity`);
    else assert(PRIVACY_OPAQUE.test(after.name), `${label} retained a readable sprite name`);
    assert(after?.costumes.length === before?.costumes.length, `${label} changed costume count`);
    assert(after?.sounds.length === before?.sounds.length, `${label} changed sound count`);
    for (let index = 0; index < before.costumes.length; index += 1) {
      const beforeDescriptor = before.costumes[index];
      const afterDescriptor = after.costumes[index];
      assert(PRIVACY_OPAQUE.test(String(afterDescriptor?.name)), `${label} retained a readable costume/backdrop name`);
      assert(JSON.stringify(withoutDisplayName(afterDescriptor)) === JSON.stringify(withoutDisplayName(beforeDescriptor)),
        `${label} changed a costume descriptor beyond its display name`);
    }
    for (let index = 0; index < before.sounds.length; index += 1) {
      const beforeDescriptor = before.sounds[index];
      const afterDescriptor = after.sounds[index];
      assert(PRIVACY_OPAQUE.test(String(afterDescriptor?.name)), `${label} retained a readable sound name`);
      assert(JSON.stringify(withoutDisplayName(afterDescriptor)) === JSON.stringify(withoutDisplayName(beforeDescriptor)),
        `${label} changed a sound descriptor beyond its display name`);
    }
    for (const broadcastName of Object.values(after?.broadcasts ?? {})) {
      assert(PRIVACY_OPAQUE.test(String(broadcastName)), `${label} retained a readable broadcast name`);
    }
  }

  assert(transformed.monitors.length === original.monitors.length, `${label} changed monitor count`);
  for (const monitor of transformed.monitors) {
    assert(monitor.visible === false && monitor.x === 0 && monitor.y === 0,
      `${label} did not hide and canonicalize monitor presentation`);
  }

  const strings = collectStrings(transformed);
  for (const id of originalIds) assert(!strings.has(id), `${label} retained original identifier ${JSON.stringify(id)}`);
  for (const name of originalRenamableNames) {
    assert(!strings.has(name), `${label} retained renamable name ${JSON.stringify(name)}`);
  }
  for (const readableName of ['Visible Sprite', 'backdrop1', 'costume1']) {
    assert(!strings.has(readableName), `${label} retained privacy-sensitive name ${JSON.stringify(readableName)}`);
  }

  assertNoInactiveFallbacks(transformed, label);
  assertWatermark(transformed, label);
  assertOpaqueSymbolNames(transformed, label);
  assertStaticOptimization(transformed, 'no-preserve', label);
  assertVariablePacking(transformed, 'no-preserve', true, label);
  assertNoPreserveVirtualization(transformed, label, allowSize);
  assertNoPreserveCoherentSystems(transformed, label, allowSize);
  assertNoPreserveSiteCaps(transformed, label, allowSize);
  assertAntiCheat(transformed, label);
  const antiSaveAudit = antiSave
    ? assertAntiSave(transformed, label, true)
    : assertNoAntiSave(transformed, label);
  assertGrowthCap(original, transformed, 'no-preserve', allowSize, label, antiCheatCheckpoint, antiSaveAudit);
  assertSerializedGrowth(original, transformed, 'no-preserve', allowSize, label, antiCheatCheckpoint);
}

function withoutDisplayName(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) return descriptor;
  const copy = {...descriptor};
  delete copy.name;
  return copy;
}

function assertNoPreserveVirtualization(project, label, allowSize = false) {
  if (allowSize) {
    assertExpandedNoPreserveVirtualization(project, label);
    return;
  }
  const blocks = objectBlocks(project);
  const opcodes = blocks.map(entry => entry.block.opcode);
  assert(opcodes.includes('control_if_else'), `${label} has no dispatcher branch`);
  assert(opcodes.filter(opcode => opcode === 'procedures_definition').length > 1, `${label} has no generated handler procedures`);

  const markers = [
    findUniqueMarker(blocks, 'motion_changexby', label),
    findUniqueMarker(blocks, 'motion_changeyby', label),
    findUniqueMarker(blocks, 'looks_changesizeby', label),
    findUniqueMarker(blocks, 'sound_changevolumeby', label)
  ];
  for (let index = 0; index < markers.length - 1; index += 1) {
    const current = markers[index];
    const successor = markers[index + 1];
    assert(current.block.next !== successor.id, `${label} retained direct marker edge ${current.block.opcode} -> ${successor.block.opcode}`);
    assert(successor.block.parent !== current.id, `${label} retained direct marker parent ${current.block.opcode} -> ${successor.block.opcode}`);
  }

  const markerInputNames = ['DX', 'DY', 'CHANGE', 'VOLUME'];
  const expectedMarkerValues = [11, -7, 13, -9];
  const targetIndex = markers[0]?.targetIndex;
  assert(typeof targetIndex === 'number' && markers.every(marker => marker.targetIndex === targetIndex),
    `${label} compact dispatcher markers are split across targets`);
  const target = project.targets[targetIndex];
  assert(target !== undefined, `${label} compact dispatcher target is unavailable`);
  const branchIds = new Set();
  const suffixIds = new Set();
  const witnessVariableIds = new Set();
  const armedVariableIds = new Set();
  const routeVariableIds = new Set();
  const routeExpressionIds = new Set();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const inputName = markerInputNames[index];
    const input = marker.block.inputs?.[inputName];
    assert(evaluateNumericInput(target, input, new Set()) === expectedMarkerValues[index],
      `${label} ${marker.block.opcode} changed its compact marker operand`);
    assert(collectInlineVariableIds(target, input).length === 0,
      `${label} ${marker.block.opcode} retained the retired inline-register frame`);
    const inputRootId = activeReference(input);
    const inputRoot = inputRootId === undefined ? undefined : target.blocks[inputRootId];
    assert(isObjectBlock(inputRoot)
      && inputRoot.opcode === 'operator_multiply'
      && primitiveNumber(inputRoot.inputs?.NUM1) !== undefined
      && primitiveNumber(inputRoot.inputs?.NUM2) !== undefined,
    `${label} ${marker.block.opcode} no longer uses the current encoded numeric reporter`);

    const branch = typeof marker.block.parent === 'string' ? target.blocks[marker.block.parent] : undefined;
    assert(isObjectBlock(branch)
      && branch.opcode === 'control_if'
      && activeReference(branch.inputs?.SUBSTACK) === marker.id,
    `${label} ${marker.block.opcode} is not owned by a compact dispatcher branch`);
    assert(!branchIds.has(marker.block.parent), `${label} compact dispatcher branch owns multiple marker commands`);
    branchIds.add(marker.block.parent);
    const conditionId = activeReference(branch.inputs?.CONDITION);
    const condition = conditionId === undefined ? undefined : target.blocks[conditionId];
    assert(isObjectBlock(condition) && condition.opcode === 'operator_equals',
      `${label} compact dispatcher marker condition is malformed`);
    const routeVariableId = [
      inlineVariable(condition.inputs?.OPERAND1)?.id,
      inlineVariable(condition.inputs?.OPERAND2)?.id
    ].find(value => value !== undefined);
    const routeExpressionId = [
      activeReference(condition.inputs?.OPERAND1),
      activeReference(condition.inputs?.OPERAND2)
    ].find(value => value !== undefined);
    assert(typeof routeVariableId === 'string'
      && typeof routeExpressionId === 'string'
      && routeVariableId !== routeExpressionId,
    `${label} compact dispatcher marker condition is not dynamically keyed`);
    routeVariableIds.add(routeVariableId);
    routeExpressionIds.add(routeExpressionId);

    const witnessId = marker.block.next;
    const witness = typeof witnessId === 'string' ? target.blocks[witnessId] : undefined;
    assert(isObjectBlock(witness)
      && witness.opcode === 'data_setvariableto'
      && witness.parent === marker.id,
    `${label} ${marker.block.opcode} has no inline post-effect witness capture`);
    const armedId = witness.next;
    const armed = typeof armedId === 'string' ? target.blocks[armedId] : undefined;
    assert(isObjectBlock(armed)
      && armed.opcode === 'data_setvariableto'
      && armed.parent === witnessId
      && armed.next === null
      && inlineVariable(armed.inputs?.VALUE)?.id === routeVariableId,
    `${label} ${marker.block.opcode} has no armed-last leaf commit`);
    assert(!suffixIds.has(witnessId) && !suffixIds.has(armedId),
      `${label} compact dispatcher marker leaves share a mutable suffix`);
    suffixIds.add(witnessId);
    suffixIds.add(armedId);
    const witnessVariableId = witness.fields?.VARIABLE?.[1];
    const armedVariableId = armed.fields?.VARIABLE?.[1];
    assert(typeof witnessVariableId === 'string' && typeof armedVariableId === 'string',
      `${label} compact dispatcher leaf state is unavailable`);
    witnessVariableIds.add(witnessVariableId);
    armedVariableIds.add(armedVariableId);
  }
  assert(branchIds.size === markers.length && suffixIds.size === markers.length * 2,
    `${label} compact dispatcher marker ownership is incomplete`);
  assert(witnessVariableIds.size === 1 && armedVariableIds.size === 1,
    `${label} compact dispatcher leaves do not converge on one witness/latch pair`);
  assert(routeVariableIds.size === 1 && routeExpressionIds.size === markers.length,
    `${label} compact dispatcher does not use one live identity with distinct route expressions`);
  assertCompactPacketStore(target, markers.length, label);
}

function assertCompactPacketStore(target, routeCount, label) {
  const packedLists = Object.entries(target.lists).flatMap(([id, declaration]) => {
    const values = declaration?.[1];
    return Array.isArray(values)
      && values.length === 2 * (routeCount + 1)
      && values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      ? [{id, values}]
      : [];
  });
  assert(packedLists.length === 2, `${label} does not contain exactly two compact packet banks`);
  const packetIds = new Set(packedLists.map(record => record.id));
  const modulusCandidates = [251, 257, 263, 269].filter(modulus => {
    const decodeCount = Object.values(target.blocks).filter(block => (
      isObjectBlock(block)
      && block.opcode === 'operator_mod'
      && primitiveNumber(block.inputs?.NUM2) === modulus
    )).length;
    return decodeCount >= routeCount && packedLists.every(record => (
      record.values.every(value => value < modulus ** 4)
    ));
  });
  assert(modulusCandidates.length === 1, `${label} compact packet digit field is ambiguous`);
  for (const record of packedLists) {
    assert(listBlocks(target, 'data_itemoflist', record.id).length >= 3,
      `${label} compact packet bank ${record.id} is not actively decoded`);
    assert(listBlocks(target, 'data_lengthoflist', record.id).length >= 1,
      `${label} compact packet bank ${record.id} has no length guard`);
    assert([
      'data_replaceitemoflist',
      'data_addtolist',
      'data_deleteoflist',
      'data_deletealloflist',
      'data_insertatlist'
    ].every(opcode => listBlocks(target, opcode, record.id).length === 0),
    `${label} compact packet bank ${record.id} is mutable`);
  }
  const checksumSetters = Object.values(target.blocks).filter(block => {
    if (!isObjectBlock(block) || block.opcode !== 'data_setvariableto') return false;
    const expressionId = activeReference(block.inputs?.VALUE);
    if (expressionId === undefined) return false;
    const references = collectExpressionListIds(target, expressionId);
    return references.size === packetIds.size && [...packetIds].every(id => references.has(id));
  });
  assert(checksumSetters.length === 1, `${label} compact packet banks do not share one checksum fold`);
  const checksumId = activeReference(checksumSetters[0]?.inputs?.VALUE);
  const checksum = checksumId === undefined ? undefined : target.blocks[checksumId];
  assert(isObjectBlock(checksum)
    && checksum.opcode === 'operator_mod'
    && primitiveNumber(checksum.inputs?.NUM2) === 2_147_483_647,
  `${label} compact packet checksum does not use the full exact prime field`);
  const scanLoops = Object.values(target.blocks).filter(block => {
    if (!isObjectBlock(block) || block.opcode !== 'control_repeat') return false;
    const lengthId = activeReference(block.inputs?.TIMES);
    const length = lengthId === undefined ? undefined : target.blocks[lengthId];
    return isObjectBlock(length)
      && length.opcode === 'data_lengthoflist'
      && packetIds.has(length.fields?.LIST?.[1]);
  });
  assert(scanLoops.length === 1, `${label} compact packet dispatcher does not scan one complete bank`);
}

function assertExpandedNoPreserveVirtualization(project, label) {
  const markerOpcodes = [
    'motion_changexby',
    'motion_changeyby',
    'looks_changesizeby',
    'sound_changevolumeby'
  ];
  const expectedMarkerValues = [11, -7, 13, -9];
  const handlerCount = 4;
  const targetCandidates = project.targets.flatMap((target, targetIndex) => {
    const aliasesByCommand = markerOpcodes.map(opcode => Object.entries(target.blocks).flatMap(([id, block]) => (
      isObjectBlock(block) && block.opcode === opcode ? [{id, block}] : []
    )));
    return aliasesByCommand.every(aliases => aliases.length === handlerCount)
      ? [{target, targetIndex, aliasesByCommand}]
      : [];
  });
  assert(targetCandidates.length === 1, `${label} does not contain exactly one expanded universal dispatcher target`);
  const candidate = targetCandidates[0];
  assert(candidate !== undefined, `${label} expanded universal dispatcher target is unavailable`);
  const {target, aliasesByCommand} = candidate;
  const commandCount = aliasesByCommand.length;
  const aliasOwners = new Map();
  const suffixIds = new Set();
  const witnessVariableIds = new Set();
  const armedVariableIds = new Set();
  for (const [commandIndex, aliases] of aliasesByCommand.entries()) {
    for (const alias of aliases) {
      assert(!aliasOwners.has(alias.id), `${label} expanded command alias ${alias.id} is reused`);
      aliasOwners.set(alias.id, {commandIndex, alias});
      const inputName = ['DX', 'DY', 'CHANGE', 'VOLUME'][commandIndex];
      assert(evaluateNumericInput(target, alias.block.inputs?.[inputName], new Set()) === expectedMarkerValues[commandIndex],
        `${label} expanded command alias changed its marker operand`);
      const witnessId = alias.block.next;
      const witness = typeof witnessId === 'string' ? target.blocks[witnessId] : undefined;
      assert(isObjectBlock(witness)
        && witness.opcode === 'data_setvariableto'
        && witness.parent === alias.id,
      `${label} expanded command alias has no inline post-effect witness capture`);
      const armedId = witness.next;
      const armed = typeof armedId === 'string' ? target.blocks[armedId] : undefined;
      assert(isObjectBlock(armed)
        && armed.opcode === 'data_setvariableto'
        && armed.parent === witnessId
        && armed.next === null
        && primitiveNumber(armed.inputs?.VALUE) === 1,
      `${label} expanded command alias has no armed-last leaf commit`);
      assert(!suffixIds.has(witnessId) && !suffixIds.has(armedId),
        `${label} expanded command aliases share a post-effect suffix`);
      suffixIds.add(witnessId);
      suffixIds.add(armedId);
      const witnessVariableId = witness.fields?.VARIABLE?.[1];
      const armedVariableId = armed.fields?.VARIABLE?.[1];
      assert(typeof witnessVariableId === 'string' && typeof armedVariableId === 'string',
        `${label} expanded command alias state is unavailable`);
      witnessVariableIds.add(witnessVariableId);
      armedVariableIds.add(armedVariableId);
    }
  }
  assert(suffixIds.size === commandCount * handlerCount * 2,
    `${label} expanded command aliases do not have disjoint inline suffixes`);
  assert(witnessVariableIds.size === 1 && armedVariableIds.size === 1,
    `${label} expanded command aliases do not converge on one witness/latch pair`);
  assert([...aliasOwners.values()].every(({alias}) => {
    const suffix = typeof alias.block.next === 'string' ? target.blocks[alias.block.next] : undefined;
    return isObjectBlock(suffix) && suffix.opcode !== 'procedures_call';
  }), `${label} expanded command aliases retained shared logical suffix ownership`);

  const tables = findExpandedRuntimeTables(target, commandCount, handlerCount, label);

  const claimedAliases = new Set();
  const handlers = Object.entries(target.blocks).flatMap(([outerId, outer]) => {
    if (!isObjectBlock(outer) || outer.opcode !== 'control_if') return [];
    const firstInnerId = activeReference(outer.inputs?.SUBSTACK);
    const firstInner = firstInnerId === undefined ? undefined : target.blocks[firstInnerId];
    if (!isObjectBlock(firstInner) || firstInner.opcode !== 'control_if') return [];
    const firstAliasId = activeReference(firstInner.inputs?.SUBSTACK);
    if (firstAliasId === undefined || !aliasOwners.has(firstAliasId)) return [];

    const owned = [];
    let innerId = firstInnerId;
    let expectedParent = outerId;
    const visited = new Set();
    while (innerId !== null) {
      assert(!visited.has(innerId), `${label} expanded universal handler contains a branch cycle`);
      visited.add(innerId);
      const inner = target.blocks[innerId];
      assert(isObjectBlock(inner) && inner.opcode === 'control_if',
        `${label} expanded universal handler branch is malformed`);
      assert(inner.parent === expectedParent, `${label} expanded universal handler branch parent is malformed`);
      const aliasId = activeReference(inner.inputs?.SUBSTACK);
      const owner = aliasId === undefined ? undefined : aliasOwners.get(aliasId);
      assert(owner !== undefined, `${label} expanded universal handler owns an unexpected command`);
      assert(owner.alias.block.parent === innerId, `${label} expanded command alias parent is malformed`);
      assert(!claimedAliases.has(aliasId), `${label} expanded command alias is claimed more than once`);
      claimedAliases.add(aliasId);
      const conditionId = activeReference(inner.inputs?.CONDITION);
      const condition = conditionId === undefined ? undefined : target.blocks[conditionId];
      assert(isObjectBlock(condition) && condition.opcode === 'operator_equals',
        `${label} expanded command branch condition is malformed`);
      const comparedVariableId = [
        inlineVariable(condition.inputs?.OPERAND1)?.id,
        inlineVariable(condition.inputs?.OPERAND2)?.id
      ].find(value => value !== undefined);
      assert(typeof comparedVariableId === 'string',
        `${label} expanded command branch does not compare the live slot`);
      owned.push({
        commandIndex: owner.commandIndex,
        slot: equalityNumericLiteral(target, inner, label),
        comparedVariableId
      });
      expectedParent = innerId;
      innerId = inner.next;
    }

    const conditionId = activeReference(outer.inputs?.CONDITION);
    const condition = conditionId === undefined ? undefined : target.blocks[conditionId];
    assert(isObjectBlock(condition) && condition.opcode === 'operator_equals',
      `${label} expanded universal handler condition is malformed`);
    const comparedVariableId = [
      inlineVariable(condition.inputs?.OPERAND1)?.id,
      inlineVariable(condition.inputs?.OPERAND2)?.id
    ].find(value => value !== undefined);
    const handlerIndex = [
      primitiveNumber(condition.inputs?.OPERAND1),
      primitiveNumber(condition.inputs?.OPERAND2)
    ].find(value => value !== undefined);
    assert(typeof comparedVariableId === 'string'
      && Number.isInteger(handlerIndex)
      && handlerIndex >= 0
      && handlerIndex < handlerCount,
    `${label} expanded universal handler selector is malformed`);
    return [{id: outerId, block: outer, comparedVariableId, handlerIndex, owned}];
  });

  assert(handlers.length === handlerCount, `${label} does not contain exactly four universal handlers`);
  assert(claimedAliases.size === commandCount * handlerCount,
    `${label} universal handlers do not own every command alias`);
  const handlerById = new Map(handlers.map(handler => [handler.id, handler]));
  const firstHandlers = handlers.filter(handler => {
    return handler.block.parent === null || !handlerById.has(handler.block.parent);
  });
  assert(firstHandlers.length === 1, `${label} expanded handler scan entry is not unique`);
  const firstHandler = firstHandlers[0];
  assert(firstHandler !== undefined, `${label} expanded handler scan entry is unavailable`);
  const orderedHandlers = [firstHandler];
  while (orderedHandlers.length < handlerCount) {
    const current = orderedHandlers[orderedHandlers.length - 1];
    assert(current !== undefined && typeof current.block.next === 'string',
      `${label} expanded handler scan ended early`);
    const nextHandler = handlerById.get(current.block.next);
    assert(nextHandler !== undefined
      && nextHandler.block.parent === current.id
      && !orderedHandlers.some(handler => handler.id === nextHandler.id),
    `${label} expanded universal handler scan linkage is malformed`);
    orderedHandlers.push(nextHandler);
  }
  assert(new Set(orderedHandlers.map(handler => handler.id)).size === handlerCount,
    `${label} expanded universal handler scan repeats a handler`);
  assert(new Set(orderedHandlers.map(handler => handler.handlerIndex)).size === handlerCount
    && orderedHandlers.every(handler => Number.isInteger(handler.handlerIndex)),
  `${label} expanded universal handler domain is incomplete`);
  assert(new Set(orderedHandlers.map(handler => handler.comparedVariableId)).size === 1,
    `${label} expanded universal handlers do not share one live handler selector`);
  const handlerVariableId = orderedHandlers[0]?.comparedVariableId;
  assert(typeof handlerVariableId === 'string', `${label} expanded handler variable is unavailable`);

  const expectedSlots = Array.from({length: commandCount}, (_, index) => index);
  const liveSlots = new Set();
  const slotVariableIds = new Set();
  for (const handler of orderedHandlers) {
    assert(handler.owned.length === commandCount, `${label} expanded universal handler has incomplete command coverage`);
    assert(JSON.stringify(handler.owned.map(entry => entry.commandIndex).sort((left, right) => left - right))
      === JSON.stringify(expectedSlots), `${label} expanded universal handler has duplicate command ownership`);
    for (const owned of handler.owned) {
      assert(Number.isInteger(owned.slot) && owned.slot > 0 && owned.slot < 67_108_859,
        `${label} expanded command slot is outside the threaded field`);
      assert(!liveSlots.has(owned.slot), `${label} expanded command slots are not globally unique`);
      liveSlots.add(owned.slot);
      slotVariableIds.add(owned.comparedVariableId);
    }
  }
  assert(slotVariableIds.size === 1, `${label} expanded command branches do not share one live slot selector`);
  const slotVariableId = [...slotVariableIds][0];
  assert(typeof slotVariableId === 'string' && slotVariableId !== handlerVariableId,
    `${label} expanded handler and slot selectors are not separated`);
  const allSlots = numericEqualityLiteralsForVariable(target, slotVariableId);
  assert(allSlots.length === (commandCount + 1) * handlerCount
    && new Set(allSlots).size === allSlots.length
    && allSlots.every(value => Number.isInteger(value) && value > 0 && value < 67_108_859),
  `${label} expanded live/terminal slots are not globally unique nonzero field values`);
  const handlerLiterals = numericEqualityLiteralsForVariable(target, handlerVariableId);
  assert(handlerLiterals.length === handlerCount * 2
    && Array.from({length: handlerCount}, (_, value) => (
      handlerLiterals.filter(candidateValue => candidateValue === value).length === 2
    )).every(Boolean),
  `${label} expanded live/terminal handler domains are incomplete`);

  const armedVariableId = [...armedVariableIds][0];
  assert(typeof armedVariableId === 'string', `${label} expanded armed variable is unavailable`);
  assertExpandedRuntimeTableShape(target, tables, label, {
    aliasIds: new Set(aliasOwners.keys()),
    handlerVariableId,
    slotVariableId,
    slotLiterals: allSlots,
    armedVariableId,
    routeCount: commandCount,
    handlerCount
  });
  assertTwoWordThreadedEvaluator(project, label);
}

function assertTwoWordThreadedEvaluator(project, label) {
  const recovered = recoverAdversarialStructure(project);
  const dispatchers = recovered.dispatchers.filter(dispatcher => (
    dispatcher.threadedProgramSchema?.recordWordCount === 2
  ));
  assert(dispatchers.length === 1, `${label} evaluator did not recognize exactly one two-word threaded dispatcher`);
  const schema = dispatchers[0]?.threadedProgramSchema;
  assert(schema?.status === 'entry-rooted-complete'
    && schema.handlerCount === 4
    && schema.commandCount === 4
    && schema.stateCellCount === 7
    && schema.encryptedRecordCount === 64
    && schema.encryptedRecordWordCount === 128,
  `${label} evaluator recovered the wrong K=4 two-word program dimensions`);
  assert(schema.selectorRecordWordPresent === false
    && schema.markerRecordWordPresent === false
    && schema.directlyKnownPlaintextRecordWordCount === 0
    && schema.fullyKnownPlaintextWordCount === 0
    && schema.smallDomainPlaintextRailCount === 0
    && schema.knownPlaintextMarkerGrammarValidated === false
    && schema.knownPlaintextKeyRecoveryStatus === 'not-applicable-no-known-plaintext',
  `${label} evaluator found a retired selector/marker or known-plaintext record surface`);
  assert(schema.staticDirectTableRecoveryStatus === 'unresolved'
    && schema.staticAffineRecoveryStatus === 'unresolved'
    && schema.staticPolynomialRecoveryStatus === 'unresolved'
    && schema.randomAccessValidNonEntryRecordDecrypts === 0,
  `${label} evaluator recovered a direct shortcut or a non-entry record with entry-key reuse`);
  assert(schema.entryRootedRecoveryStatus === 'complete'
    && schema.entryRootedRecoveredTransitionEdges === 3
    && schema.entryRootedRouteCount === 4
    && schema.originalDirectChainAbsent === true
    && schema.terminalValidated === true,
  `${label} evaluator did not complete the expected entry-rooted execution boundary`);
}

function findExpandedRuntimeTables(target, commandCount, handlerCount, label) {
  const numericLists = Object.entries(target.lists).flatMap(([id, declaration]) => {
    const values = declaration?.[1];
    return Array.isArray(values) && values.every(value => typeof value === 'number' && Number.isSafeInteger(value))
      ? [{id, values}]
      : [];
  });
  const stateCandidates = numericLists.filter(record => (
    record.values.length === 7 && record.values.every(value => value === 0)
  ));
  const recordWordCount = commandCount * handlerCount * handlerCount * 2;
  const recordCandidates = numericLists.filter(record => (
    record.values.length === recordWordCount
    && record.values.every(value => value >= 67_108_859 && value < 67_108_859 ** 2)
  ));
  assert(stateCandidates.length === 1, `${label} does not contain exactly one seven-cell threaded state list`);
  assert(recordCandidates.length === 1, `${label} does not contain exactly one two-word threaded record store`);
  const state = stateCandidates[0];
  const records = recordCandidates[0];
  assert(state !== undefined && records !== undefined, `${label} expanded threaded tables are unavailable`);
  assert(new Set(records.values).size === records.values.length,
    `${label} expanded threaded record ciphertext tuples contain duplicate words`);
  assert(!numericLists.some(record => record.values.length === commandCount * handlerCount * handlerCount * 4),
    `${label} retained the four-word selector/marker record layout`);
  assert(!numericLists.some(record => record.values.length === 257),
    `${label} retained the retired 257-cell expanded program`);
  return {state, records};
}

function assertExpandedRuntimeTableShape(target, tables, label, topology) {
  const stateWrites = listBlocks(target, 'data_replaceitemoflist', tables.state.id);
  assert(stateWrites.length === 14, `${label} expanded state list does not have entry and commit writers`);
  const stateWriteIndices = stateWrites.map(write => primitiveNumber(write.inputs?.INDEX));
  assert(Array.from({length: 7}, (_, index) => (
    stateWriteIndices.filter(value => value === index + 1).length === 2
  )).every(Boolean), `${label} expanded state writers do not cover every cell exactly twice`);
  assert([
    'data_replaceitemoflist',
    'data_addtolist',
    'data_deleteoflist',
    'data_deletealloflist',
    'data_insertatlist'
  ].every(opcode => listBlocks(target, opcode, tables.records.id).length === 0),
  `${label} expanded encrypted record store is mutable`);
  for (const table of [tables.state, tables.records]) {
    assert(listBlocks(target, 'data_itemoflist', table.id).length > 0,
      `${label} expanded runtime table ${table.id} has no active item reads`);
    assert(listBlocks(target, 'data_lengthoflist', table.id).length > 0,
      `${label} expanded runtime table ${table.id} has no active length reads`);
  }
  const repeats = Object.entries(target.blocks).filter(([, block]) => (
    isObjectBlock(block) && block.opcode === 'control_repeat'
  ));
  const checksumLoops = repeats.filter(([, block]) => (
    primitiveNumber(block.inputs?.TIMES) === tables.records.values.length
  ));
  const scanLoops = repeats.filter(([, block]) => (
    primitiveNumber(block.inputs?.TIMES) === tables.records.values.length / 2
  ));
  const roundLoops = repeats.filter(([, block]) => primitiveNumber(block.inputs?.TIMES) === 8);
  assert(checksumLoops.length === 1 && scanLoops.length === 1 && roundLoops.length === 1,
    `${label} expanded checksum/record/Feistel loop dimensions are malformed`);
  assert(Object.values(target.blocks).filter(block => (
    isObjectBlock(block)
    && block.opcode === 'operator_divide'
    && primitiveNumber(block.inputs?.NUM2) === 67_108_859
  )).length === 3, `${label} expanded packed-rail decoder dimensions are malformed`);
  assert(Object.values(target.blocks).some(block => (
    isObjectBlock(block)
    && block.opcode === 'operator_mod'
    && primitiveNumber(block.inputs?.NUM2) === 67_108_859
  )), `${label} expanded field arithmetic does not reduce modulo 67,108,859`);

  const procedures = expandedProcedureTopology(target);
  const decrypt = procedures.filter(record => (
    record.callIds.length === 2 && record.repeatLiterals.includes(8)
  ));
  const dispatcher = procedures.filter(record => (
    record.callIds.length === topology.routeCount + 1
    && record.repeatLiterals.includes(tables.records.values.length / 2)
  ));
  assert(decrypt.length === 1, `${label} does not contain exactly one shared eight-round decrypt procedure`);
  assert(dispatcher.length === 1, `${label} does not contain exactly one threaded dispatcher procedure`);
  const decryptProcedure = decrypt[0];
  const dispatcherProcedure = dispatcher[0];
  assert(decryptProcedure !== undefined && dispatcherProcedure !== undefined,
    `${label} expanded procedure topology is unavailable`);
  assert([...dispatcherProcedure.reachableIds].filter(id => (
    target.blocks[id]?.opcode === 'sensing_timer'
  )).length === 1, `${label} expanded dispatcher does not cache exactly one timer reporter per invocation`);
  assert(decryptProcedure.warp && dispatcherProcedure.warp,
    `${label} expanded decrypt/dispatcher procedures are not warp procedures`);
  assert(topology.aliasIds.size === topology.routeCount * topology.handlerCount
    && [...topology.aliasIds].every(id => dispatcherProcedure.reachableIds.has(id)),
  `${label} expanded aliases are not owned by the threaded dispatcher procedure`);

  const scanLoop = scanLoops[0];
  assert(scanLoop !== undefined, `${label} expanded record scan loop is unavailable`);
  assertExpandedScanAndCommitTopology(
    target,
    scanLoop,
    tables,
    topology,
    decryptProcedure.code,
    label
  );
  assert(topology.slotLiterals.every(value => !tables.records.values.includes(value)),
    `${label} expanded record store exposes a visible selector/terminal slot word`);
}

function expandedProcedureTopology(target) {
  const callsByCode = new Map();
  for (const [id, block] of Object.entries(target.blocks)) {
    if (!isObjectBlock(block) || block.opcode !== 'procedures_call') continue;
    const code = block.mutation?.proccode;
    if (typeof code !== 'string') continue;
    const calls = callsByCode.get(code) ?? [];
    calls.push(id);
    callsByCode.set(code, calls);
  }
  return Object.entries(target.blocks).flatMap(([prototypeId, prototype]) => {
    if (!isObjectBlock(prototype) || prototype.opcode !== 'procedures_prototype') return [];
    const code = prototype.mutation?.proccode;
    const definitionId = prototype.parent;
    const definition = typeof definitionId === 'string' ? target.blocks[definitionId] : undefined;
    if (typeof code !== 'string'
      || !isObjectBlock(definition)
      || definition.opcode !== 'procedures_definition'
      || activeReference(definition.inputs?.custom_block) !== prototypeId) return [];
    const reachableIds = new Set();
    collectReferencedBlockIds(target, definitionId, reachableIds);
    const repeatLiterals = [...reachableIds].flatMap(id => {
      const block = target.blocks[id];
      const literal = isObjectBlock(block) && block.opcode === 'control_repeat'
        ? primitiveNumber(block.inputs?.TIMES)
        : undefined;
      return literal === undefined ? [] : [literal];
    });
    return [{
      code,
      warp: prototype.mutation?.warp === 'true',
      callIds: callsByCode.get(code) ?? [],
      reachableIds,
      repeatLiterals
    }];
  });
}

function assertExpandedScanAndCommitTopology(target, scanLoop, tables, topology, decryptCode, label) {
  const [scanLoopId, scanRepeat] = scanLoop;
  const scanRootId = activeReference(scanRepeat.inputs?.SUBSTACK);
  assert(typeof scanRootId === 'string', `${label} expanded record scan body is unavailable`);
  const scanIds = new Set();
  collectReferencedBlockIds(target, scanRootId, scanIds);
  const recordReads = [...scanIds].filter(id => {
    const block = target.blocks[id];
    return isObjectBlock(block)
      && block.opcode === 'data_itemoflist'
      && block.fields?.LIST?.[1] === tables.records.id;
  });
  assert(recordReads.length === 2, `${label} expanded scan does not read exactly two encrypted words per record`);
  const decryptCalls = [...scanIds].flatMap(id => {
    const block = target.blocks[id];
    return isObjectBlock(block)
      && block.opcode === 'procedures_call'
      && block.mutation?.proccode === decryptCode
      ? [{id, block}]
      : [];
  });
  assert(decryptCalls.length === 2, `${label} expanded scan does not decrypt exactly two word domains`);
  const wordDomainSetters = decryptCalls.map(call => {
    const setter = typeof call.block.parent === 'string' ? target.blocks[call.block.parent] : undefined;
    assert(isObjectBlock(setter) && setter.opcode === 'data_setvariableto',
      `${label} expanded decrypt call has no word-domain setter`);
    return setter;
  });
  assert(new Set(wordDomainSetters.map(setter => setter.fields?.VARIABLE?.[1])).size === 1
    && JSON.stringify(wordDomainSetters.map(setter => primitiveNumber(setter.inputs?.VALUE)).sort()) === '[1,2]',
  `${label} expanded decrypt calls do not use exactly word domains one and two`);
  assert([...scanIds].some(id => {
    const block = target.blocks[id];
    return isObjectBlock(block)
      && block.opcode === 'operator_multiply'
      && [primitiveNumber(block.inputs?.NUM1), primitiveNumber(block.inputs?.NUM2)].includes(2);
  }), `${label} expanded record index does not advance in two-word units`);

  const scanFailureId = scanRepeat.next;
  const scanFailure = typeof scanFailureId === 'string' ? target.blocks[scanFailureId] : undefined;
  assert(isObjectBlock(scanFailure) && scanFailure.opcode === 'control_if' && scanFailure.parent === scanLoopId,
    `${label} expanded exact-one scan gate is unavailable`);
  const notId = activeReference(scanFailure.inputs?.CONDITION);
  const not = notId === undefined ? undefined : target.blocks[notId];
  const equalsId = isObjectBlock(not) ? activeReference(not.inputs?.OPERAND) : undefined;
  const equals = equalsId === undefined ? undefined : target.blocks[equalsId];
  assert(isObjectBlock(not)
    && not.opcode === 'operator_not'
    && isObjectBlock(equals)
    && equals.opcode === 'operator_equals',
  `${label} expanded scan does not reject a non-one match count`);
  const matchVariableId = [
    inlineVariable(equals.inputs?.OPERAND1)?.id,
    inlineVariable(equals.inputs?.OPERAND2)?.id
  ].find(value => value !== undefined);
  const matchLiteral = [
    primitiveNumber(equals.inputs?.OPERAND1),
    primitiveNumber(equals.inputs?.OPERAND2)
  ].find(value => value !== undefined);
  assert(typeof matchVariableId === 'string' && matchLiteral === 1,
    `${label} expanded scan exact-one comparison is malformed`);
  const stopId = activeReference(scanFailure.inputs?.SUBSTACK);
  const stop = stopId === undefined ? undefined : target.blocks[stopId];
  assert(isObjectBlock(stop)
    && stop.opcode === 'control_stop'
    && stop.fields?.STOP_OPTION?.[0] === 'this script',
  `${label} expanded scan failure does not stop the dispatcher`);
  const matchIncrements = [...scanIds].flatMap(id => {
    const block = target.blocks[id];
    return isObjectBlock(block)
      && block.opcode === 'data_changevariableby'
      && block.fields?.VARIABLE?.[1] === matchVariableId
      && primitiveNumber(block.inputs?.VALUE) === 1
      ? [{id, block}]
      : [];
  });
  assert(matchIncrements.length === 1, `${label} expanded scan has an invalid authenticated-match counter`);
  const matchIncrement = matchIncrements[0];
  const matchBranch = matchIncrement === undefined || typeof matchIncrement.block.parent !== 'string'
    ? undefined
    : target.blocks[matchIncrement.block.parent];
  assert(isObjectBlock(matchBranch) && matchBranch.opcode === 'control_if',
    `${label} expanded authenticated record branch is unavailable`);
  const authenticationOpcodes = collectReporterOpcodes(target, matchBranch.inputs?.CONDITION);
  assert(authenticationOpcodes.filter(opcode => opcode === 'operator_equals').length === 2
    && authenticationOpcodes.filter(opcode => opcode === 'operator_gt').length === 2,
  `${label} expanded record match does not validate two key rails and two tag rails`);
  const selectedLeftId = matchIncrement?.block.next;
  const selectedLeft = typeof selectedLeftId === 'string' ? target.blocks[selectedLeftId] : undefined;
  const selectedRightId = isObjectBlock(selectedLeft) ? selectedLeft.next : undefined;
  const selectedRight = typeof selectedRightId === 'string' ? target.blocks[selectedRightId] : undefined;
  assert(isObjectBlock(selectedLeft)
    && selectedLeft.opcode === 'data_setvariableto'
    && isObjectBlock(selectedRight)
    && selectedRight.opcode === 'data_setvariableto'
    && selectedRight.next === null,
  `${label} expanded authenticated match does not capture exactly one next-key pair`);

  const commitBlocks = [];
  const visited = new Set();
  let commitId = scanFailure.next;
  while (typeof commitId === 'string' && !visited.has(commitId)) {
    visited.add(commitId);
    const block = target.blocks[commitId];
    assert(isObjectBlock(block), `${label} expanded post-scan commit references a missing block`);
    commitBlocks.push(block);
    commitId = block.next;
  }
  const expectedCommitOpcodes = [
    'data_setvariableto',
    'data_changevariableby',
    ...Array.from({length: 6}, () => 'data_setvariableto'),
    ...Array.from({length: 7}, () => 'data_replaceitemoflist'),
    ...Array.from({length: 3}, () => 'data_setvariableto')
  ];
  assert(JSON.stringify(commitBlocks.map(block => block.opcode)) === JSON.stringify(expectedCommitOpcodes),
    `${label} expanded post-scan commit ordering is malformed`);
  assert(primitiveNumber(commitBlocks[1]?.inputs?.VALUE) === 1,
    `${label} expanded post-scan commit does not advance the logical step once`);
  assert(commitBlocks[3]?.fields?.VARIABLE?.[1] === topology.handlerVariableId
    && commitBlocks[4]?.fields?.VARIABLE?.[1] === topology.slotVariableId,
  `${label} expanded post-scan commit does not install handler then derived slot`);
  const stateCommit = commitBlocks.slice(8, 15);
  assert(stateCommit.every(block => block.fields?.LIST?.[1] === tables.state.id)
    && JSON.stringify(stateCommit.map(block => primitiveNumber(block.inputs?.INDEX))) === '[1,2,3,4,5,6,7]',
  `${label} expanded post-scan state commit is incomplete or out of order`);
  const armedCommit = commitBlocks.at(-1);
  assert(armedCommit?.fields?.VARIABLE?.[1] === topology.armedVariableId
    && primitiveNumber(armedCommit.inputs?.VALUE) === 0
    && armedCommit.next === null,
  `${label} expanded post-scan commit does not leave armed=0 last`);
}

function numericEqualityLiteralsForVariable(target, variableId) {
  return Object.values(target.blocks).flatMap(block => {
    if (!isObjectBlock(block) || block.opcode !== 'operator_equals') return [];
    for (const [variableInput, literalInput] of [
      [block.inputs?.OPERAND1, block.inputs?.OPERAND2],
      [block.inputs?.OPERAND2, block.inputs?.OPERAND1]
    ]) {
      if (inlineVariable(variableInput)?.id !== variableId) continue;
      const literal = primitiveNumber(literalInput);
      if (literal !== undefined) return [literal];
    }
    return [];
  });
}

function listBlocks(target, opcode, listId) {
  return Object.values(target.blocks).filter(block => (
    isObjectBlock(block)
    && block.opcode === opcode
    && block.fields?.LIST?.[1] === listId
  ));
}

function collectExpressionListIds(target, rootId) {
  const listIds = new Set();
  const pending = [rootId];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const block = target.blocks[id];
    if (!isObjectBlock(block)) continue;
    if (block.opcode === 'data_itemoflist') {
      const listId = block.fields?.LIST?.[1];
      if (typeof listId === 'string') listIds.add(listId);
    }
    for (const input of Object.values(block.inputs ?? {})) {
      const childId = activeReference(input);
      if (childId !== undefined) pending.push(childId);
    }
  }
  return listIds;
}

function equalityNumericLiteral(target, branch, label) {
  const conditionId = activeReference(branch.inputs?.CONDITION);
  const condition = conditionId === undefined ? undefined : target.blocks[conditionId];
  assert(isObjectBlock(condition) && condition.opcode === 'operator_equals',
    `${label} expanded branch condition is not an equality`);
  const literals = [
    primitiveNumber(condition.inputs?.OPERAND1),
    primitiveNumber(condition.inputs?.OPERAND2)
  ].filter(value => value !== undefined);
  assert(literals.length === 1, `${label} expanded branch condition does not contain exactly one slot literal`);
  const literal = literals[0];
  assert(typeof literal === 'number', `${label} expanded branch slot literal is unavailable`);
  return literal;
}

function assertNoPreserveCoherentSystems(project, label, allowSize) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const channelIds = new Set(Object.keys(stage.broadcasts));
  if (channelIds.size === 0) {
    assert(allowSize && hasTwoWordExpandedRecordStore(project),
      `${label} omitted coherent broadcast systems without spending the explicit size waiver on K=4 records`);
    return;
  }

  const references = broadcastReferenceCounts(project);
  for (const id of channelIds) {
    assert((references.sent.get(id) ?? 0) > 0, `${label} generated broadcast ${id} has no sender`);
    assert((references.received.get(id) ?? 0) > 0, `${label} generated broadcast ${id} has no receiver`);
  }
  assert([...references.received.keys()].every(id => (references.sent.get(id) ?? 0) > 0),
    `${label} has an unpaired receiver hat`);

  const sponsorAudit = auditLiveSponsorGuards(project, label);
  assert(sponsorAudit.guards > 0, `${label} has no runtime-dependent sponsor guard`);
  assert(sponsorAudit.strongGuards === sponsorAudit.guards, `${label} has a statically decidable sponsor guard`);
  assert([...channelIds].every(id => sponsorAudit.sponsoredChannels.has(id)),
    `${label} has a broadcast channel without a runtime-dependent entry sender`);

  const coherentCodesByTarget = project.targets.map(target => coherentProcedureDefinitions(target));
  const receiverEntries = objectBlocks(project).filter(entry => entry.block.opcode === 'event_whenbroadcastreceived');
  assert(receiverEntries.length >= channelIds.size, `${label} has too few coherent receiver hats`);
  for (const receiver of receiverEntries) {
    const target = project.targets[receiver.targetIndex];
    const codes = linearProcedureCodes(target, receiver.id);
    assert(codes.some(code => coherentCodesByTarget[receiver.targetIndex].has(code)),
      `${label} receiver ${receiver.id} does not reach a coherent custom procedure`);
  }
  const coherentCodeCount = coherentCodesByTarget.reduce((count, codes) => count + codes.size, 0);
  assert(coherentCodeCount >= channelIds.size, `${label} has too few coherent custom procedures`);

  const opcodes = new Set(objectBlocks(project).map(entry => entry.block.opcode));
  for (const opcode of [
    'control_wait',
    'data_addtolist',
    'data_itemoflist',
    'data_lengthoflist',
    'data_variable',
    'event_broadcast',
    'event_whenbroadcastreceived',
    'operator_join',
    'operator_or',
    'procedures_call',
    'procedures_definition'
  ]) {
    assert(opcodes.has(opcode), `${label} coherent graph is missing ${opcode}`);
  }
}

function auditLiveSponsorGuards(project, label) {
  let guards = 0;
  let strongGuards = 0;
  const sponsoredChannels = new Set();
  for (const target of project.targets) {
    for (const [guardId, guard] of Object.entries(target.blocks)) {
      if (!isObjectBlock(guard) || guard.opcode !== 'control_if' || typeof guard.parent !== 'string') continue;
      const update = target.blocks[guard.parent];
      if (!isObjectBlock(update) || update.opcode !== 'data_changevariableby') continue;
      guards += 1;
      const conditionId = activeReference(guard.inputs?.CONDITION);
      const condition = conditionId ? target.blocks[conditionId] : undefined;
      const conditionIds = new Set();
      if (conditionId) collectReferencedBlockIds(target, conditionId, conditionIds);
      const sensing = [...conditionIds].filter(id => LIVE_SENSING_OPCODES.has(target.blocks[id]?.opcode));
      const stateId = update.fields?.VARIABLE?.[1];
      const readsUpdatedState = [...conditionIds].some(id => {
        const block = target.blocks[id];
        return isObjectBlock(block) && block.opcode === 'data_variable' && block.fields?.VARIABLE?.[1] === stateId;
      });
      if (isObjectBlock(condition) && LIVE_CONDITION_OPCODES.has(condition.opcode) && sensing.length === 1 && readsUpdatedState) {
        strongGuards += 1;
      }

      const visited = new Set();
      let chainId = activeReference(guard.inputs?.SUBSTACK);
      while (typeof chainId === 'string' && !visited.has(chainId)) {
        visited.add(chainId);
        const block = target.blocks[chainId];
        if (!isObjectBlock(block)) break;
        const broadcastId = broadcastCommandId(block);
        if (broadcastId) sponsoredChannels.add(broadcastId);
        chainId = block.next;
      }
      assert(guardId !== update.parent, `${label} has a cyclic sponsor guard`);
    }
  }
  return {guards, strongGuards, sponsoredChannels};
}

function coherentProcedureDefinitions(target) {
  const result = new Map();
  for (const [id, block] of Object.entries(target.blocks)) {
    if (!isObjectBlock(block) || block.opcode !== 'procedures_definition') continue;
    const prototypeId = activeReference(block.inputs?.custom_block);
    const prototype = prototypeId ? target.blocks[prototypeId] : undefined;
    const code = isObjectBlock(prototype) ? prototype.mutation?.proccode : undefined;
    if (typeof code !== 'string') continue;
    const ids = new Set();
    collectReferencedBlockIds(target, id, ids);
    const opcodes = new Set([...ids].map(blockId => target.blocks[blockId]?.opcode));
    if (['data_addtolist', 'data_itemoflist', 'operator_join', 'operator_or'].every(opcode => opcodes.has(opcode))) {
      result.set(code, id);
    }
  }
  return result;
}

function linearProcedureCodes(target, rootId) {
  const codes = [];
  const visited = new Set();
  let id = rootId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const block = target.blocks[id];
    if (!isObjectBlock(block)) break;
    const code = block.opcode === 'procedures_call' ? block.mutation?.proccode : undefined;
    if (typeof code === 'string') codes.push(code);
    id = block.next;
  }
  return codes;
}

function assertNoPreserveSiteCaps(project, label, allowSize = false) {
  const definitions = project.targets.map(target => coherentProcedureDefinitions(target));
  const receivers = project.targets.map(target => Object.entries(target.blocks)
    .filter(([, block]) => isObjectBlock(block) && block.opcode === 'event_whenbroadcastreceived')
    .map(([id, block]) => ({id, block})));
  const componentGrowths = [];
  const siteGrowths = [];

  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [guardId, guard] of Object.entries(target.blocks)) {
      if (!isObjectBlock(guard) || guard.opcode !== 'control_if' || typeof guard.parent !== 'string') continue;
      const update = target.blocks[guard.parent];
      if (!isObjectBlock(update) || update.opcode !== 'data_changevariableby') continue;
      const conditionId = activeReference(guard.inputs?.CONDITION);
      if (!conditionId) continue;
      const conditionIds = new Set();
      collectReferencedBlockIds(target, conditionId, conditionIds);
      if (![...conditionIds].some(id => LIVE_SENSING_OPCODES.has(target.blocks[id]?.opcode))) continue;

      const siteIds = new Set([guardId, guard.parent, ...conditionIds]);
      const parent = update.parent;
      const parentBlock = typeof parent === 'string' ? target.blocks[parent] : undefined;
      if (isObjectBlock(parentBlock) && parentBlock.topLevel && parentBlock.opcode === 'event_whenflagclicked') {
        siteIds.add(parent);
      }
      const visited = new Set();
      let chainId = activeReference(guard.inputs?.SUBSTACK);
      while (typeof chainId === 'string' && !visited.has(chainId)) {
        visited.add(chainId);
        const block = target.blocks[chainId];
        if (!isObjectBlock(block)) break;
        const broadcastId = broadcastCommandId(block);
        const component = broadcastId
          ? coherentComponentIds(target, chainId, broadcastId, receivers[targetIndex], definitions[targetIndex])
          : undefined;
        if (component) {
          for (const id of component) siteIds.add(id);
          componentGrowths.push(equivalentGrowth(target, component));
        } else {
          siteIds.add(chainId);
          collectInputReferencedBlockIds(target, block, siteIds);
        }
        chainId = block.next;
      }
      siteGrowths.push(equivalentGrowth(target, siteIds));
    }
  }
  if (componentGrowths.length === 0) {
    assert(allowSize && hasTwoWordExpandedRecordStore(project),
      `${label} has no attributable coherent components or expanded K=4 record site`);
    return;
  }
  const componentCap = allowSize ? 224 : 56;
  const siteCap = allowSize ? 2048 : 256;
  assert(componentGrowths.every(growth => growth <= componentCap), `${label} has an oversized coherent component`);
  assert(siteGrowths.every(growth => growth <= siteCap), `${label} exceeded a ${siteCap}-equivalent no-preserve site cap`);
}

function hasTwoWordExpandedRecordStore(project) {
  return project.targets.some(target => Object.values(target.lists).some(declaration => (
    Array.isArray(declaration?.[1])
    && declaration[1].length === 128
    && declaration[1].every(value => (
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 67_108_859
      && value < 67_108_859 ** 2
    ))
  )));
}

function coherentComponentIds(target, senderId, broadcastId, receivers, definitions) {
  const receiverCandidates = receivers.filter(entry => entry.block.fields?.BROADCAST_OPTION?.[1] === broadcastId);
  const entry = receiverCandidates.find(candidate => {
    const path = linearBlocks(target, candidate.id);
    return !path.some(({block}) => block.opcode === 'control_wait') &&
      path.some(({block}) => block.opcode === 'procedures_call' && definitions.has(block.mutation?.proccode));
  });
  if (!entry) return undefined;
  const entryPath = linearBlocks(target, entry.id);
  const code = entryPath.find(({block}) =>
    block.opcode === 'procedures_call' && definitions.has(block.mutation?.proccode))?.block.mutation?.proccode;
  const definitionId = typeof code === 'string' ? definitions.get(code) : undefined;
  const continuation = receivers.find(candidate => {
    const path = linearBlocks(target, candidate.id);
    return path.some(({block}) => block.opcode === 'control_wait') &&
      path.some(({block}) => block.opcode === 'procedures_call' && block.mutation?.proccode === code);
  });
  if (!definitionId || !continuation) return undefined;
  const ids = new Set([senderId]);
  collectReferencedBlockIds(target, entry.id, ids);
  collectReferencedBlockIds(target, definitionId, ids);
  collectReferencedBlockIds(target, continuation.id, ids);
  return ids;
}

function linearBlocks(target, rootId) {
  const result = [];
  const visited = new Set();
  let id = rootId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const block = target.blocks[id];
    if (!isObjectBlock(block)) break;
    result.push({id, block});
    id = block.next;
  }
  return result;
}

function assertAntiCheat(project, label) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const watermarkEntries = Object.entries(stage.variables).filter(([, declaration]) => declaration?.[0] === WATERMARK);
  assert(watermarkEntries.length === 1, `${label} has an invalid anti-cheat watermark count`);
  const [watermarkId] = watermarkEntries[0];

  const stageBlocks = Object.entries(stage.blocks)
    .filter(([, block]) => isObjectBlock(block))
    .map(([id, block]) => ({id, block}));
  const hats = stageBlocks.filter(entry => isWatchdogHat(stage, entry));
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
  assert(protectedSentinels.size === 9,
    `${label} watchdog must protect seven decoys, one gameplay-breach sentinel, and its latch`);
  for (const [variableId, sentinel] of protectedSentinels) {
    const declaration = stage.variables[variableId];
    assert(Array.isArray(declaration), `${label} protected variable declaration is missing`);
    assert(sentinel.name === declaration[0], `${label} protected variable field name is stale`);
    assert(sentinel.expected === declaration[1], `${label} watchdog sentinel does not match its initial value`);
  }

  assert(!protectedSentinels.has(watermarkId), `${label} watchdog improperly uses its watermark as a sentinel`);
  assert(countExactStringOccurrences(stage.blocks, watermarkId) === 0,
    `${label} anti-cheat block graph reads or mutates its watermark`);
  const candidateDecoyIds = [...protectedSentinels.keys()].filter(id => id !== latchId);
  const decoyIds = candidateDecoyIds.filter(id => !objectBlocks(project).some(({block}) => (
    block.opcode === 'data_setvariableto' && block.fields?.VARIABLE?.[1] === id
  )));
  assert(decoyIds.length === 7, `${label} must contain seven protected decoy variables`);
  for (const id of decoyIds) {
    const declaration = stage.variables[id];
    assert(isOpaqueName(String(declaration?.[0])), `${label} decoy name is readable`);
    assert(SENTINEL_TOKEN.test(String(declaration?.[1])), `${label} decoy sentinel is invalid`);
  }
  assert(SENTINEL_TOKEN.test(String(latchDeclaration[1])) && SENTINEL_TOKEN.test(trippedValue), `${label} latch tokens are invalid`);

  const eventGuards = assertEveryOriginalHatIsGuarded(
    project,
    hat,
    protectedSentinels,
    latchId,
    latchDeclaration,
    trippedValue,
    label
  );
  const allowedLatchSetters = new Set([setter.id, ...eventGuards.setterIds]);
  const latchMutators = objectBlocks(project).filter(({block}) => {
    const variableId = block.fields?.VARIABLE?.[1];
    return variableId === latchId && (block.opcode === 'data_setvariableto' || block.opcode === 'data_changevariableby');
  });
  assert(latchMutators.length === allowedLatchSetters.size &&
    latchMutators.every(mutator => allowedLatchSetters.has(mutator.id)), `${label} resets or otherwise mutates its latch`);

  const integrity = recoverAdversarialStructure(project).tamperIntegrityAnalysis;
  assert(integrity.status === 'analyzed', `${label} gameplay integrity structure was not analyzed`);
  assert(integrity.integrityPairCount === 4, `${label} has an unexpected protected gameplay-variable count`);
  assert(integrity.integrityGroupCount === 2 && integrity.completeIntegrityGroupCount === 2,
    `${label} does not retain both complete gameplay integrity groups`);
  assert(integrity.linkedIntegrityGroupCount === 2 && integrity.linkedIntegrityPairCount === 4,
    `${label} gameplay integrity groups are not cyclically linked`);
  assert(integrity.integrityLinkEdgeCount === 4 && integrity.coupledRefreshPathCount === 4,
    `${label} gameplay integrity coupling is incomplete`);
  assert(integrity.weakestComponentCut === 2 && integrity.weakestStructuralComponentCut === 2,
    `${label} gameplay integrity cut regressed below two components`);
  assert(integrity.singleComponentBypassCount === 0,
    `${label} gameplay integrity admits a single-component bypass`);
  return project.targets.reduce((growth, target) => growth + Object.entries(target.blocks)
    .filter(([id, block]) => id.startsWith('b_ac_') && isObjectBlock(block))
    .reduce((targetGrowth, [, block]) => targetGrowth + blockEquivalentContribution(block), 0), 0);
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
  assert(guardedHats.length > 0, `${label} release fixture has no guarded executable hats`);
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
    let guardParent = {id: definitionId, block: definition};
    const firstBodyId = definition.next;
    const firstBody = typeof firstBodyId === 'string' ? target.blocks[firstBodyId] : undefined;
    if (isObjectBlock(firstBody) && firstBody.opcode === 'procedures_call') {
      assert(firstBody.mutation?.warp === 'true', `${label} gameplay pre-guard is not warp-enabled`);
      guardParent = {id: firstBodyId, block: firstBody};
    }
    const guard = requireNextBlock(target, guardParent, 'control_if', label);
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
  return {
    setterIds,
    guardedHatCount: guardedHats.length,
    guardedTargetCount: new Set(guardedHats.map(hat => hat.targetIndex)).size
  };
}

function inspectMismatchCondition(target, rootId, label) {
  const reachable = collectInputReachable(target, rootId);
  const blocks = [...reachable].map(id => ({id, block: target.blocks[id]}))
    .filter(entry => isObjectBlock(entry.block));
  const equalsBlocks = blocks.filter(({block}) => {
    if (block.opcode !== 'operator_equals' || !inlineVariable(block.inputs?.OPERAND1)) return false;
    const expectedId = activeReference(block.inputs?.OPERAND2);
    const expected = expectedId ? target.blocks[expectedId] : undefined;
    return isObjectBlock(expected)
      && (expected.opcode === 'operator_join' || expected.opcode === 'operator_subtract');
  });
  assert(equalsBlocks.length > 0, `${label} has no protected comparisons`);

  const sentinels = new Map();
  for (const equals of equalsBlocks) {
    const reporter = inlineVariable(equals.block.inputs?.OPERAND1);
    const variableId = reporter?.id;
    const variableName = reporter?.name;
    assert(typeof variableId === 'string' && typeof variableName === 'string' && !sentinels.has(variableId),
      `${label} has an invalid protected variable`);
    const expectedValue = evaluateBlindedExpectation(target, equals.block.inputs?.OPERAND2, label);
    const not = target.blocks[equals.block.parent];
    assert(isObjectBlock(not) && not.opcode === 'operator_not' && activeReference(not.inputs?.OPERAND) === equals.id,
      `${label} sentinel comparison does not trip on mismatch`);
    sentinels.set(variableId, {name: variableName, expected: expectedValue});
  }
  return sentinels;
}

function inlineVariable(input) {
  const active = Array.isArray(input) ? input[1] : undefined;
  if (!Array.isArray(active) || active[0] !== 12) return undefined;
  return typeof active[1] === 'string' && typeof active[2] === 'string'
    ? {name: active[1], id: active[2]}
    : undefined;
}

function evaluateBlindedExpectation(target, input, label) {
  const id = activeReference(input);
  const block = id ? target.blocks[id] : undefined;
  assert(isObjectBlock(block), `${label} protected comparison has no encoded expectation`);
  if (block.opcode === 'operator_join') {
    const left = primitiveText(block.inputs?.STRING1);
    const right = primitiveText(block.inputs?.STRING2);
    assert(typeof left === 'string' && left.length > 0 && typeof right === 'string' && right.length > 0,
      `${label} string expectation is not split`);
    return left + right;
  }
  assert(block.opcode === 'operator_subtract', `${label} uses an unexpected expectation encoding`);
  const left = primitiveNumber(block.inputs?.NUM1);
  const right = primitiveNumber(block.inputs?.NUM2);
  assert(typeof left === 'number' && typeof right === 'number' && left === right,
    `${label} numeric expectation mask is invalid`);
  return left - right;
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
  return isOfficialHatOpcode(opcode);
}

function assertWatermark(project, label) {
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const stage = project.targets[stageIndex];
  assert(stageIndex >= 0 && stage, `${label} has no Stage`);
  const watermarkEntries = Object.entries(stage.variables).filter(([, declaration]) => declaration?.[0] === WATERMARK);
  assert(watermarkEntries.length === 1, `${label} must contain exactly one Stage watermark variable`);
  const watermarkEntry = watermarkEntries[0];
  assert(watermarkEntry !== undefined, `${label} Stage watermark variable is unavailable`);
  const [watermarkId, watermarkDeclaration] = watermarkEntry;
  const nameOccurrences = collectExactStringOccurrences(project, WATERMARK);
  assert(nameOccurrences.length === 1
    && nameOccurrences[0]?.kind === 'value'
    && nameOccurrences[0]?.owner === watermarkDeclaration
    && nameOccurrences[0]?.key === 0,
  `${label} must contain exactly one branded string, only as the Stage watermark variable name`);
  assert(countExactStringOccurrences(stage.blocks, watermarkId) === 0,
    `${label} executable Stage blocks reference the watermark variable`);
}

function assertAntiSave(project, label, antiCheat) {
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const stage = project.targets[stageIndex];
  assert(stageIndex >= 0 && stage, `${label} has no Stage`);

  const negativeZeroVariables = project.targets.flatMap((target, targetIndex) => Object.entries(target.variables)
    .filter(([, declaration]) => Object.is(declaration?.[1], -0))
    .map(([id, declaration]) => ({targetIndex, id, declaration})));
  assert(negativeZeroVariables.length === 1, `${label} must contain exactly one signed-negative-zero sentinel`);
  const sentinel = negativeZeroVariables[0];
  assert(sentinel.targetIndex === stageIndex && sentinel.id.startsWith('v_as_'),
    `${label} signed-zero sentinel is not the generated Stage sentinel`);
  const sentinelName = sentinel.declaration?.[0];
  assert(isAntiSaveCanaryText(sentinelName), `${label} signed-zero sentinel name is not a safe Unicode canary`);

  const markerLists = Object.entries(stage.lists).filter(([id, declaration]) => (
    id.startsWith('l_as_')
    && isAntiSaveCanaryText(declaration?.[0])
    && Array.isArray(declaration?.[1])
    && declaration[1].length === 1
    && isAntiSaveCanaryText(declaration[1][0])
  ));
  assert(markerLists.length === 1, `${label} must contain exactly one safe Unicode marker list`);

  const guardCodesByTarget = new Map();
  for (const [targetIndex, target] of project.targets.entries()) {
    const codes = signedZeroGuardProcedureCodes(target, sentinel.id, label);
    const runnableHats = Object.values(target.blocks).filter(block => (
      isObjectBlock(block) && block.topLevel && isExecutableHat(block.opcode)
    ));
    const requiresGuard = targetIndex === stageIndex || runnableHats.length > 0;
    assert(codes.length === (requiresGuard ? 1 : 0),
      `${label} target ${targetIndex} has an invalid signed-zero guard procedure count`);
    if (codes.length === 1) guardCodesByTarget.set(targetIndex, codes[0]);
  }

  const antiCheatWatchdogs = objectBlocks(project).filter(entry => (
    entry.block.topLevel && isWatchdogHat(project.targets[entry.targetIndex], entry)
  ));
  assert(antiCheatWatchdogs.length === (antiCheat ? 1 : 0),
    `${label} has an unexpected anti-cheat watchdog surface while auditing antisave`);
  const antiCheatWatchdogIds = new Set(antiCheatWatchdogs.map(entry => `${entry.targetIndex}:${entry.id}`));
  const guardedHats = objectBlocks(project).filter(entry => (
    entry.block.topLevel
    && isExecutableHat(entry.block.opcode)
    && !antiCheatWatchdogIds.has(`${entry.targetIndex}:${entry.id}`)
  ));
  assert(guardedHats.length > 0, `${label} has no runnable native hats protected by antisave`);

  for (const hat of guardedHats) {
    const target = project.targets[hat.targetIndex];
    const guardCode = guardCodesByTarget.get(hat.targetIndex);
    assert(typeof guardCode === 'string', `${label} native hat has no target-local signed-zero guard`);
    let parentId = hat.id;
    let callId = hat.block.next;
    if (antiCheat) {
      const outerCall = typeof callId === 'string' ? target.blocks[callId] : undefined;
      assert(isObjectBlock(outerCall) && outerCall.opcode === 'procedures_call',
        `${label} protected native hat has no outer anti-cheat guard call`);
      assert(outerCall.parent === parentId && typeof outerCall.next === 'string',
        `${label} outer anti-cheat guard call is disconnected`);
      parentId = callId;
      callId = outerCall.next;
    }
    const call = typeof callId === 'string' ? target.blocks[callId] : undefined;
    assert(isObjectBlock(call) && call.opcode === 'procedures_call' && call.mutation?.proccode === guardCode,
      `${label} native hat does not enter its signed-zero guard before its original successor`);
    assert(call.parent === parentId && call.mutation?.warp === 'true',
      `${label} native-hat signed-zero guard call is disconnected or non-warp`);
    if (typeof call.next === 'string') {
      const continuation = target.blocks[call.next];
      assert(isObjectBlock(continuation) && continuation.parent === callId,
        `${label} signed-zero guard lost its original continuation`);
    }
  }

  const generatedBlocks = objectBlocks(project).filter(entry => entry.id.startsWith('b_as_'));
  const generatedBlockEquivalents = generatedBlocks.reduce(
    (count, entry) => count + blockEquivalentContribution(entry.block),
    0
  );
  const expectedBlockEquivalents = (guardCodesByTarget.size * 10) + guardedHats.length;
  assert(generatedBlocks.length > 0 && generatedBlockEquivalents === expectedBlockEquivalents,
    `${label} antisave generated-block accounting is invalid ` +
      `(${generatedBlockEquivalents} !== ${expectedBlockEquivalents})`);
  return {generatedBlockEquivalents};
}

function signedZeroGuardProcedureCodes(target, sentinelId, label) {
  const codes = [];
  for (const [definitionId, definition] of Object.entries(target.blocks)) {
    if (!isObjectBlock(definition) || definition.opcode !== 'procedures_definition') continue;
    const prototypeId = activeReference(definition.inputs?.custom_block);
    const prototype = prototypeId ? target.blocks[prototypeId] : undefined;
    const guard = typeof definition.next === 'string' ? target.blocks[definition.next] : undefined;
    if (!isObjectBlock(prototype) || prototype.opcode !== 'procedures_prototype'
      || !isObjectBlock(guard) || guard.opcode !== 'control_if') continue;
    const notId = activeReference(guard.inputs?.CONDITION);
    const not = notId ? target.blocks[notId] : undefined;
    const lessThanId = isObjectBlock(not) ? activeReference(not.inputs?.OPERAND) : undefined;
    const lessThan = lessThanId ? target.blocks[lessThanId] : undefined;
    const divideId = isObjectBlock(lessThan) ? activeReference(lessThan.inputs?.OPERAND1) : undefined;
    const divide = divideId ? target.blocks[divideId] : undefined;
    const sentinelReporter = isObjectBlock(divide) ? inlineVariable(divide.inputs?.NUM2) : undefined;
    if (!isObjectBlock(not) || not.opcode !== 'operator_not'
      || !isObjectBlock(lessThan) || lessThan.opcode !== 'operator_lt'
      || !isObjectBlock(divide) || divide.opcode !== 'operator_divide'
      || sentinelReporter?.id !== sentinelId) continue;
    assert(primitiveNumber(divide.inputs?.NUM1) === 1 && primitiveNumber(lessThan.inputs?.OPERAND2) === 0,
      `${label} signed-zero guard arithmetic is invalid`);
    const stopId = activeReference(guard.inputs?.SUBSTACK);
    const stop = stopId ? target.blocks[stopId] : undefined;
    assert(isObjectBlock(stop) && stop.opcode === 'control_stop' && stop.fields?.STOP_OPTION?.[0] === 'all',
      `${label} signed-zero guard does not stop the project`);
    const code = prototype.mutation?.proccode;
    assert(typeof code === 'string' && isAntiSaveCanaryText(code) && prototype.mutation?.warp === 'true',
      `${label} signed-zero guard procedure name is not a safe Unicode canary`);
    assert(prototype.parent === definitionId, `${label} signed-zero guard prototype has a stale parent`);
    codes.push(code);
  }
  assert(new Set(codes).size === codes.length, `${label} has duplicate signed-zero guard procedure names`);
  return codes;
}

function assertNoAntiSave(project, label) {
  const generatedIds = project.targets.flatMap(target => [
    ...Object.keys(target.variables),
    ...Object.keys(target.lists),
    ...Object.keys(target.blocks)
  ]).filter(id => /^(?:[blv]_as_)/u.test(id));
  assert(generatedIds.length === 0, `${label} contains antisave-generated IDs without the flag`);
  const negativeZeroVariables = project.targets.flatMap(target => Object.values(target.variables))
    .filter(declaration => Object.is(declaration?.[1], -0));
  assert(negativeZeroVariables.length === 0, `${label} contains a signed-zero sentinel without the flag`);
  const canaryStrings = [...collectStrings(project)].filter(isAntiSaveCanaryText);
  assert(canaryStrings.length === 0, `${label} contains antisave Unicode canaries without the flag`);
  return undefined;
}

function isAntiSaveCanaryText(value) {
  if (typeof value !== 'string' || value.length < 20 || value !== value.normalize('NFC')) return false;
  if (!value.startsWith('\u2063\u200b\u2060')) return false;
  if (value.includes('\u0000')
    || /\uffff|\ufeff|\u200c|\u200d|[\r\n]|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  let privateUseCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xe000 && code <= 0xf8ff) {
      privateUseCharacters += 1;
      continue;
    }
    if (code === 0x200b || code === 0x2060 || code === 0x2063 || (code >= 0xfe00 && code <= 0xfe02)) continue;
    return false;
  }
  return privateUseCharacters >= 2;
}

function assertNoAntiCheat(project, label) {
  const stage = project.targets.find(target => target.isStage);
  assert(stage, `${label} has no Stage`);
  const watchdogHats = Object.entries(stage.blocks)
    .filter(([, block]) => isObjectBlock(block))
    .map(([id, block]) => ({id, block}))
    .filter(entry => isWatchdogHat(stage, entry));
  assert(watchdogHats.length === 0, `${label} enabled the anti-cheat watchdog without the flag`);
}

function isWatchdogHat(target, entry) {
  const hat = entry.block;
  if (!hat.topLevel || hat.opcode !== 'event_whenflagclicked' || typeof hat.next !== 'string') return false;
  const forever = target.blocks[hat.next];
  if (!isObjectBlock(forever) || forever.opcode !== 'control_forever') return false;
  const guardId = activeReference(forever.inputs?.SUBSTACK);
  const guard = guardId ? target.blocks[guardId] : undefined;
  if (!isObjectBlock(guard) || guard.opcode !== 'control_if') return false;
  const setterId = activeReference(guard.inputs?.SUBSTACK);
  const setter = setterId ? target.blocks[setterId] : undefined;
  const stop = isObjectBlock(setter) && typeof setter.next === 'string' ? target.blocks[setter.next] : undefined;
  return isObjectBlock(setter) && setter.opcode === 'data_setvariableto' &&
    isObjectBlock(stop) && stop.opcode === 'control_stop' && stop.fields?.STOP_OPTION?.[0] === 'all';
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

function collectInlineVariableIds(target, input) {
  const found = [];
  const visited = new Set();
  const visitInput = value => {
    if (!Array.isArray(value)) return;
    const active = value[1];
    if (Array.isArray(active)) {
      if (active[0] === 12 && typeof active[2] === 'string' && !found.includes(active[2])) found.push(active[2]);
      return;
    }
    if (typeof active !== 'string' || visited.has(active)) return;
    visited.add(active);
    const block = target.blocks[active];
    if (!isObjectBlock(block)) return;
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

function primitiveNumber(input) {
  const active = Array.isArray(input) ? input[1] : undefined;
  if (!Array.isArray(active) || active[0] !== 4) return undefined;
  const value = Number(active[1]);
  return Number.isFinite(value) ? value : undefined;
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

function collectExactStringOccurrences(value, expected, found = [], owner, key) {
  if (typeof value === 'string') {
    if (value === expected) found.push({kind: 'value', owner, key});
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectExactStringOccurrences(item, expected, found, value, index);
    }
    return found;
  }
  for (const [property, item] of Object.entries(value)) {
    if (property === expected) found.push({kind: 'key', owner: value, key: property});
    collectExactStringOccurrences(item, expected, found, value, property);
  }
  return found;
}

function countExactStringOccurrences(value, expected) {
  return collectExactStringOccurrences(value, expected).length;
}

function broadcastReferenceCounts(project) {
  const sent = new Map();
  const received = new Map();
  for (const {block} of objectBlocks(project)) {
    const sentId = broadcastCommandId(block);
    if (sentId) sent.set(sentId, (sent.get(sentId) ?? 0) + 1);
    if (block.opcode === 'event_whenbroadcastreceived') {
      const receivedId = block.fields?.BROADCAST_OPTION?.[1];
      if (typeof receivedId === 'string') received.set(receivedId, (received.get(receivedId) ?? 0) + 1);
    }
  }
  return {sent, received};
}

function broadcastCommandId(block) {
  if (block.opcode !== 'event_broadcast' && block.opcode !== 'event_broadcastandwait') return undefined;
  const primitive = block.inputs?.BROADCAST_INPUT?.[1];
  return Array.isArray(primitive) && typeof primitive[2] === 'string' ? primitive[2] : undefined;
}

function collectReferencedBlockIds(target, rootId, found) {
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (typeof id !== 'string' || found.has(id)) continue;
    const block = target.blocks[id];
    if (!isObjectBlock(block)) continue;
    found.add(id);
    if (typeof block.next === 'string') queue.push(block.next);
    for (const input of Object.values(block.inputs ?? {})) {
      if (!Array.isArray(input)) continue;
      for (let index = 1; index < input.length; index += 1) {
        if (typeof input[index] === 'string') queue.push(input[index]);
      }
    }
  }
}

function collectInputReferencedBlockIds(target, root, found) {
  const queue = [root];
  const visited = new Set();
  while (queue.length > 0) {
    const block = queue.pop();
    if (!isObjectBlock(block) || visited.has(block)) continue;
    visited.add(block);
    for (const input of Object.values(block.inputs ?? {})) {
      if (!Array.isArray(input)) continue;
      for (let index = 1; index < input.length; index += 1) {
        const id = input[index];
        const child = typeof id === 'string' ? target.blocks[id] : undefined;
        if (typeof id === 'string' && isObjectBlock(child)) {
          found.add(id);
          queue.push(child);
        }
      }
    }
  }
}

function equivalentGrowth(target, ids) {
  let growth = 0;
  for (const id of ids) {
    const block = target.blocks[id];
    if (!isObjectBlock(block)) continue;
    growth += blockEquivalentContribution(block);
  }
  return growth;
}

function blockEquivalentContribution(block) {
  let growth = 1;
  for (const input of Object.values(block.inputs ?? {})) {
    if (Array.isArray(input?.[1])) growth += 1;
    if (Array.isArray(input?.[2])) growth += 1;
  }
  return growth;
}

function countBlockEquivalents(project) {
  let count = 0;
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      count += 1;
      if (isObjectBlock(block)) count += blockEquivalentContribution(block) - 1;
    }
  }
  return count;
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
