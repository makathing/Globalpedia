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
import { projectX, projectY } from './math';
import { compositeSurface, drawAging, drawGoreSeams } from './surface';

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

/** Nearest-pixel ISO3 lookup. `index[y * width + x]` is 0 for ocean, else 1 + position in `iso3s`. */
export interface IdMap {
  width: number;
  height: number;
  index: Uint16Array;
  iso3s: string[];
}

export interface GlobeTextures {
  map: HTMLCanvasElement;
  idMap: IdMap;
  /** Keyed by ISO3, for the highlight layer. */
  shapes: Map<string, CountryShape>;
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

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

function drawGraticule(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number,
  ink: string,
): void {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineCap = 'butt';

  // Every 15° — thin, low alpha. The ±90° parallels collapse to the raster edge, skip them.
  ctx.globalAlpha = 0.17;
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  for (let lon = -180; lon < 180; lon += 15) {
    const x = Math.round(projectX(lon, width)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
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

  drawGraticule(ctx, width, height, s, theme.graticule);

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

  // The physical surface, in the order a real object acquires it.
  compositeSurface(ctx, width, height, theme.surface, theme.grainAlpha);
  drawAging(ctx, width, height, s, theme);
  drawGoreSeams(ctx, width, height, s, theme);

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
  return { width, height, index, iso3s };
}

/**
 * Look up the ISO3 under a UV. Anti-aliased border pixels have no exact
 * encoding (index 0), so fall back to a 3×3 neighbourhood vote.
 */
export function lookupId(idMap: IdMap, u: number, v: number): string | null {
  const { width, height, index, iso3s } = idMap;
  const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
  const direct = index[y * width + x];
  if (direct) return iso3s[direct - 1];
  const votes = new Map<number, number>();
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = (x + dx + width) % width; // wrap across the antimeridian
      const id = index[yy * width + xx];
      if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestVotes = 0;
  for (const [id, n] of votes) {
    if (n > bestVotes) {
      best = id;
      bestVotes = n;
    }
  }
  return best ? iso3s[best - 1] : null;
}

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
    if (/^[A-Z]{3}$/.test(iso3)) shapes.set(iso3, shape);
    return shape;
  });

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
  paintMap(mapCtx, shapesByIndex, paths, width, options.theme);

  const pickable = shapesByIndex.map((s) => (s && shapes.has(s.iso3) ? s : null));
  const idMap = buildIdMap(pickable, options.idWidth ?? 4096);

  return {
    map,
    idMap,
    shapes,
    redraw(theme) {
      paintMap(mapCtx, shapesByIndex, paths, width, theme);
    },
  };
}
