import * as THREE from 'three';
import { clamp, lerp, TAU, DEG } from '../core/MathUtil.js';

/**
 * Turns a corner-by-corner description of a circuit into control nodes.
 *
 * Circuits are described the way a track is actually described — "420 metres
 * of straight, then a 95 degree right at 120 metre radius, banked 12, climbing
 * 14" — rather than as a list of world coordinates. Raw coordinates are
 * miserable to tune: moving one apex means re-deriving every point after it,
 * and it is almost impossible to tell from the numbers whether a corner is
 * fast or slow.
 *
 * Segment forms:
 *   { straight: metres, rise?, width?, bank?, name? }
 *   { turn: degrees, radius: metres, rise?, width?, bank?, name? }
 *
 * `turn` is positive for a left-hander. `width` and `bank` are the values at
 * the END of the segment and are interpolated from whatever came before, so a
 * corner can ease its banking in over its entry.
 *
 * A hand-written loop will not close exactly, so the builder squares it up in
 * two steps. Heading is normalised to a whole revolution by scaling every
 * corner by the same small factor. The remaining positional gap is then closed
 * by nudging the straights.
 *
 * That second step is exact rather than approximate. Once the corner angles
 * are fixed, every segment's displacement is linear in one number — a
 * straight in its length, an arc in its radius (the chord is
 * 2R.sin(theta/2) along a fixed heading). So closing the loop is a
 * two-equation least-squares problem over all of them at once, and the
 * minimum-norm solution spreads the correction in proportion to how much
 * each segment actually points along the gap.
 *
 * Straights are weighted far more heavily than radii, because lengthening a
 * straight by 10% changes almost nothing about how a circuit drives while
 * tightening a corner by 10% changes it a great deal. Corner *angles* are
 * never touched after the heading pass, so the sequence of lefts and rights
 * is exactly what was written down.
 */

const NODE_SPACING = 32;

export class LayoutError extends Error {}

/**
 * @param {Array} segments
 * @param {{start?: THREE.Vector3, heading?: number, width?: number, nodeSpacing?: number}} options
 */
