/**
 * Renderer, camera, lights, the textured sphere and the brass-and-wood stand.
 *
 * Scene graph
 * -----------
 *   scene
 *   ├─ rig              tilted 23.5° about Z, and then never touched again;
 *   │  │                its local +Y is the globe's spin axis
 *   │  ├─ globeSpin     carries *all* user rotation, as a quaternion
 *   │  │  ├─ sphere     the map (raycast target)
 *   │  │  ├─ highlight  translucent overlay sphere (added by highlight.ts)
 *   │  │  └─ life       ships and animals (added by life.ts)
 *   │  └─ standRig      meridian ring, pole pins, caps, stem, base, key light — never moves
 *   └─ camera           fixed pose; the only motion left to it is dollying along VIEW_DIR
 *
 * The cradle is furniture. It is bolted to the world, and so is the camera: dragging
 * rotates `globeSpin`, exactly as your hand turns a real globe inside its ring. There is
 * no counter-rotation and no camera roll to keep the base upright any more — the base is
 * upright because nothing ever tips it.
 *
 * One deliberate consequence: the pins belong to the cradle, so once the user rolls the
 * globe about the camera's right vector the geographic poles no longer sit in them. A
 * sphere turning inside a thin ring reads perfectly well, and chasing the poles with the
 * cradle would put the furniture back in motion — which is the thing being fixed here.
 */
import {
  AmbientLight,
  CubicBezierCurve3,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
  CanvasTexture,
  type Material,
  type Object3D,
} from 'three';
import type { GlobeTheme } from '../core/themes';
import { DEG, TILT } from './math';
import { applySurfaceMaterial } from './surface';

export const GLOBE_RADIUS = 1;
export const RING_RADIUS = 1.075;

/**
 * The base's up axis, in `rig` local space. `rig` is tilted by -TILT, so this lands on world
 * +Y: the base stands upright on screen with the camera simply held level. Nothing projects
 * it any more — it is geometry, used to build the stand and to aim the fill light.
 */
export const STAND_UP = new Vector3(-Math.sin(TILT), Math.cos(TILT), 0);
/** Spin axis in world space. */
export const AXIS = new Vector3(Math.sin(TILT), Math.cos(TILT), 0);
/**
 * What the camera looks at: a point on the axis a little below the globe's centre, so the
 * framing leaves room for the base underneath.
 */
export const VIEW_TARGET = AXIS.clone().multiplyScalar(-0.2);
/** Default camera distance from VIEW_TARGET. */
export const DEFAULT_DISTANCE = 3.9;

/**
 * Elevation of the fixed viewpoint above the globe's equatorial plane, measured at the spin
 * axis. Together with the azimuth below it reproduces, to the decimal, the pose the orbiting
 * camera used to open in — so the globe at rest looks exactly as it always did.
 */
const VIEW_ELEVATION = 31.7847 * DEG;
/**
 * Unit vector from VIEW_TARGET towards the camera. It lies in the stand's own meridian plane
 * (x = 0 in `rig` local space, i.e. the cradle's azimuth 0), which is precisely what lets the
 * base read upright with the camera held level and no roll applied.
 */
export const VIEW_DIR = new Vector3(0, Math.sin(VIEW_ELEVATION), Math.cos(VIEW_ELEVATION)).applyAxisAngle(
  new Vector3(0, 0, 1),
  -TILT,
);

/**
 * The point of the globe that is dead centre of the fixed view, in `rig` local space: where
 * the ray from VIEW_TARGET towards the camera meets the unit sphere. `flyTo` turns a country
 * onto exactly this point. It depends only on the view ray, so zooming never moves it.
 */
export const FACING_POINT = (() => {
  const b = VIEW_TARGET.dot(VIEW_DIR);
  const t = -b + Math.sqrt(b * b + GLOBE_RADIUS * GLOBE_RADIUS - VIEW_TARGET.lengthSq());
  const world = VIEW_TARGET.clone().addScaledVector(VIEW_DIR, t);
  return world.applyAxisAngle(new Vector3(0, 0, 1), TILT).normalize();
})();

