import * as THREE from 'three';
import { clamp, lerp } from '../core/MathUtil.js';

/**
 * The centreline of a circuit, resampled to uniform arc length.
 *
 * Tracks are authored as a handful of control nodes carrying a position, a
 * road width and a banking angle. Everything downstream — mesh generation,
 * physics, the AI racing line, the minimap — reads this class instead of the
 * raw nodes, and always in metres along the track rather than in spline
 * parameter space. That distinction matters: a Catmull-Rom's `t` moves at
 * wildly different speeds through tight and open corners, so anything paced
 * by `t` (AI lookahead, texture tiling, checkpoint spacing) comes out uneven.
 *
 * Frames are propagated sequentially rather than derived from world up, so a
 * steeply climbing or inverted-banked section cannot flip the road over.
 */

/** Distance in metres between resampled points. Finer costs memory, not time. */
const DEFAULT_SPACING = 2;

/** Catmull-Rom through four scalars, matching the position spline's shape. */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    ((2 * p1) +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

export class TrackSample {
  constructor() {
    this.distance = 0;
    this.position = new THREE.Vector3();
    /** Unit vector along the direction of travel. */
    this.tangent = new THREE.Vector3(0, 0, 1);
    /** Road surface normal, already banked. */
    this.normal = new THREE.Vector3(0, 1, 0);
    /**
     * Points to the right-hand edge of the road, already banked.
     * right = normal x tangent, which is the genuine right in three's
     * right-handed Y-up space. (tangent x normal gives LEFT -- easy to get
     * backwards, and it silently mirrors the grid, the minimap and every
     * overtaking decision the AI makes.)
     */
    this.right = new THREE.Vector3(1, 0, 0);
    this.width = 20;
    this.bank = 0;
    /** Signed 1/radius; positive turns left. Drives AI braking and camera lean. */
    this.curvature = 0;
    /** Rate of climb, as a fraction. */
    this.grade = 0;
  }

  copy(other) {
    this.distance = other.distance;
    this.position.copy(other.position);
    this.tangent.copy(other.tangent);
    this.normal.copy(other.normal);
    this.right.copy(other.right);
    this.width = other.width;
    this.bank = other.bank;
    this.curvature = other.curvature;
    this.grade = other.grade;
    return this;
  }
}

export class TrackPath {
  /**
   * @param {{position: THREE.Vector3, width?: number, bank?: number}[]} nodes
   * @param {{spacing?: number}} [options]
   */
  constructor(nodes, { spacing = DEFAULT_SPACING } = {}) {
    if (!Array.isArray(nodes) || nodes.length < 4) {
      throw new Error('TrackPath needs at least 4 control nodes');
    }
    this.nodes = nodes;
    this.curve = new THREE.CatmullRomCurve3(
      nodes.map((n) => n.position.clone()),
      true,
      'centripetal',
      0.5
    );

    /** @type {TrackSample[]} uniformly spaced, index 0 at the start line */
    this.samples = [];
    this.length = 0;
    this.spacing = spacing;

    this._build(spacing);
  }

  get count() {
    return this.samples.length;
  }

  _build(spacing) {
    // 1. Dense walk of the curve to measure true arc length.
    const dense = Math.max(512, this.nodes.length * 48);
    const densePoints = [];
    const cumulative = [0];
    const scratch = new THREE.Vector3();
    let total = 0;

    for (let i = 0; i <= dense; i++) {
      const t = i / dense;
      const p = this.curve.getPoint(t, new THREE.Vector3());
      densePoints.push(p);
      if (i > 0) {
        total += scratch.subVectors(p, densePoints[i - 1]).length();
        cumulative.push(total);
      }
    }
    this.length = total;

    // 2. Resample at a whole number of equal steps so the loop closes exactly.
    const count = Math.max(16, Math.round(total / spacing));
    this.spacing = total / count;

    let cursor = 0;
    for (let k = 0; k < count; k++) {
      const target = k * this.spacing;
      while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor++;

      const segLen = cumulative[cursor + 1] - cumulative[cursor];
      const f = segLen > 1e-6 ? (target - cumulative[cursor]) / segLen : 0;

      const sample = new TrackSample();
      sample.distance = target;
      sample.position.lerpVectors(densePoints[cursor], densePoints[cursor + 1], f);

      // Spline parameter for this point, used to look up authored width/bank.
      const t = (cursor + f) / dense;
      sample.width = this._nodeAttribute(t, 'width', 20);
      sample.bank = this._nodeAttribute(t, 'bank', 0);

      this.samples.push(sample);
    }

    this._buildFrames();
    this._buildCurvature();
  }

  /** Catmull-Rom interpolation of a per-node scalar at spline parameter t. */
  _nodeAttribute(t, key, fallback) {
    const n = this.nodes.length;
    const scaled = t * n;
    const i = Math.floor(scaled) % n;
    const u = scaled - Math.floor(scaled);
    const at = (k) => {
      const node = this.nodes[((k % n) + n) % n];
      const value = node[key];
      return typeof value === 'number' ? value : fallback;
    };
    return catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), u);
  }

  /**
   * Tangents from central differences, then an up vector carried forward by
   * parallel transport and finally rotated by the authored bank.
   */
  _buildFrames() {
    const n = this.samples.length;

    for (let i = 0; i < n; i++) {
      const prev = this.samples[(i - 1 + n) % n].position;
      const next = this.samples[(i + 1) % n].position;
      this.samples[i].tangent.subVectors(next, prev).normalize();
    }

    // Seed the transported up vector. If the track starts on a steep climb,
    // world up is still a valid seed as long as it is not parallel to T.
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(up.dot(this.samples[0].tangent)) > 0.95) up.set(0, 0, 1);

    const carried = new THREE.Vector3().copy(up);
    const scratch = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      // Remove any component along the tangent: that is the transport step.
      scratch.copy(s.tangent).multiplyScalar(carried.dot(s.tangent));
      carried.sub(scratch);
      if (carried.lengthSq() < 1e-8) {
        // Degenerate (the path doubled back); fall back to world up.
        carried.set(0, 1, 0).sub(scratch.copy(s.tangent).multiplyScalar(s.tangent.y));
      }
      carried.normalize();

      s.normal.copy(carried);
      s.right.crossVectors(s.normal, s.tangent).normalize();

      if (s.bank !== 0) {
        // Positive bank banks the road into a left-hander: the right edge
        // lifts, so the normal rotates toward the right-hand side.
        const angle = s.bank * (Math.PI / 180);
        s.normal.applyAxisAngle(s.tangent, angle).normalize();
        s.right.crossVectors(s.normal, s.tangent).normalize();
      }

      s.grade = s.tangent.y;
    }

    // The loop is closed, so the transported frame at the end will generally
    // not match the frame at the start. Distribute that twist evenly around
    // the whole lap rather than leaving a visible kink at the start line.
    this._closeFrameSeam();
  }

  _closeFrameSeam() {
    const n = this.samples.length;
    const first = this.samples[0];
    const last = this.samples[n - 1];

    // Transport the last frame one more step to where sample 0 sits.
    const predicted = last.normal.clone();
    const t0 = first.tangent;
    predicted.sub(t0.clone().multiplyScalar(predicted.dot(t0))).normalize();

    const reference = first.normal
      .clone()
      .applyAxisAngle(first.tangent, -first.bank * (Math.PI / 180))
      .normalize();

    let twist = Math.atan2(
      reference.clone().cross(predicted).dot(t0),
      reference.dot(predicted)
    );
    if (!Number.isFinite(twist)) return;
    // Take the short way round.
    if (twist > Math.PI) twist -= Math.PI * 2;
    if (twist < -Math.PI) twist += Math.PI * 2;
    if (Math.abs(twist) < 1e-5) return;

    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const correction = (-twist * i) / n;
      s.normal.applyAxisAngle(s.tangent, correction).normalize();
      s.right.crossVectors(s.normal, s.tangent).normalize();
    }
  }

  _buildCurvature() {
    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      const a = this.samples[(i - 1 + n) % n];
      const b = this.samples[i];
      const c = this.samples[(i + 1) % n];

      // Turn angle between consecutive tangents, signed about the surface
      // normal so a left-hander and a right-hander differ.
      const cross = new THREE.Vector3().crossVectors(a.tangent, c.tangent);
      const sinA = cross.dot(b.normal);
      const cosA = clamp(a.tangent.dot(c.tangent), -1, 1);
      const angle = Math.atan2(sinA, cosA);
      b.curvature = angle / (2 * this.spacing);
    }
  }

  /** Wrap a distance into [0, length). */
  wrap(distance) {
    const l = this.length;
    let d = distance % l;
    if (d < 0) d += l;
    return d;
  }

  /** Shortest signed distance from `from` to `to` around the loop. */
  delta(from, to) {
    const half = this.length / 2;
    let d = this.wrap(to) - this.wrap(from);
    if (d > half) d -= this.length;
    if (d < -half) d += this.length;
    return d;
  }

  indexAt(distance) {
    return Math.floor(this.wrap(distance) / this.spacing) % this.samples.length;
  }

  sampleByIndex(i) {
    const n = this.samples.length;
    return this.samples[((i % n) + n) % n];
  }

  /**
   * Interpolated frame at an arbitrary distance.
   * @param {number} distance
   * @param {TrackSample} out  reused to keep this allocation-free in the loop
   */
  sampleAt(distance, out) {
    const d = this.wrap(distance);
    const n = this.samples.length;
    const f = d / this.spacing;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const u = f - Math.floor(f);

    const a = this.samples[i0];
    const b = this.samples[i1];

    out.distance = d;
    out.position.lerpVectors(a.position, b.position, u);
    out.tangent.lerpVectors(a.tangent, b.tangent, u).normalize();
    out.normal.lerpVectors(a.normal, b.normal, u).normalize();
    // Re-derive right from the interpolated pair so the basis stays orthogonal.
    out.right.crossVectors(out.normal, out.tangent).normalize();
    out.normal.crossVectors(out.tangent, out.right).normalize();
    out.width = lerp(a.width, b.width, u);
    out.bank = lerp(a.bank, b.bank, u);
    out.curvature = lerp(a.curvature, b.curvature, u);
    out.grade = lerp(a.grade, b.grade, u);
    return out;
  }

  /**
   * Find where a world position sits relative to the track.
   *
   * `hintIndex` is the sample index the caller was near last frame; supplying
   * it turns this from a scan of the whole circuit into a short local search,
   * which is what makes it affordable per craft per physics step.
   *
   * @returns {{distance:number, lateral:number, height:number, index:number}}
   *   lateral is metres right of the centreline, height is metres above the
   *   road surface along its normal.
   */
  project(worldPos, hintIndex = -1, searchRadius = 24) {
    const n = this.samples.length;
    let bestIndex = 0;
    let bestDistSq = Infinity;

    if (hintIndex >= 0) {
      for (let k = -searchRadius; k <= searchRadius; k++) {
        const i = ((hintIndex + k) % n + n) % n;
        const dsq = this.samples[i].position.distanceToSquared(worldPos);
        if (dsq < bestDistSq) {
          bestDistSq = dsq;
          bestIndex = i;
        }
      }
      // If the best is at the edge of the window the hint was stale; fall
      // through to a full scan rather than silently locking onto the wrong
      // part of a circuit that doubles back on itself.
      const offset = Math.abs(((bestIndex - hintIndex + n + n / 2) % n) - n / 2);
      if (offset < searchRadius) return this._refine(bestIndex, worldPos);
    }

    // Coarse-to-fine full scan.
    const stride = Math.max(1, Math.floor(n / 256));
    bestDistSq = Infinity;
    for (let i = 0; i < n; i += stride) {
      const dsq = this.samples[i].position.distanceToSquared(worldPos);
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        bestIndex = i;
      }
    }
    for (let k = -stride; k <= stride; k++) {
      const i = ((bestIndex + k) % n + n) % n;
      const dsq = this.samples[i].position.distanceToSquared(worldPos);
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        bestIndex = i;
      }
    }
    return this._refine(bestIndex, worldPos);
  }

  /** Project onto the two segments either side of `index` for sub-sample accuracy. */
  _refine(index, worldPos) {
    const n = this.samples.length;
    const centre = this.samples[index];

    const toPoint = _v1.subVectors(worldPos, centre.position);
    const along = toPoint.dot(centre.tangent);
    // Clamp into the neighbouring half-segments; beyond that the frame here is
    // no longer the right one to measure against.
    const clamped = clamp(along, -this.spacing, this.spacing);

    const distance = this.wrap(centre.distance + clamped);
    const sample = this.sampleAt(distance, _sample);

    const offset = _v2.subVectors(worldPos, sample.position);
    return {
      distance,
      lateral: offset.dot(sample.right),
      height: offset.dot(sample.normal),
      index: this.indexAt(distance) % n,
    };
  }

  /** World-space point at a distance along the track and a lateral offset. */
  pointAt(distance, lateral = 0, height = 0, out = new THREE.Vector3()) {
    const s = this.sampleAt(distance, _sample);
    return out
      .copy(s.position)
      .addScaledVector(s.right, lateral)
      .addScaledVector(s.normal, height);
  }

  /** Axis-aligned bounds of the centreline, for framing the minimap. */
  computeBounds() {
    const box = new THREE.Box3();
    for (const s of this.samples) box.expandByPoint(s.position);
    return box;
  }
}

// Scratch objects. The physics step calls project() once per craft per tick,
// and allocating three vectors each time is the kind of thing that turns into
// a visible GC hitch halfway down a straight.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sample = new TrackSample();
