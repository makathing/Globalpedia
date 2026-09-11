/**
 * Hover / selection highlight: a low-res transparent canvas texture on a
 * slightly larger sphere, redrawn only when the highlighted countries change.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, SphereGeometry, SRGBColorSpace } from 'three';
import type { GlobeTheme } from '../core/themes';
import type { GlobeTextures } from './texture';
import { traceGeometry } from './texture';

export interface HighlightLayer {
  mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** Returns true when anything was redrawn. */
  set(hover: string | null, selected: string | null): boolean;
  /** Adopt another theme's highlight colours and repaint the current selection. */
  restyle(theme: GlobeTheme): void;
  dispose(): void;
}

export function createHighlightLayer(textures: GlobeTextures, theme: GlobeTheme, width = 2048): HighlightLayer {
  let colors = theme;
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

  /** Unconditional repaint of the current hover/selection in the current colours. */
  function repaint(): void {
    ctx.clearRect(0, 0, width, height);
    if (curHover && curHover !== curSelected) {
      paint(curHover, colors.highlightHoverFill, colors.highlightHoverLine, 1.6);
    }
    if (curSelected) paint(curSelected, colors.highlightSelFill, colors.highlightSelLine, 2.4);
    mesh.visible = Boolean(curHover || curSelected);
    texture.needsUpdate = true;
  }

  function set(hover: string | null, selected: string | null): boolean {
    if (hover === curHover && selected === curSelected) return false;
    curHover = hover;
    curSelected = selected;
    repaint();
    return true;
  }

  return {
    mesh,
    set,
    restyle(next) {
      colors = next;
      repaint(); // bypasses set()'s unchanged-input early return
    },
    dispose() {
      texture.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
