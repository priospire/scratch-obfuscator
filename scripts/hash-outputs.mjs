import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {readFile, writeFile} from 'node:fs/promises';
import {basename} from 'node:path';

const [destination, ...files] = process.argv.slice(2);
if (!destination || files.length === 0) throw new Error('usage: hash-outputs.mjs <destination.json> <files...>');
const hashes = Object.create(null);
for (const file of [...files].sort((left, right) => Buffer.from(basename(left)).compare(Buffer.from(basename(right))))) {
  const name = basename(file);
  if (Object.hasOwn(hashes, name)) throw new Error(`duplicate output basename: ${JSON.stringify(name)}`);
  hashes[name] = createHash('sha256').update(await readFile(file)).digest('hex');
}
await writeFile(destination, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
