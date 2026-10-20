import test from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/track/Track.js';
import { Arcline } from '../src/track/Arcline.js';
import { Ship, HANDLING } from '../src/game/Ship.js';
import { loadTrack } from '../src/data/tracks/index.js';
import { PROFILE } from '../src/track/TrackMesh.js';
import { clamp } from '../src/core/MathUtil.js';

/**
 * Physics is validated numerically rather than by feel, because the numbers
 * are the part that can silently regress. A craft that reaches its stated top
 * speed, holds the road, and completes a lap in a plausible time is not proof
 * that the handling is *fun*, but it is proof that it is not broken.
 */

const STEP = 1 / 120;
const track = new Track(loadTrack('meridian'));
const arcline = new Arcline(track);

/**
 * A wide oval with 2.5km straights, for the tests that need to measure
 * acceleration and braking without a corner getting in the way. Driving a
 * real circuit in a straight line just grinds along the first barrier, which
 * measures the collision response rather than the drivetrain.
 */
const OVAL_DATA = {
  id: 'test-oval',
  name: 'Test Oval',
  theme: 'ridge',
  laps: 1,
  layout: { start: [0, 0, 0], heading: 0, width: 40 },
  segments: [
    { straight: 2500 },
    { turn: 180, radius: 420 },
    { straight: 2500 },
    { turn: 180, radius: 420 },
  ],
};
const oval = new Track(OVAL_DATA);
const ovalLine = new Arcline(oval);

function makeShip(shipId = 'kestrel', classId = 'sprint', circuit = track, line = arcline) {
  const ship = new Ship({ shipId, classId, track: circuit, arcline: line, name: shipId });
  ship.placeAt(circuit.gridSlot(0));
  return ship;
}

const makeOvalShip = (shipId = 'kestrel', classId = 'sprint') =>
  makeShip(shipId, classId, oval, ovalLine);

const NEUTRAL = {
  throttle: 0,
  brake: 0,
  steer: 0,
  airLeft: 0,
  airRight: 0,
  boost: false,
  shield: false,
};

const controls = (patch) => ({ ...NEUTRAL, ...patch });

/**
 * A simple line-following driver, used to put the craft through a full lap.
 * Deliberately crude: if the physics only survives a sophisticated controller
 * then it is the controller holding it together.
 */
function autopilot(ship, { skill = 1, circuit = track, line = arcline } = {}) {
  const lookahead = clamp(14 + ship.speed * 0.42, 16, 70);
  const aheadDistance = ship.distance + lookahead;
  const targetLateral = line.lateralAt(aheadDistance);

  const frameAhead = circuit.frameAt(aheadDistance);
  const bearing = Math.atan2(
    frameAhead.position.clone().sub(ship.position).dot(ship.right) +
      (targetLateral - ship.lateral) * 0.65,
    Math.max(1, frameAhead.position.clone().sub(ship.position).dot(ship.forward))
  );

  // Slow down for what is coming, based on the curvature ahead.
  let worstCurvature = 0;
  for (let d = 10; d < 150; d += 10) {
    worstCurvature = Math.max(worstCurvature, Math.abs(circuit.frameAt(ship.distance + d).curvature));
  }
  const cornerSpeed = clamp(
    Math.sqrt((HANDLING.gripBase + 60 * HANDLING.gripPerSpeed) * ship.stats.grip / Math.max(worstCurvature, 1e-5)),
    26,
    ship.stats.topSpeed
  );

  const wantThrottle = ship.speed < cornerSpeed * skill ? 1 : 0;
  const wantBrake = ship.speed > cornerSpeed * 1.08 ? 1 : 0;

  return controls({
    throttle: wantThrottle,
    brake: wantBrake,
    steer: clamp(bearing * 2.1, -1, 1),
  });
}

