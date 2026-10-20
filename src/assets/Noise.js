import { makeRng } from '../core/MathUtil.js';

/**
 * Noise functions used to author textures and scatter scenery.
 *
 * Everything here is seeded and deterministic: the same track must produce
 * byte-identical textures on every load, otherwise a player's ghost lap would
 * be racing on a subtly different-looking circuit to the one they recorded on.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export class Noise {
  constructor(seed = 1337) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates with the seeded generator.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  /** 2D simplex noise, roughly -1..1. */
  simplex2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;

    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = GRAD2[this.permMod8[ii + this.perm[jj]]];
      t0 *= t0;
      n += t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = GRAD2[this.permMod8[ii + i1 + this.perm[jj + j1]]];
      t1 *= t1;
      n += t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = GRAD2[this.permMod8[ii + 1 + this.perm[jj + 1]]];
      t2 *= t2;
      n += t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * n;
  }

  /** Fractal sum. Returns roughly -1..1. */
  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.simplex2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — sharp creases, good for rock and ice. */
  ridged(x, y, octaves = 4, lacunarity = 2.1, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex2(x * freq, y * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Tileable fbm: sampled on a torus in 4D would be ideal, but blending four
   * offset copies is cheap, artefact-free at these frequencies, and keeps the
   * whole generator two-dimensional.
   */
  tileableFbm(u, v, size, octaves = 4) {
    const a = this.fbm(u, v, octaves);
    const b = this.fbm(u - size, v, octaves);
    const c = this.fbm(u, v - size, octaves);
    const d = this.fbm(u - size, v - size, octaves);
    const wu = u / size;
    const wv = v / size;
    return (
      a * (1 - wu) * (1 - wv) +
      b * wu * (1 - wv) +
      c * (1 - wu) * wv +
      d * wu * wv
    );
  }
}

/**
 * Worley / cellular noise. Returns the distance to the nearest feature point,
 * normalised so 0 is dead-centre of a cell and ~1 is a cell boundary.
 */
export function worley2(x, y, seed = 7) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let nearest = 8;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      // Hash the cell to a stable feature point.
      let h = (cx * 374761393 + cy * 668265263 + seed * 2654435761) | 0;
      h = (h ^ (h >> 13)) * 1274126177;
      h = h ^ (h >> 16);
      const fx = cx + ((h & 0xffff) / 65535);
      const fy = cy + (((h >> 16) & 0xffff) / 65535);
      const d = Math.hypot(x - fx, y - fy);
      if (d < nearest) nearest = d;
    }
  }
  return Math.min(nearest, 1);
}
