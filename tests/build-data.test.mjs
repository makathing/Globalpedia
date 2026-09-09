/** Checks the generated public/data bundles (runs the build if they are missing). */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'public', 'data');
const countriesPath = join(dataDir, 'countries.json');
const worldPath = join(dataDir, 'world-50m.json');

let world;
let file;

before(() => {
  if (!existsSync(countriesPath) || !existsSync(worldPath)) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-data.mjs')], { cwd: root, stdio: 'inherit', timeout: 120_000 });
    assert.equal(r.status, 0, 'build-data.mjs failed');
  }
  world = JSON.parse(readFileSync(worldPath, 'utf8'));
  file = JSON.parse(readFileSync(countriesPath, 'utf8'));
});

test('world-50m.json: 241 geometries, all with string ids, ISO3-keyed', () => {
  assert.equal(world.type, 'Topology');
  const geoms = world.objects.countries.geometries;
  assert.equal(geoms.length, 241);
  for (const g of geoms) {
    assert.equal(typeof g.id, 'string', `geometry ${g.properties?.name} has non-string id`);
    assert.ok(g.id.length > 0);
    assert.equal(typeof g.properties.name, 'string');
    assert.equal(typeof g.properties.ccn3, 'string');
  }
  const ids = new Set(geoms.map((g) => g.id));
  for (const iso3 of ['FRA', 'USA', 'BRA', 'CHN', 'UNK', 'ATA']) assert.ok(ids.has(iso3), `missing geometry ${iso3}`);
  for (const special of ['_SOMALILAND', '_NCYPRUS', '_IOT', '_SIACHEN']) assert.ok(ids.has(special), `missing ${special}`);
  assert.equal(geoms.find((g) => g.id === 'UNK').properties.name, 'Kosovo');
  assert.equal(geoms.find((g) => g.id === 'FRA').properties.ccn3, '250');
  // Natural Earth 1:50m ships Australia twice (both ccn3 036); everything else is unique.
  const dupes = geoms.map((g) => g.id).filter((id, i, arr) => arr.indexOf(id) !== i);
  assert.deepEqual(dupes, ['AUS'], `unexpected duplicate geometry ids: ${dupes}`);
});

test('countries.json: shape, France, Kosovo, flags on disk', () => {
  assert.match(file.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const countries = file.countries;
  const all = Object.values(countries);
  assert.ok(all.length >= 250, `expected >= 250 countries, got ${all.length}`);

  const fra = countries.FRA;
  assert.deepEqual(fra.capital, ['Paris']);
  assert.equal(fra.iso2, 'FR');
  assert.equal(fra.ccn3, '250');
  assert.equal(fra.officialName, 'French Republic');
  assert.deepEqual(fra.currencies, ['Euro (€)']);
  assert.deepEqual(fra.languages, ['French']);
  assert.equal(fra.demonym, 'French');
  assert.equal(fra.independent, true);
  assert.equal(fra.flagSvg, 'data/flags/FRA.svg');
  assert.ok(existsSync(join(root, 'public', fra.flagSvg)), 'FRA flag on disk');

  const unk = countries.UNK;
  assert.equal(unk.name, 'Kosovo');
  assert.equal(unk.iso2, 'XK');
  assert.equal(unk.independent, true);
  assert.equal(unk.wikipediaTitle, 'Kosovo');
  assert.deepEqual(unk.borders, ['ALB', 'MKD', 'MNE', 'SRB']);
  assert.equal(countries.GEO.wikipediaTitle, 'Georgia (country)');

  for (const r of all) {
    assert.equal(r.iso3.length, 3);
    assert.ok(existsSync(join(root, 'public', r.flagSvg)), `${r.iso3} flag missing on disk`);
    const svg = readFileSync(join(root, 'public', r.flagSvg), 'utf8').trimStart();
    assert.ok(svg.startsWith('<svg') || svg.startsWith('<?xml'), `${r.iso3} flag is not an SVG`);
    if (r.independent) {
      assert.ok(Array.isArray(r.latlng) && r.latlng.length === 2 && r.latlng.every(Number.isFinite), `${r.iso3} latlng`);
      assert.ok(typeof r.wikipediaTitle === 'string' && r.wikipediaTitle.length > 0, `${r.iso3} wikipediaTitle`);
    }
    if (r.population !== undefined) assert.ok(Number.isInteger(r.population) && r.population > 0, `${r.iso3} population`);
  }
  assert.equal(all.filter((r) => r.independent).length, 195, '194 independent states + Kosovo');
});

test('every ISO3 in content/lists exists in countries.json; content merged when present', (t) => {
  const listsDir = join(root, 'content', 'lists');
  const listed = readdirSync(listsDir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(readFileSync(join(listsDir, f), 'utf8')).map((e) => e.iso3));
  assert.ok(listed.length >= 190, `expected ~195 listed countries, got ${listed.length}`);
  for (const iso3 of listed) assert.ok(file.countries[iso3], `listed ${iso3} missing from countries.json`);

  const contentDir = join(root, 'content', 'countries');
  const contentFiles = existsSync(contentDir) ? readdirSync(contentDir).filter((f) => f.endsWith('.json')) : [];
  if (contentFiles.length === 0) {
    t.skip('content/countries is empty — coverage not checked');
    return;
  }
  // Every valid authored file present at build time must have been merged.
  let merged = 0;
  for (const f of contentFiles) {
    const iso3 = f.replace('.json', '');
    const rec = file.countries[iso3];
    if (!rec?.content) continue;
    merged++;
    assert.equal(rec.content.iso3, iso3);
    for (const k of ['tagline', 'overview', 'landAndNature', 'peopleAndCulture', 'history']) assert.equal(typeof rec.content[k], 'string', `${iso3}.${k}`);
    assert.ok(Array.isArray(rec.content.funFacts) && rec.content.funFacts.length > 0, `${iso3}.funFacts`);
  }
  assert.ok(merged > 0, 'at least one content file merged (re-run npm run build:data if content was added after the last build)');
});
