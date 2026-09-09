/**
 * Hover / selection highlight: a low-res transparent canvas texture on a
 * slightly larger sphere, redrawn only when the highlighted countries change.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, SphereGeometry, SRGBColorSpace } from 'three';
import type { GlobeTextures } from './texture';
import { traceGeometry } from './texture';

export interface HighlightLayer {
  mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** Returns true when anything was redrawn. */
  set(hover: string | null, selected: string | null): boolean;
  dispose(): void;
}

export function createHighlightLayer(textures: GlobeTextures, width = 2048): HighlightLayer {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('2D canvas context unavailable');
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(
    new SphereGeometry(1.002, 128, 96),
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 1 }),
  );
  mesh.renderOrder = 1;
  mesh.visible = false;
  // Never a raycast target: picking goes straight to the map sphere and the labels.
  mesh.raycast = () => {};

  let curHover: string | null = null;
  let curSelected: string | null = null;

  function paint(iso3: string, fill: string, stroke: string, lineWidth: number): void {
    const shape = textures.shapes.get(iso3);
    if (!shape) return;
    ctx.beginPath();
    traceGeometry(ctx, shape.geometry, width, height);
    ctx.fillStyle = fill;
    ctx.fill('evenodd');
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function set(hover: string | null, selected: string | null): boolean {
    if (hover === curHover && selected === curSelected) return false;
    curHover = hover;
    curSelected = selected;
    ctx.clearRect(0, 0, width, height);
    if (hover && hover !== selected) paint(hover, 'rgba(255, 176, 80, 0.30)', 'rgba(160, 70, 20, 0.65)', 1.6);
    if (selected) paint(selected, 'rgba(240, 130, 45, 0.48)', 'rgba(150, 60, 15, 0.95)', 2.4);
    mesh.visible = Boolean(hover || selected);
    texture.needsUpdate = true;
    return true;
  }

  return {
    mesh,
    set,
    dispose() {
      texture.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
