import {constants as fsConstants, existsSync} from 'node:fs';
import {Buffer} from 'node:buffer';
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {clearTimeout, setTimeout} from 'node:timers';

const CHILD_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const inputArgument = process.argv[2];
if (!inputArgument) throw new Error('usage: smoke-packed.mjs <fixture.sb3>');

const repository = resolve('.');
const input = resolve(inputArgument);
const packageMetadata = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
if (!packageMetadata || typeof packageMetadata.version !== 'string') {
  throw new Error('package.json has no valid version');
}
const tarball = resolve(repository, `scratch-obfuscator-${packageMetadata.version}.tgz`);
if (!existsSync(tarball)) throw new Error(`expected current package tarball ${basename(tarball)}`);

const temporary = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-pack-'));
const installation = join(temporary, 'installed package ü');
const workspace = join(temporary, 'project paths 世界');
const alternateCwd = join(temporary, 'alternate cwd å');

try {
  await Promise.all([
    mkdir(installation),
    mkdir(workspace),
    mkdir(alternateCwd)
  ]);
  await writeFile(join(installation, 'package.json'), '{"private":true}', 'utf8');
  await runNpm(['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], installation);

  const installedBin = process.platform === 'win32'
    ? join(installation, 'node_modules', '.bin', 'scratch-obfuscator.cmd')
    : join(installation, 'node_modules', '.bin', 'scratch-obfuscator');
  if (process.platform !== 'win32') await access(installedBin, fsConstants.X_OK);

  const version = process.platform === 'win32'
    ? await runCli(['--version'], alternateCwd)
    : await run(installedBin, ['--version'], alternateCwd);
  assert(version.code === 0, `installed CLI --version exited with ${version.code}`);
  assert(version.stdout.trim() === packageMetadata.version, 'installed CLI version differs from package version');

  const unicodeInput = join(workspace, 'Prøject ü space.sb3');
  await copyFile(input, unicodeInput);
  const first = join(workspace, 'first output ü.sb3');
  const second = join(temporary, 'second output 世界.sb3');
  const firstResult = await runCli([unicodeInput, '-o', first, '-lossless'], installation, {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC'
  });
  const secondResult = await runCli([unicodeInput, '-o', second, '--lossless'], alternateCwd, {
    LANG: 'tr_TR.UTF-8',
    LC_ALL: 'tr_TR.UTF-8',
    TZ: 'Pacific/Auckland'
  });
  assertSuccess(firstResult, 'first deterministic invocation');
  assertSuccess(secondResult, 'second deterministic invocation');
  await assertFilesEqual(first, second, 'output changed with cwd, path, locale, or timezone');
  assert(!firstResult.stderr.includes('\r') && !secondResult.stderr.includes('\r'), 'non-TTY progress used carriage returns');

  const defaultResult = await runCli([unicodeInput, '-lossless'], alternateCwd);
  assertSuccess(defaultResult, 'default output invocation');
  const defaultOutput = join(workspace, 'Prøject ü space.obfuscated.sb3');
  await assertFilesEqual(first, defaultOutput, 'default output path changed archive bytes');

  const antiSaveFirst = join(workspace, 'antisave first.sb3');
  const antiSaveSecond = join(temporary, 'antisave second.sb3');
  assertSuccess(
    await runCli([unicodeInput, '-o', antiSaveFirst, '-lossless', '-antisave'], installation, {TZ: 'UTC'}),
    'antisave packed invocation'
  );
  assertSuccess(
    await runCli([unicodeInput, '-o', antiSaveSecond, '--lossless', '--antisave'], alternateCwd, {TZ: 'Asia/Tokyo'}),
    'antisave packed repeat'
  );
  await assertFilesEqual(antiSaveFirst, antiSaveSecond, 'antisave packed output changed across paths or timezone');

  const strongestFirst = join(workspace, 'strongest first.sb3');
  const strongestSecond = join(temporary, 'strongest second.sb3');
  assertSuccess(
    await runCli(
      [unicodeInput, '-o', strongestFirst, '-no-preserve', '-anticheat', '-extra', '-allowsize', '-antisave'],
      installation,
      {TZ: 'UTC'}
    ),
    'strongest packed invocation'
  );
  assertSuccess(
    await runCli(
      [unicodeInput, '-o', strongestSecond, '--no-preserve', '--anticheat', '--extra', '--allowsize', '--antisave'],
      alternateCwd,
      {TZ: 'Asia/Tokyo'}
    ),
    'strongest packed repeat'
  );
  await assertFilesEqual(strongestFirst, strongestSecond, 'strongest packed output changed across paths or timezone');

  const lossyAllowSize = join(workspace, 'lossy allowsize.sb3');
  assertSuccess(
    await runCli([unicodeInput, '-o', lossyAllowSize, '-lossy', '-allowsize'], installation),
    'lossy allowsize packed invocation'
  );

  const lossyProtectedAllowSize = join(workspace, 'lossy anticheat allowsize.sb3');
  assertSuccess(
    await runCli(
      [unicodeInput, '-o', lossyProtectedAllowSize, '-lossy', '-anticheat', '-allowsize'],
      installation
    ),
    'lossy anticheat allowsize packed invocation'
  );

  const strongestProtectedAllowSize = join(workspace, 'no preserve anticheat allowsize.sb3');
  assertSuccess(
    await runCli(
      [unicodeInput, '-o', strongestProtectedAllowSize, '-no-preserve', '-anticheat', '-allowsize'],
      installation
    ),
    'no-preserve anticheat allowsize packed invocation'
  );

  const forced = join(workspace, 'existing output.sb3');
  await writeFile(forced, 'prior output', 'utf8');
  assertSuccess(await runCli([unicodeInput, '-o', forced, '-lossless', '--force'], installation), 'forced replacement');
  await assertFilesEqual(first, forced, 'forced replacement did not install the deterministic output');

  const hardlinkOutput = join(workspace, 'hardlink output.sb3');
  await link(unicodeInput, hardlinkOutput);
  const beforeIdentityChecks = await readFile(unicodeInput);
  assertExit(await runCli([unicodeInput, '-o', hardlinkOutput, '-lossless', '--force'], installation), 2, 'hardlink identity');
  assert(Buffer.compare(beforeIdentityChecks, await readFile(unicodeInput)) === 0, 'hardlink identity check changed the input');

  if (process.platform !== 'win32') {
    const symlinkOutput = join(workspace, 'symlink output.sb3');
    await symlink(unicodeInput, symlinkOutput);
    assertExit(await runCli([unicodeInput, '-o', symlinkOutput, '-lossless', '--force'], installation), 2, 'symlink identity');
    assert(Buffer.compare(beforeIdentityChecks, await readFile(unicodeInput)) === 0, 'symlink identity check changed the input');

    const permissionInput = join(workspace, 'read only input.sb3');
    const permissionDirectory = join(workspace, 'private output directory');
    const permissionOutput = join(permissionDirectory, 'permission output.sb3');
    await copyFile(input, permissionInput);
    await mkdir(permissionDirectory, {mode: 0o700});
    await chmod(permissionInput, 0o400);
    await chmod(permissionDirectory, 0o700);
    assertSuccess(await runCli([permissionInput, '-o', permissionOutput, '-lossless'], installation), 'POSIX permission invocation');
    const outputMode = (await stat(permissionOutput)).mode & 0o777;
    assert(outputMode === 0o600, `expected output mode 0600, received ${outputMode.toString(8)}`);

    const readOnlyOutput = join(permissionDirectory, 'read only existing output.sb3');
    await writeFile(readOnlyOutput, 'prior output', {encoding: 'utf8', mode: 0o400});
    await chmod(readOnlyOutput, 0o400);
    assertSuccess(
      await runCli([permissionInput, '-o', readOnlyOutput, '-lossless', '--force'], installation),
      'POSIX read-only forced replacement'
    );
    await assertFilesEqual(first, readOnlyOutput, 'read-only forced replacement did not install deterministic bytes');
  }

  const caseInput = join(workspace, 'CaseProbe.sb3');
  const caseOutput = join(workspace, 'caseprobe.sb3');
  await copyFile(input, caseInput);
  const caseInsensitive = await pathExists(caseOutput);
  const caseResult = await runCli([caseInput, '-o', caseOutput, '-lossless', '--force'], installation);
  if (caseInsensitive) {
    assertExit(caseResult, 2, 'case-insensitive path identity');
    assert(Buffer.compare(await readFile(caseInput), await readFile(input)) === 0, 'case identity check changed the input');
  } else {
    assertSuccess(caseResult, 'case-sensitive distinct path');
    await assertFilesEqual(first, caseOutput, 'case-sensitive output changed deterministic bytes');
  }

  const residue = (await readdir(workspace)).filter(name => (
    name.includes('.scratch-obfuscator.transaction')
    || name.includes('.scratch-obfuscator.backup')
    || name.includes('.tmp-')
  ));
  assert(residue.length === 0, `output transactions left residue: ${residue.join(', ')}`);
  process.stdout.write(`Packed CLI platform smoke OK: ${process.platform} ${process.version}\n`);
} finally {
  await rm(temporary, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}

function runCli(arguments_, cwd, environment = {}) {
  return runNpm(['--prefix', installation, 'exec', '--offline', '--', 'scratch-obfuscator', ...arguments_], cwd, environment);
}

function runNpm(arguments_, cwd, environment = {}) {
  const configuredNpmCli = process.env.npm_execpath;
  const npmCli = configuredNpmCli && existsSync(configuredNpmCli)
    ? configuredNpmCli
    : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = process.platform === 'win32' ? process.execPath : 'npm';
  const argumentsWithCli = process.platform === 'win32' ? [npmCli, ...arguments_] : arguments_;
  return run(command, argumentsWithCli, cwd, environment);
}

function run(command, arguments_, cwd, environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: {...process.env, ...environment},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    const collect = destination => chunk => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      destination.push(bytes);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (timedOut) rejectPromise(new Error(`${command} timed out after ${CHILD_TIMEOUT_MS} ms`));
      else if (outputBytes > MAX_CHILD_OUTPUT_BYTES) rejectPromise(new Error(`${command} exceeded the child-output limit`));
      else resolvePromise(result);
    });
  });
}

function assertSuccess(result, label) {
  assertExit(result, 0, label);
}

function assertExit(result, expected, label) {
  assert(
    result.code === expected,
    `${label} exited with ${result.code}${result.signal ? ` (${result.signal})` : ''}\n${result.stdout}${result.stderr}`
  );
}

async function assertFilesEqual(left, right, message) {
  assert(Buffer.compare(await readFile(left), await readFile(right)) === 0, message);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
