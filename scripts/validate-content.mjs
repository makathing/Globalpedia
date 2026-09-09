#!/usr/bin/env node
// Validates content/countries/*.json against the CountryContent contract + STYLE.md limits.
// Usage: node scripts/validate-content.mjs            (all files)
//        node scripts/validate-content.mjs FRA DEU    (specific ISO3 codes)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'content', 'countries');
const wc = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

const args = process.argv.slice(2);
const files = args.length
  ? args.map((c) => `${c.toUpperCase()}.json`)
  : readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

let errors = 0;
const warn = (f, m) => console.warn(`  ⚠ ${f}: ${m}`);
const fail = (f, m) => { console.error(`  ✖ ${f}: ${m}`); errors++; };

for (const f of files) {
  const p = join(dir, f);
  if (!existsSync(p)) { fail(f, 'file missing'); continue; }
  let c;
  try { c = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(f, `invalid JSON: ${e.message}`); continue; }
  const iso = f.replace('.json', '');
  if (c.iso3 !== iso) fail(f, `iso3 "${c.iso3}" ≠ filename`);
  for (const k of ['tagline', 'overview', 'landAndNature', 'peopleAndCulture', 'history']) {
    if (typeof c[k] !== 'string' || !c[k].trim()) fail(f, `${k} missing/empty`);
  }
  if (!Array.isArray(c.funFacts) || c.funFacts.length < 4 || c.funFacts.length > 6) fail(f, `funFacts must have 4–6 items (has ${c.funFacts?.length ?? 0})`);
  else c.funFacts.forEach((x, i) => { if (typeof x !== 'string' || wc(x) > 34) warn(f, `funFacts[${i}] too long (${wc(x)} words)`); });
  if (c.tagline && (wc(c.tagline) > 8 || /\.$/.test(c.tagline.trim()))) warn(f, `tagline should be ≤8 words with no trailing period`);
  const ranges = { overview: [100, 230], landAndNature: [55, 150], peopleAndCulture: [55, 150], history: [65, 160] };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    const n = wc(c[k]);
    if (n && (n < lo || n > hi)) warn(f, `${k} is ${n} words (target ${lo}–${hi})`);
  }
  if (c.overview && !c.overview.includes('\n\n')) warn(f, 'overview should have 2–3 paragraphs separated by \\n\\n');
  const all = [c.overview, c.landAndNature, c.peopleAndCulture, c.history, ...(c.funFacts || [])].join(' ');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(all)) fail(f, 'contains emoji');
  if (/!{1}/.test(all) && (all.match(/!/g) || []).length > 1) warn(f, 'more than one exclamation mark');
  if (/\bcurrently\b/i.test(all)) warn(f, 'avoid "currently"');
  const extra = Object.keys(c).filter((k) => !['iso3', 'tagline', 'overview', 'landAndNature', 'peopleAndCulture', 'history', 'funFacts', 'pronunciation'].includes(k));
  if (extra.length) fail(f, `unknown keys: ${extra.join(', ')}`);
}
console.log(`${files.length} file(s) checked, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
