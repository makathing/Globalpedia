// Nothing on a third-party server may sit in front of the page's own code.
//
// This exists because it once did: `src/styles/app.css` opened with an
// `@import url('https://fonts.googleapis.com/...')`. A remote @import is discovered only
// after the stylesheet that contains it has been fetched and parsed, and it then blocks
// both rendering and script execution until it answers. The measured cost was 12.7 s from
// navigation to the first line of app code — the globe could not even begin to build until
// Google replied. Moving the same fonts to a non-blocking <link> in index.html took the same
// page from 12.85 s to 126 ms to DOMContentLoaded.
//
// The failure mode is silent and invisible on a fast connection, so it needs a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const REMOTE = /@import\s+(?:url\(\s*)?["']?(https?:)?\/\//i;

test('no stylesheet pulls a remote @import onto the critical path', () => {
  const dir = join(root, 'src/styles');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(dir, file), 'utf8');
    assert.ok(
      !REMOTE.test(css),
      `${file} has a remote @import. It blocks rendering AND script execution until the ` +
        `third party answers. Load it from index.html with media="print" onload="this.media='all'" instead.`,
    );
  }
});

test('every remote stylesheet in index.html is loaded without blocking', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  // Only look at the real document head, not the <noscript> fallback: with no JavaScript
  // there is no globe to hold up, so a plain blocking link there is correct.
  const head = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  const links = head.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi) ?? [];
  for (const link of links) {
    if (!/href=["']https?:\/\//i.test(link)) continue;
    assert.match(
      link,
      /media=["']print["']/,
      `A remote stylesheet in index.html is render-blocking:\n  ${link}\n` +
        `Give it media="print" onload="this.media='all'" so a slow font server cannot hold the page.`,
    );
    assert.match(link, /onload=["']this\.media='all'["']/, `${link} never flips back to media="all", so it would never apply.`);
  }
  assert.ok(links.length > 0, 'expected the webfonts to be loaded from index.html');
});

test('the built CSS carries no remote @import', () => {
  let assets;
  try {
    assets = readdirSync(join(root, 'dist/assets'));
  } catch {
    return; // no build to check; `npm run build` covers this in CI
  }
  for (const file of assets.filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(root, 'dist/assets', file), 'utf8');
    assert.ok(!REMOTE.test(css), `dist/assets/${file} still bundles a remote @import`);
  }
});
