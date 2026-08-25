import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const directories: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyScript = join(repositoryRoot, 'scripts', 'check-dependency-policy.mjs');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('dependency lockfile policy', () => {
  it('accepts the checked-in application and browser-QA lockfiles', async () => {
    const result = await runPolicy([
      join(repositoryRoot, 'package-lock.json'),
      join(repositoryRoot, 'qa', 'gui', 'package-lock.json')
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dependency policy OK:');
    expect(result.stderr).toBe('');
  });

  it('accepts registry packages and reviewed local QA links', async () => {
    const lockfile = await writeLock({
      '': {name: 'fixture', version: '1.0.0'},
      'node_modules/example': registryPackage(),
      'node_modules/local-boundary': {resolved: 'qa/shims/local-boundary', link: true},
      'qa/shims/local-boundary': {version: '1.0.0'}
    });
    const result = await runPolicy([lockfile]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects deprecated, unpinned, noncanonical, and weak-integrity packages', async () => {
    const lockfile = await writeLock({
      '': {name: 'fixture', version: '1.0.0'},
      'node_modules/deprecated': {...registryPackage(), deprecated: 'unsupported'},
      'node_modules/unpinned': {version: '1.0.0'},
      'node_modules/git': {version: '1.0.0', resolved: 'git+https://example.invalid/repository.git'},
      'node_modules/noncanonical': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/noncanonical/-/noncanonical-1.0.0.tgz',
        integrity: `sha512-${'A'.repeat(85)}B==`
      },
      'node_modules/substituted': registryPackage(),
      'node_modules/truncated': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/truncated/-/truncated-1.0.0.tgz',
        integrity: 'sha512-example'
      },
      'node_modules/weak': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/weak/-/weak-1.0.0.tgz',
        integrity: 'sha1-example'
      }
    });
    const result = await runPolicy([lockfile]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('deprecated: unsupported');
    expect(result.stderr).toContain('missing a pinned resolution');
    expect(result.stderr).toContain('not pinned to its canonical HTTPS npm tarball');
    expect(result.stderr).toContain('missing one canonical SHA-512 digest');
  });

  it('requires the current lockfile format and exact semantic versions', async () => {
    const rangeLockfile = await writeLock({
      '': {name: 'fixture', version: '1.0.0'},
      'node_modules/ranged': {
        ...registryPackage(),
        version: '^1.0.0',
        resolved: 'https://registry.npmjs.org/ranged/-/ranged-1.0.0.tgz'
      }
    });
    const oldLockfile = await writeLock({
      '': {name: 'fixture', version: '1.0.0'}
    }, 2);
    const result = await runPolicy([rangeLockfile, oldLockfile]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing an exact semantic version');
    expect(result.stderr).toContain('lockfileVersion must be exactly 3');
  });

  it('rejects dependency links outside the reviewed shim directory', async () => {
    const lockfile = await writeLock({
      '': {name: 'fixture', version: '1.0.0'},
      'node_modules/escaped': {resolved: 'qa/shims/../../outside', link: true},
      'node_modules/missing': {resolved: 'qa/shims/missing', link: true}
    });
    const result = await runPolicy([lockfile]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dependency link is outside the reviewed QA shims');
    expect(result.stderr).toContain('dependency link has no locked shim descriptor');
  });
});

function registryPackage(): Record<string, unknown> {
  return {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`
  };
}

async function writeLock(packages: Record<string, Record<string, unknown>>, lockfileVersion = 3): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-dependency-policy-'));
  directories.push(directory);
  const lockfile = join(directory, 'package-lock.json');
  await writeFile(lockfile, JSON.stringify({name: 'fixture', lockfileVersion, packages}), 'utf8');
  return lockfile;
}

function runPolicy(lockfiles: string[]): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [policyScript, ...lockfiles], {
      cwd: repositoryRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk as Uint8Array)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk as Uint8Array)));
    child.once('error', rejectPromise);
    child.once('exit', code => resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}
