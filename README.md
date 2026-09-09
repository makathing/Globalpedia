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

## How it is put together

```
src/core/     shared types + the event bus (the only link between modules)
src/globe/    Three.js globe: canvas-rasterized political texture, brass meridian & stand,
              country labels, pixel-exact picking, fly-to
src/ui/       notebook-paper page, header + search, the index-card info panel, lightbox
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
