import * as THREE from 'three';
import { TrackSample } from '../track/TrackPath.js';
import { PROFILE } from '../track/TrackMesh.js';
import { resolveStats } from '../data/ships.js';
import { clamp, clamp01, damp, moveTowards, smoothstep } from '../core/MathUtil.js';

/**
 * Hovercraft simulation.
 *
 * The craft is a point mass with an orientation, held to the road by a spring
 * rather than by a collision mesh. That choice is the whole architecture: a
 * general rigid body on a 3km ribbon of banked geometry spends its life
 * tunnelling through barriers and catching edges at 130 m/s, whereas a craft
 * that knows where the road *is* — via the track's own projection — can never
 * leave it by accident. Everything here is expressed in the road's local
 * frame: distance along, lateral offset, height above the surface.
 *
 * Handling is deliberately not realistic. It is built around three things a
 * player can feel:
 *   - grip grows with speed, so the craft plants itself the harder it is
 *     driven, and lifting mid-corner is punished
 *   - yaw authority shrinks with speed, so high-speed corrections are gentle
 *     and low-speed hairpins are sharp
 *   - the air brakes rotate the craft *and* scrub speed, so they are a real
 *     decision rather than a free turn
 */

export const HANDLING = {
  /** Ride height the hover spring targets, in metres. */
  hoverHeight: 1.3,
  hoverStiffness: 230,
  hoverDamping: 26,
  /** Stronger than earth: everything in this game happens quickly. */
  gravity: 19,
  /** Extra downward acceleration per m/s of speed. Ground effect. */
  downforce: 0.46,

  /**
   * Drag is not a tuned constant. It is derived per craft from thrust and
   * stated top speed (k = thrust / topSpeed^2) so that terminal velocity
   * *is* the quoted number, rather than something that has to be chased every
   * time a stat changes. Boost then raises top speed for free and correctly:
   * sqrt((thrust + boost) / thrust).
   */
  brakeForce: 34,
  reverseForce: 11,

  /** Peak yaw rate multiplier at a standstill, falling off with speed. */
  yawLowSpeedBoost: 1.9,
  yawSpeedFalloff: 78,
  yawResponse: 9.0,
  yawDamping: 6.5,

  /** Air brakes: yaw contribution and the drag they cost. */
  airbrakeYaw: 0.95,
  airbrakeDrag: 0.0022,
  airbrakeGrip: 0.35,

  /** Lateral grip in m/s^2: a floor, plus a term that grows with speed. */
  gripBase: 9.0,
  gripPerSpeed: 0.118,
  /** Once sliding, how quickly lateral velocity bleeds off. */
  slideRecovery: 0.6,

  /** Extra thrust while boosting. Raises top speed by ~19% on a Kestrel. */
  boostThrust: 18,

  /** Barrier response. */
  wallRestitution: 0.28,
  wallScrub: 0.52,
  wallDamage: 0.62,
  wallGraze: 2.6,

  /** Cell economy, in units per second. */
  chargeRate: 27,
  boostDrain: 30,
  shieldDrain: 21,
  airbrakeDrain: 5,
  /** Trickle charge so a stranded craft is never permanently out of options. */
  idleCharge: 1.6,
};

let nextShipId = 1;

export class Ship {
  /**
   * @param {object} options
   * @param {import('../track/Track.js').Track} options.track
   * @param {import('../track/Arcline.js').Arcline} options.arcline
   */
  constructor({ shipId, classId, track, arcline, name, isPlayer = false, colours }) {
    this.uid = nextShipId++;
    this.shipId = shipId;
    this.classId = classId;
    this.name = name ?? shipId;
    this.isPlayer = isPlayer;
    this.colours = colours;

    this.track = track;
    this.path = track.path;
    this.arcline = arcline;
    this.stats = resolveStats(shipId, classId);
    // See HANDLING: drag is solved from the stats so top speed is exact.
    this.dragCoefficient = this.stats.thrust / (this.stats.topSpeed * this.stats.topSpeed);

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    /** Unit heading, kept in the plane of the road surface. */
    this.forward = new THREE.Vector3(0, 0, 1);
    /** Smoothed surface normal the craft is riding. */
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);

    this.speed = 0;
    this.yawRate = 0;
    /** Visual only: body roll and pitch, driven by cornering and thrust. */
    this.visualRoll = 0;
    this.visualPitch = 0;

    this.distance = 0;
    this.lateral = 0;
    this.height = HANDLING.hoverHeight;
    this.trackIndex = 0;
    this.grounded = true;
    this.sliding = 0;

