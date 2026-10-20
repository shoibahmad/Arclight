import * as THREE from 'three';

/**
 * Environment themes.
 *
 * A theme is the whole look of a location in one object: sky, light rig, fog,
 * colour grade, the palettes the procedural texture generators are seeded with,
 * and which scenery builder runs. Tracks name a theme; nothing else in the game
 * hard-codes a colour.
 *
 * Light intensities are in the same arbitrary-but-consistent space the post
 * chain tone-maps from, so changing one theme never requires re-grading another.
 */

export const THEMES = {
  /** High desert at the end of the day. Warm, dusty, long shadows. */
  ridge: {
    id: 'ridge',
    name: 'Copperline Ridge',
    sunDirection: new THREE.Vector3(-0.44, 0.38, 0.81),
    sky: {
      zenith: 0x3a5f96,
      horizon: 0xd98a58,
      ground: 0x241a15,
      sunColour: 0xffc27a,
      sunIntensity: 11,
      sunSize: 0.032,
      haze: 0.85,
      cloudiness: 0.3,
      stars: 0,
    },
    sun: { colour: 0xffbe84, intensity: 3.1 },
    ambient: { sky: 0x6f8dc4, ground: 0x4a2f1e, intensity: 0.85 },
    fog: { colour: 0xbf8763, density: 0.0019 },
    grade: { exposure: 1.0, bloomStrength: 0.5, saturation: 1.06, tint: 0xfff3e8, vignette: 0.8 },
    surfaces: {
      road: { base: 0x22252c, accent: 0x3a3630, seed: 11 },
      kerb: { a: 0xe4e0d4, b: 0xb8452f },
      panel: { base: 0x4a4138, seed: 5 },
      terrain: { style: 'rock', tint: 0x8a6243, seed: 3 },
    },
    /** Emissive trim colour: track edges, gate frames, boost pads. */
    accent: 0x4ad6ff,
    accentWarm: 0xffb347,
    decor: 'canyon',
    horizonHaze: 0xe8a06a,
  },

  /** Rain-slick night city. The only theme where the ground is brighter than the sky. */
  nocturne: {
    id: 'nocturne',
    name: 'Nocturne District',
    sunDirection: new THREE.Vector3(0.34, 0.52, -0.78),
    sky: {
      zenith: 0x05070f,
      horizon: 0x1a1430,
      ground: 0x05060a,
      sunColour: 0x9fb4ff,
      sunIntensity: 2.0,
      sunSize: 0.02,
      haze: 0.5,
      cloudiness: 0.25,
      stars: 0.75,
    },
    sun: { colour: 0x8fa6ff, intensity: 0.75 },
    ambient: { sky: 0x2a3a6b, ground: 0x160e22, intensity: 0.55 },
    fog: { colour: 0x120d22, density: 0.0042 },
    grade: { exposure: 1.12, bloomStrength: 0.78, saturation: 1.14, tint: 0xeaf0ff, vignette: 0.95 },
    surfaces: {
      road: { base: 0x14161e, accent: 0x242b3d, seed: 21 },
      kerb: { a: 0xdfe6f2, b: 0x2f6ad0 },
      panel: { base: 0x262b39, seed: 13 },
      terrain: { style: 'rock', tint: 0x2a2f3d, seed: 9 },
    },
    accent: 0xff3d7f,
    accentWarm: 0x29e0ff,
    decor: 'city',
    horizonHaze: 0x2a1f4a,
  },

  /** Blue hour over a glacier. Flat, cold light; the ice does the work. */
  hollow: {
    id: 'hollow',
    name: 'Vaskr Hollow',
    sunDirection: new THREE.Vector3(0.58, 0.36, 0.73),
    sky: {
      zenith: 0x2a4f80,
      horizon: 0x9fc2d8,
      ground: 0x1b2733,
      sunColour: 0xdce9ff,
      sunIntensity: 7,
      sunSize: 0.028,
      haze: 0.95,
      cloudiness: 0.42,
      stars: 0.12,
    },
    sun: { colour: 0xcfe2ff, intensity: 2.0 },
    ambient: { sky: 0x9ec6e8, ground: 0x2d3b4d, intensity: 1.15 },
    fog: { colour: 0xa8c4d8, density: 0.0028 },
    grade: { exposure: 1.04, bloomStrength: 0.62, saturation: 0.95, tint: 0xf0f6ff, vignette: 0.75 },
    surfaces: {
      road: { base: 0x1d2330, accent: 0x33404f, seed: 31 },
      kerb: { a: 0xeef4fa, b: 0x1f7d8c },
      panel: { base: 0x3b4654, seed: 17 },
      terrain: { style: 'ice', tint: 0x9dc4dd, seed: 7 },
    },
    accent: 0x7affd8,
    accentWarm: 0xffe9a8,
    decor: 'glacier',
    horizonHaze: 0xb9d4e6,
  },
};

export function getTheme(id) {
  const theme = THEMES[id];
  if (!theme) {
    console.warn(`[themes] unknown theme "${id}", falling back to ridge`);
    return THEMES.ridge;
  }
  return theme;
}

export const THEME_IDS = Object.keys(THEMES);
