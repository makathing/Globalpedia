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
import { projectX, projectY } from './math';

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
  /** Index into PALETTE. */
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
}

/** Eight muted pastels, in the order the greedy colouring prefers them. */
export const PALETTE = [
  '#f2e2a3', // buttery yellow
  '#f0b9a4', // salmon
  '#c5d5ae', // sage
  '#d5c5e4', // lilac
  '#f6d1ad', // peach
  '#bfe1cf', // mint
  '#a9c7e2', // sky
  '#eac0cb', // rose
];

export const OCEAN = '#cfe6f2';
export const OUTLINE = '#3b2f2a';

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
function assignColors(geometries: GeometryObject<WorldProps>[]): number[] {
  const adj = neighbors(geometries);
  const n = geometries.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => adj[b].length - adj[a].length);
  const colors = new Array<number>(n).fill(-1);
  for (const i of order) {
    const used = new Array<number>(PALETTE.length).fill(0);
    for (const j of adj[i]) if (colors[j] >= 0) used[colors[j]]++;
    // Deterministic tie-break so the same file always yields the same map:
    // start the scan at a position derived from the geometry id.
    const id = String(geometries[i].id ?? i);
    let hash = 0;
    for (let k = 0; k < id.length; k++) hash = (hash * 31 + id.charCodeAt(k)) >>> 0;
    const start = hash % PALETTE.length;
    let best = -1;
    let bestCount = Infinity;
    for (let k = 0; k < PALETTE.length; k++) {
      const c = (start + k) % PALETTE.length;
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
  ctx: CanvasRenderingContext2D,
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

function traceLines(ctx: CanvasRenderingContext2D, lines: GeoJSON.MultiLineString, width: number, height: number): void {
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

/** A tiling grey-speckle pattern that reads as paper grain when drawn at low alpha. */
function makeGrainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const size = 256;
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;
  const img = tctx.createImageData(size, size);
  const d = img.data;
  // Seeded LCG so the grain is deterministic between runs.
  let seed = 12345;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = (seed >>> 24) & 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  return ctx.createPattern(tile, 'repeat');
}

function drawGraticule(ctx: CanvasRenderingContext2D, width: number, height: number, s: number): void {
  ctx.save();
  ctx.strokeStyle = OUTLINE;
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
 * Build the visible map. `width` should be 8192 or 4096; everything scales with it.
 */
function drawMap(
  world: Topology,
  collection: GeometryCollection<WorldProps>,
  shapesByIndex: (CountryShape | null)[],
  width: number,
): HTMLCanvasElement {
  const height = width / 2;
  const s = width / 8192; // stroke widths are specified "at 8k"
  const [canvas, ctx] = makeCanvas(width, height);

  // Ocean.
  ctx.fillStyle = OCEAN;
  ctx.fillRect(0, 0, width, height);

  // Country fills.
  for (const shape of shapesByIndex) {
    if (!shape) continue;
    ctx.fillStyle = PALETTE[shape.paletteIndex];
    ctx.beginPath();
    traceGeometry(ctx, shape.geometry, width, height);
    ctx.fill('evenodd');
  }

  // Paper grain over everything (land and sea), very subtle.
  const grain = makeGrainPattern(ctx);
  if (grain) {
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  drawGraticule(ctx, width, height, s);

  // Borders and coastlines — mesh() yields every arc exactly once.
  const borders = mesh(world, collection);
  ctx.save();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5 * s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  traceLines(ctx, borders, width, height);
  ctx.stroke();
  ctx.restore();

  return canvas;
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
}

export function buildGlobeTextures(
  world: Topology,
  countries: Record<string, CountryRecord>,
  options: BuildTexturesOptions,
): GlobeTextures {
  const collection = pickCollection(world);
  const geometries = collection.geometries;
  const colors = assignColors(geometries);

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

  const map = drawMap(world, collection, shapesByIndex, options.mapWidth);
  const pickable = shapesByIndex.map((s) => (s && shapes.has(s.iso3) ? s : null));
  const idMap = buildIdMap(pickable, options.idWidth ?? 4096);
  return { map, idMap, shapes };
}
