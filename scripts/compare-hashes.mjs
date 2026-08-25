import {Buffer} from 'node:buffer';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

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

const root = process.argv[2];
if (!root) throw new Error('usage: compare-hashes.mjs <artifact-directory>');

async function findJson(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findJson(path));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

const files = (await findJson(root)).sort();
if (files.length !== 6) throw new Error(`expected 6 hash manifests, found ${files.length}`);
const baseline = normalizedManifest(await readFile(files[0], 'utf8'), files[0]);
for (const file of files.slice(1)) {
  const candidate = normalizedManifest(await readFile(file, 'utf8'), file);
  if (candidate !== baseline) throw new Error(`cross-platform output differs: ${files[0]} vs ${file}`);
}
process.stdout.write(`All ${files.length} platform/runtime manifests are identical.\n`);

function normalizedManifest(source, file) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON hash manifest ${file}`, {cause: error});
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid hash manifest object: ${file}`);
  const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  if (entries.length !== expectedNames.length || entries.some(([name], index) => name !== expectedNames[index])) {
    throw new Error(`hash manifest ${file} must contain exactly ${expectedNames.join(', ')}`);
  }
  for (const [name, hash] of entries) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`invalid SHA-256 for ${JSON.stringify(name)} in ${file}`);
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
}
