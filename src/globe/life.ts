/**
 * Life on the globe — ships under sail and animals where they actually live, at ant scale.
 *
 * The whole feature rides on one observation: `lookupCountryId(idMap, u, v)` already answers
 * "what is under this point of the planet?" for every point of the planet, and it answers
 * `null` for ocean. That is a complete land/water oracle, already built and already in
 * memory, so this file needs no coastline geometry and no new data. Every placement and
 * every single movement step is *verified* against it rather than assumed: a camel in the
 * Atlantic is the one bug this feature can most easily ship with, and the only defence that
 * actually works is to reject the step, not to trust the table.
 *
 * Three rules, in the house style:
 *
 *  1. **Determinism.** Nothing here calls `Math.random`. Every creature's home, kind, speed
 *     and wander comes from a `mulberry32` seeded off `opts.seed`, so the same seed puts the
 *     same whale in the same part of the same sea on every machine and every reload.
 *
 *  2. **One draw call.** All ~450 creatures are instances of a single tangent-aligned quad in
 *     one `InstancedMesh`, sampling one procedurally drawn silhouette atlas. Instanced rather
 *     than `Points` because a ship has to point where it is going.
 *
 *  3. **Sleep by default.** The app renders on demand. `update()` returns `false` whenever
 *     nothing visibly changed — out of range, disabled, or frozen by `prefers-reduced-motion` —
 *     so the host's loop can go straight back to sleep. At the default camera distance the
 *     opacity ramp is at zero and the sim does not run at all: life is *discovered* by leaning in.
 *
 * The atlas carries no colour, only two coverage masks (body in R, halo in G), so a theme
 * switch is two uniform writes and never a repaint.
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  NoColorSpace,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import type { GlobeTheme } from '../core/themes';
import { DEG, latLngToVector3, smoothstep } from './math';
import { mulberry32 } from './surface';
import { lookupCountryId, type IdMap } from './texture';

/* ── public surface ─────────────────────────────────────────────────────────────────────── */

export interface LifeOptions {
  /** Seeds every placement and every wander. Same seed, same world. */
  seed?: number;
  /** Roughly how many creatures to place (default 440). Split across ships / sea / land. */
  count?: number;
}

export interface LifeHandle {
  /** Add this to the same parent as the sphere. */
  group: Object3D;
  /** Advance the simulation. Returns true if anything visibly changed (drives the render loop). */
  update(dt: number, cameraDistance: number): boolean;
  restyle(theme: GlobeTheme): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

/* ── tuning ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Just clear of the surface. Close enough that a creature never floats off its coastline at a
 * grazing angle, far enough that it never z-fights the sphere. With `depthTest: true` the
 * opaque sphere occludes the far hemisphere for free — no per-instance facing test needed.
 */
const LIFE_RADIUS = 1.0035;

/**
 * World size of the quad, as a fraction of the globe radius. The drawing itself only fills
 * `CELL_INSET` of that, so the ink measures about 0.0035 R — at the closest the controls allow
 * (1.6 from the orbit target, so ~0.6 from the surface) that is 7 CSS pixels for a schooner and
 * 11 for a whale, against a globe some 2000 pixels across. Genuinely ant-sized, but *drawn*:
 * one notch smaller and they stop being creatures and become dust on the varnish.
 */
const BASE_SCALE = 0.0052;

/**
 * The discovery ramp, in camera distance from the view target. `DEFAULT_DISTANCE` is 3.9 and
 * `MIN_DISTANCE` is 1.6, so the default pose still sits hard at zero: the globe is lifeless
 * until the viewer leans in, which is the point.
 *
 * But the ramp used to start at 3.15 and only fill in at 2.15 — two thirds of the way to the
 * closest the controls allow — and with creatures this sparse the first person to look simply
 * could not find them. The ramp now opens almost as soon as the viewer starts zooming, so the
 * reward arrives while they are still moving towards it rather than after they have given up.
 */
const FADE_FAR = 3.72;
const FADE_NEAR = 2.55;
/** Below this the layer is switched off entirely and the simulation stops. */
const ALPHA_EPSILON = 0.004;

/** Silhouette atlas geometry. Small on purpose: these are never more than ~16 px on screen. */
const CELL = 64;
const ATLAS_COLS = 5;
const ATLAS_ROWS = 4;
/** Fraction of a cell the drawing may use. The rest is gutter, so linear filtering never bleeds. */
const CELL_INSET = 0.82;

/* ── geography helpers ──────────────────────────────────────────────────────────────────── */

/**
 * The (u, v) the id map wants. It is fed raycast hits against `SphereGeometry`, whose default
 * UV layout has v = 1 at the **north** pole — not the raster's top-down v — so the latitude
 * term is (lat + 90) / 180 and not its complement. Getting this backwards mirrors the planet
 * about the equator, which is exactly the kind of bug that puts penguins in Siberia, so the
 * harness asserts a handful of known points rather than trusting this comment.
 */
function uvOf(lat: number, lng: number): [number, number] {
  const u = (((lng + 180) / 360) % 1 + 1) % 1;
  const v = (lat + 90) / 180;
  return [u, v < 0 ? 0 : v > 1 ? 1 : v];
}

/** ISO3 under a geographic point, or null for ocean. The land/water oracle, whole planet. */
function isoAt(idMap: IdMap, lat: number, lng: number): string | null {
  const [u, v] = uvOf(lat, lng);
  // Territory, not ink: a name printed out over the sea must not read as land.
  return lookupCountryId(idMap, u, v);
}

/** Unit vector → geographic, the exact inverse of `latLngToVector3` (see math.ts). */
function toLatLng(p: Vector3, out: { lat: number; lng: number }): void {
  const y = p.y < -1 ? -1 : p.y > 1 ? 1 : p.y;
  out.lat = Math.asin(y) / DEG;
  out.lng = Math.atan2(-p.z, p.x) / DEG;
}

/** Local east and north unit vectors at a geographic point (sphere-local frame). */
function eastAt(_lat: number, lng: number, out: Vector3): Vector3 {
  const l = lng * DEG;
  return out.set(-Math.sin(l), 0, -Math.cos(l));
}
function northAt(lat: number, lng: number, out: Vector3): Vector3 {
  const p = lat * DEG;
  const l = lng * DEG;
  return out.set(-Math.sin(p) * Math.cos(l), Math.cos(p), Math.sin(p) * Math.sin(l));
}

/** Great-circle distance in degrees. */
function arcDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const s =
    Math.sin(aLat * DEG) * Math.sin(bLat * DEG) +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.cos((bLng - aLng) * DEG);
  return Math.acos(s < -1 ? -1 : s > 1 ? 1 : s) / DEG;
}

/** Initial bearing from a to b, in radians clockwise from north. */
function bearingTo(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dl = (bLng - aLng) * DEG;
  const y = Math.sin(dl) * Math.cos(bLat * DEG);
  const x =
    Math.cos(aLat * DEG) * Math.sin(bLat * DEG) -
    Math.sin(aLat * DEG) * Math.cos(bLat * DEG) * Math.cos(dl);
  return Math.atan2(y, x);
}

/* ── the cast ───────────────────────────────────────────────────────────────────────────── */

type Kind =
  | 'steamer'
  | 'schooner'
  | 'fishing'
  | 'whale'
  | 'dolphins'
  | 'turtle'
  | 'seabirds'
  | 'penguin'
  | 'polarbear'
  | 'camel'
  | 'elephant'
  | 'kangaroo'
  | 'panda'
  | 'llama'
  | 'reindeer'
  | 'tiger'
  | 'bison';

/** Atlas cell order. Index into this is the instance's `aCell`. */
const KINDS: readonly Kind[] = [
  'steamer', 'schooner', 'fishing', 'whale', 'dolphins',
  'turtle', 'seabirds', 'penguin', 'polarbear', 'camel',
  'elephant', 'kangaroo', 'panda', 'llama', 'reindeer',
  'tiger', 'bison',
];

