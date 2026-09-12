# `src/globe` — the school globe

```ts
import { createGlobe } from './globe';
const handle = createGlobe(container, worldTopology, countries, bus, { autoRotate: true });
```

`createGlobe(container, world, countries, bus, opts?) → GlobeHandle`

- `container` — must have an explicit size (the canvas fills it; a `ResizeObserver` follows it).
- `world` — parsed TopoJSON (`public/data/world-50m.json`): `geometry.id` is ISO3, `properties = { name, ccn3 }`.
  `objects.countries` is used (falls back to the first GeometryCollection).
- `countries` — `Record<ISO3, CountryRecord>`; printed name = `name`, anchor = `latlng`,
  size clamp = `area`, ordering = `area` + `independent`.
- `opts.autoRotate` (default true; forced off by `prefers-reduced-motion`), `opts.initialIso3`,
  `opts.textureSize` (8192 | 4096; default 8192 when the GPU allows and the pointer is fine),
  `opts.theme` (a `ThemeId`; default `DEFAULT_THEME`).

`GlobeHandle`: `flyTo(iso3, {duration?}) → Promise`, `setSelected(iso3|null)`, `setAutoRotate(on)`,
`resize()`, `dispose()`. The default export is `createGlobe`.

Bus contract: emits `globe:hover {iso3|null}` (on change) and `globe:select {iso3}` (tap, not drag);
listens to `ui:flyTo {iso3}` (fly + highlight), `ui:close` (clear highlight, auto-rotate resumes after 6 s)
and `ui:theme {id}` (repaint in that theme).

## Files

| file | role |
| --- | --- |
| `index.ts` | `createGlobe`: wires everything, render loop, `flyTo`, bus listeners, dispose |
| `texture.ts` | Canvas2D rasteriser: theme fills (greedy adjacency colouring), graticule, multi-pass outlines; ISO3 pick index; `redraw(theme)` |
| `surface.ts` | The printed surface: paper/ink/halftone tiles, age, gore seams, and the sphere's bump + roughness + clearcoat |
| `globe.ts` | renderer, camera, lights, sphere, brass semi-meridian + finials + curved stem + wooden base |
| `controls.ts` | OrbitControls wrapper: zoom-scaled rotate speed, auto-rotate that yields to input/selection |
| `label-layout.ts` | where each country name is printed: position, size from the country's own width, `1/cos(lat)` pre-stretch, collisions |
| `highlight.ts` | 2048×1024 transparent canvas on a 1.002-radius sphere: the wash, plus an underline beneath the printed name |
| `picking.ts` | pointer → sphere UV → pick index; click = < 5 px & < 300 ms |
| `math.ts` | lat/lng ↔ sphere, projection, easing |

## Design decisions

- **Tilt without fighting OrbitControls.** The sphere never rotates; the camera orbits. `camera.up` is set to
  the 23.5°-tilted axis before OrbitControls is built, so dragging/auto-rotate spin around the *real* axis.
  The stand (`standRig`) is counter-rotated by the azimuth each frame so it stays put on screen, and the
  camera is rolled so the base always reads as upright. The orbit target sits on the axis just below the
  globe centre so the default framing has room for the base.
- **Picking is pixel-exact, not geometric.** A 4096×2048 index (`Uint16Array`, 16 MB) is decoded from a
  flat-colour canvas; the blue channel is a checksum so anti-aliased border blends fail the lookup and fall
  back to a 3×3 neighbourhood vote instead of decoding as a wrong country. Stand meshes are never raycast.
- **The names are printed on the paper, not floated in front of it.** They are rasterised into the map
  texture (`label-layout.ts` decides where, `texture.ts` draws them), so they curve over the surface, turn
  with it, go upside down when you spin past them, foreshorten into the limb, and never move relative to
  their country. Nothing about them is recomputed per frame — the whole label system left the render loop.
  Three consequences, all of them the point:
  - **The `cos(lat)` pre-stretch is the load-bearing bit.** The sphere squeezes the raster horizontally by
    `cos(lat)`, so type of uniform width looks progressively narrower towards the poles. Each name is drawn
    under `scale(1 / cos(lat), 1)` — clamped at 3, i.e. 70.5° — which cancels it exactly, the same trick a
    real globe's printed gores play mechanically. Verified on the sphere: the rendered aspect matches the
    aspect the glyphs were set at to within 1.5% up to 60°, and −14% at Greenland where the clamp bites.
  - **Size comes from the country, not from a zoom tier.** The starting rung of a nine-step ladder (96 → 21
    reference texels, ~26 → 6 screen px in the default pose) is the largest whose *set* width is within 0.75
    of the country's own width in texture space; the area tier only clamps that from both ends. Measured
    over the 123 countries above 60 000 km² the median name fills 0.79 of its country. Small countries still
    overflow — that is what the halo is for — but deliberately, not by default.
  - **Zoom tiers are gone.** A name is printed at one size forever and small countries are unreadable until
    you lean in. That is how a globe behaves.
