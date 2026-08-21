import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';

const [fixturePath, losslessPath, lossyPath, noPreservePath] = process.argv.slice(2);
if (!fixturePath || !losslessPath || !lossyPath || !noPreservePath) {
  throw new Error('usage: assert-release-outputs.mjs <fixture.sb3> <lossless.sb3> <lossy.sb3> <no-preserve.sb3>');
}

const fixture = await loadArchive(fixturePath);
const outputs = await Promise.all([
  loadArchive(losslessPath),
  loadArchive(lossyPath),
  loadArchive(noPreservePath)
]);
assertFixtureContract(fixture.project);

const originalIds = collectOriginalIds(fixture.project);
const originalRenamableNames = new Set([
  'Readable score',
  'Readable list',
  'Readable sprite value',
  'record completion'
]);
for (const [index, output] of outputs.entries()) {
  assertAssetsEqual(fixture.entries, output.entries);
  assertOutputContract(fixture.project, output.project, index + 1);
  const strings = collectStrings(output.project);
  for (const id of originalIds) assert(!strings.has(id), `output ${index + 1} retained original identifier ${JSON.stringify(id)}`);
  for (const name of originalRenamableNames) assert(!strings.has(name), `output ${index + 1} retained renamable name ${JSON.stringify(name)}`);
}

assertNoPreserveVirtualization(outputs[2].project);
process.stdout.write('Release fixture assertions passed for all three modes.\n');

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
  assert(project.targets[0]?.isStage === true && project.targets[1]?.isStage === false, 'fixture target order is invalid');
  assert(Array.isArray(project.monitors) && project.monitors.some(monitor => monitor.opcode === 'data_variable'), 'fixture monitor is missing');
  assert(Array.isArray(project.extensions) && project.extensions.includes('pen'), 'fixture declared extension is missing');
  const blocks = project.targets.flatMap(target => Object.values(target.blocks));
  assert(blocks.some(block => block?.opcode === 'procedures_definition'), 'fixture procedure definition is missing');
  assert(blocks.some(block => block?.opcode === 'procedures_call'), 'fixture procedure call is missing');
  assert(blocks.some(block => block?.opcode === 'pen_clear'), 'fixture official extension payload is missing');

  const spriteBlocks = project.targets[1].blocks;
  const directIds = ['sprite_set_x', 'sprite_set_y', 'sprite_set_size', 'sprite_set_volume'];
  for (let index = 0; index < directIds.length - 1; index += 1) {
    assert(spriteBlocks[directIds[index]]?.next === directIds[index + 1], 'fixture virtualization marker chain is incomplete');
  }
}

function assertNoPreserveVirtualization(project) {
  const blocks = project.targets.flatMap(target => Object.entries(target.blocks).map(([id, block]) => ({id, block})));
  const objectBlocks = blocks.filter(entry => entry.block && !Array.isArray(entry.block) && typeof entry.block.opcode === 'string');
  const opcodes = objectBlocks.map(entry => entry.block.opcode);
  assert(opcodes.includes('control_if_else'), 'no-preserve output has no dispatcher branch');
  assert(opcodes.filter(opcode => opcode === 'procedures_definition').length > 1, 'no-preserve output has no generated handler procedures');

  const markers = [
    findUniqueMarker(objectBlocks, 'motion_setx'),
    findUniqueMarker(objectBlocks, 'motion_sety'),
    findUniqueMarker(objectBlocks, 'looks_setsizeto'),
    findUniqueMarker(objectBlocks, 'sound_setvolumeto')
  ];
  for (let index = 0; index < markers.length - 1; index += 1) {
    const current = markers[index];
    const successor = markers[index + 1];
    assert(current.block.next !== successor.id, `no-preserve retained direct marker edge ${current.block.opcode} -> ${successor.block.opcode}`);
    assert(successor.block.parent !== current.id, `no-preserve retained direct marker parent ${current.block.opcode} -> ${successor.block.opcode}`);
  }

  const variableReporters = new Set(objectBlocks.filter(entry => entry.block.opcode === 'data_variable').map(entry => entry.id));
  const equalsWithPcReporter = new Set(objectBlocks.filter(entry => {
    if (entry.block.opcode !== 'operator_equals') return false;
    return Object.values(entry.block.inputs ?? {}).some(input => Array.isArray(input) && variableReporters.has(input[1]));
  }).map(entry => entry.id));
  assert(objectBlocks.some(entry => {
    if (entry.block.opcode !== 'control_if_else') return false;
    const condition = entry.block.inputs?.CONDITION;
    return Array.isArray(condition) && equalsWithPcReporter.has(condition[1]);
  }), 'no-preserve dispatcher is not keyed by an encoded program-counter variable');
}

