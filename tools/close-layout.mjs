/**
 * Layout closing aid.
 *
 *   node --import ./tools/test/register.mjs tools/close-layout.mjs <trackId>
 *
 * When a hand-written circuit misses closure by more than the builder is
 * willing to absorb, this searches for the smallest set of changes to the
 * authored straights and radii that brings it home, and prints them for
 * pasting back into the track file.
 *
 * It deliberately prints numbers to copy rather than rewriting the data: the
 * track files are the design, and a design should not be silently edited by
 * a tool. Seeing "that 300m straight wants to be 190m" is also the fastest
 * way to understand what is wrong with the shape.
 */

import { TRACKS, loadTrack } from '../src/data/tracks/index.js';
import { DEG } from '../src/core/MathUtil.js';

const only = process.argv[2];
const ids = only ? [only] : Object.keys(TRACKS);

/** Walk a layout and return its closure error, without any correction. */
function measure(segments, heading, overrides = {}) {
  let yaw = heading * DEG;
  let x = 0;
  let z = 0;
  let total = 0;

  let turnSum = 0;
  for (const seg of segments) if (seg.turn) turnSum += seg.turn;
  const scale = (Math.round(turnSum / 360) * 360) / turnSum;

  segments.forEach((seg, i) => {
    if (seg.straight != null) {
      const length = overrides[i] ?? seg.straight;
      x += Math.sin(yaw) * length;
      z += Math.cos(yaw) * length;
      total += length;
    } else {
      const radius = overrides[i] ?? seg.radius;
      const angle = seg.turn * scale * DEG;
      const chord = 2 * radius * Math.sin(Math.abs(angle) / 2);
      const mid = yaw + angle / 2;
      x += Math.sin(mid) * chord;
      z += Math.cos(mid) * chord;
      yaw += angle;
      total += Math.abs(angle) * radius;
    }
  });

  return { gap: Math.hypot(x, z), x, z, length: total };
}

/**
 * Coordinate descent over the free numbers.
 *
 * The closure constraint is linear, so this converges in a handful of sweeps;
 * the only reason not to solve it directly is that we also want to keep the
 * changes small and respect per-segment bounds, which is easier to express as
 * a penalised search than as a constrained solve.
 */
function search(segments, heading) {
  const overrides = {};
  const bounds = segments.map((seg, i) => {
    if (seg.straight != null) return { i, base: seg.straight, lo: Math.max(40, seg.straight * 0.45), hi: seg.straight * 1.9, cost: 1 };
    return { i, base: seg.radius, lo: Math.max(50, seg.radius * 0.7), hi: seg.radius * 1.45, cost: 3.2 };
  });

  const score = () => {
    const { gap } = measure(segments, heading, overrides);
    let drift = 0;
    for (const b of bounds) {
      const value = overrides[b.i] ?? b.base;
      drift += b.cost * ((value - b.base) / b.base) ** 2;
    }
    // Closure dominates; drift is only a tiebreaker between equally valid
    // solutions, so that the smallest edit wins.
    return gap * gap + drift * 900;
  };

  let best = score();
  for (let sweep = 0; sweep < 220; sweep++) {
    const stepScale = 1 - sweep / 240;
    let improved = false;
    for (const b of bounds) {
      const current = overrides[b.i] ?? b.base;
      const step = Math.max(1, b.base * 0.06 * stepScale);
      for (const candidate of [current + step, current - step]) {
        if (candidate < b.lo || candidate > b.hi) continue;
        overrides[b.i] = candidate;
        const next = score();
        if (next < best - 1e-6) {
          best = next;
          improved = true;
        } else {
          overrides[b.i] = current;
        }
      }
    }
    if (!improved && sweep > 20) break;
  }
  return overrides;
}

for (const id of ids) {
  const data = loadTrack(id);
  if (!data) continue;

  const heading = data.layout?.heading ?? 0;
  const before = measure(data.segments, heading);
  if (before.gap / before.length < 0.015) {
    console.log(`\n${data.name}: closes to ${before.gap.toFixed(1)}m of ${before.length.toFixed(0)}m — nothing to do`);
    continue;
  }

  const overrides = search(data.segments, heading);
  const after = measure(data.segments, heading, overrides);

  console.log(`\n${data.name} (${id})`);
  console.log(`  authored miss ${before.gap.toFixed(1)}m over ${before.length.toFixed(0)}m`);
  console.log(`  suggested     ${after.gap.toFixed(1)}m over ${after.length.toFixed(0)}m`);
  console.log('  changes:');
  data.segments.forEach((seg, i) => {
    const value = overrides[i];
    if (value == null) return;
    const base = seg.straight ?? seg.radius;
    if (Math.abs(value - base) / base < 0.015) return;
    const kind = seg.straight != null ? 'straight' : 'radius  ';
    const label = seg.name ? ` (${seg.name})` : '';
    console.log(
      `    [${String(i).padStart(2)}] ${kind} ${String(Math.round(base)).padStart(4)} -> ${String(Math.round(value)).padStart(4)}${label}`
    );
  });
}
