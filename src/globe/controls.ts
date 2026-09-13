/**
 * Spin the globe, not the camera.
 *
 * The cradle is furniture: it is bolted to the world and never moves. So the camera is
 * bolted down too — it sits on a fixed ray through `target` and the only motion left to it
 * is sliding along that ray to zoom. Everything the user does to "move the world" is a
 * rotation of `spin`, the group that carries the sphere, the highlight and the life layer.
 *
 * Two axes, both fixed, both perpendicular to each other, so every point of the planet is
 * reachable and a plain drag gets you there:
 *   horizontal drag → about the globe's own tilted axis (the parent frame's local +Y);
 *   vertical drag   → about TILT_AXIS, perpendicular to that axis and to the view direction,
 *                     so the drag walks the facing point along a meridian and straight over
 *                     the poles.
 * Neither is clamped — rolling over a pole and out the other side is allowed, which is the whole
 * reason a polar angle limit could not survive this change.
 *
 * The vertical axis is deliberately *not* the camera's right vector. That vector sits 67.2° from
 * the globe's tilted axis rather than 90°, so rolling about it walks a small circle that tops out
 * at 62.8°N — a user dragging straight up stalls 27° short of the pole with nothing to explain
 * why, and the diagonal that would get them there is not something anyone discovers. Being able
 * to reach a pole in principle is not the same as reaching it in practice.
 *
 * The feel is lifted from the OrbitControls this replaced, deliberately and to the number:
 * the same 2π·px/clientHeight mapping, the same zoom-scaled rotate speed, the same
 * apply-`DAMPING`-then-decay inertia, the same 0.95^(zoomSpeed·Δ) wheel step, and the same
 * auto-rotate that yields to input, to a selection and to `prefers-reduced-motion`.
 */
