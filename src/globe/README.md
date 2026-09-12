# `src/globe` — the school globe

```ts
import { createGlobe } from './globe';
const handle = createGlobe(container, worldTopology, countries, bus, { autoRotate: true });
```

`createGlobe(container, world, countries, bus, opts?) → GlobeHandle`

- `container` — must have an explicit size (the canvas fills it; a `ResizeObserver` follows it).
- `world` — parsed TopoJSON (`public/data/world-50m.json`): `geometry.id` is ISO3, `properties = { name, ccn3 }`.
  `objects.countries` is used (falls back to the first GeometryCollection).
- `countries` — `Record<ISO3, CountryRecord>`; label text = `name`, anchor = `latlng`, tier = `area`.
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
| `labels.ts` | one `Sprite` per country, serif text with cream halo, 3 area tiers revealed by zoom, limb fade |
| `highlight.ts` | 2048×1024 transparent canvas on a 1.002-radius sphere; redrawn only when hover/selection changes |
| `picking.ts` | pointer → label sprite raycast, else sphere UV → pick index; click = < 5 px & < 300 ms |
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
- **Labels are cheap.** Sprites with `sizeAttenuation: false`; the scale is derived from a target pixel
  height each frame, so text stays the same size when zooming. Hover/selected variants are extra textures
  created lazily. Countries with no polygon (Tuvalu…) still get a clickable label.
- **Render on demand.** One rAF loop; `renderer.render` runs only when the camera moved, a flight/auto-rotate
  is active, or hover/selection changed. The loop stops while the tab is hidden.
- **Theming is a repaint, never a rebuild.** Every colour comes from `core/themes.ts`'s `GlobeTheme`; the
  globe owns none of them. A switch runs in two phases so the click feels instant: *synchronously* it
  recolours the brass/wood materials and all three lights in place, calls `labels.restyle()` and
  `highlight.restyle()` and tints the sphere; then, debounced onto an idle slot, `textures.redraw(theme)`
  repaints the 8k map **into the same canvas** and flags `mapTexture.needsUpdate`. The adjacency colouring
  (`neighbors()` over ~250 geometries), the arc mesh and the pick index are computed once and never again —
  every theme's palette is exactly 8 long, so each country keeps its colour *slot* and only the hue changes.
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
