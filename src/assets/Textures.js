import * as THREE from 'three';
import { Noise, worley2 } from './Noise.js';
import { clamp01, smoothstep } from '../core/MathUtil.js';

/**
 * Every texture in the game is generated here, at load time, from noise and
 * canvas drawing. Nothing is loaded from disk.
 *
 * Surfaces are produced as a pair: an albedo map and a packed ORM map
 * (R = ambient occlusion, G = roughness, B = metalness), which is the layout
 * three's MeshStandardMaterial already expects when you hand the same texture
 * to aoMap/roughnessMap/metalnessMap. One upload instead of three.
 */

const cache = new Map();

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function canvasTexture(canvas, { repeat = 1, anisotropy = 8, srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function dataTexture(data, size, { srgb = false, channels = 4 } = {}) {
  const format = channels === 4 ? THREE.RGBAFormat : THREE.RedFormat;
  const tex = new THREE.DataTexture(data, size, size, format);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel a height field into a tangent-space normal map.
 * Wraps at the edges so the result tiles as cleanly as its input does.
 */
function normalFromHeight(height, size, strength = 2.2) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;

      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return dataTexture(data, size);
}

function packORM(ao, rough, metal, size) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = clamp01(ao[i]) * 255;
    data[i * 4 + 1] = clamp01(rough[i]) * 255;
    data[i * 4 + 2] = clamp01(metal[i]) * 255;
    data[i * 4 + 3] = 255;
  }
  return dataTexture(data, size);
}

function hexToRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// --------------------------------------------------------------- surfaces

/**
 * Track running surface: a dark composite deck broken into panels, with
 * longitudinal brushing from traffic and worn patches at the panel edges.
 */
export function roadSurface({ seed = 11, base = 0x1b2028, accent = 0x2c3542, size = 512 } = {}) {
  const key = `road:${seed}:${base}:${accent}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const noise = new Noise(seed);
  const albedo = createCanvas(size, size);
  const ctx = albedo.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(size, size);
  const px = image.data;

  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);

  const [br, bg, bb] = hexToRgb(base);
  const [ar, ag, ab] = hexToRgb(accent);

  // Panel grid: 4 across, 8 along, so the seams read as travelling under you.
  const PANELS_X = 4;
  const PANELS_Y = 8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;

      const gx = (u * PANELS_X) % 1;
      const gy = (v * PANELS_Y) % 1;
      const seamX = Math.min(gx, 1 - gx);
      const seamY = Math.min(gy, 1 - gy);
      const seam = 1 - smoothstep(0.0, 0.035, Math.min(seamX, seamY));

      // Per-panel tonal variation so the deck is not a flat field.
      const panelId = Math.floor(u * PANELS_X) * 31 + Math.floor(v * PANELS_Y) * 17;
      const panelTone = ((Math.sin(panelId * 12.9898) * 43758.5453) % 1 + 1) % 1;

      const grain = noise.tileableFbm(u * 18, v * 18, 18, 4) * 0.5 + 0.5;
      // Stretched along V: wear from craft travelling the same direction.
      const brush = noise.tileableFbm(u * 60, v * 6, 60, 3) * 0.5 + 0.5;
      const wear = smoothstep(0.42, 0.95, noise.tileableFbm(u * 5, v * 5, 5, 3) * 0.5 + 0.5);

      let shade = 0.82 + panelTone * 0.2 + (grain - 0.5) * 0.22 + (brush - 0.5) * 0.14;
      shade *= 1 - seam * 0.55;

      const wearMix = wear * 0.5;
      const r = (br * (1 - wearMix) + ar * wearMix) * shade;
      const g = (bg * (1 - wearMix) + ag * wearMix) * shade;
      const b = (bb * (1 - wearMix) + ab * wearMix) * shade;

      const o = i * 4;
      px[o] = clamp01(r) * 255;
      px[o + 1] = clamp01(g) * 255;
      px[o + 2] = clamp01(b) * 255;
      px[o + 3] = 255;

      height[i] = grain * 0.35 + brush * 0.2 - seam * 0.85;
      ao[i] = 1 - seam * 0.7;
      // Worn centre line is polished smooth; panel edges stay matte.
      rough[i] = clamp01(0.82 - wear * 0.34 + (grain - 0.5) * 0.12 + seam * 0.1);
      metal[i] = 0.12 + wear * 0.18;
    }
  }

  ctx.putImageData(image, 0, 0);

  const result = {
    map: canvasTexture(albedo, { repeat: 1 }),
    normalMap: normalFromHeight(height, size, 1.6),
    ormMap: packORM(ao, rough, metal, size),
  };
  cache.set(key, result);
  return result;
}

/** Hazard kerb: angled stripes with a chamfered, scuffed top. */
export function kerbSurface({ a = 0xd8dde4, b = 0xc8392b, size = 256, stripes = 8 } = {}) {
  const key = `kerb:${a}:${b}:${size}:${stripes}`;
  if (cache.has(key)) return cache.get(key);

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const colA = `#${new THREE.Color(a).getHexString()}`;
  const colB = `#${new THREE.Color(b).getHexString()}`;

  ctx.fillStyle = colA;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = colB;
  const band = size / stripes;
  for (let i = 0; i < stripes; i += 2) {
    ctx.fillRect(0, i * band, size, band);
  }

  // Scuffs: the kerb is the part of the circuit that gets hit.
  const noise = new Noise(91);
  const image = ctx.getImageData(0, 0, size, size);
  const px = image.data;
  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;
      const grime = noise.tileableFbm(u * 14, v * 14, 14, 4) * 0.5 + 0.5;
      const scuff = smoothstep(0.55, 0.95, noise.tileableFbm(u * 7, v * 30, 7, 3) * 0.5 + 0.5);
      const shade = 0.78 + grime * 0.3 - scuff * 0.25;

      const o = i * 4;
      px[o] *= shade;
      px[o + 1] *= shade;
      px[o + 2] *= shade;

      height[i] = grime * 0.4;
      ao[i] = 1 - scuff * 0.3;
      rough[i] = clamp01(0.55 + grime * 0.3 + scuff * 0.2);
      metal[i] = 0.05;
    }
  }
  ctx.putImageData(image, 0, 0);

  const result = {
    map: canvasTexture(canvas),
    normalMap: normalFromHeight(height, size, 1.1),
    ormMap: packORM(ao, rough, metal, size),
  };
  cache.set(key, result);
  return result;
}

