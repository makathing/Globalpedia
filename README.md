# Globalpedia

A 3D school globe you can spin. Tap a country name and an index card slides in with the
flag, five photographs, key facts and a short encyclopedia article written for curious kids
(clear and precise, never dumbed down).

## Run it

```bash
npm install
npm run build:data   # downloads borders/facts/flags and merges the articles → public/data/
npm run dev          # http://localhost:5173
```

`npm run build` regenerates the data, type-checks and bundles to `dist/`.
`npm test` runs the unit tests; `npm run smoke` drives the built site in headless Chromium.

## Themes

Six looks, each restyling the page and the globe together, chosen from the swatch
picker in the header:

| Theme | The wall | The globe |
|---|---|---|
| Classroom | Cream paper, blue rules, red margin | Pastel countries, brass ring, walnut base |
| Chalkboard | Slate-green board, faint chalk grid | Chalk outlines and dusty fills, pewter stand |
| Vintage Atlas | Aged parchment, sepia rules | Ochre and umber, antique brass, mahogany |
| Blueprint | Indigo drafting paper, white grid | White line-work over a near-black ocean |
| Field Notebook | Pale mint graph paper | Botanical greens, tan and clay, kraft stand |
| Night Study | Dark navy paper, lamp vignette | Deep teal ocean, dim jewel fills, warm brass |

The choice is saved to `localStorage` and applied before first paint, so there is no
flash on reload. With nothing saved, the app opens in Classroom, or Night Study when
the system asks for dark.

`src/core/themes.ts` is the single source of truth: it carries both the page's custom
properties and the globe's colors, so the two halves cannot drift. Adding a theme means
adding one entry there. Every palette must be exactly eight fills — the globe hands out
indices into it, so a swap keeps each country's color slot and the map retints rather
than reshuffles. `npm test` enforces that, along with contrast floors for text and labels.

## How it is put together

```
src/core/     shared types, the event bus, and the theme table
src/globe/    Three.js globe: canvas-rasterized political texture, brass meridian & stand,
              country labels, pixel-exact picking, fly-to
src/ui/       the paper page, header + search + theme picker, info panel, lightbox
src/data/     loaders for public/data/*.json and the runtime Wikipedia photo client
scripts/      build-data.mjs (Natural Earth via world-atlas + mledoze/countries + World Bank)
content/      the articles: content/countries/<ISO3>.json, one per country, see STYLE.md
```

Photos are fetched in the visitor's browser from the English Wikipedia article for each
country (Wikimedia's API allows cross-origin requests), filtered to keep real photographs and
drop flags, maps and diagrams. Offline or blocked, the panel falls back to the bundled flag.

## Data & licences

- Borders: [Natural Earth](https://www.naturalearthdata.com/) via `world-atlas` (public domain)
- Facts & flags: [mledoze/countries](https://github.com/mledoze/countries) (ODbL)
- Population: World Bank via `datasets/population` (CC BY 4.0), when available at build time
- Photos & "Read more" links: Wikipedia / Wikimedia Commons, credited per image
- Articles: original text in `content/`, © this repository, CC BY-SA 4.0

## Deploying

`.github/workflows/deploy.yml` builds and publishes `dist/` to GitHub Pages on every push to
`main` (enable Pages → Source: GitHub Actions in the repo settings). Vite is configured with
`base: './'`, so the site works from any sub-path.
