# `src/ui` — Globalpedia UI module

Header (brand + typeahead search + theme picker), info panel (index card / bottom sheet),
photo lightbox, hover tooltip, loading overlay, first-use hint, footer. Vanilla DOM + one
stylesheet. Talks to the rest of the app **only** through the `EventBus` in `src/core/events.ts`.

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
neighbour chips, `ui:close` when the panel closes, and `ui:theme` whenever the theme changes
(the globe repaints from it). `main.ts` should still call
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
| `theme.ts` | `createThemeController()` — owns `<html data-theme>` + the inline theme tokens |
| `theme-toggle.ts` | header button + swatch popover (`role="menu"`, roving focus) |
| `icons.ts` | constant inline SVG strings (the only input `svg()` accepts) |
| `../styles/app.css` | all layout + theme, class prefix `gp-` |

## Themes

Six themes live in `src/core/themes.ts` — the single source of truth for the page tokens
*and* the globe's colors. Nothing in `src/ui` or `src/styles` hand-writes a theme:

```ts
const theme = createThemeController(bus);   // built in createUI(), passed to renderHeader()
theme.current();                            // the Theme showing now
theme.set('blueprint');                     // apply + persist to localStorage `gp:theme`
theme.set('classroom', { persist: false }); // apply without remembering (startup / OS follow)
theme.dispose();
```

`set()` stamps `data-theme` on `<html>`, calls `setProperty()` for every entry in
`Theme.css`, emits `ui:theme` and announces the name in a `role="status"` region.
Startup order: a saved `gp:theme` wins, then whatever the pre-paint script in `index.html`
already stamped, then `DEFAULT_DARK_THEME` / `DEFAULT_THEME` from the OS preference. Until
the viewer picks one, the page keeps following `prefers-color-scheme` live.

**Never apply `--gp-margin-x`, `--gp-gutter` or `--gp-panel-w` from a theme.** They are set
responsively in app.css and an inline value on `<html>` would beat the media queries. The
table omits them and `theme.ts` filters them out again.

Test hooks: `[data-gp-theme-toggle]` on the header button, `[data-gp-theme="<id>"]` on each
popover row.

## Design tokens (`:root` in app.css carries the Classroom values as the no-JS fallback)

- Paper: `--gp-paper #fbf8f1`, `--gp-paper-2`, rules `--gp-rule` (blue, ~13%), `--gp-rule-faint`,
  `--gp-margin` (red), `--gp-rule-gap 30px`, `--gp-margin-x`, `--gp-vignette`.
- Paper structure: `--gp-paper-image` is the whole `background-image` layer list (ruled, grid,
  graph or plain parchment); `--gp-grain-image` is the tinted noise SVG and `--gp-grain-blend`
  its blend mode (`multiply` on paper, `screen` on a dark board), `--gp-grain-opacity`.
- Depth: `--gp-shadow-rgb` is one `"r, g, b"` triple every `box-shadow` mixes from, so a dark
  board gets black depth instead of brown haze. `--gp-flag-mat` and `--gp-scrim` are derived
  from it and `--gp-paper` in app.css — no theme carries them.
- Ink: `--gp-ink #2b241f`, `--gp-ink-2`, `--gp-ink-3`, `--gp-ink-faint`.
- Brand: `--gp-ocean`, `--gp-land`, `--gp-brass`, `--gp-accent #c8553d`, `--gp-blue #2f6f8f`, `--gp-focus`.
- Card: `--gp-card`, `--gp-card-rule`, `--gp-card-shadow`, `--gp-tape`, `--gp-chip`, skeleton + tooltip colours.
- Type: `--gp-font-head` (Fraunces → Iowan Old Style/Palatino/Georgia), `--gp-font-body`
  (Nunito → system-ui), `--gp-fs-body 16px`, `--gp-lh-body 1.55`. Google Fonts are optional.
- Motion/layout: `--gp-dur 240ms`, `--gp-ease`, `--gp-panel-w min(420px, 40vw)`, `--gp-gutter`.
  Bottom-sheet mode kicks in at `max-width: 720px`. Reduced motion disables all transitions.
