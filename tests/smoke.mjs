// End-to-end smoke test against `vite preview` using headless Chromium (SwiftShader WebGL).
// Run: npm run build && npm run smoke
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

// This sandbox routes HTTPS through an agent proxy; localhost must bypass it or the
// readiness poll hangs. Also never let the run wedge forever.
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
const watchdog = setTimeout(() => {
  console.error('✖ smoke test exceeded 240s — aborting');
  process.exit(1);
}, 240000);
watchdog.unref();

/** Pick a free port so a stray dev server never blocks the run. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Use whatever Chromium this machine already has. The sandbox ships a pinned build under
 * PLAYWRIGHT_BROWSERS_PATH that may not match the npm playwright version; on CI the
 * bundled download is correct, so fall back to Playwright's own resolution.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const PORT = await freePort();
const OUT = new URL('../scratch/smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
let previewLog = '';
preview.stdout.on('data', (d) => { previewLog += d; });
preview.stderr.on('data', (d) => { previewLog += d; });

// Poll the port rather than parsing startup logs, whose wording varies between Vite versions.
await (async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (preview.exitCode !== null) throw new Error(`preview exited ${preview.exitCode}:\n${previewLog}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`preview never became ready on port ${PORT}:\n${previewLog}`);
})();
console.log(`preview ready on ${PORT}`);

const executablePath = findChromium();
console.log(`chromium: ${executablePath ?? 'playwright default'}`);
const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✖'} ${msg}`); if (!ok) fails.push(msg); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Wikipedia is not reachable from CI sandboxes: block it so the fallback path is exercised deterministically.
  await page.route(/wikipedia\.org|wikimedia\.org/, (r) => r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#globe canvas') !== null, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}01-home.png` });

  // Prove the globe actually renders: reading the WebGL buffer directly is unreliable
  // (it is cleared after compositing unless preserveDrawingBuffer is on), so compare
  // screenshots of the globe region before and after rotating to another continent.
  const globeBox = await page.locator('#globe').boundingBox();
  const clip = {
    x: globeBox.x + globeBox.width * 0.2,
    y: globeBox.y + globeBox.height * 0.2,
    width: Math.floor(globeBox.width * 0.5),
    height: Math.floor(globeBox.height * 0.5),
  };
  const before = await page.screenshot({ clip });
  // A blank paper region compresses to almost nothing; a drawn globe does not.
  check(before.length > 20000, `globe region has detail (${before.length} bytes of PNG)`);

  await page.evaluate(() => window.__gp?.bus.emit('ui:flyTo', { iso3: 'AUS' }));
  await page.waitForTimeout(1800);
  const after = await page.screenshot({ clip });
  check(!before.equals(after), 'globe region changes after flying to Australia');
  await page.screenshot({ path: `${OUT}01b-australia.png` });

  // Select via the bus (exposed for tests) and via search.
  await page.evaluate(() => window.__gp?.bus.emit('globe:select', { iso3: 'FRA' }));
  await page.waitForTimeout(800);
  const panelText = await page.locator('#panel').innerText();
  check(/France/.test(panelText), 'panel shows France');
  check(/Paris/.test(panelText), 'panel shows capital Paris');
  check(/French/.test(panelText), 'panel shows language French');
  check(panelText.length > 800, `panel has article text (${panelText.length} chars)`);
  await page.screenshot({ path: `${OUT}02-france.png` });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const search = page.locator('input[type="search"], input[role="combobox"]').first();
  await search.fill('Jap');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const t2 = await page.locator('#panel').innerText();
  check(/Japan/.test(t2) && /Tokyo/.test(t2), 'search "Jap" → Japan / Tokyo');
  await page.screenshot({ path: `${OUT}03-japan.png` });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.route(/wikipedia\.org|wikimedia\.org/, (r) => r.abort());
  await mobile.goto(`http://localhost:${PORT}/#BRA`, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(3000);
  await mobile.screenshot({ path: `${OUT}04-mobile-brazil.png` });
  check(/Brazil/.test(await mobile.locator('#panel').innerText()), 'deep link #BRA opens Brazil on mobile');

  const realErrors = errors.filter((e) => !/wikipedia|wikimedia|Failed to load resource|ERR_FAILED|net::/i.test(e));
  check(realErrors.length === 0, `no page errors${realErrors.length ? ': ' + realErrors.join(' | ') : ''}`);
} finally {
  await browser.close();
  preview.kill();
}
console.log(`Screenshots in ${OUT}`);
if (fails.length) { console.error(`${fails.length} smoke check(s) failed`); process.exit(1); }
