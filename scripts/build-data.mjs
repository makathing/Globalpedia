#!/usr/bin/env node
/**
 * Globalpedia data pipeline — `npm run build:data`
 *
 *   inputs   mledoze/countries (facts + flag SVGs, GitHub raw)
 *            world-atlas/countries-50m.json (Natural Earth TopoJSON, npm)
 *            datasets/population (World Bank population CSV, GitHub raw)
 *            content/countries/<ISO3>.json (authored articles, optional)
 *   outputs  public/data/countries.json     CountriesFile (see src/core/types.ts)
 *            public/data/world-50m.json     TopoJSON with ISO3 geometry ids
 *            public/data/flags/<ISO3>.svg   250 + Kosovo flags
 *            public/data/sources.json       provenance / licences / years
 *
 * Idempotent: downloads are cached under scratch/cache (git-ignored) and
 * re-used on later runs. Node built-ins only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIKIPEDIA_TITLES } from './lib/wikipedia-titles.mjs';
import { fetchCached, mapLimit, parseCsv } from './lib/fetch-cache.mjs';

const t0 = Date.now();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'scratch', 'cache');
const outDir = join(root, 'public', 'data');
const flagsDir = join(outDir, 'flags');
const contentDir = join(root, 'content', 'countries');
const listsDir = join(root, 'content', 'lists');

const SOURCES = {
  countries: {
    name: 'mledoze/countries',
    url: 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json',
    license: 'ODbL-1.0',
  },
  flags: {
    name: 'mledoze/countries flag SVGs',
    url: 'https://raw.githubusercontent.com/mledoze/countries/master/data/<cca3>.svg',
    license: 'ODbL-1.0 (flag artwork public domain / see repository)',
  },
  geometry: {
    name: 'world-atlas countries-50m (Natural Earth 1:50m)',
    url: 'https://www.npmjs.com/package/world-atlas',
    license: 'ISC (code) / Natural Earth public domain (data)',
  },
  population: {
    name: 'World Bank population (datasets/population mirror)',
    url: 'https://raw.githubusercontent.com/datasets/population/main/data/population.csv',
    license: 'CC-BY-4.0',
  },
};

/** World Bank uses a few codes that differ from ISO 3166-1 alpha-3. */
const POPULATION_CODE_ALIASES = { XKX: 'UNK' };

/** Geometries in world-atlas that carry no ISO numeric id. */
const UNNUMBERED_GEOMETRIES = {
  Kosovo: { id: 'UNK', name: 'Kosovo' },
  Somaliland: { id: '_SOMALILAND' },
  'N. Cyprus': { id: '_NCYPRUS' },
  'Indian Ocean Ter.': { id: '_IOT' },
  'Siachen Glacier': { id: '_SIACHEN' },
};

/** Used only if mledoze ever drops Kosovo. */
const KOSOVO_FALLBACK = {
  cca2: 'XK', cca3: 'UNK', ccn3: '', independent: null, status: 'user-assigned',
  name: { common: 'Kosovo', official: 'Republic of Kosovo' },
  capital: ['Pristina'], region: 'Europe', subregion: 'Southeast Europe',
  languages: { sqi: 'Albanian', srp: 'Serbian' },
  currencies: { EUR: { name: 'Euro', symbol: '€' } },
  area: 10908, latlng: [42.6, 21], landlocked: true,
  borders: ['ALB', 'MKD', 'MNE', 'SRB'], flag: '🇽🇰',
  demonyms: { eng: { m: 'Kosovar', f: 'Kosovar' } },
};

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  ⚠', ...a);
const isSvg = (buf) => /^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 200).toString('utf8').replace(/^﻿/, ''));
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

// ---------------------------------------------------------------- 1. facts
async function loadMledoze() {
  const { buf, cached } = await fetchCached(SOURCES.countries.url, join(cacheDir, 'mledoze-countries.json'), {
    validate: (b) => { try { return Array.isArray(JSON.parse(b.toString('utf8'))); } catch { return false; } },
  });
  const list = JSON.parse(buf.toString('utf8'));
  log(`mledoze/countries: ${list.length} entries (${cached ? 'cache' : 'downloaded'})`);
  if (!list.some((c) => c.cca3 === 'UNK')) {
    warn('mledoze has no Kosovo (UNK) — using built-in fallback record');
    list.push(KOSOVO_FALLBACK);
  }
  return list;
}

