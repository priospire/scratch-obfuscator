import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, extname, isAbsolute, join, normalize, resolve, sep} from 'node:path';
import process from 'node:process';
import {pathToFileURL, URL} from 'node:url';

const dependencyBase = process.env.GUI_QA_ROOT
  ? join(resolve(process.env.GUI_QA_ROOT), 'package.json')
  : import.meta.url;
const require = createRequire(dependencyBase);
const guiRoot = dirname(require.resolve('@scratch/scratch-gui'));
const puppeteerUrl = pathToFileURL(require.resolve('puppeteer-core')).href;

const chromeCandidates = process.platform === 'win32' ? [
  process.env.GUI_CHROME,
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
] : process.platform === 'darwin' ? [
  process.env.GUI_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
] : [
  process.env.GUI_CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

const runner = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scratch GUI smoke</title></head>
<body>
  <main id="app"></main>
  <script src="/gui/scratch-gui-standalone.js"></script>
  <script>
    window.__smokeErrors = [];
    window.addEventListener('error', event => window.__smokeErrors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));
    window.__smokeReady = new Promise((resolve, reject) => {
      try {
        const state = new GUI.EditorState({locale: 'en'});
        const root = GUI.createStandaloneRoot(state, document.getElementById('app'));
        window.__smokeRoot = root;
        root.render({
          backpackVisible: false,
          canEditTitle: false,
          canSave: false,
          showComingSoon: false,
          onVmInit: vm => {
            window.__smokeVm = vm;
            resolve(true);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  </script>
</body>
</html>`;

const findExecutable = async () => {
  for (const candidate of chromeCandidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next platform-specific location.
    }
  }
  throw new Error('Chrome or Chromium was not found; set GUI_CHROME to its executable path');
};

const resolveGuiFile = requestPath => {
  const relative = normalize(decodeURIComponent(requestPath.slice('/gui/'.length))).replace(/^([/\\])+/, '');
  const candidate = resolve(guiRoot, relative);
  const expectedPrefix = `${resolve(guiRoot)}${sep}`;
  return candidate.startsWith(expectedPrefix) ? candidate : null;
};

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath === '/' || requestPath === '/runner.html') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(runner);
      return;
    }
    if (!requestPath.startsWith('/gui/')) {
      response.writeHead(404).end();
      return;
    }
    const filePath = resolveGuiFile(requestPath);
    if (!filePath || !(await stat(filePath)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream'
    });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404).end();
  }
});

const listen = () => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});

const projectPaths = process.argv.slice(2).map(path => resolve(path));
if (projectPaths.length === 0 || projectPaths.some(path => !isAbsolute(path))) {
  process.stderr.write('usage: node scripts/gui-smoke.mjs <project.sb3> [...]\n');
  process.exitCode = 2;
} else {
  let browser;
  try {
    const [{default: puppeteer}, executablePath, address] = await Promise.all([
      import(puppeteerUrl),
      findExecutable(),
      listen()
    ]);
    if (!address || typeof address === 'string') throw new Error('failed to bind GUI smoke server');
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    for (const projectPath of projectPaths) {
      const page = await browser.newPage();
      const hostErrors = [];
      page.on('pageerror', error => hostErrors.push(String(error)));
      page.setDefaultTimeout(60_000);
      await page.goto(`http://127.0.0.1:${address.port}/runner.html`, {waitUntil: 'networkidle0'});
      await page.evaluate(() => globalThis.__smokeReady);
      const bytes = await readFile(projectPath);
      const result = await page.evaluate(async encoded => {
        const decode = value => Uint8Array.from(globalThis.atob(value), character => character.charCodeAt(0));
        const vm = globalThis.__smokeVm;
        const snapshot = () => ({
          targetCount: vm.runtime.targets.length,
          targets: vm.runtime.targets.map(target => ({
            isStage: target.isStage,
            name: target.getName(),
            blockCount: Object.keys(target.blocks._blocks).length,
            symbols: Object.values(target.variables).map(variable => ({
              name: variable.name,
              type: variable.type
            }))
          }))
        });
        await vm.loadProject(decode(encoded));
        const firstLoad = snapshot();
        const firstSave = await vm.saveProjectSb3();
        const firstBytes = new Uint8Array(await firstSave.arrayBuffer());
        await vm.loadProject(firstBytes);
        const secondLoad = snapshot();
        const secondSave = await vm.saveProjectSb3();
        const secondSize = (await secondSave.arrayBuffer()).byteLength;
        return {
          errors: globalThis.__smokeErrors.slice(),
          hasWorkspace: Boolean(globalThis.document.querySelector('.blocklyWorkspace')),
          firstSize: firstBytes.byteLength,
          secondSize,
          firstLoad,
          secondLoad
        };
      }, bytes.toString('base64'));
      await page.close();
      if (hostErrors.length > 0 || result.errors.length > 0 || !result.hasWorkspace || result.firstSize === 0 || result.secondSize === 0 ||
          result.firstLoad.targetCount === 0 || JSON.stringify(result.firstLoad) !== JSON.stringify(result.secondLoad)) {
        throw new Error(`${projectPath}: GUI roundtrip failed: ${JSON.stringify(result)}`);
      }
      process.stdout.write(`GUI roundtrip OK: ${projectPath} (${result.firstLoad.targetCount} targets)\n`);
    }
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(() => resolveClose()));
  }
}