/**
 * The spin, about the globe's own axis, that brings `lng` onto the camera's meridian. A point
 * at longitude L sits at rig azimuth 90° + L, and the camera sits at azimuth 0.
 */
export function spinForLongitude(lng: number): number {
  return -(Math.PI / 2 + lng * DEG);
}

export interface GlobeScene {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** The tilt frame. Static: it is set once and never rotated. */
  rig: Group;
  /** Everything that turns when the user spins the globe. */
  globeSpin: Group;
  /** The cradle. Static: ring, pins, caps, stem, base and the key light. */
  standRig: Group;
  /** Physical, not standard: a varnished paper globe has a coat over the ink (see surface.ts). */
  sphere: Mesh<SphereGeometry, MeshPhysicalMaterial>;
  mapTexture: CanvasTexture;
  /**
   * The one material shared by the ring, both pole pins, both finials, the base
   * band, the collar and the stem — `brassMat.color.set(...)` recolours all of them.
   */
  brassMat: MeshStandardMaterial;
  /** The base disc. */
  woodMat: MeshStandardMaterial;
  keyLight: DirectionalLight;
  hemiLight: HemisphereLight;
  ambientLight: AmbientLight;
  /** Resize renderer + camera to the container's current box. */
  resize(): void;
  dispose(): void;
}

/** The stand's mutable parts, handed back so a theme switch can recolour in place. */
interface Stand {
  group: Group;
  brassMat: MeshStandardMaterial;
  woodMat: MeshStandardMaterial;
  keyLight: DirectionalLight;
}

/** Build the semi-meridian ring, pole caps, curved stem and wooden base. */
function buildStand(theme: GlobeTheme): Stand {
  const g = new Group();
  const brassMat = new MeshStandardMaterial({ color: theme.brass, metalness: 0.85, roughness: 0.32 });

  // Semi-meridian: a half torus in the XY plane from the south pole, round +X, to the north pole,
  // then swung ~20° back (about Y) so it recedes behind the globe instead of lying flat on screen.
  const ring = new Mesh(new TorusGeometry(RING_RADIUS, 0.024, 14, 120, Math.PI), brassMat);
  ring.rotation.z = -Math.PI / 2;
  const ringSwing = new Group();
  ringSwing.rotation.y = 0.35;
  ringSwing.add(ring);
  g.add(ringSwing);

  // Pole pins: little axles from the sphere out to the ring, capped with a finial.
  for (const sign of [1, -1]) {
    const pin = new Mesh(new CylinderGeometry(0.014, 0.014, RING_RADIUS - GLOBE_RADIUS + 0.06, 12), brassMat);
    pin.position.y = sign * (GLOBE_RADIUS + (RING_RADIUS - GLOBE_RADIUS) / 2);
    g.add(pin);
    const cap = new Mesh(new SphereGeometry(0.036, 20, 14), brassMat);
    cap.position.y = sign * (RING_RADIUS + 0.02);
    g.add(cap);
  }

  // Base: upright in *screen* space, i.e. along STAND_UP. Like a real semi-meridian globe it sits
  // (almost) under the ring's foot, so the tilted globe overhangs it slightly to the right.
  const baseUp = STAND_UP.clone();
  const baseRight = new Vector3(Math.cos(TILT), Math.sin(TILT), 0);
  const footX = -(RING_RADIUS + 0.03) * Math.sin(TILT); // screen-x of the ring's south end
  const baseCenter = baseUp.clone().multiplyScalar(-1.62).addScaledVector(baseRight, footX + 0.1);

  const base = new Group();
  base.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), baseUp);
  base.position.copy(baseCenter);
  const woodMat = new MeshStandardMaterial({ color: theme.wood, roughness: 0.6, metalness: 0.05 });
  const disc = new Mesh(new CylinderGeometry(0.44, 0.5, 0.11, 64), woodMat);
  base.add(disc);
  const band = new Mesh(new TorusGeometry(0.455, 0.011, 10, 96), brassMat);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.045;
  base.add(band);
  const collar = new Mesh(new CylinderGeometry(0.06, 0.1, 0.07, 32), brassMat);
  collar.position.y = 0.09;
  base.add(collar);
  g.add(base);

  // Stem: cubic Bézier from the ring's south end, continuing the axis downward, easing into
  // the base vertically.
  const p0 = new Vector3(0, -(RING_RADIUS + 0.03), 0);
  const p3 = baseCenter.clone().addScaledVector(baseUp, 0.1);
  const p1 = p0.clone().add(new Vector3(0, -0.14, 0));
  const p2 = p3.clone().addScaledVector(baseUp, 0.16);
  const stem = new Mesh(new TubeGeometry(new CubicBezierCurve3(p0, p1, p2, p3), 32, 0.028, 12, false), brassMat);
  g.add(stem);

  // Key light lives in the stand rig so shading stays put while the globe spins.
  const keyLight = new DirectionalLight(theme.keyLight.color, theme.keyLight.intensity);
  keyLight.position.set(-2.5, 3.5, 4.5);
  g.add(keyLight);
  g.add(keyLight.target);

  return { group: g, brassMat, woodMat, keyLight };
}