function simulate(ship, seconds, controlFn, circuit = track) {
  const steps = Math.round(seconds / STEP);
  const stats = { maxSpeed: 0, maxLateralOverrun: -Infinity, impacts: 0, minHeight: Infinity, maxHeight: -Infinity };
  for (let i = 0; i < steps; i++) {
    const c = controlFn(ship, i * STEP);
    ship.update(STEP, c);
    stats.maxSpeed = Math.max(stats.maxSpeed, ship.speed);
    stats.minHeight = Math.min(stats.minHeight, ship.height);
    stats.maxHeight = Math.max(stats.maxHeight, ship.height);
    const limit = circuit.halfWidthAt(ship.distance) + PROFILE.kerbWidth;
    stats.maxLateralOverrun = Math.max(stats.maxLateralOverrun, Math.abs(ship.lateral) - limit);
    if (ship.impact > 0) stats.impacts++;
  }
  return stats;
}

test('a craft settles at its hover height when left alone', () => {
  const ship = makeShip();
  simulate(ship, 3, () => NEUTRAL);
  assert.ok(
    Math.abs(ship.height - HANDLING.hoverHeight) < 0.35,
    `settled at ${ship.height.toFixed(3)}m, expected near ${HANDLING.hoverHeight}m`
  );
  assert.ok(Math.abs(ship.speed) < 1.5, `should not drift, speed ${ship.speed.toFixed(2)}`);
});

test('full throttle reaches the stated top speed without exceeding it', () => {
  const ship = makeOvalShip();
  const stats = simulate(ship, 40, () => controls({ throttle: 1 }), oval);
  const top = ship.stats.topSpeed;

  assert.ok(
    stats.maxSpeed > top * 0.9,
    `only reached ${stats.maxSpeed.toFixed(1)} m/s of a stated ${top.toFixed(1)}`
  );
  assert.ok(
    stats.maxSpeed < top * 1.05,
    `overshot the ceiling: ${stats.maxSpeed.toFixed(1)} m/s vs ${top.toFixed(1)}`
  );
});

test('acceleration is brisk but not instant', () => {
  const ship = makeOvalShip();
  let reached = null;
  for (let i = 0; i < 120 * 20 && reached === null; i++) {
    ship.update(STEP, controls({ throttle: 1 }));
    if (ship.speed > ship.stats.topSpeed * 0.9) reached = i * STEP;
  }
  assert.ok(reached !== null, 'never reached 90% of top speed');
  assert.ok(reached > 2.5, `0-90% in ${reached.toFixed(2)}s is too instant`);
  assert.ok(reached < 14, `0-90% in ${reached.toFixed(2)}s is too sluggish`);
});

test('braking pulls the craft up in a sane distance', () => {
  const ship = makeOvalShip();
  simulate(ship, 20, () => controls({ throttle: 1 }), oval);
  const entrySpeed = ship.speed;
  const startDistance = ship.progress;

  let steps = 0;
  while (ship.speed > entrySpeed * 0.3 && steps < 120 * 20) {
    ship.update(STEP, controls({ brake: 1 }));
    steps++;
  }
  const braked = ship.progress - startDistance;
  assert.ok(braked > 40, `stopped in ${braked.toFixed(0)}m — brakes are unrealistically strong`);
  assert.ok(braked < 420, `needed ${braked.toFixed(0)}m to slow down — brakes are useless`);
});

test('the cell charges on the line and drains under boost', () => {
  const ship = makeOvalShip();
  ship.energy = 40;

  // Drive the line properly: the cell should fill.
  simulate(ship, 8, (s) => autopilot(s, { circuit: oval, line: ovalLine }), oval);
  assert.ok(ship.energy > 55, `expected the cell to charge, sat at ${ship.energy.toFixed(1)}`);

  const before = ship.energy;
  simulate(ship, 2, () => controls({ throttle: 1, boost: true }), oval);
  assert.ok(ship.energy < before, `boost should cost energy: ${before.toFixed(1)} -> ${ship.energy.toFixed(1)}`);
});

