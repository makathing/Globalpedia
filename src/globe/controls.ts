/**
 * Spin the globe, not the camera.
 *
 * The cradle is furniture: it is bolted to the world and never moves. So the camera is
 * bolted down too — it sits on a fixed ray through `target` and the only motion left to it
 * is sliding along that ray to zoom. Everything the user does to "move the world" is a
 * rotation of `spin`, the group that carries the sphere, the highlight and the life layer.
 *
 * Two axes, trackball style, so every point of the planet is reachable:
 *   horizontal drag → about the globe's own tilted axis (the parent frame's local +Y);
 *   vertical drag   → about the camera's right vector, which is constant now the camera is.
 * Neither is clamped — rolling straight over a pole and out the other side is allowed, which
 * is the whole reason a polar angle limit could not survive this change.
 *
 * The feel is lifted from the OrbitControls this replaced, deliberately and to the number:
 * the same 2π·px/clientHeight mapping, the same zoom-scaled rotate speed, the same
 * apply-`DAMPING`-then-decay inertia, the same 0.95^(zoomSpeed·Δ) wheel step, and the same
 * auto-rotate that yields to input, to a selection and to `prefers-reduced-motion`.
 */
import { Quaternion, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { clamp } from './math';

export const MIN_DISTANCE = 1.6;
export const MAX_DISTANCE = 4.5;
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

  let distance = clamp(o.camera.position.distanceTo(o.target), MIN_DISTANCE, MAX_DISTANCE);
  let wanted = o.autoRotate && !reducedMotion;
  let selected = false;
  let suspended = false;
  let interacting = false;
  let resumeTimer = 0;
  /** Undelivered rotation, in radians: x about the globe's axis, y about the camera's right. */
  let pendingSpin = 0;
  let pendingTilt = 0;

  const qDelta = new Quaternion();
  const axis = new Vector3();
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

  /** Rotate the globe: `s` about its own axis, `t` about the camera's right vector. */
  function rotate(s: number, t: number): void {
    if (s) {
      qDelta.setFromAxisAngle(SPIN_AXIS, s);
      o.spin.quaternion.premultiply(qDelta);
    }
    if (t) {
      axis.set(1, 0, 0).applyQuaternion(o.camera.quaternion).applyQuaternion(toRig).normalize();
      qDelta.setFromAxisAngle(axis, t);
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
    const speed = 0.22 + 0.78 * clamp((distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE), 0, 1);
    return (2 * Math.PI * px * speed) / h;
  }

  function dolly(scale: number): void {
    distance = clamp(distance * scale, MIN_DISTANCE, MAX_DISTANCE);
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (pointers.size === 0) {
      interacting = true;
      window.clearTimeout(resumeTimer);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinch = pinchSpan();
    o.dom.setPointerCapture?.(e.pointerId);
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
      // Drag right → the surface goes right; drag down → it goes down. Both signs match the
      // camera-orbiting controls this replaced.
      pendingSpin += dragToRadians(dx);
      pendingTilt += dragToRadians(dy);
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
      distance = clamp(d, MIN_DISTANCE, MAX_DISTANCE);
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