    /** Signed metres travelled since the race started; negative on the grid. */
    this.progress = 0;
    this.lap = 1;
    this.finished = false;
    this.finishTime = 0;

    this.energy = this.stats.cell;
    this.integrity = this.stats.shield;
    this.boosting = false;
    this.shielding = false;
    this.chargeRate01 = 0;
    this.lineError = 0;

    /** Set for one step after a barrier strike, for audio and camera. */
    this.impact = 0;
    this.lastImpactSpeed = 0;

    this._sample = new TrackSample();
    this._frame = new TrackSample();
    this._scratch = new THREE.Vector3();
    this._scratchB = new THREE.Vector3();
  }

  get topSpeed() {
    return this.stats.topSpeed;
  }

  /** 0..1, for HUD bars and audio pitch. */
  get speed01() {
    return clamp01(this.speed / this.stats.topSpeed);
  }

  get energy01() {
    return clamp01(this.energy / this.stats.cell);
  }

  get integrity01() {
    return clamp01(this.integrity / this.stats.shield);
  }

  /** Place the craft on a grid slot and zero its motion. */
  placeAt(slot) {
    this.position.copy(slot.position);
    this.velocity.set(0, 0, 0);
    this.forward.copy(slot.tangent);
    this.up.copy(slot.normal);
    this.right.crossVectors(this.up, this.forward).normalize();

    this.speed = 0;
    this.yawRate = 0;
    this.visualRoll = 0;
    this.visualPitch = 0;

    const hit = this.path.project(this.position, -1);
    this.distance = hit.distance;
    this.lateral = hit.lateral;
    this.height = hit.height;
    this.trackIndex = hit.index;

    // Grid slots sit behind the line, so progress starts negative and the
    // first crossing is a real lap start rather than an instant lap 1.
    this.progress = -this.path.delta(hit.distance, 0);
    this.lap = 1;
    this.finished = false;
    this.finishTime = 0;

    this.energy = this.stats.cell;
    this.integrity = this.stats.shield;
  }

  /**
   * Advance one fixed step.
   * @param {number} dt
   * @param {{throttle:number,brake:number,steer:number,airLeft:number,airRight:number,boost:boolean,shield:boolean}} controls
   * @param {{frozen?:boolean}} [options] frozen holds the craft on the grid
   */
  update(dt, controls, options = {}) {
    const frame = this.path.sampleAt(this.distance, this._frame);
    this._updateOrientation(dt, frame, controls, options.frozen);
    this._updateEnergy(dt, controls, options.frozen);
    this._integrate(dt, frame, controls, options.frozen);
    this._resolveTrack(dt);
    this._updateProgress();
    this._updateVisuals(dt, controls);
  }

  _updateOrientation(dt, frame, controls, frozen) {
    // Ride the road's normal, but lag it slightly so a sharp change of camber
    // reads as the craft reacting rather than snapping.
    this.up.copy(damped(this.up, frame.normal, 0.0008, dt)).normalize();

    if (frozen) {
      this.yawRate = 0;
      return;
    }

    // Yaw authority falls away with speed. Without this the craft is
    // uncontrollable at 400kph and sluggish in a hairpin.
    const speedFactor =
      1 + (HANDLING.yawLowSpeedBoost - 1) * (1 - smoothstep(0, HANDLING.yawSpeedFalloff, this.speed));

    const airbrakeTurn = (controls.airRight - controls.airLeft) * HANDLING.airbrakeYaw;
    const target = (controls.steer + airbrakeTurn) * this.stats.agility * speedFactor;

    this.yawRate = moveTowards(
      this.yawRate,
      target,
      (target === 0 ? HANDLING.yawDamping : HANDLING.yawResponse) * dt
    );

    // Rotate about the craft's own up. Positive yaw turns right, matching the
    // track frame's right = normal x tangent convention.
    this.forward.applyAxisAngle(this.up, this.yawRate * dt);
    // Re-project into the surface plane: integration drift would otherwise
    // let the heading slowly tilt out of the road.
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();
    this.right.crossVectors(this.up, this.forward).normalize();
  }

  _updateEnergy(dt, controls, frozen) {
    const result = this.arcline.evaluate(this.distance, this.lateral);
    this.lineError = result.error;
    this.chargeRate01 = frozen ? 0 : result.charge;

    let delta = HANDLING.idleCharge;
    if (!frozen) {
      // Charge scales with how fast you are going as well as how well you are
      // tracking the line; crawling along it is not a strategy.
      const pace = 0.35 + 0.65 * this.speed01;
      delta += result.charge * HANDLING.chargeRate * this.stats.charge * pace;
    }

    this.boosting = !frozen && controls.boost && this.energy > 1;
    this.shielding = !frozen && controls.shield && this.energy > 1;

    if (this.boosting) delta -= HANDLING.boostDrain;
    if (this.shielding) delta -= HANDLING.shieldDrain;
    delta -= (controls.airLeft + controls.airRight) * HANDLING.airbrakeDrain;

    this.energy = clamp(this.energy + delta * dt, 0, this.stats.cell);
    if (this.energy <= 0) {
      this.boosting = false;
      this.shielding = false;
    }
  }

  _integrate(dt, frame, controls, frozen) {
    const accel = this._scratch.set(0, 0, 0);

    if (!frozen) {
      // Constant thrust; the quadratic drag below is what sets top speed.
      const thrust =
        this.stats.thrust * controls.throttle + (this.boosting ? HANDLING.boostThrust : 0);
      accel.addScaledVector(this.forward, thrust);

      if (controls.brake > 0) {
        const force = this.speed > 1 ? HANDLING.brakeForce : HANDLING.reverseForce;
        accel.addScaledVector(this.forward, -force * controls.brake);
      }
    }

    // Gravity, plus ground effect that grows with speed.
    accel.y -= HANDLING.gravity;
    accel.addScaledVector(this.up, -this.speed * HANDLING.downforce);

    // Hover spring along the surface normal.
    const verticalSpeed = this.velocity.dot(this.up);
    const compression = HANDLING.hoverHeight - this.height;
    const springForce =
      compression * HANDLING.hoverStiffness - verticalSpeed * HANDLING.hoverDamping;
    // Only pushes, never pulls: beyond a few metres up the craft is airborne
    // and should fall, not get yanked back down.
    const airborne = this.height > HANDLING.hoverHeight * 3;
    accel.addScaledVector(this.up, airborne ? 0 : Math.max(springForce, 0));
    this.grounded = !airborne;

    // Quadratic drag, plus whatever the air brakes are costing.
    const drag =
      this.dragCoefficient + (controls.airLeft + controls.airRight) * HANDLING.airbrakeDrag;
    accel.addScaledVector(this.velocity, -drag * this.velocity.length());

    this.velocity.addScaledVector(accel, dt);

    // Lateral grip is applied as a limited impulse rather than a force, which
    // keeps it stable at any step size and gives a clean break into a slide.
    if (this.grounded) {
      const lateralSpeed = this.velocity.dot(this.right);
      const airbrakeAssist = 1 + (controls.airLeft + controls.airRight) * HANDLING.airbrakeGrip;
      const maxGrip =
        (HANDLING.gripBase + this.speed * HANDLING.gripPerSpeed) *
        this.stats.grip *
        airbrakeAssist;

      const wanted = -lateralSpeed / dt;
      const applied = clamp(wanted, -maxGrip, maxGrip);
      this.velocity.addScaledVector(this.right, applied * dt);

      // How far past the limit we were, for tyre-smoke equivalents and audio.
      this.sliding = clamp01((Math.abs(wanted) - maxGrip) / Math.max(maxGrip, 1));
      if (this.sliding > 0) {
        this.velocity.addScaledVector(
          this.right,
          -lateralSpeed * HANDLING.slideRecovery * dt
        );
      }
    } else {
      this.sliding = 0;
    }

    if (frozen) {
      // Held on the grid: kill everything except the hover settling.
      const vertical = this.velocity.dot(this.up);
      this.velocity.copy(this._scratchB.copy(this.up).multiplyScalar(vertical));
    }

    this.position.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.dot(this.forward);
  }

  /** Re-project onto the circuit and handle barrier contact. */
  _resolveTrack(dt) {
    const hit = this.path.project(this.position, this.trackIndex);
    this.trackIndex = hit.index;
    this.distance = hit.distance;
    this.height = hit.height;

    const frame = this.path.sampleAt(hit.distance, this._sample);
    const limit = frame.width / 2 + PROFILE.kerbWidth;

    this.impact = 0;
    if (Math.abs(hit.lateral) > limit) {
      const side = Math.sign(hit.lateral);
      const overrun = Math.abs(hit.lateral) - limit;

      // Push back to the barrier face.
      this.position.addScaledVector(frame.right, -side * overrun);

      const closingSpeed = this.velocity.dot(frame.right) * side;
      if (closingSpeed > 0) {
        // Reflect the component into the wall and scrub along it. A glancing
        // blow should cost a little speed; a square hit should end the lap.
        this.velocity.addScaledVector(
          frame.right,
          -side * closingSpeed * (1 + HANDLING.wallRestitution)
        );
        const squareness = clamp01(closingSpeed / HANDLING.wallGraze);
        this.velocity.multiplyScalar(1 - HANDLING.wallScrub * squareness * squareness);

        if (closingSpeed > HANDLING.wallGraze) {
          this.impact = squareness;
          this.lastImpactSpeed = closingSpeed;
          if (!this.shielding) {
            this.integrity = Math.max(
              0,
              this.integrity - closingSpeed * HANDLING.wallDamage * this.stats.mass
            );
          }
        }
      }
      this.lateral = side * limit;
    } else {
      this.lateral = hit.lateral;
    }

    // Floor: the hover spring handles normal ride height, but a heavy landing
    // can briefly push through. Never let the craft end a step under the road.
    if (this.height < 0.12) {
      this.position.addScaledVector(frame.normal, 0.12 - this.height);
      const into = this.velocity.dot(frame.normal);
      if (into < 0) this.velocity.addScaledVector(frame.normal, -into * 1.2);
      this.height = 0.12;
    }

    // Last-resort recovery. Should be unreachable, but a craft that somehow
    // ends up under the circuit must come back rather than fall forever.
    if (this.height < -25 || !Number.isFinite(this.position.lengthSq())) {
      this.respawn();
    }
  }

  respawn() {
    const frame = this.path.sampleAt(this.distance, this._sample);
    this.position
      .copy(frame.position)
      .addScaledVector(frame.right, clamp(this.lateral, -frame.width / 2, frame.width / 2))
      .addScaledVector(frame.normal, HANDLING.hoverHeight);
    this.velocity.copy(frame.tangent).multiplyScalar(Math.max(0, Math.min(this.speed, 40)));
    this.forward.copy(frame.tangent);
    this.up.copy(frame.normal);
    this.right.crossVectors(this.up, this.forward).normalize();
    this.height = HANDLING.hoverHeight;
  }

  _updateProgress() {
    const advance = this.path.delta(this.path.wrap(this.progress), this.distance);
    // Guard against a projection jump (a craft cutting a hairpin apex can
    // legitimately move a long way along the spline in one step, but a jump
    // of half a lap means the projection latched onto the wrong place).
    if (Math.abs(advance) < this.path.length * 0.25) {
      this.progress += advance;
    }
    this.lap = Math.max(1, Math.floor(this.progress / this.path.length) + 1);
  }

  _updateVisuals(dt, controls) {
    // Body roll leans into the corner, led by yaw rate and how much the craft
    // is sliding. Pitch squats under acceleration and lifts under braking.
    const rollTarget =
      clamp(-this.yawRate * 0.38, -0.5, 0.5) +
      clamp(-this.velocity.dot(this.right) * 0.012, -0.22, 0.22) +
      (controls.airRight - controls.airLeft) * 0.14;
    this.visualRoll = damp(this.visualRoll, rollTarget, 0.0015, dt);

    const pitchTarget =
      clamp((controls.brake - controls.throttle * 0.6) * 0.07, -0.06, 0.09) +
      clamp(-this.path.sampleAt(this.distance, this._sample).grade * 0.25, -0.1, 0.1);
    this.visualPitch = damp(this.visualPitch, pitchTarget, 0.002, dt);
  }

  /** Orientation as a quaternion, for the mesh and the camera. */
  getOrientation(out = new THREE.Quaternion()) {
    const forward = _q1.copy(this.forward);
    const up = _q2.copy(this.up);
    const right = _q3.crossVectors(up, forward).normalize();
    up.crossVectors(forward, right).normalize();
    _basis.makeBasis(right, up, forward);
    out.setFromRotationMatrix(_basis);
    // Visual lean is applied on top so it never affects the physics frame.
    _tilt.setFromAxisAngle(_axisZ, this.visualRoll);
    out.multiply(_tilt);
    _tilt.setFromAxisAngle(_axisX, this.visualPitch);
    out.multiply(_tilt);
    return out;
  }
}

const _q1 = new THREE.Vector3();
const _q2 = new THREE.Vector3();
const _q3 = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _tilt = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _axisX = new THREE.Vector3(1, 0, 0);
const _dampVec = new THREE.Vector3();

/** Frame-rate independent vector approach, reusing one scratch vector. */
function damped(current, target, smoothing, dt) {
  const t = 1 - Math.exp(Math.log(smoothing) * dt);
  return _dampVec.copy(current).lerp(target, t);
}
