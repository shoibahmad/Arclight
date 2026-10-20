import * as THREE from 'three';
import { TrackSample } from './TrackPath.js';
import { clamp, clamp01, smoothstep, makeRng } from '../core/MathUtil.js';

/**
 * The arcline: a luminous ideal line threaded through the circuit.
 *
 * This is the one mechanic the whole game hangs off. Riding the line charges
 * the cell, and the cell is the only thing that pays for boost, shields and
 * air brakes. So the question in every corner is not "what is the fastest way
 * through" but "can I afford to take the fast way through", and the answer
 * changes depending on what you spent on the last straight.
 *
 * The line moves. Each lap it is re-derived with a different wander phase, so
 * a driver cannot simply memorise one groove and stop looking — but the
 * wander is low frequency and always inside the road, so it never asks for
 * something undrivable.
 *
 * The base shape comes from curvature. A raw "apex on the inside" target is
 * useless on its own: what makes a racing line a racing line is that it is
 * smoothed over a long window, and the smoothing is what produces the wide
 * entry and wide exit for free.
 */

/** Metres from the road edge the line will never cross. */
const EDGE_MARGIN = 2.6;
/** How far off the line still earns some charge. */
export const CHARGE_TOLERANCE = 4.2;
/** Curvature at which the line sits fully at the apex. */
const FULL_APEX_CURVATURE = 0.009;

export class Arcline {
  /**
   * @param {import('./Track.js').Track} track
   */
  constructor(track, { seed = 20260117 } = {}) {
    this.track = track;
    this.path = track.path;
    this.seed = seed;

    const n = this.path.count;
    /** Base racing line, metres right of centre, before any lap wander. */
    this.base = new Float32Array(n);
    /** Lateral room available at each sample, after the edge margin. */
    this.room = new Float32Array(n);
    /** Working line for the current lap. */
    this.current = new Float32Array(n);

    this.lap = -1;
    this._sample = new TrackSample();

    this._buildBase();
    this.setLap(0);
  }

  _buildBase() {
    const n = this.path.count;
    const raw = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const s = this.path.sampleByIndex(i);
      this.room[i] = Math.max(1, s.width / 2 - EDGE_MARGIN);
      // Curvature is positive turning right, so the apex of a right-hander is
      // on the +lateral side. Strength ramps in so a gentle kink does not pull
      // the line all the way to the barrier.
      const strength = clamp01(Math.abs(s.curvature) / FULL_APEX_CURVATURE);
      raw[i] = Math.sign(s.curvature) * strength * this.room[i];
    }

    // Smooth over roughly 90 metres each way. This is the step that turns a
    // set of apex targets into something resembling a driven line: the entry
    // and exit widen out on their own because the filter pulls the line toward
    // the opposite side before and after the corner.
    const window = Math.max(4, Math.round(90 / this.path.spacing));
    smoothWrapped(raw, this.base, window, 2);

    for (let i = 0; i < n; i++) {
      this.base[i] = clamp(this.base[i], -this.room[i], this.room[i]);
    }
  }

  /**
   * Re-derive the line for a given lap.
   * Called when a craft starts a new lap; cheap enough to do per lap, far too
   * expensive to do per frame.
   */
  setLap(lap) {
    if (lap === this.lap) return;
    this.lap = lap;

    const n = this.path.count;
    if (lap === 0) {
      // Lap one is the clean line. Learn it before it starts moving.
      this.current.set(this.base);
      this._dirty = true;
      return;
    }

    // Two slow sine components with lap-dependent phase and period. Two rather
    // than one so the result does not read as an obvious repeating wave.
    const rng = makeRng(this.seed + lap * 7919);
    const phaseA = rng() * Math.PI * 2;
    const phaseB = rng() * Math.PI * 2;
    const cyclesA = 2 + Math.floor(rng() * 3);
    const cyclesB = 5 + Math.floor(rng() * 4);
    const amount = 0.55 + rng() * 0.25;

    for (let i = 0; i < n; i++) {
      const t = i / n;
      const wander =
        Math.sin(t * Math.PI * 2 * cyclesA + phaseA) * 0.65 +
        Math.sin(t * Math.PI * 2 * cyclesB + phaseB) * 0.35;

      // The wander is scaled by whatever room is left between the base line
      // and the edge, so a corner where the line is already on the kerb stays
      // put and only the open sections move.
      const headroom = this.room[i] - Math.abs(this.base[i]);
      this.current[i] = clamp(
        this.base[i] + wander * headroom * amount,
        -this.room[i],
        this.room[i]
      );
    }
    this._dirty = true;
  }

  /** Lateral offset of the line at a distance along the lap. */
  lateralAt(distance) {
    const n = this.path.count;
    const f = this.path.wrap(distance) / this.path.spacing;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const u = f - Math.floor(f);
    return this.current[i0] * (1 - u) + this.current[i1] * u;
  }

  /** World-space point on the line, slightly above the road. */
  pointAt(distance, height = 0.05, out = new THREE.Vector3()) {
    const s = this.path.sampleAt(distance, this._sample);
    return out
      .copy(s.position)
      .addScaledVector(s.right, this.lateralAt(distance))
      .addScaledVector(s.normal, height);
  }

  /**
   * How well a craft is tracking the line.
   * @returns {{target:number, error:number, charge:number}} charge is 0..1
   */
  evaluate(distance, lateral) {
    const target = this.lateralAt(distance);
    const error = lateral - target;
    const normalised = Math.abs(error) / CHARGE_TOLERANCE;
    // Squared falloff: dead centre is worth meaningfully more than "close",
    // which is what stops the line from being free money.
    const charge = normalised >= 1 ? 0 : (1 - normalised) * (1 - normalised * 0.5);
    return { target, error, charge };
  }

  /**
   * Lateral offset a driver should be aiming for a short distance ahead.
   * Used by both the AI and the HUD's line indicator.
   */
  lookahead(distance, metres) {
    return this.lateralAt(distance + metres);
  }
}

/**
 * Box blur over a wrapped array.
 *
 * Two passes of a box filter approximate a gaussian closely enough for a
 * racing line, and the running sum keeps each pass O(n) rather than
 * O(n * window) — which matters when the window is ninety metres wide over
 * sixteen hundred samples.
 */
function smoothWrapped(source, target, window, passes = 2) {
  const n = source.length;
  const wrap = (i) => ((i % n) + n) % n;
  const inverse = 1 / (window * 2 + 1);

  let read = Float32Array.from(source);
  let write = new Float32Array(n);

  for (let pass = 0; pass < passes; pass++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) sum += read[wrap(k)];
    for (let i = 0; i < n; i++) {
      write[i] = sum * inverse;
      sum -= read[wrap(i - window)];
      sum += read[wrap(i + window + 1)];
    }
    const swap = read;
    read = write;
    write = swap;
  }

  target.set(read);
}

export { smoothstep };