test('boost is net negative while held, so it cannot be spammed', () => {
  const ship = makeOvalShip();
  ship.energy = ship.stats.cell;
  // Even driving the line perfectly, holding boost must drain.
  simulate(ship, 6, (s) => ({ ...autopilot(s, { circuit: oval, line: ovalLine }), boost: true }), oval);
  assert.ok(
    ship.energy < ship.stats.cell * 0.95,
    `boost on the line left ${ship.energy.toFixed(1)} of ${ship.stats.cell} — it is free`
  );
});

test('a basic autopilot completes a clean lap', () => {
  const ship = makeShip();
  const startProgress = ship.progress;
  const target = track.length;

  let elapsed = 0;
  const stats = { impacts: 0, maxOverrun: -Infinity };
  for (let i = 0; i < 120 * 240 && ship.progress - startProgress < target; i++) {
    ship.update(STEP, autopilot(ship));
    elapsed += STEP;
    if (ship.impact > 0) stats.impacts++;
    const limit = track.halfWidthAt(ship.distance) + PROFILE.kerbWidth;
    stats.maxOverrun = Math.max(stats.maxOverrun, Math.abs(ship.lateral) - limit);
  }

  assert.ok(
    ship.progress - startProgress >= target,
    `autopilot did not finish a lap in 240s (got ${(ship.progress - startProgress).toFixed(0)}m)`
  );
  assert.ok(elapsed > 25, `lap time of ${elapsed.toFixed(1)}s is implausibly quick`);
  assert.ok(elapsed < 150, `lap time of ${elapsed.toFixed(1)}s is implausibly slow`);
  assert.ok(stats.maxOverrun <= 0.01, `left the circuit by ${stats.maxOverrun.toFixed(2)}m`);
  assert.ok(Number.isFinite(ship.position.lengthSq()), 'position went non-finite');
});

test('a craft driven straight into a barrier is contained and damaged', () => {
  const ship = makeShip();
  simulate(ship, 14, () => controls({ throttle: 1 }));
  const before = ship.integrity;

  // Hard lock toward the barrier.
  const stats = simulate(ship, 6, () => controls({ throttle: 1, steer: 1 }));

  assert.ok(stats.maxLateralOverrun < 0.05, `escaped the barrier by ${stats.maxLateralOverrun.toFixed(3)}m`);
  assert.ok(ship.integrity < before, 'a barrier strike should cost integrity');
  assert.ok(Number.isFinite(ship.position.lengthSq()), 'position went non-finite after impact');
});

test('shields trade cell for integrity', () => {
  const unshielded = makeShip();
  simulate(unshielded, 14, () => controls({ throttle: 1 }));
  simulate(unshielded, 5, () => controls({ throttle: 1, steer: 1 }));

  const shielded = makeShip();
  simulate(shielded, 14, () => controls({ throttle: 1 }));
  shielded.energy = shielded.stats.cell;
  simulate(shielded, 5, () => controls({ throttle: 1, steer: 1, shield: true }));

  assert.ok(
    shielded.integrity > unshielded.integrity,
    `shield did not help: ${shielded.integrity.toFixed(1)} vs ${unshielded.integrity.toFixed(1)}`
  );
});

test('every craft in the roster survives a lap of each class', () => {
  for (const shipId of ['kestrel', 'vireo', 'mantis', 'oriole']) {
    for (const classId of ['sprint', 'apex']) {
      const ship = makeShip(shipId, classId);
      const stats = simulate(ship, 45, (s) => autopilot(s, { skill: 0.94 }));
      assert.ok(
        Number.isFinite(ship.position.lengthSq()) && Number.isFinite(ship.speed),
        `${shipId}/${classId} produced non-finite state`
      );
      assert.ok(
        stats.maxLateralOverrun < 0.05,
        `${shipId}/${classId} left the circuit by ${stats.maxLateralOverrun.toFixed(2)}m`
      );
      assert.ok(ship.progress > 300, `${shipId}/${classId} barely moved (${ship.progress.toFixed(0)}m)`);
    }
  }
});
