import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtil.js';

/**
 * Chase camera.
 *
 * Two things matter more than anything else here. The camera's up vector
 * follows the *road's* normal rather than world up, so a banked corner rolls
 * the horizon and the banking is something you see instead of something you
 * only read about in the track description. And it aims at a point further
 * down the circuit rather than at the craft, so a corner is framed before you
 * arrive at it — aiming at the craft means the apex is always off-screen at
 * exactly the moment you need to see it.
 *
 * Position is followed with exponential damping and the yaw deliberately lags,
 * which is what makes the craft visibly rotate underneath the camera when it
 * is being thrown into a corner.
 */

const VIEWS = {
  chase: { back: 11.5, up: 4.0, lookAhead: 42, lookUp: 1.6, fovBase: 0, stiffness: 0.0009 },
  close: { back: 7.6, up: 2.6, lookAhead: 34, lookUp: 1.2, fovBase: 3, stiffness: 0.0004 },
  cockpit: { back: -0.6, up: 1.15, lookAhead: 55, lookUp: 1.0, fovBase: 6, stiffness: 0.00008 },
};

export class ChaseCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../core/Settings.js').Settings} settings
   */
  constructor(camera, settings) {
    this.camera = camera;
    this.settings = settings;

    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    this.shake = 0;
    this.shakeSeed = Math.random() * 1000;
    this.lookBack = false;
    this.initialised = false;

    this._desired = new THREE.Vector3();
    this._lookPoint = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
    this._offset = new THREE.Vector3();
  }

  get view() {
    return VIEWS[this.settings.get('cameraMode')] ?? VIEWS.chase;
  }

  /** Called when a race starts, so the camera does not fly in from the origin. */
  reset(ship, track) {
    this.initialised = false;
    this.update(0.016, ship, track);
  }

  /** Add a one-off jolt. `amount` is roughly 0..1. */
  addShake(amount) {
    this.shake = clamp(this.shake + amount, 0, 1.4);
  }

  /**
   * @param {number} dt real frame time
   * @param {import('./Ship.js').Ship} ship
   * @param {import('../track/Track.js').Track} track
   */
  update(dt, ship, track) {
    const view = this.view;
    const behind = this.lookBack ? -1 : 1;

    // Desired position: behind and above the craft, in its own frame.
    this._desired
      .copy(ship.position)
      .addScaledVector(ship.forward, -view.back * behind)
      .addScaledVector(ship.up, view.up);

    // Pull back a little further the faster you go, which reads as the world
    // opening up rather than as a crude FOV ramp on its own.
    this._desired.addScaledVector(ship.forward, -ship.speed01 * 2.6 * behind);

    if (!this.initialised) {
      this.position.copy(this._desired);
      this.up.copy(ship.up);
      this.initialised = true;
    } else {
      // Softer in cockpit view (it is rigidly attached), looser in chase.
      const t = 1 - Math.exp(Math.log(view.stiffness) * dt);
      this.position.lerp(this._desired, t);
      this.up.copy(dampVector(this.up, ship.up, 0.0005, dt)).normalize();
    }

    // Aim down the circuit, not at the craft.
    const aheadDistance = ship.distance + view.lookAhead * (this.lookBack ? -0.35 : 1);
    const frame = track.frameAt(aheadDistance);
    this._lookPoint
      .copy(frame.position)
      .addScaledVector(frame.right, ship.lateral * 0.45)
      .addScaledVector(frame.normal, view.lookUp);

    // Blend toward the craft itself at low speed, where looking 40 metres up
    // the road leaves the craft tiny and uncentred.
    const blend = smoothstep(0, 24, Math.abs(ship.speed));
    this._lookPoint.lerp(
      this._scratch.copy(ship.position).addScaledVector(ship.up, view.lookUp),
      1 - blend
    );
    if (this.lookBack) {
      this._lookPoint.copy(ship.position).addScaledVector(ship.forward, -30).addScaledVector(ship.up, 1.2);
    }

    this.target.lerp(this._lookPoint, this.initialised ? 1 - Math.exp(-14 * dt) : 1);

    // Shake: impacts, plus a constant low rumble that grows with speed.
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const intensity = this.settings.get('shake');
    const rumble = clamp01((ship.speed01 - 0.55) / 0.45) * 0.18 + ship.sliding * 0.2;
    const amount = (this.shake + rumble) * intensity;

    this._offset.set(0, 0, 0);
    if (amount > 0.001) {
      const t = performance.now() * 0.001 + this.shakeSeed;
      this._offset.set(
        Math.sin(t * 37.1) * 0.5 + Math.sin(t * 19.3) * 0.5,
        Math.sin(t * 29.7) * 0.5 + Math.sin(t * 13.1) * 0.5,
        Math.sin(t * 23.3) * 0.3
      ).multiplyScalar(amount * 0.55);
    }

    this.camera.position.copy(this.position).add(this._offset);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);

    // Speed FOV. Kept modest: a big swing is nauseating over a 60 second lap.
    const base = this.settings.get('fov') + view.fovBase;
    const boostKick = ship.boosting ? 5.5 : 0;
    const wanted = base + ship.speed01 * 9 + boostKick;
    this.camera.fov = damp(this.camera.fov || wanted, wanted, 0.002, dt);
    this.camera.updateProjectionMatrix();
  }
}

const _dampScratch = new THREE.Vector3();

function dampVector(current, target, smoothing, dt) {
  const t = 1 - Math.exp(Math.log(smoothing) * dt);
  return _dampScratch.copy(current).lerp(target, t);
}

export { VIEWS, lerp };
