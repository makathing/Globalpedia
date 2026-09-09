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
  `opts.textureSize` (8192 | 4096; default 8192 when the GPU allows and the pointer is fine).

`GlobeHandle`: `flyTo(iso3, {duration?}) → Promise`, `setSelected(iso3|null)`, `setAutoRotate(on)`,
`resize()`, `dispose()`. The default export is `createGlobe`.

Bus contract: emits `globe:hover {iso3|null}` (on change) and `globe:select {iso3}` (tap, not drag);
listens to `ui:flyTo {iso3}` (fly + highlight) and `ui:close` (clear highlight, auto-rotate resumes after 6 s).

## Files

| file | role |
| --- | --- |
| `index.ts` | `createGlobe`: wires everything, render loop, `flyTo`, bus listeners, dispose |
| `texture.ts` | Canvas2D rasteriser: pastel fills (greedy adjacency colouring), grain, graticule, 1.5 px @8k outlines; ISO3 pick index |
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
- **Textures.** 8192×4096 sRGB canvas texture with max anisotropy; MeshStandardMaterial roughness 0.55,
  metalness 0.02 (varnished paper, not plastic). Renderer has `alpha: true` so the page background shows.
