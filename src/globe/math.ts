/**
 * Small geometry helpers shared by the globe files.
 *
 * Coordinate conventions
 * ----------------------
 * The sphere is a THREE.SphereGeometry with its default UV layout, which maps an
 * equirectangular image so that u = 0 is longitude -180°, u = 0.5 is the prime
 * meridian and v = 1 is the north pole. Working that layout back through
 * SphereGeometry's vertex formula gives, in the sphere's local frame:
 *
 *   x =  r · cos(lat) · cos(lon)
 *   y =  r · sin(lat)
 *   z = -r · cos(lat) · sin(lon)
 *
 * i.e. the prime meridian points at +X, 90°E points at -Z and the north pole is +Y.
 * A camera on +Z therefore sees the Americas with east on the right.
 */
import { Vector3 } from 'three';

export const DEG = Math.PI / 180;

/** Axial tilt of a classic desk globe. */
export const TILT = 23.5 * DEG;

/** Convert geographic coordinates to a point on a sphere of radius `r` (sphere-local frame). */
export function latLngToVector3(lat: number, lng: number, r: number, out = new Vector3()): Vector3 {
  const phi = lat * DEG;
  const lam = lng * DEG;
  const c = Math.cos(phi);
  return out.set(r * c * Math.cos(lam), r * Math.sin(phi), -r * c * Math.sin(lam));
}

/** Plain equirectangular projection onto a W×H raster. */
export function projectX(lon: number, width: number): number {
  return ((lon + 180) / 360) * width;
}
export function projectY(lat: number, height: number): number {
  return ((90 - lat) / 180) * height;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Hermite smoothstep: 0 below `a`, 1 above `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
