/**
 * Pointer → country. One raycast against the map sphere; its UV goes straight to the ID map.
 * Emits hover changes and click selections through callbacks; index.ts turns those into bus
 * events.
 *
 * There is nothing else to hit any more. The names are printed into the raster, so their pick
 * targets are boxes stamped into that same index (`texture.ts`) — a name is now *part of the
 * map*, which is why a single sphere hit answers every question.
 */
import { Raycaster, Vector2, type Camera, type Mesh } from 'three';
import { lookupId, type IdMap } from './texture';

export interface PickingOptions {
  dom: HTMLElement;
  camera: Camera;
  sphere: Mesh;
  idMap: IdMap;
  onHover(iso3: string | null): void;
  onSelect(iso3: string): void;
}

export interface Picking {
  /** Current hovered ISO3 (or null). */
  readonly hovered: string | null;
  /** Re-run the hover test at the last pointer position (after the camera moved). */
  refresh(): void;
  dispose(): void;
}

const HOVER_INTERVAL_MS = 33;

/**
 * What counts as a tap, per pointer type — because a finger is not a mouse.
 *
 * A mouse pointer does not move unless you move it, so 5 px / 300 ms is exactly right: past
 * that the user was dragging the globe and did not mean to select anything.
 *
 * A finger is a different instrument. Both platforms put touch slop at 8-10 px before they will
 * even call a gesture a scroll, a fingertip covers 40-plus pixels of glass so its reported
 * centre wanders as the pad flattens and lifts, and a child aiming at a country the size of a
 * fingernail *presses deliberately* — which routinely runs past 300 ms. Held to the mouse's
 * numbers the headline interaction of the whole app, "tap a country", silently did nothing on
 * a phone perhaps half the time, with no feedback to say why.
 *
 * There is no cost to being generous here: a touch that travels more than this really was a
 * drag, and the controls have already turned it into one. A stylus sits between the two.
 */
const TAP_LIMITS: Record<string, { movePx: number; ms: number }> = {
  mouse: { movePx: 5, ms: 300 },
  pen: { movePx: 8, ms: 500 },
  touch: { movePx: 16, ms: 900 },
};
function tapLimits(pointerType: string): { movePx: number; ms: number } {
  return TAP_LIMITS[pointerType] ?? TAP_LIMITS.touch;
}

/**
 * When the press happened, not when we got round to hearing about it.
 *
 * `performance.now()` inside the handler measures the press *plus* whatever the main thread was
 * busy with — and on the phone this is all for, the main thread is exactly what is busy. A press
 * the hardware timestamped 180 ms apart is easily 600 ms apart by the time two handlers run
 * behind a long frame, and the tap is then thrown away for being slow when the finger was not.
 * `timeStamp` on a trusted pointer event is the input's own clock, on `performance.now()`'s
 * origin. Measured on a loaded machine, handler time overstated a press by up to 6 seconds.
 */
function eventTime(e: PointerEvent): number {
  return e.timeStamp > 0 ? e.timeStamp : performance.now();
}

export function createPicking(o: PickingOptions): Picking {
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let hovered: string | null = null;
  let lastMoveAt = 0;
  let lastClientX = NaN;
  let lastClientY = NaN;
  let pointerInside = false;

  function toNdc(clientX: number, clientY: number): boolean {
    const r = o.dom.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return true;
  }

  /** What is under the pointer: the country under the sphere UV, or nothing. */
  function pick(clientX: number, clientY: number): string | null {
    if (!toNdc(clientX, clientY)) return null;
    raycaster.setFromCamera(ndc, o.camera);
    const hits = raycaster.intersectObject(o.sphere, false);
    const uv = hits[0]?.uv;
    return uv ? lookupId(o.idMap, uv.x, uv.y) : null;
  }

  function setHovered(iso3: string | null): void {
    if (iso3 === hovered) return;
    hovered = iso3;
    o.dom.style.cursor = iso3 ? 'pointer' : '';
    o.onHover(iso3);
  }

  function refresh(): void {
    if (!pointerInside || Number.isNaN(lastClientX)) return;
    setHovered(pick(lastClientX, lastClientY));
  }

  /**
   * Throttling the hover test must not mean *dropping* the last move.
   *
   * The pointer's final position is the one that matters, and it is exactly the one most
   * likely to be thrown away: a quick flick off the globe delivers a burst of moves, the last
   * of which lands inside the throttle window and is discarded. The hover then stays on
   * whatever the pointer was over two frames ago — a country left washed with the cursor
   * nowhere near it — until something else happens to redraw. `pointerleave` only covers
   * leaving the canvas, and the canvas is much bigger than the globe.
   *
   * So a throttled move schedules a trailing test at the end of the window instead.
   */
  let trailing = 0;
  function testNow(): void {
    trailing = 0;
    lastMoveAt = performance.now();
    setHovered(pick(lastClientX, lastClientY));
  }
  const onMove = (e: PointerEvent): void => {
    pointerInside = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    const wait = HOVER_INTERVAL_MS - (performance.now() - lastMoveAt);
    if (wait > 0) {
      if (!trailing) trailing = window.setTimeout(testNow, wait);
      return;
    }
    testNow();
  };
  const onLeave = (): void => {
    pointerInside = false;
    clearTimeout(trailing);
    trailing = 0;
    setHovered(null);
  };

  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let downId = -1;
  let downType = 'mouse';
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // A second finger means a pinch, and a pinch is never a tap. `isPrimary` says so without
    // keeping a count that could leak a contact and reject every tap thereafter.
    if (!e.isPrimary) {
      downId = -1;
      return;
    }
    downX = e.clientX;
    downY = e.clientY;
    downAt = eventTime(e);
    downId = e.pointerId;
    downType = e.pointerType || 'mouse';
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== downId) return;
    downId = -1;
    const limits = tapLimits(downType);
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > limits.movePx || eventTime(e) - downAt > limits.ms) return;
    // Where the finger came up, not where it went down: the globe may have turned under a long
    // press, and the pixel the viewer is looking at when they lift is the one they chose.
    const iso3 = pick(e.clientX, e.clientY);
    if (iso3) o.onSelect(iso3);
  };
  /** The browser took the gesture over (scroll, back-swipe, palm). Not a tap. */
  const onCancel = (): void => {
    downId = -1;
  };

  o.dom.addEventListener('pointermove', onMove);
  o.dom.addEventListener('pointerleave', onLeave);
  o.dom.addEventListener('pointerdown', onDown);
  o.dom.addEventListener('pointerup', onUp);
  o.dom.addEventListener('pointercancel', onCancel);

  return {
    get hovered() {
      return hovered;
    },
    refresh,
    dispose() {
      clearTimeout(trailing);
      o.dom.removeEventListener('pointermove', onMove);
      o.dom.removeEventListener('pointerleave', onLeave);
      o.dom.removeEventListener('pointerdown', onDown);
      o.dom.removeEventListener('pointerup', onUp);
      o.dom.removeEventListener('pointercancel', onCancel);
      o.dom.style.cursor = '';
    },
  };
}
