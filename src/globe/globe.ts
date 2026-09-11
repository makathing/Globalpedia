/**
 * Renderer, camera, lights, the textured sphere and the brass-and-wood stand.
 *
 * Scene graph
 * -----------
 *   scene
 *   ├─ rig            tilted 23.5° about Z; its local +Y is the globe's spin axis
 *   │  ├─ sphere      the map (raycast target)
 *   │  ├─ highlight   translucent overlay sphere (added by highlight.ts)
 *   │  ├─ labels      label sprites (added by labels.ts)
 *   │  └─ standRig    meridian ring, pole caps, stem, base, key light
 *   └─ camera         camera.up == the tilted axis, so OrbitControls orbits around it
 *
 * The camera orbits the globe; the globe itself never rotates. To make the
 * stand look fixed while the user "spins the globe", `standRig` is rotated
 * about the axis by the camera's azimuth every frame (see index.ts), and the
 * camera is rolled so the base always appears upright on screen.
 */
import {
  AmbientLight,
  CubicBezierCurve3,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
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
import { TILT } from './math';

export const GLOBE_RADIUS = 1;
export const RING_RADIUS = 1.075;

/**
 * Direction that must appear vertical on screen, expressed in `standRig`
 * local space: world +Y at azimuth 0 (the base's up axis).
 */
export const STAND_UP = new Vector3(-Math.sin(TILT), Math.cos(TILT), 0);
/** Spin axis in world space (also the camera's up vector). */
export const AXIS = new Vector3(Math.sin(TILT), Math.cos(TILT), 0);
/**
 * Orbit target: a point on the axis a little below the globe's centre, so the default framing
 * leaves room for the base underneath. Staying on the axis keeps "orbit == spin the globe" exact.
 */
export const ORBIT_TARGET = AXIS.clone().multiplyScalar(-0.2);
/** Default camera distance from ORBIT_TARGET. */
export const DEFAULT_DISTANCE = 3.9;

export interface GlobeScene {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  rig: Group;
  standRig: Group;
  sphere: Mesh<SphereGeometry, MeshStandardMaterial>;
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
  const camera = new PerspectiveCamera(38, 1, 0.1, 50);
  camera.up.copy(AXIS);
  camera.position.copy(ORBIT_TARGET).add(new Vector3(0, 0.55, DEFAULT_DISTANCE));
  camera.lookAt(ORBIT_TARGET);

  const rig = new Group();
  rig.rotation.z = -TILT; // rotates local +Y onto AXIS
  scene.add(rig);

  const mapTexture = new CanvasTexture(mapCanvas);
  mapTexture.colorSpace = SRGBColorSpace;
  mapTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const sphere = new Mesh(
    new SphereGeometry(GLOBE_RADIUS, 128, 96),
    // Varnished paper, not plastic: mid roughness and next to no metalness.
    // `color` multiplies the map texture; 0xffffff means "no tint".
    new MeshStandardMaterial({ map: mapTexture, color: theme.sphereTint, roughness: 0.55, metalness: 0.02 }),
  );
  rig.add(sphere);

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
