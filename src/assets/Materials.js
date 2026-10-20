import * as THREE from 'three';
import { roadSurface, kerbSurface, panelSurface, terrainSurface, glowSprite } from './Textures.js';

/**
 * Material factory.
 *
 * Texture *data* is cached and shared (see Textures.js); this module owns the
 * materials that wrap it. Where a caller needs different tiling from an
 * existing surface the textures are cloned — a three Texture clone shares its
 * `source`, so the image is still only uploaded to the GPU once, but repeat
 * and offset become independent. Mutating the cached texture instead would
 * silently re-tile every other surface using it.
 */

const materials = new Set();
let globalAnisotropy = 8;

export function setAnisotropy(value) {
  globalAnisotropy = Math.max(1, value | 0);
}

function prepare(texture, repeatU, repeatV, anisotropy) {
  const needsOwnTiling = repeatU !== 1 || repeatV !== 1;
  const tex = needsOwnTiling ? texture.clone() : texture;
  if (needsOwnTiling) {
    tex.repeat.set(repeatU, repeatV);
    tex.needsUpdate = true;
  }
  tex.anisotropy = Math.min(anisotropy, globalAnisotropy);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Standard PBR material from one of the generated surface sets.
 * The ORM map feeds roughness, metalness and AO from a single texture.
 */
export function surfaceMaterial(surface, options = {}) {
  const {
    repeatU = 1,
    repeatV = 1,
    anisotropy = 16,
    normalScale = 1,
    ...overrides
  } = options;

  const map = prepare(surface.map, repeatU, repeatV, anisotropy);
  const normalMap = prepare(surface.normalMap, repeatU, repeatV, anisotropy);
  const ormMap = prepare(surface.ormMap, repeatU, repeatV, anisotropy);

  const material = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    roughness: 1,
    metalness: 1,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    ...overrides,
  });
  // The generated meshes only ever carry one UV set, so AO reads channel 0
  // rather than three's default second channel.
  material.aoMap.channel = 0;

  materials.add(material);
  return material;
}

export function roadMaterial(theme) {
  return surfaceMaterial(roadSurface(theme.surfaces.road), { normalScale: 0.85, name: 'road' });
}

export function kerbMaterial(theme) {
  return surfaceMaterial(kerbSurface(theme.surfaces.kerb), { normalScale: 0.7, name: 'kerb' });
}

export function panelMaterial(theme, overrides = {}) {
  return surfaceMaterial(panelSurface(theme.surfaces.panel), {
    normalScale: 1.1,
    name: 'panel',
    ...overrides,
  });
}

export function terrainMaterial(theme, overrides = {}) {
  return surfaceMaterial(terrainSurface(theme.surfaces.terrain), {
    normalScale: 1.25,
    name: 'terrain',
    ...overrides,
  });
}

/**
 * Unlit emissive trim.
 *
 * Deliberately MeshBasicMaterial with an over-1 colour rather than a standard
 * material with an emissive term: these strips exist to feed the bloom chain,
 * and running them through the lighting path only risks them picking up
 * shadowing from the very geometry they are supposed to outline.
 */
export function emissiveMaterial(colour, intensity = 6, options = {}) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colour).multiplyScalar(intensity),
    toneMapped: false,
    fog: false,
    ...options,
  });
  materials.add(material);
  return material;
}

/** Additive sprite material for thrusters, sparks and light haze. */
export function glowMaterial(colour, intensity = 3, options = {}) {
  const material = new THREE.MeshBasicMaterial({
    map: glowSprite(),
    color: new THREE.Color(colour).multiplyScalar(intensity),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
    ...options,
  });
  materials.add(material);
  return material;
}

/** Plain shaded material for craft hulls and structural props. */
export function hullMaterial(colour, { roughness = 0.38, metalness = 0.85, ...rest } = {}) {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colour),
    roughness,
    metalness,
    ...rest,
  });
  materials.add(material);
  return material;
}

export function disposeMaterials() {
  for (const material of materials) material.dispose();
  materials.clear();
}
