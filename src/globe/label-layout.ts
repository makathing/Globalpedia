/**
 * Where every country name is *printed* on the map raster.
 *
 * The names are no longer billboards — they are part of the paper, so their position, size
 * and horizontal stretch have to be decided once, in texture space, before anything is drawn.
 * Two modules consume the result: `texture.ts` prints it into the map raster and stamps its
 * boxes into the pick index, and `highlight.ts` rules an underline beneath the selected one.
 *
 * Nothing here reads the theme or the camera, so the layout is built exactly once for the
 * life of the globe and is identical across themes, raster sizes and reloads.
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
 * How much of its country's width a name should fill, when the country is big enough to
 * choose. Under about 0.7 the name looks timid on the landmass; over about 0.85 it starts
 * crowding the borders, and past 1 it is the single thing that makes a globe read as software
 * rather than as print. Measured over the 125 countries above 60 000 km², this target lands
 * the median at 0.79 of the country's own width. Small countries cannot reach it and overflow
 * deliberately — that is what the halo is for — but overflow is then the exception rather
 * than, as it was when the size came from the area tier alone, the rule.
 */
const TARGET_FILL = 0.75;

/** How many rungs below the area tier the extent rule may push a name. */
const EXTENT_FLOOR_STEPS = 3;

/**
 * Glyph height in reference (8192-wide) texels, largest first.
 *
 * Calibration: at 8192 across, with the globe about 700 px on screen, roughly 3.7 texels
 * land on one screen pixel at the centre of the disc — so divide by 3.7 for the em size a
 * viewer actually sees in the default pose. 96 → 26 px, 80 → 22 px, 66 → 18 px, 54 → 15 px,
 * 44 → 12 px, 36 → 10 px, 30 → 8 px, 25 → 7 px, 21 → 6 px. The bottom rungs are deliberately
 * below comfortable reading size: they are the "lean in" tier, and they keep crowded regions
 * looking like dense printed type rather than a map with holes in it. There is no zoom tier —
 * a name is printed at one size forever, and the viewer moves closer.
 *
 * Which rung a name *starts* on comes from `startTierFor` — its country's actual width — not
 * from its area; collisions then step it further down.
 */
export const FONT_LADDER: readonly number[] = [96, 80, 66, 54, 44, 36, 30, 25, 21];

/**
 * Area (km²) at or above which a country may start on ladder rung i. Area is the *clamp*
 * now, not the driver: it caps how large a name may be set and how small the extent rule may
 * push it, and the country's actual width in texture space decides where between the two it
 * lands. Area alone cannot do this job — Chad and Western Sahara can share an area tier while
 * one name fits inside its border and the other is twice as wide as the territory.
 */
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

/**
 * When a sovereign state's name will not fit anywhere on or beside its territory, it is set
 * clear of the country and joined to it by a leader line — the device every printed atlas uses
 * for Portugal, Lebanon, Togo and the rest of the crowded coastlines. These are the rings it
 * is offered, as multiples of "half the name plus the country's own reach", nearest first, and
 * sixteen directions per ring. Each ring is swept twice — open water or its own ground first,
 * then anywhere — so a short leader onto a neighbour beats a long one out to sea. The leader
 * line and the ink index between them leave no doubt which country the name belongs to.
 */
const LEADER_RINGS: readonly number[] = [0.7, 1, 1.4, 1.9, 2.5, 3.2, 4.2, 5.2, 6.4, 8];
const LEADER_DIRS: readonly [number, number][] = Array.from({ length: 16 }, (_, i) => {
  const a = Math.PI + (i * Math.PI) / 8; // start due west, step 22.5°
  return [Math.cos(a), Math.sin(a)] as [number, number];
});
/**
 * A displaced name is set one rung smaller than its area alone would allow — but from the
 * *area* tier, not from the extent tier. "Fill 0.75 of the country's width" is meaningless for
 * a name that is not standing on the country; sizing a displaced Portugal off Portugal's width
 * had it set at the bottom rung, six screen pixels, for a country people come looking for.
 */
const LEADER_STEP_DOWN = 1;
/** However far the rings reach, a leader never crosses more of the globe than this. */
const MAX_LEADER_LAT_DEG = 14;
const MAX_LEADER_LNG_DEG = 20;

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
  /**
   * Present only when the name had to be set clear of its territory: the point on the
   * territory, in reference pixels, that a leader line should run back to.
   */
  leader?: { x: number; y: number };
}

