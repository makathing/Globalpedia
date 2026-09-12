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
  console.error('✖ smoke test exceeded 600s — aborting');
  process.exit(1);
}, 600000);
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

  // --- printed labels and autonomous life ---------------------------------------------------
  // Hold the globe still for the duration: auto-rotate resumes on its own timer and
  // would otherwise land between two screenshots and masquerade as movement.
  await page.evaluate(() => window.__gp?.globe?.setAutoRotate(false));
  await page.waitForTimeout(3000);

  // At the default pose the creatures are out of range, so consecutive frames are identical.
  const farA = await page.screenshot({ clip });
  await page.waitForTimeout(2600);
  const farB = await page.screenshot({ clip });
  check(farA.equals(farB), 'nothing moves at the default pose (life is out of range)');

  // Lean in and they should be alive.
  const gb = await page.locator('#globe').boundingBox();
  for (let i = 0; i < 11; i++) {
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.wheel(0, -260);
    await page.waitForTimeout(280);
  }
  await page.waitForTimeout(3500);
  const nearA = await page.screenshot({ clip });
  await page.waitForTimeout(2600);
  const nearB = await page.screenshot({ clip });
  check(!nearA.equals(nearB), 'the globe is alive up close (ships and animals moving)');
  await page.screenshot({ path: `${OUT}20-life-close.png` });

  // Printed names scale with the globe: a billboard sprite would not have changed size.
  check(!farA.equals(nearA), 'printed names and surface scale with zoom');

  // Back out, and the world settles again.
  for (let i = 0; i < 11; i++) {
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(3000);
  const backA = await page.screenshot({ clip });
  await page.waitForTimeout(2600);
  const backB = await page.screenshot({ clip });
  check(backA.equals(backB), 'the render loop sleeps again once the camera pulls back');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  // --- themes ---------------------------------------------------------------------------------
  const THEME_IDS = ['classroom', 'chalkboard', 'atlas', 'blueprint', 'fieldnotes', 'nightstudy'];
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const toggle = page.locator('#header [data-gp-theme-toggle]');
  check((await toggle.count()) === 1, 'header has exactly one theme toggle');

  const rasters = new Map();
  for (const id of THEME_IDS) {
    await toggle.click();
    await page.waitForTimeout(250);
    const row = page.locator(`[data-gp-theme="${id}"]`);
    check((await row.count()) > 0, `picker offers "${id}"`);
    await row.first().click();
    // Phase 2 of the switch re-rasters the map on a later frame.
    await page.waitForTimeout(2200);

    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    check(applied === id, `data-theme is "${id}" after picking it`);
    rasters.set(id, await page.screenshot({ clip }));
    await page.screenshot({ path: `${OUT}10-theme-${id}.png` });
  }

  // Each theme must actually repaint the globe, not just flip the CSS.
  for (let i = 1; i < THEME_IDS.length; i++) {
    const a = THEME_IDS[i - 1];
    const b = THEME_IDS[i];
    check(!rasters.get(a).equals(rasters.get(b)), `globe raster differs between "${a}" and "${b}"`);
  }

  // Picking must survive a theme switch: the pick index is never rebuilt, so it should.
  await page.evaluate(() => window.__gp?.bus.emit('globe:select', { iso3: 'JPN' }));
  await page.waitForTimeout(700);
  check(/Japan/.test(await page.locator('#panel').innerText()), 'country select still works after theme switches');
  await page.keyboard.press('Escape');

  // The choice survives a reload, and is applied before first paint (no flash of default).
  await page.reload({ waitUntil: 'domcontentloaded' });
  const atFirstPaint = await page.evaluate(() => document.documentElement.dataset.theme);
  check(atFirstPaint === 'nightstudy', `theme is already "${atFirstPaint}" at domcontentloaded (no flash)`);
  await page.waitForTimeout(3000);
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'nightstudy', 'theme persists across reload');

  // Keyboard path: open, move, select, and focus comes back to the button.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await toggle.getAttribute('aria-expanded')) === 'true', 'Enter opens the picker');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const afterKeys = await page.evaluate(() => document.documentElement.dataset.theme);
  check(THEME_IDS.includes(afterKeys), `keyboard selection picked a theme ("${afterKeys}")`);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check((await toggle.getAttribute('aria-expanded')) === 'false', 'Escape closes the picker');
  check(await toggle.evaluate((el) => el === document.activeElement), 'Escape returns focus to the toggle');

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
