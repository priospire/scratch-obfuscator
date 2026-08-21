import {existsSync} from 'node:fs';
import {mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';

const input = process.argv[2];
if (!input) throw new Error('usage: smoke-packed.mjs <fixture.sb3>');
const tarballs = (await readdir('.')).filter(name => /^scratch-obfuscator-.*\.tgz$/.test(name)).sort();
if (tarballs.length !== 1) throw new Error(`expected one package tarball, found ${tarballs.length}`);

const temporary = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-pack-'));
const run = (command, args) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, {cwd: temporary, stdio: 'inherit', shell: false});
  child.once('error', rejectPromise);
  child.once('exit', code => code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${code}`)));
});

try {
  await writeFile(join(temporary, 'package.json'), '{"private":true}', 'utf8');
  const configuredNpmCli = process.env.npm_execpath;
  const npmCli = configuredNpmCli && existsSync(configuredNpmCli)
    ? configuredNpmCli
    : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArguments = process.platform === 'win32' ? [npmCli] : [];
  await run(npmCommand, [...npmArguments, 'install', resolve(tarballs[0]), '--ignore-scripts', '--no-audit', '--no-fund']);
  const result = join(temporary, `${basename(input, '.sb3')}.result.sb3`);
  await run(npmCommand, [...npmArguments, 'exec', '--', 'scratch-obfuscator', '--version']);
  await run(npmCommand, [...npmArguments, 'exec', '--', 'scratch-obfuscator', resolve(input), '-o', result, '-lossless']);
  if ((await stat(result)).size === 0) throw new Error('packed CLI produced an empty file');
} finally {
  await rm(temporary, {recursive: true, force: true});
}
