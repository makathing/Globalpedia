/**
 * The six scholastic themes — the single source of truth for BOTH halves of a theme:
 * the page's CSS custom properties and the globe's rendered colors. The UI applies
 * `Theme.css` to the document element at runtime and the globe reads `Theme.globe`,
 * so the wall and the globe can never drift apart.
 *
 * Adding a theme: add its id to ThemeId and one entry to THEMES. Nothing else.
 *
 * Two rules this file must keep:
 *  1. `palette` is EXACTLY 8 entries. assignColors() in globe/texture.ts hands out
 *     indices into it and reads its length, so an 8-entry swap keeps every country's
 *     color slot. A different length reshuffles the whole map.
 *  2. `css` must never contain --gp-margin-x, --gp-gutter or --gp-panel-w. Those are
 *     set responsively in app.css, and applying them inline here would win on small
 *     screens and break the mobile layout.
 */

export type ThemeId = 'classroom' | 'chalkboard' | 'atlas' | 'blueprint' | 'fieldnotes' | 'nightstudy';

/** Eight fills, in the order the greedy adjacency coloring hands them out. */
export type Palette = readonly [string, string, string, string, string, string, string, string];

/** Everything the Three.js side needs to paint a theme. */
export interface GlobeTheme {
  /** Sea color, filled across the whole raster before land. */
  ocean: string;
  palette: Palette;
  /** Coastlines and borders. */
  outline: string;
  /** Stroke width at 8k; scaled down for a 4k raster. */
  outlineWidth: number;
  /** Graticule, tropics and equator. Usually the same ink as `outline`. */
  graticule: string;
  /** < 1 lets the ocean show through the fills, for line-work looks. */
  fillAlpha: number;
  /** Paper-grain noise over the raster. 0 disables it. */
  grainAlpha: number;
  /** Meridian ring, pole pins, finials, stem, band and collar share one material. */
  brass: number;
  /** The base disc. */
  wood: number;
  /** Multiplies the map texture. 0xffffff means no tint. */
  sphereTint: number;
  keyLight: { color: number; intensity: number };
  hemiLight: { sky: number; ground: number; intensity: number };
  ambient: number;
  labelInk: string;
  labelHalo: string;
  labelHover: string;
  highlightHoverFill: string;
  highlightHoverLine: string;
  highlightSelFill: string;
  highlightSelLine: string;
}

export interface Theme {
  id: ThemeId;
  /** Shown on the toggle and in the picker. */
  name: string;
  /** One line under the name in the picker. */
  blurb: string;
  /** [paper, globe] for the picker's split-circle chip. */
  swatch: [string, string];
  /** Custom properties (plus color-scheme) applied to <html>. See rule 2 above. */
  css: Record<string, string>;
  globe: GlobeTheme;
}

/* -- paper structures ---------------------------------------------------------------------- */

const VIGNETTE = 'radial-gradient(ellipse at 50% 45%, transparent 55%, var(--gp-vignette) 100%)';
const VIGNETTE_TIGHT = 'radial-gradient(ellipse at 50% 45%, transparent 42%, var(--gp-vignette) 100%)';
const VIGNETTE_WIDE = 'radial-gradient(ellipse at 50% 45%, transparent 62%, var(--gp-vignette) 100%)';

/** The red margin line down the left edge. */
const MARGIN_LINE =
  'linear-gradient(to right, transparent calc(var(--gp-margin-x) - 1px), var(--gp-margin) calc(var(--gp-margin-x) - 1px), var(--gp-margin) calc(var(--gp-margin-x) + 1px), transparent calc(var(--gp-margin-x) + 1px))';

/** Evenly spaced horizontal rules at --gp-rule-gap. */
const RULES =
  'repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--gp-rule-gap) - 1px), var(--gp-rule) calc(var(--gp-rule-gap) - 1px), var(--gp-rule) var(--gp-rule-gap))';

/** Vertical companion to RULES, making a square grid. */
const COLUMNS =
  'repeating-linear-gradient(to right, transparent 0, transparent calc(var(--gp-rule-gap) - 1px), var(--gp-rule) calc(var(--gp-rule-gap) - 1px), var(--gp-rule) var(--gp-rule-gap))';

/** The fine 8px grid under a graph-paper theme's coarse squares. */
const FINE_ROWS =
  'repeating-linear-gradient(to bottom, transparent 0, transparent 7px, var(--gp-rule-faint) 7px, var(--gp-rule-faint) 8px)';
