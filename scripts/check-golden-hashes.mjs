import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';

const expectedNames = [
  'lossless.sb3',
  'lossless-extra2.sb3',
  'lossy.sb3',
  'no-preserve.sb3',
  'lossless-anticheat.sb3',
  'lossy-anticheat.sb3',
  'lossy-anticheat-allowsize.sb3',
  'lossy-allowsize.sb3',
  'no-preserve-allowsize.sb3',
  'no-preserve-anticheat.sb3',
  'no-preserve-anticheat-allowsize.sb3',
  'no-preserve-anticheat-extra.sb3',
  'no-preserve-anticheat-extra-allowsize.sb3',
  'lossless-antisave.sb3',
  'lossy-antisave.sb3',
  'no-preserve-antisave.sb3',
  'no-preserve-anticheat-extra-allowsize-antisave.sb3'
].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));

const [manifestPath, goldenPath] = process.argv.slice(2);
if (!manifestPath || !goldenPath) {
  throw new Error('usage: check-golden-hashes.mjs <actual.json> <golden.json>');
}

const [actual, golden] = await Promise.all([
  loadManifest(manifestPath),
  loadManifest(goldenPath)
]);
if (JSON.stringify(actual) !== JSON.stringify(golden)) {
  throw new Error(`archive golden hashes differ: ${manifestPath} vs ${goldenPath}`);
}
process.stdout.write(`Archive hashes match ${goldenPath}.\n`);

async function loadManifest(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid hash manifest: ${path}`);
  const entries = Object.entries(parsed).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  if (entries.length !== expectedNames.length || entries.some(([name], index) => name !== expectedNames[index])) {
    throw new Error(`hash manifest ${path} must contain exactly ${expectedNames.join(', ')}`);
  }
  for (const [name, hash] of entries) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`invalid SHA-256 for ${JSON.stringify(name)} in ${path}`);
    }
  }
  return Object.fromEntries(entries);
}
