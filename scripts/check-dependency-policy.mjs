import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import process from 'node:process';

const EXACT_SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_LOCATION_PATTERN = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;

function hasCanonicalSha512Integrity(integrity) {
  if (typeof integrity !== 'string' || !SHA512_INTEGRITY_PATTERN.test(integrity)) return false;
  const encodedDigest = integrity.slice('sha512-'.length);
  const digest = Buffer.from(encodedDigest, 'base64');
  return digest.length === 64 && digest.toString('base64') === encodedDigest;
}

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

    if (!lock || typeof lock !== 'object' || lock.lockfileVersion !== 3) {
      violations.push(`${lockfile}: lockfileVersion must be exactly 3`);
      continue;
    }
    if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
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
      if (typeof descriptor.version !== 'string' || !EXACT_SEMVER_PATTERN.test(descriptor.version)) {
        violations.push(`${label}: registry dependency is missing an exact semantic version`);
        continue;
      }
      const packageMatch = PACKAGE_LOCATION_PATTERN.exec(location);
      if (!packageMatch) {
        violations.push(`${label}: registry dependency has an invalid package location`);
        continue;
      }
      const packageName = packageMatch[1];
      const tarballName = packageName.slice(packageName.lastIndexOf('/') + 1);
      const expectedResolution = `https://registry.npmjs.org/${packageName}/-/${tarballName}-${descriptor.version}.tgz`;
      if (descriptor.resolved !== expectedResolution) {
        violations.push(`${label}: dependency is not pinned to its canonical HTTPS npm tarball: ${descriptor.resolved}`);
        continue;
      }
      if (!hasCanonicalSha512Integrity(descriptor.integrity)) {
        violations.push(`${label}: registry dependency is missing one canonical SHA-512 digest`);
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
