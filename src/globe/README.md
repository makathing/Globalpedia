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
`resize()`, `setViewOffset(fraction)`, `dispose()`. The default export is `createGlobe`.

`setViewOffset(f)` raises what the camera centres on by `f` of the canvas height, for a bottom
sheet that would otherwise sit on the country `flyTo` just brought round. It is an off-centre
projection (`camera.setViewOffset`), so the globe *and its cradle* rise together, the stand stays
upright and planted, the pick ray follows, and nothing in the flight maths changes — `FACING_POINT`
is still the point on the view ray. `0` clears it.

It is taken literally rather than clamped to keep the globe on screen — only the caller knows what
is covering it. The usable maximum is the globe's headroom inside the canvas over the canvas
height: at 390×844 with the current chrome the globe is 309 px across with 166 px of headroom in a
689 px canvas, so ~0.24 puts its top edge on the canvas edge and **~0.18 centres it in the band a
62%-tall sheet leaves**. Verified: with the offset applied and `flyTo('BRA')` flown, a tap at 25%
of the viewport height — inside that band — picks Brazil. Hard limit ±0.5.

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
| `highlight.ts` | transparent canvas at half the map's width on a 1.002-radius sphere: the wash, plus an underline beneath the printed name |
| `picking.ts` | pointer → sphere UV → pick index; tap thresholds are per pointer type |
| `id-map.ts` | the pick index itself: `lookupCountryId` (polygons) and `lookupId` (label ink first, then the 3×3 vote) |
| `life.ts` | ~950 ships and animals in one InstancedMesh: placement against the id map, the wander, the horizon skip and the dirty-range upload |
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
- **The framing fits the smaller axis, and the distance is derived rather than chosen.** Only
  `camera.aspect` used to react to the viewport, and aspect widens the *horizontal* field while
  leaving the vertical one alone. A 38° vertical FOV at a fixed 3.9 therefore always framed the
  globe to 79% of the **height** — right on a desk, and on a 390×844 phone it put the globe at
  **1.42× the viewport width**, both limbs off the screen, the north finial and the polar cap
  jammed into the top edge (which is what the stray "rings" at the top of the globe were).
  `fitDistance(aspect)` now solves for the distance at which the globe fills the same fraction of
  the **tighter** half-field. The fraction is not a second magic number: `FRAMING_FILL` is read
  back out of the pose the globe has always opened in, so at aspect ≥ 1 `fitDistance` returns 3.9
  to the last bit and a desktop is framed exactly as before, while a portrait phone simply pulls
  back. Measured diameter ÷ the stage's short side: **0.793-0.794 at 390×844, 414×896, 360×780,
  844×390 and 1440×900** — where before it was 0.79 of the *height* everywhere and 1.39-1.43 of
  the width on a phone.
  - **The zoom range travels with it.** `MIN_DISTANCE`/`MAX_DISTANCE` are quoted against
    `DEFAULT_DISTANCE` and stretched by the same `fitScale`, so the range is the same range in
    *apparent size* on every screen: hard in still shows the same patch of the planet across the
    short side, hard out is still the same 15% step back. Everything else keyed to apparent size
    travels too — the small-country flyTo distance, and the life layer's discovery ramp, which is
    fed `ctl.relativeDistance` rather than the raw one.
  - **A resize re-frames; a viewer's zoom is never overruled.** `setFitScale` only moves the
    camera while the viewer has not zoomed or dragged (more than 8 px of travel) and is still
    sitting at the default — otherwise the limits move around them and the camera stays put. So
    an address-bar nudge, a rotation or a panel opening re-fits an untouched globe and cannot
    yank one out from under a gesture. `resize()` itself does nothing at all when neither the box
    nor the pixel ratio changed, which matters because a `dvh` container fires the ResizeObserver
    on every toolbar movement and every `setSize` reallocates the drawing buffer.