/** Structural panelling for barriers, pylons and tunnel linings. */
export function panelSurface({ seed = 5, base = 0x323a46, size = 512, rivets = true } = {}) {
  const key = `panel:${seed}:${base}:${size}:${rivets}`;
  if (cache.has(key)) return cache.get(key);

  const noise = new Noise(seed);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(size, size);
  const px = image.data;

  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);

  const [br, bg, bb] = hexToRgb(base);
  const CELLS = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;

      const cx = (u * CELLS) % 1;
      const cy = (v * CELLS) % 1;
      const edge = Math.min(Math.min(cx, 1 - cx), Math.min(cy, 1 - cy));
      const channel = 1 - smoothstep(0.02, 0.07, edge);

      // Four bolts per cell, inset from the corners.
      let rivet = 0;
      if (rivets) {
        const corner = Math.min(
          Math.hypot(cx - 0.12, cy - 0.12),
          Math.hypot(cx - 0.88, cy - 0.12),
          Math.hypot(cx - 0.12, cy - 0.88),
          Math.hypot(cx - 0.88, cy - 0.88)
        );
        rivet = 1 - smoothstep(0.012, 0.03, corner);
      }

      const grain = noise.tileableFbm(u * 24, v * 24, 24, 4) * 0.5 + 0.5;
      const streak = noise.tileableFbm(u * 4, v * 40, 4, 3) * 0.5 + 0.5;
      const stain = smoothstep(0.5, 0.9, noise.tileableFbm(u * 3, v * 3, 3, 4) * 0.5 + 0.5);

      const shade =
        (0.85 + (grain - 0.5) * 0.25 + (streak - 0.5) * 0.1) *
        (1 - channel * 0.45) *
        (1 - stain * 0.22) +
        rivet * 0.18;

      const o = i * 4;
      px[o] = clamp01(br * shade) * 255;
      px[o + 1] = clamp01(bg * shade) * 255;
      px[o + 2] = clamp01(bb * shade) * 255;
      px[o + 3] = 255;

      height[i] = grain * 0.25 - channel * 0.9 + rivet * 0.8;
      ao[i] = 1 - channel * 0.65;
      rough[i] = clamp01(0.42 + stain * 0.35 + (grain - 0.5) * 0.14 - rivet * 0.15);
      metal[i] = clamp01(0.75 - stain * 0.4 + rivet * 0.2);
    }
  }

  ctx.putImageData(image, 0, 0);

  const result = {
    map: canvasTexture(canvas),
    normalMap: normalFromHeight(height, size, 2.4),
    ormMap: packORM(ao, rough, metal, size),
  };
  cache.set(key, result);
  return result;
}