/** Per-kind size multiplier on `BASE_SCALE`. A whale is not a penguin. */
const KIND_SCALE: Record<Kind, number> = {
  steamer: 1.25, schooner: 1.2, fishing: 0.85,
  whale: 1.7, dolphins: 1.3, turtle: 1.0, seabirds: 1.25,
  penguin: 0.85, polarbear: 1.0, camel: 1.0, elephant: 1.25, kangaroo: 0.95,
  panda: 0.95, llama: 0.95, reindeer: 1.0, tiger: 1.05, bison: 1.15,
};

/** Degrees of arc per second. Ships make way; a sea turtle does not. */
const KIND_SPEED: Record<Kind, number> = {
  steamer: 0.46, schooner: 0.34, fishing: 0.11,
  whale: 0.09, dolphins: 0.17, turtle: 0.05, seabirds: 0.22,
  penguin: 0.05, polarbear: 0.07, camel: 0.06, elephant: 0.06, kangaroo: 0.09,
  panda: 0.04, llama: 0.05, reindeer: 0.07, tiger: 0.07, bison: 0.06,
};

/**
 * Which silhouettes are drawn looking **down** on the creature. Those may take any roll in the
 * tangent plane, because from above every heading is as good as another. Everything else is
 * drawn in profile — a ship, an elephant, a camel — and a profile rolled to a southerly heading
 * is simply upside down, which is the single most "a computer did this" thing this layer could
 * do. Profiles therefore stay upright with local north up and are *mirrored* to face their way,
 * exactly as ships and beasts are drawn in the margins of a real printed globe.
 */
function isPlanView(kind: Kind): boolean {
  return kind === 'turtle' || kind === 'seabirds';
}

/* ── ports and routes ───────────────────────────────────────────────────────────────────── */

/**
 * Two dozen real ports, given at their **seaward approach** rather than at the quay, because
 * the quay is a pixel of land in the index and a ship standing on it would fail its own
 * geography check. Every one of these is verified to be ocean at build time.
 */
const PORTS: Record<string, [number, number]> = {
  newyork: [40.45, -73.75],
  lisbon: [38.6, -9.45],
  rotterdam: [51.98, 3.8],
  gibraltar: [35.95, -5.55],
  marseille: [43.2, 5.4],
  piraeus: [37.8, 23.6],
  alexandria: [31.35, 29.9],
  dakar: [14.55, -17.6],
  lagos: [5.9, 3.4],
  capetown: [-34.2, 18.3],
  durban: [-30.0, 31.3],
  mombasa: [-4.2, 39.9],
  aden: [12.7, 45.0],
  mumbai: [18.9, 72.55],
  colombo: [6.85, 79.7],
  singapore: [1.2, 104.4],
  hongkong: [22.15, 114.25],
  shanghai: [30.8, 122.4],
  yokohama: [35.2, 140.0],
  honolulu: [21.15, -157.9],
  sanfrancisco: [37.7, -122.9],
  valparaiso: [-33.1, -71.8],
  buenosaires: [-35.3, -56.2],
  rio: [-23.2, -43.15],
  sydney: [-33.95, 151.4],
  auckland: [-36.6, 175.2],
};

type Mark = string | [number, number];

/**
 * Sailing directions, not straight lines between ports. A great circle from New York to
 * Rotterdam runs over Wales; one from Colombo to Singapore runs over Sumatra. Real routes are
 * chains of short ocean legs around the capes, so that is what these are — port names with
 * open-water marks between them, each leg a great circle the ship actually follows.
 *
 * No canals: Suez and Panama are land in the index, and "a ship must never cross a continent"
 * is the harder promise. So the eastern runs go round the Cape and the Pacific runs round the
 * Horn, which is also the more school-globe answer.
 */
const ROUTES: Mark[][] = [
  // North Atlantic, north-about Scotland rather than through the Dover Strait (which is
  // three pixels wide in a 4096-column index and would be a coin flip every voyage).
  ['newyork', [42, -64], [47, -42], [52, -25], [57, -13], [60, -4], [59, 1], [55, 3], 'rotterdam'],
  // The Lisbon packet.
  ['newyork', [38, -60], [38, -35], [38, -20], 'lisbon', 'gibraltar'],
  // Mediterranean coasting trade.
  ['gibraltar', [36.5, -2], [37.5, 1.5], 'marseille', [38.5, 11], [36.5, 17], 'piraeus', [34.5, 27], 'alexandria'],
  // Down the west coast of Africa.
  ['lisbon', [33, -11], [25, -17], 'dakar', [8, -15], [4, -4], 'lagos'],
  // The Cape route.
  ['lagos', [0, 5], [-10, 6], [-20, 9], [-30, 14], 'capetown', [-35, 23], 'durban', [-25, 36], [-12, 43], 'mombasa'],
  // Arabian Sea and the Malabar coast.
  ['mombasa', [-2, 44], [5, 49], 'aden', [13, 52], [18, 62], 'mumbai', [12, 74], 'colombo'],
  // The long southern passage to Australia, through Bass Strait.
  ['colombo', [-5, 85], [-20, 95], [-32, 110], [-35, 118], [-37, 130], [-39, 142], [-39.8, 147], 'sydney'],
  // China coast and the run up to Japan, south-about Kyushu and Shikoku.
  ['singapore', [4, 107], [12, 111], 'hongkong', [24, 119], 'shanghai', [30, 126], [30, 131], [31, 134], [33, 137], 'yokohama'],
  // Tasman and the islands.
  ['sydney', [-35, 158], [-36, 170], 'auckland', [-25, 178], [-15, -168], [-2, -162], 'honolulu'],
  // Great circle across the North Pacific.
  ['yokohama', [38, 150], [45, 170], [48, -170], [45, -150], [40, -130], 'sanfrancisco'],
  // San Francisco to Hawaii and on to the China Sea.
  ['sanfrancisco', [32, -135], 'honolulu', [15, -170], [7, 175], [11, 150], [15, 130], 'hongkong'],
  // The South Pacific, in the westerlies.
  ['sydney', [-38, 165], [-42, -175], [-44, -140], [-40, -100], [-35, -80], 'valparaiso'],
  // Round the Horn.
  ['valparaiso', [-40, -75], [-50, -78], [-56, -70], [-52, -62], [-45, -58], 'buenosaires'],
  // The Brazil run and back across to Africa.
  ['buenosaires', [-32, -50], 'rio', [-20, -38], [-10, -33], [-2, -30], [8, -22], 'dakar'],
  // New York to Brazil, well outside the Bahama banks.
  ['newyork', [33, -74], [28, -76], [22, -68], [15, -58], [5, -50], [-8, -35], 'rio'],
  // Indian Ocean crossing.
  ['mumbai', [15, 68], [8, 60], [0, 55], [-8, 48], 'mombasa'],
];

/* ── land regions ───────────────────────────────────────────────────────────────────────── */

/**
 * Where each land animal actually lives. A box is only the *search* area; membership is decided
 * by the index — a point must be land, and it must be land belonging to one of `iso`. That
 * second test is what keeps the Sichuan pandas out of Kazakhstan and the Andean llamas off the
 * Brazilian side of the divide, without anyone having to draw a range map.
 */
interface Region {
  kind: Kind;
  /** Search box: [latMin, latMax, lngMin, lngMax]. */
  box: [number, number, number, number];
  /** Acceptable ISO3 codes. */
  iso: readonly string[];
  /** How far from its birth point an animal may wander, in degrees of arc. */
  roam: number;
  /** Relative share of the land population. */
  weight: number;
}

