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
import type { CountryRecord } from '../core/types';
import { createControls, MAX_DISTANCE, MIN_DISTANCE } from './controls';
import { createGlobeScene, DEFAULT_DISTANCE, ORBIT_TARGET, STAND_UP } from './globe';
import { createHighlightLayer } from './highlight';
import { createLabels } from './labels';
import { clamp, easeInOutCubic, latLngToVector3 } from './math';
import { createPicking } from './picking';
import { buildGlobeTextures } from './texture';

export interface GlobeOptions {
  /** Slowly spin when idle (default true; always off under prefers-reduced-motion). */
  autoRotate?: boolean;
  /** Country to face on first paint. */
  initialIso3?: string;
  /** Force the map raster width. Default: 8192 when the GPU allows it and the pointer is fine, else 4096. */
  textureSize?: 8192 | 4096;
}

export interface GlobeHandle {
  /** Rotate the camera so `iso3` faces the viewer (eased, ~900 ms). Resolves when the flight ends. */
  flyTo(iso3: string, opts?: { duration?: number }): Promise<void>;
  /** Highlight a country (or clear with null). */
  setSelected(iso3: string | null): void;
  setAutoRotate(on: boolean): void;
  /** Re-fit to the container. Called automatically via ResizeObserver; exposed for manual layouts. */
  resize(): void;
  dispose(): void;
}

/** Countries smaller than this (km²) get a closer camera on flyTo. */
const SMALL_COUNTRY_AREA = 50_000;
const SMALL_COUNTRY_DISTANCE = 2.1;

interface Flight {
  start: number;
  duration: number;
  fromDir: Vector3;
  rotation: Quaternion;
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
  let textures: ReturnType<typeof buildGlobeTextures> | null = null;
  const gs = createGlobeScene(container, (maxTextureSize) => {
    const mapWidth = opts.textureSize ?? (maxTextureSize >= 8192 && !coarsePointer ? 8192 : 4096);
    textures = buildGlobeTextures(world, countries, { mapWidth, idWidth: Math.min(4096, maxTextureSize) });
    return textures.map;
  });
  if (!textures) throw new Error('globe textures were not built');
  const tex = textures as ReturnType<typeof buildGlobeTextures>;
  const { renderer, scene, camera, rig, standRig, sphere } = gs;

  const highlight = createHighlightLayer(tex);
  rig.add(highlight.mesh);

  const labels = createLabels(countries);
  rig.add(labels.group);

  const ctl = createControls(camera, renderer.domElement, opts.autoRotate ?? true);
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
    labels,
    idMap: tex.idMap,
    onHover(iso3) {
      labels.setHover(iso3);
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
    labels.setSelected(iso3);
    highlight.set(picking.hovered, iso3);
    ctl.setSelected(iso3 !== null);
    needsRender = true;
  }

  // --- camera orientation ---------------------------------------------------------------------
  const camUp = new Vector3();
  const camBack = new Vector3();
  const standUpWorld = new Vector3();
  const tmpQ = new Quaternion();
  const tmpV = new Vector3();

  /**
   * Keep the stand fixed relative to the viewer and the base upright on screen.
   * The stand is counter-rotated about the axis by the camera's azimuth; then the camera is rolled
   * about its view axis by the signed angle between its up vector and the base's up vector.
   */
  function orient(): void {
    standRig.rotation.y = ctl.controls.getAzimuthalAngle();
    tmpQ.copy(rig.quaternion).multiply(standRig.quaternion);
    standUpWorld.copy(STAND_UP).applyQuaternion(tmpQ);

    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camBack.set(0, 0, 1).applyQuaternion(camera.quaternion);
    // Project the desired up onto the image plane, then measure the roll from camUp to it.
    tmpV.copy(standUpWorld).addScaledVector(camBack, -standUpWorld.dot(camBack)).normalize();
    const roll = Math.atan2(camUp.clone().cross(tmpV).dot(camBack), camUp.dot(tmpV));
    camera.rotateZ(roll);
    camera.updateMatrixWorld();
  }

  // --- flyTo ----------------------------------------------------------------------------------
  const identity = new Quaternion();
  function stepFlight(now: number): boolean {
    if (!flight) return false;
    const t = flight.duration > 0 ? clamp((now - flight.start) / flight.duration, 0, 1) : 1;
    const k = easeInOutCubic(t);
    tmpQ.copy(identity).slerp(flight.rotation, k);
    tmpV.copy(flight.fromDir).applyQuaternion(tmpQ);
    camera.position
      .copy(ORBIT_TARGET)
      .addScaledVector(tmpV, flight.fromDist + (flight.toDist - flight.fromDist) * k);
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
    // Direction from the orbit target through the country's surface point, extended to the camera.
    const toDir = rig.localToWorld(latLngToVector3(lat, lng, 1)).sub(ORBIT_TARGET).normalize();
    const fromDir = camera.position.clone().sub(ORBIT_TARGET);
    const fromDist = fromDir.length();
    fromDir.normalize();
    let toDist = fromDist;
    if ((rec.area ?? Infinity) < SMALL_COUNTRY_AREA) toDist = Math.min(fromDist, SMALL_COUNTRY_DISTANCE);
    toDist = clamp(toDist, MIN_DISTANCE, MAX_DISTANCE);
    ctl.suspend();
    needsRender = true;
    return new Promise<void>((resolve) => {
      flight = {
        start: performance.now(),
        duration: reducedMotion ? 0 : (o.duration ?? 900),
        fromDir,
        rotation: new Quaternion().setFromUnitVectors(fromDir, toDir),
        fromDist,
        toDist,
        resolve,
      };
    });
  }

  // --- render loop ----------------------------------------------------------------------------
  function frame(now: number): void {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    let moved = stepFlight(now);
    if (ctl.update(dt)) moved = true;
    if (!moved && !needsRender) return;
    orient();
    labels.update(camera, container.clientHeight || 1);
    if (moved) picking.refresh();
    renderer.render(scene, camera);
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

  const observer = new ResizeObserver(() => {
    gs.resize();
    needsRender = true;
  });
  observer.observe(container);

  // --- bus wiring -----------------------------------------------------------------------------
  const offs = [
    bus.on('ui:flyTo', ({ iso3 }) => {
      setSelected(iso3);
      void flyTo(iso3);
    }),
    bus.on('ui:close', () => setSelected(null)),
  ];

  // --- initial view ---------------------------------------------------------------------------
  if (opts.initialIso3 && countries[opts.initialIso3]) {
    void flyTo(opts.initialIso3, { duration: 0 });
  } else {
    // Classic catalogue pose: the Atlantic in the middle, Americas left, Europe/Africa right.
    const dir = rig.localToWorld(latLngToVector3(22, -35, 1)).sub(ORBIT_TARGET).normalize();
    camera.position.copy(ORBIT_TARGET).addScaledVector(dir, DEFAULT_DISTANCE);
  }
  if (!document.hidden) start();

  return {
    flyTo,
    setSelected,
    setAutoRotate: (on) => ctl.setAutoRotate(on),
    resize() {
      gs.resize();
      needsRender = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (flight) flight.resolve();
      flight = null;
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      for (const off of offs) off();
      picking.dispose();
      ctl.dispose();
      labels.dispose();
      highlight.dispose();
      gs.dispose();
    },
  };
}

export { createGlobe as default };
export type { CountryRecord } from '../core/types';
export type { EventBus } from '../core/events';
