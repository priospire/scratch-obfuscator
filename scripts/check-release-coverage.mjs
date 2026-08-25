#!/usr/bin/env node

import {readFile} from 'node:fs/promises';

const [summaryPath = 'coverage/coverage-summary.json', snapshotPath = 'src/release-coverage.json', packagePath = 'package.json'] = process.argv.slice(2);
const [summary, snapshot, packageMetadata] = await Promise.all([
  readJson(summaryPath),
  readJson(snapshotPath),
  readJson(packagePath)
]);

const failures = [];
if (snapshot.version !== packageMetadata.version) {
  failures.push(`snapshot version ${JSON.stringify(snapshot.version)} does not match package version ${JSON.stringify(packageMetadata.version)}`);
}

for (const name of ['statements', 'branches', 'functions', 'lines']) {
  const actual = summary.total?.[name];
  const recorded = snapshot[name];
  if (!isMetric(actual)) {
    failures.push(`coverage summary has no valid ${name} metric`);
    continue;
  }
  if (!isRecordedMetric(recorded)) {
    failures.push(`release snapshot has no valid ${name} metric`);
    continue;
  }
  const expectedPercentage = Math.floor((recorded.covered / recorded.total) * 10_000) / 100;
  if (recorded.percentage !== expectedPercentage || recorded.allCovered !== (recorded.covered === recorded.total)) {
    failures.push(`release snapshot has inconsistent ${name} arithmetic`);
  }
  if (process.platform === 'win32' && (
    actual.covered !== recorded.covered
    || actual.total !== recorded.total
    || actual.pct !== recorded.percentage
  )) {
    failures.push(
      `${name} snapshot is stale: recorded ${recorded.covered}/${recorded.total} (${recorded.percentage}%),` +
      ` measured ${actual.covered}/${actual.total} (${actual.pct}%)`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`release coverage policy: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release coverage snapshot is valid for ${snapshot.version}.\n`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release coverage policy: cannot read ${path}: ${detail}\n`);
    process.exit(1);
  }
}

function isMetric(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isInteger(value.covered)
    && Number.isInteger(value.total)
    && typeof value.pct === 'number';
}

function isRecordedMetric(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isInteger(value.covered)
    && Number.isInteger(value.total)
    && value.total > 0
    && value.covered >= 0
    && value.covered <= value.total
    && typeof value.percentage === 'number'
    && typeof value.allCovered === 'boolean';
}
