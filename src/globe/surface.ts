/**
 * The physical character of the printed surface — everything that separates a paper
 * globe someone actually made from a clean vector drawing.
 *
 * Two rules govern this file:
 *
 *  1. **Determinism.** Nothing here calls `Math.random`. Every "random" value comes from
 *     a `mulberry32` seeded off a fixed constant or a stable string hash, so rasterising
 *     the same theme twice produces byte-identical output and a theme switch never shimmers.
 *
 *  2. **Build once.** Every noise / fibre / halftone tile is a module-level cache. A theme
 *     switch composites cached tiles as `createPattern` fills; it never runs a per-pixel JS
 *     loop over the 33 M pixels of an 8k raster.
 *
 * The eight `SurfaceTheme` knobs in `core/themes.ts` are the only dials. This file owns how
 * they are realised; it must never invent a colour, which is `GlobeTheme`'s job.
 */
import { CanvasTexture, LinearFilter, RepeatWrapping, type MeshPhysicalMaterial } from 'three';
import type { GlobeTheme, SurfaceTheme } from '../core/themes';

/* -- deterministic randomness ---------------------------------------------------------------- */

/** mulberry32: small, fast, and identical on every machine and every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a. Turns a stable string (an ISO3 code) into a stable seed. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Roughly gaussian in -1.5..1.5: three uniforms beat one for natural-looking scatter. */
function bell(rnd: () => number): number {
  return rnd() + rnd() + rnd() - 1.5;
}

/* -- noise fields ---------------------------------------------------------------------------- */

function makeTile(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [c, ctx];
}

function whiteNoise(size: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const a = new Float32Array(size * size);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

/**
 * Separable box blur with wrap-around addressing, so a blurred tile still tiles
 * seamlessly. Unequal radii are what make the result read as *fibre* rather than fog.
 */
function blurWrap(src: Float32Array, size: number, rx: number, ry: number): Float32Array {
  const wrap = (i: number): number => ((i % size) + size) % size;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);

  const wx = 2 * rx + 1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -rx; k <= rx; k++) sum += src[row + wrap(k)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum / wx;
      sum -= src[row + wrap(x - rx)];
      sum += src[row + wrap(x + rx + 1)];
    }
  }

  const wy = 2 * ry + 1;
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -ry; k <= ry; k++) sum += tmp[wrap(k) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum / wy;
      sum -= tmp[wrap(y - ry) * size + x];
      sum += tmp[wrap(y + ry + 1) * size + x];
    }
  }
  return out;
}

/** Push a 0..1 field away from its mean, clipping the tails. An fbm sum is bell-shaped, so
 * without this its standard deviation is only ~0.13 and the layer reads as flat. */
function contrast(a: Float32Array, k: number): Float32Array {
  // Pivot on the field's OWN mean, not on 0.5. An fbm's mean is not exactly 0.5, and pivoting
  // on the wrong point tints the whole tile, which shows up as every theme quietly darkening.
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  const mid = sum / a.length;
  for (let i = 0; i < a.length; i++) {
    const v = mid + (a[i] - mid) * k;
    a[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return a;
}

/** Rescale a field to exactly 0..1 so downstream amplitudes mean the same thing every time. */
function normalise(a: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < lo) lo = a[i];
    if (a[i] > hi) hi = a[i];
  }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

/**
 * Felted paper fibre: a long "machine direction" layer, a shorter cross layer from an
 * independent field, and a little of the raw tooth. Directional, but not stripes.
 */
function fibreField(size: number, seed: number): Float32Array {
  const warpSrc = whiteNoise(size, seed);
  const weftSrc = whiteNoise(size, seed ^ 0x5bf03635);
  const warp = blurWrap(warpSrc, size, Math.max(1, size >> 7), 1);
  const weft = blurWrap(weftSrc, size, 1, Math.max(1, size >> 8));
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = 0.52 * warp[i] + 0.33 * weft[i] + 0.15 * warpSrc[i];
  return normalise(out);
}

/** Periodic value noise: a `grid`×`grid` lattice wrapped modulo `grid`, so it tiles. */
function valueNoise(size: number, grid: number, seed: number, out: Float32Array, gain: number): void {
  const lat = whiteNoise(grid, seed);
  const fade = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * grid;
    const y0 = Math.floor(fy);
    const sy = fade(fy - y0);
    const r0 = (((y0 % grid) + grid) % grid) * grid;
    const r1 = ((((y0 + 1) % grid) + grid) % grid) * grid;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * grid;
      const x0 = Math.floor(fx);
      const sx = fade(fx - x0);
      const c0 = ((x0 % grid) + grid) % grid;
      const c1 = (((x0 + 1) % grid) + grid) % grid;
      const top = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
      const bot = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
      out[y * size + x] += (top + (bot - top) * sy) * gain;
    }
  }
}

