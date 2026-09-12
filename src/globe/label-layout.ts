/**
 * Where every country name is *printed* on the map raster.
 *
 * The names are no longer billboards — they are part of the paper, so their position,
 * size and horizontal stretch have to be decided once, in texture space, before anything
 * is drawn. Three modules consume the result: `texture.ts` prints it and stamps it into
 * the pick index, and `highlight.ts` underlines it.
 *
 * ## The one piece of real maths here
 *
 * An equirectangular raster wrapped on a sphere is compressed horizontally by `cos(lat)`:
 * a 100-texel run at the equator subtends 100/8192 of a full turn, but the same run at 60°N
 * sits on a parallel of half the circumference, so it covers twice the angle and arrives on
 * screen half as wide. Type drawn at uniform width therefore looks progressively squeezed
 * towards the poles — the classic giveaway of a name pasted onto a texture rather than
 * printed on gores. Pre-stretching the glyphs by `scaleX = 1 / cos(lat)` in texture space
 * cancels it exactly, which is what a real globe's printed gores do mechanically.
 *
 * The stretch is clamped (`MAX_SCALE_X`) because `1/cos` runs away at the poles, and the
 * anchor latitude is clamped to `MAX_LABEL_LAT` so nothing is printed into the polar caps
 * (`surface.ts` paints those over the top) or into the region where the sampler smears.
 *
 * Vertical needs no correction: `y` is linear in latitude and so is arc length along a
 * meridian, so a glyph's height survives the mapping unchanged.
 */
import type { CountryRecord } from '../core/types';
import { clamp, projectX, projectY } from './math';
import { hashString, mulberry32 } from './surface';

/** All coordinates and sizes below are in this raster. Consumers scale by `width / LABEL_REF_WIDTH`. */
export const LABEL_REF_WIDTH = 8192;
export const LABEL_REF_HEIGHT = 4096;

export const LABEL_FONT_FAMILY = 'Georgia, "Times New Roman", "DejaVu Serif", serif';
export function labelFont(px: number): string {
  return `${px}px ${LABEL_FONT_FAMILY}`;
}

/**
 * Glyph height in reference (8192-wide) texels, largest first.
 *
 * Calibration: at 8192 across, with the globe about 700 px on screen, roughly 3.7 texels
 * land on one screen pixel at the centre of the disc — so divide by 3.7 for the em size a
 * viewer actually sees in the default pose. 96 → 26 px, 80 → 22 px, 66 → 18 px, 54 → 15 px,
 * 44 → 12 px, 36 → 10 px. The bottom rungs are deliberately below comfortable reading size:
 * they are the "lean in" tier, which is exactly how a printed globe behaves.
 */
export const FONT_LADDER: readonly number[] = [96, 80, 66, 54, 44, 36];

/** Area (km²) at or above which a country starts on ladder rung i. */
const TIER_AREA: readonly number[] = [2_500_000, 800_000, 250_000, 60_000, 10_000];

/** How many rungs a name may step down before it is dropped rather than overlap a neighbour. */
const MAX_STEP_DOWN = 2;

/** 1/cos(lat) past ~70.5° is more stretch than the glyphs survive; hold it here. */
const MAX_SCALE_X = 3;
/** No name is printed beyond this latitude; the anchor is clamped into the band. */
const MAX_LABEL_LAT = 74;

/** Printed type is never perfectly square to the line. Degrees. */
const TYPE_TILT_DEG = 0.6;

/** Padding around a name's box, as a fraction of the font size (x, y). */
const PAD_X = 0.28;
const PAD_Y = 0.16;

export interface PlacedLabel {
  iso3: string;
  name: string;
  /** Centre of the name in reference-raster pixels. */
  x: number;
  y: number;
  /** Glyph height in reference pixels. Vertical only — see `scaleX`. */
  fontPx: number;
  /** Horizontal pre-stretch that cancels the sphere's `cos(lat)` squeeze. ≥ 1. */
  scaleX: number;
  /** Axis-aligned box in reference pixels, stretch and padding included. */
  boxW: number;
  boxH: number;
  /** Sub-degree type tilt in radians, seeded from the ISO3 so it never moves. */
  tilt: number;
  /** Ink-spread stroke width for this name, in reference pixels. */
  bleed: number;
  /** Rung of `FONT_LADDER` actually used. */
  tier: number;
}

export interface LabelLayout {
  /** Reference raster the coordinates are expressed in. */
  width: number;
  height: number;
  /** Placed names, in print order (descending country area). */
  labels: readonly PlacedLabel[];
  byIso: ReadonlyMap<string, PlacedLabel>;
  /** Names that could not be placed without overlapping one already down. */
  skipped: readonly string[];
}