const REGIONS: readonly Region[] = [
  // Antarctica, all round the coast — the interior is ice, the birds are on the edge.
  { kind: 'penguin', box: [-78, -63, -180, 180], iso: ['ATA'], roam: 3, weight: 1.3 },
  // The high Arctic: Greenland, the Canadian archipelago, Svalbard, the Siberian coast, the
  // North Slope. Everything above 69° that is land is polar bear country and nothing else is.
  { kind: 'polarbear', box: [69, 83, -180, 180], iso: ['GRL', 'CAN', 'RUS', 'NOR', 'USA'], roam: 4, weight: 1.1 },
  // Sahara.
  { kind: 'camel', box: [15, 30, -13, 33], iso: ['MAR', 'ESH', 'DZA', 'TUN', 'LBY', 'EGY', 'MRT', 'MLI', 'NER', 'TCD', 'SDN'], roam: 4, weight: 1.1 },
  // Arabia.
  { kind: 'camel', box: [16, 30, 35, 57], iso: ['SAU', 'OMN', 'YEM', 'ARE', 'JOR', 'IRQ', 'KWT', 'QAT'], roam: 3, weight: 0.7 },
  // East African savannah.
  { kind: 'elephant', box: [-8, 5, 29, 41], iso: ['KEN', 'TZA', 'UGA', 'RWA', 'BDI', 'ZMB', 'MWI'], roam: 3, weight: 1.0 },
  { kind: 'kangaroo', box: [-36, -17, 114, 152], iso: ['AUS'], roam: 4, weight: 1.1 },
  { kind: 'panda', box: [27.5, 34, 101, 109], iso: ['CHN'], roam: 1.5, weight: 0.7 },
  // The altiplano and the Peruvian sierra.
  { kind: 'llama', box: [-23, -8, -73, -65], iso: ['PER', 'BOL', 'CHL', 'ARG'], roam: 2.5, weight: 0.8 },
  { kind: 'reindeer', box: [65.5, 71, 15, 40], iso: ['NOR', 'SWE', 'FIN', 'RUS'], roam: 3, weight: 0.9 },
  // The hinterland of the Bay of Bengal.
  { kind: 'tiger', box: [19, 28, 82, 96], iso: ['IND', 'BGD', 'MMR', 'NPL', 'BTN'], roam: 2.5, weight: 0.9 },
  { kind: 'bison', box: [38, 53, -112, -95], iso: ['USA', 'CAN'], roam: 4, weight: 1.0 },
];

/* ── silhouettes ────────────────────────────────────────────────────────────────────────── */

/**
 * A drawing, held as geometry rather than pixels so the same paths can be rendered twice: once
 * filled, for the ink mask, and once stroked wide, for the paper halo behind it. Two masks, one
 * set of paths, no duplicated draw code and no colour anywhere in the atlas.
 */
interface Sketch {
  fills: Path2D[];
  lines: { path: Path2D; w: number }[];
}

function sketch(): Sketch {
  return { fills: [], lines: [] };
}
function line(s: Sketch, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const p = new Path2D();
  p.moveTo(x0, y0);
  p.lineTo(x1, y1);
  s.lines.push({ path: p, w });
}
function poly(s: Sketch, pts: number[]): void {
  const p = new Path2D();
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
  p.closePath();
  s.fills.push(p);
}
function oval(s: Sketch, x: number, y: number, rx: number, ry: number, rot = 0): void {
  const p = new Path2D();
  p.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  s.fills.push(p);
}

/** A hull, drawn bow-right: flat sheer, raked stem, cut-up counter. */
function hull(s: Sketch, len: number, depth: number, y: number): void {
  poly(s, [
    -len, y,
    len * 0.86, y,
    len, y + depth * 0.5,
    len * 0.72, y + depth,
    -len * 0.84, y + depth,
    -len, y + depth * 0.45,
  ]);
}

/**
 * The common four-legged body. Every land animal on the globe is one of these with its
 * proportions pushed around — a bison is a shoulder hump, a camel is a back hump and a long
 * neck, a tiger is low and long. At six pixels the profile is the whole animal, so the
 * parameters are exactly the ones that survive being six pixels tall.
 */
interface Beast {
  /** Half-length of the barrel. */
  len: number;
  /** Half-depth of the barrel. */
  thick: number;
  /** Barrel centre height (negative is up). */
  y: number;
  leg: number;
  legW: number;
  /** Rise of the withers above the barrel, at `humpX`. */
  hump: number;
  humpX: number;
  /** Neck length and lean, radians from vertical; larger leans the head forward. */
  neck: number;
  lean: number;
  head: number;
  /** 0 none, 1 tuft, 2 long. */
  tail: number;
}

function beast(s: Sketch, b: Beast): void {
  const { len, thick, y, leg, legW, hump, humpX } = b;
  // Barrel, with the withers raised where the hump wants to be.
  const body = new Path2D();
  body.moveTo(-len, y);
  body.quadraticCurveTo(humpX, y - thick - hump, len, y - thick * 0.75);
  body.quadraticCurveTo(len + thick * 0.35, y, len * 0.9, y + thick);
  body.quadraticCurveTo(0, y + thick * 1.25, -len, y + thick * 0.8);
  body.closePath();
  s.fills.push(body);

  const foot = y + thick + leg;
  for (const [lx, k] of [[-len * 0.72, 1], [-len * 0.45, 0.94], [len * 0.5, 0.94], [len * 0.76, 1]] as const) {
    poly(s, [
      lx - legW, y + thick * 0.3,
      lx + legW, y + thick * 0.3,
      lx + legW * 0.7, y + thick + leg * k,
      lx - legW * 0.7, foot,
    ]);
  }

  // Neck and head, swung forward from the shoulder.
  const sx = len * 0.82;
  const sy = y - thick * 0.5;
  const hx = sx + Math.sin(b.lean) * b.neck;
  const hy = sy - Math.cos(b.lean) * b.neck;
  const nw = b.head * 0.62;
  poly(s, [sx - nw, sy + thick * 0.5, sx + nw, sy, hx + nw * 0.7, hy, hx - nw * 0.7, hy + nw]);
  oval(s, hx + b.head * 0.35, hy, b.head, b.head * 0.72, b.lean * 0.5);

  if (b.tail === 1) line(s, -len, y, -len - 0.06, y + thick + 0.05, 0.035);
  else if (b.tail === 2) line(s, -len, y - thick * 0.2, -len - 0.18, y + thick * 0.9, 0.03);
}

/**
 * Every silhouette in the atlas, drawn in a unit cell: the creature faces **+x**, which the
 * instance matrix then aligns with its heading, and occupies roughly [-0.5, 0.5] in both axes.
 */
