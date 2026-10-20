import * as THREE from 'three';
import { HANDLING } from './Ship.js';
import { TrackSample } from '../track/TrackPath.js';
import { clamp, clamp01, lerp, makeRng, smoothstep } from '../core/MathUtil.js';

/**
 * Computer-controlled driver.
 *
 * The AI drives the same simulation the player does — same thrust, same grip,
 * same cell. It has no hidden speed and cannot corner harder than the physics
 * allows; everything it does comes out of the same `controls` object the
 * keyboard produces. That is the only way the racing stays honest when a
 * player is three metres behind it on the last lap.
 *
 * It is built in four layers:
 *   1. a target lateral offset — the arcline, plus a personal bias
 *   2. a target speed for what is coming, from curvature lookahead
 *   3. avoidance, which bends the target offset around traffic
 *   4. cell management, which decides when boosting is worth it
 *
 * Skill scales the margins rather than the capability: a low-skill driver
 * brakes earlier, holds a sloppier line and spends its cell badly, but it is
 * driving the same craft.
 */

/** Driver names, paired with a temperament that actually changes behaviour. */
export const FIELD = [
  { name: 'R. Almeida', aggression: 0.72, consistency: 0.88, bravery: 0.70 },
  { name: 'K. Sørvik', aggression: 0.55, consistency: 0.95, bravery: 0.58 },
  { name: 'T. Okonkwo', aggression: 0.90, consistency: 0.72, bravery: 0.88 },
  { name: 'M. Ferreira', aggression: 0.64, consistency: 0.84, bravery: 0.66 },
  { name: 'J. Lindqvist', aggression: 0.80, consistency: 0.78, bravery: 0.76 },
  { name: 'A. Pradhan', aggression: 0.48, consistency: 0.92, bravery: 0.52 },
  { name: 'D. Marchetti', aggression: 0.86, consistency: 0.66, bravery: 0.92 },
  { name: 'S. Beaumont', aggression: 0.60, consistency: 0.90, bravery: 0.62 },
];

export class AIDriver {
  /**
   * @param {import('./Ship.js').Ship} ship
   * @param {import('../track/Track.js').Track} track
   * @param {import('../track/Arcline.js').Arcline} arcline
   */
  constructor(ship, track, arcline, { skill = 0.85, personality, seed = 1 } = {}) {
    this.ship = ship;
    this.track = track;
    this.arcline = arcline;
    this.skill = clamp01(skill);
    this.personality = personality ?? FIELD[0];
    this.rng = makeRng(seed);

    /** Steady-state offset from the line, so the field is not single file. */
    this.lineBias = (this.rng() - 0.5) * 3.4 * (1.25 - this.personality.consistency);
    /** Slow wander, so a trailing car does not sit perfectly in a tow. */
    this.wanderPhase = this.rng() * Math.PI * 2;
    this.wanderRate = 0.25 + this.rng() * 0.3;

    /** Current avoidance offset, smoothed. */
    this.avoidOffset = 0;
    this.time = 0;
    /** Non-zero while recovering from a mistake, forcing a lift. */
    this.recovery = 0;
    this.nextMistakeCheck = 2 + this.rng() * 6;

    this.controls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      airLeft: 0,
      airRight: 0,
      boost: false,
      shield: false,
    };