- **The far hemisphere is not simulated.** The sphere is opaque and drawn first, so the depth test
  was already discarding everything behind the limb — after this module had stepped it and
  rewritten its matrix. `update` now takes the eye in its own frame and skips anything below the
  horizon, which is a tangency test, not a hemisphere test: tangents from an eye at distance D
  touch the sphere at `p·v = R²/D`, and a creature at `LIFE_RADIUS` meets that cone a little
  earlier still. At the distances creatures are visible at that is 60-78% of them, not half.
  Measured at 4096 index columns: **0.82 ms → 0.31 ms** per `update`, 351 of 951 creatures
  stepped, and a full geography audit of the instance matrices afterwards still finds 0 ships or
  sea life ashore and 0 land animals at sea. The one liberty: a creature below the horizon is
  frozen rather than stepped, so where it reappears depends a little on where the viewer has been
  looking. Nothing anyone can see, and it only applies at all once the viewer has leaned in.

- **Only the instances that moved are uploaded.** `writeMatrix` reports each index it writes;
  consecutive indices collapse into runs, and the runs are coalesced down to at most four
  `updateRanges` by closing the smallest gaps first. That only pays if the creatures facing the
  viewer are *near each other in the buffer*, so the cast is sorted by longitude at build time —
  the visible cap is a band of longitudes for any pose that has not been rolled onto a pole.
  Measured: 351 creatures written, **449 of 951 instances uploaded** (28 kB instead of 59 kB).
  One catch worth knowing: an attribute is only uploaded when the object carrying it is drawn, so
  the first frame after the layer becomes visible again sends the whole buffer rather than a
  range that would silently never arrive.

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
- **Render on demand, and pace what is left.** One rAF loop; `renderer.render` runs only when the
  camera moved, a flight/auto-rotate is active, or hover/selection changed. The loop stops while
  the tab is hidden. What that had no answer for is the creature layer: once the viewer leans in,
  *something* is moving all the time, and it is ant-sized. So a frame in which **only** the
  creatures moved is capped at 30 fps (22 on a coarse pointer) and is drawn at half the device
  pixel ratio — never below 1 — with the full ratio restored 200 ms after the creatures stop.
  The **idle drift** is capped by the same rule. It turns the globe at 2.1°/s, about a fifth of a
  pixel a frame at the limb, and `controls.update` returns true for it on every frame, so an
  untouched globe on a desk was redrawing the whole scene sixty times a second to move nothing
  anyone can see. Measured on an untouched page: before, **28.0 redraws a second against 28.0 loop
  ticks — every single tick**; after, with the renderer made cheap enough that the cap can
  actually bite, **43.7 ticks a second and 18.2 redraws**, 58% of the drift's frames dropped.
  `ctl.idleSpinOnly` goes false the instant a finger is down, an inertia throw is still running, a
  flight is in the air or the camera dollies, so none of those are ever paced.
  The flag has to track the viewer's share of the pending rotation *separately* and decay it by
  the same factor, rather than wait for `pendingSpin` to fall under `EPS`: while the globe drifts,
  `AUTO_ROTATE · dt` is topped up every frame and the damping holds `pendingSpin` at about 0.007
  rad, twice `EPS`, so a flag cleared that way would latch on at the viewer's first drag and the
  drift would silently stop being paced for the rest of the session.
  Measured: `life.update` is only ~0.6-0.8 ms of such a frame; the cost is the draw, and at DPR 2
  the resolution drop takes three quarters of the fragments out of it.
  Two rules keep that from being felt. The pacing test is made **before** `life.update` runs and
  is skipped entirely the moment anything else moves, so a paced-out frame costs nothing at all
  and any drag, pinch, wheel, flight, hover or theme change redraws on the very next rAF.
  And the resolution is keyed to the creatures alone, not to "is anything moving": the globe at
  rest — including under the barely-perceptible idle spin — is always at full ratio, because that
  is the picture someone stops and studies, and the drawing buffer is then reallocated once when
  the viewer leans in and once when they lean back out rather than twice per drag.
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
- **A finger is not a mouse, and the tap thresholds now say so.** 5 px / 300 ms is exactly right
  for a mouse: past that the user was dragging. It is wrong for a finger by roughly a factor of
  three. Both platforms put touch slop at 8-10 px before they will even call a gesture a scroll, a
  fingertip covers 40-plus pixels of glass so its reported centre wanders as the pad flattens and
  lifts, and a child aiming at a country the size of a fingernail *presses deliberately* — well
  past 300 ms. Held to the mouse's numbers, the headline interaction of the whole app did nothing
  on a phone about half the time, with no feedback to say why. It is now 16 px / 900 ms for touch,
  8 px / 500 ms for a pen, and unchanged for a mouse. A second finger cancels the tap outright, so
  a pinch is never a selection, and so does `pointercancel`.

