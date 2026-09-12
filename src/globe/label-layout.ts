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
export const FONT_LADDER: readonly number[] = [96, 80, 66, 54, 44, 36, 30, 25, 21];

/** Area (km²) at or above which a country starts on ladder rung i. */
const TIER_AREA: readonly number[] = [2_500_000, 800_000, 250_000, 60_000, 10_000];

/** How many rungs a name may step down before it is dropped rather than overlap a neighbour. */
const MAX_STEP_DOWN = 6;

/**
 * A name may also slide a little off its anchor before it gives up the rung — the move every
 * atlas makes for a country wedged against a bigger neighbour (Norway beside Sweden, Poland
 * between Germany and Belarus). Capped hard in degrees as well as in box fractions, so a name
 * can shuffle out of a collision but can never wander far enough to sit over another country.
 */
const NUDGE_Y_FRACTION = 0.8; // of the box height
const NUDGE_X_FRACTION = 0.45; // of the box width
const MAX_NUDGE_LAT_DEG = 4.5;
const MAX_NUDGE_LNG_DEG = 6;

/**
 * …and never further than the country itself reaches. Without this a nudge of four degrees
 * walks Nepal's name into Tibet — which both reads wrong and, because a label may never take
 * a pixel that belongs to a polygon, makes the name unclickable. `sqrt(area / π) / 111` is the
 * radius of an equal-area disc in degrees: crude, but it is the right order of magnitude and
 * the only size signal the data carries.
 */
function reachDeg(areaKm2: number): number {
  if (!(areaKm2 > 0)) return 0;
  return Math.sqrt(areaKm2 / Math.PI) / 111;
}

/**
 * Is the whole middle of the name standing on its own country (or on nothing)?
 *
 * Five probes, not one: the middle, a third of the way out each way along the name, and a
 * fifth of a degree above and below. A single centre probe accepts a name shoved hard against
 * its country's edge — Nepal pushed north onto the Himalayan border — where a pixel of
 * rounding in the raycast, or the index's own 3×3 vote on an anti-aliased border pixel, hands
 * the click to the neighbour. The outer four are the margin that rules those placements out.
 *
 * This is a preference, not a rule: when no rung and no offset satisfies it, the caller falls
 * back to a relaxed sweep, so a name is never dropped for failing it.
 */
function sitsOnOwnGround(
  countryAt: (lat: number, lng: number) => string | null,
  iso3: string,
  cx: number,
  cLat: number,
  boxW: number,
  W: number,
  /** Also require the middle probe to be the country itself, not merely open water. */
  middleOnLand: boolean,
): boolean {
  for (let i = 0; i < STRICT_PROBES.length; i++) {
    const [fx, dLat] = STRICT_PROBES[i];
    const lng = (((((cx + fx * boxW) / W) * 360 - 180) % 360) + 540) % 360 - 180;
    const under = countryAt(cLat + dLat, lng);
    if (under !== null && under !== iso3) return false;
    if (i === 0 && middleOnLand && under !== iso3) return false;
  }
  return true;
}

/** [fraction of the box width, degrees of latitude] offsets probed by the strict pass. */
const STRICT_PROBES: readonly [number, number][] = [
  [0, 0],
  [-0.3, 0],
  [0.3, 0],
  [0, -0.2],
  [0, 0.2],
];

/** N/S first, then W/E, then the four diagonals. */
const NUDGE_DIRS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Fractions of the full step, tried smallest first. Most collisions are shallow — Nepal's box
 * overlaps Bangladesh's by a fifth of its height — and a full box-height shove to clear a
 * fifth of one walks the name onto the next country. Sweeping every direction at a third of a
 * step before trying any at a whole one keeps the name as near its anchor as the neighbours
 * allow.
 */
const NUDGE_MAGNITUDES: readonly number[] = [0.35, 0.7, 1];

/** Anchor first, then each direction at each magnitude. First clear one wins. */
const NUDGES: readonly [number, number][] = [
  [0, 0],
  ...NUDGE_MAGNITUDES.flatMap((m) => NUDGE_DIRS.map(([x, y]): [number, number] => [x * m, y * m])),
];

/** 1/cos(lat) past ~70.5° is more stretch than the glyphs survive; hold it here. */
const MAX_SCALE_X = 3;
/** No name is printed beyond this latitude; the anchor is clamped into the band. */
const MAX_LABEL_LAT = 74;

/** Printed type is never perfectly square to the line. Degrees. */
const TYPE_TILT_DEG = 0.6;

/**
 * Padding around a name's box, as a fraction of the font size. Kept small, and much
 * smaller vertically than horizontally: the box is also the collision unit, and a tall
 * box makes two names on the *same* parallel fight each other for no visual reason.
 */
const PAD_X = 0.18;
const PAD_Y = 0.06;

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
  /**
   * What `boxW` would have been with no stretch — i.e. the aspect the glyphs are *set* at.
   * The sphere divides `boxW` by `scaleX` again, so `flatW / boxH` is the aspect the name
   * should come out at on screen. Exported so that can be asserted rather than eyeballed.
   */
  flatW: number;
  /** Sub-degree type tilt in radians, seeded from the ISO3 so it never moves. */
  tilt: number;
  /**
   * Seeded sub-pixel offset of the halo pass, in reference pixels. A halo laid down exactly
   * on centre reads as a computed outline; one that slips a fraction of a pixel reads as the
   * second plate of a cheap two-colour print, which is what it is meant to be. Free — the
   * halo has to be stroked anyway — where a dedicated ink-spread pass cost 78 ms at 8k.
   */
  haloShift: number;
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

