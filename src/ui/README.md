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
ui.sheetCoverage();              // 0-1: how much of #stage the bottom sheet covers
ui.onSheetCoverage(fn);          // subscribe to that (fires once now, then on change)
ui.setCountries(map);            // search index + neighbour names (auto on data:ready)
ui.setLoading(on, message?);     // "Inflating the globe…" overlay over #stage
ui.dispose();
```

### Framing the globe around the sheet

On a phone the panel is a bottom sheet, so the centre of `#stage` is *under* it and
a fly-to that centres a country there hides the thing it just flew to. The UI knows
how much of the stage is covered; the camera owner wires it up:

```ts
ui.onSheetCoverage((coverage) => globe.setViewOffset(Math.min(coverage / 2, LIMIT)));
```

`#globe` fills `#stage`, so the coverage is also a fraction of the globe canvas's
height — the unit `setViewOffset` takes. Half of it, because that is how far the
centre of the *visible* strip of stage sits above the centre of the whole stage.
The UI does not clamp: only the camera knows how far the globe can rise before it
leaves the canvas (`setViewOffset`'s own note puts that near 0.24 at 390x844).
Peek covers ~0.48 and full ~0.88 — read the number, do not hard-code one detent.

`sheetCoverage()` is `0` whenever the panel is closed or the layout is the desktop
side card, and it reports settled values only — a finger mid-drag does not move
the camera.

### The sheet

Two detents, both percentages of `#stage` (never of the viewport — the stage is
the box the sheet actually shares with the globe):

| detent | height | globe keeps |
|---|---|---|
| `peek` (default) | `clamp(240px, 48%, 340px)` | ~52% of the stage |
| `full` | `min(88%, 680px)` | ~12% of the stage |

The grabber and the sheet's own header are both drag surfaces: drag up to expand,
down to collapse, further down to dismiss; a flick decides on its own. Tapping the
grabber toggles, and it is a `<button>`, so Enter/Space do the same thing. A tap on
the globe that selects nothing closes the sheet, and the foot bar carries `Close`
where a thumb already is. Whichever detent the reader settles on is where the next
country opens.

`data-detent` on `#panel` is the live state; `SHEET_QUERY` in `panel.ts` must stay
in step with the matching `@media` block in `app.css`.

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
| `panel.ts` | info panel: identity, 5-slot photo strip, facts grid, article, focus + Esc handling, the two-detent bottom sheet and its drag/dismiss gestures |
| `lightbox.ts` | `<dialog>` viewer, ← → Esc, click-outside, focus trap + restore |
| `tooltip.ts` | paper-tag tooltip following the pointer on `globe:hover` |
| `overlay.ts` | loading overlay and the fading "Drag to spin…" hint |
| `footer.ts` | credits line; a short one-line variant under 720px so every link is a 44px target |
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
  Reduced motion disables all transitions.
- Safe areas: `--gp-safe-t/r/b/l` wrap `env(safe-area-inset-*)`. `index.html` sets
  `viewport-fit=cover`, so every edge that holds something tappable — header, footer,
  the sheet's foot bar, the hint, the lightbox controls — adds the matching inset.
  Android gesture navigation reports no inset, which is why the footer's links are
  also sized to 44px rather than relying on the inset alone.

## Breakpoints

Three axes, not one — a phone on its side is not a small desktop:

| query | what it is |
|---|---|
| `max-width: 1024px` | narrower side card |
| `max-width: 720px` | phone chrome: wrapped header, 44px controls, short footer, theme picker as a bottom card |
| `max-width: 720px` **and** `min-height: 481px` | the bottom sheet |
| `max-height: 480px` | short viewports (a phone in landscape): compact header and footer, a narrower side card, one-column facts, smaller photo tiles |
| `max-width: 460px` | one-column facts grid |
| `hover: none` | hover styles that would otherwise stick after a tap |
