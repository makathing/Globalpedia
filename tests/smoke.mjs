// End-to-end smoke test against `vite preview` using headless Chromium (SwiftShader WebGL).
// Run: npm run build && npm run smoke
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = 4173;
const OUT = new URL('../scratch/smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  preview.stdout.on('data', (d) => { if (String(d).includes('http://')) res(); });
  preview.on('exit', (c) => rej(new Error(`preview exited ${c}`)));
  setTimeout(() => rej(new Error('preview timeout')), 20000);
});

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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

  // Globe canvas has non-transparent pixels.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#globe canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return -1;
    const px = new Uint8Array(4 * 64 * 64);
    gl.readPixels((c.width / 2) | 0, (c.height / 2) | 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    return n;
  });
  check(painted !== 0, `globe canvas painted (centre sample alpha count: ${painted}; -1 = context not readable, tolerated)`);

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
