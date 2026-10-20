import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrackPath, TrackSample } from '../src/track/TrackPath.js';
import { Arcline, CHARGE_TOLERANCE } from '../src/track/Arcline.js';

/**
 * A circuit with one unmistakable right-hand corner, so the sign conventions
 * the arcline depends on are pinned down rather than assumed.
 *
 * Travelling +Z, then turning toward +X, is a right turn.
 */
function rightHandCircuit() {
  const pts = [
    [0, 0, 0],
    [0, 0, 240],
    [60, 0, 330],
    [150, 0, 390],
    [300, 0, 390],
    [390, 0, 300],
    [390, 0, 90],
    [300, 0, 0],
    [150, 0, -40],
    [40, 0, -40],
  ];
  return pts.map(([x, y, z]) => ({ position: new THREE.Vector3(x, y, z), width: 22, bank: 0 }));
}

const path = new TrackPath(rightHandCircuit(), { spacing: 2 });

/** Minimal stand-in for Track — Arcline only uses `path`. */
const fakeTrack = { path };

test('curvature is positive through a right-hand corner', () => {
  // Sample where the circuit is clearly turning from +Z toward +X.
  const sample = new TrackSample();
  let found = false;
  for (let d = 240; d < 420; d += 4) {
    path.sampleAt(d, sample);
    if (sample.tangent.x > 0.5 && sample.tangent.z > 0.2) {
      assert.ok(
        sample.curvature > 0,
        `expected positive curvature turning right, got ${sample.curvature.toFixed(5)}`
      );
      found = true;
      break;
    }
  }
  assert.ok(found, 'never found the right-hander — the test circuit changed shape');
});

test('the base line apexes on the inside of a corner', () => {
  const line = new Arcline(fakeTrack);
  const sample = new TrackSample();

  // Find the tightest right-hander and check the line is on the right there.
  let apexDistance = 0;
  let peak = 0;
  for (let i = 0; i < path.count; i++) {
    const s = path.sampleByIndex(i);
    if (s.curvature > peak) {
      peak = s.curvature;
      apexDistance = s.distance;
    }
  }
  assert.ok(peak > 0.004, 'test circuit has no meaningful corner');

  path.sampleAt(apexDistance, sample);
  const lateral = line.lateralAt(apexDistance);
  assert.ok(lateral > 1, `expected the line inside a right-hander, got ${lateral.toFixed(2)}`);
});

test('the line never leaves the road', () => {
  const line = new Arcline(fakeTrack);
  const sample = new TrackSample();
  for (let lap = 0; lap < 6; lap++) {
    line.setLap(lap);
    for (let d = 0; d < path.length; d += 2) {
      path.sampleAt(d, sample);
      const lateral = line.lateralAt(d);
      assert.ok(
        Math.abs(lateral) <= sample.width / 2 - 2,
        `lap ${lap} at ${d.toFixed(0)}m: line at ${lateral.toFixed(2)} is outside a ${sample.width.toFixed(1)}m road`
      );
    }
  }
});

test('the line is smooth enough to drive', () => {
  const line = new Arcline(fakeTrack);
  for (let lap = 0; lap < 4; lap++) {
    line.setLap(lap);
    let worst = 0;
    for (let d = 0; d < path.length; d += 2) {
      const a = line.lateralAt(d);
      const b = line.lateralAt(d + 2);
      worst = Math.max(worst, Math.abs(b - a));
    }
    // More than ~0.35m of lateral movement per 2m travelled would be a
    // 10-degree kink in the line — undrivable at racing speed.
    assert.ok(worst < 0.35, `lap ${lap} line kinks by ${worst.toFixed(3)}m per 2m step`);
  }
});

test('the line actually moves between laps', () => {
  const line = new Arcline(fakeTrack);
  line.setLap(0);
  const lap0 = [];
  for (let d = 0; d < path.length; d += 10) lap0.push(line.lateralAt(d));

  line.setLap(1);
  let moved = 0;
  let index = 0;
  for (let d = 0; d < path.length; d += 10) {
    moved = Math.max(moved, Math.abs(line.lateralAt(d) - lap0[index++]));
  }
  assert.ok(moved > 1.5, `lap 2 line only moved ${moved.toFixed(2)}m — not worth re-learning`);
});

test('charge falls off with distance from the line', () => {
  const line = new Arcline(fakeTrack);
  line.setLap(0);
  const d = path.length * 0.3;
  const onLine = line.lateralAt(d);

  assert.ok(line.evaluate(d, onLine).charge > 0.99, 'dead on the line should charge fully');
  assert.ok(line.evaluate(d, onLine + CHARGE_TOLERANCE * 0.5).charge > 0.1, 'close should still pay');
  assert.equal(line.evaluate(d, onLine + CHARGE_TOLERANCE + 0.1).charge, 0, 'far off should pay nothing');
  assert.equal(line.evaluate(d, onLine - CHARGE_TOLERANCE - 0.1).charge, 0, 'symmetric either side');

  // Monotonic: being closer is never worth less.
  let previous = Infinity;
  for (let e = 0; e <= CHARGE_TOLERANCE; e += 0.2) {
    const charge = line.evaluate(d, onLine + e).charge;
    assert.ok(charge <= previous + 1e-9, 'charge should decrease monotonically with error');
    previous = charge;
  }
});
