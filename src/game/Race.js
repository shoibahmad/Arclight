import * as THREE from 'three';
import { Track } from '../track/Track.js';
import { Arcline } from '../track/Arcline.js';
import { ArclineRibbon } from '../render/ArclineRibbon.js';
import { Environment } from '../render/Environment.js';
import { Ship } from './Ship.js';
import { ShipVisual } from './ShipVisual.js';
import { ChaseCamera } from './ChaseCamera.js';
import { AIDriver, FIELD, catchUpFactor } from './AIDriver.js';
import { RaceDirector, RACE_STATE } from './RaceDirector.js';
import { Ghost } from '../core/Profile.js';
import { getShip, getClass } from '../data/ships.js';
import { loadTrack } from '../data/tracks/index.js';
import { clamp, clamp01, makeRng } from '../core/MathUtil.js';

/**
 * One race session: the world, the field, and the loop that advances them.
 *
 * Sits between the game shell (which owns screens and input) and the
 * simulation (which owns physics and rules). The shell calls `step` at a
 * fixed rate and `present` once per rendered frame; everything that must be
 * deterministic lives in `step`, everything that is only cosmetic lives in
 * `present`. Keeping that line clean is what lets the handling be identical
 * on a 60Hz laptop and a 240Hz monitor.
 */

/** Craft-to-craft contact. */
const CONTACT_RADIUS = 4.4;
const CONTACT_PUSH = 26;

export class Race {
  /**
   * @param {object} options
   * @param {string} options.trackId
   * @param {string} options.classId
   * @param {string} options.shipId  the player's craft
   * @param {'race'|'timetrial'} [options.mode]
   * @param {number} [options.opponents]
   * @param {import('../core/Profile.js').Ghost} [options.ghost]
   */
  constructor({
    trackId,
    classId = 'sprint',
    shipId = 'kestrel',
    mode = 'race',
    opponents = 7,
    laps,
    ghost = null,
    settings,
    seed = 7,
  }) {
    this.mode = mode;
    this.settings = settings;
    this.seed = seed;

    const data = loadTrack(trackId);
    if (!data) throw new Error(`unknown track "${trackId}"`);

    this.scene = new THREE.Scene();
    this.track = new Track(data);
    this.arcline = new Arcline(this.track, { seed: seed * 1013 });
    this.scene.add(this.track.group);

    this.environment = new Environment(this.scene, this.track.theme, settings);
    this.ribbon = new ArclineRibbon(this.arcline, this.track.theme.accent);
    this.scene.add(this.ribbon.mesh);

    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 16 / 9, 0.35, 5000);
    this.chase = new ChaseCamera(this.camera, settings);

    this.ships = [];
    this.visuals = [];
    this.drivers = [];

    const fieldSize = mode === 'timetrial' ? 1 : opponents + 1;
    this._buildField(shipId, classId, fieldSize);

    this.director = new RaceDirector({
      track: this.track,
      ships: this.ships,
      laps: laps ?? (mode === 'timetrial' ? 3 : data.laps),
      mode,
    });

