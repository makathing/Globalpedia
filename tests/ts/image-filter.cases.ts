/**
 * Unit tests for src/data/image-filter.ts. Run via tests/image-filter.test.mjs
 * (which spawns `node --experimental-strip-types --test` on this file).
 * Named *.cases.ts so the default `node --test` glob does not pick it up twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectImages, filterImages, rankImages, toCountryImage, stripHtml, truncate, cleanFileTitle, mergeImages,
  type MwPage,
} from '../../src/data/image-filter.ts';

const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons';

function page(
  file: string,
  mime: string,
  width: number,
  height: number,
  meta: Record<string, string> = {},
  overrides: Partial<MwPage['imageinfo'] extends (infer T)[] | undefined ? T : never> = {},
): MwPage {
  const name = file.replace(/ /g, '_');
  const thumbwidth = Math.min(900, width);
  const thumbheight = Math.round((height * thumbwidth) / width);
  return {
    pageid: Math.floor(Math.random() * 1e6),
    ns: 6,
    title: `File:${file}`,
    imageinfo: [
      {
        url: `${COMMONS}/a/ab/${name}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
        thumburl: `${COMMONS}/thumb/a/ab/${name}/${thumbwidth}px-${name}`,
        thumbwidth,
        thumbheight,
        width,
        height,
        mime,
        extmetadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { value: v, source: 'commons-desc-page' }])),
        ...overrides,
      },
    ],
  };
}

const LONG_ARTIST =
  '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane &amp; John Photographer of the Very Long Studio Name International Ltd.</a>';
const LONG_DESC =
  '<p>The <b>capital</b> seen from the river at dusk, with the old town, the bridge, the cathedral and the modern skyline of glass towers behind them, photographed in late summer.</p>';

/** Realistic mocked `generator=images` result: 6 good photos among 18 pages. */
const FIXTURE: MwPage[] = [
  page('Flag of Testland.svg', 'image/svg+xml', 1200, 800),
  page('Testland location map.png', 'image/png', 2000, 1500, { ImageDescription: 'Location map of Testland' }),
  page('Small thumb.jpg', 'image/jpeg', 500, 300),
  page('Animated thing.gif', 'image/gif', 1000, 700),
  page('Coat of arms of Testland.png', 'image/png', 1000, 1200),
  page('Capital skyline.jpg', 'image/jpeg', 3000, 2000, {
    ObjectName: '<b>Capital skyline</b> at dusk',
    Artist: LONG_ARTIST,
    LicenseShortName: 'CC BY-SA 4.0',
  }),
  page('Mountain lake.jpg', 'image/jpeg', 4000, 2500, { LicenseShortName: 'CC BY 2.0', Artist: 'Ann Example' }),
  page('Portrait tower.jpg', 'image/jpeg', 2000, 3000),
  page('Village street.jpg', 'image/jpeg', 1600, 1000, { ImageDescription: LONG_DESC }),
  page('Panorama wide.jpg', 'image/jpeg', 6000, 1500),
  page('Beach sunset.jpg', 'image/jpeg', 1600, 1000),
  page('Population pyramid Testland.png', 'image/png', 1200, 900),
  page('Nice photo.jpg', 'image/jpeg', 2000, 1400, { ImageDescription: 'Old map of the harbour, 1850' }),
  page('Topo.tif', 'image/tiff', 3000, 3000),
  page('Mountain lake.jpg', 'image/jpeg', 4000, 2500), // duplicate
  page('Testland Köppen.png', 'image/png', 1400, 900, { ObjectName: 'Testland Köppen classification' }),
  { pageid: 1, ns: 6, title: 'File:No info.jpg' }, // no imageinfo
  page('Weird mime.jpg', 'image/webp', 1600, 1000),
];

test('filterImages keeps exactly the 6 photographs', () => {
  const kept = filterImages(FIXTURE).map((p) => p.title);
  assert.deepEqual(kept, [
    'File:Capital skyline.jpg',
    'File:Mountain lake.jpg',
    'File:Portrait tower.jpg',
    'File:Village street.jpg',
    'File:Panorama wide.jpg',
    'File:Beach sunset.jpg',
  ]);
});

