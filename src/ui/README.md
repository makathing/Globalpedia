# `src/ui` — Globalpedia UI module

Header (brand + typeahead search), info panel (index card / bottom sheet), photo lightbox,
hover tooltip, loading overlay, first-use hint, footer. Vanilla DOM + one stylesheet.
Talks to the rest of the app **only** through the `EventBus` in `src/core/events.ts`.

## API

```ts
import { createUI } from './ui';
const ui = createUI({ header, panel, footer, stage }, bus);  // the four #ids from index.html

ui.showCountry(record);          // open/update panel; photo strip shows 5 skeletons
ui.setImages(iso3, images);      // fill the strip (ignored if iso3 isn't the shown country)
ui.setImagesFailed(iso3);        // fallback tiles (flag + "Photos load from Wikipedia…")
ui.close();                      // same as × / Esc; emits ui:close
ui.setCountries(map);            // search index + neighbour names (auto on data:ready)
ui.setLoading(on, message?);     // "Inflating the globe…" overlay over #stage
ui.dispose();
```

Bus traffic: listens to `data:ready`, `globe:select` (opens the panel when the record is
known), `globe:hover` (tooltip). Emits `ui:flyTo` + `globe:select` from search results and
neighbour chips, and `ui:close` when the panel closes. `main.ts` should still call
`showCountry()` on `globe:select` (a second call for the same iso3 is cheap and keeps photos).

## Files

| file | role |
|---|---|
| `index.ts` | `createUI()` / `UIHandle`; wires the pieces; imports `../styles/app.css` |
| `header.ts` | brand mark, wordmark, tagline, ARIA combobox search (name / official / capital / iso3) |
| `panel.ts` | info panel: identity, 5-slot photo strip, facts grid, article, focus + Esc handling |
| `lightbox.ts` | `<dialog>` viewer, ← → Esc, click-outside, focus trap + restore |
| `tooltip.ts` | paper-tag tooltip following the pointer on `globe:hover` |
| `overlay.ts` | loading overlay and the fading "Drag to spin…" hint |
| `footer.ts` | credits line |
| `dom.ts` | `el()` / `append()` / `svg()` helpers — all data goes through `textContent` |
| `format.ts` | population ("about 68 million"), area, Wikipedia URL, paragraph split |
| `icons.ts` | constant inline SVG strings (the only input `svg()` accepts) |
| `../styles/app.css` | all layout + theme, class prefix `gp-` |

## Design tokens (`:root` in app.css; dark variants under `prefers-color-scheme: dark`)

- Paper: `--gp-paper #fbf8f1`, `--gp-paper-2`, rules `--gp-rule` (blue, ~13%), `--gp-margin` (red),
  `--gp-rule-gap 30px`, `--gp-margin-x`, grain `--gp-grain-opacity`, `--gp-vignette`.
- Ink: `--gp-ink #2b241f`, `--gp-ink-2`, `--gp-ink-3`, `--gp-ink-faint`.
- Brand: `--gp-ocean`, `--gp-land`, `--gp-brass`, `--gp-accent #c8553d`, `--gp-blue #2f6f8f`, `--gp-focus`.
- Card: `--gp-card`, `--gp-card-rule`, `--gp-card-shadow`, `--gp-tape`, `--gp-chip`, skeleton + tooltip colours.
- Type: `--gp-font-head` (Fraunces → Iowan Old Style/Palatino/Georgia), `--gp-font-body`
  (Nunito → system-ui), `--gp-fs-body 16px`, `--gp-lh-body 1.55`. Google Fonts are optional.
- Motion/layout: `--gp-dur 240ms`, `--gp-ease`, `--gp-panel-w min(420px, 40vw)`, `--gp-gutter`.
  Bottom-sheet mode kicks in at `max-width: 720px`. Reduced motion disables all transitions.