function drawKind(kind: Kind): Sketch {
  const s = sketch();
  switch (kind) {
    case 'steamer': {
      hull(s, 0.46, 0.15, -0.01);
      poly(s, [-0.14, -0.13, 0.17, -0.13, 0.17, -0.01, -0.14, -0.01]);
      poly(s, [0.0, -0.28, 0.1, -0.28, 0.09, -0.12, -0.01, -0.12]);
      oval(s, -0.05, -0.33, 0.055, 0.045);
      oval(s, -0.16, -0.37, 0.042, 0.034);
      oval(s, -0.27, -0.4, 0.03, 0.025);
      line(s, 0.31, -0.02, 0.31, -0.25, 0.024);
      line(s, -0.26, -0.02, -0.26, -0.22, 0.022);
      break;
    }
    case 'schooner': {
      hull(s, 0.4, 0.14, 0.05);
      line(s, 0.03, 0.05, 0.03, -0.45, 0.026);
      line(s, 0.27, 0.05, 0.27, -0.32, 0.022);
      line(s, 0.4, 0.06, 0.55, -0.02, 0.02);
      const main = new Path2D();
      main.moveTo(0.05, -0.42);
      main.quadraticCurveTo(0.3, -0.22, 0.06, -0.03);
      main.closePath();
      s.fills.push(main);
      const aft = new Path2D();
      aft.moveTo(0.0, -0.38);
      aft.quadraticCurveTo(-0.27, -0.19, -0.02, -0.03);
      aft.closePath();
      s.fills.push(aft);
      const fore = new Path2D();
      fore.moveTo(0.29, -0.3);
      fore.quadraticCurveTo(0.47, -0.15, 0.3, -0.01);
      fore.closePath();
      s.fills.push(fore);
      break;
    }
    case 'fishing': {
      hull(s, 0.3, 0.14, 0.03);
      poly(s, [-0.15, -0.11, 0.04, -0.11, 0.04, 0.02, -0.15, 0.02]);
      line(s, 0.11, 0.03, 0.11, -0.3, 0.026);
      line(s, 0.11, -0.28, -0.28, -0.05, 0.018);
      break;
    }
    case 'whale': {
      // Blunt head, deep jaw, heavy tailstock. At eight pixels the fluke is the whole animal,
      // so it is drawn well oversize and the head is kept round rather than pointed.
      const b = new Path2D();
      b.moveTo(-0.24, -0.02);
      b.quadraticCurveTo(-0.04, -0.22, 0.26, -0.16);
      b.quadraticCurveTo(0.46, -0.12, 0.45, 0.0);
      b.quadraticCurveTo(0.44, 0.14, 0.22, 0.17);
      b.quadraticCurveTo(-0.02, 0.2, -0.24, 0.08);
      b.closePath();
      s.fills.push(b);
      poly(s, [-0.2, 0.03, -0.52, -0.2, -0.38, 0.03, -0.52, 0.25]);
      poly(s, [-0.04, -0.18, 0.03, -0.32, 0.12, -0.16]);
      poly(s, [0.14, 0.13, 0.04, 0.3, 0.24, 0.16]);
      // The blow: one short plume, thin enough that it never reads as a pair of ears.
      line(s, 0.31, -0.2, 0.29, -0.34, 0.016);
      line(s, 0.31, -0.2, 0.37, -0.32, 0.016);
      break;
    }
    case 'dolphins': {
      // Two animals breaking the surface together, stacked rather than crossed: overlapping
      // them merges into one unreadable blob the moment the atlas is minified.
      const one = (x: number, y: number, k: number): void => {
        const p = new Path2D();
        p.moveTo(x - 0.26 * k, y + 0.1 * k);
        p.quadraticCurveTo(x - 0.02 * k, y - 0.14 * k, x + 0.26 * k, y - 0.06 * k);
        p.quadraticCurveTo(x + 0.36 * k, y - 0.02 * k, x + 0.24 * k, y + 0.03 * k);
        p.quadraticCurveTo(x + 0.0 * k, y + 0.01 * k, x - 0.2 * k, y + 0.17 * k);
        p.closePath();
        s.fills.push(p);
        poly(s, [x + 0.0 * k, y - 0.09 * k, x + 0.05 * k, y - 0.24 * k, x + 0.11 * k, y - 0.07 * k]);
        poly(s, [x - 0.24 * k, y + 0.11 * k, x - 0.38 * k, y + 0.03 * k, x - 0.33 * k, y + 0.2 * k]);
      };
      one(0.22, -0.23, 0.6);
      one(-0.1, 0.15, 0.84);
      break;
    }
    case 'turtle': {
      // Seen from above. The flippers have to reach clear of the shell and taper, or the whole
      // thing minifies into a pebble.
      oval(s, -0.02, 0.0, 0.27, 0.23);
      oval(s, 0.31, 0.0, 0.085, 0.07);
      poly(s, [0.14, -0.16, 0.28, -0.33, 0.35, -0.26, 0.22, -0.09]);
      poly(s, [0.14, 0.16, 0.28, 0.33, 0.35, 0.26, 0.22, 0.09]);
      poly(s, [-0.16, -0.17, -0.3, -0.31, -0.36, -0.23, -0.23, -0.09]);
      poly(s, [-0.16, 0.17, -0.3, 0.31, -0.36, 0.23, -0.23, 0.09]);
      poly(s, [-0.27, -0.035, -0.37, 0.0, -0.27, 0.035]);
      break;
    }
    case 'seabirds': {
      // Four gulls in echelon, drawn as thin sharp chevrons. Fat strokes here read as ticks
      // of dirt rather than birds, so these are the thinnest lines in the atlas.
      const bird = (x: number, y: number, k: number): void => {
        const p = new Path2D();
        p.moveTo(x - 0.24 * k, y - 0.15 * k);
        p.lineTo(x, y + 0.06 * k);
        p.lineTo(x + 0.24 * k, y - 0.15 * k);
        s.lines.push({ path: p, w: 0.04 * k });
      };
      bird(0.16, -0.16, 1.0);
      bird(-0.08, 0.02, 0.85);
      bird(-0.3, 0.2, 0.7);
      bird(0.2, 0.24, 0.6);
      break;
    }
    case 'penguin': {
      oval(s, -0.02, 0.06, 0.17, 0.26);
      oval(s, 0.03, -0.25, 0.13, 0.13);
      poly(s, [0.14, -0.27, 0.3, -0.24, 0.14, -0.2]);
      const flip = new Path2D();
      flip.moveTo(-0.14, -0.08);
      flip.quadraticCurveTo(-0.3, 0.12, -0.1, 0.18);
      flip.closePath();
      s.fills.push(flip);
      poly(s, [-0.02, 0.3, 0.2, 0.36, -0.02, 0.36]);
      poly(s, [-0.16, 0.3, -0.02, 0.36, -0.16, 0.36]);
      break;
    }
    case 'polarbear':
      beast(s, { len: 0.3, thick: 0.11, y: -0.02, leg: 0.16, legW: 0.055, hump: 0.03, humpX: 0.1, neck: 0.06, lean: 1.1, head: 0.1, tail: 1 });
      break;
    case 'camel': {
      beast(s, { len: 0.24, thick: 0.085, y: -0.03, leg: 0.22, legW: 0.04, hump: 0.02, humpX: 0.0, neck: 0.19, lean: 0.42, head: 0.07, tail: 1 });
      // The hump has to be a lump standing proud of the back, not a smoothly arched spine —
      // a raised withers is a bison, and the two must not be the same animal at eight pixels.
      const h = new Path2D();
      h.moveTo(-0.1, -0.1);
      h.quadraticCurveTo(-0.02, -0.31, 0.12, -0.1);
      h.closePath();
      s.fills.push(h);
      break;
    }
    case 'elephant': {
      beast(s, { len: 0.3, thick: 0.15, y: -0.05, leg: 0.16, legW: 0.075, hump: 0.05, humpX: -0.05, neck: 0.03, lean: 0.9, head: 0.13, tail: 1 });
      // Trunk and ear, which is the whole silhouette at this size.
      const trunk = new Path2D();
      trunk.moveTo(0.42, -0.05);
      trunk.quadraticCurveTo(0.56, 0.06, 0.47, 0.22);
      trunk.lineTo(0.4, 0.2);
      trunk.quadraticCurveTo(0.47, 0.06, 0.36, -0.03);
      trunk.closePath();
      s.fills.push(trunk);
      oval(s, 0.26, -0.06, 0.1, 0.12, -0.25);
      break;
    }
    case 'kangaroo': {
      const b = new Path2D();
      b.moveTo(-0.06, -0.3);
      b.quadraticCurveTo(0.14, -0.24, 0.1, -0.02);
      b.quadraticCurveTo(0.06, 0.14, -0.1, 0.14);
      b.quadraticCurveTo(-0.2, 0.0, -0.14, -0.24);
      b.closePath();
      s.fills.push(b);
      oval(s, 0.06, -0.36, 0.09, 0.07, -0.35);
      poly(s, [0.05, -0.43, 0.09, -0.54, 0.13, -0.41]);
      poly(s, [-0.16, 0.1, 0.16, 0.16, 0.2, 0.3, -0.16, 0.28]);
      const tail = new Path2D();
      tail.moveTo(-0.12, 0.06);
      tail.quadraticCurveTo(-0.4, 0.14, -0.46, 0.32);
      tail.lineTo(-0.38, 0.34);
      tail.quadraticCurveTo(-0.3, 0.2, -0.09, 0.18);
      tail.closePath();
      s.fills.push(tail);
      line(s, 0.0, -0.16, 0.16, -0.06, 0.04);
      break;
    }
    case 'panda':
      beast(s, { len: 0.25, thick: 0.14, y: 0.0, leg: 0.12, legW: 0.07, hump: 0.04, humpX: 0.05, neck: 0.03, lean: 0.8, head: 0.13, tail: 0 });
      oval(s, 0.26, -0.24, 0.055, 0.055);
      oval(s, 0.44, -0.24, 0.05, 0.05);
      break;
    case 'llama':
      beast(s, { len: 0.21, thick: 0.09, y: 0.0, leg: 0.2, legW: 0.035, hump: 0.02, humpX: 0.0, neck: 0.26, lean: 0.22, head: 0.065, tail: 1 });
      poly(s, [0.22, -0.4, 0.24, -0.52, 0.28, -0.39]);
      poly(s, [0.3, -0.4, 0.34, -0.52, 0.35, -0.38]);
      break;
    case 'reindeer':
      beast(s, { len: 0.24, thick: 0.095, y: -0.02, leg: 0.19, legW: 0.038, hump: 0.05, humpX: 0.1, neck: 0.15, lean: 0.5, head: 0.075, tail: 1 });
      line(s, 0.34, -0.28, 0.3, -0.5, 0.026);
      line(s, 0.3, -0.44, 0.16, -0.5, 0.022);
      line(s, 0.32, -0.38, 0.2, -0.4, 0.02);
      line(s, 0.42, -0.28, 0.5, -0.48, 0.026);
      line(s, 0.48, -0.42, 0.6, -0.46, 0.022);
      break;
    case 'tiger':
      beast(s, { len: 0.3, thick: 0.095, y: 0.0, leg: 0.14, legW: 0.042, hump: 0.02, humpX: 0.05, neck: 0.05, lean: 1.2, head: 0.095, tail: 2 });
      break;
    case 'bison':
      beast(s, { len: 0.26, thick: 0.12, y: -0.02, leg: 0.14, legW: 0.055, hump: 0.14, humpX: 0.14, neck: 0.04, lean: 1.25, head: 0.115, tail: 1 });
      poly(s, [0.34, -0.22, 0.44, -0.32, 0.46, -0.22]);
      break;
  }
  return s;
}

