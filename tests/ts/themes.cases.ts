/**
 * Guards on src/core/themes.ts. Run via tests/themes.test.mjs.
 * Named *.cases.ts so the default `node --test` glob does not pick it up twice.
 *
 * Six palettes are easy to get subtly wrong, and a theme that is handsome but
 * unreadable is a bug. These tests are the cheap way to catch that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_THEME, DEFAULT_DARK_THEME, themeById, isThemeId } from '../../src/core/themes.ts';

type RGB = [number, number, number];

function hex(color: string): RGB | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(color: string): { rgb: RGB; a: number } | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (!m) return null;
  const p = m[1].split(',').map((s) => parseFloat(s));
  if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
  return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]: RGB): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio. */
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a translucent color over an opaque backdrop. */
function composite(over: string, backdrop: RGB): RGB {
  const c = rgba(over);
  if (!c) return hex(over) ?? backdrop;
  return [0, 1, 2].map((i) => Math.round(c.rgb[i] * c.a + backdrop[i] * (1 - c.a))) as RGB;
}

test('there are six themes with unique ids', () => {
  assert.equal(THEMES.length, 6);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, 6);
});

test('every palette is exactly 8 entries of valid hex', () => {
  // Load-bearing: globe/texture.ts hands out indices into this array and reads its
  // length. A different length reshuffles every country's color across themes.
  for (const t of THEMES) {
    assert.equal(t.globe.palette.length, 8, `${t.id} palette must have 8 entries`);
    for (const c of t.globe.palette) assert.ok(hex(c), `${t.id} palette entry ${c} is not hex`);
  }
});

test('body ink clears 4.5:1 against its paper', () => {
  for (const t of THEMES) {
    const ink = hex(t.css['--gp-ink']);
    const paper = hex(t.css['--gp-paper']);
    assert.ok(ink && paper, `${t.id} needs hex --gp-ink and --gp-paper`);
    const ratio = contrast(ink, paper);
    assert.ok(ratio >= 4.5, `${t.id} body ink on paper is ${ratio.toFixed(2)}:1, needs 4.5`);
  }
});

test('label ink clears 4.5:1 over its halo on every backdrop it can land on', () => {
  // Labels sit on a halo, which sits on either the ocean or any of the 8 land fills.
  for (const t of THEMES) {
    const ink = hex(t.globe.labelInk);
    assert.ok(ink, `${t.id} labelInk must be hex`);
    const backdrops = [t.globe.ocean, ...t.globe.palette].map((c) => hex(c)!);
    for (const bg of backdrops) {
      const ratio = contrast(ink, composite(t.globe.labelHalo, bg));
      assert.ok(ratio >= 4.5, `${t.id} label ink over halo on ${bg} is ${ratio.toFixed(2)}:1, needs 4.5`);
    }
  }
});

test('coastlines stay visible against the ocean', () => {
  for (const t of THEMES) {
    const ratio = contrast(hex(t.globe.outline)!, hex(t.globe.ocean)!);
    assert.ok(ratio >= 1.6, `${t.id} outline on ocean is ${ratio.toFixed(2)}:1, needs 1.6`);
  }
});

test('neighbouring palette entries are distinguishable from each other', () => {
  // The adjacency coloring guarantees neighbours get different slots, but two slots
  // that look identical would defeat that.
  for (const t of THEMES) {
    const pal = t.globe.palette.map((c) => hex(c)!);
    for (let i = 0; i < pal.length; i++) {
      for (let j = i + 1; j < pal.length; j++) {
        const d = Math.abs(luminance(pal[i]) - luminance(pal[j]));
        const hueGap = Math.max(...[0, 1, 2].map((k) => Math.abs(pal[i][k] - pal[j][k])));
        assert.ok(d > 0.012 || hueGap > 18, `${t.id} palette slots ${i} and ${j} are too alike`);
      }
    }
  }
});

test('themes never set the responsive layout tokens', () => {
  // These are set by media queries in app.css; applying them inline from a theme
  // would win on small screens and break the mobile layout.
  const forbidden = ['--gp-margin-x', '--gp-gutter', '--gp-panel-w'];
  for (const t of THEMES) {
    for (const key of forbidden) {
      assert.ok(!(key in t.css), `${t.id} must not set ${key}`);
    }
  }
});

test('every theme carries the tokens the page needs', () => {
  const required = [
    'color-scheme', '--gp-paper', '--gp-paper-2', '--gp-paper-image', '--gp-rule', '--gp-rule-faint',
    '--gp-rule-gap', '--gp-vignette', '--gp-grain-image', '--gp-grain-opacity', '--gp-grain-blend',
    '--gp-shadow-rgb', '--gp-ink', '--gp-ink-2', '--gp-ink-3', '--gp-ink-faint', '--gp-ocean',
    '--gp-land', '--gp-brass', '--gp-accent', '--gp-accent-ink', '--gp-focus', '--gp-card',
    '--gp-chip', '--gp-tooltip',
  ];
  for (const t of THEMES) {
    for (const key of required) {
      assert.ok(t.css[key], `${t.id} is missing ${key}`);
    }
    assert.ok(t.name && t.blurb, `${t.id} needs a name and blurb`);
    assert.equal(t.swatch.length, 2, `${t.id} needs a two-color swatch`);
  }
});

test('themeById falls back to the default for anything unrecognized', () => {
  assert.equal(themeById('blueprint').id, 'blueprint');
  assert.equal(themeById('nope').id, DEFAULT_THEME);
  assert.equal(themeById(null).id, DEFAULT_THEME);
  assert.equal(themeById(undefined).id, DEFAULT_THEME);
  assert.ok(isThemeId(DEFAULT_DARK_THEME));
  assert.ok(!isThemeId('nope'));
});
