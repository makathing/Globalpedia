export { type IdMap, lookupCountryId, lookupId } from './id-map';
/**
 * Rasterises the world TopoJSON into
 *   1. the visible equirectangular "school globe" map (canvas → THREE.CanvasTexture), and
 *   2. a compact ISO3 index map used for pixel-exact picking.
 *
 * Everything here is pure Canvas2D; no Three.js.
 */
import { feature, mesh, neighbors } from 'topojson-client';
import type { GeometryCollection, GeometryObject, Objects, Topology } from 'topojson-specification';
import type { CountryRecord } from '../core/types';
import { DEFAULT_THEME, themeById, type GlobeTheme } from '../core/themes';
import { lookupCountryId, type IdMap } from './id-map';
import { labelFont, layoutLabels, type LabelLayout, type PlacedLabel } from './label-layout';
import { projectX, projectY } from './math';
import { CAP_DEGREES, compositeSurface, drawAging, drawGoreSeams, drawPolarCaps } from './surface';

/** Properties carried by production `public/data/world-50m.json` geometries. */
export interface WorldProps {
  name?: string;
  ccn3?: string;
}

/** Only polygonal geometries (the world file has nothing else). */
export type AreaGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export interface CountryShape {
  iso3: string;
  name: string;
  geometry: AreaGeometry;
  /** Index into the active theme's 8-entry palette. Stable across themes. */
  paletteIndex: number;
}

export interface GlobeTextures {
  map: HTMLCanvasElement;
  idMap: IdMap;
  /** Keyed by ISO3, for the highlight layer. */
  shapes: Map<string, CountryShape>;
  /**
   * Where every country name is printed. Computed once — it depends on the data and on
   * nothing else — so a theme switch re-inks the same names in exactly the same places
   * and the pick index never has to be rebuilt.
   */
  labels: LabelLayout;
  /**
   * Repaint the visible map **into the existing `map` canvas** with another theme.
   * The adjacency colouring and the pick index are NOT recomputed — only the
   * paint changes — so the caller just has to flag `mapTexture.needsUpdate`.
   */
  redraw(theme: GlobeTheme): void;
}

/**
 * The default (Classroom) theme's colours, kept as named exports for callers that
 * predate theming. The drawing path itself never reads these — it takes a
 * `GlobeTheme` — but every theme's palette is exactly 8 long, so an index handed
 * out against one palette means the same slot in every other.
 */
const DEFAULT_GLOBE = themeById(DEFAULT_THEME).globe;
/** Eight muted pastels, in the order the greedy colouring prefers them. */
export const PALETTE: readonly string[] = DEFAULT_GLOBE.palette;
export const OCEAN: string = DEFAULT_GLOBE.ocean;
export const OUTLINE: string = DEFAULT_GLOBE.outline;

/** Find the geometry collection to draw: `objects.countries` or the first collection present. */
export function pickCollection(world: Topology): GeometryCollection<WorldProps> {
  const objects = world.objects as Objects<WorldProps>;
  const named = objects['countries'];
  if (named && named.type === 'GeometryCollection') return named;
  for (const key of Object.keys(objects)) {
    const o = objects[key];
    if (o && o.type === 'GeometryCollection') return o;
  }
  throw new Error('world topology has no GeometryCollection');
}

/**
 * Greedy graph colouring by adjacency (shared arcs). Vertices are visited by
 * descending degree; each takes the first palette entry unused by an already
 * coloured neighbour, or, when all eight are taken, the entry least used
 * among its neighbours.
 */
