import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrackPath, TrackSample } from '../src/track/TrackPath.js';

/** A rounded rectangle with a banked section and a change of elevation. */
function makeTestNodes() {
  const nodes = [];
  const push = (x, y, z, width = 20, bank = 0) =>
    nodes.push({ position: new THREE.Vector3(x, y, z), width, bank });

  push(0, 0, -200);
  push(120, 0, -160, 22);
  push(160, 6, 0, 18, 12);
  push(120, 12, 160, 18, 18);
  push(0, 10, 200);
  push(-120, 4, 160, 24);
  push(-160, 0, 0, 24, -8);
  push(-120, 0, -160);
  return nodes;
}

const path = new TrackPath(makeTestNodes(), { spacing: 2 });

test('resamples to uniform arc length around a closed loop', () => {
  assert.ok(path.length > 900, `expected a long circuit, got ${path.length}`);
  assert.ok(path.count > 400);

  let min = Infinity;
  let max = 0;
  for (let i = 0; i < path.count; i++) {
    const a = path.sampleByIndex(i).position;
    const b = path.sampleByIndex(i + 1).position;
    const d = a.distanceTo(b);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  // Chord length is slightly under arc length in corners; a few percent is
  // expected, anything more means the resample is not actually uniform.
  assert.ok(max / min < 1.06, `spacing varied too much: ${min.toFixed(3)}..${max.toFixed(3)}`);
});

test('frames stay orthonormal everywhere', () => {
  for (let i = 0; i < path.count; i++) {
    const s = path.sampleByIndex(i);
    assert.ok(Math.abs(s.tangent.length() - 1) < 1e-5, 'tangent not unit');
    assert.ok(Math.abs(s.normal.length() - 1) < 1e-5, 'normal not unit');
    assert.ok(Math.abs(s.right.length() - 1) < 1e-5, 'right not unit');
    assert.ok(Math.abs(s.tangent.dot(s.normal)) < 1e-4, 'tangent/normal not perpendicular');
    assert.ok(Math.abs(s.tangent.dot(s.right)) < 1e-4, 'tangent/right not perpendicular');
    assert.ok(Math.abs(s.normal.dot(s.right)) < 1e-4, 'normal/right not perpendicular');
  }
});

test('frame never flips between adjacent samples', () => {
  for (let i = 0; i < path.count; i++) {
    const a = path.sampleByIndex(i);
    const b = path.sampleByIndex(i + 1);
    assert.ok(
      a.normal.dot(b.normal) > 0.9,
      `normal jumped at ${i}: dot=${a.normal.dot(b.normal).toFixed(3)}`
    );
  }
});

test('frame seam is closed across the start line', () => {
  const first = path.sampleByIndex(0);
  const last = path.sampleByIndex(path.count - 1);
  assert.ok(
    last.normal.dot(first.normal) > 0.995,
    `twist left at the seam: dot=${last.normal.dot(first.normal).toFixed(4)}`
  );
});

test('banking tilts the surface normal away from world up', () => {
  // Node 3 is authored at 18 degrees; find the most banked sample and check it.
  let steepest = path.sampleByIndex(0);
  for (let i = 0; i < path.count; i++) {
    const s = path.sampleByIndex(i);
    if (Math.abs(s.bank) > Math.abs(steepest.bank)) steepest = s;
  }
  assert.ok(Math.abs(steepest.bank) > 10, 'authored bank was not interpolated through');

  const tiltDegrees = Math.acos(Math.min(1, steepest.normal.dot(new THREE.Vector3(0, 1, 0)))) * (180 / Math.PI);
  assert.ok(tiltDegrees > 8, `expected a visibly banked normal, got ${tiltDegrees.toFixed(1)} degrees`);
});

test('project inverts pointAt', () => {
  const probe = new THREE.Vector3();
  for (let d = 0; d < path.length; d += 17.3) {
    for (const lateral of [-7, 0, 5.5]) {
      path.pointAt(d, lateral, 0, probe);
      const hit = path.project(probe, -1);

      const alongError = Math.abs(path.delta(d, hit.distance));
      assert.ok(alongError < 0.6, `distance off by ${alongError.toFixed(3)} at d=${d}`);
      assert.ok(
        Math.abs(hit.lateral - lateral) < 0.3,
        `lateral off by ${(hit.lateral - lateral).toFixed(3)} at d=${d}`
      );
      assert.ok(Math.abs(hit.height) < 0.3, `height off by ${hit.height.toFixed(3)}`);
    }
  }
});

test('project measures height along the banked normal', () => {
  const sample = path.sampleAt(path.length * 0.37, new TrackSample());
  const probe = sample.position.clone().addScaledVector(sample.normal, 3.25);
  const hit = path.project(probe, -1);
  assert.ok(Math.abs(hit.height - 3.25) < 0.1, `height was ${hit.height.toFixed(3)}`);
  assert.ok(Math.abs(hit.lateral) < 0.1, `lateral should be ~0, was ${hit.lateral.toFixed(3)}`);
});

test('a stale hint still resolves to the correct point', () => {
  const probe = new THREE.Vector3();
  path.pointAt(path.length * 0.8, 0, 0, probe);
  // Hint from the opposite side of the circuit.
  const hit = path.project(probe, path.indexAt(path.length * 0.2));
  assert.ok(
    Math.abs(path.delta(path.length * 0.8, hit.distance)) < 0.6,
    'stale hint was not detected and corrected'
  );
});

test('wrap and delta handle the seam', () => {
  assert.equal(path.wrap(0), 0);
  assert.ok(Math.abs(path.wrap(path.length) - 0) < 1e-6);
  assert.ok(Math.abs(path.wrap(-1) - (path.length - 1)) < 1e-6);

  // Ten metres forward across the start line is +10, not minus a lap.
  const d = path.delta(path.length - 5, 5);
  assert.ok(Math.abs(d - 10) < 1e-6, `expected +10, got ${d}`);
  assert.ok(path.delta(5, path.length - 5) < 0);
});

test('curvature is signed and peaks in the corners', () => {
  let maxLeft = 0;
  let maxRight = 0;
  for (let i = 0; i < path.count; i++) {
    const k = path.sampleByIndex(i).curvature;
    maxLeft = Math.max(maxLeft, k);
    maxRight = Math.min(maxRight, k);
  }
  // A closed loop must turn a full circle, so it has to bend meaningfully.
  assert.ok(Math.abs(maxLeft) > 0.002 || Math.abs(maxRight) > 0.002, 'curvature never develops');

  // Total turning around a simple closed loop is one full revolution.
  let total = 0;
  for (let i = 0; i < path.count; i++) total += path.sampleByIndex(i).curvature * path.spacing;
  assert.ok(
    Math.abs(Math.abs(total) - Math.PI * 2) < 0.6,
    `integrated curvature should be ~2pi, got ${total.toFixed(3)}`
  );
});

test('sampleAt interpolates without denormalising the basis', () => {
  const out = new TrackSample();
  for (let d = 0; d < path.length; d += 3.7) {
    path.sampleAt(d, out);
    assert.ok(Math.abs(out.tangent.length() - 1) < 1e-5);
    assert.ok(Math.abs(out.normal.length() - 1) < 1e-5);
    assert.ok(Math.abs(out.tangent.dot(out.normal)) < 1e-4);
    assert.ok(out.width > 5 && out.width < 40, `implausible width ${out.width}`);
  }
});
