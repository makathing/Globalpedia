/**
 * Country-name labels: one THREE.Sprite per country with canvas-drawn serif text.
 *
 * - Fixed screen size (sizeAttenuation off; scale derived from the desired pixel height).
 * - Three size tiers by area; smaller tiers fade in as the camera zooms closer.
 * - Labels on the far side of the globe are hidden, with a fade near the limb.
 * - Hover and selected variants are rendered lazily into separate textures.
 */
import {
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  SRGBColorSpace,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import type { CountryRecord } from '../core/types';
import type { GlobeTheme } from '../core/themes';
import { DEG, latLngToVector3, smoothstep } from './math';
import { hashString, mulberry32 } from './surface';

export type LabelVariant = 'normal' | 'hover' | 'selected';

/** Tier 0: ≥ 1 M km² (always visible); tier 1: ≥ 200 k km²; tier 2: the rest. */
const TIER_AREA = [1_000_000, 200_000];
/** Camera distance (from the orbit target) below which each tier becomes visible. */
const TIER_DISTANCE = [Infinity, 3.0, 2.3];
/** Desired glyph height in CSS pixels per tier. */
const TIER_PX = [15, 13, 11.5];

const FONT_PX = 48; // canvas font size; the sprite is scaled down, so text stays crisp at DPR 2
const FONT = `${FONT_PX}px Georgia, "Times New Roman", serif`;
const PAD = 14;
const LABEL_RADIUS = 1.005;

interface LabelEntry {
  iso3: string;
  name: string;
  tier: number;
  sprite: Sprite;
  material: SpriteMaterial;
  normal: Vector3;
  /** canvas height ÷ font size — converts glyph px to sprite px. */
  heightRatio: number;
  aspect: number;
  /** Seeded from the ISO3, never the name or the variant, so the tilt never moves. */
  seed: number;
  /** Measured once at build time; re-measuring 250 names is not free. */
  width: number;
  height: number;
  textures: Partial<Record<LabelVariant, Texture>>;
  variant: LabelVariant;
}

export interface LabelSystem {
  group: Group;
  /** Sprites currently visible enough to be clicked (refreshed by `update`). */
  readonly pickable: Sprite[];
  /** Recompute facing, tier visibility and screen scale. Call whenever the camera moved. */
  update(camera: PerspectiveCamera, viewportHeightPx: number): void;
  setHover(iso3: string | null): void;
  setSelected(iso3: string | null): void;
  /**
   * Repaint every label in another theme's ink. Cached variant textures are
   * disposed and only the variant each sprite is *currently* showing is redrawn;
   * hover/selected variants are rebuilt lazily the next time they are needed.
   */
  restyle(theme: GlobeTheme): void;
  iso3Of(sprite: Sprite): string | undefined;
  dispose(): void;
}

function tierFor(area: number): number {
  if (area >= TIER_AREA[0]) return 0;
  if (area >= TIER_AREA[1]) return 1;
  return 2;
}

function measure(name: string): { width: number; height: number } {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return { width: 256, height: 64 };
  ctx.font = FONT;
  const w = ctx.measureText(name).width;
  return { width: Math.ceil(w + PAD * 2), height: Math.ceil(FONT_PX * 1.5) };
}

/** Sub-degree tilt, in degrees. Printed type sits fractionally off-true; much more than this reads as a mistake. */
const TYPE_TILT_DEG = 0.6;

function drawLabel(
  name: string,
  variant: LabelVariant,
  width: number,
  height: number,
  theme: GlobeTheme,
  seed: number,
): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = variant === 'selected' ? `bold ${FONT}` : FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const cx = width / 2;
    const cy = height / 2 - FONT_PX * 0.06;

    // Real printed type is never perfectly square to the line and never perfectly crisp.
    // The seed is the country's, not the variant's, so hovering never nudges the name.
    const rnd = mulberry32(seed);
    const tilt = (rnd() - 0.5) * 2 * TYPE_TILT_DEG * DEG;
    const offX = (rnd() - 0.5) * 0.9;
    const offY = (rnd() - 0.5) * 0.9;
    const bleed = 0.55 + rnd() * 0.5;
    ctx.translate(cx, cy);
    ctx.rotate(tilt);
    ctx.translate(-cx + offX, -cy + offY);

    // Halo in the theme's paper colour, for legibility over ocean and land alike.
    ctx.lineWidth = variant === 'normal' ? 7 : 8;
    ctx.strokeStyle = theme.labelHalo;
    ctx.strokeText(name, cx, cy);
    const inkColor = variant === 'hover' ? theme.labelHover : theme.labelInk;
    ctx.fillStyle = inkColor;
    ctx.fillText(name, cx, cy);
    // Ink spread: a hairline of the same ink bleeding off the glyph edges. Kept well under a
    // pixel so the letterforms thicken very slightly rather than losing their counters.
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.16 * rnd();
    ctx.lineWidth = bleed;
    ctx.strokeStyle = inkColor;
    ctx.strokeText(name, cx, cy);
    ctx.restore();
    if (variant === 'selected') {
      const w = ctx.measureText(name).width;
      const y = cy + FONT_PX * 0.5;
      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, y);
      ctx.lineTo(cx + w / 2, y);
      ctx.stroke();
      ctx.strokeStyle = theme.labelInk;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function createLabels(countries: Record<string, CountryRecord>, theme: GlobeTheme): LabelSystem {
  let ink = theme;
  const group = new Group();
  group.renderOrder = 10;
  const entries: LabelEntry[] = [];
  const bySprite = new Map<Sprite, LabelEntry>();
  const byIso = new Map<string, LabelEntry>();
  const pickable: Sprite[] = [];

  for (const iso3 of Object.keys(countries)) {
    const rec = countries[iso3];
    if (!rec || !Array.isArray(rec.latlng)) continue;
    const [lat, lng] = rec.latlng;
    const { width, height } = measure(rec.name);
    const seed = hashString(iso3);
    const tex = drawLabel(rec.name, 'normal', width, height, ink, seed);
    const material = new SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = 10;
    latLngToVector3(lat, lng, LABEL_RADIUS, sprite.position);
    sprite.visible = false;
    const entry: LabelEntry = {
      iso3,
      name: rec.name,
      tier: tierFor(rec.area ?? 0),
      sprite,
      material,
      normal: sprite.position.clone().normalize(),
      seed,
      heightRatio: height / FONT_PX,
      aspect: width / height,
      width,
      height,
      textures: { normal: tex },
      variant: 'normal',
    };
    entries.push(entry);
    bySprite.set(sprite, entry);
    byIso.set(iso3, entry);
    group.add(sprite);
  }

  function setVariant(entry: LabelEntry, variant: LabelVariant): void {
    if (entry.variant === variant) return;
    let tex = entry.textures[variant];
    if (!tex) {
      tex = drawLabel(entry.name, variant, entry.width, entry.height, ink, entry.seed);
      entry.textures[variant] = tex;
    }
    entry.material.map = tex;
    entry.material.needsUpdate = true;
    entry.variant = variant;
  }

  let hovered: string | null = null;
  let selected: string | null = null;
  function refreshVariant(iso3: string): void {
    const e = byIso.get(iso3);
    if (!e) return;
    setVariant(e, iso3 === selected ? 'selected' : iso3 === hovered ? 'hover' : 'normal');
  }

  const camLocal = new Vector3();
  const camDir = new Vector3();

  function update(camera: PerspectiveCamera, viewportHeightPx: number): void {
    // Camera position in the label group's (= rig's) frame.
    group.worldToLocal(camLocal.copy(camera.position));
    const dist = camLocal.length(); // distance to the globe centre, close enough to the orbit distance
    camDir.copy(camLocal).normalize();

    // A surface point is on the visible cap when dot(n, camDir) > 1/dist; fade in just inside that.
    const horizon = 1 / dist;
    const fadeStart = Math.max(0.15, horizon + 0.04);
    const fadeEnd = fadeStart + 0.22;

    // sizeAttenuation=false: a sprite of scale s spans s · (viewport height / 2) / tan(fov/2) pixels.
    const pxToScale = (2 * Math.tan((camera.fov * DEG) / 2)) / viewportHeightPx;

    pickable.length = 0;
    for (const e of entries) {
      const facing = e.normal.dot(camDir);
      let alpha = smoothstep(fadeStart, fadeEnd, facing);
      if (e.tier > 0) {
        // Progressive reveal: fully visible 0.3 closer than the threshold, gone 0.15 beyond it.
        const t = TIER_DISTANCE[e.tier];
        alpha *= 1 - smoothstep(t - 0.3, t + 0.15, dist);
      }
      if (alpha < 0.02) {
        e.sprite.visible = false;
        continue;
      }
      e.sprite.visible = true;
      e.material.opacity = alpha;
      const h = TIER_PX[e.tier] * e.heightRatio * pxToScale;
      e.sprite.scale.set(h * e.aspect, h, 1);
      if (alpha > 0.35) pickable.push(e.sprite);
    }
  }

  return {
    group,
    pickable,
    update,
    setHover(iso3) {
      const prev = hovered;
      hovered = iso3;
      if (prev) refreshVariant(prev);
      if (iso3) refreshVariant(iso3);
    },
    setSelected(iso3) {
      const prev = selected;
      selected = iso3;
      if (prev) refreshVariant(prev);
      if (iso3) refreshVariant(iso3);
    },
    restyle(next) {
      ink = next;
      for (const e of entries) {
        const variant = e.variant;
        // Drop every cached variant: none of them carry the new ink.
        for (const key of Object.keys(e.textures) as LabelVariant[]) {
          e.textures[key]?.dispose();
          delete e.textures[key];
        }
        // Only the variant this sprite is actually showing is repainted now; the
        // other two are cheap to rebuild on the next hover/selection.
        const tex = drawLabel(e.name, variant, e.width, e.height, ink, e.seed);
        e.textures[variant] = tex;
        e.material.map = tex;
        e.material.needsUpdate = true;
      }
    },
    iso3Of: (sprite) => bySprite.get(sprite)?.iso3,
    dispose() {
      for (const e of entries) {
        for (const t of Object.values(e.textures)) t?.dispose();
        e.material.dispose();
      }
      group.clear();
    },
  };
}
