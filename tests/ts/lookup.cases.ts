/**
 * Guards on the two id-map lookups. Run via tests/lookup.test.mjs.
 * Named *.cases.ts so the default `node --test` glob does not pick it up twice.
 *
 * These exist because of a real bug. Printed country names are stamped into the pick
 * index so that clicking the letters of a name selects its country, and names that do
 * not fit are set out over open water. `lookupId` therefore reports a country for
 * ocean under lettering — correct for a click. The autonomous life layer used the same
 * call to decide land from sea, so a polar bear could be placed on open water beneath
 * the tail of "Greenland"; measured at about one build in thirty-three before the fix.
 *
 * The two questions are now separate functions, and the whole correctness of the life
 * layer rests on `lookupCountryId` staying territory-only. That is what these lock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupCountryId, lookupId, type IdMap } from '../../src/globe/id-map.ts';

const W = 8;
const H = 4;

/** A tiny world: one land pixel, and one ink pixel sitting over open water. */
function makeIdMap(): IdMap {
  const index = new Uint16Array(W * H);
  const labelInk = new Uint16Array(W * H);
  // iso3s is 1-based: id 1 => 'LND', id 2 => 'INK'.
  const iso3s = ['LND', 'INK'];
  const at = (x: number, y: number) => y * W + x;
  index[at(2, 2)] = 1; // the only land on the map
  labelInk[at(6, 1)] = 2; // a name printed out over the sea
  return { width: W, height: H, index, iso3s, labelInk };
}

/** Pixel centre -> the (u, v) the lookups expect. v is flipped, as the sphere wants. */
function uvOfPixel(x: number, y: number): [number, number] {
  return [(x + 0.5) / W, 1 - (y + 0.5) / H];
}

test('lookupCountryId reports land where there is land', () => {
  const m = makeIdMap();
  assert.equal(lookupCountryId(m, ...uvOfPixel(2, 2)), 'LND');
});

test('lookupCountryId ignores printed ink: a name over the sea is still sea', () => {
  // The invariant the life layer depends on. If this fails, creatures that ask
  // "is this land?" will read lettering as ground and animals will appear at sea.
  const m = makeIdMap();
  assert.equal(lookupCountryId(m, ...uvOfPixel(6, 1)), null);
});

test('lookupId prefers printed ink, so clicking a name selects its country', () => {
  // The complementary invariant: this is what makes clicking the letters of a country
  // whose name overhangs its neighbour select the right country.
  const m = makeIdMap();
  assert.equal(lookupId(m, ...uvOfPixel(6, 1)), 'INK');
});

test('the two lookups agree everywhere there is no ink', () => {
  const m = makeIdMap();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (m.labelInk[y * W + x]) continue;
      const uv = uvOfPixel(x, y);
      assert.equal(lookupId(m, ...uv), lookupCountryId(m, ...uv), `disagreement at ${x},${y}`);
    }
  }
});

test('an empty ink layer leaves lookupId identical to lookupCountryId', () => {
  // Life builds before any labels exist in some harnesses; the ink-free path must match.
  const m = makeIdMap();
  m.labelInk = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const uv = uvOfPixel(x, y);
      assert.equal(lookupId(m, ...uv), lookupCountryId(m, ...uv));
    }
  }
});

test('neither lookup reads outside the raster', () => {
  const m = makeIdMap();
  for (const [u, v] of [[-1, -1], [2, 2], [0, 1], [1, 0]] as [number, number][]) {
    assert.doesNotThrow(() => lookupCountryId(m, u, v));
    assert.doesNotThrow(() => lookupId(m, u, v));
  }
});
