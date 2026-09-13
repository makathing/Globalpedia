/**
 * The pick index and the two questions you can ask it.
 *
 * Kept apart from texture.ts deliberately: these are pure integer maths over typed
 * arrays, so they can be unit-tested without a canvas — and the invariant they encode
 * is load-bearing enough to deserve that. See tests/ts/lookup.cases.ts.
 */

export interface IdMap {
  width: number;
  height: number;
  index: Uint16Array;
  iso3s: string[];
  /**
   * Where the printed names' **ink** is, in the same encoding and the same raster as `index`.
   *
   * `index` carries a name's whole bounding box, and only where a pixel was still unassigned —
   * coarse on purpose, because a box that outranked polygons would let "Russia" swallow
   * Mongolia. But that coarseness meant clicking the middle of "Belgium", which overhangs
   * France, selected France: the letters are there, the box could not claim the pixel, so the
   * polygon under them won.
   *
   * This layer is the fine one. It holds the glyphs themselves, dilated to the halo's width —
   * i.e. exactly the footprint a viewer reads as "the name" — and `lookupId` consults it
   * first. Where there is ink the ink wins; one pixel outside it, nothing has changed.
   */
  labelInk: Uint16Array;
  /**
   * Where the printed names' **bounding boxes** are — a name's whole rectangle, claimed only
   * where no polygon already held the pixel.
   *
   * These used to be written straight into `index`, which quietly made `index` stop meaning
   * "land". A name set out over the sea, or one simply overhanging its coast, left its box on
   * open water, and 1.84% of the ocean answered "land" to anything that asked. Picking did not
   * care; the creatures did, and a polar bear ended up standing in Baffin Bay.
   *
   * So the boxes live here instead, and only `lookupId` consults them. `index` is polygons and
   * nothing else again.
   */
  labelBox: Uint16Array;
}

/**
 * Territory only: whose *land* is under this point, ignoring printed names.
 *
 * Use this for questions about geography rather than about what the reader is
 * pointing at. Names are set over open water — a displaced label and its leader,
 * or a long name overhanging its coast — so `lookupId` reports a country there,
 * which is right for a click and wrong for a ship.
 */
export function lookupCountryId(idMap: IdMap, u: number, v: number): string | null {
  return resolve(idMap, u, v, false);
}

/**
 * Scratch for the 3×3 vote: at most nine ids, reused on every call.
 *
 * This used to be a `Map` built per call, and the call it is built for is the one that
 * almost always happens. Every point over **water** has `index[p] === 0`, so it falls past
 * the direct hit and past the boxes and into the vote — and the life layer asks about water
 * constantly: `steer()` probes twice per ship and `stepWanderer` tries up to seven headings,
 * some 1,400 lookups a frame of which about 1,300 are at sea. That was ~78,000 short-lived
 * Maps a second straight into the nursery, on the phone this is all for, to answer "no" 1,300
 * times. Nine reads and a fixed tally allocate nothing at all, and the common case — nine
 * zeroes — now costs nine typed-array reads and an early return.
 *
 * Module-level and mutable is safe here: JS is single-threaded and `resolve` never re-enters.
 */
const voteIds = new Int32Array(9);

/**
 * The shared walk. A polygon wins outright; then, for the pointer only, a name's box may
 * claim a pixel no polygon held; otherwise a 3×3 vote recovers anti-aliased coastline.
 * Boxes are checked before the vote because that is where they used to sit, inside `index`.
 */
function resolve(idMap: IdMap, u: number, v: number, useBoxes: boolean): string | null {
  const { width, height, index, iso3s, labelBox } = idMap;
  const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
  const direct = index[y * width + x];
  if (direct) return iso3s[direct - 1];
  if (useBoxes && labelBox.length) {
    const box = labelBox[y * width + x];
    if (box) return iso3s[box - 1];
  }

  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    const row = yy * width;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = (x + dx + width) % width; // wrap across the antimeridian
      const id = index[row + xx];
      if (id) voteIds[n++] = id;
    }
  }
  if (n === 0) return null; // open water, which is most of the questions asked
  if (n === 1) return iso3s[voteIds[0] - 1];

  // Count each id at its *first* appearance and keep ties on `>`, which is exactly what the
  // Map version did: insertion order was scan order, and a later id never displaced an equal.
  let best = 0;
  let bestVotes = 0;
  for (let i = 0; i < n; i++) {
    const id = voteIds[i];
    let firstHere = true;
    for (let j = 0; j < i; j++) {
      if (voteIds[j] === id) {
        firstHere = false;
        break;
      }
    }
    if (!firstHere) continue;
    let count = 1;
    for (let j = i + 1; j < n; j++) if (voteIds[j] === id) count++;
    if (count > bestVotes) {
      best = id;
      bestVotes = count;
    }
  }
  return best ? iso3s[best - 1] : null;
}

/** What the reader is pointing at: printed ink, then land, then a name's box. */
export function lookupId(idMap: IdMap, u: number, v: number): string | null {
  const { width, height, iso3s, labelInk } = idMap;
  if (labelInk.length) {
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
    const ink = labelInk[y * width + x];
    if (ink) return iso3s[ink - 1];
  }
  return resolve(idMap, u, v, true);
}