export interface LabelLayout {
  /** Reference raster the coordinates are expressed in. */
  width: number;
  height: number;
  /** Placed names, in print order: independent states first, then territories, each by area. */
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

/**
 * The rung a name *starts* on: the largest one whose set width is still within `TARGET_FILL`
 * of the country's own width, held between the area tier's rung (never larger) and three
 * rungs below it (never so small that a 250 000 km² territory with a long name disappears).
 *
 * Both widths are measured in texture space, so the horizontal pre-stretch cancels out of the
 * comparison exactly the way it cancels on the sphere: `unitW · fontPx · scaleX` against the
 * country's own stretched span. That is why this can be a single division and not a table.
 */
function startTierFor(
  areaTier: number,
  lngSpanDeg: number | null,
  unitW: number,
  scaleX: number,
  W: number,
): number {
  const floor = Math.min(FONT_LADDER.length - 1, areaTier + EXTENT_FLOOR_STEPS);
  if (lngSpanDeg === null || !(lngSpanDeg > 0) || unitW <= 0) return areaTier;
  const countryW = (lngSpanDeg / 360) * W;
  const idealPx = (TARGET_FILL * countryW) / (unitW * scaleX);
  let tier = areaTier;
  while (tier < floor && FONT_LADDER[tier] > idealPx) tier++;
  return tier;
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
  /**
   * Longitude span, in degrees, of the country's main landmass — its bounding box in the same
   * space the name is set in, so the two are directly comparable. Optional; without it names
   * fall back to their area tier alone, which sets many of them far too wide.
   */
  lngSpanOf?: (iso3: string) => number | null;
}

/**
 * Deterministic placement. Names are set in a fixed order (independent states first, then
 * territories, each by descending area, ISO3 breaking ties) and each one takes the first slot
 * that is free: starting rung from `startTierFor`, then up to `MAX_STEP_DOWN` rungs smaller,
 * and at each rung the anchor followed by twenty-four small offsets, nearest first. The whole
 * ladder is swept up to three times at decreasing fussiness about what the name is standing
 * on (see `sweep`). A sovereign state that still has nowhere to go gets one more chance from
 * `leaderSweep`: set clear of its territory, with a leader line back to it. A name that finds
 * no free slot at all is dropped and listed in `skipped`.
 *
 * No randomness that is not seeded from the ISO3, no dependence on iteration order of the
 * input object beyond the explicit sort: the same data always yields the same map.
 */
export function layoutLabels(
  countries: Record<string, CountryRecord>,
  options: LayoutOptions = {},
): LabelLayout {
  const measure = options.measure ?? canvasMeasurer();
  const countryAt = options.countryAt;
  const lngSpanOf = options.lngSpanOf;
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
    const areaTier = tierFor(rec.area ?? 0);
    const startTier = startTierFor(areaTier, lngSpanOf?.(iso3) ?? null, unitW, anchorScaleX, W);
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

    /**
     * Last resort, and only for sovereign states: set the name clear of the country and run a
     * leader back to it. Rather this than no name at all — Portugal is a country people hunt
     * for, and "there was no room" is not an answer a globe is allowed to give. Territories
     * are left to drop, exactly as a real globe drops them.
     *
     * The displaced slot must still stand on its own country or on open water, never on a
     * neighbour: a name sitting in the middle of Spain with a hairline pointing at Portugal
     * would be worse than nothing.
     */
    const leaderSweep = (): PlacedLabel | null => {
      const maxLeadX = (MAX_LEADER_LNG_DEG / 360) * W;
      const maxLeadY = (MAX_LEADER_LAT_DEG / 180) * H;
      const reachY = (reach / 180) * H;
      const first = Math.min(areaTier + LEADER_STEP_DOWN, FONT_LADDER.length - 1);
      // Rings outside, sizes inside: near beats large. Exhausting every ring at the biggest
      // rung before trying a smaller one flung "Liechtenstein" and "Bosnia and Herzegovina"
      // across half of Europe on a hairline; a name set two sizes down but beside its country
      // is the better map, and the one an atlas would set.
      for (const r of LEADER_RINGS) {
        for (let tier = first; tier < FONT_LADDER.length; tier++) {
          const fontPx = FONT_LADDER[tier];
          const boxH = fontPx * (0.98 + 2 * PAD_Y);
          const flatW = (unitW + 2 * PAD_X) * fontPx;
          // The step is the country's own reach plus a modest share of the name, not the whole
          // name: the leader exists precisely so the name need not clear its territory.
          const baseX = flatW * anchorScaleX * 0.35 + reachY * anchorScaleX;
          const baseY = boxH * 0.8 + reachY;
          for (const strict of [true, false]) {
            for (const [ux, uy] of LEADER_DIRS) {
              const cx = anchorX + clamp(ux * r * baseX, -maxLeadX, maxLeadX);
              const cy = clamp(anchorY + clamp(uy * r * baseY, -maxLeadY, maxLeadY), boxH / 2, H - boxH / 2);
              const cLat = 90 - (cy / H) * 180;
              const scaleX = stretchAt(cLat);
              const boxW = unitW * fontPx * scaleX + 2 * PAD_X * fontPx;
              if (strict && countryAt && !sitsOnOwnGround(countryAt, iso3, cx, cLat, boxW, W, false)) continue;
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
                leader: { x: anchorX, y: anchorY },
              };
            }
          }
        }
      }
      return null;
    };

    const placed =
      ((countryAt ? (sweep(0) ?? sweep(1)) : null) ?? sweep(2)) ??
      (rec.independent ? leaderSweep() : null);

    if (placed) {
      labels.push(placed);
      byIso.set(iso3, placed);
    } else {
      skipped.push(iso3);
    }
  }

  return { width: W, height: H, labels, byIso, skipped };
}