/* ── the atlas ──────────────────────────────────────────────────────────────────────────── */

/**
 * Two coverage masks packed into one RGBA canvas: **R is the ink**, **G is the paper halo**
 * behind it. No colour is baked in, which is the point — `restyle` is two uniform writes, and
 * the atlas is built once for the life of the page however many globes or themes come and go.
 */
let atlasCanvas: HTMLCanvasElement | null = null;

function buildAtlas(): HTMLCanvasElement {
  if (atlasCanvas) return atlasCanvas;
  const w = ATLAS_COLS * CELL;
  const h = ATLAS_ROWS * CELL;
  const make = (): CanvasRenderingContext2D => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    return ctx;
  };
  const body = make();
  const halo = make();

  const u = CELL * CELL_INSET; // drawing unit: the sketch's [-0.5, 0.5] maps onto this
  const haloW = 0.075; // in sketch units, so it scales with the drawing

  for (let i = 0; i < KINDS.length; i++) {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    const cx = col * CELL + CELL / 2;
    const cy = row * CELL + CELL / 2;
    const s = drawKind(KINDS[i]);
    for (const ctx of [halo, body]) {
      const isHalo = ctx === halo;
      ctx.setTransform(u, 0, 0, u, cx, cy);
      for (const p of s.fills) {
        if (isHalo) {
          ctx.lineWidth = haloW;
          ctx.stroke(p);
        }
        ctx.fill(p);
      }
      for (const l of s.lines) {
        ctx.lineWidth = l.w + (isHalo ? haloW : 0);
        ctx.stroke(l.path);
      }
    }
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  if (!octx) throw new Error('2D canvas context unavailable');
  const bodyData = body.getImageData(0, 0, w, h).data;
  const haloData = halo.getImageData(0, 0, w, h).data;
  const img = octx.createImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    d[i] = bodyData[i + 3];
    d[i + 1] = haloData[i + 3];
    d[i + 2] = 0;
    d[i + 3] = 255; // masks, not coverage: the shader composes the alpha itself
  }
  octx.putImageData(img, 0, 0);
  body.canvas.width = halo.canvas.width = 1;
  atlasCanvas = out;
  return out;
}

/* ── material ───────────────────────────────────────────────────────────────────────────── */

const VERT = /* glsl */ `
attribute vec4 aCell;
attribute float aInk;
varying vec2 vUv;
varying float vInk;
void main() {
  // flipY is off on the atlas, so the cell's v runs top-down while the quad's uv runs bottom-up.
  vUv = vec2(aCell.x + uv.x * aCell.z, aCell.y + (1.0 - uv.y) * aCell.w);
  vInk = aInk;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uInk;
uniform vec3 uHalo;
uniform float uHaloAlpha;
uniform float uOpacity;
varying vec2 vUv;
varying float vInk;
void main() {
  vec2 m = texture2D(uAtlas, vUv).rg;
  float body = m.r;
  float halo = m.g * uHaloAlpha;
  float a = (body + (1.0 - body) * halo) * uOpacity * vInk;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uHalo, uInk, body), a);
  #include <colorspace_fragment>
}
`;

/** '#rrggbb', 'rgb(r,g,b)' and 'rgba(r,g,b,a)' — themes use all three for ink and halo. */
function parseInk(css: string, out: Color): number {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/i.exec(css);
  if (m) {
    out.setRGB(+m[1] / 255, +m[2] / 255, +m[3] / 255, SRGBColorSpace);
    return m[4] === undefined ? 1 : +m[4];
  }
  out.set(css);
  return 1;
}

/* ── simulation state ───────────────────────────────────────────────────────────────────── */

/** A ship's sailing directions, pre-resolved to unit vectors with each leg's arc length. */
interface Leg {
  a: Vector3;
  b: Vector3;
  /** Arc length, radians. */
  angle: number;
}

interface Creature {
  kind: Kind;
  lat: number;
  lng: number;
  /** Radians clockwise from north. */
  heading: number;
  speed: number;
  /** Ships only: which sailing directions, which leg, how far along it (radians). */
  legs: Leg[] | null;
  leg: number;
  along: number;
  /** Ships only: how far the helm is currently off the rhumb, radians, to clear a headland. */
  avoid: number;
  /** Wanderers only: where they belong and how far they may stray, degrees. */
  homeLat: number;
  homeLng: number;
  roam: number;
  /** Wanderers only: the ISO3 set this animal's ground must belong to, or null for open water. */
  iso: readonly string[] | null;
  /** Per-creature wander phase, so a shoal does not turn as one animal. */
  phase: number;
  /** Profile kinds only: +1 facing east, -1 facing west. Hysteretic, so it never chatters. */
  face: number;
}

/* ── construction ───────────────────────────────────────────────────────────────────────── */