/**
 * @param makeMap builds the equirectangular map canvas; receives the GPU's max texture size so the
 *                caller can pick 8192 vs 4096 before rasterising.
 * @param theme   colours for the initial paint. Everything a theme touches later (both materials
 *                and all three lights) is returned on the GlobeScene so it can be mutated in place.
 */
export function createGlobeScene(
  container: HTMLElement,
  makeMap: (maxTextureSize: number) => HTMLCanvasElement,
  theme: GlobeTheme,
): GlobeScene {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const mapCanvas = makeMap(renderer.capabilities.maxTextureSize);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  // Fixed pose, set once. `camera.up` stays world +Y, which is where STAND_UP lands, so the
  // base is upright on screen without a roll. Only `position` moves after this, and only
  // along VIEW_DIR.
  const camera = new PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.copy(VIEW_TARGET).addScaledVector(VIEW_DIR, DEFAULT_DISTANCE);
  camera.lookAt(VIEW_TARGET);

  const rig = new Group();
  rig.rotation.z = -TILT; // rotates local +Y onto AXIS
  scene.add(rig);

  const globeSpin = new Group();
  globeSpin.name = 'globeSpin';
  rig.add(globeSpin);

  const mapTexture = new CanvasTexture(mapCanvas);
  mapTexture.colorSpace = SRGBColorSpace;
  mapTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // Varnished paper, not plastic. A flat roughness with no bump map returns light perfectly
  // evenly, which is exactly what made this read as a computer drawing; surface.ts supplies
  // the fibre relief, the patchy gloss and the clearcoat. `color` multiplies the map texture.
  const sphereMat = new MeshPhysicalMaterial({ map: mapTexture, color: theme.sphereTint });
  applySurfaceMaterial(sphereMat, theme);
  const sphere = new Mesh(new SphereGeometry(GLOBE_RADIUS, 128, 96), sphereMat);
  globeSpin.add(sphere);

  const stand = buildStand(theme);
  const standRig = stand.group;
  rig.add(standRig);

  // Fill: warm sky / dusty ground hemisphere along the screen-up direction, plus a whisper of ambient.
  const hemiLight = new HemisphereLight(theme.hemiLight.sky, theme.hemiLight.ground, theme.hemiLight.intensity);
  hemiLight.position.copy(STAND_UP);
  standRig.add(hemiLight);
  const ambientLight = new AmbientLight(0xffffff, theme.ambient);
  scene.add(ambientLight);

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  function dispose(): void {
    scene.traverse((obj: Object3D) => {
      const mesh = obj as Partial<Mesh>;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m: Material) => m.dispose());
      else mat?.dispose();
    });
    mapTexture.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    renderer,
    scene,
    camera,
    rig,
    globeSpin,
    standRig,
    sphere,
    mapTexture,
    brassMat: stand.brassMat,
    woodMat: stand.woodMat,
    keyLight: stand.keyLight,
    hemiLight,
    ambientLight,
    resize,
    dispose,
  };
}
