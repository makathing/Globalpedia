/**
 * OrbitControls wrapper: zoom-aware rotate speed, gentle auto-rotate that yields
 * to the user and to a selected country, and reduced-motion support.
 */
import type { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ORBIT_TARGET } from './globe';
import { clamp } from './math';

export const MIN_DISTANCE = 1.6;
export const MAX_DISTANCE = 4.5;
/** How long after the user lets go / the panel closes before auto-rotate resumes. */
export const RESUME_DELAY_MS = 6000;

export interface GlobeControls {
  readonly controls: OrbitControls;
  /** Whether the pointer is currently dragging / pinching. */
  readonly interacting: boolean;
  /** Advance damping / auto-rotate. Returns true when the camera moved. */
  update(deltaSeconds: number): boolean;
  /** User-level switch (also forced off by prefers-reduced-motion). */
  setAutoRotate(on: boolean): void;
  /** A selected country pauses auto-rotate until `setSelected(false)` + delay. */
  setSelected(selected: boolean): void;
  /** Temporarily suspend auto-rotate (e.g. while flying) and resume after the delay. */
  suspend(): void;
  /**
   * Apply any pending damped rotation immediately so nothing keeps drifting afterwards.
   * Call before taking over the camera (flyTo); otherwise the auto-rotate tail nudges the target off-centre.
   */
  flush(): void;
  dispose(): void;
}

export function createControls(camera: PerspectiveCamera, dom: HTMLElement, autoRotate: boolean): GlobeControls {
  const reducedMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // NB: OrbitControls captures camera.up in its constructor; camera.up is already the tilted axis.
  const controls = new OrbitControls(camera, dom);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.zoomSpeed = 0.7;
  controls.autoRotateSpeed = 0.35; // ≈ 170 s per revolution
  controls.target.copy(ORBIT_TARGET);
  controls.update();

  let wanted = autoRotate && !reducedMotion;
  let selected = false;
  let suspended = false;
  let interacting = false;
  let resumeTimer = 0;

  function apply(): void {
    controls.autoRotate = wanted && !selected && !suspended && !interacting;
  }
  function scheduleResume(): void {
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      suspended = false;
      apply();
    }, RESUME_DELAY_MS);
  }
  function suspend(): void {
    suspended = true;
    apply();
    scheduleResume();
  }

  const onStart = (): void => {
    interacting = true;
    window.clearTimeout(resumeTimer);
    apply();
  };
  const onEnd = (): void => {
    interacting = false;
    suspend();
  };
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  apply();

  const lastPos = camera.position.clone();

  function update(deltaSeconds: number): boolean {
    // Close in, the visible patch is small: slow the drag so a swipe moves ~the same on-screen distance.
    const d = camera.position.distanceTo(controls.target);
    controls.rotateSpeed = 0.22 + 0.78 * clamp((d - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE), 0, 1);
    controls.update(deltaSeconds);
    const moved = lastPos.distanceToSquared(camera.position) > 1e-10;
    lastPos.copy(camera.position);
    return moved;
  }

  return {
    controls,
    get interacting() {
      return interacting;
    },
    update,
    setAutoRotate(on) {
      wanted = on && !reducedMotion;
      apply();
    },
    setSelected(sel) {
      selected = sel;
      if (!sel) suspend();
      else apply();
    },
    suspend,
    flush() {
      // With damping off, update() applies the whole _sphericalDelta and resets it to zero.
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      lastPos.copy(camera.position);
    },
    dispose() {
      window.clearTimeout(resumeTimer);
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      controls.dispose();
    },
  };
}
