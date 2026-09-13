# src/data — data pipeline & runtime loaders

## Pipeline (`npm run build:data` → `scripts/build-data.mjs`, ~4 s cold / 0.1 s cached)

| Output (`public/data/`)   | Built from                                                            |
| ------------------------- | --------------------------------------------------------------------- |
| `countries.json`          | `CountriesFile`: 250 mledoze entries incl. Kosovo (`UNK`), + authored `content/countries/<ISO3>.json` merged as `content` |
| `world-50m.json`          | `world-atlas/countries-50m.json`, geometry `id` re-keyed ISO numeric → ISO3, `properties = { name, ccn3 }`; `objects.land` kept (~13 kB, shares arcs) |
| `flags/<ISO3>.svg`        | mledoze `data/<cca3>.svg`, validated to start with `<svg`/`<?xml`     |
| `sources.json`            | provenance, licences, population year, record counts                  |

Downloads are cached in `scratch/cache/` (git-ignored); delete it to force a refresh.
The script is idempotent and tolerates a partial or empty `content/countries/` — invalid
content files are skipped with a warning and the summary lists ISO3s still missing an article.

Geometry notes: Natural Earth has no polygons for 14 small territories (BES, BVT, CCK, CXR, GIB,
GLP, GUF, MTQ, MYT, REU, SJM, TKL, TUV, UMI); five unnumbered shapes get ids `UNK` (Kosovo),
`_SOMALILAND`, `_NCYPRUS`, `_IOT`, `_SIACHEN` (leading `_` = not a country); Australia appears
twice with id `AUS` (a Natural Earth quirk — treat ids as non-unique or `topojson.merge` them).

`wikipediaTitle` defaults to `name.common`; overrides live in `scripts/lib/wikipedia-titles.mjs`.

## Sources & licences

- **mledoze/countries** — facts + flags — <https://github.com/mledoze/countries> — ODbL 1.0
- **world-atlas** (Natural Earth 1:50m) — <https://github.com/topojson/world-atlas> — Natural Earth data is public domain
- **World Bank population** via <https://github.com/datasets/population> (`Country Code`, latest year per country, `XKX`→`UNK`) — CC BY 4.0. Missing for Taiwan, Vatican City and a few territories → `population` omitted.
- **English Wikipedia / Wikimedia Commons** (runtime only) — text CC BY-SA 4.0, images licensed per file (`CountryImage.license` / `credit` / `sourcePage` must be shown).

## Runtime (`src/data/index.ts`)

```ts
loadWorld(): Promise<Topology>                       // data/world-50m.json
loadCountries(): Promise<Record<string, CountryRecord>>
loadAll(bus: EventBus): Promise<{ world, countries }> // parallel, emits 'data:ready'
fetchCountryImages(record, { signal?, count? = 5 }): Promise<CountryImage[]>
```

URLs are resolved as `new URL(import.meta.env.BASE_URL + 'data/…', document.baseURI)`, so
they work at `/` and under GitHub Pages sub-paths (`vite.config` `base: './'`).

### Image client (`images.ts` + pure `image-filter.ts`)

Wikimedia is unreachable at build time, so photos are fetched in the visitor's browser:
`en.wikipedia.org/w/api.php?action=query&generator=images&prop=imageinfo&origin=*` for the
country's `wikipediaTitle` (one `continue` page max, `redirects=1`), then filtered — JPEG/PNG only,
≥ 640×400, no flags/maps/logos/charts/etc. (`EXCLUDE_RE` on title, ObjectName and description),
no `.gif`/`.tif`, de-duplicated — and ranked: landscape (w/h 1.2–2.2) first, then pixel count,
then article order. Fewer than `count` hits are topped up from the capital's article.
Results are cached in `sessionStorage` (`gp:img:<ISO3>`); an 8 s timeout is combined with the
caller's `AbortSignal`. Partial results are returned as-is; only a total failure throws, so the
UI should catch and show a fallback (e.g. the flag). Tests: `npm test` (`tests/`).