const FINE_COLS =
  'repeating-linear-gradient(to right, transparent 0, transparent 7px, var(--gp-rule-faint) 7px, var(--gp-rule-faint) 8px)';

/** Fractal-noise grain. `tint` is an "r g b" triple in 0..1, `a` the noise alpha. */
const grain = (tint: string, a: number): string =>
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${tint.split(' ')[0]}  0 0 0 0 ${tint.split(' ')[1]}  0 0 0 0 ${tint.split(' ')[2]}  0 0 0 ${a} 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`;

const WARM_GRAIN = grain('0.45 0.40 0.33', 0.09);
const CHALK_GRAIN = grain('0.95 0.97 0.93', 0.11);
const SEPIA_GRAIN = grain('0.42 0.32 0.18', 0.12);
const COOL_GRAIN = grain('0.80 0.90 1.00', 0.07);

/* -- the themes ---------------------------------------------------------------------------- */

export const THEMES: readonly Theme[] = [
  {
    id: 'classroom',
    name: 'Classroom',
    blurb: 'Pastel countries on cream notebook paper',
    swatch: ['#fbf8f1', '#f2e2a3'],
    css: {
      'color-scheme': 'light',
      '--gp-paper': '#fbf8f1',
      '--gp-paper-2': '#f4efe3',
      '--gp-paper-image': [VIGNETTE, MARGIN_LINE, RULES].join(', '),
      '--gp-rule': 'rgba(72, 132, 196, 0.13)',
      '--gp-rule-faint': 'rgba(72, 132, 196, 0.07)',
      '--gp-margin': 'rgba(214, 92, 104, 0.38)',
      '--gp-rule-gap': '30px',
      '--gp-vignette': 'rgba(70, 50, 30, 0.10)',
      '--gp-grain-image': WARM_GRAIN,
      '--gp-grain-opacity': '0.55',
      '--gp-grain-blend': 'multiply',
      '--gp-shadow-rgb': '60, 40, 20',
      '--gp-ink': '#2b241f',
      '--gp-ink-2': '#5a5048',
      '--gp-ink-3': '#7d7269',
      '--gp-ink-faint': 'rgba(43, 36, 31, 0.12)',
      '--gp-ocean': '#bfe3f5',
      '--gp-land': '#f2dfa9',
      '--gp-brass': '#c99a3f',
      '--gp-accent': '#c8553d',
      '--gp-accent-ink': '#a53f2a',
      '--gp-blue': '#2f6f8f',
      '--gp-blue-ink': '#245a75',
      '--gp-focus': '#2f6f8f',
      '--gp-card': '#fffdf8',
      '--gp-card-rule': 'rgba(214, 92, 104, 0.35)',
      '--gp-card-line': 'rgba(72, 132, 196, 0.10)',
      '--gp-tape': 'rgba(255, 216, 128, 0.62)',
      '--gp-tape-edge': 'rgba(200, 150, 40, 0.28)',
      '--gp-chip': '#f3ecdc',
      '--gp-chip-hover': '#eadfc7',
      '--gp-skeleton-a': '#ede6d6',
      '--gp-skeleton-b': '#f7f2e7',
      '--gp-tooltip': '#fff8dc',
    },
    globe: {
      ocean: '#cfe6f2',
      palette: ['#f2e2a3', '#f0b9a4', '#c5d5ae', '#d5c5e4', '#f6d1ad', '#bfe1cf', '#a9c7e2', '#eac0cb'],
      outline: '#3b2f2a',
      outlineWidth: 1.5,
      graticule: '#3b2f2a',
      fillAlpha: 1,
      grainAlpha: 0.045,
      brass: 0xb8925a,
      wood: 0x4a2e1f,
      sphereTint: 0xffffff,
      keyLight: { color: 0xfff3e2, intensity: 2.4 },
      hemiLight: { sky: 0xfff9ef, ground: 0x9a8b7a, intensity: 1.1 },
      ambient: 0.25,
      labelInk: '#2b221e',
      labelHalo: 'rgba(255, 248, 232, 0.85)',
      labelHover: '#7a4a2a',
      highlightHoverFill: 'rgba(255, 176, 80, 0.30)',
      highlightHoverLine: 'rgba(160, 70, 20, 0.65)',
      highlightSelFill: 'rgba(240, 130, 45, 0.48)',
      highlightSelLine: 'rgba(150, 60, 15, 0.95)',
    },
  },

  {
    id: 'chalkboard',
    name: 'Chalkboard',
    blurb: 'Chalk on a slate-green classroom board',
    swatch: ['#2a3733', '#cfd7a8'],
    css: {
      'color-scheme': 'dark',
      '--gp-paper': '#2a3733',
      '--gp-paper-2': '#334340',
      '--gp-paper-image': [VIGNETTE, COLUMNS, RULES].join(', '),
      '--gp-rule': 'rgba(233, 240, 232, 0.06)',
      '--gp-rule-faint': 'rgba(233, 240, 232, 0.03)',
      '--gp-margin': 'rgba(240, 200, 200, 0.14)',
      '--gp-rule-gap': '34px',
      '--gp-vignette': 'rgba(0, 0, 0, 0.30)',
      '--gp-grain-image': CHALK_GRAIN,
      '--gp-grain-opacity': '0.40',
      '--gp-grain-blend': 'screen',
      '--gp-shadow-rgb': '0, 0, 0',
      '--gp-ink': '#eef2ea',
      '--gp-ink-2': '#c5cfc3',
      '--gp-ink-3': '#9aa698',
      '--gp-ink-faint': 'rgba(238, 242, 234, 0.14)',
      '--gp-ocean': '#5c7a82',
      '--gp-land': '#cfd7a8',
      '--gp-brass': '#b9c4c0',
      '--gp-accent': '#ffe9a8',
      '--gp-accent-ink': '#ffe9a8',
      '--gp-blue': '#a8cfdc',
      '--gp-blue-ink': '#c2e2ec',
      '--gp-focus': '#ffe9a8',
      '--gp-card': '#35443f',
      '--gp-card-rule': 'rgba(255, 233, 168, 0.40)',
      '--gp-card-line': 'rgba(233, 240, 232, 0.07)',
      '--gp-tape': 'rgba(233, 240, 232, 0.26)',
      '--gp-tape-edge': 'rgba(233, 240, 232, 0.16)',
      '--gp-chip': '#3f4f4a',
      '--gp-chip-hover': '#4b5c56',
      '--gp-skeleton-a': '#3a4a45',
      '--gp-skeleton-b': '#445551',
      '--gp-tooltip': '#3f4f4a',
    },
    globe: {
      ocean: '#3f5259',
      palette: ['#cfd7a8', '#e0b6a8', '#a9c2ab', '#c0b6d2', '#e3c9a6', '#a8ccbc', '#a4bcd0', '#d5b3bd'],
      outline: '#f2f6ee',
      outlineWidth: 1.6,
      graticule: '#f2f6ee',
      fillAlpha: 0.88,
      grainAlpha: 0.07,
      brass: 0x9aa6a2,
      wood: 0x4c5551,
      sphereTint: 0xffffff,
      keyLight: { color: 0xe8f0ea, intensity: 2.2 },
      hemiLight: { sky: 0xdfe8e0, ground: 0x5a6560, intensity: 1.0 },
      ambient: 0.3,
      labelInk: '#f6faf2',
      labelHalo: 'rgba(28, 40, 36, 0.78)',
      labelHover: '#ffe9a8',
      highlightHoverFill: 'rgba(255, 233, 150, 0.26)',
      highlightHoverLine: 'rgba(255, 242, 190, 0.70)',
      highlightSelFill: 'rgba(255, 226, 130, 0.42)',
      highlightSelLine: 'rgba(255, 248, 210, 0.95)',
    },
  },

  {
    id: 'atlas',
    name: 'Vintage Atlas',
    blurb: 'Ochre and umber on aged parchment',
    swatch: ['#e8dcc0', '#d9b878'],
    css: {
      'color-scheme': 'light',
      '--gp-paper': '#e8dcc0',
      '--gp-paper-2': '#ddcfae',
      '--gp-paper-image': [VIGNETTE_TIGHT, RULES].join(', '),
      '--gp-rule': 'rgba(120, 90, 55, 0.13)',
      '--gp-rule-faint': 'rgba(120, 90, 55, 0.07)',
      '--gp-margin': 'rgba(150, 100, 60, 0.30)',
      '--gp-rule-gap': '32px',
      '--gp-vignette': 'rgba(92, 62, 28, 0.26)',
      '--gp-grain-image': SEPIA_GRAIN,
      '--gp-grain-opacity': '0.62',
      '--gp-grain-blend': 'multiply',
      '--gp-shadow-rgb': '78, 52, 24',
      '--gp-ink': '#3a2c1c',
      '--gp-ink-2': '#5f4c33',
      '--gp-ink-3': '#806a4d',
      '--gp-ink-faint': 'rgba(58, 44, 28, 0.16)',
      '--gp-ocean': '#b9c6b4',
      '--gp-land': '#d9b878',
      '--gp-brass': '#a8813c',
      '--gp-accent': '#9c4a22',
      '--gp-accent-ink': '#7d3a1a',
      '--gp-blue': '#4a6b6a',
      '--gp-blue-ink': '#3a5655',
      '--gp-focus': '#7d3a1a',
      '--gp-card': '#f2e8d2',
      '--gp-card-rule': 'rgba(156, 74, 34, 0.35)',
      '--gp-card-line': 'rgba(120, 90, 55, 0.12)',
      '--gp-tape': 'rgba(214, 180, 120, 0.60)',
      '--gp-tape-edge': 'rgba(150, 110, 50, 0.30)',
      '--gp-chip': '#e2d4b4',
      '--gp-chip-hover': '#d6c59f',
      '--gp-skeleton-a': '#ddcfae',
      '--gp-skeleton-b': '#ece0c6',
      '--gp-tooltip': '#f6ecd6',
    },
    globe: {
      ocean: '#b9c6b4',
      palette: ['#d9b878', '#c9906a', '#a9a86a', '#bfa48c', '#e0c48f', '#93a583', '#8fa39a', '#c9a0a0'],
      outline: '#4a3520',
      outlineWidth: 1.5,
      graticule: '#4a3520',
      fillAlpha: 1,
      grainAlpha: 0.075,
      brass: 0xa8813c,
      wood: 0x3a2114,
      sphereTint: 0xffffff,
      keyLight: { color: 0xfff0d8, intensity: 2.3 },
      hemiLight: { sky: 0xfff4e0, ground: 0x8a7a60, intensity: 1.0 },
      ambient: 0.28,
      labelInk: '#3a2c1c',
      labelHalo: 'rgba(242, 232, 206, 0.88)',
      labelHover: '#8a4a1a',
      highlightHoverFill: 'rgba(200, 130, 60, 0.28)',
      highlightHoverLine: 'rgba(120, 60, 20, 0.65)',
      highlightSelFill: 'rgba(190, 100, 40, 0.46)',
      highlightSelLine: 'rgba(110, 50, 14, 0.95)',
    },
  },

  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'White line-work on indigo drafting paper',
    swatch: ['#12243f', '#9bd8ea'],
    css: {
      'color-scheme': 'dark',
      '--gp-paper': '#12243f',
      '--gp-paper-2': '#182e4e',
      '--gp-paper-image': [VIGNETTE_WIDE, COLUMNS, RULES, FINE_COLS, FINE_ROWS].join(', '),
      '--gp-rule': 'rgba(190, 220, 255, 0.13)',
      '--gp-rule-faint': 'rgba(190, 220, 255, 0.05)',
      '--gp-margin': 'rgba(190, 220, 255, 0.20)',
      '--gp-rule-gap': '40px',
      '--gp-vignette': 'rgba(0, 8, 24, 0.42)',
      '--gp-grain-image': COOL_GRAIN,
      '--gp-grain-opacity': '0.22',
      '--gp-grain-blend': 'screen',
      '--gp-shadow-rgb': '0, 6, 20',
      '--gp-ink': '#e6f0fb',
      '--gp-ink-2': '#b8cde4',
      '--gp-ink-3': '#8ba5c2',
      '--gp-ink-faint': 'rgba(230, 240, 251, 0.16)',
      '--gp-ocean': '#7fc4dc',
      '--gp-land': '#9bd8ea',
      '--gp-brass': '#b6c8d8',
      '--gp-accent': '#ffd98a',
      '--gp-accent-ink': '#ffd98a',
      '--gp-blue': '#9bd8ea',
      '--gp-blue-ink': '#bce8f6',
      '--gp-focus': '#ffd98a',
      '--gp-card': '#1b3454',
      '--gp-card-rule': 'rgba(255, 217, 138, 0.40)',
      '--gp-card-line': 'rgba(190, 220, 255, 0.09)',
      '--gp-tape': 'rgba(190, 220, 255, 0.24)',
      '--gp-tape-edge': 'rgba(190, 220, 255, 0.16)',
      '--gp-chip': '#24405f',
      '--gp-chip-hover': '#2e4d70',
      '--gp-skeleton-a': '#1f3a5b',
      '--gp-skeleton-b': '#284566',
      '--gp-tooltip': '#24405f',
    },
    globe: {
      ocean: '#0e1c31',
      palette: ['#5aa8c8', '#7fc4dc', '#9bd8ea', '#4e97b8', '#6fb8d2', '#8ccfe2', '#a8e0ee', '#5fb0cc'],
      outline: '#eaf6ff',
      outlineWidth: 2,
      graticule: '#cfe6ff',
      fillAlpha: 0.36,
      grainAlpha: 0,
      brass: 0x9fb4c6,
      wood: 0x243a52,
      sphereTint: 0xffffff,
      keyLight: { color: 0xdfeeff, intensity: 2.6 },
      hemiLight: { sky: 0xcfe4ff, ground: 0x24384f, intensity: 1.2 },
      ambient: 0.35,
      labelInk: '#eaf6ff',
      labelHalo: 'rgba(10, 24, 44, 0.82)',
      labelHover: '#ffd98a',
      highlightHoverFill: 'rgba(255, 217, 138, 0.24)',
      highlightHoverLine: 'rgba(255, 233, 180, 0.72)',
      highlightSelFill: 'rgba(255, 200, 100, 0.40)',
      highlightSelLine: 'rgba(255, 240, 200, 0.95)',
    },
  },

  {
    id: 'fieldnotes',
    name: 'Field Notebook',
    blurb: 'Botanical greens on graph paper',
    swatch: ['#eef3e6', '#cfd9a8'],
    css: {
      'color-scheme': 'light',
      '--gp-paper': '#eef3e6',
      '--gp-paper-2': '#e2e9d6',
      '--gp-paper-image': [VIGNETTE_WIDE, COLUMNS, RULES, FINE_COLS, FINE_ROWS].join(', '),
      '--gp-rule': 'rgba(96, 134, 96, 0.20)',
      '--gp-rule-faint': 'rgba(96, 134, 96, 0.09)',
      '--gp-margin': 'rgba(96, 134, 96, 0.24)',
      '--gp-rule-gap': '24px',
      '--gp-vignette': 'rgba(50, 66, 40, 0.10)',
      '--gp-grain-image': WARM_GRAIN,
      '--gp-grain-opacity': '0.42',
      '--gp-grain-blend': 'multiply',
      '--gp-shadow-rgb': '44, 56, 34',
      '--gp-ink': '#2c3524',
      '--gp-ink-2': '#56604a',
      '--gp-ink-3': '#7b8570',
      '--gp-ink-faint': 'rgba(44, 53, 36, 0.14)',
      '--gp-ocean': '#c6dcd6',
      '--gp-land': '#cfd9a8',
      '--gp-brass': '#9c7a4a',
      '--gp-accent': '#8a5a2a',
      '--gp-accent-ink': '#6e4620',
      '--gp-blue': '#4a7a72',
      '--gp-blue-ink': '#3a625c',
      '--gp-focus': '#4a7a72',
      '--gp-card': '#f6faf0',
      '--gp-card-rule': 'rgba(138, 90, 42, 0.32)',
      '--gp-card-line': 'rgba(96, 134, 96, 0.13)',
      '--gp-tape': 'rgba(210, 226, 170, 0.62)',
      '--gp-tape-edge': 'rgba(120, 150, 80, 0.30)',
      '--gp-chip': '#e4ecd8',
      '--gp-chip-hover': '#d6e0c6',
      '--gp-skeleton-a': '#e2e9d6',
      '--gp-skeleton-b': '#f0f5e8',
      '--gp-tooltip': '#f2f8e6',
    },
    globe: {
      ocean: '#c6dcd6',
      palette: ['#cfd9a8', '#d9bb92', '#a8c6a0', '#c8b4a0', '#e2d2a8', '#9fc2b0', '#b6c8d2', '#d2b0ac'],
      outline: '#3d4a32',
      outlineWidth: 1.5,
      graticule: '#3d4a32',
      fillAlpha: 1,
      grainAlpha: 0.04,
      brass: 0x9c7a4a,
      wood: 0x5c4326,
      sphereTint: 0xffffff,
      keyLight: { color: 0xfdfff6, intensity: 2.4 },
      hemiLight: { sky: 0xf4ffe8, ground: 0x8a9480, intensity: 1.1 },
      ambient: 0.26,
      labelInk: '#2c3524',
      labelHalo: 'rgba(246, 250, 238, 0.90)',
      labelHover: '#6a7a2a',
      highlightHoverFill: 'rgba(230, 170, 80, 0.28)',
      highlightHoverLine: 'rgba(130, 90, 30, 0.65)',
      highlightSelFill: 'rgba(220, 140, 50, 0.44)',
      highlightSelLine: 'rgba(110, 70, 18, 0.95)',
    },
  },

  {
    id: 'nightstudy',
    name: 'Night Study',
    blurb: 'A desk lamp on dark navy paper',
    swatch: ['#171d2b', '#c8b06a'],
    css: {
      'color-scheme': 'dark',
      '--gp-paper': '#171d2b',
      '--gp-paper-2': '#1f2637',
      '--gp-paper-image': [VIGNETTE_TIGHT, MARGIN_LINE, RULES].join(', '),
      '--gp-rule': 'rgba(130, 165, 215, 0.08)',
      '--gp-rule-faint': 'rgba(130, 165, 215, 0.04)',
      '--gp-margin': 'rgba(214, 120, 110, 0.22)',
      '--gp-rule-gap': '30px',
      '--gp-vignette': 'rgba(0, 0, 0, 0.46)',
      '--gp-grain-image': COOL_GRAIN,
      '--gp-grain-opacity': '0.26',
      '--gp-grain-blend': 'screen',
      '--gp-shadow-rgb': '0, 0, 0',
      '--gp-ink': '#e8e2d4',
      '--gp-ink-2': '#bfb8a8',
      '--gp-ink-3': '#8f887b',
      '--gp-ink-faint': 'rgba(232, 226, 212, 0.14)',
      '--gp-ocean': '#4e8894',
      '--gp-land': '#c8b06a',
      '--gp-brass': '#c9a05a',
      '--gp-accent': '#e08a6a',
      '--gp-accent-ink': '#f0a288',
      '--gp-blue': '#7fb8cc',
      '--gp-blue-ink': '#9ccfe0',
      '--gp-focus': '#f0c078',
      '--gp-card': '#232b3d',
      '--gp-card-rule': 'rgba(224, 138, 106, 0.42)',
      '--gp-card-line': 'rgba(130, 165, 215, 0.08)',
      '--gp-tape': 'rgba(240, 200, 120, 0.30)',
      '--gp-tape-edge': 'rgba(240, 200, 120, 0.18)',
      '--gp-chip': '#2c3548',
      '--gp-chip-hover': '#374157',
      '--gp-skeleton-a': '#262e40',
      '--gp-skeleton-b': '#303a4e',
      '--gp-tooltip': '#2c3548',
    },
    globe: {
      ocean: '#2a5f6c',
      palette: ['#c8b06a', '#c08a76', '#8aa676', '#9a86b4', '#cfa273', '#79ae96', '#7b9fc0', '#bb8496'],
      outline: '#0e171b',
      outlineWidth: 1.5,
      graticule: '#0e171b',
      fillAlpha: 1,
      grainAlpha: 0.05,
      brass: 0xc9a05a,
      wood: 0x38251a,
      sphereTint: 0xffffff,
      keyLight: { color: 0xffe0b0, intensity: 2.3 },
      hemiLight: { sky: 0xffe8c8, ground: 0x2a3038, intensity: 0.9 },
      ambient: 0.22,
      labelInk: '#f2ece0',
      labelHalo: 'rgba(16, 24, 32, 0.80)',
      labelHover: '#ffcf8a',
      highlightHoverFill: 'rgba(255, 200, 120, 0.26)',
      highlightHoverLine: 'rgba(255, 220, 160, 0.70)',
      highlightSelFill: 'rgba(250, 180, 90, 0.44)',
      highlightSelLine: 'rgba(255, 232, 180, 0.95)',
    },
  },
];

export const DEFAULT_THEME: ThemeId = 'classroom';
/** Used when nothing is saved and the OS asks for dark. */
export const DEFAULT_DARK_THEME: ThemeId = 'nightstudy';

const BY_ID = new Map<string, Theme>(THEMES.map((t) => [t.id, t]));

export function isThemeId(id: unknown): id is ThemeId {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Look up a theme, falling back to the default for anything unrecognized. */
export function themeById(id: string | null | undefined): Theme {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_THEME)!;
}