export function buildLayout(segments, options = {}) {
  const {
    start = [0, 0, 0],
    heading = 0,
    width = 20,
    bank = 0,
    nodeSpacing = NODE_SPACING,
    closeWarnMetres = 45,
  } = options;

  if (!Array.isArray(segments) || segments.length < 3) {
    throw new LayoutError('a layout needs at least three segments');
  }

  // Pass 1: normalise the turn angles so the heading closes on exactly one
  // revolution. Scaling every corner by the same small factor preserves the
  // relative character of the circuit; forcing the error into a single corner
  // would not.
  let totalTurn = 0;
  for (const seg of segments) if (seg.turn) totalTurn += seg.turn;

  const revolutions = Math.round(totalTurn / 360);
  if (revolutions === 0) {
    throw new LayoutError(
      `layout turns a net ${totalTurn.toFixed(1)} degrees; a closed circuit needs ~±360`
    );
  }
  const turnScale = (revolutions * 360) / totalTurn;
  if (Math.abs(turnScale - 1) > 0.15) {
    throw new LayoutError(
      `layout turns ${totalTurn.toFixed(1)} degrees, too far from ${revolutions * 360} to correct`
    );
  }

  // Pass 2: a dry walk recording how each segment's displacement responds to
  // its one free number, and measuring how far the authored layout misses by.
  const variables = [];
  let closureGap = [0, 0];
  {
    let yaw = heading * DEG;
    let x = 0;
    let z = 0;
    for (let index = 0; index < segments.length; index++) {
      const seg = segments[index];
      if (seg.straight != null) {
        // d(position)/d(length) is just the heading.
        variables.push({
          index,
          kind: 'straight',
          value: seg.straight,
          dx: Math.sin(yaw),
          dz: Math.cos(yaw),
          maxFraction: 0.22,
          min: 25,
          weight: 1,
        });
        x += Math.sin(yaw) * seg.straight;
        z += Math.cos(yaw) * seg.straight;
      } else {
        const angle = seg.turn * turnScale * DEG;
        // The whole arc's chord is 2R.sin(|theta|/2) at the mean heading, so
        // d(position)/d(radius) is that expression with R divided out.
        const unitChord = 2 * Math.sin(Math.abs(angle) / 2);
        const midYaw = yaw + angle / 2;
        variables.push({
          index,
          kind: 'turn',
          value: seg.radius,
          dx: Math.sin(midYaw) * unitChord,
          dz: Math.cos(midYaw) * unitChord,
          maxFraction: 0.18,
          min: 45,
          weight: 0.3,
        });
        x += Math.sin(midYaw) * unitChord * seg.radius;
        z += Math.cos(midYaw) * unitChord * seg.radius;
        yaw += angle;
      }
    }
    closureGap = [x, z];
  }

  const adjusted = solveClosure(variables, closureGap);

  // Pass 3: walk the centreline for real, emitting nodes.
  const raw = [];
  // Track data files describe the origin as a plain array so they stay free of
  // three.js imports and remain readable as pure data.
  const cursor = Array.isArray(start) ? new THREE.Vector3(...start) : start.clone();
  let yaw = heading * DEG;
  let currentWidth = width;
  let currentBank = bank;
  let travelled = 0;

  const push = (position, w, b, name, isCorner) => {
    raw.push({ position: position.clone(), width: w, bank: b, distance: travelled, name, isCorner });
  };
  push(cursor, currentWidth, currentBank, null, false);

  for (const seg of segments) {
    const endWidth = seg.width ?? currentWidth;
    const endBank = seg.bank ?? 0;
    const rise = seg.rise ?? 0;

    if (seg.straight != null) {
      const length = adjusted.values[segments.indexOf(seg)];
      if (!(length > 0)) throw new LayoutError(`straight must be positive, got ${length}`);
      const steps = Math.max(1, Math.round(length / nodeSpacing));
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const step = (length / steps);
        cursor.x += dx * step;
        cursor.z += dz * step;
        cursor.y += rise / steps;
        travelled += step;
        push(cursor, lerp(currentWidth, endWidth, f), lerp(currentBank, endBank, f), seg.name, false);
      }
    } else if (seg.turn != null) {
      const radius = adjusted.values[segments.indexOf(seg)];
      if (!(radius > 0)) throw new LayoutError(`turn needs a positive radius, got ${radius}`);
      const angle = seg.turn * turnScale * DEG;
      const arc = Math.abs(angle) * radius;
      const steps = Math.max(2, Math.round(arc / nodeSpacing));

      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const dAngle = angle / steps;
        // Step along the chord, then rotate: equivalent to integrating the
        // arc, and it keeps the node spacing even around the corner.
        const chord = 2 * radius * Math.sin(Math.abs(dAngle) / 2);
        const midYaw = yaw + dAngle / 2;
        cursor.x += Math.sin(midYaw) * chord;
        cursor.z += Math.cos(midYaw) * chord;
        cursor.y += rise / steps;
        yaw += dAngle;
        travelled += chord;
        push(cursor, lerp(currentWidth, endWidth, f), lerp(currentBank, endBank, f), seg.name, true);
      }
    } else {
      throw new LayoutError('segment must specify either `straight` or `turn`');
    }

    currentWidth = endWidth;
    currentBank = endBank;
  }

  // The final node lands on (or very near) the first; drop it and let the
  // spline close the loop.
  const last = raw.pop();
  const gap = new THREE.Vector3().subVectors(last.position, raw[0].position);
  gap.y = 0; // elevation is squared up separately, by levelLayout()
  const gapLength = gap.length();
  const totalLength = travelled;

  // Anything the solver could not remove, because a straight hit its bound,
  // is small enough to absorb by easing the nodes back toward the start.
  if (gapLength > 1e-3) {
    for (const node of raw) {
      node.position.addScaledVector(gap, -(node.distance / totalLength));
    }
  }

  const report = {
    length: totalLength,
    gap: gapLength,
    rawGap: Math.hypot(closureGap[0], closureGap[1]),
    turnScale,
    straightAdjust: adjusted.maxStraight,
    radiusAdjust: adjusted.maxRadius,
    clamped: adjusted.clamped,
    nodeCount: raw.length,
  };

  if (gapLength > closeWarnMetres) {
    console.warn(
      `[layout] ${totalLength.toFixed(0)}m circuit still closes ${gapLength.toFixed(1)}m out ` +
        'after adjusting the straights; the residual will skew the shape'
    );
  }

  return {
    nodes: raw.map((n) => ({
      position: n.position,
      width: n.width,
      bank: n.bank,
      name: n.name,
      isCorner: n.isCorner,
    })),
    report,
  };
}