    this._relative = new THREE.Vector3();
  }

  /**
   * @param {number} dt
   * @param {{rivals: import('./Ship.js').Ship[], frozen?: boolean, catchUp?: number}} context
   */
  update(dt, context) {
    const ship = this.ship;
    const c = this.controls;

    if (context.frozen) {
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.airLeft = 0;
      c.airRight = 0;
      c.boost = false;
      c.shield = false;
      return c;
    }

    this.time += dt;
    this.recovery = Math.max(0, this.recovery - dt);

    const targetLateral = this._chooseLine(dt, context.rivals);
    const cornerSpeed = this._cornerSpeed(context.catchUp ?? 1);
    this._steer(targetLateral, cornerSpeed);
    this._pedals(cornerSpeed);
    this._manageCell(cornerSpeed, context.rivals);
    this._maybeMakeMistake(dt);

    return c;
  }

  /** Lookahead distance grows with speed: three quarters of a second of travel. */
  get lookahead() {
    return clamp(16 + this.ship.speed * 0.5, 18, 78);
  }

  _chooseLine(dt, rivals) {
    const ship = this.ship;
    const base = this.arcline.lateralAt(ship.distance + this.lookahead);

    // A slow wander, scaled by how inconsistent this driver is.
    const wander =
      Math.sin(this.time * this.wanderRate + this.wanderPhase) *
      1.2 *
      (1 - this.personality.consistency);

    const avoid = this._avoidance(rivals);
    // Avoidance is smoothed hard: a jerky dodge looks like a bug, and at
    // 110 m/s a sudden lateral demand just puts the craft into the barrier.
    this.avoidOffset = lerp(this.avoidOffset, avoid, 1 - Math.exp(-4.5 * dt));

    const halfWidth = this.track.halfWidthAt(ship.distance + this.lookahead);
    return clamp(base + this.lineBias + wander + this.avoidOffset, -halfWidth + 2, halfWidth - 2);
  }

  /**
   * Lateral nudge to get around whatever is in front.
   * Only considers craft genuinely ahead and closing; anything alongside is
   * handled by not steering into it, which the line clamp already does.
   */
  _avoidance(rivals) {
    if (!rivals || rivals.length === 0) return 0;
    const ship = this.ship;
    let strongest = 0;

    for (const other of rivals) {
      if (other === ship || other.finished) continue;
      const gap = this.track.path.delta(ship.distance, other.distance);
      if (gap < 1 || gap > 46) continue;

      const lateralGap = other.lateral - ship.lateral;
      if (Math.abs(lateralGap) > 7) continue;

      // Urgency rises as the gap closes and as the speed difference grows.
      const closing = clamp01((ship.speed - other.speed) / 18 + 0.35);
      const proximity = 1 - gap / 46;
      const urgency = proximity * proximity * closing;

      // Prefer the side with more road, but commit to the side we are already
      // on if we are nearly alongside — swapping sides late causes contact.
      const halfWidth = this.track.halfWidthAt(other.distance);
      const roomLeft = other.lateral + halfWidth;
      const roomRight = halfWidth - other.lateral;
      let side = roomRight > roomLeft ? 1 : -1;
      if (Math.abs(lateralGap) > 1.5) side = -Math.sign(lateralGap);

      const want = side * (4.6 + this.personality.aggression * 1.8) * urgency;
      if (Math.abs(want) > Math.abs(strongest)) strongest = want;
    }

    return strongest;
  }

  /**
   * Fastest speed the craft can hold through the worst curvature ahead.
   *
   * v = sqrt(a_lat / k) is the real relationship; the margin is where skill
   * lives. Note the grip term uses the *current* speed, because grip in this
   * game grows with speed — using peak grip would have the AI arriving far
   * too fast at every corner.
   */
  _cornerSpeed(catchUp) {
    const ship = this.ship;
    const path = this.track.path;

    // Scan far enough ahead to brake in time from the current speed.
    const brakingDistance = (ship.speed * ship.speed) / (2 * HANDLING.brakeForce) + 25;
    const horizon = clamp(brakingDistance, 60, 320);

    let limit = ship.stats.topSpeed;
    for (let d = 8; d < horizon; d += 8) {
      const sample = path.sampleAt(ship.distance + d, _scanSample);
      const curvature = Math.abs(sample.curvature);
      if (curvature < 1e-5) continue;

      // Banking adds grip in the direction of the turn.
      const bankAssist = 1 + clamp01((sample.bank * Math.sign(sample.curvature)) / 22) * 0.22;
      const available =
        (HANDLING.gripBase + ship.speed * HANDLING.gripPerSpeed) * ship.stats.grip * bankAssist;
      const corner = Math.sqrt(available / curvature);

      // How much of the distance to this corner we still have to slow down in.
      const reachable = Math.sqrt(corner * corner + 2 * HANDLING.brakeForce * d);
      limit = Math.min(limit, reachable);
    }

    // Skill and bravery set how close to the limit the driver runs.
    const margin = lerp(0.80, 1.0, this.skill) * lerp(0.95, 1.04, this.personality.bravery);
    const recovering = this.recovery > 0 ? 0.72 : 1;
    return clamp(limit * margin * recovering * catchUp, 22, ship.stats.topSpeed * 1.2);
  }

  _steer(targetLateral, cornerSpeed) {
    const ship = this.ship;
    const path = this.track.path;
    const ahead = path.sampleAt(ship.distance + this.lookahead, _steerSample);

    // Aim at a point on the target line, and steer at the bearing to it. This
    // folds the heading error and the lateral error into one number, which
    // behaves far better through a corner than servoing on lateral alone.
    _aimPoint
      .copy(ahead.position)
      .addScaledVector(ahead.right, targetLateral)
      .addScaledVector(ahead.normal, 1.2);

    this._relative.subVectors(_aimPoint, ship.position);
    const forward = Math.max(2, this._relative.dot(ship.forward));
    const lateral = this._relative.dot(ship.right);
    const bearing = Math.atan2(lateral, forward);

    const gain = lerp(1.7, 2.6, this.skill);
    this.controls.steer = clamp(bearing * gain, -1, 1);

    // Air brakes: used when the craft needs more rotation than steering alone
    // can give, which is exactly what a player learns to do in a hairpin.
    const overshoot = Math.abs(this.controls.steer) > 0.85 && ship.speed > cornerSpeed * 0.9;
    const wantsRotation = overshoot ? clamp01((Math.abs(bearing) - 0.28) * 3) : 0;
    const spend = ship.energy01 > 0.22 ? 1 : 0;
    this.controls.airLeft = bearing < 0 ? wantsRotation * spend : 0;
    this.controls.airRight = bearing > 0 ? wantsRotation * spend : 0;
  }

  _pedals(cornerSpeed) {
    const ship = this.ship;
    const c = this.controls;
    const over = ship.speed - cornerSpeed;

    if (over > 1.5) {
      c.brake = clamp01(over / 12);
      c.throttle = 0;
    } else if (over > -1.5) {
      // Hold station near the limit rather than oscillating on and off.
      c.brake = 0;
      c.throttle = 0.45;
    } else {
      c.brake = 0;
      c.throttle = 1;
    }

    // Never fully lift while sliding; it transfers weight and makes it worse.
    if (ship.sliding > 0.35) c.throttle = Math.max(c.throttle, 0.3);
  }

  _manageCell(cornerSpeed, rivals) {
    const ship = this.ship;
    const c = this.controls;

    // Boost only where it converts into lap time: on throttle, near the
    // corner-exit speed, and with enough cell left to still shield later.
    const onPower = c.throttle > 0.9 && ship.speed > cornerSpeed * 0.88;
    const reserve = lerp(0.55, 0.3, this.personality.aggression);
    const canAfford = ship.energy01 > reserve;

    // More willing to spend when there is someone close to attack or defend.
    let pressure = 0;
    for (const other of rivals ?? []) {
      if (other === ship) continue;
      const gap = Math.abs(this.track.path.delta(ship.distance, other.distance));
      if (gap < 55) pressure = Math.max(pressure, 1 - gap / 55);
    }

    c.boost = onPower && (canAfford || (pressure > 0.5 && ship.energy01 > 0.18));

    // Shield when a hit looks likely: low integrity, or sliding wide at speed.
    const nearBarrier =
      Math.abs(ship.lateral) > this.track.halfWidthAt(ship.distance) - 2.5 && ship.speed > 45;
    const fragile = ship.integrity01 < 0.4;
    c.shield = ship.energy01 > 0.25 && (nearBarrier || (fragile && pressure > 0.4));
  }

  /**
   * Occasional errors.
   *
   * A field that never makes a mistake is both unbeatable and boring to
   * follow. The chance is tied to consistency, and the result is a brief lift
   * rather than a scripted spin — enough to lose a few car lengths.
   */
  _maybeMakeMistake(dt) {
    this.nextMistakeCheck -= dt;
    if (this.nextMistakeCheck > 0) return;
    this.nextMistakeCheck = 5 + this.rng() * 9;

    const chance = (1 - this.personality.consistency) * (1 - this.skill * 0.7) * 0.55;
    if (this.rng() < chance) {
      this.recovery = 0.7 + this.rng() * 1.1;
      this.lineBias += (this.rng() - 0.5) * 2.2;
      this.lineBias = clamp(this.lineBias, -4, 4);
    }
  }
}

/**
 * Catch-up factor for one driver.
 *
 * Deliberately gentle and one-sided: a driver a long way behind the player
 * gets a small pace increase, and nobody is ever slowed down. Rubber banding
 * that drags the leader backwards is immediately obvious and makes winning
 * feel unearned.
 */
export function catchUpFactor(ship, player, trackLength, strength = 1) {
  if (!player || ship === player) return 1;
  const gap = player.progress - ship.progress;
  if (gap <= 0) return 1;
  const normalised = clamp01(gap / (trackLength * 0.35));
  return 1 + smoothstep(0, 1, normalised) * 0.055 * strength;
}

const _scanSample = new TrackSample();
const _steerSample = new TrackSample();
const _aimPoint = new THREE.Vector3();
