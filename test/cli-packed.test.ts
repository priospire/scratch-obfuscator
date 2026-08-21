import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
import {afterEach, describe, expect, it} from 'vitest';

const directories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('packed CLI subprocess', () => {
  it('invokes the installed bin on Unicode paths and is deterministic across cwd, output path, and timezone', async () => {
    const root = await temporaryDirectory();
    const packs = join(root, 'packs');
    const installation = join(root, 'installed package');
    const alternateCwd = join(root, '別の cwd');
    const fixtureDirectory = join(root, '入力 fixtures');
    await Promise.all([mkdir(packs), mkdir(installation), mkdir(alternateCwd), mkdir(fixtureDirectory)]);
    await writeFile(join(installation, 'package.json'), '{"private":true}', 'utf8');

    await runNpm(['pack', '--silent', '--pack-destination', packs], repositoryRoot);
    const tarballs = (await readdir(packs)).filter(name => name.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    const tarball = tarballs[0];
    if (tarball === undefined) throw new Error('npm pack did not produce a tarball');
    await runNpm(['install', join(packs, tarball), '--ignore-scripts', '--no-audit', '--no-fund'], installation);

    const input = join(fixtureDirectory, 'project ü.sb3');
    const first = join(root, 'first output.sb3');
    const second = join(root, 'second output.sb3');
    await writeFile(input, validArchive());
    const prefix = ['--prefix', installation, 'exec', '--offline', '--', 'scratch-obfuscator'];
    const version = await runNpm([...prefix, '--version'], alternateCwd, {TZ: 'UTC'});
    expect(version.stdout).toMatch(/^0\.1\.0\s*$/);
    await runNpm([...prefix, input, '-o', first, '-lossless'], installation, {TZ: 'UTC'});
    await runNpm([...prefix, input, '-o', second, '-lossless'], alternateCwd, {TZ: 'Pacific/Auckland'});
    expect(await readFile(second)).toEqual(await readFile(first));
  }, 120_000);
});

function runNpm(arguments_: string[], cwd: string, environment: Record<string, string> = {}): Promise<{stdout: string; stderr: string}> {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const argumentsWithCli = process.platform === 'win32' ? [npmCli, ...arguments_] : arguments_;
  return run(command, argumentsWithCli, cwd, environment);
}

function run(command: string, arguments_: string[], cwd: string, environment: Record<string, string>): Promise<{stdout: string; stderr: string}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: {...process.env, ...environment},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk as Uint8Array)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk as Uint8Array)));
    child.once('error', rejectPromise);
    child.once('exit', code => {
      const result = {stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')};
      if (code === 0) resolvePromise(result);
      else rejectPromise(new Error(`${command} exited with ${String(code)}\n${result.stdout}${result.stderr}`));
    });
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-packed-'));
  directories.push(directory);
  return directory;
}

function validArchive(): Uint8Array {
  const assetName = '00000000000000000000000000000000.svg';
  return zipSync({
    'project.json': Buffer.from(JSON.stringify({
      targets: [{
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [{assetId: assetName.slice(0, 32), name: 'backdrop1', dataFormat: 'svg', md5ext: assetName, rotationCenterX: 0, rotationCenterY: 0}],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null
      }],
      monitors: [],
      extensions: [],
      meta: {semver: '3.0.0', vm: '5.0.0', agent: 'packed-test'}
    })),
    [assetName]: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  }, {level: 9, mtime: new Date(1980, 0, 1)});
}