import { Quaternion, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { DEFAULT_DISTANCE } from './globe';
import { clamp } from './math';

/**
 * The zoom range, quoted against `DEFAULT_DISTANCE` — i.e. against the pose a screen at least
 * as wide as it is tall opens in. A portrait screen opens further back (`fitDistance`), and
 * `setFitScale` stretches these two with it, so the range is the same range in *apparent size*
 * on every shape of screen: hard in, you see the same patch of the planet across the short
 * side of the viewport that you always did, and hard out is the same 15% step back.
 * They are only distances in the abstract; what the viewer feels is the ratio to the default.
 */
export const MIN_DISTANCE = 1.6;
export const MAX_DISTANCE = 4.5;
/**
 * Past this much finger travel a touch is a drag, not a tap with slop on it — and a viewer who
 * has dragged has taken the globe over, so a later resize must not re-frame it underneath them.
 */
const TAKEOVER_PX = 8;
/** How long after the user lets go / the panel closes before auto-rotate resumes. */
export const RESUME_DELAY_MS = 6000;

/** Fraction of the pending rotation applied per frame; the rest decays. OrbitControls' dampingFactor. */
const DAMPING = 0.08;
/** Idle spin: 2π/60 × 0.35 rad/s, i.e. ~171 s a revolution — OrbitControls' autoRotateSpeed 0.35. */
const AUTO_ROTATE = ((2 * Math.PI) / 60) * 0.35;
/** OrbitControls' zoomSpeed, feeding the same 0.95^(zoomSpeed·|Δ|/100) wheel step. */
const ZOOM_SPEED = 0.7;
/**
 * Below this a pending rotation is not worth a frame, and the remainder is dropped. The globe
 * is turning by `EPS * DAMPING` radians a frame here, under a tenth of a pixel at the limb, and
 * the app renders on demand — so the alternative is a couple of hundred frames of drawing nothing
 * anyone can see at the end of every drag. OrbitControls stopped at the same point, via a
 * threshold on the camera's own movement.
 */
const EPS = 3e-3;

/**
 * The spin axis in `spin`'s parent frame. The parent (`rig`) is tilted 23.5° precisely so that
 * its local +Y *is* the globe's axis — see globe.ts.
 */
const SPIN_AXIS = new Vector3(0, 1, 0);

export interface GlobeControls {
  /** Whether the pointer is currently dragging / pinching. */
  readonly interacting: boolean;
  /** Camera distance from the view target. */
  readonly distance: number;
  /** The framing stretch currently applied to the default distance and the zoom range. */
  readonly fitScale: number;
  /**
   * Distance as a multiple of the reference pose, i.e. the distance this framing *looks* like
   * on a landscape screen. Anything keyed to apparent size (the life layer's discovery ramp)
   * wants this and not the raw distance.
   */
  readonly relativeDistance: number;
  /** Has the viewer zoomed or dragged? Once they have, the framing is theirs, not ours. */
  readonly takenOver: boolean;
  /**
   * Re-frame for a new viewport: stretch the default distance and the zoom range by `scale`.
   * The camera itself only follows while the viewer has not taken over and is sitting at the
   * default — a resize must never pull the globe out from under a gesture or a chosen zoom.
   */
  setFitScale(scale: number): void;
  /** Advance damping / auto-rotate and place the camera. Returns true when anything moved. */
  update(deltaSeconds: number): boolean;
  /** User-level switch (also forced off by prefers-reduced-motion). */
  setAutoRotate(on: boolean): void;
  /** A selected country pauses auto-rotate until `setSelected(false)` + delay. */
  setSelected(selected: boolean): void;
  /** Temporarily suspend auto-rotate (e.g. while flying) and resume after the delay. */
  suspend(): void;
  /** Dolly to an exact distance (flyTo drives this). */
  setDistance(d: number): void;
  /**
   * Apply any pending damped rotation immediately so nothing keeps drifting afterwards.
   * Call before taking over the globe (flyTo); otherwise the inertia tail fights the flight.
   */
  flush(): void;
  dispose(): void;
}

export interface ControlsOptions {
  camera: PerspectiveCamera;
  dom: HTMLElement;
  /** The group carrying the globe's rotation. Its parent supplies the fixed 23.5° tilt. */
  spin: Object3D;
  /** The point the camera looks at. It only ever slides along `viewDir` from here. */
  target: Vector3;
  /** Unit vector from `target` towards the camera. Fixed for the life of the scene. */
  viewDir: Vector3;
  autoRotate: boolean;
}

export function createControls(o: ControlsOptions): GlobeControls {
  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The tilt frame never moves, so the change of basis into it is computed once.
  const toRig = new Quaternion();
  o.spin.parent?.getWorldQuaternion(toRig);
  toRig.invert();

  /**
   * The vertical drag's axis, in the tilt frame: perpendicular to the globe's axis and to the
   * line of sight, which is exactly the condition for a roll about it to trace a meridian. Both
   * inputs are fixed for the life of the scene, so this is computed once too.
   */
  const TILT_AXIS = new Vector3()
    .crossVectors(SPIN_AXIS, o.viewDir.clone().applyQuaternion(toRig))
    .normalize();

  /** Set by `setFitScale`; 1 is the reference (landscape) framing. */
  let fitScale = 1;
  let takenOver = false;
  let dragTravel = 0;
  const minD = (): number => MIN_DISTANCE * fitScale;
  const maxD = (): number => MAX_DISTANCE * fitScale;
  const homeD = (): number => DEFAULT_DISTANCE * fitScale;

  let distance = clamp(o.camera.position.distanceTo(o.target), minD(), maxD());
  let wanted = o.autoRotate && !reducedMotion;
  let selected = false;
  let suspended = false;
  let interacting = false;
  let resumeTimer = 0;
  /** Undelivered rotation, in radians: `Spin` about the globe's axis, `Tilt` about TILT_AXIS. */
  let pendingSpin = 0;
  let pendingTilt = 0;

  const qDelta = new Quaternion();
  const lastPos = o.camera.position.clone();

  function autoRotating(): boolean {
    return wanted && !selected && !suspended && !interacting;
  }
  function scheduleResume(): void {
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      suspended = false;
    }, RESUME_DELAY_MS);
  }
  function suspend(): void {
    suspended = true;
    scheduleResume();
  }

  /** Rotate the globe: `s` about its own axis, `t` about the meridian-walking axis. */
  function rotate(s: number, t: number): void {
    if (s) {
      qDelta.setFromAxisAngle(SPIN_AXIS, s);
      o.spin.quaternion.premultiply(qDelta);
    }
    if (t) {
      qDelta.setFromAxisAngle(TILT_AXIS, t);
      o.spin.quaternion.premultiply(qDelta);
    }
    if (s || t) o.spin.quaternion.normalize();
  }

  // --- input ------------------------------------------------------------------------------------
  o.dom.style.touchAction = 'none'; // no browser pan/zoom on touch — we handle both
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;

  /** Same mapping OrbitControls used: a drag of the element's height is 2π × rotateSpeed. */
  function dragToRadians(px: number): number {
    const h = Math.max(1, o.dom.clientHeight);
    // Close in, the visible patch is small: slow the drag so a swipe moves ~the same on-screen distance.
    const speed = 0.22 + 0.78 * clamp((distance - minD()) / (maxD() - minD()), 0, 1);
    return (2 * Math.PI * px * speed) / h;
  }

  function dolly(scale: number): void {
    distance = clamp(distance * scale, minD(), maxD());
    takenOver = true;
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (pointers.size === 0) {
      interacting = true;
      dragTravel = 0;
      window.clearTimeout(resumeTimer);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinch = pinchSpan();
    // Throws if the pointer is already gone (a fast tap, a cancelled gesture, a synthesised
    // event). Capture is an optimisation — losing it costs a drag that ends at the canvas edge,
    // not the drag itself — so it must never take the handler down with it.
    try {
      o.dom.setPointerCapture?.(e.pointerId);
    } catch {
      /* no active pointer with that id */
    }
  };

  function pinchSpan(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  const onPointerMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (pointers.size === 1) {
      // Drag right → the surface goes right; drag down → it goes down, walking the meridian.
      // Both signs match the camera-orbiting controls this replaced.
      pendingSpin += dragToRadians(dx);
      pendingTilt += dragToRadians(dy);
      dragTravel += Math.abs(dx) + Math.abs(dy);
      if (dragTravel > TAKEOVER_PX) takenOver = true;
    } else if (pointers.size === 2) {
      const span = pinchSpan();
      if (pinch > 0 && span > 0) dolly(1 / Math.pow(span / pinch, ZOOM_SPEED));
      pinch = span;
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (o.dom.hasPointerCapture?.(e.pointerId)) o.dom.releasePointerCapture(e.pointerId);
    if (pointers.size === 1) pinch = 0;
    if (pointers.size === 0) {
      interacting = false;
      suspend();
    }
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    const scale = Math.pow(0.95, (ZOOM_SPEED * Math.abs(e.deltaY)) / 100);
    dolly(e.deltaY < 0 ? scale : 1 / scale);
    suspend();
  };

  o.dom.addEventListener('pointerdown', onPointerDown);
  o.dom.addEventListener('pointermove', onPointerMove);
  o.dom.addEventListener('pointerup', onPointerUp);
  o.dom.addEventListener('pointercancel', onPointerUp);
  o.dom.addEventListener('wheel', onWheel, { passive: false });

  // --- frame ------------------------------------------------------------------------------------
  function update(deltaSeconds: number): boolean {
    if (autoRotating()) pendingSpin += AUTO_ROTATE * deltaSeconds;
    let moved = false;
    if (Math.abs(pendingSpin) > EPS || Math.abs(pendingTilt) > EPS) {
      rotate(pendingSpin * DAMPING, pendingTilt * DAMPING);
      pendingSpin *= 1 - DAMPING;
      pendingTilt *= 1 - DAMPING;
      moved = true;
    } else {
      pendingSpin = 0;
      pendingTilt = 0;
    }
    o.camera.position.copy(o.target).addScaledVector(o.viewDir, distance);
    if (lastPos.distanceToSquared(o.camera.position) > 1e-10) moved = true;
    lastPos.copy(o.camera.position);
    return moved;
  }

  return {
    get interacting() {
      return interacting;
    },
    get distance() {
      return distance;
    },
    get fitScale() {
      return fitScale;
    },
    get relativeDistance() {
      return distance / fitScale;
    },
    get takenOver() {
      return takenOver;
    },
    setFitScale(scale) {
      const next = scale > 0 && Number.isFinite(scale) ? scale : 1;
      if (next === fitScale) return;
      // Follow the new framing only from the pose we put the viewer in ourselves. Once they
      // have zoomed or dragged, or while a finger is still down, the camera stays where it is
      // and only the range around it moves.
      const atHome = Math.abs(distance - homeD()) < 1e-6;
      fitScale = next;
      if (atHome && !takenOver && !interacting) distance = homeD();
      distance = clamp(distance, minD(), maxD());
    },
    update,
    setAutoRotate(on) {
      wanted = on && !reducedMotion;
    },
    setSelected(sel) {
      selected = sel;
      if (!sel) suspend();
    },
    suspend,
    setDistance(d) {
      // flyTo drives this, so it is not a takeover: the framing is still ours to re-fit.
      distance = clamp(d, minD(), maxD());
    },
    flush() {
      rotate(pendingSpin, pendingTilt);
      pendingSpin = 0;
      pendingTilt = 0;
    },
    dispose() {
      window.clearTimeout(resumeTimer);
      o.dom.removeEventListener('pointerdown', onPointerDown);
      o.dom.removeEventListener('pointermove', onPointerMove);
      o.dom.removeEventListener('pointerup', onPointerUp);
      o.dom.removeEventListener('pointercancel', onPointerUp);
      o.dom.removeEventListener('wheel', onWheel);
      o.dom.style.touchAction = '';
      pointers.clear();
    },
  };
}
