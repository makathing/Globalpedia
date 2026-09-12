/**
 * Hover / selection highlight: a low-res transparent canvas texture on a
 * slightly larger sphere, redrawn only when the highlighted countries change.
 *
 * Two marks, not one. The wash over the polygon is unchanged; the new one is an underline
 * ruled beneath the country's **printed** name. Baked type cannot restyle itself the way the
 * old sprites did — there is no hover texture to swap — so the acknowledgement that "this is
 * the name you are pointing at" has to come from this layer instead. It is also the only
 * highlight a country with no polygon at this resolution (Tuvalu, Monaco…) ever gets.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, SphereGeometry, SRGBColorSpace } from 'three';
import type { GlobeTheme } from '../core/themes';
import type { PlacedLabel } from './label-layout';
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

export function createHighlightLayer(textures: GlobeTextures, theme: GlobeTheme, width = 4096): HighlightLayer {
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
  // Never a raycast target: picking goes straight to the map sphere.
  mesh.raycast = () => {};

  const layout = textures.labels;
  /** Reference-raster pixels → this canvas's pixels. */
  const k = width / layout.width;

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

  /**
   * Rule a line under a printed name. Drawn twice — a wide, faint pass and a narrow solid
   * one — which is what makes it read as a soft mark under the type rather than a box edge,
   * and which survives this canvas being a quarter of the map's resolution.
   *
   * The line's length is the name's stretched box width, so on the sphere it comes out the
   * same proportion of the name at every latitude, exactly like the glyphs above it.
   */
  function underline(label: PlacedLabel, soft: string, solid: string): void {
    const half = (label.boxW * k) / 2 - label.fontPx * k * 0.3;
    if (half <= 0) return;
    const y = (label.y + label.fontPx * 0.48) * k;
    const w = label.fontPx * k;
    for (const dx of [0, -width, width]) {
      const x = label.x * k + dx;
      if (x + half < 0 || x - half > width) continue;
      ctx.beginPath();
      ctx.moveTo(x - half, y);
      ctx.lineTo(x + half, y);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = soft;
      ctx.lineWidth = Math.max(2.5, w * 0.16);
      ctx.stroke();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = solid;
      ctx.lineWidth = Math.max(1, w * 0.045);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** Unconditional repaint of the current hover/selection in the current colours. */
  function repaint(): void {
    ctx.clearRect(0, 0, width, height);
    if (curHover && curHover !== curSelected) {
      paint(curHover, colors.highlightHoverFill, colors.highlightHoverLine, 1.6);
      const label = layout.byIso.get(curHover);
      if (label) underline(label, colors.labelHalo, colors.labelHover);
    }
    if (curSelected) {
      paint(curSelected, colors.highlightSelFill, colors.highlightSelLine, 2.4);
      const label = layout.byIso.get(curSelected);
      if (label) underline(label, colors.labelHover, colors.labelInk);
    }
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