// ---------------------------------------------------------------- 2. flags
async function downloadFlags(countries) {
  mkdirSync(flagsDir, { recursive: true });
  const failures = [];
  let fromCache = 0;
  await mapLimit(countries, 8, async (c) => {
    const iso3 = c.cca3;
    const url = `https://raw.githubusercontent.com/mledoze/countries/master/data/${iso3.toLowerCase()}.svg`;
    try {
      const { buf, cached } = await fetchCached(url, join(cacheDir, 'flags', `${iso3}.svg`), { validate: isSvg });
      if (cached) fromCache++;
      const dest = join(flagsDir, `${iso3}.svg`);
      if (!existsSync(dest) || !readFileSync(dest).equals(buf)) writeFileSync(dest, buf);
    } catch (err) {
      failures.push(iso3);
      warn(`flag ${iso3}: ${err.message}`);
    }
  });
  log(`flags: ${countries.length - failures.length}/${countries.length} written to public/data/flags (${fromCache} from cache)`);
  return failures;
}

// ---------------------------------------------------------------- 3. population
async function loadPopulation() {
  try {
    const { buf, cached } = await fetchCached(SOURCES.population.url, join(cacheDir, 'population.csv'), {
      validate: (b) => b.subarray(0, 64).toString('utf8').startsWith('Country Name,Country Code,Year,Value'),
    });
    const rows = parseCsv(buf.toString('utf8'));
    const header = rows.shift();
    const iCode = header.indexOf('Country Code');
    const iYear = header.indexOf('Year');
    const iValue = header.indexOf('Value');
    /** @type {Map<string, {year:number, value:number}>} */
    const latest = new Map();
    for (const r of rows) {
      const code = POPULATION_CODE_ALIASES[r[iCode]] ?? r[iCode];
      const year = Number(r[iYear]);
      const value = Number(r[iValue]);
      if (!code || !Number.isFinite(year) || !Number.isFinite(value) || value <= 0) continue;
      const prev = latest.get(code);
      if (!prev || year > prev.year) latest.set(code, { year, value: Math.round(value) });
    }
    const years = [...latest.values()].map((v) => v.year);
    const info = { ...SOURCES.population, latestYear: Math.max(...years), earliestYearUsed: Math.min(...years) };
    log(`population: ${latest.size} codes, latest year ${info.latestYear} (${cached ? 'cache' : 'downloaded'})`);
    return { latest, info };
  } catch (err) {
    warn(`population unavailable (${err.message}) — omitting \`population\``);
    return { latest: new Map(), info: { ...SOURCES.population, unavailable: true, error: err.message } };
  }
}