- **A printed name is still a pick target.** Each placed name's box is stamped into the ID map **only where
  a pixel is still unassigned**, so a label can take ocean but can never steal a pixel from a real polygon.
  That adds ~2% of the index as new, aimable area and finally gives countries with no polygon at this
  resolution (Tuvalu, Monaco…) something to click. It also means a name shoved onto a neighbour would not be
  clickable there, which is why the layout consults the finished pick index and prefers, in order, a slot
  standing on its own country, then one over open water, then anywhere — going a size or two smaller before
  it accepts a worse position. 203 of 208 printed names pick their own country at their exact middle.
- **Render on demand.** One rAF loop; `renderer.render` runs only when the camera moved, a flight/auto-rotate
  is active, or hover/selection changed. The loop stops while the tab is hidden.
- **Theming is a repaint, never a rebuild.** Every colour comes from `core/themes.ts`'s `GlobeTheme`; the
  globe owns none of them. A switch runs in two phases so the click feels instant: *synchronously* it
  recolours the brass/wood materials and all three lights in place, calls
  `highlight.restyle()` and tints the sphere; then, debounced onto an idle slot, `textures.redraw(theme)`
  repaints the 8k map **into the same canvas** and flags `mapTexture.needsUpdate`. The adjacency colouring
  (`neighbors()` over ~250 geometries), the arc mesh, the label layout and the pick index are computed once
  and never again — every theme's palette is 8 long, so each country keeps its colour *slot*, and the names
  are baked, so a switch just re-inks the same words in the same places.
  Nothing in a switch touches the camera, so an in-flight `flyTo` is undisturbed.
- **Textures.** 8192×4096 sRGB canvas texture with max anisotropy. Renderer has `alpha: true` so the page
  background shows.
- **The surface is what stops it looking like vector art.** A flat roughness with no bump map returns light
  perfectly evenly, which reads as plastic, and flat fills with one uniform stroke read as a drawing. So
  `surface.ts` gives every theme, from `GlobeTheme.surface`'s eight 0..1 knobs: low-frequency ink density
  over the whole raster, paper fibre, a seamless offset halftone rosette, clustered foxing and pole wear,
  gore seams every 30° with a real sub-pixel slip, and a `MeshPhysicalMaterial` with a fibre bump map, a
  patchy roughness map and a clearcoat. Borders are stroked three times at sub-pixel offsets rather than
  once, which buys hand-drawn irregularity, plate misregistration and ink pooling at junctions at the same
  time. Everything random is seeded (`mulberry32`, keyed off constants or the ISO3), so a re-raster is
  bit-identical and a theme switch never shimmers.
- **What the surface costs, and why it is shaped the way it is.** Measured at 8k under software raster:
  a plain `fillRect` is 14 ms, a 1:1 pattern fill 185 ms, and a pattern fill with *any* `setTransform`
  scale 415-464 ms. So the ink mottle and the paper cannot be separate passes and the mottle cannot be a
  scaled tile — both live in one 2048² tile applied at 1:1 (2048 divides 8192 and 4096 exactly, so the
  antimeridian has no seam). Likewise `drawImage` from a canvas onto itself snapshots the whole surface,
  so the twelve gore seams are one clipped whole-canvas shift (~104 ms), not twelve strip copies (892 ms).
  Stroke cost is proportional to total stroked width, so the three border passes sum to 1.95× the old
  single pass, not 2.9×. Full redraw: **872 ms at 8k, 174 ms at 4k** (was 454 / 216).
- **Tiles are built once, at module level, and are independent of the theme** where they can be; the
  handful that depend on knob values are memoised by those values, so at most one exists per theme and a
  switch only ever looks one up. No per-pixel JS ever runs over the 33 M pixels of an 8k raster.
