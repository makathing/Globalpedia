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

`GlobeHandle`: `flyTo(iso3, {duration?}) → Promise` (turns the *globe*, not the camera), `setSelected(iso3|null)`, `setAutoRotate(on)`,
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
| `controls.ts` | drag → globe rotation (two axes, unclamped), wheel/pinch → dolly, zoom-scaled rotate speed, auto-rotate that yields to input/selection |
| `label-layout.ts` | where each country name is printed: position, size from the country's own width, `1/cos(lat)` pre-stretch, collisions, leader lines |
| `highlight.ts` | 2048×1024 transparent canvas on a 1.002-radius sphere: the wash, plus an underline beneath the printed name |
| `picking.ts` | pointer → sphere UV → pick index; click = < 5 px & < 300 ms |
| `math.ts` | lat/lng ↔ sphere, projection, easing |

## Design decisions

- **The cradle is furniture: the globe turns, nothing else does.** The ring, pins, stem, base and key
  light are bolted to the world and never move; the camera is bolted down too, with one degree of freedom
  left — sliding along a fixed view ray to zoom. Everything the user does turns `globeSpin`, the group
  holding the sphere, the highlight and the life layer, inside a `rig` that supplies the 23.5° tilt and is
  then never touched again. Horizontal drag spins it about its own tilted axis; vertical drag rolls it
  about the perpendicular to that axis and the line of sight, so the drag walks the facing point along
  a meridian and straight over the poles. Neither is clamped, so every point of the planet can be
  brought to face the viewer, and past a pole the map simply carries on and comes up inverted.
  The camera's right vector would have been the obvious axis for the vertical drag and is the wrong
  one: it sits 67.2° from the tilted axis rather than 90°, so rolling about it walks a *small* circle
  that measured out at exactly 62.8°N — a user dragging straight up stalls 27° short of the pole, and
  the diagonal drag that would get them there is not discoverable. This replaced an inversion of the same thing — the camera orbited, `standRig`
  was counter-rotated by the azimuth each frame and the camera was rolled to keep the base upright. That
  fake only ever compensated azimuth: change elevation and the whole cradle swung up and down the screen.
  Both the counter-rotation and the roll are gone, and so is OrbitControls; the feel (damping, inertia,
  zoom-scaled drag, wheel step, auto-rotate speed) is carried over to the number.
  The view target sits on the axis just below the globe centre so the framing has room for the base, and
  the fixed viewpoint sits in the stand's own meridian plane 31.8° above the equator — the pose the
  orbiting camera used to open in, so the globe at rest looks exactly as it did.
  `flyTo` spends its one free degree of freedom — a twist about the view axis, which leaves the
  country dead centre — on returning the globe's axis to the cradle's lean, rather than carrying
  whatever roll the user left behind into the flight and landing Australia on its side.
  One accepted liberty: the pins belong to the cradle, so after a roll they no longer point at the
  geographic poles. A sphere turning inside a thin ring reads naturally; chasing the poles with the
  cradle would put the furniture back in motion.
- **Picking is pixel-exact, not geometric.** A 4096×2048 index (`Uint16Array`, 16 MB) is decoded from a
  flat-colour canvas; the blue channel is a checksum so anti-aliased border blends fail the lookup and fall
  back to a 3×3 neighbourhood vote instead of decoding as a wrong country. Stand meshes are never raycast.
  A second index of the same shape (`IdMap.labelInk`) holds the printed names' **glyphs**, and `lookupId`
  reads it first — see below.
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
    over the countries above 60 000 km² the median name fills 0.79 of its country. Small countries still
    overflow — that is what the halo is for — but deliberately, not by default. Placement probes the
    name's **ends** as well as its middle, because a name is not clear of its neighbours until all of it
    is: with only a middle probe, "Spain" was accepted at a width whose first letter sat on Portugal.
  - **Zoom tiers are gone.** A name is printed at one size forever and small countries are unreadable until
    you lean in. That is how a globe behaves.