/** Natural terrain: `style` picks the fracture pattern and palette response. */
export function terrainSurface({ seed = 3, style = 'rock', tint = 0x6b5a46, size = 512 } = {}) {
  const key = `terrain:${seed}:${style}:${tint}:${size}`;
  if (cache.has(key)) return cache.get(key);

  const noise = new Noise(seed);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(size, size);
  const px = image.data;

  const height = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);

  const [tr, tg, tb] = hexToRgb(tint);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size;
      const v = y / size;

      const broad = noise.tileableFbm(u * 4, v * 4, 4, 5) * 0.5 + 0.5;
      const detail = noise.tileableFbm(u * 26, v * 26, 26, 4) * 0.5 + 0.5;
      const cells = worley2(u * 9, v * 9, seed);

      let h;
      let shade;
      let roughness;
      if (style === 'ice') {
        // Fracture planes: sharp cell boundaries, smooth polished faces.
        const fracture = smoothstep(0.0, 0.14, cells);
        h = broad * 0.5 + fracture * 0.5 + detail * 0.08;
        shade = 0.62 + fracture * 0.4 + broad * 0.22;
        roughness = 0.1 + (1 - fracture) * 0.35 + detail * 0.1;
      } else if (style === 'sand') {
        // Wind ripples: high frequency on one axis only.
        const ripple = Math.sin((u * 90 + noise.tileableFbm(u * 5, v * 5, 5, 2) * 6)) * 0.5 + 0.5;
        h = broad * 0.6 + ripple * 0.25 + detail * 0.15;
        shade = 0.72 + broad * 0.3 + ripple * 0.12;
        roughness = 0.85 + detail * 0.12;
      } else {
        const ridges = noise.ridged(u * 7, v * 7, 5);
        h = ridges * 0.7 + detail * 0.3;
        shade = 0.5 + ridges * 0.55 + (detail - 0.5) * 0.25;
        roughness = 0.72 + (1 - ridges) * 0.2;
      }

      const o = i * 4;
      px[o] = clamp01(tr * shade) * 255;
      px[o + 1] = clamp01(tg * shade) * 255;
      px[o + 2] = clamp01(tb * shade) * 255;
      px[o + 3] = 255;

      height[i] = h;
      ao[i] = clamp01(0.35 + h * 0.75);
      rough[i] = clamp01(roughness);
      metal[i] = style === 'ice' ? 0.04 : 0.0;
    }
  }

  ctx.putImageData(image, 0, 0);

  const result = {
    map: canvasTexture(canvas),
    normalMap: normalFromHeight(height, size, style === 'ice' ? 3.2 : 2.6),
    ormMap: packORM(ao, rough, metal, size),
  };
  cache.set(key, result);
  return result;
}

// ----------------------------------------------------------------- sprites

/** Soft radial falloff, used for thruster cores, sparks and light blooms. */
export function glowSprite(size = 128, power = 2.4) {
  const key = `glow:${size}:${power}`;
  if (cache.has(key)) return cache.get(key);

  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - d, power);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = clamp01(a) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Night sky: stars with a dusty band of galaxy across the middle. */
export function starfield({ size = 1024, seed = 4, density = 0.00035, band = true } = {}) {
  const key = `stars:${size}:${seed}:${density}:${band}`;
  if (cache.has(key)) return cache.get(key);

  const noise = new Noise(seed);
  const canvas = createCanvas(size, size / 2);
  const h = size / 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, size, h);

  if (band) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < size; x += 2) {
        const u = x / size;
        const v = y / h;
        const toBand = Math.abs(v - 0.52);
        const bandMask = Math.pow(Math.max(0, 1 - toBand * 5.5), 2);
        if (bandMask <= 0.001) continue;
        const dust = (noise.fbm(u * 9, v * 24, 5) * 0.5 + 0.5) * bandMask;
        ctx.fillStyle = `rgba(${110 + dust * 60}, ${120 + dust * 50}, ${170 + dust * 60}, ${dust * 0.22})`;
        ctx.fillRect(x, y, 2, 1);
      }
    }
  }

  const count = Math.floor(size * h * density);
  for (let i = 0; i < count; i++) {
    // Deterministic placement from the same noise field.
    const rx = (noise.simplex2(i * 0.731, 11.3) * 0.5 + 0.5) * size;
    const ry = (noise.simplex2(7.1, i * 0.917) * 0.5 + 0.5) * h;
    const mag = Math.pow(noise.simplex2(i * 1.37, i * 0.21) * 0.5 + 0.5, 3);
    const r = 0.35 + mag * 1.5;
    const warmth = noise.simplex2(i * 0.11, 3.7) * 0.5 + 0.5;
    const cr = 200 + warmth * 55;
    const cb = 255 - warmth * 60;
    ctx.fillStyle = `rgba(${cr}, ${215 + mag * 40}, ${cb}, ${0.35 + mag * 0.65})`;
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Small tiling noise used by shaders for shimmer and dissolve. */
export function noiseTexture(size = 128, seed = 17) {
  const key = `noisetex:${size}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const noise = new Noise(seed);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      data[i] = (noise.tileableFbm(u * 8, v * 8, 8, 3) * 0.5 + 0.5) * 255;
      data[i + 1] = (noise.tileableFbm(u * 16 + 31, v * 16, 16, 3) * 0.5 + 0.5) * 255;
      data[i + 2] = worley2(u * 6, v * 6, seed) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = dataTexture(data, size);
  cache.set(key, tex);
  return tex;
}

/** Dispose every generated texture. Called when the whole game shuts down. */
export function disposeAll() {
  for (const entry of cache.values()) {
    if (entry instanceof THREE.Texture) entry.dispose();
    else for (const tex of Object.values(entry)) tex?.dispose?.();
  }
  cache.clear();
}
