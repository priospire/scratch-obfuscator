import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const VERSION = '15.1.0';
const TARBALL_URL = `https://registry.npmjs.org/@scratch/scratch-gui/-/scratch-gui-${VERSION}.tgz`;
const TARBALL_SHA512 = '3a72ddc5cc9d8cf74ce1ef9b3a133f363fdabc2f1011ef043b36be62f4ae1564f4a8d4d31bb2939f1e8ee352a4ac9c46d8969c2972ff5e26f368beafe5830508';
const BUNDLE_SHA256 = '3964fbfd4a701cc03ee5a191cab21a5c7d7376afe7d53bca2d19241ae3d45f1c';
const DISTRIBUTION_SHA256 = '810c71fdb198dad6a943e821e90c959210422c4b6166017041f8510993192b0c';
const MAX_TARBALL_BYTES = 160 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const EXTRACTION_TIMEOUT_MS = 3 * 60 * 1000;
const workspace = resolve('.');
const expectedTarget = resolve(workspace, 'qa/.official-scratch-gui');
const target = resolve(process.argv[2] ?? expectedTarget);
const targetRelative = relative(workspace, target);
if (target !== expectedTarget) {
  throw new Error('official GUI extraction target must be qa/.official-scratch-gui');
}

const bundlePath = join(target, 'scratch-gui-standalone.js');
const markerPath = join(target, '.verified-source.json');
if (await isCurrentExtraction(bundlePath, markerPath)) {
  process.stdout.write(`Official Scratch GUI ${VERSION} already verified at ${targetRelative}.\n`);
  process.exit(0);
}

const temporary = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-official-gui-'));
const tarball = join(temporary, `scratch-gui-${VERSION}.tgz`);
try {
  const downloadController = new globalThis.AbortController();
  const downloadTimeout = globalThis.setTimeout(() => {
    downloadController.abort(new Error(
      `official Scratch GUI download timed out after ${DOWNLOAD_TIMEOUT_MS} ms`
    ));
  }, DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(TARBALL_URL, {
      redirect: 'error',
      signal: downloadController.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`official Scratch GUI download failed with HTTP ${response.status}`);
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_TARBALL_BYTES) {
      throw new Error(`official Scratch GUI tarball exceeds ${MAX_TARBALL_BYTES} bytes`);
    }
    const digest = createHash('sha512');
    let received = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_TARBALL_BYTES) {
          callback(new Error(`official Scratch GUI tarball exceeds ${MAX_TARBALL_BYTES} bytes`));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verifier,
      createWriteStream(tarball, {flags: 'wx'}),
      {signal: downloadController.signal}
    );
    if (digest.digest('hex') !== TARBALL_SHA512) {
      throw new Error('official Scratch GUI tarball failed the pinned SHA-512 check');
    }
  } catch (error) {
    if (downloadController.signal.aborted) {
      throw new Error(
        `official Scratch GUI download timed out after ${DOWNLOAD_TIMEOUT_MS} ms`,
        {cause: error}
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(downloadTimeout);
  }

  const extraction = spawnSync('tar', [
    '-xzf', tarball,
    '-C', temporary,
    'package/dist'
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: EXTRACTION_TIMEOUT_MS
  });
  if (extraction.error?.code === 'ETIMEDOUT') {
    throw new Error(`official Scratch GUI extraction timed out after ${EXTRACTION_TIMEOUT_MS} ms`);
  }
  if (extraction.error) {
    throw new Error(`official Scratch GUI extraction failed: ${extraction.error.message}`);
  }
  if (extraction.status !== 0) {
    throw new Error(`official Scratch GUI extraction failed: ${extraction.stderr?.trim() || 'tar exited nonzero'}`);
  }
  const extracted = join(temporary, 'package', 'dist');
  if (await sha256(join(extracted, 'scratch-gui-standalone.js')) !== BUNDLE_SHA256) {
    throw new Error('official Scratch GUI standalone bundle failed the pinned SHA-256 check');
  }
  if (await directoryDigest(extracted) !== DISTRIBUTION_SHA256) {
    throw new Error('official Scratch GUI distribution failed the pinned tree SHA-256 check');
  }

  await mkdir(dirname(target), {recursive: true});
  await rm(target, {recursive: true, force: true});
  await rename(extracted, target);
  await writeFile(markerPath, `${JSON.stringify({
    version: VERSION,
    tarball: TARBALL_URL,
    tarballSha512: TARBALL_SHA512,
    bundleSha256: BUNDLE_SHA256,
    distributionSha256: DISTRIBUTION_SHA256
  })}\n`, {encoding: 'utf8', flag: 'wx'});
  process.stdout.write(`Prepared verified official Scratch GUI ${VERSION} at ${targetRelative}.\n`);
} finally {
  await rm(temporary, {recursive: true, force: true});
}

async function isCurrentExtraction(bundle, marker) {
  try {
    const metadata = JSON.parse(await readFile(marker, 'utf8'));
    return metadata?.version === VERSION
      && metadata?.tarballSha512 === TARBALL_SHA512
      && metadata?.bundleSha256 === BUNDLE_SHA256
      && metadata?.distributionSha256 === DISTRIBUTION_SHA256
      && await sha256(bundle) === BUNDLE_SHA256
      && await directoryDigest(dirname(bundle)) === DISTRIBUTION_SHA256;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function directoryDigest(root) {
  const paths = await collectFiles(root, root);
  paths.sort((left, right) => Buffer.compare(Buffer.from(left.relative), Buffer.from(right.relative)));
  const digest = createHash('sha256');
  for (const path of paths) {
    const name = Buffer.from(path.relative, 'utf8');
    const bytes = await readFile(path.absolute);
    const header = Buffer.alloc(12);
    header.writeUInt32BE(name.length);
    header.writeBigUInt64BE(BigInt(bytes.length), 4);
    digest.update(header);
    digest.update(name);
    digest.update(bytes);
  }
  return digest.digest('hex');
}

async function collectFiles(root, directory) {
  const paths = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = join(directory, entry.name);
    const entryRelative = relative(root, absolute).replaceAll('\\', '/');
    if (entryRelative === '.verified-source.json') continue;
    if (entry.isDirectory()) {
      paths.push(...await collectFiles(root, absolute));
    } else if (entry.isFile()) {
      paths.push({absolute, relative: entryRelative});
    } else {
      throw new Error(`official Scratch GUI distribution contains a non-file entry: ${entry.name}`);
    }
  }
  return paths;
}