/** Fractal sum of periodic value noise. Tiles seamlessly for any integer grid. */
function fbm(size: number, grids: number[], seed: number, falloff = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  let gain = 1;
  for (let i = 0; i < grids.length; i++) {
    valueNoise(size, grids[i], seed + i * 0x9e3779b9, out, gain);
    gain *= falloff;
  }
  return normalise(out);
}

function writeGrey(ctx: CanvasRenderingContext2D, size: number, value: (i: number) => number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const v = value(i);
    const g = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    d[p] = d[p + 1] = d[p + 2] = g;
    d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* -- the halftone rosette -------------------------------------------------------------------- */

/**
 * A dot screen at an arbitrary angle does not tile, which is why naive halftones show a
 * repeat. These lattices are chosen so they do: for basis `(2,1)p` and `(-1,2)p`, the integer
 * combination `2·b1 + 1·b2` is `(5p, 0)` and `1·b1 + 2·b2` is `(0, 5p)`, so the lattice is
 * exactly periodic over `5p` on both axes. Two mirrored screens (≈ ±26.57°) plus a fine
 * square screen share one period and read as a real offset rosette.
 */

/** The distinct lattice residues inside one period — generated once, then tiled by translation. */
function latticeResidues(b1: [number, number], b2: [number, number], period: number): [number, number][] {
  const seen = new Set<string>();
  const pts: [number, number][] = [];
  for (let m = -6; m <= 6; m++) {
    for (let n = -6; n <= 6; n++) {
      const x = ((((m * b1[0] + n * b2[0]) % period) + period) % period);
      const y = ((((m * b1[1] + n * b2[1]) % period) + period) % period);
      const key = `${x.toFixed(3)},${y.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push([x, y]);
    }
  }
  return pts;
}

/**
 * Two screens at ≈ ±26.57° and DIFFERENT rulings. Same-pitch mirrored screens interfere on a
 * regular beat and read as polka dots rather than print; different rulings give the irregular
 * rosette real four-colour work has.
 *
 * The whole rosette is drawn ONCE into a 64² tile and then tiled. Both rulings are powers of
 * two, so 64 px is exactly one period of the coarse screen and two of the fine one — the tile
 * is seamless, and 64 divides 2048. Drawing the dots directly into the 2048² surface tile
 * instead meant ~51 000 individual arcs and measured **7.8 seconds per theme**, which stalled
 * startup and would have stalled every first theme switch.
 */
const ROSETTE_TILE = 64;
let rosetteTile: HTMLCanvasElement | null = null;

function getRosetteTile(): HTMLCanvasElement {
  if (rosetteTile) return rosetteTile;
  const [canvas, ctx] = makeTile(ROSETTE_TILE); // starts transparent; the dots are the content
  const screens = [
    { period: 64, r: 1.9, a: 0.42 },
    { period: 32, r: 1.15, a: 0.3 },
  ];
  ctx.fillStyle = '#000';
  for (const sc of screens) {
    const p = sc.period / 5;
    for (const [b1, b2] of [
      [[2 * p, p], [-p, 2 * p]],
      [[2 * p, -p], [p, 2 * p]],
    ] as [[number, number], [number, number]][]) {
      ctx.globalAlpha = sc.a;
      const pts = latticeResidues(b1, b2, sc.period);
      const cells = ROSETTE_TILE / sc.period;
      ctx.beginPath();
      for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
          for (const [px, py] of pts) {
            const x = cx * sc.period + px;
            const y = cy * sc.period + py;
            ctx.moveTo(x + sc.r, y);
            ctx.arc(x, y, sc.r, 0, Math.PI * 2);
          }
        }
      }
      ctx.fill();
    }
  }
  rosetteTile = canvas;
  return canvas;
}

/** Lay the cached rosette over the surface tile. Per-theme strength is the composite alpha. */
function drawRosette(ctx: CanvasRenderingContext2D, size: number, strength: number): void {
  const pattern = ctx.createPattern(getRosetteTile(), 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = Math.min(1, strength);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
}

/* -- the surface tile: fibre + tooth + halftone + ink mottle, in ONE composite ---------------- */

/**
 * Measured on an 8192×4096 raster under software rasterisation:
 *
 *   plain fillRect ................................  14 ms
 *   pattern fill at 1:1 (overlay) .................. 185 ms
 *   pattern fill with ANY setTransform scale ....... 415-464 ms
 *
 * Scaling a pattern costs ~2.4× a 1:1 fill regardless of the scale factor or the blend mode,
 * so the low-frequency ink mottle cannot be a scaled 256² tile — and it cannot be its own pass
 * either, because a second 1:1 fill is another 185 ms.
 *
 * Both layers therefore live in ONE 2048² tile applied at 1:1. 2048 divides both raster widths
 * exactly (4 repeats at 8k, 2 at 4k) so the antimeridian has no seam, and 2048 px of longitude
 * is a long enough period that the mottle still reads as low-frequency.
 */
const SURFACE_TILE = 2048;
const FIBRE_SIZE = 512;
const MOTTLE_SIZE = 1024;

/** Theme-independent, built once ever: per-theme strength is applied as composite alpha. */
let fibreTile: HTMLCanvasElement | null = null;
let mottleTile: HTMLCanvasElement | null = null;

function getFibreTile(): HTMLCanvasElement {
  if (fibreTile) return fibreTile;
  const [canvas, ctx] = makeTile(FIBRE_SIZE);
  const fibre = fibreField(FIBRE_SIZE, 0x1b873593);
  const tooth = whiteNoise(FIBRE_SIZE, 0x85ebca6b);
  // 'overlay' pivots on mid grey: below 128 darkens, above lightens.
  writeGrey(ctx, FIBRE_SIZE, (i) => 128 + (fibre[i] - 0.5) * 165 + (tooth[i] - 0.5) * 100);
  fibreTile = canvas;
  return canvas;
}

/**
 * The octaves deliberately START at grid 8, not 2. Including the lowest octaves put ~1000-px
 * features in the tile, which at globe scale read as weather over the oceans rather than as
 * ink: whole continents drifted lighter and darker. Beginning at 8 caps the largest structure
 * at ~256 raster px — about 11° of longitude — which is print texture, not climate.
 */
function getMottleTile(): HTMLCanvasElement {
  if (mottleTile) return mottleTile;
  const [canvas, ctx] = makeTile(MOTTLE_SIZE);
  const f = contrast(fbm(MOTTLE_SIZE, [8, 16, 32, 64], 0xc2b2ae35, 0.6), 1.25);
  writeGrey(ctx, MOTTLE_SIZE, (i) => 128 + (f[i] - 0.5) * 250);
  mottleTile = canvas;
  return canvas;
}

/**
 * One tile per theme, memoised for the life of the module — at most six ever exist, each built
 * once, and a theme switch only looks one up. It is assembled entirely out of canvas ops over
 * cached sources (no per-pixel JS at 2048²); the amplitude of each layer is expressed as the
 * alpha it is drawn at, which is what keeps the knobs independent of one another.
 */
const surfaceTiles = new Map<string, HTMLCanvasElement>();

function surfaceTile(surface: SurfaceTheme, grain: number): HTMLCanvasElement {
  const key = `${surface.paperFiber}|${surface.halftone}|${surface.inkMottle}|${grain}`;
  const hit = surfaceTiles.get(key);
  if (hit) return hit;

  const [canvas, ctx] = makeTile(SURFACE_TILE);

  // 1. Ink density. Generated small and smoothly upscaled: this layer has no fine detail by
  //    definition, so resampling costs it nothing in character. Blending toward the mid grey
  //    underneath is what scales its amplitude.
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, SURFACE_TILE, SURFACE_TILE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const mottleAlpha = Math.min(1, 0.25 + 0.35 * surface.inkMottle);
  ctx.globalAlpha = mottleAlpha;
  ctx.drawImage(getMottleTile(), 0, 0, SURFACE_TILE, SURFACE_TILE);

  // 2. Paper fibre and tooth, blended with plain 'source-over' rather than 'overlay'. Overlay
  //    here is a trap: the fibre covers the full range, so overlaying it at the alpha the fibre
  //    needs largely REPLACES the mottle underneath and the fills go flat again. At a LOW alpha
  //    it modulates instead, which keeps the tooth without flattening the density underneath —
  //    'source-over' here would trade one against the other.
  //    GlobeTheme.grainAlpha used to drive a separate neutral-speckle pass; it is folded in
  //    here instead, so it costs nothing extra.
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = Math.min(1, 0.12 + 0.34 * surface.paperFiber + 1.5 * grain);
  const fibrePattern = ctx.createPattern(getFibreTile(), 'repeat');
  if (fibrePattern) {
    ctx.fillStyle = fibrePattern;
    ctx.fillRect(0, 0, SURFACE_TILE, SURFACE_TILE);
  }

  // 3. The rosette, last, so the dots are ink sitting on the paper rather than under it.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (surface.halftone > 0) drawRosette(ctx, SURFACE_TILE, surface.halftone);

  surfaceTiles.set(key, canvas);
  return canvas;
}

/**
 * The whole printed surface in a single full-raster 'overlay' pass: ink density variation
 * across fills, ocean and line-work alike, the fibre of the paper, and the offset rosette.
 */
export function compositeSurface(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  surface: SurfaceTheme,
  grain: number,
): void {
  const pattern = ctx.createPattern(surfaceTile(surface, grain), 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 1;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/* -- age and wear ---------------------------------------------------------------------------- */

/** Relative luminance of a `#rrggbb` string, for deciding whether wear stains or rubs. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * Foxing, pole grubbiness and plate wear.
 *
 * Blobs are placed in a handful of irregular clusters rather than scattered uniformly:
 * evenly spread "randomness" is itself a tell that a computer made it. On dark paper the
 * wear lightens (a rub) instead of staining brown, so Chalkboard and Blueprint stay in
 * character rather than looking like someone spilled tea on a slate.
 */
export function drawAging(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number,
  theme: GlobeTheme,
): void {
  const aging = theme.surface.aging;
  if (aging <= 0) return;
  const dark = luminance(theme.ocean) < 0.42;
  const rnd = mulberry32(0x9e3779b9);

  ctx.save();

  // --- foxing: clustered spots, soft-edged, never a uniform sprinkle ---------------------------
  const clusterCount = 26;
  const clusters: [number, number][] = [];
  for (let i = 0; i < clusterCount; i++) clusters.push([rnd() * width, rnd() * height]);

  const blobs = Math.round(40 + 220 * aging);
  ctx.globalCompositeOperation = dark ? 'lighten' : 'multiply';
  for (let i = 0; i < blobs; i++) {
    const c = clusters[(rnd() * clusterCount) | 0];
    const spread = (120 + rnd() * 520) * s;
    const x = c[0] + bell(rnd) * spread;
    const y = Math.min(height, Math.max(0, c[1] + bell(rnd) * spread * 0.7));
    const r = (8 + rnd() * 54) * s * (0.6 + aging * 0.8);
    const a = (0.06 + rnd() * 0.17) * aging;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (dark) {
      g.addColorStop(0, `rgba(196, 186, 162, ${a * 0.8})`);
      g.addColorStop(0.55, `rgba(196, 186, 162, ${a * 0.34})`);
      g.addColorStop(1, 'rgba(196, 186, 162, 0)');
    } else {
      g.addColorStop(0, `rgba(124, 84, 38, ${a})`);
      g.addColorStop(0.55, `rgba(140, 104, 56, ${a * 0.42})`);
      g.addColorStop(1, 'rgba(150, 120, 70, 0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // --- grubbiness at the poles, where the gores bunch and hands grip ---------------------------
  const band = height * 0.16;
  ctx.globalCompositeOperation = dark ? 'lighten' : 'multiply';
  for (const top of [true, false]) {
    const g = ctx.createLinearGradient(0, top ? 0 : height, 0, top ? band : height - band);
    const a = 0.2 * aging;
    const col = dark ? '170, 164, 146' : '108, 88, 58';
    g.addColorStop(0, `rgba(${col}, ${a})`);
    g.addColorStop(1, `rgba(${col}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, top ? 0 : height - band, width, band);
  }

  // --- plate wear: sparse rubs where the ink thinned ------------------------------------------
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  const rubs = Math.round(8 + 34 * aging);
  for (let i = 0; i < rubs; i++) {
    const x = rnd() * width;
    const y = rnd() * height;
    const len = (200 + rnd() * 900) * s;
    const ang = (rnd() - 0.5) * 1.1;
    ctx.strokeStyle = dark ? `rgba(0, 0, 0, ${0.05 * aging})` : `rgba(255, 252, 244, ${0.09 * aging})`;
    ctx.lineWidth = (6 + rnd() * 26) * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len * 0.4);
    ctx.stroke();
  }

  ctx.restore();
}

/* -- gore seams ------------------------------------------------------------------------------ */

/**
 * A real globe is printed paper strips glued to a sphere. Every 30° there is a join: a hairline
 * of colour break, a soft band where the paper overlaps, and — the cue that sells it — the two
 * sides not quite lining up.
 *
 * The misalignment is real pixels, not a painted fake, but it must be bought carefully.
 * `drawImage` from a canvas onto itself snapshots the WHOLE surface, so copying twelve 3-px
 * strips one at a time costs twelve 134 MB snapshots — measured at 892 ms on an 8k raster.
 * Clipping to all twelve strips at once and shifting the entire canvas in a single call is the
 * same picture for one snapshot: ~104 ms.
 */
export function drawGoreSeams(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number,
  theme: GlobeTheme,
): void {
  const gores = theme.surface.gores;
  if (gores <= 0) return;
  const dark = luminance(theme.ocean) < 0.42;
  const rnd = mulberry32(0x27d4eb2f);
  const step = width / 12;
  const half = Math.max(1.5, 2 * s);

  ctx.save();

  // The slip itself. One clip covering all twelve strips and one shift of the whole canvas: a
  // single snapshot (~104 ms at 8k) instead of one per seam. Every seam therefore leans the
  // same way, which is what laying gores up one against the last does on a real globe anyway.
  // Below about an eighth of a pixel the slip is invisible, and the snapshot is not free, so a
  // theme that barely seams (Chalkboard, gores 0.1) pays nothing for it.
  const slip = 1.15 * gores;
  if (slip >= 0.12) {
    ctx.beginPath();
    for (let i = 0; i < 12; i++) ctx.rect(i * step - half, 0, half * 2, height);
    ctx.save();
    ctx.clip();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(ctx.canvas, slip, 0);
    ctx.restore();
  }

  // Every seam converges on the poles in an equirectangular raster, so twelve full-height bands
  // overlap there and burn a dark starburst into the cap. Real globes hide that convergence
  // under a polar calotte; tapering each seam out above ~75° does the same job. Slabs rather
  // than one fillRect because the band needs a horizontal gradient AND a vertical falloff.
  const SLABS = 10;
  const taper = (t: number): number => {
    const d = Math.min(t, 1 - t) / 0.14;
    return d >= 1 ? 1 : d <= 0 ? 0 : d * d * (3 - 2 * d);
  };

  for (let i = 0; i < 12; i++) {
    const x = i * step;
    const bw = 14 * s;
    const hairAlpha = (0.1 + 0.16 * rnd()) * gores;

    for (let k = 0; k < SLABS; k++) {
      const y0 = (k / SLABS) * height;
      const slabH = height / SLABS;
      const fade = taper((k + 0.5) / SLABS);
      if (fade <= 0.01) continue;

      // A soft band: two sheets of paper overlapping never lie perfectly flat.
      const g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
      const col = dark ? '235, 240, 236' : '86, 66, 40';
      g.addColorStop(0, `rgba(${col}, 0)`);
      g.addColorStop(0.5, `rgba(${col}, ${0.07 * gores * fade})`);
      g.addColorStop(1, `rgba(${col}, 0)`);
      ctx.globalCompositeOperation = dark ? 'lighten' : 'multiply';
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(x - bw, y0, bw * 2, slabH);

      // The hairline itself.
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = hairAlpha * fade;
      ctx.fillStyle = dark ? '#f2f6ee' : '#4a3a24';
      ctx.fillRect(x - 0.5 * s, y0, Math.max(1, s), slabH);
    }
  }
  ctx.restore();
}

/* -- material: varnish, fibre relief, patchy gloss -------------------------------------------- */

const BUMP_SIZE = 1024;
const ROUGH_SIZE = 512;

let bumpTexture: CanvasTexture | null = null;

/**
 * Paper fibre plus a gentle low-frequency "orange peel" from the varnish coat. Small
 * `bumpScale` is the whole point: we want light to catch on the surface, not a golf ball.
 */
function getBumpTexture(): CanvasTexture {
  if (bumpTexture) return bumpTexture;
  const [canvas, ctx] = makeTile(BUMP_SIZE);
  const fibre = fibreField(BUMP_SIZE, 0x7feb352d);
  const peel = fbm(BUMP_SIZE, [3, 6], 0x846ca68b);
  writeGrey(ctx, BUMP_SIZE, (i) => 128 + (fibre[i] - 0.5) * 110 + (peel[i] - 0.5) * 78);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  // 8 × 4 of a 1024 tile is 1:1 with the 8k map, so the relief matches the print's own scale.
  tex.repeat.set(8, 4);
  bumpTexture = tex;
  return tex;
}

/**
 * Gloss is patchy, never uniform. `roughnessMap` *multiplies* `material.roughness`, so to get
 * an honest ±amp around a theme's `varnishRoughness` the centre has to live in the map and the
 * material factor stays at 1. The tiles are tiny (512²) and cached by centre value, so the six
 * themes between them build at most a handful, once, and a switch only looks one up.
 */
const roughTextures = new Map<string, CanvasTexture>();

function getRoughTexture(centre: number, amp: number, repeatU: number, repeatV: number): CanvasTexture {
  const key = `${centre.toFixed(3)}|${amp.toFixed(3)}|${repeatU}`;
  const hit = roughTextures.get(key);
  if (hit) return hit;
  const [canvas, ctx] = makeTile(ROUGH_SIZE);
  const f = fbm(ROUGH_SIZE, [2, 4, 8], 0x165667b1);
  writeGrey(ctx, ROUGH_SIZE, (i) => 255 * (centre + (f[i] - 0.5) * 2 * amp));
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeatU, repeatV);
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  roughTextures.set(key, tex);
  return tex;
}

/**
 * Point the sphere's material at this theme's surface. Cheap enough to run in **phase 1** of a
 * theme switch, so the varnish changes the instant you click.
 *
 * `clearcoat` is never allowed to reach zero: three.js keys the `USE_CLEARCOAT` shader define
 * off `clearcoat > 0`, so crossing that boundary would recompile the program mid-switch and
 * hitch. Every theme's `varnish` is already ≥ 0.04; matte surfaces are expressed through
 * roughness instead, which costs nothing to change.
 */
export function applySurfaceMaterial(material: MeshPhysicalMaterial, theme: GlobeTheme): void {
  const s = theme.surface;

  material.bumpMap = getBumpTexture();
  material.bumpScale = 0.006 + 0.013 * s.paperFiber;

  // `varnishRoughness` is used as a RELATIVE dial mapped into 0.40-0.95, not as an absolute
  // roughness. Taken literally, Night Study's 0.30 under this scene's 2.3-intensity key light
  // produces a mirror-hard specular sun on the Atlantic; the mapping keeps every theme's
  // ordering while holding them all in satin-to-matte, where varnished paper actually lives.
  material.roughnessMap = getRoughTexture(0.4 + 0.55 * s.varnishRoughness, 0.18, 3, 1.5);
  material.roughness = 1;

  // A coat over the ink, not a glaze on a teapot. Clearcoat carries strong Fresnel, so even
  // modest values wash the limb out; a third of the knob is as far as this scene tolerates.
  // It is never allowed to reach zero: three.js keys the USE_CLEARCOAT shader define off
  // `clearcoat > 0`, so crossing that boundary would recompile the program mid-switch and
  // hitch. Chalkboard's matte comes from roughness instead, which costs nothing to change.
  material.clearcoat = Math.max(0.02, 0.3 * s.varnish);
  material.clearcoatRoughnessMap = getRoughTexture(
    Math.min(0.95, 0.38 + 0.45 * s.varnishRoughness),
    0.14,
    2,
    1,
  );
  material.clearcoatRoughness = 1;

  // Paper scatters; it does not glint. Damping the base layer's specular is what stops the
  // fibre relief from turning into sparkle under a bright key light.
  material.specularIntensity = 0.3 + 0.3 * s.varnish;

  material.metalness = 0;
  material.color.set(theme.sphereTint);
  material.needsUpdate = true;
}