/** 1 / cos(lat): the inverse of the sphere's horizontal compression. Clamped, never < 1. */
function stretchAt(lat: number): number {
  return clamp(1 / Math.max(Math.cos((lat * Math.PI) / 180), 1e-3), 1, MAX_SCALE_X);
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
  /**
   * Which country's polygon covers a geographic point, or null for open water / no polygon.
   *
   * Optional, but worth supplying: a label's box is stamped into the pick index only where a
   * pixel is still unassigned, so a name whose middle has drifted over a neighbour is not
   * clickable in the middle. Given this, placement prefers a candidate whose centre sits on
   * its own country (or on nothing) before it accepts one that has wandered next door.
   */
  countryAt?: (lat: number, lng: number) => string | null;
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
  const countryAt = options.countryAt;
  const W = LABEL_REF_WIDTH;
  const H = LABEL_REF_HEIGHT;

  const order = Object.keys(countries)
    .filter((iso3) => {
      const rec = countries[iso3];
      return Boolean(rec && rec.name && Array.isArray(rec.latlng) && rec.latlng.length === 2);
    })
    // Independent states first, then territories; descending area within each group, ISO3
    // breaking ties. Area alone let "Saint Pierre and Miquelon" take the space Egypt or
    // Norway needed — a long name on a small rock beats a short name on a large country at
    // equal priority, which is the opposite of how an atlas is set.
    .sort((a, b) => {
      const ra = countries[a];
      const rb = countries[b];
      const ia = ra.independent ? 0 : 1;
      const ib = rb.independent ? 0 : 1;
      if (ia !== ib) return ia - ib;
      const d = (rb.area ?? 0) - (ra.area ?? 0);
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
    const anchorScaleX = stretchAt(lat);

    const rnd = mulberry32(hashString(iso3));
    const tilt = (rnd() - 0.5) * 2 * TYPE_TILT_DEG * (Math.PI / 180);
    const haloShiftK = (rnd() - 0.5) * 0.05; // of the font size

    const unitW = measure(rec.name);
    const x = projectX(lng, W);
    const startTier = tierFor(rec.area ?? 0);
    const lastTier = Math.min(FONT_LADDER.length - 1, startTier + MAX_STEP_DOWN);

    const reach = reachDeg(rec.area ?? 0);
    const maxDy = (Math.min(MAX_NUDGE_LAT_DEG, reach) / 180) * H;
    const maxDx = (Math.min(MAX_NUDGE_LNG_DEG, reach * anchorScaleX) / 360) * W;
    const anchorX = x;
    const anchorY = projectY(lat, H);

    /**
     * One sweep of the ladder, at one level of fussiness:
     *   0 — the name's middle must be standing on the country itself;
     *   1 — its middle may be on open water, but never on a neighbour;
     *   2 — anywhere it fits.
     *
     * All three sweep the whole ladder, so a name would rather be printed a size or two
     * smaller *on the country it names* than printed large across the border or out to sea.
     * That is the order an atlas sets type in, and it is also what keeps the name clickable:
     * a label may never take a pixel that already belongs to a polygon, so a name shoved next
     * door cannot be clicked there.
     */
    const sweep = (mode: 0 | 1 | 2): PlacedLabel | null => {
      for (let tier = startTier; tier <= lastTier; tier++) {
        const fontPx = FONT_LADDER[tier];
        // Collision height is roughly one em — ascender to descender — not the full line box.
        // A taller box makes two names on the same parallel fight over air.
        const boxH = fontPx * (0.98 + 2 * PAD_Y);
        const flatW = (unitW + 2 * PAD_X) * fontPx;
        const stepY = Math.min(boxH * NUDGE_Y_FRACTION, maxDy);
        const stepX = Math.min(flatW * anchorScaleX * NUDGE_X_FRACTION, maxDx);
        for (const [nx, ny] of NUDGES) {
          const cx = anchorX + nx * stepX;
          // Keep the whole box on the raster vertically; horizontally it may straddle the seam.
          const cy = clamp(anchorY + ny * stepY, boxH / 2, H - boxH / 2);
          // The stretch follows the row the name actually lands on, not the anchor: a nudge of
          // several degrees at 64°N changes 1/cos by ~15%, which is visible as a squeeze.
          const cLat = 90 - (cy / H) * 180;
          const scaleX = stretchAt(cLat);
          const boxW = unitW * fontPx * scaleX + 2 * PAD_X * fontPx;
          if (mode < 2 && countryAt && !sitsOnOwnGround(countryAt, iso3, cx, cLat, boxW, W, mode === 0)) continue;
          const box: Box = { x0: cx - boxW / 2, x1: cx + boxW / 2, y0: cy - boxH / 2, y1: cy + boxH / 2 };
          let clear = true;
          for (const other of boxes) {
            if (overlaps(box, other, W)) {
              clear = false;
              break;
            }
          }
          if (!clear) continue;
          boxes.push(box);
          return {
            iso3, name: rec.name, x: cx, y: cy, fontPx, scaleX, boxW, boxH, flatW,
            tilt, haloShift: haloShiftK * fontPx, tier,
          };
        }
      }
      return null;
    };

    const placed = (countryAt ? (sweep(0) ?? sweep(1)) : null) ?? sweep(2);

    if (placed) {
      labels.push(placed);
      byIso.set(iso3, placed);
    } else {
      skipped.push(iso3);
    }
  }

  return { width: W, height: H, labels, byIso, skipped };
}