function assignColors(geometries: GeometryObject<WorldProps>[], palette: readonly string[]): number[] {
  const adj = neighbors(geometries);
  const n = geometries.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => adj[b].length - adj[a].length);
  const colors = new Array<number>(n).fill(-1);
  for (const i of order) {
    const used = new Array<number>(palette.length).fill(0);
    for (const j of adj[i]) if (colors[j] >= 0) used[colors[j]]++;
    // Deterministic tie-break so the same file always yields the same map:
    // start the scan at a position derived from the geometry id.
    const id = String(geometries[i].id ?? i);
    let hash = 0;
    for (let k = 0; k < id.length; k++) hash = (hash * 31 + id.charCodeAt(k)) >>> 0;
    const start = hash % palette.length;
    let best = -1;
    let bestCount = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = (start + k) % palette.length;
      if (used[c] < bestCount) {
        bestCount = used[c];
        best = c;
        if (bestCount === 0) break;
      }
    }
    colors[i] = best;
  }
  return colors;
}

/** Append a Polygon / MultiPolygon to the current path in raster coordinates. */
export function traceGeometry(
  ctx: CanvasPath,
  geometry: AreaGeometry,
  width: number,
  height: number,
): void {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const x = projectX(ring[i][0], width);
        const y = projectY(ring[i][1], height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }
}

/**
 * Fold a second geometry into a country's shape.
 *
 * The world file carries some countries as **several** geometry entries sharing one id —
 * Australia is the mainland plus a separate entry for its offshore islands — and `shapes`
 * used to keep whichever came last, so `shapes.get('AUS')` was a five-point island off the
 * Kimberley coast. That silently shrank the highlight wash to a dot for those countries, and
 * would have handed the label layout an eight-kilometre-wide Australia to set a name across.
 * Merging into one MultiPolygon fixes both; the painted fills are unaffected, because those
 * are drawn per geometry from `shapesByIndex`.
 */
function mergeAreas(a: AreaGeometry, b: AreaGeometry): GeoJSON.MultiPolygon {
  const polysOf = (g: AreaGeometry): GeoJSON.Position[][][] =>
    g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return { type: 'MultiPolygon', coordinates: [...polysOf(a), ...polysOf(b)] };
}

/**
 * Longitude span, in degrees, of a country's **main** landmass.
 *
 * The whole geometry's bounding box is useless for this: it would hand France the span from
 * the Atlantic to French Guiana, and the United States the span from Maine to Guam. So each
 * outer ring is measured on its own, longitudes unwrapped so a ring crossing the antimeridian
 * stays in one piece, and the ring with the largest bounding box wins — for every country
 * that is the landmass a reader thinks of as the country, and the one the name is set across.
 */
function mainLandmassSpan(geometry: AreaGeometry): number {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let bestSpan = 0;
  let bestBox = 0;
  for (const rings of polys) {
    const ring = rings[0];
    if (!ring || ring.length < 4) continue;
    let lon = ring[0][0];
    let minLon = lon;
    let maxLon = lon;
    let minLat = ring[0][1];
    let maxLat = ring[0][1];
    for (let i = 1; i < ring.length; i++) {
      let d = ring[i][0] - ring[i - 1][0];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      lon += d;
      if (lon < minLon) minLon = lon;
      else if (lon > maxLon) maxLon = lon;
      const lat = ring[i][1];
      if (lat < minLat) minLat = lat;
      else if (lat > maxLat) maxLat = lat;
    }
    const span = maxLon - minLon;
    const box = span * (maxLat - minLat);
    if (box > bestBox) {
      bestBox = box;
      bestSpan = span;
    }
  }
  return bestSpan;
}

