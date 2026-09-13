/**
 * Globalpedia globe module — public entry point.
 *
 *   const handle = createGlobe(container, worldTopology, countries, bus, { autoRotate: true });
 *
 * Talks to the rest of the app only through the EventBus:
 *   emits   globe:hover { iso3 | null }, globe:select { iso3 }
 *   listens ui:flyTo { iso3 } → flyTo + highlight; ui:close → clear highlight, resume auto-rotate later
 */
import { Quaternion, Vector3 } from 'three';
import type { Topology } from 'topojson-specification';
import type { EventBus } from '../core/events';
import { DEFAULT_THEME, themeById, type GlobeTheme, type ThemeId } from '../core/themes';
import type { CountryRecord } from '../core/types';
import { createControls } from './controls';
import {
  createGlobeScene,
  DEFAULT_DISTANCE,
  FACING_POINT,
  fitDistance,
  spinForLongitude,
  VIEW_DIR,
  VIEW_TARGET,
} from './globe';
import { createHighlightLayer } from './highlight';
import { createLife } from './life';
import { clamp, easeInOutCubic, latLngToVector3 } from './math';
import { createPicking } from './picking';
import { applySurfaceMaterial } from './surface';
import { buildGlobeTextures } from './texture';

export interface GlobeOptions {
  /** Slowly spin when idle (default true; always off under prefers-reduced-motion). */
  autoRotate?: boolean;
  /** Country to face on first paint. */
  initialIso3?: string;
  /** Force the map raster width. Default: 8192 when the GPU allows it and the pointer is fine, else 4096. */
  textureSize?: 8192 | 4096;
  /** Theme to paint on first build (default `DEFAULT_THEME`). Later switches arrive on `ui:theme`. */
  theme?: ThemeId;
}

export interface GlobeHandle {
  /** Turn the globe so `iso3` faces the viewer (eased, ~900 ms). Resolves when the flight ends. */
  flyTo(iso3: string, opts?: { duration?: number }): Promise<void>;
  /** Highlight a country (or clear with null). */
  setSelected(iso3: string | null): void;
  setAutoRotate(on: boolean): void;
  /** Re-fit to the container. Called automatically via ResizeObserver; exposed for manual layouts. */
  resize(): void;
  /**
   * Raise the point a `flyTo` centres a country on by `fraction` of the globe canvas's height,
   * so a bottom sheet does not cover the country that was just brought round. Pass 0 to clear
   * it. It is an off-centre projection, so the globe *and its cradle* rise together and the
   * stand stays planted and upright; nothing about the camera's pose, the pick ray or the
   * flight maths changes.
   *
   * It is taken literally and not clamped to keep the globe on screen, because only the caller
   * knows what is covering it. How far it can usefully go is (the gap between the canvas top
   * and the globe's own top edge) ÷ the canvas height: at 390×844 with the current chrome the
   * globe is 309 px across with 166 px of headroom in a 689 px canvas, so ~0.24 puts its top on
   * the canvas edge and ~0.18 centres it in the band a 62%-tall bottom sheet leaves. Hard limit
   * ±0.5.
   */
  setViewOffset(fraction: number): void;
  dispose(): void;
}

/**
 * How long a theme click must settle before the expensive re-raster runs. Long enough
 * that clicking down a six-item picker rasterises once, short enough to feel immediate.
 */
const THEME_SETTLE_MS = 120;

/** Countries smaller than this (km²) get a closer camera on flyTo. */
const SMALL_COUNTRY_AREA = 50_000;
/** In reference units, like every other distance here — scaled by the framing when used. */
const SMALL_COUNTRY_DISTANCE = 2.1;

/**
 * Pacing the redraw.
 *
 * The render loop already sleeps when nothing moves. The case it had no answer for is the one
 * the creatures create: something is moving, all the time, and it is ant-sized. Redrawing the
 * whole scene sixty times a second so a schooner can cross four pixels an hour is the largest
 * avoidable cost on a phone, and `life.update` itself is only ~0.6 ms of it — the cost is the
 * draw. So a frame in which *only* the creature layer moved is paced, and everything the
 * viewer does — drag, pinch, wheel, flight, hover, theme — is exempt and redraws at once.
 */
const ANIM_FPS_FINE = 30;
const ANIM_FPS_COARSE = 22;
/**
 * How long after the last animated frame the full pixel ratio comes back. Long enough that the
 * end of a flick or the last creature step does not flip resolution twice; short enough that
 * the picture anyone stops to study has sharpened before they have focused on it. The change
 * is a resolution pop, so it wants to happen while the eye is still settling, not later.
 */
const RESTORE_FULL_RES_MS = 200;