/**
 * Close the loop.
 *
 * Each variable contributes `(dx, dz) * value` to the finishing position, so
 * with A the 2xN matrix of those gradients we want a change dv satisfying
 * `A dv = -gap`. That is underdetermined, and the minimum-norm solution is
 * `dv = -A^T (A A^T)^-1 gap`, with A A^T only 2x2 — a closed form, not a
 * search.
 *
 * Weights bias which variables absorb the error: substituting dv = W y and
 * solving for the minimum-norm y means a variable with twice the weight moves
 * four times as far. Straights carry weight 1 and corner radii 0.3, so a
 * circuit is stretched rather than reshaped.
 *
 * Bounds are enforced by freezing any variable that hits its limit and
 * re-solving over what is left.
 */
function solveClosure(variables, gap) {
  const n = variables.length;
  const result = variables.map((v) => v.value);
  if (n === 0) return { values: result, maxStraight: 0, maxRadius: 0, clamped: false };

  const free = new Array(n).fill(true);
  let residual = [gap[0], gap[1]];
  let clamped = false;

  for (let pass = 0; pass < 6; pass++) {
    let m00 = 0;
    let m01 = 0;
    let m11 = 0;
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const w = variables[i].weight * variables[i].weight;
      m00 += variables[i].dx * variables[i].dx * w;
      m01 += variables[i].dx * variables[i].dz * w;
      m11 += variables[i].dz * variables[i].dz * w;
    }
    const det = m00 * m11 - m01 * m01;
    if (Math.abs(det) < 1e-9) break;

    const ix = (m11 * residual[0] - m01 * residual[1]) / det;
    const iz = (m00 * residual[1] - m01 * residual[0]) / det;

    let anyClamped = false;
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      const v = variables[i];
      const delta = -(v.dx * ix + v.dz * iz) * v.weight * v.weight;
      const limit = v.value * v.maxFraction;
      let next = result[i] + delta;
      if (Math.abs(next - v.value) > limit || next < v.min) {
        next = Math.max(v.min, v.value + Math.sign(delta || 1) * limit);
        free[i] = false;
        anyClamped = true;
        clamped = true;
      }
      result[i] = next;
    }

    let x = gap[0];
    let z = gap[1];
    for (let i = 0; i < n; i++) {
      x += variables[i].dx * (result[i] - variables[i].value);
      z += variables[i].dz * (result[i] - variables[i].value);
    }
    residual = [x, z];
    if (!anyClamped || Math.hypot(x, z) < 1e-4) break;
  }

  // Map back to a per-segment lookup, and report how hard each kind was bent.
  const values = [];
  let maxStraight = 0;
  let maxRadius = 0;
  for (let i = 0; i < n; i++) {
    const v = variables[i];
    values[v.index] = result[i];
    const moved = Math.abs(result[i] - v.value) / v.value;
    if (v.kind === 'straight') maxStraight = Math.max(maxStraight, moved);
    else maxRadius = Math.max(maxRadius, moved);
  }

  return { values, maxStraight, maxRadius, clamped };
}

/**
 * Flatten the elevation error the same way.
 * Called separately because a circuit that climbs 40m net is a design mistake
 * worth seeing, not something to silently absorb.
 */
export function levelLayout(nodes) {
  const n = nodes.length;
  const drift = nodes[n - 1].position.y - nodes[0].position.y;
  if (Math.abs(drift) < 1e-3) return 0;
  for (let i = 0; i < n; i++) {
    nodes[i].position.y -= (drift * i) / (n - 1);
  }
  return drift;
}

/** Rough bounding radius, used to place scenery and frame the minimap. */
export function layoutExtent(nodes) {
  const box = new THREE.Box3();
  for (const node of nodes) box.expandByPoint(node.position);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size, radius: Math.max(size.x, size.z) * 0.5 };
}

export { clamp, TAU };
