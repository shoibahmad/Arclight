import { Signal } from '../core/Signal.js';
import { SECTOR_COUNT } from '../track/Track.js';
import { clamp01 } from '../core/MathUtil.js';

/**
 * Race rules, timing and standings.
 *
 * Deliberately knows nothing about three.js, the DOM or audio — it is handed
 * a list of craft and a track, and it emits events. That keeps the rules
 * testable in Node, and it means the HUD, the audio engine and the career
 * screen all read the same numbers rather than each deriving their own idea
 * of who is winning.
 *
 * Events: 'countdown', 'start', 'lap', 'sector', 'finish', 'complete',
 *         'overtake', 'lastLap'
 */

export const RACE_STATE = {
  GRID: 'grid',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
};

/** Seconds of lights before the start. Five lamps, then out. */
const COUNTDOWN_SECONDS = 5;
/** After the winner finishes, how long the rest get before the race is called. */
const GRACE_SECONDS = 25;

class Entrant {
  constructor(ship, index) {
    this.ship = ship;
    this.gridIndex = index;
    this.position = index + 1;
    this.previousPosition = index + 1;

    this.lap = 1;
    this.lapTimes = [];
    this.bestLap = null;
    this.currentLapStart = 0;

    this.sector = 0;
    this.sectorTimes = [];
    this.bestSectors = new Array(SECTOR_COUNT).fill(null);

    this.finished = false;
    this.finishTime = null;
    this.totalTime = null;
    this.retired = false;
  }

  get name() {
    return this.ship.name;
  }

  get id() {
    return this.ship.uid;
  }
}

export class RaceDirector {
  /**
   * @param {object} options
   * @param {import('../track/Track.js').Track} options.track
   * @param {import('./Ship.js').Ship[]} options.ships
   * @param {'race'|'timetrial'} [options.mode]
   */
  constructor({ track, ships, laps, mode = 'race' }) {
    this.track = track;
    this.mode = mode;
    this.totalLaps = laps ?? track.laps;
    this.events = new Signal();

    this.entrants = ships.map((ship, i) => new Entrant(ship, i));
    this.byShip = new Map(this.entrants.map((e) => [e.ship, e]));

    this.state = RACE_STATE.GRID;
    this.clock = 0;
    this.countdown = COUNTDOWN_SECONDS;
    this.lightsLit = 0;
    this.finishedAt = null;
    this.winner = null;

    /** Set once the leader starts the final lap, for HUD and music. */
    this.lastLapCalled = false;
  }

  get player() {
    return this.entrants.find((e) => e.ship.isPlayer) ?? null;
  }

  get frozen() {
    return this.state === RACE_STATE.GRID || this.state === RACE_STATE.COUNTDOWN;
  }

  get running() {
    return this.state === RACE_STATE.RACING;
  }

  entrantFor(ship) {
    return this.byShip.get(ship) ?? null;
  }

  /** Standings, best first. Call after update(); it is recomputed there. */
  get standings() {
    return this._standings ?? this.entrants;
  }

  begin() {
    this.state = RACE_STATE.COUNTDOWN;
    this.countdown = COUNTDOWN_SECONDS;
    this.lightsLit = 0;
    this.events.emit('countdown', { remaining: this.countdown, lit: 0 });
  }

  /** Skip straight to racing. Used by the smoke test and by time trial restarts. */
  beginImmediately() {
    this.state = RACE_STATE.RACING;
    this.clock = 0;
    for (const entrant of this.entrants) entrant.currentLapStart = 0;
    this.events.emit('start', {});
  }

  update(dt) {
    switch (this.state) {
      case RACE_STATE.COUNTDOWN:
        this._updateCountdown(dt);
        break;
      case RACE_STATE.RACING:
        this.clock += dt;
        this._updateProgress();
        break;
      case RACE_STATE.FINISHED:
        this.clock += dt;
        this._updateProgress();
        break;
      default:
        break;
    }
    this._updateStandings();
  }

  _updateCountdown(dt) {
    this.countdown -= dt;

    // Light one lamp per second, then all out on zero.
    const lit = Math.min(5, Math.floor(COUNTDOWN_SECONDS - this.countdown) + 1);
    if (lit !== this.lightsLit) {
      this.lightsLit = lit;
      this.track.setStartLights(lit);
      this.events.emit('countdown', { remaining: Math.max(0, this.countdown), lit });
    }

    if (this.countdown <= 0) {
      this.state = RACE_STATE.RACING;
      this.clock = 0;
      this.track.setStartLights(-1);
      for (const entrant of this.entrants) entrant.currentLapStart = 0;
      this.events.emit('start', {});
    }
  }

