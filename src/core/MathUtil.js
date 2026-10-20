/** Small numeric helpers shared across the simulation. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, inA, inB, outA, outB) => lerp(outA, outB, clamp01(invLerp(inA, inB, v)));
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent approach toward a target.
 *
 * A plain `lerp(current, target, 0.1)` per frame moves twice as fast at 120fps
 * as it does at 60. This converges at the same real-world rate regardless:
 * `smoothing` is the fraction of remaining distance left after one second.
 */
export function damp(current, target, smoothing, dt) {
  return lerp(target, current, Math.exp(Math.log(smoothing) * dt));
}

/** Move toward a target by at most `maxDelta`. Never overshoots. */
export function moveTowards(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Signed shortest rotation from `from` to `to`. */
export const deltaAngle = (from, to) => wrapAngle(to - from);

/** Deadzone with rescaling, so the first active input is still small. */
export function deadzone(v, threshold = 0.18) {
  const m = Math.abs(v);
  if (m < threshold) return 0;
  return Math.sign(v) * ((m - threshold) / (1 - threshold));
}

/** Format seconds as m:ss.mmm — the canonical lap-time layout. */
export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Format a time delta as +/-s.mmm, for split comparisons. */
export function formatDelta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.abs(seconds);
  return `${seconds < 0 ? '-' : '+'}${s.toFixed(3)}`;
}

/**
 * Mulberry32. Tiny, fast, good enough statistically for scenery scatter and
 * AI jitter — and crucially seedable, so a track looks identical every load.
 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(rng.range(lo, hi + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  return rng;
}
