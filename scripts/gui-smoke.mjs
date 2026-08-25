import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, extname, isAbsolute, join, normalize, resolve, sep} from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL, URL} from 'node:url';

const browserQaRoot = process.env.BROWSER_QA_ROOT ?? process.env.GUI_QA_ROOT;
const dependencyBase = browserQaRoot
  ? join(resolve(browserQaRoot), 'package.json')
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'gui', 'package.json');
const require = createRequire(dependencyBase);
const puppeteerUrl = pathToFileURL(require.resolve('puppeteer-core')).href;
const officialGuiRoot = resolve(
  process.env.OFFICIAL_SCRATCH_GUI_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'qa', '.official-scratch-gui')
);
const BROWSER_NAVIGATION_TIMEOUT_MS = 2 * 60 * 1000;
const BROWSER_READY_TIMEOUT_MS = 60 * 1000;
const PROJECT_ROUNDTRIP_TIMEOUT_MS = 3 * 60 * 1000;
const PROJECT_PHASE_TIMEOUT_MS = 60 * 1000;
const RENDERER_SNAPSHOT_TIMEOUT_MS = 30 * 1000;

const chromeCandidates = process.platform === 'win32' ? [
  process.env.BROWSER_CHROME ?? process.env.GUI_CHROME,
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
] : process.platform === 'darwin' ? [
  process.env.BROWSER_CHROME ?? process.env.GUI_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
] : [
  process.env.BROWSER_CHROME ?? process.env.GUI_CHROME,
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
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

const runner = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Official Scratch GUI smoke</title>
  <style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style>
</head>
<body>
  <main id="app"></main>
  <script src="/runtime/scratch-gui-standalone.js"></script>
  <script>
    window.__smokeErrors = [];
    window.addEventListener('error', event => window.__smokeErrors.push(String(event.error || event.message)));
    window.addEventListener('unhandledrejection', event => window.__smokeErrors.push(String(event.reason)));
    window.__smokeReady = new Promise((resolve, reject) => {
      try {
        const app = document.getElementById('app');
        GUI.setAppElement(app);
        const state = new GUI.EditorState({locale: 'en'});
        const root = GUI.createStandaloneRoot(state, app);
        root.render({
          backpackVisible: false,
          canEditTitle: false,
          canSave: false,
          showComingSoon: false
        });
        window.__smokeState = state;
        window.__smokeRoot = root;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
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
      continue;
    }
  }
  throw new Error('Chrome or Chromium was not found; set BROWSER_CHROME to its executable path');
};

const withTimeout = async (operation, timeoutMs, description) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error(`${description} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
};

const resolveOfficialGuiFile = requestPath => {
  const relative = normalize(decodeURIComponent(requestPath.replace(/^\/runtime\//u, '').replace(/^\//u, '')))
    .replace(/^([/\\])+/u, '');
  const candidate = resolve(officialGuiRoot, relative);
  return candidate.startsWith(`${officialGuiRoot}${sep}`) ? candidate : null;
};

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath === '/' || requestPath === '/runner.html') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(runner);
      return;
    }
    if (requestPath === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const filePath = resolveOfficialGuiFile(requestPath);
    if (!filePath) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readFile(filePath);
    response.writeHead(200, {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream'
    });
    response.end(bytes);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
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
    if (!address || typeof address === 'string') throw new Error('failed to bind browser smoke server');
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    for (const projectPath of projectPaths) {
      const page = await browser.newPage();
      const hostErrors = [];
      page.on('pageerror', error => hostErrors.push(String(error)));
      page.on('requestfailed', request => hostErrors.push(
        `${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`
      ));
      page.setDefaultTimeout(BROWSER_NAVIGATION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(BROWSER_NAVIGATION_TIMEOUT_MS);
      await page.goto(`http://127.0.0.1:${address.port}/runner.html`, {waitUntil: 'networkidle0'});
      await withTimeout(
        page.evaluate(() => globalThis.__smokeReady),
        BROWSER_READY_TIMEOUT_MS,
        `${projectPath}: official Scratch GUI readiness`
      );
      const bytes = await readFile(projectPath);
      const result = await withTimeout(page.evaluate(async options => {
        const {encoded, phaseTimeoutMs, rendererSnapshotTimeoutMs} = options;
        const decode = value => Uint8Array.from(globalThis.atob(value), character => character.charCodeAt(0));
        const toBytes = async value => value instanceof Uint8Array
          ? value
          : new Uint8Array(await value.arrayBuffer());
        const withPhaseTimeout = async (operation, description, timeoutMs = phaseTimeoutMs) => {
          let timer;
          try {
            return await Promise.race([
              operation,
              new Promise((_, reject) => {
                timer = globalThis.setTimeout(() => {
                  reject(new Error(`${description} timed out after ${timeoutMs} ms`));
                }, timeoutMs);
              })
            ]);
          } finally {
            globalThis.clearTimeout(timer);
          }
        };
        const settle = () => new Promise(resolveFrame => globalThis.requestAnimationFrame(
          () => globalThis.requestAnimationFrame(() => resolveFrame())
        ));
        const state = globalThis.__smokeState;
        const vm = state.store.getState().scratchGui.vm;
        const snapshot = () => {
          const gui = state.store.getState().scratchGui;
          const guiSprites = gui.targets?.sprites;
          return {
            targetCount: vm.runtime.targets.length,
            targets: vm.runtime.targets.map(target => ({
              isStage: target.isStage,
              name: target.getName(),
              blockCount: Object.keys(target.blocks._blocks).length,
              symbols: Object.values(target.variables).map(variable => ({
                name: variable.name,
                type: variable.type
              }))
            })),
            guiStagePresent: Boolean(gui.targets?.stage),
            guiSpriteCount: Array.isArray(guiSprites)
              ? guiSprites.length
              : guiSprites && typeof guiSprites === 'object'
                ? Object.keys(guiSprites).length
                : -1
          };
        };
        const stagePixels = description => withPhaseTimeout(
          new Promise(resolveSnapshot => vm.renderer.requestSnapshot(resolveSnapshot)),
          description,
          rendererSnapshotTimeoutMs
        );

        await withPhaseTimeout(vm.loadProject(decode(encoded)), 'initial project load');
        await withPhaseTimeout(settle(), 'initial renderer settle');
        const firstLoad = snapshot();
        const firstPixels = await stagePixels('initial renderer snapshot');
        const firstBytes = await withPhaseTimeout(
          (async () => toBytes(await vm.saveProjectSb3()))(),
          'first project save'
        );
        await withPhaseTimeout(vm.loadProject(firstBytes), 'serialized project reload');
        await withPhaseTimeout(settle(), 'reloaded renderer settle');
        const secondLoad = snapshot();
        const secondPixels = await stagePixels('reloaded renderer snapshot');
        const secondBytes = await withPhaseTimeout(
          (async () => toBytes(await vm.saveProjectSb3()))(),
          'second project save'
        );
        return {
          errors: globalThis.__smokeErrors.slice(),
          editorMounted: globalThis.document.querySelector('#app')?.children.length > 0,
          canvasCount: globalThis.document.querySelectorAll('canvas').length,
          firstSize: firstBytes.byteLength,
          secondSize: secondBytes.byteLength,
          firstLoad,
          secondLoad,
          visualRoundtripEqual: firstPixels.length > 100 && firstPixels === secondPixels
        };
      }, {
        encoded: bytes.toString('base64'),
        phaseTimeoutMs: PROJECT_PHASE_TIMEOUT_MS,
        rendererSnapshotTimeoutMs: RENDERER_SNAPSHOT_TIMEOUT_MS
      }), PROJECT_ROUNDTRIP_TIMEOUT_MS, `${projectPath}: official Scratch GUI project roundtrip`);
      await page.close();
      if (
        hostErrors.length > 0
        || result.errors.length > 0
        || !result.editorMounted
        || result.canvasCount === 0
        || result.firstSize === 0
        || result.secondSize === 0
        || result.firstLoad.targetCount === 0
        || result.firstLoad.guiSpriteCount < 0
        || JSON.stringify(result.firstLoad) !== JSON.stringify(result.secondLoad)
        || !result.visualRoundtripEqual
      ) {
        throw new Error(`${projectPath}: official Scratch GUI roundtrip failed: ${JSON.stringify({hostErrors, result})}`);
      }
      process.stdout.write(
        `Official Scratch GUI roundtrip OK: ${projectPath} (${result.firstLoad.targetCount} targets)\n`
      );
    }
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(() => resolveClose()));
  }
}