  _updateProgress() {
    const length = this.track.length;

    for (const entrant of this.entrants) {
      if (entrant.finished || entrant.retired) continue;
      const ship = entrant.ship;

      // Sector crossings. Sectors are only credited in order, so cutting back
      // across the line cannot award a split.
      const sector = this.track.sectorFor(ship.distance);
      const expected = (entrant.sector + 1) % SECTOR_COUNT;
      if (sector === expected && ship.progress > 0) {
        const lapElapsed = this.clock - entrant.currentLapStart;
        entrant.sectorTimes[entrant.sector] = lapElapsed;
        const best = entrant.bestSectors[entrant.sector];
        if (best == null || lapElapsed < best) entrant.bestSectors[entrant.sector] = lapElapsed;
        entrant.sector = sector;
        this.events.emit('sector', { entrant, sector: entrant.sector, time: lapElapsed });
      }

      if (ship.lap > entrant.lap) {
        this._completeLap(entrant, ship.lap);
      }
    }

    // Call the race once the winner has had their grace period, so the field
    // is not left circulating forever behind a retired leader.
    if (this.finishedAt != null && this.clock - this.finishedAt > GRACE_SECONDS) {
      for (const entrant of this.entrants) {
        if (!entrant.finished) this._finish(entrant, true);
      }
    }

    if (this.state === RACE_STATE.RACING && this.entrants.every((e) => e.finished)) {
      this.state = RACE_STATE.FINISHED;
      this.events.emit('complete', { standings: this.standings });
    }
  }

  _completeLap(entrant, newLap) {
    const lapTime = this.clock - entrant.currentLapStart;
    entrant.currentLapStart = this.clock;
    entrant.lap = newLap;
    entrant.sector = 0;

    // Guard the opening crossing: a craft starting behind the line completes
    // "lap 1" the moment it crosses, which is not a lap time.
    if (lapTime > 3 && entrant.lapTimes.length < this.totalLaps) {
      entrant.lapTimes.push(lapTime);
      if (entrant.bestLap == null || lapTime < entrant.bestLap) {
        entrant.bestLap = lapTime;
        this.events.emit('lap', { entrant, lapTime, personalBest: true });
      } else {
        this.events.emit('lap', { entrant, lapTime, personalBest: false });
      }
    }

    // The arcline moves every lap, for everyone.
    entrant.ship.arcline?.setLap?.(newLap - 1);

    if (newLap > this.totalLaps) {
      this._finish(entrant, false);
      return;
    }

    if (!this.lastLapCalled && newLap === this.totalLaps) {
      const leader = this.standings[0];
      if (leader === entrant) {
        this.lastLapCalled = true;
        this.events.emit('lastLap', { entrant });
      }
    }
  }

  _finish(entrant, timedOut) {
    entrant.finished = true;
    entrant.finishTime = this.clock;
    entrant.totalTime = this.clock;
    entrant.ship.finished = true;
    entrant.ship.finishTime = this.clock;
    entrant.retired = timedOut;

    if (this.finishedAt == null) {
      this.finishedAt = this.clock;
      this.winner = entrant;
    }
    this.events.emit('finish', { entrant, position: entrant.position, timedOut });
  }

  /**
   * Order the field.
   *
   * Finishers are locked in the order they crossed. Everyone still running is
   * ranked on total distance covered, which is the only measure that stays
   * correct when craft are spread over more than a lap.
   */
  _updateStandings() {
    const sorted = [...this.entrants].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.ship.progress - a.ship.progress;
    });

    for (let i = 0; i < sorted.length; i++) {
      const entrant = sorted[i];
      const position = i + 1;
      if (position !== entrant.position) {
        entrant.previousPosition = entrant.position;
        entrant.position = position;
        // Only report changes involving the player; nobody needs a feed of
        // the AI shuffling for sixth.
        if (entrant.ship.isPlayer || this.player == null) {
          this.events.emit('overtake', {
            entrant,
            from: entrant.previousPosition,
            to: position,
          });
        }
      }
    }
    this._standings = sorted;
  }

  /** Gap in seconds to the craft ahead, estimated from speed and distance. */
  gapAhead(entrant) {
    const index = this.standings.indexOf(entrant);
    if (index <= 0) return null;
    const ahead = this.standings[index - 1];
    const metres = ahead.ship.progress - entrant.ship.progress;
    const speed = Math.max(12, entrant.ship.speed);
    return metres / speed;
  }

  gapBehind(entrant) {
    const index = this.standings.indexOf(entrant);
    if (index < 0 || index >= this.standings.length - 1) return null;
    const behind = this.standings[index + 1];
    const metres = entrant.ship.progress - behind.ship.progress;
    const speed = Math.max(12, behind.ship.speed);
    return metres / speed;
  }

  /** 0..1 around the current lap, for the HUD progress ring. */
  lapProgress(entrant) {
    return clamp01((entrant.ship.progress % this.track.length) / this.track.length);
  }

  /** Final classification, for the results screen and the championship. */
  results() {
    return this.standings.map((entrant, index) => ({
      id: entrant.id,
      name: entrant.name,
      shipId: entrant.ship.shipId,
      isPlayer: entrant.ship.isPlayer,
      position: index + 1,
      laps: Math.min(entrant.lap - 1, this.totalLaps),
      totalTime: entrant.totalTime,
      bestLap: entrant.bestLap,
      lapTimes: [...entrant.lapTimes],
      retired: entrant.retired,
    }));
  }
}

export { Entrant, COUNTDOWN_SECONDS };
