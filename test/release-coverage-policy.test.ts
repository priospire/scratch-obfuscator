import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('release coverage snapshot policy', () => {
  it('accepts a self-consistent snapshot and rejects stale arithmetic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-coverage-policy-'));
    temporaryDirectories.push(directory);
    const summaryPath = join(directory, 'summary.json');
    const snapshotPath = join(directory, 'snapshot.json');
    const packagePath = join(directory, 'package.json');
    const packageMetadata = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {version: string};
    const summary = {
      total: {
        statements: {covered: 98, total: 100, pct: 98},
        branches: {covered: 94, total: 100, pct: 94},
        functions: {covered: 10, total: 10, pct: 100},
        lines: {covered: 99, total: 100, pct: 99}
      }
    };
    const snapshot = {
      version: packageMetadata.version,
      statements: {covered: 98, total: 100, percentage: 98, allCovered: false},
      branches: {covered: 94, total: 100, percentage: 94, allCovered: false},
      functions: {covered: 10, total: 10, percentage: 100, allCovered: true},
      lines: {covered: 99, total: 100, percentage: 99, allCovered: false}
    };
    await Promise.all([
      writeFile(summaryPath, JSON.stringify(summary)),
      writeFile(snapshotPath, JSON.stringify(snapshot)),
      writeFile(packagePath, JSON.stringify(packageMetadata))
    ]);

    const valid = await runPolicy(summaryPath, snapshotPath, packagePath);
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain('Release coverage snapshot is valid');

    snapshot.branches.percentage = 93;
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    const invalid = await runPolicy(summaryPath, snapshotPath, packagePath);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('inconsistent branches arithmetic');
  });
});

async function runPolicy(
  summaryPath: string,
  snapshotPath: string,
  packagePath: string
): Promise<{exitCode: number; stdout: string; stderr: string}> {
  try {
    const result = await executeFile(process.execPath, [
      resolve('scripts/check-release-coverage.mjs'),
      summaryPath,
      snapshotPath,
      packagePath
    ]);
    return {exitCode: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    const failure = error as Error & {code?: number; stdout?: string; stderr?: string};
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
}