    // Ghost playback, time trial only.
    this.ghost = ghost;
    this.ghostVisual = null;
    this.ghostSample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0 };
    if (ghost && mode === 'timetrial') this._createGhost(shipId, classId);

    // Ghost recording: always on in time trial, so a good lap is never lost.
    this.recording = mode === 'timetrial' ? new Ghost() : null;
    this.recordTimer = 0;
    this.recordedLapStart = 0;

    this.elapsed = 0;
    this.paused = false;
    this.playerControls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      airLeft: 0,
      airRight: 0,
      boost: false,
      shield: false,
    };

    this.chase.reset(this.player, this.track);
  }

  get player() {
    return this.ships.find((s) => s.isPlayer) ?? this.ships[0];
  }

  get playerEntrant() {
    return this.director.entrantFor(this.player);
  }

  get state() {
    return this.director.state;
  }

  get finished() {
    return this.director.state === RACE_STATE.FINISHED;
  }

  _buildField(playerShipId, classId, fieldSize) {
    const rng = makeRng(this.seed * 31 + 17);
    const cls = getClass(classId);
    const roster = ['kestrel', 'vireo', 'mantis', 'oriole'];
    const trailSegments = this.settings.preset.trailSegments;

    // Pole goes to the player in time trial; otherwise they start at the back,
    // which is the only grid order that makes a 3-lap race interesting.
    const playerSlot = fieldSize === 1 ? 0 : fieldSize - 1;

    for (let i = 0; i < fieldSize; i++) {
      const isPlayer = i === playerSlot;
      const id = isPlayer ? playerShipId : roster[(i + 1) % roster.length];
      const spec = getShip(id);
      const personality = FIELD[i % FIELD.length];

      const ship = new Ship({
        shipId: id,
        classId,
        track: this.track,
        arcline: this.arcline,
        name: isPlayer ? 'YOU' : personality.name,
        isPlayer,
        colours: isPlayer
          ? spec.colours
          : { ...spec.colours, accent: shiftHue(spec.colours.accent, (i * 47) % 360) },
      });
      ship.placeAt(this.track.gridSlot(i, fieldSize));
      this.ships.push(ship);

      const visual = new ShipVisual(ship, { trailSegments });
      visual.addTo(this.scene);
      this.visuals.push(visual);

      if (!isPlayer) {
        // Spread skill across the field so there is a clear front and back.
        const spread = fieldSize > 1 ? i / (fieldSize - 1) : 0;
        const skill = clamp01(cls.aiSkill + (0.5 - spread) * 0.12 + (rng() - 0.5) * 0.05);
        this.drivers.push(
          new AIDriver(ship, this.track, this.arcline, {
            skill,
            personality,
            seed: this.seed * 101 + i * 13,
          })
        );
      }
    }
  }

  _createGhost(shipId, classId) {
    const spec = getShip(shipId);
    const phantom = new Ship({
      shipId,
      classId,
      track: this.track,
      arcline: this.arcline,
      name: 'GHOST',
      colours: { ...spec.colours, accent: 0x7fa8ff },
    });
    phantom.placeAt(this.track.gridSlot(0));
    this.ghostShip = phantom;
    this.ghostVisual = new ShipVisual(phantom, { ghost: true });
    this.ghostVisual.addTo(this.scene);
  }

  start() {
    this.director.begin();
  }

  startImmediately() {
    this.director.beginImmediately();
  }

  /**
   * Fixed-step simulation.
   * @param {number} dt always the same value; see core/Loop.js
   */
  step(dt) {
    if (this.paused) return;
    this.elapsed += dt;

    const frozen = this.director.frozen;
    const player = this.player;

    // Drive the AI first so every craft advances against the same world state.
    for (const driver of this.drivers) {
      const catchUp = catchUpFactor(driver.ship, player, this.track.length);
      driver.update(dt, { rivals: this.ships, frozen, catchUp });
    }

    for (const ship of this.ships) {
      const controls = ship.isPlayer
        ? this.playerControls
        : this.drivers.find((d) => d.ship === ship).controls;
      ship.update(dt, controls, { frozen });
    }

    this._resolveContacts(dt);
    this.director.update(dt);
    this._recordGhost(dt);
  }

  /**
   * Craft-to-craft contact.
   *
   * Separation is applied in the track's lateral axis rather than in world
   * space. Two craft side by side at 110 m/s are only ever a metre or two
   * apart laterally, and pushing them apart along the world vector between
   * their centres would mostly shove them forwards and backwards — which
   * reads as one craft mysteriously accelerating out of a scrape.
   */
  _resolveContacts(dt) {
    const ships = this.ships;
    for (let i = 0; i < ships.length; i++) {
      const a = ships[i];
      for (let j = i + 1; j < ships.length; j++) {
        const b = ships[j];

        const gap = this.track.path.delta(a.distance, b.distance);
        if (Math.abs(gap) > CONTACT_RADIUS * 1.6) continue;

        const lateralGap = b.lateral - a.lateral;
        const separation = Math.hypot(gap, lateralGap);
        if (separation > CONTACT_RADIUS || separation < 1e-4) continue;

        const overlap = (CONTACT_RADIUS - separation) / CONTACT_RADIUS;
        const side = Math.sign(lateralGap) || (a.uid < b.uid ? 1 : -1);

        // Heavier craft give way less.
        const totalMass = a.stats.mass + b.stats.mass;
        const pushA = (b.stats.mass / totalMass) * overlap * CONTACT_PUSH;
        const pushB = (a.stats.mass / totalMass) * overlap * CONTACT_PUSH;

        a.velocity.addScaledVector(a.right, -side * pushA * dt);
        b.velocity.addScaledVector(b.right, side * pushB * dt);

        // A solid side-on hit costs a little speed and some integrity.
        if (overlap > 0.5) {
          const severity = (overlap - 0.5) * 2;
          for (const [ship, other] of [[a, b], [b, a]]) {
            if (!ship.shielding) {
              ship.integrity = Math.max(0, ship.integrity - severity * 7 * dt * other.stats.mass);
            }
            ship.velocity.multiplyScalar(1 - 0.22 * severity * dt);
          }
          a.impact = Math.max(a.impact, severity * 0.35);
          b.impact = Math.max(b.impact, severity * 0.35);
        }
      }
    }
  }

  _recordGhost(dt) {
    if (!this.recording || !this.director.running) return;
    const player = this.player;
    const entrant = this.playerEntrant;
    if (!entrant) return;

    this.recordTimer += dt;
    const interval = 1 / Ghost.RATE;
    if (this.recordTimer < interval) return;
    this.recordTimer -= interval;

    // One lap at a time: if this lap turns out to be the best, it is kept.
    if (entrant.lap !== this._recordingLap) {
      this._recordingLap = entrant.lap;
      this._pendingGhost = new Ghost();
    }
    const yaw = Math.atan2(player.forward.x, player.forward.z);
    const pitch = Math.asin(clamp(player.forward.y, -1, 1));
    this._pendingGhost?.push(player.position, yaw, pitch, player.visualRoll, player.speed);
  }

  /** Called by the shell when a lap completes, to keep the best ghost. */
  captureGhostIfBest(lapTime) {
    if (!this._pendingGhost || this._pendingGhost.length < 10) return null;
    if (this.recording.lapTime && lapTime >= this.recording.lapTime) return null;
    this._pendingGhost.lapTime = lapTime;
    this.recording = this._pendingGhost;
    return this.recording;
  }

  /**
   * Per-rendered-frame update. Nothing here may change the simulation.
   * @param {number} dt real frame time
   * @param {import('../render/Viewport.js').Viewport} viewport
   */
  present(dt, viewport) {
    const player = this.player;

    for (let i = 0; i < this.visuals.length; i++) {
      const ship = this.ships[i];
      const controls = ship.isPlayer
        ? this.playerControls
        : this.drivers.find((d) => d.ship === ship)?.controls;
      this.visuals[i].update(dt, controls ?? this.playerControls);
    }

    this._presentGhost(dt);
    this.ribbon.update(dt);
    this.ribbon.setVisible(this.settings.get('showRacingLine'));

    this.chase.lookBack = this.lookBack === true;
    this.chase.update(dt, player, this.track);
    this.environment.update(player.position, this.camera, this.elapsed);

    // Motion effects follow the player's speed and any fresh impact.
    viewport.setSpeedSignal(player.speed01 * (player.boosting ? 1.15 : 1));
    if (player.impact > 0.05) {
      this.chase.addShake(player.impact * 0.9);
      viewport.pulse(player.impact * 0.7, player.shielding ? 0x59b7ff : 0xff5533);
    }
  }

  _presentGhost(dt) {
    if (!this.ghost || !this.ghostVisual || !this.playerEntrant) return;
    const entrant = this.playerEntrant;
    const lapTime = this.director.clock - entrant.currentLapStart;

    const visible = this.settings.get('showGhost') && this.director.running;
    this.ghostVisual.group.visible = visible;
    if (!visible) return;

    if (this.ghost.sampleAt(lapTime, this.ghostSample)) {
      const s = this.ghostSample;
      this.ghostShip.position.set(s.x, s.y, s.z);
      this.ghostShip.forward.set(Math.sin(s.yaw), Math.sin(s.pitch), Math.cos(s.yaw)).normalize();
      this.ghostShip.visualRoll = s.roll;
      this.ghostShip.speed = s.speed;
      this.ghostShip.right.crossVectors(this.ghostShip.up, this.ghostShip.forward).normalize();
      this.ghostVisual.update(dt, { throttle: 0.8, airLeft: 0, airRight: 0 });
    }
  }

  /** Difference to the ghost at this point on the lap, in seconds. */
  ghostDelta() {
    if (!this.ghost || !this.playerEntrant) return null;
    const entrant = this.playerEntrant;
    const lapTime = this.director.clock - entrant.currentLapStart;

    // Walk the ghost's recording to find when it reached the player's distance.
    const player = this.player;
    const lapDistance = ((player.progress % this.track.length) + this.track.length) % this.track.length;
    const ghostTime = this._ghostTimeAtDistance(lapDistance);
    if (ghostTime == null) return null;
    return lapTime - ghostTime;
  }

  _ghostTimeAtDistance(distance) {
    // Cache a distance->time table the first time it is needed.
    if (!this._ghostTable) {
      const table = [];
      const sample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0 };
      const point = new THREE.Vector3();
      let hint = -1;
      for (let i = 0; i < this.ghost.length; i++) {
        this.ghost.sampleAt(i / Ghost.RATE, sample);
        point.set(sample.x, sample.y, sample.z);
        const hit = this.track.path.project(point, hint);
        hint = hit.index;
        table.push({ distance: hit.distance, time: i / Ghost.RATE });
      }
      this._ghostTable = table;
    }

    const table = this._ghostTable;
    if (table.length < 2) return null;
    for (let i = 1; i < table.length; i++) {
      if (table[i].distance >= distance) {
        const a = table[i - 1];
        const b = table[i];
        const span = b.distance - a.distance;
        const f = span > 1e-3 ? (distance - a.distance) / span : 0;
        return a.time + (b.time - a.time) * f;
      }
    }
    return table[table.length - 1].time;
  }

  applyQuality() {
    this.environment.configureShadow();
    this.environment.applyGrade?.(this._viewport);
  }

  dispose() {
    for (const visual of this.visuals) {
      visual.removeFrom(this.scene);
      visual.dispose();
    }
    this.ghostVisual?.removeFrom(this.scene);
    this.ghostVisual?.dispose();
    this.ribbon.dispose();
    this.environment.dispose();
    this.track.dispose();
    this.scene.clear();
  }
}

/** Shift a hex colour's hue, to tell otherwise identical craft apart. */
function shiftHue(hex, degrees) {
  const colour = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl);
  colour.setHSL((hsl.h + degrees / 360) % 1, hsl.s, hsl.l);
  return colour.getHex();
}

export { RACE_STATE };