- **Nothing on the hot paths allocates.** Two things were quietly making garbage where it hurt
  most:
  - **The land/water oracle.** Every point over water has `index[p] === 0`, so it falls past the
    direct hit and into the 3×3 vote — and the vote built a `Map` per call. The life layer asks
    about water constantly (`steer` probes twice per ship, `stepWanderer` tries up to seven
    headings): ~1,400 lookups a frame, ~1,300 of them at sea, which is some 78,000 short-lived
    Maps a second on a phone to answer "no". The vote is now nine reads into one module-level
    `Int32Array` and a fixed tally, with the all-zero case returning on the spot. Ties still fall
    the same way — first in scan order, `>` not `>=` — and a differential run against the old
    implementation agrees on 34,056 lookups over 400 random rasters. Measured over 200,000 mixed
    lookups (69% at sea): **299 ns → 233 ns** a call, −22%. The timing is the smaller half of it;
    the point is that the call now allocates nothing at all, and a desktop V8 with a roomy
    nursery is the machine least likely to show what 78,000 dead Maps a second cost a phone.
  - **The index decode.** Both pick indices were decoded by looking each pixel's packed RGB up in
    a `Map`: 8.4 million iterations at 4096 across with a hash probe on each of the ~2.5 million
    that are not sea. But `encodeId` is invertible — red and green *are* the index's two bytes —
    so `decodeId` recovers it by arithmetic and the blue checksum still rejects anti-aliased
    blends exactly as before; callers bound the result to the ids they painted, which is all the
    Map's membership was for. The label boxes also stopped collecting every candidate pixel into
    a multi-million-entry array for a second pass: that two-phase write existed only while boxes
    went into `index` itself, and `isClearOfPolygons` reads `index`, which the stamp never
    writes. Measured: a whole `buildGlobeTextures` at 4096 went 1093 ms → 1052 ms, which is the
    honest size of it. Varying each dimension alone puts index work at **39%** of the build and
    the map raster at **36%**, so the decode loops are real but are the smaller part of the
    smaller half — what costs is rasterising the two index canvases and the two 33 MB
    `getImageData` copies they need. Cutting boot properly means either yielding between the
    phases (which makes `createGlobe` async, and so is a decision for its caller) or a smaller
    index on a coarse pointer — and that one trades away picking accuracy and the resolution of
    the life layer's land/water oracle, so it is not a decision to take on performance grounds
    alone.

- **Textures.** 8192×4096 sRGB canvas texture with max anisotropy. Renderer has `alpha: true` so the page
  background shows. **Every large allocation is now derived from the GPU's `maxTextureSize` and the
  pointer**, which the highlight layer alone was not: it was a flat 4096×2048 regardless, so a
  phone — which takes a 4096 map precisely because it cannot afford an 8192 one — still paid 33 MB
  of canvas and some 45 MB on the GPU for a layer that is invisible until something is hovered.
  It is half the map's linear resolution now (a quarter of its area, which is what this file's
  notes always assumed and what the doubled underline is drawn to survive), clamped to
  `maxTextureSize`: a desktop keeps exactly what it had, a phone gets three quarters of it back.
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