test('rankImages: landscape first, then pixels, then original order', () => {
  const ranked = rankImages(filterImages(FIXTURE)).map((p) => p.title);
  assert.deepEqual(ranked, [
    'File:Mountain lake.jpg', // landscape, 10 Mpx
    'File:Capital skyline.jpg', // landscape, 6 Mpx
    'File:Village street.jpg', // landscape, 1.6 Mpx, appears before Beach sunset
    'File:Beach sunset.jpg', // landscape, 1.6 Mpx (tie → article order)
    'File:Panorama wide.jpg', // ratio 4 → not landscape, 9 Mpx
    'File:Portrait tower.jpg', // portrait, 6 Mpx
  ]);
});

test('selectImages returns exactly 5 in rank order with correct mapping', () => {
  const images = selectImages(FIXTURE);
  assert.equal(images.length, 5);
  assert.deepEqual(
    images.map((i) => i.url.split('/').pop()),
    ['Mountain_lake.jpg', 'Capital_skyline.jpg', 'Village_street.jpg', 'Beach_sunset.jpg', 'Panorama_wide.jpg'],
  );

  const skyline = images[1]!;
  assert.equal(skyline.title, 'Capital skyline at dusk', 'ObjectName is HTML-stripped');
  assert.ok(skyline.credit && skyline.credit.length <= 60, `credit capped: ${skyline.credit}`);
  assert.ok(skyline.credit!.startsWith('Jane & John Photographer'), 'credit HTML/entities stripped');
  assert.ok(skyline.credit!.endsWith('…'));
  assert.equal(skyline.license, 'CC BY-SA 4.0');
  assert.equal(skyline.sourcePage, 'https://commons.wikimedia.org/wiki/File:Capital_skyline.jpg');
  assert.equal(skyline.thumbUrl, `${COMMONS}/thumb/a/ab/Capital_skyline.jpg/900px-Capital_skyline.jpg`);
  assert.equal(skyline.width, 900);
  assert.equal(skyline.height, 600);

  const lake = images[0]!;
  assert.equal(lake.title, 'Mountain lake', 'falls back to cleaned file title');
  assert.equal(lake.credit, 'Ann Example');
  assert.equal(lake.license, 'CC BY 2.0');

  const village = images[2]!;
  assert.ok(village.title.length <= 90, `description capped to 90: ${village.title}`);
  assert.ok(village.title.startsWith('The capital seen from the river at dusk'));
  assert.ok(!/<|&amp;/.test(village.title));
  assert.equal(village.credit, undefined);
  assert.equal(village.license, undefined);
});

test('selectImages honours count and never exceeds available', () => {
  assert.equal(selectImages(FIXTURE, 2).length, 2);
  assert.equal(selectImages(FIXTURE, 50).length, 6);
  assert.deepEqual(selectImages([], 5), []);
});

test('toCountryImage falls back gracefully on sparse imageinfo', () => {
  const img = toCountryImage({ title: 'File:Lonely_photo.jpeg', imageinfo: [{ url: 'https://x/y/Lonely_photo.jpeg', width: 800, height: 600 }] });
  assert.equal(img.thumbUrl, img.url);
  assert.equal(img.width, 800);
  assert.equal(img.height, 600);
  assert.equal(img.title, 'Lonely photo');
  assert.equal(img.sourcePage, 'https://commons.wikimedia.org/wiki/File%3ALonely_photo.jpeg');
});

test('helpers: stripHtml / truncate / cleanFileTitle / mergeImages', () => {
  assert.equal(stripHtml('<a href="#">Tom &amp; Jerry</a><br/>2nd&nbsp;line &#169;'), 'Tom & Jerry 2nd line ©');
  assert.equal(truncate('short', 10), 'short');
  const t = truncate('a'.repeat(50) + ' ' + 'b'.repeat(50), 60);
  assert.ok(t.length <= 60 && t.endsWith('…'), t);
  assert.equal(cleanFileTitle('File:Eiffel_Tower_at_dusk.jpg'), 'Eiffel Tower at dusk');
  const a = selectImages(FIXTURE, 2);
  const b = selectImages(FIXTURE, 4);
  assert.equal(mergeImages(a, b).length, 4);
});
