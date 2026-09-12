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
const CLICK_MAX_MOVE_PX = 5;
const CLICK_MAX_MS = 300;

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

  const onMove = (e: PointerEvent): void => {
    pointerInside = true;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    const now = performance.now();
    if (now - lastMoveAt < HOVER_INTERVAL_MS) return;
    lastMoveAt = now;
    setHovered(pick(e.clientX, e.clientY));
  };
  const onLeave = (): void => {
    pointerInside = false;
    setHovered(null);
  };

  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let downId = -1;
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    downX = e.clientX;
    downY = e.clientY;
    downAt = performance.now();
    downId = e.pointerId;
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== downId) return;
    downId = -1;
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > CLICK_MAX_MOVE_PX || performance.now() - downAt > CLICK_MAX_MS) return;
    const iso3 = pick(e.clientX, e.clientY);
    if (iso3) o.onSelect(iso3);
  };

  o.dom.addEventListener('pointermove', onMove);
  o.dom.addEventListener('pointerleave', onLeave);
  o.dom.addEventListener('pointerdown', onDown);
  o.dom.addEventListener('pointerup', onUp);

  return {
    get hovered() {
      return hovered;
    },
    refresh,
    dispose() {
      o.dom.removeEventListener('pointermove', onMove);
      o.dom.removeEventListener('pointerleave', onLeave);
      o.dom.removeEventListener('pointerdown', onDown);
      o.dom.removeEventListener('pointerup', onUp);
      o.dom.style.cursor = '';
    },
  };
}