- **A printed name is a pick target, at two resolutions.** The two layers do different jobs and the split
  is the whole trick:
  - **The box, coarse, deferential.** Each name's bounding box is stamped into the country index *only
    where a pixel is still unassigned*, so a label can take ocean but can never take a pixel from a real
    polygon. A box is a blunt instrument — letting "Russia"'s box outrank Mongolia would be far worse than
    the problem it solves — so it never outranks anything. It adds a slice of open water to the index as
    aimable area and gives countries with no polygon at this resolution (Tuvalu, Nauru…) their first
    clickable target.
  - **The box takes open water, not coastline.** A stamped pixel must be unassigned *and* have no
    assigned neighbour. Anti-aliased coast and border pixels decode as 0 but are not sea — `lookupId`
    resolves them with its 3×3 vote — and a box that swallows them takes the vote away. That is how
    Marseille came to select Monaco: one coastal pixel France's polygon did not quite cover.
  - **The ink, fine, and it outranks.** The glyphs themselves, dilated to the halo's width, go into a
    separate index that `lookupId` consults *first*. Clicking the letters of "Belgium" can only mean
    Belgium, even where those letters overhang France and the pixel is France's; one pixel off the
    letterforms, nothing has changed. It costs a second 16 MB `Uint16Array`. Before it existed, Laos,
    Togo, Belgium, Kuwait and Eswatini each selected a neighbour when clicked at the middle of their own
    name. A full pixel-by-pixel diff against an index built with no labels at all confirms the polygons
    lose nothing to either layer.
  - **Except a name that had to be moved.** A name standing on its own country may overhang a neighbour
    and still win the click. A name set *clear* of its country is a different case: it carries a leader
    line and a dot saying where it belongs, and it has landed on ground that is visibly someone else's.
    Letting that ink outrank the polygon made **Paris select Switzerland**. So a displaced name claims
    open water and its own land and nothing else — and the dot at the end of its leader is stamped as a
    small target of its own, which is what keeps Liechtenstein and San Marino reachable at all. Cost of
    the exception: the middle of 3 of 238 names (Switzerland, Liechtenstein, French Guiana) picks the
    country underneath instead.
  - **What that buys.** Every one of 20 capital-and-major-city test points — Paris, Lyon, Bordeaux,
    Strasbourg, Berlin, Madrid, Lisbon, Rome, Bern, Brussels, Vienna and the rest — picks its own
    country, and every sovereign state is reachable by pointer somewhere. Six tiny territories (Isle of
    Man, Guernsey, Macau, Saint Martin, Saint Barthélemy, Caribbean Netherlands) are not: they hold no
    pixel of their own at this index resolution and no room for a name.
- **Every sovereign state gets a name, with a leader line when it will not fit.** Placement sweeps the size
  ladder up to three times at decreasing fussiness about what the name is standing on (its own country →
  open water → anywhere), and for the 195 sovereign states there is a fourth resort: set the name clear of
  the territory and run a fine hairline back to a dot on it, exactly as a printed atlas does for The Gambia
  and San Marino. That search is ordered *rings outside, sizes inside* — near beats large — and its radius
  is tied to the country's own size, not a flat number.
  **Shrinking beats moving**, though, and that is the important half. The ladder runs down to 14 reference
  texels precisely so the narrow states of central Europe can be lettered where they belong: Switzerland's
  landmass is 4.5° wide and its name is eleven letters, and at any larger size the layout had to relocate
  it — six degrees west, over the middle of France. 13 of 238 names now need a leader; all 195 sovereign
  states carry one. Territories are still allowed to drop, as they do on a real globe.
- **Render on demand.** One rAF loop; `renderer.render` runs only when the camera moved, a flight/auto-rotate
  is active, or hover/selection changed. The loop stops while the tab is hidden.
- **The hover test is throttled, but the last move is never dropped.** The pointer's final position is the
  one that matters and it is exactly the one most likely to be discarded: a quick flick off the globe
  delivers a burst of moves, the last of which lands inside the 33 ms window. The hover then stayed on a
  country the cursor had long left — with the tooltip still showing — because `pointerleave` only covers
  leaving the *canvas*, and the canvas is far bigger than the globe. A throttled move now schedules a
  trailing test at the end of the window instead.
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
