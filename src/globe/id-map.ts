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

/** What the reader is pointing at: printed ink wins, then the territory beneath it. */
export function lookupId(idMap: IdMap, u: number, v: number): string | null {
  const { width, height, iso3s, labelInk } = idMap;
  if (labelInk.length) {
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor((1 - v) * height)));
    const ink = labelInk[y * width + x];
    if (ink) return iso3s[ink - 1];
  }
  return lookupCountryId(idMap, u, v);
}