// ---------------------------------------------------------------- 4. geometry
function buildTopology(countries) {
  const topoPath = join(root, 'node_modules', 'world-atlas', 'countries-50m.json');
  const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
  const byCcn3 = new Map(countries.filter((c) => c.ccn3).map((c) => [c.ccn3, c]));
  let unmatched = 0;
  for (const g of topo.objects.countries.geometries) {
    const neName = g.properties?.name ?? '';
    if (g.id === undefined || g.id === null) {
      const special = UNNUMBERED_GEOMETRIES[neName];
      if (!special) { warn(`geometry "${neName}" has no id and no mapping — keeping as _${neName}`); }
      g.id = special?.id ?? `_${neName.replace(/\W+/g, '_').toUpperCase()}`;
      g.properties = { name: special?.name ?? neName, ccn3: '' };
      continue;
    }
    const ccn3 = String(g.id).padStart(3, '0');
    const c = byCcn3.get(ccn3);
    if (!c) {
      unmatched++;
      warn(`geometry ${ccn3} "${neName}" has no mledoze match — keeping numeric id`);
      g.id = ccn3;
      g.properties = { name: neName, ccn3 };
      continue;
    }
    g.id = c.cca3;
    g.properties = { name: c.name.common, ccn3 };
  }
  // objects.land is kept: it only references arcs already needed by `countries`
  // (~13 kB), and lets the globe draw a single land silhouette if it wants one.
  const ids = new Set(topo.objects.countries.geometries.map((g) => g.id));
  const dupes = topo.objects.countries.geometries.map((g) => g.id).filter((id, i, arr) => arr.indexOf(id) !== i);
  if (dupes.length) log(`geometry: duplicate ids kept as-is (Natural Earth quirk): ${dupes.join(', ')}`);
  const noGeometry = countries.filter((c) => !ids.has(c.cca3)).map((c) => c.cca3);
  log(`geometry: ${topo.objects.countries.geometries.length} geometries re-keyed to ISO3` +
      (unmatched ? `, ${unmatched} unmatched` : '') +
      `; ${noGeometry.length} countries without polygon at 1:50m (${noGeometry.join(', ')})`);
  return topo;
}

// ---------------------------------------------------------------- 5. content
function readLists() {
  if (!existsSync(listsDir)) return [];
  const iso3s = new Set();
  for (const f of readdirSync(listsDir).filter((f) => f.endsWith('.json'))) {
    try {
      for (const e of JSON.parse(readFileSync(join(listsDir, f), 'utf8'))) if (e?.iso3) iso3s.add(e.iso3);
    } catch (err) { warn(`content/lists/${f}: ${err.message}`); }
  }
  return [...iso3s].sort();
}

const CONTENT_STRINGS = ['iso3', 'tagline', 'overview', 'landAndNature', 'peopleAndCulture', 'history'];
function readContent(iso3) {
  const p = join(contentDir, `${iso3}.json`);
  if (!existsSync(p)) return undefined;
  let c;
  try { c = JSON.parse(readFileSync(p, 'utf8')); } catch (err) { warn(`content ${iso3}.json: invalid JSON (${err.message}) — skipped`); return undefined; }
  const problems = [];
  for (const k of CONTENT_STRINGS) if (typeof c?.[k] !== 'string' || !c[k].trim()) problems.push(`${k} missing`);
  if (c?.iso3 && c.iso3 !== iso3) problems.push(`iso3 "${c.iso3}" ≠ filename`);
  if (!Array.isArray(c?.funFacts) || c.funFacts.length === 0 || !c.funFacts.every((x) => typeof x === 'string' && x.trim()))
    problems.push('funFacts must be a non-empty string array');
  if (c?.pronunciation !== undefined && typeof c.pronunciation !== 'string') problems.push('pronunciation must be a string');
  if (problems.length) { warn(`content ${iso3}.json: ${problems.join('; ')} — skipped`); return undefined; }
  const out = { iso3, tagline: c.tagline, overview: c.overview, landAndNature: c.landAndNature,
    peopleAndCulture: c.peopleAndCulture, history: c.history, funFacts: c.funFacts };
  if (c.pronunciation) out.pronunciation = c.pronunciation;
  return out;
}

// ---------------------------------------------------------------- 6. records
function formatCurrency(code, cur) {
  const name = cur?.name?.trim() || code;
  const symbol = cur?.symbol?.trim();
  return symbol && symbol !== name ? `${name} (${symbol})` : name;
}

