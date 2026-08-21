import {Buffer} from 'node:buffer';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

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
  if (entries.length !== 3) throw new Error(`expected 3 output hashes in ${file}, found ${entries.length}`);
  for (const [name, hash] of entries) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`invalid SHA-256 for ${JSON.stringify(name)} in ${file}`);
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
}