/** Width of `name` at 1 px, so a rung change is a multiply rather than a re-measure. */
export type MeasureFn = (name: string) => number;

const MEASURE_PX = 100;

function canvasMeasurer(): MeasureFn {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return (name) => name.length * 0.5;
  ctx.font = labelFont(MEASURE_PX);
  const cache = new Map<string, number>();
  return (name) => {
    let w = cache.get(name);
    if (w === undefined) {
      w = ctx.measureText(name).width / MEASURE_PX;
      cache.set(name, w);
    }
    return w;
  };
}

function tierFor(area: number): number {
  for (let i = 0; i < TIER_AREA.length; i++) if (area >= TIER_AREA[i]) return i;
  return TIER_AREA.length;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function overlaps(a: Box, b: Box, width: number): boolean {
  if (a.y1 <= b.y0 || b.y1 <= a.y0) return false;
  // The raster wraps at the antimeridian, so a box near either edge has two neighbours.
  for (const dx of [-width, 0, width]) {
    if (a.x0 + dx < b.x1 && b.x0 < a.x1 + dx) return true;
  }
  return false;
}

export interface LayoutOptions {
  /** Injected for tests; defaults to a 1×1 Canvas2D text measurer. */
  measure?: MeasureFn;
}

/**
 * Deterministic placement: by descending area (ties broken by ISO3), each name takes the
 * first ladder rung whose box clears everything already placed, stepping down at most
 * `MAX_STEP_DOWN` rungs before it is dropped. Nothing here reads the theme or the camera,
 * so the layout is computed exactly once for the life of the globe and is identical across
 * themes, raster sizes and reloads.
 */
export function layoutLabels(
  countries: Record<string, CountryRecord>,
  options: LayoutOptions = {},
): LabelLayout {
  const measure = options.measure ?? canvasMeasurer();
  const W = LABEL_REF_WIDTH;
  const H = LABEL_REF_HEIGHT;

  const order = Object.keys(countries)
    .filter((iso3) => {
      const rec = countries[iso3];
      return Boolean(rec && rec.name && Array.isArray(rec.latlng) && rec.latlng.length === 2);
    })
    .sort((a, b) => {
      const d = (countries[b].area ?? 0) - (countries[a].area ?? 0);
      return d !== 0 ? d : a < b ? -1 : 1;
    });

  const labels: PlacedLabel[] = [];
  const byIso = new Map<string, PlacedLabel>();
  const skipped: string[] = [];
  const boxes: Box[] = [];

  for (const iso3 of order) {
    const rec = countries[iso3];
    const [rawLat, lng] = rec.latlng;
    const lat = clamp(rawLat, -MAX_LABEL_LAT, MAX_LABEL_LAT);
    // 1 / cos(lat): the inverse of the sphere's horizontal compression. Clamped, never < 1.
    const scaleX = clamp(1 / Math.max(Math.cos((lat * Math.PI) / 180), 1e-3), 1, MAX_SCALE_X);

    const rnd = mulberry32(hashString(iso3));
    const tilt = (rnd() - 0.5) * 2 * TYPE_TILT_DEG * (Math.PI / 180);
    const bleedK = 0.006 + rnd() * 0.005;

    const unitW = measure(rec.name);
    const x = projectX(lng, W);
    const startTier = tierFor(rec.area ?? 0);
    const lastTier = Math.min(FONT_LADDER.length - 1, startTier + MAX_STEP_DOWN);

    let placed: PlacedLabel | null = null;
    for (let tier = startTier; tier <= lastTier; tier++) {
      const fontPx = FONT_LADDER[tier];
      const boxW = unitW * fontPx * scaleX + 2 * PAD_X * fontPx;
      const boxH = fontPx * (1.16 + 2 * PAD_Y);
      // Keep the whole box on the raster vertically; horizontally it may straddle the seam.
      const y = clamp(projectY(lat, H), boxH / 2, H - boxH / 2);
      const box: Box = { x0: x - boxW / 2, x1: x + boxW / 2, y0: y - boxH / 2, y1: y + boxH / 2 };
      let clear = true;
      for (const other of boxes) {
        if (overlaps(box, other, W)) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      boxes.push(box);
      placed = { iso3, name: rec.name, x, y, fontPx, scaleX, boxW, boxH, tilt, bleed: bleedK * fontPx, tier };
      break;
    }

    if (placed) {
      labels.push(placed);
      byIso.set(iso3, placed);
    } else {
      skipped.push(iso3);
    }
  }

  return { width: W, height: H, labels, byIso, skipped };
}