interface Flight {
  start: number;
  duration: number;
  /** The globe's rotation at the start of the flight, and where it must end up. */
  from: Quaternion;
  to: Quaternion;
  fromDist: number;
  toDist: number;
  resolve(): void;
}

export function createGlobe(
  container: HTMLElement,
  world: Topology,
  countries: Record<string, CountryRecord>,
  bus: EventBus,
  opts: GlobeOptions = {},
): GlobeHandle {
  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  // --- textures + scene -----------------------------------------------------------------------
  let theme: GlobeTheme = themeById(opts.theme ?? DEFAULT_THEME).globe;
  let textures: ReturnType<typeof buildGlobeTextures> | null = null;
  const gs = createGlobeScene(
    container,
    (maxTextureSize) => {
      const mapWidth = opts.textureSize ?? (maxTextureSize >= 8192 && !coarsePointer ? 8192 : 4096);
      textures = buildGlobeTextures(world, countries, {
        mapWidth,
        idWidth: Math.min(4096, maxTextureSize),
        theme,
      });
      return textures.map;
    },
    theme,
  );
  if (!textures) throw new Error('globe textures were not built');
  const tex = textures as ReturnType<typeof buildGlobeTextures>;
  const { renderer, scene, camera, globeSpin, sphere } = gs;

  // Both ride inside the spinning group, so they turn with the map rather than sliding over it.
  const highlight = createHighlightLayer(tex, theme);
  globeSpin.add(highlight.mesh);

  // Ships and animals, ant-scale, absent until the camera comes close.
  const life = createLife(tex.idMap, theme);
  globeSpin.add(life.group);

  const ctl = createControls({
    camera,
    dom: renderer.domElement,
    spin: globeSpin,
    target: VIEW_TARGET,
    viewDir: VIEW_DIR,
    autoRotate: opts.autoRotate ?? true,
  });
  scene.updateMatrixWorld(true);

  // --- state ----------------------------------------------------------------------------------
  let needsRender = true;
  let selected: string | null = null;
  let flight: Flight | null = null;
  let rafId = 0;
  let lastTime = performance.now();
  let disposed = false;

  const picking = createPicking({
    dom: renderer.domElement,
    camera,
    sphere,
    idMap: tex.idMap,
    onHover(iso3) {
      highlight.set(iso3, selected);
      needsRender = true;
      bus.emit('globe:hover', { iso3 });
    },
    onSelect(iso3) {
      setSelected(iso3);
      bus.emit('globe:select', { iso3 });
    },
  });

  function setSelected(iso3: string | null): void {
    selected = iso3;
    highlight.set(picking.hovered, iso3);
    ctl.setSelected(iso3 !== null);
    needsRender = true;
  }

  // --- flyTo ----------------------------------------------------------------------------------
  // The camera is nailed down, so a flight is a rotation of the globe: slerp its quaternion
  // until the country lands on FACING_POINT, the spot dead centre of the fixed view.
  const tmpV = new Vector3();
  const tmpQ = new Quaternion();
  const globeAxis = new Vector3();
  const axisFlat = new Vector3();
  const upFlat = new Vector3();
  const crossTmp = new Vector3();
  /** The cradle's own axis, in the tilt frame: its local +Y, which is where the pins point. */
  const CRADLE_AXIS = new Vector3(0, 1, 0);

  /**
   * Land the globe level. Putting a country dead centre leaves one degree of freedom — a twist
   * about the view axis — and the shortest rotation spends it on whatever roll the user happened
   * to leave behind, which is how you arrive at Australia lying on its side. So spend it instead
   * on bringing the globe's own axis back as close to the cradle's as the framing allows — poles
   * back in the pins, which is exactly where the orbiting camera always used to leave them.
   * Twisting about FACING_POINT keeps the country dead centre while it happens.
   */
  function levelUp(q: Quaternion): void {
    globeAxis.set(0, 1, 0).applyQuaternion(q);
    axisFlat.copy(globeAxis).addScaledVector(FACING_POINT, -globeAxis.dot(FACING_POINT));
    upFlat.copy(CRADLE_AXIS).addScaledVector(FACING_POINT, -CRADLE_AXIS.dot(FACING_POINT));
    // A pole dead centre: the axis points at the viewer and there is no "up" to align.
    if (axisFlat.lengthSq() < 1e-6 || upFlat.lengthSq() < 1e-6) return;
    axisFlat.normalize();
    upFlat.normalize();
    const twist = Math.atan2(crossTmp.crossVectors(axisFlat, upFlat).dot(FACING_POINT), axisFlat.dot(upFlat));
    q.premultiply(tmpQ.setFromAxisAngle(FACING_POINT, twist));
  }
  function stepFlight(now: number): boolean {
    if (!flight) return false;
    const t = flight.duration > 0 ? clamp((now - flight.start) / flight.duration, 0, 1) : 1;
    const k = easeInOutCubic(t);
    globeSpin.quaternion.copy(flight.from).slerp(flight.to, k);
    ctl.setDistance(flight.fromDist + (flight.toDist - flight.fromDist) * k);
    if (t >= 1) {
      flight.resolve();
      flight = null;
    }
    return true;
  }

  function flyTo(iso3: string, o: { duration?: number } = {}): Promise<void> {
    const rec = countries[iso3];
    if (!rec || !Array.isArray(rec.latlng)) return Promise.resolve();
    if (flight) flight.resolve(); // supersede an in-progress flight
    ctl.flush();
    const [lat, lng] = rec.latlng;
    const from = globeSpin.quaternion.clone();
    // Where the country is now, in the tilt frame, and the shortest turn that puts it centre stage.
    latLngToVector3(lat, lng, 1, tmpV).applyQuaternion(from).normalize();
    const to = new Quaternion().setFromUnitVectors(tmpV, FACING_POINT).multiply(from);
    levelUp(to);
    const fromDist = ctl.distance;
    let toDist = fromDist;
    if ((rec.area ?? Infinity) < SMALL_COUNTRY_AREA) {
      toDist = Math.min(fromDist, SMALL_COUNTRY_DISTANCE * ctl.fitScale);
    }
    ctl.suspend();
    needsRender = true;
    return new Promise<void>((resolve) => {
      flight = {
        start: performance.now(),
        duration: reducedMotion ? 0 : (o.duration ?? 900),
        from,
        to,
        fromDist,
        toDist,
        resolve,
      };
    });
  }

  // --- theme switching ------------------------------------------------------------------------
  // Two phases, because a full 8192x4096 re-raster is a main-thread stall of tens of
  // milliseconds and the click must feel instant:
  //   1. synchronous — materials, lights and highlight (all cheap);
  //   2. deferred and debounced — the map raster, for the theme the viewer settled on.
  // Neither phase touches the camera, the pick index, the CanvasTexture object or any
  // material instance, so an in-flight flyTo and picking both carry on undisturbed.
  let settleTimer = 0;
  let cancelRaster: (() => void) | null = null;

  /** Phase 1: everything that is not the 8k raster. */
  function applyThemeChrome(t: GlobeTheme): void {
    gs.brassMat.color.set(t.brass);
    gs.woodMat.color.set(t.wood);
    gs.keyLight.color.set(t.keyLight.color);
    gs.keyLight.intensity = t.keyLight.intensity;
    gs.hemiLight.color.set(t.hemiLight.sky);
    gs.hemiLight.groundColor.set(t.hemiLight.ground);
    gs.hemiLight.intensity = t.hemiLight.intensity;
    gs.ambientLight.intensity = t.ambient;
    highlight.restyle(t);
    life.restyle(t);
    // The varnish, the fibre relief and the gloss are material state, not raster state, so
    // they change on the click rather than waiting for phase 2. This also sets the tint,
    // which carries the (still old) raster towards the new theme until it is repainted.
    applySurfaceMaterial(sphere.material, t);
    needsRender = true;
  }

  /** Phase 2: repaint the map canvas in place and flag the existing texture. */
  function rasterizeTheme(t: GlobeTheme): void {
    tex.redraw(t);
    gs.mapTexture.needsUpdate = true;
    if (t.sphereTint === 0xffffff) sphere.material.color.set(0xffffff);
    needsRender = true;
  }

  /** Run `fn` off the critical path: an idle slot if the browser offers one, else the next frame. */
  function afterPaint(fn: () => void): () => void {
    const ric = (window as Window & { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric.call(window, () => fn(), { timeout: 300 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = requestAnimationFrame(() => fn());
    return () => cancelAnimationFrame(id);
  }

  function setTheme(id: ThemeId): void {
    const next = themeById(id).globe;
    if (next === theme) return;
    theme = next;
    applyThemeChrome(next);
    // Debounce the raster: rapid clicks through the picker coalesce into one repaint
    // of whatever the viewer settled on.
    clearTimeout(settleTimer);
    cancelRaster?.();
    cancelRaster = null;
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      cancelRaster = afterPaint(() => {
        cancelRaster = null;
        if (!disposed) rasterizeTheme(theme);
      });
    }, THEME_SETTLE_MS);
  }

  // --- render loop ----------------------------------------------------------------------------
  const animIntervalMs = 1000 / (coarsePointer ? ANIM_FPS_COARSE : ANIM_FPS_FINE);
  /** The camera's position in the life layer's own frame, for its horizon test. */
  const eyeLocal = new Vector3();
  const spinWorld = new Quaternion();
  let lastRenderAt = 0;
  let lastAnimatedAt = 0;
  let lifeAnimating = false;
  let lowRes = false;
  /** Time the creatures have banked while their frames were being paced out. */
  let lifeDt = 0;

  function frame(now: number): void {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    let moved = stepFlight(now);
    if (ctl.update(dt)) moved = true;
    lifeDt += dt;

    // Creature-only frames are paced; anything the viewer caused is not. The test is made
    // before `life.update` runs, so a paced-out frame costs nothing at all — no stepping, no
    // matrix writes, no upload — and the time it banks is handed over on the frame that lands.
    if (!moved && !needsRender && lifeAnimating && now - lastRenderAt < animIntervalMs) return;

    // Life drives its own frames only while it is close enough to be seen; when it
    // returns false the loop goes back to sleep exactly as before.
    globeSpin.getWorldQuaternion(spinWorld);
    eyeLocal.copy(camera.position).applyQuaternion(spinWorld.invert());
    lifeAnimating = life.update(lifeDt, ctl.relativeDistance, eyeLocal);
    lifeDt = 0;
    if (lifeAnimating) moved = true;

    // Trade resolution for fill rate, but only while the creatures are actually running: the
    // globe at rest — including under the barely-perceptible idle spin — is always drawn at
    // full ratio, because that is the picture someone stops and studies. Keying it to the
    // creature layer rather than to "is anything moving" also means the drawing buffer is
    // reallocated once when the viewer leans in and once when they lean back out, instead of
    // twice per drag.
    if (lifeAnimating) lastAnimatedAt = now;
    if (lifeAnimating !== lowRes && (lifeAnimating || now - lastAnimatedAt >= RESTORE_FULL_RES_MS)) {
      lowRes = lifeAnimating;
      gs.setAnimating(lowRes);
      needsRender = true; // redraw once at the new ratio
    }
    if (!moved && !needsRender) return;

    // The sphere moves now, not the camera, so picking needs fresh world matrices before it
    // raycasts — and the camera is outside the scene graph, so it updates separately.
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    if (moved) picking.refresh();
    renderer.render(scene, camera);
    lastRenderAt = now;
    needsRender = false;
  }
  function start(): void {
    if (rafId || disposed) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stop(): void {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else {
      needsRender = true;
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  /**
   * Re-fit to the container: size the renderer, then re-derive the opening distance from the
   * new aspect. `setFitScale` decides for itself whether the camera is allowed to follow — it
   * is not, once the viewer has zoomed or dragged, or while a finger is still down.
   */
  function refit(): void {
    if (disposed) return; // the orientation re-check below can outlive the globe
    gs.resize();
    ctl.setFitScale(fitDistance(gs.aspect) / DEFAULT_DISTANCE);
    needsRender = true;
  }
  const observer = new ResizeObserver(refit);
  observer.observe(container);
  // A phone rotated in the hand resizes the container, so the observer covers it; iOS has been
  // known to fire the orientation change before the layout settles, so take the second look.
  const onOrientation = (): void => {
    refit();
    window.setTimeout(refit, 250);
  };
  window.addEventListener('orientationchange', onOrientation);

  // --- bus wiring -----------------------------------------------------------------------------
  const offs = [
    bus.on('ui:flyTo', ({ iso3 }) => {
      setSelected(iso3);
      void flyTo(iso3);
    }),
    bus.on('ui:close', () => setSelected(null)),
    bus.on('ui:theme', ({ id }) => setTheme(id)),
  ];

  // --- initial view ---------------------------------------------------------------------------
  // Frame before the first paint: on a portrait phone the opening distance is not the
  // reference one, and a flyTo below reads the distance it lands at from the controls.
  refit();
  if (opts.initialIso3 && countries[opts.initialIso3]) {
    void flyTo(opts.initialIso3, { duration: 0 });
  } else {
    // Classic catalogue pose: the Atlantic in the middle, Americas left, Europe/Africa right.
    // A pure spin about the globe's own axis, so at rest the poles sit in the cradle's pins
    // exactly as a real globe's do.
    globeSpin.rotation.y = spinForLongitude(-35);
  }
  if (!document.hidden) start();

  return {
    flyTo,
    setSelected,
    setAutoRotate: (on) => ctl.setAutoRotate(on),
    resize: refit,
    setViewOffset(fraction) {
      gs.setViewOffset(fraction);
      needsRender = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (flight) flight.resolve();
      flight = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('orientationchange', onOrientation);
      clearTimeout(settleTimer);
      cancelRaster?.();
      observer.disconnect();
      for (const off of offs) off();
      picking.dispose();
      ctl.dispose();
      highlight.dispose();
      life.dispose();
      gs.dispose();
    },
  };
}

export { createGlobe as default };
export type { CountryRecord } from '../core/types';
export type { EventBus } from '../core/events';