export function createLife(idMap: IdMap, theme: GlobeTheme, opts: LifeOptions = {}): LifeHandle {
  const rnd = mulberry32((opts.seed ?? 0x5eed1235) >>> 0);
  // 440 spread over a sphere left most close-ups empty; the globe has to feel inhabited
  // at the moment someone leans in, not merely be inhabited on average.
  const target = Math.max(24, opts.count ?? 950);

  const reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * The longest step the simulation will take in one call, in seconds.
   *
   * This is not an arbitrary guard against a backgrounded tab. Every movement test in this file
   * checks where a step *lands*, never the path it took, and those are only the same question
   * while a step is shorter than one pixel of the index being asked. The fastest thing on the
   * globe is a steamer at the top of its speed range; holding it to four fifths of an index
   * pixel means no ship can be on one side of a coastline at one sample and the other side at
   * the next. At a 4096-column index that works out at 0.12 s, so a machine rendering slower
   * than about 8 fps runs the creatures in slow motion rather than letting them skip — which is
   * the right way round, since the alternative is a ship stepping clean over a headland.
   *
   * The host clamps its own dt below this already (globe/index.ts caps it at 0.1 s). Deriving it
   * here keeps the guarantee a property of this module rather than of whoever calls it.
   */
  const maxStep = ((360 / idMap.width) * 0.8) / (KIND_SPEED.steamer * 1.25);

  const water = (lat: number, lng: number): boolean => isoAt(idMap, lat, lng) === null;
  const land = (lat: number, lng: number, iso: readonly string[] | null): boolean => {
    const id = isoAt(idMap, lat, lng);
    return id !== null && (!iso || iso.includes(id));
  };

  const creatures: Creature[] = [];

  /* -- ships ------------------------------------------------------------------------------ */

  // Resolve each route to unit-vector legs once. Ports are given at their seaward approach, so
  // a leg is a short great circle between two points of open water; the helm below only has to
  // handle the headlands that a straight arc between them still clips.
  //
  // The voyage runs OUT along the sailing directions and BACK again. It used to close the loop
  // by joining the last port straight to the first, and that closing arc was the one leg nobody
  // designed: Mombasa to Lagos is a line across Africa, Alexandria to Gibraltar one across the
  // Maghreb. A ship on it found no water to port or starboard and did the only safe thing —
  // held station — so it sat still for the rest of the session. Out and back is what a liner
  // service actually does, and it means every leg is one that was drawn as a sea leg.
  const routeLegs: Leg[][] = [];
  for (const route of ROUTES) {
    const pts: [number, number][] = route.map((m) => (typeof m === 'string' ? PORTS[m] : m));
    const legs: Leg[] = [];
    const addLeg = (a: [number, number], b: [number, number]): void => {
      const av = latLngToVector3(a[0], a[1], 1);
      const bv = latLngToVector3(b[0], b[1], 1);
      const angle = av.angleTo(bv);
      if (angle > 1e-4) legs.push({ a: av, b: bv, angle });
    };
    for (let i = 0; i + 1 < pts.length; i++) addLeg(pts[i], pts[i + 1]);
    for (let i = pts.length - 1; i > 0; i--) addLeg(pts[i], pts[i - 1]);
    if (legs.length) routeLegs.push(legs);
  }

  const shipCount = Math.round(target * 0.34);
  const shipKinds: Kind[] = ['steamer', 'steamer', 'schooner'];
  const routeTotal = routeLegs.map((legs) => legs.reduce((a, l) => a + l.angle, 0));
  // How many ships each route carries, so each ship can be spaced along its own line.
  const routeShips = routeLegs.map(() => 0);
  for (let i = 0; i < shipCount; i++) routeShips[i % routeLegs.length]++;
  const routeSeen = routeLegs.map(() => 0);
  for (let i = 0; i < shipCount; i++) {
    const r = i % routeLegs.length;
    const legs = routeLegs[r];
    const kind = shipKinds[(rnd() * shipKinds.length) | 0];
    // Stratified along the OUTBOUND half rather than dropped on the whole line at random.
    //
    // Two things went wrong with the obvious version. Placed independently, a dozen ships
    // sharing a route put two of them on the same pixel surprisingly often, and two overlapping
    // hulls read as one smudge rather than as two ships. Spreading them evenly over the whole
    // out-and-back line then made it worse and systematically so: the point at arc s outbound
    // IS the point at 2L - s homeward, so ship k and ship m-1-k are exact geographic twins, and
    // half the fleet had a double. Spacing them along the outbound half only gives every ship
    // its own stretch of water; they spread into the return half by themselves as they turn,
    // and having drawn their speeds from a range they stay spread. Regular sailings are also
    // what a liner service looks like; the jitter keeps it from being a metronome.
    let along = ((routeSeen[r]++ + 0.2 + 0.6 * rnd()) / routeShips[r]) * routeTotal[r] * 0.5;
    let leg = 0;
    while (leg < legs.length - 1 && along >= legs[leg].angle) {
      along -= legs[leg].angle;
      leg++;
    }
    creatures.push({
      kind,
      lat: 0,
      lng: 0,
      heading: 0,
      speed: KIND_SPEED[kind] * (0.75 + rnd() * 0.5) * DEG,
      legs,
      leg,
      along,
      avoid: 0,
      homeLat: 0,
      homeLng: 0,
      roam: 0,
      iso: null,
      phase: rnd() * Math.PI * 2,
      face: rnd() < 0.5 ? 1 : -1,
    });
  }

  /* -- open water ------------------------------------------------------------------------- */

  /**
   * Area-correct scatter over the whole sphere, rejected until the index says ocean. Sampling
   * `sin(lat)` rather than `lat` is what keeps the Arctic from being as crowded as the equator.
   */
  const seaCount = Math.round(target * 0.33);
  for (let i = 0; i < seaCount; i++) {
    let lat = 0;
    let lng = 0;
    let ok = false;
    for (let t = 0; t < 200 && !ok; t++) {
      lat = Math.asin(rnd() * 2 - 1) / DEG;
      lng = rnd() * 360 - 180;
      ok = water(lat, lng);
    }
    if (!ok) continue;
    // Who lives here. Whales run to the poles, turtles do not; fishing boats stay in soundings.
    const a = Math.abs(lat);
    const coastal = water(lat, lng) && !!nearLand(idMap, lat, lng);
    let kind: Kind;
    if (coastal && rnd() < 0.3) kind = 'fishing';
    else if (a > 52) kind = rnd() < 0.62 ? 'whale' : 'seabirds';
    else if (a > 34) kind = rnd() < 0.4 ? 'whale' : rnd() < 0.5 ? 'dolphins' : 'seabirds';
    else kind = rnd() < 0.3 ? 'turtle' : rnd() < 0.45 ? 'dolphins' : rnd() < 0.6 ? 'whale' : 'seabirds';
    creatures.push({
      kind,
      lat,
      lng,
      heading: rnd() * Math.PI * 2,
      speed: KIND_SPEED[kind] * (0.6 + rnd() * 0.8) * DEG,
      legs: null,
      leg: 0,
      along: 0,
      avoid: 0,
      homeLat: lat,
      homeLng: lng,
      roam: kind === 'fishing' ? 2.5 : 6,
      iso: null,
      phase: rnd() * Math.PI * 2,
      face: rnd() < 0.5 ? 1 : -1,
    });
  }

  /* -- ashore ----------------------------------------------------------------------------- */

  const landCount = target - creatures.length;
  const weightSum = REGIONS.reduce((a, r) => a + r.weight, 0);
  for (const region of REGIONS) {
    const n = Math.max(1, Math.round((landCount * region.weight) / weightSum));
    const [latMin, latMax, lngMin, lngMax] = region.box;
    /**
     * Elbow room, in degrees: a candidate closer than this to an animal already placed in the
     * same region is rejected. Sichuan and the altiplano are small enough that at a high
     * population plain rejection sampling will stack two pandas on the same pixel, and two
     * silhouettes on one spot read as a smudge rather than as two animals. Expressed in
     * silhouette widths so it scales with the drawing, not with the globe.
     */
    const spacing = (BASE_SCALE * KIND_SCALE[region.kind] * 1.8) / DEG;
    const placed: { lat: number; lng: number }[] = [];
    for (let i = 0; i < n; i++) {
      let lat = 0;
      let lng = 0;
      let ok = false;
      // Rejection sampling against the index itself. A region is a *search* box, never a claim:
      // nothing is placed until the oracle has confirmed the exact point is the right ground.
      for (let t = 0; t < 400 && !ok; t++) {
        lat = latMin + rnd() * (latMax - latMin);
        lng = lngMin + rnd() * (lngMax - lngMin);
        if (!land(lat, lng, region.iso)) continue;
        // Spacing is a preference, not a requirement: the last quarter of the attempts drops it
        // so that a region too small to hold its share still fills rather than coming up short.
        if (t < 300) {
          let crowded = false;
          for (const q of placed) {
            if (arcDeg(lat, lng, q.lat, q.lng) < spacing) { crowded = true; break; }
          }
          if (crowded) continue;
        }
        ok = true;
      }
      if (!ok) continue;
      placed.push({ lat, lng });
      creatures.push({
        kind: region.kind,
        lat,
        lng,
        heading: rnd() * Math.PI * 2,
        speed: KIND_SPEED[region.kind] * (0.6 + rnd() * 0.8) * DEG,
        legs: null,
        leg: 0,
        along: 0,
        avoid: 0,
        homeLat: lat,
        homeLng: lng,
        roam: region.roam,
        iso: region.iso,
        phase: rnd() * Math.PI * 2,
        face: rnd() < 0.5 ? 1 : -1,
      });
    }
  }

  /* -- mesh ------------------------------------------------------------------------------- */

  const n = creatures.length;
  const geometry = new PlaneGeometry(1, 1);
  const texture = new CanvasTexture(buildAtlas());
  texture.flipY = false;
  texture.colorSpace = NoColorSpace; // two coverage masks, not a picture: no decode wanted
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;

  const inkColor = new Color();
  const haloColor = new Color();
  parseInk(theme.labelInk, inkColor);
  let haloAlpha = parseInk(theme.labelHalo, haloColor);

  const material = new ShaderMaterial({
    uniforms: {
      uAtlas: { value: texture },
      uInk: { value: inkColor },
      uHalo: { value: haloColor },
      uHaloAlpha: { value: haloAlpha * 0.55 },
      uOpacity: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    // The sphere is opaque and drawn first, so depth testing alone hides everything on the far
    // side of the planet — no per-instance facing test, no horizon fade, nothing to get wrong.
    depthTest: true,
    depthWrite: false,
    // Mirrored profile instances have a left-handed basis, so back-face culling would drop
    // every creature facing west. Nothing here is lit, so two-sided costs nothing.
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, n);
  mesh.frustumCulled = false; // one draw call whose instances cover the whole sphere
  mesh.renderOrder = 8; // under the labels, over the map

  const cells = new Float32Array(n * 4);
  const inks = new Float32Array(n);
  const du = 1 / ATLAS_COLS;
  const dv = 1 / ATLAS_ROWS;
  // Pull the sampled rectangle a hair inside the cell so linear filtering never reaches a
  // neighbour, and give every creature its own ink density, the way printed ink actually lands.
  const bleed = 0.5 / (ATLAS_COLS * CELL);
  for (let i = 0; i < n; i++) {
    const k = KINDS.indexOf(creatures[i].kind);
    const col = k % ATLAS_COLS;
    const row = (k / ATLAS_COLS) | 0;
    cells[i * 4] = col * du + bleed;
    cells[i * 4 + 1] = row * dv + bleed;
    cells[i * 4 + 2] = du - 2 * bleed;
    cells[i * 4 + 3] = dv - 2 * bleed;
    inks[i] = 0.78 + rnd() * 0.22;
  }
  geometry.setAttribute('aCell', new InstancedBufferAttribute(cells, 4));
  geometry.setAttribute('aInk', new InstancedBufferAttribute(inks, 1));

  const group = new Group();
  group.name = 'life';
  group.add(mesh);

  /* -- placement → matrices --------------------------------------------------------------- */

  const mat = new Matrix4();
  const pos = new Vector3();
  const east = new Vector3();
  const north = new Vector3();
  const xAxis = new Vector3();
  const yAxis = new Vector3();
  const zAxis = new Vector3();

  function writeMatrix(i: number, c: Creature): void {
    latLngToVector3(c.lat, c.lng, LIFE_RADIUS, pos);
    zAxis.copy(pos).normalize();
    eastAt(c.lat, c.lng, east);
    northAt(c.lat, c.lng, north);
    if (isPlanView(c.kind)) {
      // Seen from above: the quad's +x simply is the course.
      xAxis.copy(north).multiplyScalar(Math.cos(c.heading)).addScaledVector(east, Math.sin(c.heading));
      xAxis.normalize();
      yAxis.crossVectors(zAxis, xAxis);
    } else {
      // Seen from the side: north stays up, the drawing is mirrored to face its course, and it
      // leans by the northerly component so a column of animals is not a rubber stamp. The
      // mirror makes the basis left-handed, which is why the material is DoubleSide.
      const sn = Math.sin(c.heading);
      if (sn > 0.22) c.face = 1;
      else if (sn < -0.22) c.face = -1;
      const tilt = Math.cos(c.heading) * 0.26 * c.face;
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      xAxis.copy(east).multiplyScalar(c.face * ct).addScaledVector(north, st);
      yAxis.copy(north).multiplyScalar(ct).addScaledVector(east, -c.face * st);
      xAxis.normalize();
      yAxis.normalize();
    }
    const s = BASE_SCALE * KIND_SCALE[c.kind];
    mat.makeBasis(xAxis.multiplyScalar(s), yAxis.multiplyScalar(s), zAxis);
    mat.setPosition(pos);
    mesh.setMatrixAt(i, mat);
  }

  /* -- ships: follow the sailing directions ------------------------------------------------ */

  const sv = new Vector3();
  const tangent = new Vector3();
  const perp = new Vector3();
  const probe = new Vector3();
  const here = { lat: 0, lng: 0 };

  /** Point and course at the ship's current position along its leg, before any avoidance. */
  function onLeg(c: Creature): void {
    const leg = c.legs![c.leg];
    const t = leg.angle > 0 ? c.along / leg.angle : 0;
    // Slerp by hand: `Vector3.lerp().normalize()` bunches up near the ends of a long leg.
    const s = Math.sin(leg.angle);
    const w0 = Math.sin((1 - t) * leg.angle) / s;
    const w1 = Math.sin(t * leg.angle) / s;
    sv.copy(leg.a).multiplyScalar(w0).addScaledVector(leg.b, w1).normalize();
    // Course: the component of b perpendicular to here, i.e. the great circle's tangent.
    tangent.copy(leg.b).addScaledVector(sv, -leg.b.dot(sv)).normalize();
    perp.crossVectors(sv, tangent); // in the tangent plane, to port
  }

  /** Apply `c.avoid` and write the result into the creature. Returns false if that is land. */
  function tryAvoid(c: Creature, offset: number): boolean {
    probe.copy(sv).multiplyScalar(Math.cos(offset)).addScaledVector(perp, Math.sin(offset)).normalize();
    toLatLng(probe, here);
    if (!water(here.lat, here.lng)) return false;
    c.lat = here.lat;
    c.lng = here.lng;
    return true;
  }

  /**
   * Steer round whatever the arc clips. The routes are chains of short ocean legs, so this is a
   * safety net rather than a pathfinder: it walks the helm out to port and to starboard in half-
   * degree steps until the index says water, keeps that offset, and eases it back to the rhumb
   * once the coast is clear. A ship that can find no water at all simply holds station — which
   * is the one behaviour that can never put it ashore.
   */
  const AVOID_STEP = 0.5 * DEG;
  const AVOID_MAX = 16;

  /**
   * Returns whether the helm found water. `tryAvoid` never moves a ship it cannot place, so a
   * false here means the ship is holding station exactly where it was — the one outcome that
   * can never put it ashore — and the caller can tell that apart from a normal step.
   */
  function steer(c: Creature): boolean {
    onLeg(c);
    let placed = false;
    // Try the helm where it already is, then straighten toward the rhumb, then search outward.
    if (tryAvoid(c, c.avoid)) {
      placed = true;
      const eased = c.avoid * 0.94;
      if (Math.abs(eased) < AVOID_STEP * 0.5) c.avoid = 0;
      else if (tryAvoid(c, eased)) c.avoid = eased;
    } else {
      for (let k = 1; k <= AVOID_MAX && !placed; k++) {
        for (const sign of [1, -1]) {
          const off = c.avoid + sign * k * AVOID_STEP;
          if (tryAvoid(c, off)) {
            c.avoid = off;
            placed = true;
            break;
          }
        }
      }
    }
    // Course made good, which for a small offset is the great circle's own tangent.
    eastAt(c.lat, c.lng, east);
    northAt(c.lat, c.lng, north);
    c.heading = Math.atan2(tangent.dot(east), tangent.dot(north));
    return placed;
  }

  /**
   * A ship has to be on water before the first frame, not merely after its first successful
   * step. Because `tryAvoid` declines to move a ship it cannot place, one whose spawn point was
   * blocked kept the (0, 0) it was constructed with and lay in the Gulf of Guinea for the whole
   * session. Walk it along its own sailing directions until the helm finds water.
   */
  function placeShip(c: Creature): void {
    const legs = c.legs!;
    for (let tries = 0; tries < legs.length * 4; tries++) {
      if (steer(c)) return;
      c.along += legs[c.leg].angle * 0.25;
      while (c.along >= legs[c.leg].angle) {
        c.along -= legs[c.leg].angle;
        c.leg = (c.leg + 1) % legs.length;
      }
    }
    // No water anywhere on the route: impossible for a designed route, but never leave a ship
    // sitting on the construction sentinel.
    toLatLng(legs[0].a, here);
    c.lat = here.lat;
    c.lng = here.lng;
  }

  function stepShip(c: Creature, dt: number): void {
    const legs = c.legs!;
    c.along += c.speed * dt;
    let guard = 0;
    while (c.along >= legs[c.leg].angle && guard++ < legs.length) {
      c.along -= legs[c.leg].angle;
      c.leg = (c.leg + 1) % legs.length;
    }
    steer(c);
  }

  /* -- wanderers: bounded random walk ------------------------------------------------------ */

  const wv = new Vector3();
  const dir = new Vector3();
  const next = new Vector3();

  /** Is (lat, lng) somewhere this creature is allowed to be? The oracle decides, every step. */
  function allowed(c: Creature, lat: number, lng: number): boolean {
    return c.iso ? land(lat, lng, c.iso) : water(lat, lng);
  }

  /**
   * One step of a bounded random walk. The heading wanders; once the creature is further than
   * `roam` from home the wander is biased back toward it; and the step itself is only taken if
   * the index agrees it is legal, otherwise the creature turns and tries another way. Six tries
   * covers every coastline shape; the seventh outcome is to stand still, which is always safe.
   */
  function stepWanderer(c: Creature, dt: number): void {
    c.phase += dt * (0.6 + c.speed * 40);
    c.heading += Math.sin(c.phase * 1.7) * 0.9 * dt + Math.sin(c.phase * 0.37 + 1.3) * 0.5 * dt;

    const away = arcDeg(c.lat, c.lng, c.homeLat, c.homeLng);
    if (away > c.roam) {
      const home = bearingTo(c.lat, c.lng, c.homeLat, c.homeLng);
      // Turn toward home by the shortest way, harder the further out they are.
      const d = ((home - c.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const pull = Math.min(1, (away - c.roam) / Math.max(0.5, c.roam * 0.5));
      c.heading += d * Math.min(1, 2.2 * pull * dt);
    }

    const delta = c.speed * dt;
    latLngToVector3(c.lat, c.lng, 1, wv);
    for (let k = 0; k < 7; k++) {
      const h = c.heading + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.9);
      eastAt(c.lat, c.lng, east);
      northAt(c.lat, c.lng, north);
      dir.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h)).normalize();
      next.copy(wv).multiplyScalar(Math.cos(delta)).addScaledVector(dir, Math.sin(delta)).normalize();
      toLatLng(next, here);
      if (allowed(c, here.lat, here.lng)) {
        c.lat = here.lat;
        c.lng = here.lng;
        c.heading = h;
        return;
      }
    }
    // Boxed in: turn about and wait. Never move to a place the oracle rejected.
    c.heading += Math.PI * (0.7 + 0.6 * ((c.phase * 0.31) % 1));
  }

  // Everyone is on station before the first frame: ships snapped onto their leg, every matrix
  // written once. Nothing here depends on `update` ever being called.
  for (let i = 0; i < n; i++) {
    const c = creatures[i];
    if (c.legs) placeShip(c);
    writeMatrix(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;

  /* -- driving ---------------------------------------------------------------------------- */

  let enabled = true;
  let opacity = 0;
  let disposed = false;

  function update(dt: number, cameraDistance: number): boolean {
    if (disposed || !enabled) return false;

    const want = 1 - smoothstep(FADE_NEAR, FADE_FAR, cameraDistance);
    let changed = false;
    if (want !== opacity) {
      opacity = want;
      material.uniforms.uOpacity.value = want;
      changed = true;
    }
    const visible = want > ALPHA_EPSILON;
    if (mesh.visible !== visible) {
      mesh.visible = visible;
      changed = true;
    }
    // Out of range: nothing is on screen, so nothing moves and the host can go back to sleep.
    if (!visible) return changed;
    // Reduced motion: everyone is present, nobody moves. Only the fade can still change.
    if (reducedMotion) return changed;

    const step = dt > maxStep ? maxStep : dt;
    if (step <= 0) return changed;
    for (let i = 0; i < n; i++) {
      const c = creatures[i];
      if (c.legs) stepShip(c, step);
      else stepWanderer(c, step);
      writeMatrix(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  return {
    group,
    update,
    restyle(next) {
      parseInk(next.labelInk, inkColor);
      haloAlpha = parseInk(next.labelHalo, haloColor);
      material.uniforms.uHaloAlpha.value = haloAlpha * 0.55;
      material.uniformsNeedUpdate = true;
    },
    setEnabled(on) {
      enabled = on;
      group.visible = on;
    },
    dispose() {
      disposed = true;
      geometry.dispose();
      material.dispose();
      texture.dispose(); // the atlas *canvas* is module-cached; this GPU copy is ours alone
      mesh.dispose();
      group.clear();
    },
  };
}

/**
 * Is there land within about a degree and a half? Used only to decide which stretches of water
 * are "in soundings" and get fishing boats rather than whales — eight probes, once, at build.
 */
function nearLand(idMap: IdMap, lat: number, lng: number): boolean {
  const r = 1.5;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dLat = Math.sin(a) * r;
    const dLng = (Math.cos(a) * r) / Math.max(0.2, Math.cos(lat * DEG));
    if (isoAt(idMap, lat + dLat, lng + dLng) !== null) return true;
  }
  return false;
}