function traceLines(ctx: CanvasPath, lines: GeoJSON.MultiLineString, width: number, height: number): void {
  for (const line of lines.coordinates) {
    for (let i = 0; i < line.length; i++) {
      const x = projectX(line[i][0], width);
      const y = projectY(line[i][1], height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
}

/**
 * `willReadFrequently` is load-bearing, not a hint to ignore. Both of these canvases are read
 * back: the pick index does a full `getImageData`, and the gore seams copy a slice of the map
 * onto itself. On a GPU-backed canvas that self-copy forces a round trip and measured **20.8 s**
 * on a fresh 8192×4096 surface, against 104 ms once the canvas is software-backed — it was
 * adding ~18 s to first paint. Asking for the software path up front is the standard way to say
 * so, rather than relying on Chromium's "a readback happened, stop accelerating" heuristic.
 */
function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

/**
 * `capH` is the polar cap's depth in raster rows. The meridians stop just inside it rather than
 * running to y = 0: every one of them converges on the pole there, and the sampler smears that
 * convergence into a fan of rays — a large part of what read as the pole starburst was simply
 * 24 graticule lines meeting at a point. On a printed globe they run under the cap and stop.
 */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number,
  ink: string,
  capH: number,
): void {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineCap = 'butt';

  // Every 15° — thin, low alpha. The ±90° parallels collapse to the raster edge, skip them.
  ctx.globalAlpha = 0.17;
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  const meridianTop = capH * 0.72;
  for (let lon = -180; lon < 180; lon += 15) {
    const x = Math.round(projectX(lon, width)) + 0.5;
    ctx.moveTo(x, meridianTop);
    ctx.lineTo(x, height - meridianTop);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    if (lat === 0) continue;
    const y = Math.round(projectY(lat, height)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Tropics and polar circles: dashed, a little stronger.
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1.3 * s;
  ctx.setLineDash([14 * s, 9 * s]);
  ctx.beginPath();
  for (const lat of [23.4366, -23.4366, 66.5634, -66.5634]) {
    const y = projectY(lat, height);
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Equator: solid and clearly thicker.
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2.6 * s;
  ctx.beginPath();
  const eq = projectY(0, height);
  ctx.moveTo(0, eq);
  ctx.lineTo(width, eq);
  ctx.stroke();
  ctx.restore();
}

/**
 * The theme-independent geometry of a paint, traced once at build time and reused by every
 * repaint. Re-walking ~250 polygons and the whole arc mesh on each theme switch was pure
 * waste, and retiring it is what pays for the extra stroke passes below.
 */
interface PaintPaths {
  /** Parallel to `shapesByIndex`; null wherever that entry is null. */
  fills: (Path2D | null)[];
  borders: Path2D;
}

/**
 * Print the country names into the raster.
 *
 * Called between the border passes and the ink/paper/age passes, which is the whole point:
 * a name drawn *after* the mottle, halftone and foxing floats above the paper like an
 * overlay, and a name drawn *before* them is printed matter that ages with everything else.
 *
 * Each name is drawn under `translate → rotate → scale(scaleX, 1)`, so the halo is stretched
 * with the glyphs. That is deliberate: the sphere divides everything here by `scaleX` again,
 * so a halo that is uniform *on the globe* has to be elliptical *in the texture*.
 *
 * Two passes, not three. Measured at 8k over 178 names: `fillText` 44 ms, and **every**
 * `strokeText` about 85 ms regardless of its line width — the cost is outlining the glyph
 * paths, not covering pixels. A third pass for ink spread was 78 ms for an effect a quarter
 * of a screen pixel wide, so the spread is bought instead with a seeded sub-pixel offset on
 * the halo, which costs nothing. Total: ~133 ms at 8k, ~35 ms at 4k.
 */
/**
 * The hairline from a displaced name back to its territory, with a small dot where it lands.
 *
 * Drawn in the *unstretched* frame: it is a geometric line between two points of the raster,
 * not type, so it must not carry the glyphs' `1/cos(lat)` pre-stretch — the sphere foreshortens
 * it correctly on its own. Kept under a pixel wide at 8k and stopped short of the name's box,
 * so it reads as an engraved rule rather than as a pointer drawn by a user interface.
 */
function drawLeader(
  ctx: CanvasRenderingContext2D,
  label: PlacedLabel,
  xs: readonly number[],
  k: number,
  width: number,
  theme: GlobeTheme,
): void {
  const leader = label.leader;
  if (!leader) return;
  const ty = leader.y * k;
  const fontPx = label.fontPx * k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = theme.labelInk;
  ctx.fillStyle = theme.labelInk;
  ctx.lineWidth = Math.max(0.9, fontPx * 0.075);
  ctx.lineCap = 'round';
  for (const x of xs) {
    // Nearest copy of the territory across the seam.
    let tx = leader.x * k;
    if (tx - x > width / 2) tx -= width;
    else if (x - tx > width / 2) tx += width;
    const cy = label.y * k;
    const dx = tx - x;
    const dy = ty - cy;
    // Nothing to point at when the territory is already under the name.
    if (Math.abs(dx) < (label.boxW * k) / 2 && Math.abs(dy) < (label.boxH * k) / 2) continue;
    // Leave the name's box at its edge, not its centre: the fraction of the run that clears
    // the box horizontally or vertically, whichever happens first.
    const startT = Math.min(
      Math.abs(dx) > 1e-3 ? ((label.boxW * k) / 2 + fontPx * 0.2) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-3 ? ((label.boxH * k) / 2 + fontPx * 0.2) / Math.abs(dy) : Infinity,
      0.9,
    );
    ctx.beginPath();
    ctx.moveTo(x + dx * startT, cy + dy * startT);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(1.1, fontPx * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  layout: LabelLayout,
  width: number,
  theme: GlobeTheme,
): void {
  const k = width / layout.width; // reference raster → this raster
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'source-over';

  for (const label of layout.labels) {
    const fontPx = label.fontPx * k;
    if (fontPx < 3) continue; // below this the glyphs are mush; nothing is lost by omitting them
    const font = labelFont(fontPx);
    // One extra copy shifted a full raster width, so a name straddling the antimeridian
    // prints on both edges and the seam stays invisible.
    const half = (label.boxW * k) / 2;
    const xs =
      label.x * k - half < 0
        ? [label.x * k, label.x * k + width]
        : label.x * k + half > width
          ? [label.x * k, label.x * k - width]
          : [label.x * k];

    // Leader first, so the name's halo closes over the end of it rather than the line
    // crossing the letterforms.
    if (label.leader) drawLeader(ctx, label, xs, k, width, theme);

    for (const x of xs) {
      ctx.setTransform(label.scaleX, 0, 0, 1, x, label.y * k);
      ctx.rotate(label.tilt);
      ctx.font = font;

      // A thin halo, not a slab: enough to hold the name together where it crosses a
      // coastline, not enough to read as a sticker. Laid down a fraction of a pixel off
      // centre, so the two colours misregister very slightly, as a cheap print does.
      ctx.globalAlpha = 1;
      ctx.lineWidth = fontPx * 0.15;
      ctx.strokeStyle = theme.labelHalo;
      ctx.strokeText(label.name, label.haloShift * k, label.haloShift * k * 0.6);

      ctx.fillStyle = theme.labelInk;
      ctx.fillText(label.name, 0, 0);
    }
  }

  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

/**
 * Paint the visible map into `ctx`, which must already be `width` × `width / 2`.
 * Every colour comes from `theme`; the per-country palette *indices* do not, so a
 * repaint keeps the map's colouring topology and swaps only the hues.
 *
 * The order matters. Ink mottle goes over the *finished* map — fills, ocean and line-work
 * together — because that is how ink density actually behaves; paper and halftone sit above
 * the ink; age sits above the print; and the gore seams go last, because the join is the
 * outermost physical thing on the object.
 */
function paintMap(
  ctx: CanvasRenderingContext2D,
  shapesByIndex: (CountryShape | null)[],
  paths: PaintPaths,
  labels: LabelLayout,
  width: number,
  theme: GlobeTheme,
): void {
  const height = width / 2;
  const s = width / 8192; // stroke widths are specified "at 8k"

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // Ocean.
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.ocean;
  ctx.fillRect(0, 0, width, height);

  // Country fills. fillAlpha < 1 lets the sea show through, for line-work looks.
  ctx.save();
  ctx.globalAlpha = theme.fillAlpha;
  for (let i = 0; i < shapesByIndex.length; i++) {
    const shape = shapesByIndex[i];
    const path = paths.fills[i];
    if (!shape || !path) continue;
    ctx.fillStyle = theme.palette[shape.paletteIndex];
    ctx.fill(path, 'evenodd');
  }
  ctx.restore();

  drawGraticule(ctx, width, height, s, theme.graticule, (CAP_DEGREES / 180) * height);

  // Borders and coastlines. A single uniform-width pass is the loudest "a computer drew this"
  // tell there is, so the mesh is stroked three times at sub-pixel offsets: the main line, then
  // two lighter passes leaning opposite ways, which is literally what plate misregistration on
  // a cheaply printed map looks like. Every arc is its own subpath with a round cap, so where
  // arcs meet the alpha of the offset passes accumulates and the ink pools slightly darker —
  // for free, and without a second full-size canvas.
  //
  // Software stroke cost is proportional to total stroked width — measured at ~206 ms per 1×
  // pass over this mesh at 8k. The widths below sum to 1.95×, not the 2.9× a wide dedicated
  // "spread" pass would cost, which is what keeps the redraw inside its budget while still
  // buying all four cues: irregular edge, misregistration, ink spread and pooling.
  const w = theme.outlineWidth * s;
  const wob = theme.surface.lineWobble;
  // Offsets are in raster pixels, NOT multiples of the stroke width: the raster lands on screen
  // at roughly 1:1 at the zoom this is judged at, so a fraction of a 1.5 px line is invisible.
  const off = (0.6 + 1.5 * wob) * s;
  const passes: [number, number, number, number][] = [
    // lineWidth, alpha, dx, dy
    [w * 0.95, 1 - 0.16 * wob, 0, 0],
    [w * 0.55, 0.36 + 0.3 * wob, off, off * 0.55],
    [w * 0.45, 0.3 + 0.28 * wob, -off * 0.85, -off * 0.45],
  ];
  ctx.save();
  ctx.strokeStyle = theme.outline;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [lineWidth, alpha, dx, dy] of passes) {
    ctx.setTransform(1, 0, 0, 1, dx, dy);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lineWidth;
    ctx.stroke(paths.borders);
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // The names, over the line-work but under every ink and paper pass below, so they age
  // with the print instead of floating on top of it.
  drawLabels(ctx, labels, width, theme);

  // The physical surface, in the order a real object acquires it.
  compositeSurface(ctx, width, height, theme.surface, theme.grainAlpha);
  drawAging(ctx, width, height, s, theme);
  drawGoreSeams(ctx, width, height, s, theme);

  // The caps go on LAST, over the paper tooth rather than under it. That ordering is the whole
  // point: the pole starburst is high-frequency detail in u being undersampled, and the fine
  // tooth is the strongest such detail there is. A cap that carried tooth would still shimmer.
  drawPolarCaps(ctx, width, height, s, theme);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Encode a 1-based shape index as a flat RGB. The blue channel is a nonlinear
 * checksum so that anti-aliased blends between two neighbouring countries fail
 * the exact-match lookup instead of decoding as an unrelated third country.
 */
function encodeId(i: number): [number, number, number] {
  return [i & 255, (i >> 8) & 255, (i * 97 + 31) & 255];
}

function buildIdMap(shapesByIndex: (CountryShape | null)[], width: number): IdMap {
  const height = width / 2;
  const [canvas, ctx] = makeCanvas(width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const iso3s: string[] = [];
  const lookup = new Map<number, number>(); // packed rgb → 1-based index
  for (const shape of shapesByIndex) {
    if (!shape) continue;
    const idx = iso3s.push(shape.iso3);
    const [r, g, b] = encodeId(idx);
    lookup.set((r << 16) | (g << 8) | b, idx);
    const css = `rgb(${r},${g},${b})`;
    ctx.fillStyle = css;
    ctx.strokeStyle = css;
    ctx.lineWidth = 1.2; // keeps one-pixel islands pickable
    ctx.beginPath();
    traceGeometry(ctx, shape.geometry, width, height);
    ctx.fill('evenodd');
    ctx.stroke();
  }

  const data = ctx.getImageData(0, 0, width, height).data;
  const index = new Uint16Array(width * height);
  for (let p = 0, i = 0; p < index.length; p++, i += 4) {
    const packed = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (packed === 0) continue;
    const idx = lookup.get(packed);
    if (idx !== undefined) index[p] = idx;
  }
  canvas.width = canvas.height = 1; // release the backing store eagerly
  return { width, height, index, iso3s, labelInk: new Uint16Array(0), labelBox: new Uint16Array(0) };
}

/**
 * Rasterise the names' ink into `idMap.labelInk`, in the same encoding as the country index.
 *
 * The glyphs are both filled and stroked at the halo's own line width, so the region claimed
 * is the glyph plus its halo — the shape the eye reads as the name, counters and inter-letter
 * gaps closed — and not a pixel more. At 4096 across, the smallest rung (21 reference texels)
 * lands as a 10-pixel glyph with a 3-pixel dilation, which is enough for a pointer.
 *
 * Exact-match decoding, like the country index: an anti-aliased edge pixel blends two encodings
 * and decodes as nothing, so the boundary of a name falls through to the country beneath rather
 * than to some unrelated third country.
 */
function buildLabelInkIndex(idMap: IdMap, labels: LabelLayout, byIso: Map<string, number>): void {
  const { width, height } = idMap;
  const [canvas, ctx] = makeCanvas(width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const k = width / labels.width;
  const lookup = new Map<number, number>();
  /**
   * Ids whose name had to be set off its own territory. Their ink is not allowed to outrank a
   * polygon — see the decode below.
   */
  const displaced = new Set<number>();
  for (const label of labels.labels) {
    const id = byIso.get(label.iso3);
    if (id === undefined) continue;
    if (label.leader) displaced.add(id);
    const [r, g, b] = encodeId(id);
    lookup.set((r << 16) | (g << 8) | b, id);
    const css = `rgb(${r},${g},${b})`;
    const fontPx = label.fontPx * k;
    if (fontPx < 2) continue;
    ctx.fillStyle = css;
    ctx.strokeStyle = css;
    ctx.lineWidth = fontPx * 0.34; // the halo's 0.15 em, doubled because a stroke straddles
    ctx.font = labelFont(fontPx);
    // Same wrap as the paint: a name straddling the antimeridian is inked on both edges.
    const half = (label.boxW * k) / 2;
    const x0 = label.x * k;
    const xs = x0 - half < 0 ? [x0, x0 + width] : x0 + half > width ? [x0, x0 - width] : [x0];
    for (const x of xs) {
      ctx.setTransform(label.scaleX, 0, 0, 1, x, label.y * k);
      ctx.rotate(label.tilt);
      ctx.strokeText(label.name, 0, 0);
      ctx.fillText(label.name, 0, 0);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const data = ctx.getImageData(0, 0, width, height).data;
  const { index, iso3s } = idMap;
  const ink = new Uint16Array(width * height);
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    const packed = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (packed === 0) continue;
    const id = lookup.get(packed);
    if (id === undefined) continue;
    if (displaced.has(id)) {
      // A name standing on its own country may overhang a neighbour and still win the click:
      // the letters of "Belgium" mean Belgium wherever they fall. A name that had to be moved
      // off its country is a different case — it carries a leader line and a dot to say where
      // it belongs, and it has landed on ground that is visibly someone else's. Letting that
      // ink outrank the polygon made **Paris select Switzerland** and Marseille select Monaco.
      // So a displaced name takes open water and its own land, and nothing else.
      const poly = index[p];
      if (poly !== 0 && iso3s[poly - 1] !== iso3s[id - 1]) continue;
    }
    ink[p] = id;
  }
  canvas.width = canvas.height = 1;

  // The dot at the end of a leader line is the one mark that says "this country is *here*",
  // and for a state too small to hold a pixel of its own at this resolution it is the only
  // one. So it is a target: a few pixels, stamped last and unconditionally, which is what
  // keeps Liechtenstein and San Marino reachable at all.
  for (const label of labels.labels) {
    if (!label.leader) continue;
    const id = byIso.get(label.iso3);
    if (id === undefined) continue;
    const cx = Math.round(label.leader.x * k);
    const cy = Math.round(label.leader.y * k);
    for (let dy = -DOT_PX; dy <= DOT_PX; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -DOT_PX; dx <= DOT_PX; dx++) {
        if (dx * dx + dy * dy > DOT_PX * DOT_PX) continue;
        ink[y * width + ((cx + dx + width) % width)] = id;
      }
    }
  }
  idMap.labelInk = ink;
}

/** Radius, in index pixels, of the clickable dot at a leader's landing point. */
const DOT_PX = 2;

/**
 * Make the printed names clickable — **only where nothing else already is**.
 *
 * A name is now the one part of a country a viewer can reliably aim at, so its box becomes
 * a pick target. The `=== 0` guard is the whole safety property: a label can take ocean, but
 * it can never take a pixel that belongs to a real polygon, so no country ever loses area to
 * a neighbour's name and the existing encoding and 3×3 fallback are untouched. Countries with
 * no polygon at this resolution (Tuvalu, Nauru, Monaco…) get an index appended here and become
 * pickable for the first time.
 *
 * The boxes are stamped in print order, which is descending area, so where two boxes were
 * allowed to touch the larger country wins — the same rule the layout itself used.
 */
function stampLabelBoxes(idMap: IdMap, labels: LabelLayout): Map<string, number> {
  const { width, height, index, iso3s } = idMap;
  const labelBox = new Uint16Array(width * height);
  idMap.labelBox = labelBox;
  const byIso = new Map<string, number>(iso3s.map((iso, i) => [iso, i + 1]));
  const k = width / labels.width;
  // Collected first, written after: every box is judged against the *polygon* index, so one
  // label's stamp cannot make the next label's fringe test lie.
  const pending: number[] = [];
  for (const label of labels.labels) {
    let id = byIso.get(label.iso3);
    if (id === undefined) {
      id = iso3s.push(label.iso3);
      byIso.set(label.iso3, id);
    }
    const halfW = (label.boxW * k) / 2;
    const halfH = (label.boxH * k) / 2;
    const cx = label.x * k;
    const cy = label.y * k;
    const y0 = Math.max(0, Math.round(cy - halfH));
    const y1 = Math.min(height - 1, Math.round(cy + halfH));
    const x0 = Math.round(cx - halfW);
    const x1 = Math.round(cx + halfW);
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      for (let x = x0; x <= x1; x++) {
        const xx = ((x % width) + width) % width; // wrap across the antimeridian
        const p = row + xx;
        if (index[p] !== 0) continue;
        // …and not the anti-aliased fringe of somebody else's coastline or border either.
        // Those pixels decode as 0 but they are not open water: `lookupId` resolves them with
        // a 3×3 vote, and a label box that swallows them takes the vote away. That is how
        // Marseille came to select Monaco — a coastal pixel France's polygon did not quite
        // cover at this resolution, claimed by a box from three degrees away.
        if (!isClearOfPolygons(index, width, height, xx, y)) continue;
        pending.push(p, id);
      }
    }
  }
  // Into the overlay, never into `index`: a box must not turn sea into land for anything
  // that asks a geography question. The guard still stands so two boxes cannot fight.
  for (let i = 0; i < pending.length; i += 2) {
    if (index[pending[i]] === 0 && labelBox[pending[i]] === 0) labelBox[pending[i]] = pending[i + 1];
  }
  return byIso;
}

/** True when neither the pixel nor any of its eight neighbours belongs to a polygon. */
function isClearOfPolygons(index: Uint16Array, width: number, height: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    const row = yy * width;
    for (let dx = -1; dx <= 1; dx++) {
      if (index[row + ((x + dx + width) % width)] !== 0) return false;
    }
  }
  return true;
}

/**
 * Look up the ISO3 under a UV.
 *
 * Ink first: if the pointer is on the glyphs of a printed name, that name's country wins
 * outright. Clicking the letters of "Belgium" can only mean Belgium, even though those letters
 * overhang France and the pixel belongs to France in the country index. Everywhere else — one
 * pixel off the letterforms — the country index answers exactly as it did before.
 *
 * Then the country index, where anti-aliased border pixels have no exact encoding (index 0),
 * so fall back to a 3×3 neighbourhood vote.
 */


export interface BuildTexturesOptions {
  /** Width of the visible map (height is half). */
  mapWidth: 8192 | 4096;
  /** Width of the picking index (height is half). Defaults to 4096. */
  idWidth?: number;
  /** Colours for the first paint. Swap later with `GlobeTextures.redraw`. */
  theme: GlobeTheme;
}

export function buildGlobeTextures(
  world: Topology,
  countries: Record<string, CountryRecord>,
  options: BuildTexturesOptions,
): GlobeTextures {
  const collection = pickCollection(world);
  const geometries = collection.geometries;
  // Indices into an 8-entry palette. Every theme's palette is 8 long, so these stay
  // valid for the life of the globe — the colouring is never recomputed on a switch.
  const colors = assignColors(geometries, options.theme.palette);

  const shapes = new Map<string, CountryShape>();
  const shapesByIndex: (CountryShape | null)[] = geometries.map((g, i) => {
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
    // g is narrowed to a polygonal geometry above, but feature()'s overloads only see GeometryObject.
    const f = feature(world, g) as GeoJSON.Feature<AreaGeometry, WorldProps>;
    const iso3 = String(g.id ?? '');
    const shape: CountryShape = {
      iso3,
      name: countries[iso3]?.name ?? g.properties?.name ?? iso3,
      geometry: f.geometry,
      paletteIndex: colors[i],
    };
    // Only real ISO3 codes go in the pick map; disputed "-99" style ids are still painted.
    if (/^[A-Z]{3}$/.test(iso3)) {
      const existing = shapes.get(iso3);
      if (existing) existing.geometry = mergeAreas(existing.geometry, shape.geometry);
      else shapes.set(iso3, shape);
    }
    return shape;
  });

  // The pick index comes first now, because the layout consults it: it is the only source of
  // "which polygon covers this point", and a name that lands on a neighbour cannot be clicked
  // in the middle (a label never takes an assigned pixel). Both are theme-independent and
  // built exactly once.
  const pickable = shapesByIndex.map((s) => (s && shapes.has(s.iso3) ? s : null));
  const idMap = buildIdMap(pickable, options.idWidth ?? 4096);
  const spans = new Map<string, number>();
  for (const shape of shapes.values()) spans.set(shape.iso3, mainLandmassSpan(shape.geometry));
  const labels = layoutLabels(countries, {
    // Territory, not ink: placement asks whose ground a name would stand on. The ink
    // index happens to be empty at this point, but saying so explicitly keeps this
    // correct if the build order ever changes.
    countryAt: (lat, lng) => lookupCountryId(idMap, (lng + 180) / 360, (lat + 90) / 180),
    lngSpanOf: (iso3) => spans.get(iso3) ?? null,
  });
  buildLabelInkIndex(idMap, labels, stampLabelBoxes(idMap, labels));

  const width = options.mapWidth;
  const [map, mapCtx] = makeCanvas(width, width / 2);
  // Theme-independent and costly: computed once, reused by every repaint. The arc mesh AND
  // the traced paths both live here — a repaint should swap colours, not re-walk geometry.
  const borderMesh = mesh(world, collection);
  const borders = new Path2D();
  traceLines(borders, borderMesh, width, width / 2);
  const paths: PaintPaths = {
    borders,
    fills: shapesByIndex.map((shape) => {
      if (!shape) return null;
      const path = new Path2D();
      traceGeometry(path, shape.geometry, width, width / 2);
      return path;
    }),
  };
  paintMap(mapCtx, shapesByIndex, paths, labels, width, options.theme);

  return {
    map,
    idMap,
    shapes,
    labels,
    redraw(theme) {
      paintMap(mapCtx, shapesByIndex, paths, labels, width, theme);
    },
  };
}