function toRecord(c, population, content) {
  const iso3 = c.cca3;
  const demonym = c.demonyms?.eng?.m?.trim();
  const rec = {
    iso3,
    iso2: c.cca2 ?? '',
    ccn3: c.ccn3 ?? '',
    name: c.name.common,
    officialName: c.name.official ?? c.name.common,
    wikipediaTitle: WIKIPEDIA_TITLES[iso3] ?? c.name.common,
    capital: Array.isArray(c.capital) ? c.capital : [],
    region: c.region ?? '',
    subregion: c.subregion ?? '',
    languages: Object.values(c.languages ?? {}),
    currencies: Object.entries(c.currencies ?? {}).map(([code, cur]) => formatCurrency(code, cur)),
    area: Number(c.area) || 0,
  };
  if (population !== undefined) rec.population = population;
  rec.latlng = [Number(c.latlng?.[0]) || 0, Number(c.latlng?.[1]) || 0];
  rec.landlocked = c.landlocked === true;
  rec.borders = Array.isArray(c.borders) ? c.borders : [];
  if (demonym) rec.demonym = demonym;
  rec.flagEmoji = c.flag ?? '';
  rec.flagSvg = `data/flags/${iso3}.svg`;
  rec.independent = c.independent === true || iso3 === 'UNK';
  rec.status = c.status ?? '';
  if (content) rec.content = content;
  return rec;
}

// ---------------------------------------------------------------- main
async function main() {
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const mledoze = await loadMledoze();
  mledoze.sort((a, b) => a.cca3.localeCompare(b.cca3));

  const [flagFailures, { latest: population, info: populationInfo }] = await Promise.all([
    downloadFlags(mledoze),
    loadPopulation(),
  ]);

  const topo = buildTopology(mledoze);

  const listIso3 = readLists();
  const contentFiles = existsSync(contentDir) ? readdirSync(contentDir).filter((f) => f.endsWith('.json')) : [];
  const countries = {};
  let withContent = 0;
  let withPopulation = 0;
  for (const c of mledoze) {
    const pop = population.get(c.cca3)?.value;
    if (pop !== undefined) withPopulation++;
    const content = readContent(c.cca3);
    if (content) withContent++;
    countries[c.cca3] = toRecord(c, pop, content);
  }
  for (const f of contentFiles) {
    const iso3 = f.replace(/\.json$/, '');
    if (!countries[iso3]) warn(`content/countries/${f} has no matching country — ignored`);
  }
  const unknownListed = listIso3.filter((i) => !countries[i]);
  if (unknownListed.length) warn(`content/lists reference unknown ISO3: ${unknownListed.join(', ')}`);

  const generatedAt = new Date().toISOString();
  const countriesJson = JSON.stringify({ generatedAt, countries });
  const worldJson = JSON.stringify(topo);
  writeFileSync(join(outDir, 'countries.json'), countriesJson);
  writeFileSync(join(outDir, 'world-50m.json'), worldJson);
  writeFileSync(join(outDir, 'sources.json'), JSON.stringify({
    generatedAt,
    sources: { ...SOURCES, population: populationInfo,
      wikipedia: { name: 'English Wikipedia / Wikimedia Commons', url: 'https://en.wikipedia.org/w/api.php',
        license: 'text CC BY-SA 4.0; images licensed per file', note: 'fetched in the visitor\'s browser at runtime (src/data/images.ts)' } },
    counts: { countries: Object.keys(countries).length, withContent, withPopulation,
      geometries: topo.objects.countries.geometries.length, flags: mledoze.length - flagFailures.length },
  }, null, 2) + '\n');

  // summary
  const independent = Object.values(countries).filter((r) => r.independent).length;
  log('');
  log(`countries.json : ${Object.keys(countries).length} countries (${independent} independent), ` +
      `${withPopulation} with population, ${withContent} with content — ${kb(Buffer.byteLength(countriesJson))}`);
  log(`world-50m.json : ${topo.objects.countries.geometries.length} geometries — ${kb(Buffer.byteLength(worldJson))}`);
  const missingContent = listIso3.filter((i) => !countries[i]?.content);
  if (contentFiles.length === 0) log(`content        : content/countries is empty — 0/${listIso3.length} listed countries have articles yet`);
  else log(`content        : ${listIso3.length - missingContent.length}/${listIso3.length} listed countries have articles` +
      (missingContent.length ? `; missing: ${missingContent.join(' ')}` : ''));
  if (flagFailures.length) {
    console.error(`✖ ${flagFailures.length} flag(s) failed to download: ${flagFailures.join(', ')}`);
    process.exitCode = 1;
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('✖ build-data failed:', err);
  process.exit(1);
});
