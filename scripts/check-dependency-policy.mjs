import {readFile} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import process from 'node:process';

const lockfiles = process.argv.slice(2);
if (lockfiles.length === 0) {
  process.stderr.write('usage: node scripts/check-dependency-policy.mjs <package-lock.json> [...]\n');
  process.exitCode = 2;
} else {
  const violations = [];
  let packageCount = 0;

  for (const lockfile of lockfiles) {
    let lock;
    try {
      lock = JSON.parse(await readFile(lockfile, 'utf8'));
    } catch (error) {
      violations.push(`${lockfile}: could not read a valid lockfile: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
      violations.push(`${lockfile}: missing the package-lock packages map`);
      continue;
    }

    for (const [location, descriptor] of Object.entries(lock.packages)) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      packageCount += 1;
      const label = `${lockfile}:${location || '<root>'}`;
      if (typeof descriptor.deprecated === 'string' && descriptor.deprecated.length > 0) {
        violations.push(`${label}: deprecated: ${descriptor.deprecated}`);
      }
      if (!location.startsWith('node_modules/')) continue;
      if (typeof descriptor.resolved !== 'string') {
        violations.push(`${label}: installed dependency is missing a pinned resolution`);
        continue;
      }
      if (descriptor.link === true) {
        const shimRoot = resolve(dirname(lockfile), 'qa', 'shims');
        const shimTarget = resolve(dirname(lockfile), descriptor.resolved);
        const relativeTarget = relative(shimRoot, shimTarget);
        if (relativeTarget.length === 0 || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
          violations.push(`${label}: dependency link is outside the reviewed QA shims: ${descriptor.resolved}`);
          continue;
        }
        if (!(descriptor.resolved in lock.packages)) {
          violations.push(`${label}: dependency link has no locked shim descriptor: ${descriptor.resolved}`);
        }
        continue;
      }
      if (!descriptor.resolved.startsWith('https://registry.npmjs.org/')) {
        violations.push(`${label}: dependency is not pinned to the HTTPS npm registry: ${descriptor.resolved}`);
        continue;
      }
      if (typeof descriptor.integrity !== 'string' || !descriptor.integrity.startsWith('sha512-')) {
        violations.push(`${label}: registry dependency is missing SHA-512 integrity`);
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations.sort()) process.stderr.write(`${violation}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Dependency policy OK: ${packageCount} locked package entries across ${lockfiles.length} lockfile(s)\n`);
  }
}