function assertOutputContract(original, transformed, outputNumber) {
  assert(transformed.targets.length === original.targets.length, `output ${outputNumber} changed target count`);
  assert(JSON.stringify(transformed.extensions) === JSON.stringify(original.extensions), `output ${outputNumber} changed declared extensions`);
  for (let index = 0; index < original.targets.length; index += 1) {
    const before = original.targets[index];
    const after = transformed.targets[index];
    assert(after?.isStage === before?.isStage, `output ${outputNumber} changed target order`);
    assert(JSON.stringify(after?.costumes) === JSON.stringify(before?.costumes), `output ${outputNumber} changed costume descriptors`);
    assert(JSON.stringify(after?.sounds) === JSON.stringify(before?.sounds), `output ${outputNumber} changed sound descriptors`);
  }

  const blocks = transformed.targets.flatMap(target => Object.values(target.blocks));
  const penBlocks = blocks.filter(block => block?.opcode === 'pen_clear');
  assert(penBlocks.length === 1, `output ${outputNumber} did not preserve the official extension block`);
  assert(JSON.stringify(penBlocks[0].inputs) === '{}', `output ${outputNumber} changed extension inputs`);
  assert(JSON.stringify(penBlocks[0].fields) === '{}', `output ${outputNumber} changed extension fields`);
  assert(blocks.some(block => block?.opcode === 'procedures_definition'), `output ${outputNumber} lost procedure definitions`);
  assert(blocks.some(block => block?.opcode === 'procedures_call'), `output ${outputNumber} lost procedure calls`);

  assert(transformed.monitors.length === original.monitors.length, `output ${outputNumber} changed monitor count`);
  const preservedMonitorKeys = [
    'mode', 'opcode', 'spriteName', 'value', 'width', 'height', 'x', 'y', 'visible', 'sliderMin', 'sliderMax', 'isDiscrete'
  ];
  for (const key of preservedMonitorKeys) {
    assert(
      JSON.stringify(transformed.monitors[0]?.[key]) === JSON.stringify(original.monitors[0]?.[key]),
      `output ${outputNumber} changed monitor ${key}`
    );
  }
}

function findUniqueMarker(blocks, opcode) {
  const matches = blocks.filter(({block}) => block.opcode === opcode);
  assert(matches.length === 1, `expected one ${opcode} marker, found ${matches.length}`);
  return matches[0];
}

function collectOriginalIds(project) {
  const ids = new Set();
  for (const target of project.targets) {
    for (const id of Object.keys(target.blocks)) ids.add(id);
    for (const id of Object.keys(target.variables)) ids.add(id);
    for (const id of Object.keys(target.lists)) ids.add(id);
    for (const id of Object.keys(target.broadcasts)) ids.add(id);
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

function assertAssetsEqual(original, transformed) {
  const originalNames = Object.keys(original).filter(name => name !== 'project.json').sort();
  const transformedNames = Object.keys(transformed).filter(name => name !== 'project.json').sort();
  assert(JSON.stringify(transformedNames) === JSON.stringify(originalNames), 'asset entry names changed');
  for (const name of originalNames) {
    assert(Buffer.from(transformed[name]).equals(Buffer.from(original[name])), `asset bytes changed for ${JSON.stringify(name)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
